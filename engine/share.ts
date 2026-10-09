/* =============================================================================
   share.ts — a demo shared OUTSIDE the company, with a customer, behind a password
   -----------------------------------------------------------------------------
   Everything else in this app sits behind the Google sign-in gate. A shared demo cannot,
   so this module owns the whole outside-facing surface and keeps it as small as it can:

     POST /api/share/:slug/login        password -> a session cookie
     GET  /api/share/:slug/demo         that demo's profile + customizations (nothing else)
     POST /api/share/:slug/chat         the live SMS / voice agent's next reply
     POST /api/share/:slug/analyze      signals for a finished conversation
     POST /api/share/:slug/voice-token  a LiveKit join token

   Those are the ONLY routes a customer can reach. The existing /api/chat, /api/livekit-token
   and friends stay behind the staff gate and never see a customer request, so a customer
   cannot reach the demo library, the feedback board, generation or Ask AI by any route.

   ⚠️⚠️ WHY A CUSTOMER NEVER SENDS ITS OWN `brain`. /api/chat and /api/livekit-token take the
   whole agent prompt from the browser. On a public link that is a free model endpoint with a
   system prompt of the caller's choosing, on our keys. Here the browser names a STORED
   snapshot (`share.brains[brainKey]`, taken by staff when the demo was shared) and the server
   uses that; nothing a customer types can become instructions.

   ⚠️⚠️ THE SESSION KEY IS DERIVED, NOT THE STAFF KEY. The staff cookie is HMAC-signed with
   SESSION_SECRET and its verifier only checks the signature and an `exp`. A customer token
   signed with the same key would therefore pass the staff gate if a customer pasted it into
   the staff cookie's name. A separate derived key makes that impossible; audit:share pins it.

   ⚠️ THE PASSWORD IS THE CUSTOMER'S NAME, AS ASKED, WHICH IS GUESSABLE. Everything else here
   exists to make that survivable: login lockouts, hard per-session and per-day caps on every
   model call, a call length limit, expiry, and a revoke switch.
   ============================================================================= */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectEscalation, extractPhone, confirmationText, excerpt, type Escalation, type Turn } from "./escalation.ts";
import type { EscalationInput } from "./callbacks.ts";
import {
  DATA_DIR, type DemoRecord, type ShareBlock, type ShareBrainEntry,
  getDemo, saveDemo, listDemoIds, shareSummary,
} from "./demoStore.ts";

/* ── Limits ────────────────────────────────────────────────────────────────── */

/** Every number a customer can hit lives here, so a policy change is one edit and the
 *  audit can read the same constants the handlers enforce. */
export const SHARE_LIMITS = {
  /** A customer message counts as one turn. Per login session. */
  chatTurnsPerSession: 100,
  analyzePerSession: 40,
  /** One voice conversation may last this long; the room is ended server-side after it. */
  voiceCallSeconds: 5 * 60,
  /* Backstops PER DEMO PER DAY. The per-session caps reset when someone logs in again, so
     these are what actually bound spend if a password is guessed. Generous for a real
     customer evaluating over a week, small next to what an abuser would need. */
  chatPerDay: 1000,
  analyzePerDay: 300,
  voiceCallsPerDay: 20,
  /* Escalations RECORDED (each one is an email to a person), per demo per day. A real customer
     needs a handful; the cap is what stops a script turning the callback path into a mail cannon. */
  escalationsPerDay: 15,
  /* The same request repeated inside this window is one request: a model may echo its closing
     line, and a customer may confirm twice. */
  escalationDedupeMs: 10 * 60 * 1000,
  /* Input bounds — a model call is billed on what it is sent. */
  maxMessages: 210,
  maxMessageChars: 2000,
  maxTranscriptTurns: 200,
  /* Login lockouts. */
  loginFailsPerIp: 5,
  loginFailsPerSlug: 40,
  lockoutMs: 15 * 60 * 1000,
  sessionMs: 12 * 60 * 60 * 1000,
} as const;

