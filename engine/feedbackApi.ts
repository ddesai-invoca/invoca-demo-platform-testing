/* =============================================================================
   feedbackApi.ts — the feedback / feature-request routes
   -----------------------------------------------------------------------------
     POST   /api/feedback        submit an item (any signed-in user)
     GET    /api/feedback        list: YOUR items, or everything if you are admin
     PATCH  /api/feedback/:id    change status or note (ADMIN ONLY)
     DELETE /api/feedback/:id    remove (ADMIN ONLY)

   Shaped exactly like demoApi so server.ts and the Vite dev server can mount it
   the same way: returns null for a path it does not own, so the caller falls
   through to the next handler.

   VISIBILITY: a submitter sees only their own items; an admin sees all. Enforced
   HERE, on the server, because a client-side filter is a suggestion. The list is
   filtered before it is serialised, so another person's text never reaches a
   browser that should not have it.
   ============================================================================= */

import {
  listFeedback, getFeedback, saveFeedback, deleteFeedback, newFeedbackId,
  saveAttachment, readAttachment, deleteAttachments,
  isAllowedType, isInlineSafeImage, MAX_FILE_BYTES, MAX_FILES,
  STATUSES, TERMINAL, type FeedbackRecord, type FeedbackStatus, type FeedbackUser,
} from "./feedbackStore.ts";
import { sendMail, completionEmail, newItemEmail, mailConfigured } from "./mailer.ts";
import { adminEmails } from "./demoApi.ts";

export interface ApiResult {
  status: number;
  body: unknown;
  /* Set for a file download: the caller writes these instead of JSON. Kept on the
     same result shape so both servers mount this handler identically. */
  binary?: { buffer: Buffer; headers: Record<string, string> };
}
const ok = (body: unknown): ApiResult => ({ status: 200, body });
const err = (status: number, error: string): ApiResult => ({ status, body: { error } });

/* Read one query param. DECODES the value, which is the whole point: an
   undecoded `image%2Fpng` silently failed the media-type allow-list and every
   image upload came back 415. Splitting on the FIRST "=" only, because a value
   may legitimately contain one. */
function qs(urlPath: string, key: string): string | null {
  const q = urlPath.split("?")[1];
  if (!q) return null;
  for (const pair of q.split("&")) {
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? "" : pair.slice(eq + 1);
    if (safeDecode(k) === key) return safeDecode(v);
  }
  return null;
}
/** decodeURIComponent throws on a stray "%"; a malformed param is not a crash. */
function safeDecode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; }
}

const MAX_TITLE = 140;
const MAX_BODY = 4000;

