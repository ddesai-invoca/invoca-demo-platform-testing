/* =============================================================================
   mailer.ts — the one place this app sends email
   -----------------------------------------------------------------------------
   Sends FROM the maintainer's own @invoca.com address, TO the address the person
   signed in with. That was a deliberate choice over a transactional provider:

     • No new vendor, no DNS records, no waiting on IT to verify a domain.
     • It genuinely comes from a person, so a reply lands in a real inbox and the
       thread continues where the feedback started.
     • The recipient address is never typed by anyone. It comes from the Google
       session, so it cannot be mistyped and there is no address field to abuse.

   TWO WAYS TO SEND, tried in this order:

     1. GMAIL API (preferred). Reuses the Google OAuth client this app already has
        for sign-in, plus a one-time consent that mints a refresh token. This is
        the route that works when a Workspace blocks app passwords, which Invoca's
        does: /auth/gmail walks you through it once.
     2. SMTP with an APP PASSWORD. Simpler, and dead on arrival if the Workspace
        disables app passwords ("The setting you are looking for is not available
        for your account"). Kept because it is two env vars on a tenant that
        allows them.

   ⚠️ UNCONFIGURED IS A SUPPORTED STATE, not an error. With no SMTP_USER /
   SMTP_APP_PASSWORD the app runs exactly as before and a would-be email is
   logged instead of sent. The feature works end to end without it; only the
   notification is silent. That is what lets this ship before the credential
   exists, and it is why /api/status reports `integrations.emailConfigured` — a
   BOOLEAN, never the address, since that endpoint is public.
   ============================================================================= */

import nodemailer from "nodemailer";

const HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const PORT = Number(process.env.SMTP_PORT || 465);
import { appEnv, isProduction } from "./appEnv.ts";

const USER = process.env.SMTP_USER || "";              // e.g. ddesai@invoca.com
const PASS = process.env.SMTP_APP_PASSWORD || "";      // Google app password
const FROM_NAME = process.env.SMTP_FROM_NAME || "Invoca Demo Generator";

/* Gmail API route. GMAIL_SENDER is the address it sends AS; the refresh token was
   minted by that account consenting at /auth/gmail. The OAuth client is the same
   one sign-in uses, so there is no second app to register. */
const GMAIL_REFRESH = process.env.GMAIL_REFRESH_TOKEN || "";
const GMAIL_SENDER = process.env.GMAIL_SENDER || USER;
const OAUTH_ID = process.env.GOOGLE_CLIENT_ID || "";
const OAUTH_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

const gmailReady = (): boolean => !!(GMAIL_REFRESH && GMAIL_SENDER && OAUTH_ID && OAUTH_SECRET);
const smtpReady = (): boolean => !!(USER && PASS);

/** True when a real send is possible either way. /api/status reports this. */
export const mailConfigured = (): boolean => gmailReady() || smtpReady();

/** Which route is live, for diagnostics. Never includes a credential. */
export const mailMode = (): "gmail" | "smtp" | "off" =>
  gmailReady() ? "gmail" : smtpReady() ? "smtp" : "off";

/** The address replies go to, for the UI to show honestly. Empty when unset. */
export const mailFrom = (): string => (gmailReady() ? GMAIL_SENDER : USER);

/* A refresh token is long-lived, an access token is not. Exchanged per send and
   cached until just before it expires: a nightly-ish send does not need a
   background refresher, and a stale token is the failure this avoids. */
let accessToken = "";
let accessExpiry = 0;
async function gmailAccessToken(): Promise<string> {
  if (accessToken && Date.now() < accessExpiry) return accessToken;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH_ID, client_secret: OAUTH_SECRET,
      refresh_token: GMAIL_REFRESH, grant_type: "refresh_token",
    }),
  });
  const tok: any = await res.json();
  if (!tok?.access_token) throw new Error(tok?.error_description || tok?.error || "Could not refresh the Gmail token.");
  accessToken = tok.access_token;
  accessExpiry = Date.now() + Math.max(0, (Number(tok.expires_in) || 3600) - 60) * 1000;
  return accessToken;
}

/* RFC 2822 on the wire, base64url for the API. Subjects are RFC 2047 encoded
   because a non-ASCII character in a raw header is not legal and silently mangles
   the subject line in some clients. */
