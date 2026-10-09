/* =============================================================================
   demoApi.ts — request handling for the shared demo library
   -----------------------------------------------------------------------------
   Transport-agnostic on purpose: both the Vite dev server (vite.config.ts) and
   the production server (server.ts) mount the SAME handler, so the two can't
   drift. Each caller supplies the signed-in user; this module owns the rules.

   Ownership model:
     • Anyone signed in can LIST and VIEW every demo (shared team library).
     • Only the creator can EDIT or DELETE their own demo.
     • Anyone can DUPLICATE someone else's demo — the copy is theirs to edit.
     • PROJECT ADMINS can EDIT and DELETE anyone's demo (the list is in `admins.ts`), so
       whoever runs the platform can fix a colleague's demo in place instead of
       leaving them a duplicate they then have to re-share.

   Routes (all under /api):
     GET    /api/me                    → the signed-in user
     POST   /api/admin-notice/ack      → dismiss the one-time "you're now an admin" popup
     GET    /api/demos                 → summaries (no heavy payload)
     POST   /api/demos                 → create (creator = caller)
     GET    /api/demos/:id             → full demo
     PATCH  /api/demos/:id             → update customizations (owner or admin)
     DELETE /api/demos/:id             → delete (owner or admin)
     POST   /api/demos/:id/duplicate   → copy as mine
     GET    /api/demos/:id/share       → the customer share's status + password (owner or admin)
     POST   /api/demos/:id/share       → create or refresh the customer share (owner or admin)
     PATCH  /api/demos/:id/share       → extend the dates, and un-revoke (owner or admin)
     DELETE /api/demos/:id/share       → revoke the link (owner or admin)
   ============================================================================= */

import { type DemoRecord, deleteDemo, getDemo, listDemos, publicRecord, saveDemo, shareSummary, uniqueId } from "./demoStore.ts";
import {
  buildShare, checkPassword, cleanBrains, derivePassword, extendShare, saveShare, shareState, SHARE_LIMITS,
} from "./share.ts";
import { isAdminEmail } from "./admins.ts";
import { pendingAdminNotice, ackAdminNotice } from "./adminNotices.ts";

export interface DemoUser { email: string; name: string }

export interface ApiResult { status: number; body: unknown }

const ok = (body: unknown): ApiResult => ({ status: 200, body });
const err = (status: number, error: string): ApiResult => ({ status, body: { error } });

const owns = (rec: DemoRecord, user: DemoUser) =>
  (rec.creator?.email ?? "").toLowerCase() === user.email.toLowerCase();

/* PROJECT ADMINS — write access to every demo, not just their own.

   ⚠️ **THE LIST ITSELF MOVED TO `engine/admins.ts` (9/16/2026)**, so the alert funnel can
   read it without a `demoApi -> alerts -> demoApi` cycle. Everything about it is unchanged
   and documented there: built-in constant PLUS an additive `DEMO_ADMIN_EMAILS`, read at
   module load, case-insensitive. `adminEmails` is re-exported here so existing callers
   (`feedbackApi`, `audit:app`) keep importing it from where they always did — one list,
   two spellings of the same import.

   Admin is deliberately NOT ownership: an admin editing your demo does not
   become its creator (see the PATCH branch), so the library keeps showing whose
   demo it is and the owner keeps their own rights to it. */
export { adminEmails } from "./admins.ts";

export const isAdmin = (user: DemoUser) => isAdminEmail(user.email);

/* The single write rule. Both PATCH and DELETE go through this so they can never
   drift apart. */
const canWrite = (rec: DemoRecord, user: DemoUser) => owns(rec, user) || isAdmin(user);

/* Pull the library-facing fields out of a CustomerProfile. */
function describe(profile: any) {
  return {
    prospect: String(profile?.customerName ?? "Untitled").slice(0, 200),
    websiteUrl: String(profile?.websiteUrl ?? ""),
    industry: String(profile?.industry ?? ""),
  };
}