export const DEFAULT_SOFT_DAYS = 30;
export const DEFAULT_HARD_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

/* ── Password ─────────────────────────────────────────────────────────────── */

/** "Acme Corp." -> "acmecorp". Applied to the derived password AND to whatever the customer
 *  types, so "Acme Corp", "acme-corp" and "ACMECORP" all work: nobody should be locked out
 *  by punctuation. */
export function normalizePassword(input: string): string {
  return String(input ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "")
    .slice(0, 80);
}

/** The password for a customer: their name, normalised. */
export const derivePassword = (customerName: string): string => normalizePassword(customerName) || "demo";

export function hashPassword(pw: string, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(normalizePassword(pw), salt, 32).toString("hex") };
}
export function checkPassword(pw: string, share: Pick<ShareBlock, "salt" | "passwordHash">): boolean {
  const a = Buffer.from(crypto.scryptSync(normalizePassword(pw), share.salt, 32));
  const b = Buffer.from(share.passwordHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ── Slug + index ─────────────────────────────────────────────────────────── */

const INDEX_FILE = path.join(DATA_DIR, "share-index.json");

function readIndex(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")); } catch { return {}; }
}
function writeIndex(idx: Record<string, string>) {
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, INDEX_FILE);
}

export const slugFromName = (name: string): string =>
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "demo";

/** "acme", then "acme-2", … — unique across every share ever created, revoked ones included,
 *  so a retired link can never start pointing at a different customer's demo. */
export function uniqueShareSlug(name: string, demoId: string): string {
  const idx = readIndex();
  const base = slugFromName(name);
  const free = (s: string) => !idx[s] || idx[s] === demoId;
  if (free(base)) return base;
  for (let n = 2; n < 500; n++) if (free(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}
export function indexShare(slug: string, demoId: string) {
  const idx = readIndex(); idx[slug] = demoId; writeIndex(idx);
}
/** Look a demo up by its share slug. The index is an optimisation over scanning every demo
 *  file on each login, so it is re-checked against the record it points at. */
export function findByShareSlug(slug: string): DemoRecord | null {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) return null;
  const id = readIndex()[slug];
  const rec = id ? getDemo(id) : null;
  return rec?.share?.slug === slug ? rec : null;
}
/** Rebuild the index from the demo files (a migration / repair path, and what a restore from
 *  backup would need). */
export function rebuildShareIndex(): number {
  const idx: Record<string, string> = {};
  for (const id of listDemoIds()) { const r = getDemo(id); if (r?.share) idx[r.share.slug] = r.id; }
  writeIndex(idx);
  return Object.keys(idx).length;
}

/* ── State ────────────────────────────────────────────────────────────────── */

export type ShareState = "live" | "soft-expired" | "expired" | "revoked";

export function shareState(share: ShareBlock, now = Date.now()): ShareState {
  if (share.revokedAt) return "revoked";
  if (now >= Date.parse(share.hardCutoffAt)) return "expired";
  if (now >= Date.parse(share.softExpiresAt)) return "soft-expired";
  return "live";
}

/** Build (or refresh) the share block for a demo. `days` is the live-agent window and
 *  `hardDays` the later cutoff; the cutoff can never fall before the soft expiry. */
export function buildShare(
  rec: DemoRecord,
  creator: { email: string; name: string },
  opts: { days?: number; hardDays?: number; brains: Record<string, ShareBrainEntry> },
  now = Date.now(),
): ShareBlock {
  const days = clampDays(opts.days, DEFAULT_SOFT_DAYS);
  const hardDays = Math.max(days, clampDays(opts.hardDays, DEFAULT_HARD_DAYS));
  const pw = hashPassword(derivePassword(rec.prospect));
  const slug = rec.share?.slug ?? uniqueShareSlug(rec.prospect, rec.id);
  return {
    slug,
    passwordHash: pw.hash,
    salt: pw.salt,
    createdAt: rec.share?.createdAt ?? new Date(now).toISOString(),
    createdBy: rec.share?.createdBy ?? creator,
    softExpiresAt: new Date(now + days * DAY).toISOString(),
    hardCutoffAt: new Date(now + hardDays * DAY).toISOString(),
    brains: opts.brains,
  };
}
const clampDays = (n: unknown, fallback: number) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 1 ? Math.min(v, 365) : fallback;
};

/** Push the dates out from whichever is later, now or the current date, so extending an
 *  expired demo works and extending a live one never shortens it. Also un-revokes. */
export function extendShare(share: ShareBlock, opts: { days?: number; hardDays?: number }, now = Date.now()): ShareBlock {
  const days = clampDays(opts.days, DEFAULT_SOFT_DAYS);
  const soft = Math.max(now, Date.parse(share.softExpiresAt)) + days * DAY;
  const hardBase = Math.max(now, Date.parse(share.hardCutoffAt));
  const hard = Math.max(soft, hardBase + clampDays(opts.hardDays ?? days, days) * DAY);
  const { revokedAt: _r, ...rest } = share;
  return { ...rest, softExpiresAt: new Date(soft).toISOString(), hardCutoffAt: new Date(hard).toISOString() };
}

/** Validate the staff-supplied prompt snapshots. Bounded because they are stored on the demo
 *  and later sent to a model, and because a staff browser is trusted but not infallible. */
export function cleanBrains(input: unknown): Record<string, ShareBrainEntry> | string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "brains must be an object.";
  const out: Record<string, ShareBrainEntry> = {};
  const entries = Object.entries(input as Record<string, any>);
  if (!entries.length) return "At least one agent is required.";
  if (entries.length > 8) return "Too many agents (max 8).";
  let bytes = 0;
  for (const [key, v] of entries) {
    if (!/^[a-z0-9-]{1,40}$/.test(key)) return `Invalid agent key "${key}".`;
    if (!v?.brain || typeof v.brain !== "object" || typeof v.brain.customerName !== "string")
      return `Agent "${key}" needs a brain with a customerName.`;
    const entry: ShareBrainEntry = {
      brain: v.brain,
      greeting: typeof v.greeting === "string" ? v.greeting.slice(0, 2000) : undefined,
      voice: typeof v.voice === "string" ? v.voice.slice(0, 40) : undefined,
    };
    bytes += JSON.stringify(entry).length;
    out[key] = entry;
  }
  if (bytes > 1_500_000) return "Agent snapshots are too large.";
  return out;
}

