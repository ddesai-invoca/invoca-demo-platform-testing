import type { CustomerProfile } from "./schema.ts";

/* =============================================================================
   voiceCopy.ts — the voice workflow's per-prospect vocabulary
   -----------------------------------------------------------------------------
   ⚠️ **MOVED OUT OF `AgentWorkflow.tsx` (8/27/2026) BECAUSE A SECOND CALLER NEEDED IT.**
   `deriveVoiceSpec` builds the agent's greeting, qualifying question and routing steps, and
   it MUST use the same words the diagram draws — the segment titles on the tree ARE the
   Qualify drawer's answers and the prompt's routes. Two copies of this would disagree the
   first time either was tuned, and the symptom is the worst kind: the diagram says one thing
   and the agent says another, with nothing failing. Exactly why `isProspect` moved to
   `prospect.ts` when the Comfort Keepers dashboard needed the same test.
   ============================================================================= */

/* Derives every label from the prospect's own voice routing queues
   (reports.voiceRoutingDemo.queues), which all seven profiles already carry in
   the same shape: [0] is the new-business intent, [1] is existing-customer
   support, [2] is general. Previously this tree was hardcoded Shady Blinds
   retail copy, so Orlando Health's voice workflow talked about ordering window
   treatments and collecting an Order Number. */
export function voiceCopy(p: CustomerProfile) {
  const q = p.reports.voiceRoutingDemo?.queues ?? [];
  /* Queue names carry a qualifier after a separator ("Consultation - LASIK New
     Patient"); the node title wants the head, so cut at the first one.

     COMMA included, not just dashes: the em-dash migration rewrote every queue
     name from "Support - Existing Move" to "Support, Existing Move", so this
     stopped trimming anything and the intent nodes started showing the whole
     queue name. Splitting on both restores what the code always meant to do. */
  const head = (n?: string, fb = "") =>
    (n ?? fb).split(/\s*[-–—,]\s*/)[0].trim() || fb;
  const newQ = head(q[0]?.name, "New Inquiry");
  const supQ = head(q[1]?.name, "Existing Customer Support");
  // "patient" vs "customer" comes from the prospect's own queue wording rather
  // than a guess about the vertical.
  const who = /patient/i.test(q[1]?.name ?? "") ? "patient"
    : /resident/i.test(q[1]?.name ?? "") ? "resident" : "customer";
  const hero = p.reports.marketingDashboard.breakdowns
    .find((b) => /Product Category/i.test(b.title))?.rows[0]?.name;
  const booking = p.bookingTerm.toLowerCase();
  return {
    newQ, supQ, who,
    newSub: `Caller wants to book ${/^[aeiou]/i.test(booking) ? "an" : "a"} ${booking} and is not an existing ${who}`,
    supSub: `Caller is an existing ${who} and needs help with something already in progress`,
    newChips: [hero ?? p.industry, p.bookingTerm, "Timeline"],
    supChips: [`Existing ${who[0].toUpperCase()}${who.slice(1)}`, "Issue Type"],
    bookingLower: booking,
    newQueue: q[0]?.name ?? "New Inquiry",
    supQueue: q[1]?.name ?? "Support",
  };
}