const emptyCustomizations = () => ({ overrides: {}, tiles: {} });

/** Build a new demo owned by `user` from a generated profile. */
export function createDemo(
  profile: any,
  user: DemoUser,
  customizations?: DemoRecord["customizations"],
  nameSuffix = "",
): DemoRecord {
  const meta = describe(profile);
  if (nameSuffix) meta.prospect = `${meta.prospect}${nameSuffix}`;
  const id = uniqueId(meta.prospect);
  const now = new Date().toISOString();
  // The frontend keys everything off profile.id — keep it equal to the demo id
  // so a duplicate never collides with its source.
  const rec: DemoRecord = {
    id,
    ...meta,
    creator: user,
    createdAt: now,
    updatedAt: now,
    profile: { ...(profile as object), id, customerName: meta.prospect },
    customizations: customizations ?? emptyCustomizations(),
  };
  return saveDemo(rec);
}

export async function handleDemoApi(
  method: string,
  urlPath: string,
  body: any,
  user: DemoUser,
): Promise<ApiResult | null> {
  const p = urlPath.split("?")[0].replace(/\/+$/, "");

  if (p === "/api/me" && method === "GET")
    return ok({ user, admin: isAdmin(user), adminNotice: pendingAdminNotice(user.email) });

  /* ⚠️ ONE-TIME "you're now an admin" popup — see adminNotices.ts. Its own route
     rather than folding the ack into a PATCH somewhere, because dismissing it is
     not an edit to any demo; it belongs to the SIGNED-IN USER, not a record. */
  if (p === "/api/admin-notice/ack" && method === "POST") {
    ackAdminNotice(user.email);
    return ok({ ok: true });
  }

  if (p === "/api/demos") {
    if (method === "GET")
      return ok({ demos: listDemos(), user, admin: isAdmin(user), adminNotice: pendingAdminNotice(user.email) });
    if (method === "POST") {
      const profile = body?.profile;
      if (!profile?.customerName) return err(400, "A generated profile is required.");
      return ok({ demo: createDemo(profile, user, body?.customizations) });
    }
    return err(405, "Method not allowed.");
  }

  const match = /^\/api\/demos\/([^/]+)(\/duplicate|\/share)?$/.exec(p);
  if (!match) return null; // not a demo route — let the caller fall through

  const [, id, sub] = match;
  const isDuplicate = sub === "/duplicate";
  const rec = getDemo(id);
  if (!rec) return err(404, "Demo not found.");

  if (isDuplicate) {
    if (method !== "POST") return err(405, "Method not allowed.");
    // Name it "<prospect> (copy)" — otherwise the library and the in-app customer
    // switcher show two identically-named entries and nobody can tell them apart.
    const copy = createDemo(rec.profile, user, structuredClone(rec.customizations), " (copy)");
    return ok({ demo: copy });
  }

  /* ⚠️ THE CUSTOMER SHARE. Owner or admin only, both for reading and writing: the status
     includes the password. `publicRecord` below is what keeps the hash, the salt and the stored
     agent prompts out of every other response that carries this record. */
  if (sub === "/share") {
    if (!canWrite(rec, user)) return err(403, `Only ${rec.creator?.name || rec.creator?.email} or an admin can manage this demo's customer link.`);
    const now = Date.now();
    const status = (r: DemoRecord) => {
      const sh = r.share!;
      /* The password is the customer's name, so it can be shown again later, but only while
         it still matches what was stored: renaming the demo afterwards must not display a
         password that no longer works. */
      const pw = derivePassword(r.prospect);
      return {
        ...shareSummary(sh), state: shareState(sh, now), path: `/d/${sh.slug}`,
        password: checkPassword(pw, sh) ? pw : null,
        agents: Object.keys(sh.brains),
        limits: { chatTurnsPerSession: SHARE_LIMITS.chatTurnsPerSession, voiceCallSeconds: SHARE_LIMITS.voiceCallSeconds },
      };
    };

    if (method === "GET") return rec.share ? ok({ share: status(rec) }) : ok({ share: null });

    if (method === "POST") {
      /* `support: true` is the normal path: generate the Support playbook for this prospect, put
         the two Support workflows in the demo (so the customer can open them) and snapshot both
         agents' prompts — all on the server, so a browser never supplies a prompt. It never fails
         on the model: the generator falls back to a deterministic playbook. Explicit `brains`
         remain for tests and scripts. */
      let target = rec, supportSource: string | undefined, supportError: string | undefined;
      let brainsIn = body?.brains;
      if (body?.support) {
        const [gen, sp] = await Promise.all([import("./supportGen.ts"), import("../src/data/supportPlaybook.ts")]);
        const r = await gen.generateSupportPlaybook(rec.profile as any);
        supportSource = r.source; supportError = r.error;
        const p: any = rec.profile;
        const keep = (p.reports?.extraWorkflows ?? []).filter((w: any) => w?.slug !== sp.SUPPORT_SMS_SLUG && w?.slug !== sp.SUPPORT_VOICE_SLUG);
        /* The customer reads the NORMAL Voice and SMS workflows, so no extra Support workflows are added (and any
           added by an earlier version are removed): the support path is the Need Support side of the same agent. */
        const profile = { ...p, reports: { ...p.reports, extraWorkflows: keep } };
        target = saveDemo({ ...rec, profile, updatedAt: new Date(now).toISOString(), updatedBy: user });
        brainsIn = {
          [sp.SUPPORT_BRAIN_KEYS.sms]: { brain: sp.supportBrain(p, r.playbook, "sms"), greeting: sp.supportGreeting(p, "sms") },
          [sp.SUPPORT_BRAIN_KEYS.voice]: { brain: sp.supportBrain(p, r.playbook, "voice"), greeting: sp.supportGreeting(p, "voice") },
        };
      }
      const brains = cleanBrains(brainsIn);
      if (typeof brains === "string") return err(400, brains);
      const share = buildShare(target, user, { days: body?.days, hardDays: body?.hardDays, brains }, now);
      return ok({ share: { ...status(saveShare(target, share)), ...(supportSource ? { supportSource, supportError } : {}) } });
    }

    if (!rec.share) return err(404, "This demo has not been shared.");

    if (method === "PATCH") {
      const next = extendShare(rec.share, { days: body?.days, hardDays: body?.hardDays }, now);
      return ok({ share: status(saveShare(rec, next)) });
    }

    if (method === "DELETE") {
      const next = { ...rec.share, revokedAt: new Date(now).toISOString() };
      return ok({ share: status(saveShare(rec, next)) });
    }
    return err(405, "Method not allowed.");
  }

  if (method === "GET") return ok({ demo: publicRecord(rec), canEdit: canWrite(rec, user) });

  if (method === "PATCH") {
    if (!canWrite(rec, user)) return err(403, `This demo belongs to ${rec.creator?.name || rec.creator?.email}. Duplicate it to make your own editable copy.`);
    const next: DemoRecord = {
      ...rec,
      customizations: body?.customizations ?? rec.customizations,
      profile: body?.profile ?? rec.profile,
      updatedAt: new Date().toISOString(),
      /* CREATOR IS NEVER REASSIGNED. An admin editing someone else's demo would
         otherwise quietly take it over, and the owner would lose it from "mine".
         Instead the write is ATTRIBUTED: updatedBy records who last touched it,
         so an owner can see that an admin changed their demo rather than being
         left wondering. */
      updatedBy: user,
    };
    return ok({ demo: publicRecord(saveDemo(next)) });
  }

  if (method === "DELETE") {
    if (!canWrite(rec, user)) return err(403, "You can only delete demos you created.");
    return ok({ ok: deleteDemo(id) });
  }

  return err(405, "Method not allowed.");
}