/* ── Session cookie ───────────────────────────────────────────────────────── */

const RAW_SECRET = process.env.SESSION_SECRET || process.env.GOOGLE_CLIENT_SECRET || "insecure-dev-secret";
/** Derived, so a token signed here is never valid under the staff key. See the header. */
export const shareSigningKey = (secret = RAW_SECRET) =>
  crypto.createHash("sha256").update(`share-session-v1|${secret}`).digest();

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const mac = (body: string, secret?: string) =>
  crypto.createHmac("sha256", shareSigningKey(secret)).update(body).digest("base64url");

export interface ShareSession { slug: string; sid: string; exp: number }

export function signShareSession(p: ShareSession, secret?: string): string {
  const body = b64(JSON.stringify({ k: "share", ...p }));
  return `${body}.${mac(body, secret)}`;
}
export function verifyShareSession(token: string | undefined, secret?: string, now = Date.now()): ShareSession | null {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const want = mac(body, secret);
  if (!sig || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.k === "share" && typeof p.slug === "string" && typeof p.sid === "string" && typeof p.exp === "number" && p.exp > now
      ? { slug: p.slug, sid: p.sid, exp: p.exp } : null;
  } catch { return null; }
}

/** One cookie per slug, so a person reviewing two customers' demos is not logged out of one
 *  by opening the other. */
export const shareCookieName = (slug: string) => `invoca_share_${slug.replace(/[^a-z0-9-]/g, "")}`;

/* ── Login lockouts (in memory: per process, resets on restart, which is acceptable —
   the durable bound on a guesser is the daily model-call caps below) ─────────────────── */