function rawMessage(from: string, mail: Mail): string {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const subject = /^[\x20-\x7E]*$/.test(mail.subject)
    ? mail.subject
    : `=?UTF-8?B?${b64(mail.subject)}?=`;
  const boundary = "b" + Math.random().toString(36).slice(2);
  const headers = [
    `From: ${from}`, `To: ${mail.to}`, `Reply-To: ${mail.replyTo || GMAIL_SENDER || from}`,
    `Subject: ${subject}`, "MIME-Version: 1.0",
  ];
  const body = mail.html
    ? [
        `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
        `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", mail.text, "",
        `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "", mail.html, "",
        `--${boundary}--`,
      ]
    : ["Content-Type: text/plain; charset=UTF-8", "", mail.text];
  return Buffer.from([...headers, ...body].join("\r\n"), "utf8").toString("base64url");
}

async function sendViaGmail(mail: Mail): Promise<void> {
  const token = await gmailAccessToken();
  const from = `"${FROM_NAME}" <${GMAIL_SENDER}>`;
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: rawMessage(from, mail) }),
  });
  if (!res.ok) {
    const detail: any = await res.json().catch(() => ({}));
    throw new Error(detail?.error?.message || `Gmail API returned ${res.status}`);
  }
}

let transport: nodemailer.Transporter | null = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: PORT === 465,     // 465 implicit TLS; 587 upgrades via STARTTLS
      auth: { user: USER, pass: PASS },
    });
  }
  return transport;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /* Optional, and it exists for ONE case: the new-item notice goes to the admin
     but the obvious next action is replying to whoever sent it, so that mail
     points Reply-To at the submitter. Defaults to the sending account, which is
     what the completion email wants (a reply there should reach the maintainer,
     not be sent to the person who is already the recipient). */
  replyTo?: string;
}

/**
 * Send one message. NEVER throws: a notification failing must not fail the
 * status change that triggered it, or an admin's click reports an error while the
 * item is already updated on disk. Returns what happened so the caller can say so.
 */
export async function sendMail(mail: Mail): Promise<{ sent: boolean; reason?: string }> {
  /* ⚠️⚠️ **NON-PRODUCTION NEVER SENDS, IT LOGS.** Feedback completion mail goes to the
     SUBMITTER's real sign-in address. A staging service stood up by copying production's
     environment variables would therefore email real colleagues about test items from a
     service they have never heard of. `sendMail` already treats "unconfigured" as a supported
     state and logs instead, so this reuses that path rather than adding a second one; set
     `ALLOW_EMAIL=1` on a non-production service to genuinely send. */
  if (!isProduction() && process.env.ALLOW_EMAIL !== "1") {
    console.log(`[mail] ${appEnv()}: not sending to ${mail.to} — "${mail.subject}"`);
    return { sent: false, reason: `${appEnv()} does not send email` };
  }
  if (!mailConfigured()) {
    console.log(`[mail] not configured, would have sent to ${mail.to}: ${mail.subject}`);
    return { sent: false, reason: "not configured" };
  }
  try {
    if (gmailReady()) await sendViaGmail(mail);
    else await getTransport().sendMail({
      from: `"${FROM_NAME}" <${USER}>`,
      replyTo: mail.replyTo || USER,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    console.log(`[mail] sent via ${mailMode()} to ${mail.to}: ${mail.subject}`);
    return { sent: true };
  } catch (e: any) {
    /* Logged, not thrown. Most likely causes: a revoked app password, or a Gmail
       refresh token that was withdrawn in the Google account's security settings.
       The item is still saved either way. */
    console.error(`[mail] failed to ${mail.to}:`, e?.message || e);
    return { sent: false, reason: e?.message || "send failed" };
  }
}

/* ---- the two messages this app sends ---------------------------------------- */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "Someone just sent something" — to the ADMIN, when a new item is submitted.
 *
 *  ⚠️ THIS EXISTS BECAUSE NOTHING TOLD THE MAINTAINER ANYTHING (added 9/10/2026).
 *  The only mail this app sent was the COMPLETION notice, to the SUBMITTER, so the
 *  sole signal that feedback had arrived was the Inbox badge on the live launch
 *  screen. That badge is per-instance: working on localhost you see the local
 *  store's count and never the live one. Measured when it was reported — 15 open
 *  items on the live board, three of them colleagues' feedback sitting In review
 *  for over two weeks, while the local badge read a reassuring 8 from test data.
 */
export function newItemEmail(opts: {
  to: string; kind: string; title: string; body: string;
  submitterName: string; submitterEmail: string; page?: string; boardUrl: string;
}): Mail {
  const what = opts.kind === "feature" ? "Feature request" : "Feedback";
  const who = opts.submitterName || opts.submitterEmail;
  const lines = [
    `${who} sent ${opts.kind === "feature" ? "a feature request" : "feedback"}:`,
    ``,
    `  "${opts.title}"`,
    ``,
    opts.body,
    ``,
    ...(opts.page ? [`Sent from ${opts.page}`, ``] : []),
    `Reply to this email to answer ${who} directly.`,
    ``,
    `Open the board: ${opts.boardUrl}`,
  ];
  const html =
    `<div style="font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#0a231e">` +
    `<p><strong>${esc(who)}</strong> sent ${esc(what.toLowerCase())}:</p>` +
    `<blockquote style="margin:16px 0;padding:12px 16px;background:#f8faf1;border-left:3px solid #00b388;border-radius:0 8px 8px 0">` +
    `<strong>${esc(opts.title)}</strong><br><span style="color:#3d4d48">${esc(opts.body).replace(/\n/g, "<br>")}</span>` +
    `</blockquote>` +
    (opts.page ? `<p style="color:#626464;font-size:13px">Sent from <code>${esc(opts.page)}</code></p>` : "") +
    `<p>Reply to this email to answer ${esc(who)} directly.</p>` +
    `<p><a href="${esc(opts.boardUrl)}" style="color:#00a87f">Open the board</a></p>` +
    `</div>`;
  return {
    to: opts.to,
    /* The kind is in the subject so a rule can file them, and the title is what
       makes the notification readable without opening anything. */
    subject: `${what}: ${opts.title}`,
    text: lines.join("\n"),
    html,
    /* ⚠️ REPLY GOES TO THE SUBMITTER, not to the sending account. Answering the
       person who reported it is the whole next action, and this app sends FROM the
       maintainer's own address — so without this, hitting Reply mails yourself. */
    replyTo: opts.submitterEmail,
  };
}

/** "Your request is done" — sent when an item first reaches a terminal status. */
export function completionEmail(opts: {
  to: string; name: string; kind: string; title: string; note?: string; boardUrl: string;
}): Mail {
  const first = (opts.name || "").split(/\s+/)[0] || "there";
  const what = opts.kind === "feature" ? "feature request" : "feedback";
  const lines = [
    `Hi ${first},`,
    ``,
    `The ${what} you sent about the Invoca Demo Generator is done:`,
    ``,
    `  "${opts.title}"`,
    ...(opts.note ? [``, opts.note] : []),
    ``,
    `It is live now, so you should see it the next time you open the tool.`,
    ``,
    `You can see everything you have sent here: ${opts.boardUrl}`,
    ``,
    `Thanks for taking the time to send it, it is genuinely useful.`,
  ];
  const html =
    `<div style="font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#0a231e">` +
    `<p>Hi ${esc(first)},</p>` +
    `<p>The ${esc(what)} you sent about the Invoca Demo Generator is done:</p>` +
    `<blockquote style="margin:16px 0;padding:12px 16px;background:#f8faf1;border-left:3px solid #00b388;border-radius:0 8px 8px 0">` +
    `<strong>${esc(opts.title)}</strong>${opts.note ? `<br><span style="color:#3d4d48">${esc(opts.note)}</span>` : ""}` +
    `</blockquote>` +
    `<p>It is live now, so you should see it the next time you open the tool.</p>` +
    `<p><a href="${esc(opts.boardUrl)}" style="color:#00a87f">See everything you have sent</a></p>` +
    `<p style="color:#626464">Thanks for taking the time to send it, it is genuinely useful.</p>` +
    `</div>`;
  return { to: opts.to, subject: `Done: ${opts.title}`, text: lines.join("\n"), html };
}


/** "A customer asked for a person" — to whoever shared the demo, and the admins.
 *
 *  ⚠️ THE CUSTOMER GAVE A PHONE NUMBER AND NO EMAIL, so there is nobody to Reply to: the whole
 *  point of this mail is to ring them back, and the number and time go at the top. Deliberately
 *  no `replyTo`, which would otherwise send the reply to the sending account. */
export function callbackEmail(opts: {
  to: string; prospect: string; channel: string; want: "callback" | "live";
  phone?: string; confirmation: string; transcript: string; boardUrl: string;
}): Mail {
  const what = opts.want === "live" ? "asked to be connected to a person" : "asked for a callback";
  const lines = [
    `Someone on the ${opts.prospect} demo (${opts.channel === "voice" ? "voice call" : "text chat"}) ${what}.`,
    ``,
    ...(opts.phone ? [`Number they gave: ${opts.phone}`] : [`No number was captured in text. Check the read-back below.`]),
    ...(opts.confirmation ? [``, `What the agent confirmed:`, `  ${opts.confirmation}`] : []),
    ``,
    `The conversation:`,
    opts.transcript,
    ``,
    `Open it in the Inbox: ${opts.boardUrl}`,
  ];
  const html =
    `<div style="font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#0a231e">` +
    `<p>Someone on the <strong>${esc(opts.prospect)}</strong> demo (${opts.channel === "voice" ? "voice call" : "text chat"}) ${esc(what)}.</p>` +
    `<p style="font-size:18px;margin:12px 0"><strong>${opts.phone ? esc(opts.phone) : "No number captured in text"}</strong></p>` +
    (opts.confirmation ? `<blockquote style="margin:12px 0;padding:10px 14px;background:#f8faf1;border-left:3px solid #00b388;border-radius:0 8px 8px 0">${esc(opts.confirmation)}</blockquote>` : "") +
    `<p style="color:#626464;font-size:13px;margin-bottom:4px">The conversation</p>` +
    `<pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;background:#f4f5f4;padding:10px 14px;border-radius:8px">${esc(opts.transcript)}</pre>` +
    `<p><a href="${esc(opts.boardUrl)}" style="color:#00a87f">Open it in the Inbox</a></p>` +
    `</div>`;
  return { to: opts.to, subject: `Callback request: ${opts.prospect}`, text: lines.join("\n"), html };
}