export async function handleFeedbackApi(
  method: string,
  urlPath: string,
  body: any,
  user: FeedbackUser,
  isAdmin: boolean,
  baseUrl: string,
): Promise<ApiResult | null> {
  const p = urlPath.split("?")[0].replace(/\/+$/, "");
  if (!p.startsWith("/api/feedback")) return null;   // not ours

  const me = (user.email || "").toLowerCase();
  /* ⚠️ A CALLBACK BELONGS TO WHOEVER SHARED THE DEMO. Its submitter is a synthetic
     `share:<slug>` identity nobody signs in as, so the usual "the submitter sees their own"
     rule would hide every callback from the SE it is for — and the SE is exactly who has to
     ring the customer back, admin or not. Ownership is by `ownerEmail`, checked on the
     record, so an SE still cannot see anybody else's. */
  const mine = (r: FeedbackRecord) =>
    r.kind === "callback"
      ? (r.callback?.ownerEmail || "").toLowerCase() === me
      : (r.submitter?.email || "").toLowerCase() === me;

  if (p === "/api/feedback") {
    if (method === "GET") {
      const all = listFeedback();
      /* ?summary=1 → counts only. The admin's launch page wants a badge, and
         shipping every submission's text to render a number would grow with the
         backlog and put other people's reports in a payload that has no use for
         them. */
      if (qs(urlPath, "summary") !== null) {
        const isOpen = (r: FeedbackRecord) => r.status !== "Complete" && r.status !== "Declined";
        const visible = isAdmin ? all : all.filter(mine);
        return ok({
          admin: isAdmin,
          emailEnabled: mailConfigured(),
          total: visible.length,
          open: {
            feedback: visible.filter((r) => r.kind === "feedback" && isOpen(r)).length,
            feature: visible.filter((r) => r.kind === "feature" && isOpen(r)).length,
            callback: visible.filter((r) => r.kind === "callback" && isOpen(r)).length,
          },
        });
      }
      return ok({
        items: isAdmin ? all : all.filter(mine),
        admin: isAdmin,
        statuses: STATUSES,
        /* So the form can tell the truth about what happens on completion rather
           than promising an email that cannot be sent. */
        emailEnabled: mailConfigured(),
      });
    }
    if (method === "POST") {
      const kind = body?.kind === "feature" ? "feature" : "feedback";
      const title = String(body?.title ?? "").trim();
      const text = String(body?.body ?? "").trim();
      if (!title) return err(400, "A short title is required.");
      if (!text) return err(400, "Please describe it a little.");
      if (title.length > MAX_TITLE) return err(400, `Keep the title under ${MAX_TITLE} characters.`);
      if (text.length > MAX_BODY) return err(400, `Keep the description under ${MAX_BODY} characters.`);

      const now = new Date().toISOString();
      const rec: FeedbackRecord = {
        id: newFeedbackId(),
        kind,
        title,
        body: text,
        page: String(body?.page ?? "").slice(0, 200) || undefined,
        /* The submitter comes from the SESSION, never from the request body: it is
           what makes the completion email go to a real person who actually sent
           this, and it cannot be spoofed by a crafted POST. */
        submitter: { email: user.email, name: user.name },
        status: STATUSES[0],
        createdAt: now,
        updatedAt: now,
        history: [{ at: now, status: STATUSES[0], by: { email: user.email, name: user.name } }],
      };
      const saved = saveFeedback(rec);

      /* ⚠️⚠️ TELL THE MAINTAINER, because until 9/10/2026 nothing did. The only
         mail this app sent was the completion notice to the SUBMITTER, so the sole
         signal that anything had arrived was the Inbox badge on the LIVE launch
         screen — and that badge is per-instance, so working on localhost showed
         the local store's count instead. Three colleagues' reports sat In review
         for over two weeks before anyone noticed.

         ⚠️ AWAITED, NOT FIRE-AND-FORGET. A floating promise can be killed by the
         SIGTERM drain mid-deploy, which is precisely when a submission is most
         likely to be the last thing through. `sendMail` never throws and returns
         its outcome, so awaiting cannot fail the submission — the item is already
         on disk by this line either way. */
      const recipients = adminEmails().filter(
        /* ⚠️ NEVER MAIL THE SUBMITTER THEIR OWN ITEM. The maintainer files most of
           the feature requests here, and an inbox full of your own notes is the
           "permanent 0 badge" mistake: a notification that is usually about
           nothing teaches you to stop reading it. */
        (email) => email !== (user.email || "").trim().toLowerCase(),
      );
      for (const to of recipients) {
        const res = await sendMail(newItemEmail({
          to,
          kind: saved.kind,
          title: saved.title,
          body: saved.body,
          submitterName: saved.submitter?.name ?? "",
          submitterEmail: saved.submitter?.email ?? "",
          page: saved.page,
          boardUrl: `${baseUrl}/feedback`,
        }));
        if (!res.sent) console.log(`[feedback] no notice to ${to}: ${res.reason}`);
      }
      return ok({ item: saved });
    }
    return err(405, "Method not allowed.");
  }

  /* ---- attachments -------------------------------------------------------
     POST   /api/feedback/:id/files?name=…   raw bytes, one call per file
     GET    /api/feedback/:id/files/:file    stream it back                   */
  const fm = /^\/api\/feedback\/([^/]+)\/files(?:\/([^/]+))?$/.exec(p);
  if (fm) {
    const [, fid, fname] = fm;
    const item = getFeedback(fid);
    if (!item) return err(404, "Not found.");
    const isOwner = (item.submitter?.email || "").toLowerCase() === (user.email || "").toLowerCase();
    if (!isAdmin && !isOwner) return err(403, "Not yours.");

    if (method === "POST") {
      /* Only the submitter may attach, and only while it is theirs to attach to.
         An admin adding files to someone else's report would be confusing rather
         than useful. */
      if (!isOwner) return err(403, "Only the submitter can attach files.");
      const buf: Buffer = Buffer.isBuffer(body) ? body : Buffer.from([]);
      if (!buf.length) return err(400, "Empty file.");
      if (buf.length > MAX_FILE_BYTES) return err(413, `Files must be under ${MAX_FILE_BYTES / 1024 / 1024}MB.`);
      const existing = item.attachments ?? [];
      if (existing.length >= MAX_FILES) return err(400, `Up to ${MAX_FILES} files.`);
      const name = String(qs(urlPath, "name") || "file");
      const type = String(qs(urlPath, "type") || "application/octet-stream").toLowerCase();
      /* Type is checked against an allow-list rather than a block-list: the set of
         things a browser will execute is not knowable in advance. */
      if (!isAllowedType(type)) return err(415, "That file type is not accepted.");
      const stored = saveAttachment(item.id, existing.length, name, buf);
      item.attachments = [...existing, { name: name.slice(0, 120), type, size: buf.length, file: stored }];
      item.updatedAt = new Date().toISOString();
      saveFeedback(item);
      return ok({ item });
    }

    if (method === "GET" && fname) {
      const att = (item.attachments ?? []).find((a) => a.file === fname);
      if (!att) return err(404, "Not found.");
      const buffer = readAttachment(item.id, att.file);
      if (!buffer) return err(404, "Not found.");
      /* THE SERVING RULES, which are the whole security story for uploads:
           • nosniff, so a browser cannot decide a .txt is really HTML.
           • Only real raster images render inline. Everything else, INCLUDING SVG,
             is forced to download, because an SVG rendered inline on this origin
             can run script and read the session.
           • The download name is the sanitised on-disk one, quoted. */
      const inline = isInlineSafeImage(att.type);
      return {
        status: 200, body: null,
        binary: {
          buffer,
          headers: {
            "Content-Type": inline ? att.type : "application/octet-stream",
            "Content-Length": String(buffer.length),
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${att.file}"`,
            "Cache-Control": "private, max-age=300",
          },
        },
      };
    }
    return err(405, "Method not allowed.");
  }

  const m = /^\/api\/feedback\/([^/]+)$/.exec(p);
  if (!m) return err(404, "Not found.");
  const rec = getFeedback(m[1]);
  if (!rec) return err(404, "Not found.");

  if (method === "GET") {
    if (!isAdmin && !mine(rec)) return err(403, "Not yours.");
    return ok({ item: rec });
  }

  /* Triage is an admin action. A submitter marking their own request Complete
     would both skew the board and mail themselves. */
  if (method === "PATCH") {
    /* Triage is an admin action, with one exception: the SE who shared a demo works their own
       callbacks (they are the one calling back), but only those. */
    if (!isAdmin && !(rec.kind === "callback" && mine(rec))) return err(403, "Only an admin can change status.");
    const next = String(body?.status ?? "") as FeedbackStatus;
    if (next && !STATUSES.includes(next)) return err(400, "Unknown status.");
    const now = new Date().toISOString();

    if (typeof body?.note === "string") rec.note = body.note.slice(0, MAX_BODY);
    let mailed: { sent: boolean; reason?: string } | null = null;

    if (next && next !== rec.status) {
      rec.status = next;
      rec.history.push({ at: now, status: next, by: { email: user.email, name: user.name } });

      /* THE NOTIFICATION, sent once. `notifiedAt` is the guard: without it, any
         later save while the item sits in a terminal status would mail the person
         again, and "your request is done" arriving three times is worse than it
         never arriving. */
      /* ⚠️ NEVER FOR A CALLBACK: its submitter is `share:<slug>`, not an address, and the "your
         request is done" note would be addressed to nobody. */
      if (TERMINAL.includes(next) && !rec.notifiedAt && rec.kind !== "callback") {
        mailed = await sendMail(completionEmail({
          to: rec.submitter.email,
          name: rec.submitter.name,
          kind: rec.kind,
          title: rec.title,
          note: rec.note,
          boardUrl: `${baseUrl.replace(/\/+$/, "")}/feedback`,
        }));
        /* Stamped only on a real send, so an item completed while email is
           unconfigured still notifies later if someone re-completes it. */
        if (mailed.sent) rec.notifiedAt = now;
      }
    }
    rec.updatedAt = now;
    saveFeedback(rec);
    return ok({ item: rec, mailed });
  }

  if (method === "DELETE") {
    if (!isAdmin) return err(403, "Only an admin can delete.");
    deleteAttachments(rec.id);   // no orphaned files on disk
    return ok({ deleted: deleteFeedback(rec.id) });
  }

  return err(405, "Method not allowed.");
}