const fails = new Map<string, { n: number; until: number; first: number }>();

function failState(key: string, now: number) {
  const f = fails.get(key);
  if (!f) return { locked: false, retryMs: 0 };
  if (f.until > now) return { locked: true, retryMs: f.until - now };
  if (now - f.first > SHARE_LIMITS.lockoutMs) { fails.delete(key); return { locked: false, retryMs: 0 }; }
  return { locked: false, retryMs: 0 };
}
function recordFail(key: string, limit: number, now: number) {
  const f = fails.get(key) ?? { n: 0, until: 0, first: now };
  f.n += 1;
  if (f.n >= limit) f.until = now + SHARE_LIMITS.lockoutMs;
  fails.set(key, f);
}
export const resetShareLockoutsForTest = () => fails.clear();

/* ── Usage (persisted, so a restart cannot reset a cap) ───────────────────── */

const USAGE_DIR = path.join(DATA_DIR, "share-usage");
export type UsageKind = "chat" | "analyze" | "voice";

interface UsageFile {
  day: string;
  chat: number; analyze: number; voice: number;
  escalation?: number;
  sessions: Record<string, { chat: number; analyze: number; at: number; esc?: Record<string, number> }>;
}
const today = (now: number) => new Date(now).toISOString().slice(0, 10);

function readUsage(demoId: string, now: number): UsageFile {
  let u: UsageFile | null = null;
  try { u = JSON.parse(fs.readFileSync(path.join(USAGE_DIR, `${demoId}.json`), "utf8")); } catch { /* first use */ }
  const day = today(now);
  if (!u || u.day !== day) u = { day, chat: 0, analyze: 0, voice: 0, sessions: u?.sessions ?? {} };
  for (const [sid, s] of Object.entries(u.sessions)) if (now - s.at > 7 * DAY) delete u.sessions[sid];
  return u;
}
function writeUsage(demoId: string, u: UsageFile) {
  fs.mkdirSync(USAGE_DIR, { recursive: true });
  const file = path.join(USAGE_DIR, `${demoId}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(u));
  fs.renameSync(tmp, file);
}

/** Count one use and say whether it is allowed. Synchronous read-modify-write on one Node
 *  thread, so two requests cannot both slip under a cap. */
export function spend(demoId: string, sid: string, kind: UsageKind, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  const u = readUsage(demoId, now);
  const L = SHARE_LIMITS;
  const day = kind === "chat" ? L.chatPerDay : kind === "analyze" ? L.analyzePerDay : L.voiceCallsPerDay;
  if (u[kind] >= day) return { ok: false, reason: "This demo has reached its usage limit for today. Please try again tomorrow." };
  if (kind !== "voice") {
    const s = (u.sessions[sid] ??= { chat: 0, analyze: 0, at: now });
    const cap = kind === "chat" ? L.chatTurnsPerSession : L.analyzePerSession;
    if (s[kind] >= cap)
      return { ok: false, reason: kind === "chat"
        ? "This session has reached the demo's conversation limit. Sign in again to keep exploring." : "Analysis limit reached for this session." };
    s[kind] += 1; s.at = now;
  }
  u[kind] += 1;
  writeUsage(demoId, u);
  return { ok: true };
}
export const usageFor = (demoId: string, now = Date.now()) => readUsage(demoId, now);

/** May this escalation be recorded? Deduplicated per session and per kind, then capped per demo
 *  per day. Same synchronous read-modify-write as `spend`. */
export function spendEscalation(demoId: string, sid: string, want: Escalation, now = Date.now()): boolean {
  const u = readUsage(demoId, now);
  const s = (u.sessions[sid] ??= { chat: 0, analyze: 0, at: now });
  const last = s.esc?.[want] ?? 0;
  if (now - last < SHARE_LIMITS.escalationDedupeMs) return false;
  if ((u.escalation ?? 0) >= SHARE_LIMITS.escalationsPerDay) return false;
  s.esc = { ...(s.esc ?? {}), [want]: now };
  u.escalation = (u.escalation ?? 0) + 1;
  writeUsage(demoId, u);
  return true;
}

/* ── The handler ──────────────────────────────────────────────────────────── */

export interface ShareDeps {
  chat(brain: any, messages: { role: "user" | "assistant"; content: string }[], voice: boolean): Promise<string>;
  analyze(input: any): Promise<{ signals: unknown; outcome?: unknown }>;
  mintVoice(req: { brain: any; profileId: string; greeting?: string; voice?: string; ttl: string }): Promise<any>;
  /** End a LiveKit room after `ms`. The token's ttl only limits JOINING, not staying. */
  endRoomAfter(room: string, ms: number): void;
  voiceConfigured(): boolean;
  aiConfigured(): boolean;
  /** Store a customer's escalation and tell the SE. Never called for more than the caps allow. */
  escalate(input: EscalationInput): Promise<unknown>;
}
export interface ShareReq {
  cookies: Record<string, string>;
  ip: string;
  secure: boolean;
  /** https://host of this request, for links in an email. */
  origin?: string;
}
export interface ShareResult { status: number; body: unknown; setCookie?: string }

/** Build a ShareReq from raw Node headers. Shared by the production server and the Vite dev
 *  twin so the two cannot disagree about who a caller is.
 *
 *  ⚠️ THE CALLER'S IP IS THE RIGHT-MOST X-FORWARDED-FOR ENTRY. The left-most is whatever the
 *  client chose to send; the right-most is the one the platform's own proxy appended. Trusting
 *  the left would let a guesser rotate a fake address and dodge the per-IP lockout. (The
 *  per-slug lockout does not depend on the IP at all, and bounds it either way.) */
export function shareReqFrom(
  headers: Record<string, string | string[] | undefined>,
  remote?: string,
  baseUrl = process.env.BASE_URL || "",
): ShareReq {
  const h = (k: string) => { const v = headers[k]; return Array.isArray(v) ? v.join(",") : v ?? ""; };
  const xff = h("x-forwarded-for").split(",").map((x) => x.trim()).filter(Boolean);
  const cookies: Record<string, string> = {};
  h("cookie").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) { try { cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip a malformed cookie */ } }
  });
  return {
    cookies,
    ip: xff[xff.length - 1] || remote || "unknown",
    secure: baseUrl ? baseUrl.startsWith("https") : h("x-forwarded-proto") === "https",
    origin: baseUrl || `${h("x-forwarded-proto").split(",")[0].trim() || "http"}://${h("host")}`,
  };
}

