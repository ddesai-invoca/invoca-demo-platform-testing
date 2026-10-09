/* audit-share.ts — the customer-facing share surface (engine/share.ts), and the wiring that
   keeps it the ONLY thing a customer can reach.

   Runs the REAL handlers against a throwaway DATA_DIR and fake model/voice deps, so the caps,
   lockouts, expiry and the "a customer can never supply its own prompt" rule are exercised
   rather than grepped for. Each check was broken on purpose and seen to fire — see the
   commit that added this file. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-share-"));
process.env.DATA_DIR = tmp;          // BEFORE demoStore loads: it resolves the dir at import time

const store = await import("../engine/demoStore.ts");
const S = await import("../engine/share.ts");
const api = await import("../engine/demoApi.ts");

let bad = 0;
const ok = (c: boolean, msg: string) => { if (!c) { bad++; console.log("FAIL", msg); } else console.log("ok  ", msg); };

/* ── password ── */
ok(S.derivePassword("Acme Corp.") === "acmecorp", "password is the name, lower-cased and stripped");
ok(S.derivePassword("  ACME-corp ") === "acmecorp", "punctuation and case never lock a customer out");
ok(S.derivePassword("Café Münch") === "cafemunch", "diacritics are folded");
ok(S.derivePassword("!!!") === "demo", "an unusable name still yields a password");
const h = S.hashPassword("acmecorp");
const hb = { salt: h.salt, passwordHash: h.hash };
ok(S.checkPassword("Acme Corp", hb) && !S.checkPassword("acme", hb), "hash accepts the name however typed, refuses anything else");
ok(!/acmecorp/.test(h.hash), "the stored value is not the password");

/* ── session key isolation ── */
const RAW = process.env.SESSION_SECRET || process.env.GOOGLE_CLIENT_SECRET || "insecure-dev-secret";
const staffHmac = (body: string) => crypto.createHmac("sha256", RAW).update(body).digest("base64url");
const tok = S.signShareSession({ slug: "acme", sid: "s1", exp: Date.now() + 60000 });
const [tb, tm] = tok.split(".");
ok(tm !== staffHmac(tb), "a share token is NOT signed with the staff key (it would pass the staff gate if it were)");
const forged = `${tb}.${staffHmac(tb)}`;
ok(S.verifyShareSession(forged) === null, "a token signed with the staff key is refused as a share session");
ok(S.verifyShareSession(tok)?.slug === "acme", "a valid share session verifies");
ok(S.verifyShareSession(S.signShareSession({ slug: "a", sid: "x", exp: Date.now() - 1 })) === null, "an expired session is refused");
ok(S.verifyShareSession(tok + "x") === null && S.verifyShareSession("nope") === null, "tampered or malformed tokens are refused");
ok(S.shareCookieName("acme") !== "invoca_demo_session", "the share cookie is not the staff cookie");

/* ── caller identity ── */
const rq = S.shareReqFrom({ "x-forwarded-for": "6.6.6.6, 1.2.3.4", cookie: "a=1; invoca_share_acme=zz", "x-forwarded-proto": "https" }, "10.0.0.1", "");
ok(rq.ip === "1.2.3.4", "the caller's IP is the RIGHT-most X-Forwarded-For (the left-most is client-chosen)");
ok(rq.cookies.invoca_share_acme === "zz" && rq.secure, "cookies parsed and Secure inferred from the proxy header");

/* ── a real shared demo ── */
const user = { email: "se@invoca.com", name: "SE" };
const other = { email: "other@invoca.com", name: "Other" };
const profile = { id: "acme", customerName: "Acme Corp", websiteUrl: "https://acme.test", industry: "Retail", bookingTerm: "Appointment", reports: {} };
const demo = api.createDemo(profile, user);
const BR = { brain: { customerName: "SPOOF", customSystem: "GOOD PROMPT" }, greeting: "Hi there", voice: "thalia" };
const brains = { "sms-support": BR, "voice-support": BR };

