/* =============================================================================
   callbacks.ts — a customer asked for a person: store it, and tell the SE
   -----------------------------------------------------------------------------
   Stored as a feedback record of kind "callback" so it lands in the Inbox the maintainer
   already reads. Emailed to the SE who shared the demo and to the admins, deduplicated, and
   never by a route a customer controls beyond the caps in engine/share.ts.

   ⚠️ SAVED BEFORE IT IS MAILED, AND THE MAIL CANNOT FAIL THE CALL. `sendMail` never throws and
   the record is on disk first, so an unconfigured mailer costs a notification and never a
   callback request: the Inbox still has it. AWAITED rather than fire-and-forget, for the same
   reason the new-feedback notice is: a floating promise can die with the SIGTERM drain.
   ============================================================================= */

import { saveFeedback, newFeedbackId, STATUSES, type FeedbackRecord } from "./feedbackStore.ts";
import { sendMail, callbackEmail } from "./mailer.ts";
import { adminEmails } from "./admins.ts";
import type { Escalation } from "./escalation.ts";

export interface EscalationInput {
  slug: string;
  demoId: string;
  prospect: string;
  ownerEmail: string;
  channel: "sms" | "voice";
  want: Escalation;
  phone?: string;
  confirmation: string;
  transcript: string;
  origin: string;        // https://host, for the link in the email
}

/** Who is emailed: the SE who shared the demo, and nobody else.
 *
 *  ⚠️ NOT EVERY ADMIN. The admin list here is five people, and a customer's callback is one
 *  person's job (the one who has to ring back); mailing all of them would train four people to
 *  ignore the subject line, which is the failure the "permanent 0 badge" note already records.
 *  Admins still see every callback in the Inbox. Only when the owner has no usable address
 *  (a local dev identity, a demo whose creator was never a real account) does it fall back to
 *  the admins, so a callback is never mailed to nobody. */
export function callbackRecipients(ownerEmail: string, admins: string[] = adminEmails()): string[] {
  const owner = String(ownerEmail ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(owner) ? [owner] : [...new Set(admins.map((a) => a.toLowerCase()))];
}

export async function recordEscalation(i: EscalationInput): Promise<FeedbackRecord> {
  const now = new Date().toISOString();
  const who = { email: `share:${i.slug}`, name: `${i.prospect} demo visitor` };
  const title = i.want === "live"
    ? `${i.prospect} demo: asked for a person`
    : `${i.prospect} demo: callback${i.phone ? ` to ${i.phone}` : ""}`;
  const rec: FeedbackRecord = {
    id: newFeedbackId(),
    kind: "callback",
    title,
    body: `${i.confirmation ? i.confirmation + "\n\n" : ""}${i.transcript}`.slice(0, 6000),
    page: `/d/${i.slug}`,
    submitter: who,
    status: STATUSES[0],
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, status: STATUSES[0], by: who }],
    callback: {
      demoId: i.demoId, prospect: i.prospect, ownerEmail: i.ownerEmail.toLowerCase(),
      channel: i.channel, want: i.want, phone: i.phone, confirmation: i.confirmation,
    },
  };
  saveFeedback(rec);

  const to = callbackRecipients(i.ownerEmail);
  for (const addr of to) {
    const res = await sendMail(callbackEmail({
      to: addr, prospect: i.prospect, channel: i.channel, want: i.want,
      phone: i.phone, confirmation: i.confirmation, transcript: i.transcript,
      boardUrl: `${i.origin.replace(/\/+$/, "")}/feedback`,
    }));
    if (!res.sent) console.log(`[callback] no notice to ${addr}: ${res.reason}`);
  }
  return rec;
}