const err = (status: number, error: string, extra: object = {}): ShareResult => ({ status, body: { error, ...extra } });
const GONE = "This demo link is no longer available.";

const cleanText = (s: unknown, max: number) => String(s ?? "").slice(0, max);

export async function handleShareApi(
  method: string,
  urlPath: string,
  body: any,
  req: ShareReq,
  deps: ShareDeps,
  now = Date.now(),
): Promise<ShareResult | null> {
  const m = /^\/api\/share\/([^/]+)\/([a-z-]+)$/.exec(urlPath.split("?")[0].replace(/\/+$/, ""));
  if (!m) return null;
  const [, slug, action] = m;

  /* An unknown slug and a wrong password must be indistinguishable to a guesser. */
  const rec = findByShareSlug(slug);
  const share = rec?.share;
  if (!rec || !share) return action === "login" ? err(401, "That password didn't work.") : err(404, "Not found.");

  const state = shareState(share, now);
  if (state === "revoked" || state === "expired") return err(410, GONE);

  /* ── login ── */
  if (action === "login") {
    if (method !== "POST") return err(405, "Method not allowed.");
    const ipKey = `${slug}|${req.ip}`, slugKey = `${slug}|*`;
    const a = failState(ipKey, now), b = failState(slugKey, now);
    if (a.locked || b.locked) {
      const mins = Math.ceil(Math.max(a.retryMs, b.retryMs) / 60000);
      return err(429, `Too many attempts. Please try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
    }
    if (!checkPassword(String(body?.password ?? ""), share)) {
      recordFail(ipKey, SHARE_LIMITS.loginFailsPerIp, now);
      recordFail(slugKey, SHARE_LIMITS.loginFailsPerSlug, now);
      return err(401, "That password didn't work.");
    }
    fails.delete(ipKey);
    const exp = Math.min(now + SHARE_LIMITS.sessionMs, Date.parse(share.hardCutoffAt));
    const token = signShareSession({ slug, sid: crypto.randomBytes(9).toString("hex"), exp });
    const maxAge = Math.max(0, Math.floor((exp - now) / 1000));
    return {
      status: 200,
      body: { ok: true, ...view(share, state) },
      setCookie: `${shareCookieName(slug)}=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${req.secure ? "; Secure" : ""}`,
    };
  }

  /* Everything below needs a valid session FOR THIS SLUG. */
  const session = verifyShareSession(req.cookies[shareCookieName(slug)], undefined, now);
  if (!session || session.slug !== slug) return err(401, "Please sign in again.", { needsLogin: true });

  if (action === "demo") {
    if (method !== "GET") return err(405, "Method not allowed.");
    return { status: 200, body: { ...view(share, state), profile: rec.profile, customizations: rec.customizations, brainKeys: Object.keys(share.brains) } };
  }

  /* From here every route spends model or voice budget. */
  if (method !== "POST") return err(405, "Method not allowed.");
  if (state !== "live")
    return err(403, "The live agents in this demo have been turned off. The dashboards and workflow are still available to explore.", { state });

  const entry = share.brains[String(body?.brainKey ?? "")];
  if (!entry) return err(400, "Unknown agent.");
  /* Pin the identity: whatever the browser or the snapshot says, this is this demo's customer. */
  const brain = { ...(entry.brain as object), customerName: rec.prospect };
  const isVoiceKey = /voice/.test(String(body?.brainKey));

  if (action === "chat") {
    if (!deps.aiConfigured()) return err(503, "The demo agent is not available right now.");
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    if (msgs.length > SHARE_LIMITS.maxMessages) return err(400, "This conversation is too long to continue.");
    const messages = msgs.map((x: any) => ({
      role: x?.role === "assistant" ? "assistant" as const : "user" as const,
      content: cleanText(x?.content, SHARE_LIMITS.maxMessageChars),
    }));
    /* A customer message is a turn. The opening call with no history is the agent's greeting
       and is free, or every conversation would start one turn down. */
    if (messages.length) {
      const s = spend(rec.id, session.sid, "chat", now);
      if (!s.ok) return err(429, s.reason, { limit: true });
    }
    const reply = await deps.chat(brain, messages, isVoiceKey);
    /* The model's OWN reply, which a customer cannot forge. */
    const turns: Turn[] = [...messages.map((m: { role: string; content: string }) => ({ role: m.role === "assistant" ? "agent" as const : "customer" as const, text: m.content })), { role: "agent", text: reply }];
    const escalation = await maybeEscalate({ rec, session, req, deps, now, channel: "sms", agentText: reply, turns });
    return { status: 200, body: { reply, ...(escalation ? { escalation } : {}) } };
  }

  if (action === "analyze") {
    if (!deps.aiConfigured()) return err(503, "The demo agent is not available right now.");
    const t = Array.isArray(body?.transcript) ? body.transcript : [];
    if (!t.length || t.length > SHARE_LIMITS.maxTranscriptTurns) return err(400, "Invalid transcript.");
    const s = spend(rec.id, session.sid, "analyze", now);
    if (!s.ok) return err(429, s.reason, { limit: true });
    const p: any = rec.profile ?? {};
    /* VOICE ONLY: an SMS conversation was already checked reply by reply above. The transcript here
       comes from the browser, so only lines attributed to the AGENT count, and the caps in
       `spendEscalation` bound what a forged one can do. */
    let escalation: Escalation | null = null;
    if (body?.channel === "voice") {
      const turns: Turn[] = t.map((x: any) => ({
        role: x?.speaker === "agent" ? "agent" as const : "customer" as const,
        text: cleanText(x?.text ?? x?.content, SHARE_LIMITS.maxMessageChars),
      }));
      const lastAgent = [...turns].reverse().find((x) => x.role === "agent" && detectEscalation(x.text));
      if (lastAgent) escalation = await maybeEscalate({ rec, session, req, deps, now, channel: "voice", agentText: lastAgent.text, turns });
    }
    const dests = Array.isArray(body?.destinations) ? body.destinations.slice(0, 20).map((d: unknown) => cleanText(d, 80)) : undefined;
    const analysed = await deps.analyze({
        customerName: rec.prospect,
        bookingTerm: cleanText(p.bookingTerm, 60) || undefined,
        customerNoun: cleanText(p.customerNoun, 40) || undefined,
        channel: body?.channel === "voice" ? "voice" : "sms",
        destinations: dests,
        transcript: t.map((x: any) => ({ ...x, text: cleanText(x?.text ?? x?.content, SHARE_LIMITS.maxMessageChars) })),
    });
    return { status: 200, body: { ...(analysed as object), ...(escalation ? { escalation } : {}) } };
  }

  if (action === "voice-token") {
    if (!deps.voiceConfigured()) return err(501, "Voice is not available in this demo right now.");
    const s = spend(rec.id, session.sid, "voice", now);
    if (!s.ok) return err(429, s.reason, { limit: true });
    const seconds = SHARE_LIMITS.voiceCallSeconds;
    const minted = await deps.mintVoice({
      brain,
      profileId: rec.id,
      greeting: entry.greeting,
      voice: typeof body?.voice === "string" ? body.voice : entry.voice,
      ttl: `${Math.ceil(seconds / 60)}m`,
    });
    deps.endRoomAfter(minted.room, (seconds + 5) * 1000);
    return { status: 200, body: { ...minted, maxSeconds: seconds } };
  }

  return err(404, "Not found.");
}

/** Record an escalation if this reply ends with one and the caps allow it. Never throws: the
 *  customer's conversation must not fail because a mail did, and the record itself is saved
 *  before any mail is attempted (engine/callbacks.ts). Returns the kind so the customer's
 *  screen can confirm it, or null. */
async function maybeEscalate(a: {
  rec: DemoRecord; session: ShareSession; req: ShareReq; deps: ShareDeps; now: number;
  channel: "sms" | "voice"; agentText: string; turns: Turn[];
}): Promise<Escalation | null> {
  const want = detectEscalation(a.agentText);
  if (!want) return null;
  if (!spendEscalation(a.rec.id, a.session.sid, want, a.now)) return want;   // already recorded, or capped: still tell the customer
  try {
    await a.deps.escalate({
      slug: a.session.slug,
      demoId: a.rec.id,
      prospect: a.rec.prospect,
      ownerEmail: a.rec.creator?.email ?? "",
      channel: a.channel,
      want,
      phone: extractPhone(a.turns.filter((x) => x.role === "customer").map((x) => x.text)),
      confirmation: confirmationText(a.agentText),
      transcript: excerpt(a.turns),
      origin: a.req.origin ?? process.env.BASE_URL ?? "",
    });
  } catch (e) {
    console.error("[share] could not record an escalation:", (e as Error).message);
  }
  return want;
}

/** What the customer's browser may know about the share itself. */
function view(share: ShareBlock, state: ShareState) {
  return {
    state,
    ...shareSummary(share),
    limits: {
      chatTurnsPerSession: SHARE_LIMITS.chatTurnsPerSession,
      voiceCallSeconds: SHARE_LIMITS.voiceCallSeconds,
    },
  };
}

export function saveShare(rec: DemoRecord, share: ShareBlock): DemoRecord {
  const saved = saveDemo({ ...rec, share, updatedAt: new Date().toISOString() });
  indexShare(share.slug, saved.id);
  return saved;
}