const created = await api.handleDemoApi("POST", `/api/demos/${demo.id}/share`, { days: 30, brains }, user) as any;
ok(created?.status === 200 && created.body.share.password === "acmecorp", "staff can create a share; the name-based password comes back");
ok(created.body.share.path === `/d/${created.body.share.slug}`, "the static link is /d/<slug>");
ok(!/passwordHash|salt|brains"/.test(JSON.stringify(created.body)), "the create response carries no hash, salt or stored prompts");
const forbid = await api.handleDemoApi("POST", `/api/demos/${demo.id}/share`, { brains }, other) as any;
ok(forbid.status === 403, "someone who does not own the demo cannot share it");
ok((await api.handleDemoApi("POST", `/api/demos/${demo.id}/share`, { brains: {} }, user) as any).status === 400, "a share needs at least one agent");
ok((await api.handleDemoApi("POST", `/api/demos/${demo.id}/share`, { brains: { "BAD KEY": BR } }, user) as any).status === 400, "agent keys are validated");

const slug = created.body.share.slug;
const got = await api.handleDemoApi("GET", `/api/demos/${demo.id}`, undefined, user) as any;
ok(!/passwordHash|"salt"|brains/.test(JSON.stringify(got.body)) && got.body.demo.share?.slug === slug, "GET /api/demos/:id exposes only the share summary");
ok(!/passwordHash|"salt"|brains/.test(JSON.stringify(store.listDemos())), "the demo list exposes no hash, salt or prompts");
const patched = await api.handleDemoApi("PATCH", `/api/demos/${demo.id}`, { share: { slug: "evil", revokedAt: null }, customizations: { overrides: {}, tiles: {} } }, user) as any;
ok(store.getDemo(demo.id)?.share?.slug === slug && patched.status === 200, "PATCH cannot set, replace or clear the share");
const dup = (await api.handleDemoApi("POST", `/api/demos/${demo.id}/duplicate`, undefined, user) as any).body.demo;
ok(!dup.share && !store.getDemo(dup.id)?.share, "a duplicate is not shared");

/* fake deps */
const seen: any = { brains: [] as any[], mints: [] as any[], ends: [] as any[] };
const deps: any = {
  aiConfigured: () => true, voiceConfigured: () => true,
  chat: async (brain: any, msgs: any[]) => { seen.brains.push(brain); seen.msgs = msgs; return "reply"; },
  analyze: async () => ({ signals: [], outcome: undefined }),
  mintVoice: async (r: any) => { seen.mints.push(r); return { url: "wss://x", token: "t", room: `room-${seen.mints.length}`, agentName: "a" }; },
  endRoomAfter: (room: string, ms: number) => seen.ends.push([room, ms]),
  escalate: async (i: any) => { if (seen.escFail) throw new Error("mail down"); seen.esc.push(i); return {}; },
};
seen.esc = [] as any[];
const call = (m: string, action: string, body: any, cookies: any = {}, ip = "9.9.9.9", now = Date.now()) =>
  S.handleShareApi(m, `/api/share/${slug}/${action}`, body, { cookies, ip, secure: false }, deps, now) as Promise<any>;
const cookieFrom = (r: any) => { const c = String(r.setCookie).split(";")[0]; const i = c.indexOf("="); return { [c.slice(0, i)]: c.slice(i + 1) }; };

/* login */
S.resetShareLockoutsForTest();
const unknown = await S.handleShareApi("POST", "/api/share/nope/login", { password: "x" }, { cookies: {}, ip: "1.1.1.1", secure: false }, deps) as any;
const wrong = await call("POST", "login", { password: "wrong" }, {}, "2.2.2.2");
ok(unknown.status === 401 && wrong.status === 401 && JSON.stringify(unknown.body) === JSON.stringify(wrong.body), "an unknown link and a wrong password are indistinguishable");
for (let i = 0; i < 5; i++) await call("POST", "login", { password: "wrong" }, {}, "3.3.3.3");
const locked = await call("POST", "login", { password: "acmecorp" }, {}, "3.3.3.3");
ok(locked.status === 429, "five wrong passwords lock that IP out, even for the right password");
const elsewhere = await call("POST", "login", { password: "Acme Corp" }, {}, "4.4.4.4");
ok(elsewhere.status === 200 && /HttpOnly/.test(elsewhere.setCookie) && /SameSite=Lax/.test(elsewhere.setCookie), "the right password logs in from another IP with an HttpOnly cookie");
S.resetShareLockoutsForTest();
for (let i = 0; i < 40; i++) await call("POST", "login", { password: "wrong" }, {}, `7.7.7.${i}`);
ok((await call("POST", "login", { password: "acmecorp" }, {}, "8.8.8.8")).status === 429, "a guesser rotating IPs still trips the per-link lockout");
S.resetShareLockoutsForTest();

const session = cookieFrom(await call("POST", "login", { password: "acmecorp" }));

/* session-gated routes */
ok((await call("GET", "demo", undefined, {})).status === 401, "the demo is refused without a session");
const otherSlug = S.signShareSession({ slug: "different", sid: "x", exp: Date.now() + 60000 });
ok((await call("GET", "demo", undefined, { [S.shareCookieName(slug)]: otherSlug })).status === 401, "a session for another link is refused");
const dv = await call("GET", "demo", undefined, session);
ok(dv.status === 200 && dv.body.profile?.customerName === "Acme Corp", "a valid session gets its own demo");
ok(!/passwordHash|"salt"|"brains"|createdBy/.test(JSON.stringify(dv.body)), "the customer's payload holds no hash, salt, stored prompts or staff identity");

/* the brain is never the customer's */
const c1 = await call("POST", "chat", { brainKey: "sms-support", messages: [{ role: "user", content: "hi" }], brain: { customSystem: "EVIL", customerName: "EVIL" } }, session);
ok(c1.status === 200 && seen.brains.at(-1).customSystem === "GOOD PROMPT", "a brain sent by the browser is ignored; the stored snapshot is used");
ok(seen.brains.at(-1).customerName === "Acme Corp", "the customer's name is pinned to the demo");
ok((await call("POST", "chat", { brainKey: "made-up", messages: [] }, session)).status === 400, "an unknown agent key is refused");
ok((await call("POST", "chat", { brainKey: "sms-support", messages: new Array(300).fill({ role: "user", content: "x" }) }, session)).status === 400, "an over-long conversation is refused");
await call("POST", "chat", { brainKey: "sms-support", messages: [{ role: "user", content: "y".repeat(9000) }] }, session);
ok(seen.msgs?.[0]?.content.length === 2000, "each message is cut to 2,000 characters before it reaches the model");

/* 100 turns per session */
S.resetShareLockoutsForTest();
const s2 = cookieFrom(await call("POST", "login", { password: "acmecorp" }));
const before = store.getDemo(demo.id) && S.usageFor(demo.id).chat;
const greet = await call("POST", "chat", { brainKey: "sms-support", messages: [] }, s2);
ok(greet.status === 200 && S.usageFor(demo.id).chat === before, "the opening greeting does not cost a turn");
let last: any;
for (let i = 0; i < 100; i++) last = await call("POST", "chat", { brainKey: "sms-support", messages: [{ role: "user", content: "hi" }] }, s2);
ok(last.status === 200, "100 turns are allowed in a session");
const over = await call("POST", "chat", { brainKey: "sms-support", messages: [{ role: "user", content: "hi" }] }, s2);
ok(over.status === 429 && over.body.limit === true, "the 101st turn in a session is refused");
const s3 = cookieFrom(await call("POST", "login", { password: "acmecorp" }));
ok((await call("POST", "chat", { brainKey: "sms-support", messages: [{ role: "user", content: "hi" }] }, s3)).status === 200, "a new session starts its own count");

/* voice: 5 minutes, and a daily ceiling */
const v = await call("POST", "voice-token", { brainKey: "voice-support" }, s3);
ok(v.status === 200 && seen.mints.at(-1).ttl === "5m" && v.body.maxSeconds === 300, "a voice call is capped at 5 minutes");
ok(seen.ends.at(-1)[1] === 305000 && seen.ends.at(-1)[0] === v.body.room, "the room is ended server-side when the 5 minutes are up (the token ttl alone cannot do that)");
ok(seen.mints.at(-1).brain.customSystem === "GOOD PROMPT" && seen.mints.at(-1).profileId === demo.id, "the voice agent gets the stored prompt and the demo's own id");
for (let i = 0; i < 19; i++) await call("POST", "voice-token", { brainKey: "voice-support" }, s3);
ok((await call("POST", "voice-token", { brainKey: "voice-support" }, s3)).status === 429, "voice calls are capped per demo per day, across sessions");

/* expiry */
const rec0 = store.getDemo(demo.id)!;
const soft = Date.parse(rec0.share!.softExpiresAt) + 1000;
/* a session that is still valid at that future moment — the real one lasts 12 hours */
const s4 = { [S.shareCookieName(slug)]: S.signShareSession({ slug, sid: "later", exp: soft + 3600_000 }) };
ok((await call("GET", "demo", undefined, s4, "9.9.9.9", soft)).status === 200, "after the soft expiry the read-only views still open");
const sChat = await call("POST", "chat", { brainKey: "sms-support", messages: [{ role: "user", content: "hi" }] }, s4, "9.9.9.9", soft);
const sVoice = await call("POST", "voice-token", { brainKey: "voice-support" }, s4, "9.9.9.9", soft);
ok(sChat.status === 403 && sVoice.status === 403 && sChat.body.state === "soft-expired", "after the soft expiry the live agents are refused");
const hard = Date.parse(rec0.share!.hardCutoffAt) + 1000;
ok((await call("GET", "demo", undefined, s3, "9.9.9.9", hard)).status === 410 && (await call("POST", "login", { password: "acmecorp" }, {}, "9.9.9.9", hard)).status === 410, "after the hard cutoff the link is gone, including login");

/* extend + revoke */
const ext = await api.handleDemoApi("PATCH", `/api/demos/${demo.id}/share`, { days: 10 }, user) as any;
ok(ext.body.share.state === "live" && Date.parse(ext.body.share.softExpiresAt) > Date.parse(rec0.share!.softExpiresAt), "extending pushes the dates out and never shortens");
const rev = await api.handleDemoApi("DELETE", `/api/demos/${demo.id}/share`, undefined, user) as any;
ok(rev.body.share.state === "revoked" && (await call("GET", "demo", undefined, s3)).status === 410, "revoking kills the link at once, mid-session");
ok((await api.handleDemoApi("DELETE", `/api/demos/${demo.id}/share`, undefined, other) as any).status === 403, "only the owner or an admin can revoke");
const back = await api.handleDemoApi("PATCH", `/api/demos/${demo.id}/share`, { days: 5 }, user) as any;
ok(back.body.share.state === "live", "extending a revoked share brings it back");

/* renamed demo: never display a password that no longer works */
const r2 = store.getDemo(demo.id)!; store.saveDemo({ ...r2, prospect: "Renamed Inc" });
ok((await api.handleDemoApi("GET", `/api/demos/${demo.id}/share`, undefined, user) as any).body.share.password === null, "after a rename the panel does not show a stale password");

/* slugs */
const d2 = api.createDemo({ ...profile, customerName: "Acme Corp" }, user);
const c2 = await api.handleDemoApi("POST", `/api/demos/${d2.id}/share`, { brains }, user) as any;
ok(c2.body.share.slug !== slug && /^acme-corp/.test(c2.body.share.slug), "two demos for one customer get distinct links");
ok(S.findByShareSlug("../etc/passwd") === null && S.findByShareSlug("nope") === null, "slug lookup rejects junk");
ok(S.rebuildShareIndex() >= 2, "the index can be rebuilt from the demo files");


/* ── escalations: a customer asks for a person ── */
const E = await import("../engine/escalation.ts");
const CB = "Your callback is scheduled.", LIVE = "Connecting you to a live agent now.";
ok(E.detectEscalation(`Got it, tomorrow at 10. ${CB}`) === "callback" && E.detectEscalation(LIVE) === "live", "the agent's exact closing lines are detected");
ok(E.detectEscalation(`your callback is scheduled`) === "callback" && E.detectEscalation("Connecting you to a live agent now!") === "live", "case and trailing punctuation do not matter");
ok(E.detectEscalation("Your callback is scheduled for tomorrow around 9 at 407-555-0199.") === "callback" && E.detectEscalation("Connecting you to a live agent right away.") === "live", "the line folded into one closing sentence is still detected");
ok(E.detectEscalation("Your callback is scheduled. Anything else?") === null && E.detectEscalation("I will schedule a callback for you") === null && E.detectEscalation("I'll connect you to someone") === null, "paraphrase, or the line buried mid-message, is NOT an escalation");
ok(E.extractPhone(["hi", "call me on 555-0134 tomorrow"]) === "555-0134" && E.extractPhone(["(407) 555-0192"]) === "(407) 555-0192" && E.extractPhone(["+1 407 555 0192"]) === "+1 407 555 0192" && E.extractPhone(["no number here"]) === undefined, "the phone number is pulled from what the customer typed");
ok(E.extractPhone(["old 555-0100", "new 555-0134"]) === "555-0134", "the LAST number given wins");
ok(!E.confirmationText(`Got it, 555-0134 tomorrow at 10. ${CB}`).includes("scheduled") && E.confirmationText(`Got it, 555-0134 tomorrow at 10. ${CB}`).includes("555-0134"), "the confirmation keeps the number and time and drops the marker line");

const login = async () => { S.resetShareLockoutsForTest(); return cookieFrom(await call("POST", "login", { password: "Acme Corp" })); };
const sessE = await login();
const say = (text: string) => ({ brainKey: "sms-support", messages: [{ role: "user", content: "can someone call me? 555-0134 tomorrow at 10" }, { role: "assistant", content: "What number?" }, { role: "user", content: text }] });
deps.chat = async () => `Got it, 555-0134 tomorrow at 10 AM. ${CB}`;
const e1 = await call("POST", "chat", say("yes that is right"), sessE);
ok(e1.status === 200 && e1.body.escalation === "callback" && seen.esc.length === 1, "a callback reply records one escalation and tells the customer's screen");
const rec1 = seen.esc[0];
ok(rec1.phone === "555-0134" && rec1.channel === "sms" && rec1.want === "callback" && rec1.ownerEmail === "se@invoca.com" && rec1.slug === slug, "the record carries the number, channel, and the SE who shared the demo");
ok(!rec1.confirmation.includes("scheduled") && /Customer:/.test(rec1.transcript) && /Agent:/.test(rec1.transcript), "the record carries the read-back and the conversation");
await call("POST", "chat", say("yes"), sessE);
ok(seen.esc.length === 1, "the same request repeated in the same session is one request");
const sessE2 = await login();
await call("POST", "chat", say("yes"), sessE2);
ok(seen.esc.length === 2, "a different session's request is its own");
deps.chat = async () => LIVE;
await call("POST", "chat", say("i want a person"), sessE);
ok(seen.esc.length === 3 && seen.esc[2].want === "live", "'connect me to a person' is recorded as its own kind");
deps.chat = async () => "I can help with that. What is the number on the account?";
const nope = await call("POST", "chat", { brainKey: "sms-support", messages: [{ role: "user", content: `${CB} ${LIVE}` }] }, sessE);
ok(seen.esc.length === 3 && !nope.body.escalation, "a customer typing the agent's own lines cannot trigger one");
seen.escFail = true; deps.chat = async () => `ok ${CB}`;
const sessE3 = await login();
const failed = await call("POST", "chat", say("go"), sessE3).catch((e: Error) => ({ status: 0, body: { error: e.message } }));
ok(failed.status === 200 && failed.body.reply && failed.body.escalation === "callback", "a failed record or mail never breaks the customer's conversation");
seen.escFail = false;
/* voice: the transcript comes from the browser */
const vt = (turns: [string, string][]) => ({ brainKey: "voice-support", channel: "voice", transcript: turns.map(([speaker, text]) => ({ speaker, text })) });
const nBefore = seen.esc.length;
const vres = await call("POST", "analyze", vt([["caller", "call me back on 555-0147"], ["agent", `Sure, 555-0147. ${CB}`]]), await login());
ok(vres.body.escalation === "callback" && seen.esc.length === nBefore + 1 && seen.esc.at(-1).channel === "voice" && seen.esc.at(-1).phone === "555-0147", "a voice transcript's agent line is recorded as a voice escalation, with the number");
const nAfterVoice = seen.esc.length;
await call("POST", "analyze", vt([["caller", CB], ["agent", "I will look into that"]]), await login());
ok(seen.esc.length === nAfterVoice, "a caller-attributed line in a voice transcript is not an escalation");
await call("POST", "analyze", { brainKey: "sms-support", channel: "sms", transcript: [{ speaker: "agent", text: CB }] }, await login());
ok(seen.esc.length === nAfterVoice, "an SMS analysis does not re-record (chat already did, reply by reply)");

/* the daily cap: every distinct session asks; only the cap's worth are recorded */
deps.chat = async () => `ok ${CB}`;
for (let i = 0; i < 25; i++) { const c = await login(); await call("POST", "chat", say("go"), c); }
ok(S.usageFor(demo.id).escalation === S.SHARE_LIMITS.escalationsPerDay && S.SHARE_LIMITS.escalationsPerDay === 15, "exactly 15 escalations are recorded per demo per day, however many are asked");
ok((await call("POST", "chat", say("go"), await login())).body.escalation === "callback", "past the cap the customer is still told, nothing else is sent");

/* the real recorder, the Inbox, and who may see and triage a callback */
const CBm = await import("../engine/callbacks.ts");
const FA = await import("../engine/feedbackApi.ts");
const FS = await import("../engine/feedbackStore.ts");
const recd = await CBm.recordEscalation({ slug, demoId: demo.id, prospect: "Acme Corp", ownerEmail: "SE@invoca.com", channel: "sms", want: "callback", phone: "555-0134", confirmation: "555-0134 tomorrow at 10", transcript: "Customer: hi\nAgent: hello", origin: "https://x.test/" });
ok(recd.kind === "callback" && recd.submitter.email === `share:${slug}` && recd.callback?.ownerEmail === "se@invoca.com" && FS.getFeedback(recd.id)?.callback?.phone === "555-0134", "a callback is stored in the Inbox as a callback, from a synthetic submitter");
const asOwner = (await FA.handleFeedbackApi("GET", "/api/feedback", undefined, user, false, "https://x.test")) as any;
const asOther = (await FA.handleFeedbackApi("GET", "/api/feedback", undefined, other, false, "https://x.test")) as any;
const asAdmin = (await FA.handleFeedbackApi("GET", "/api/feedback", undefined, { email: "ddesai@invoca.com", name: "D" }, true, "https://x.test")) as any;
ok(asOwner.body.items.some((x: any) => x.id === recd.id) && !asOther.body.items.some((x: any) => x.id === recd.id) && asAdmin.body.items.some((x: any) => x.id === recd.id), "the SE who shared the demo sees its callbacks, another SE does not, an admin sees all");
const sumOwner = (await FA.handleFeedbackApi("GET", "/api/feedback?summary=1", undefined, user, false, "https://x.test")) as any;
ok(sumOwner.body.open.callback >= 1 && sumOwner.body.open.feedback === 0, "the owner's summary counts their open callbacks");
ok(((await FA.handleFeedbackApi("PATCH", `/api/feedback/${recd.id}`, { status: "Complete" }, other, false, "https://x.test")) as any).status === 403, "someone else cannot triage another SE's callback");
const done = (await FA.handleFeedbackApi("PATCH", `/api/feedback/${recd.id}`, { status: "Complete" }, user, false, "https://x.test")) as any;
ok(done.status === 200 && done.body.item.status === "Complete" && !done.body.item.notifiedAt && done.body.mailed === null, "the owner can mark their callback done, and no 'request is done' email is attempted");
ok(((await FA.handleFeedbackApi("PATCH", `/api/feedback/${(await FA.handleFeedbackApi("POST", "/api/feedback", { kind: "feedback", title: "t", body: "b" }, other, false, "https://x.test") as any).body.item.id}`, { status: "Complete" }, user, false, "https://x.test")) as any).status === 403, "an ordinary SE still cannot triage ordinary feedback");
const forgedKind = (await FA.handleFeedbackApi("POST", "/api/feedback", { kind: "callback", title: "t", body: "b" }, user, false, "https://x.test")) as any;
ok(forgedKind.body.item.kind === "feedback", "a signed-in user cannot create a 'callback' record through the feedback form");
ok(JSON.stringify(CBm.callbackRecipients("SE@invoca.com", ["a@invoca.com", "b@invoca.com"])) === JSON.stringify(["se@invoca.com"]), "a callback is emailed to the SE who shared the demo only, not to every admin");
ok(CBm.callbackRecipients("local@dev", ["a@invoca.com"]).join() === "a@invoca.com" && CBm.callbackRecipients("", ["a@invoca.com"]).join() === "a@invoca.com", "with no usable owner address it falls back to the admins, never to nobody");
const mail = await import("../engine/mailer.ts");
const m1 = mail.callbackEmail({ to: "a@b.c", prospect: "Acme", channel: "sms", want: "callback", phone: "555-0134", confirmation: "c", transcript: "t <script>", boardUrl: "https://x/feedback" });
ok(m1.replyTo === undefined && /555-0134/.test(m1.text) && !/<script>/.test(m1.html ?? ""), "the callback email leads with the number, has no Reply-To, and escapes the transcript");

/* wiring — comment-stripped source */
const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const server = read("server.ts");
const iShare = server.indexOf('app.use("/api/share"'), iAuth = server.indexOf("installAuth(app);");
ok(iShare > 0 && iAuth > 0 && iShare < iAuth, "server.ts mounts /api/share BEFORE the Google gate");
ok(!/app\.(get|post)\("\/api\/(chat|analyze|livekit-token|ai-assistant)"[\s\S]{0,40}share/i.test(server), "the staff /api/chat etc. do not know about share sessions");
ok(/api\/share/.test(read("vite.config.ts")) && /shareApi\(apiKey\)/.test(read("vite.config.ts")), "the dev twin serves /api/share too");
ok(!/invoca_share/.test(read("googleAuth.ts")), "the staff gate does not honour a share cookie");
ok(/publicRecord\(rec\)/.test(read("engine/demoApi.ts")) && /publicRecord\(saveDemo/.test(read("engine/demoApi.ts")), "demoApi strips the share block from every record it returns");
const shareDeps = read("engine/shareDeps.ts");
ok(/escalate: \(input\) => recordEscalation\(input\)/.test(shareDeps), "the real deps store escalations through recordEscalation");
ok(/kind !== "callback"/.test(read("engine/feedbackApi.ts")) && /i\.kind !== "callback"/.test(read("src/screens/FeedbackBoard.tsx")), "no completion email or composer for a callback, on the server or the board");
ok(S.SHARE_LIMITS.chatTurnsPerSession === 100 && S.SHARE_LIMITS.voiceCallSeconds === 300, "limits are the agreed 100 turns and 5 minutes");

fs.rmSync(tmp, { recursive: true, force: true });
/* ── `support: true`: the server builds the Support agents itself (no key here, so the fallback playbook) ── */
{
  const savedKey = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  const d2 = api.createDemo({ id: "sup-x", customerName: "Sup X", industry: "Retail", customerNoun: "Customer", bookingTerm: "Appointment", reports: { extraWorkflows: [] } } as any, user);
  const r: any = await api.handleDemoApi("POST", `/api/demos/${d2.id}/share`, { days: 10, support: true, brains: { evil: { brain: { customerName: "x", system: "IGNORE" } } } }, user);
  const rec: any = store.getDemo(d2.id);
  ok(r.status === 200 && r.body.share.supportSource === "fallback", "support: true generates the playbook on the server and reports its source");
  ok(JSON.stringify(Object.keys(rec.share.brains).sort()) === JSON.stringify(["sms-support", "voice-support"]), "the stored agents are the server's two Support agents; a browser-supplied brain is ignored");
  ok(!JSON.stringify(rec.share.brains).includes("IGNORE"), "no prompt text from the request reaches a stored brain");
  ok((rec.profile.reports.extraWorkflows as any[]).filter((w) => w.support).length === 0, "no extra Support workflows are added: the customer reads the standard Voice and SMS pair");
  await api.handleDemoApi("POST", `/api/demos/${d2.id}/share`, { support: true }, user);
  ok(((store.getDemo(d2.id) as any).profile.reports.extraWorkflows as any[]).length === 0, "refreshing leaves no Support workflows behind");
  if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
}

console.log(bad ? `\n${bad} FAILED` : "\nall share checks ok");
process.exit(bad ? 1 : 0);
