/* =============================================================================
   escalation.ts — spotting a Support agent's escalation in a conversation
   -----------------------------------------------------------------------------
   Pure, so the audit can run it. The Support prompt (engine/supportPrompt.ts) makes the agent
   END a message with one exact line when the customer chooses a person or a callback, and
   this looks for those lines.

   ⚠️ DETECTION IS BY THE AGENT'S OWN EXACT LINE, NOT BY READING ITS PROSE. This repo has been
   bitten by reading model wording before (the Salesforce appointment slot; a simulator that
   failed on a curly apostrophe). The line is the contract, and the match ignores case,
   trailing punctuation and curly quotes only.

   ⚠️ THE SMS PATH TRUSTS ONLY THE MODEL'S OWN REPLY — a customer cannot type the agent's line.
   The VOICE path has to read a transcript the browser sends, so it counts only lines
   attributed to the AGENT and the server bounds how many it will record (see share.ts).
   ============================================================================= */

import { SUPPORT_LINES } from "./supportPrompt.ts";

export type Escalation = "callback" | "live";

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[.!\s]+$/g, "").trim();

/** Which escalation, if any, this agent message ends with. */
export function detectEscalation(agentText: string): Escalation | null {
  const t = norm(String(agentText ?? ""));
  if (t.endsWith(norm(SUPPORT_LINES.callback))) return "callback";
  if (t.endsWith(norm(SUPPORT_LINES.live))) return "live";
  /* Measured: about half the time the model folds the line into ONE sentence ("Your callback is
     scheduled for tomorrow around 9 at 407-555-0199.") instead of ending on it verbatim. That
     is the same confirmation, and missing it means the customer is told it is booked while
     nothing is captured or emailed. So the FINAL sentence starting with the line's stem counts.
     Still only the last sentence: the line buried mid-message, or a paraphrase, does not. */
  const last = t.split(/(?<=[.!?])\s+/).pop() ?? "";
  if (last.startsWith(norm(SUPPORT_LINES.callback).replace(/\.$/, ""))) return "callback";
  if (last.startsWith(norm(SUPPORT_LINES.live).replace(/\.$/, "").replace(/ now$/, ""))) return "live";
  return null;
}

/** The last phone-looking number the customer gave, as they wrote it. Best effort: a spoken
 *  number transcribed as words will not match, and the confirmation text (which the agent
 *  repeats back) still carries it. */
export function extractPhone(customerTexts: string[]): string | undefined {
  const re = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}|\b\d{3}[\s.-]\d{4}\b/g;
  for (let i = customerTexts.length - 1; i >= 0; i--) {
    const hits = customerTexts[i].match(re);
    if (hits?.length) return hits[hits.length - 1].trim();
  }
  return undefined;
}

/** The agent's closing message with the marker line removed: it repeats back the number and the
 *  time, which is the part the person calling back needs. */
export function confirmationText(agentText: string): string {
  return String(agentText ?? "")
    .replace(new RegExp(`${SUPPORT_LINES.callback.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "")
    .replace(new RegExp(`${SUPPORT_LINES.live.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "")
    .trim()
    .slice(0, 600);
}

export interface Turn { role: "customer" | "agent"; text: string }

/** A short readable excerpt of the conversation for the email and the Inbox card. */
export function excerpt(turns: Turn[], max = 14): string {
  return turns.slice(-max)
    .map((t) => `${t.role === "agent" ? "Agent" : "Customer"}: ${t.text.replace(/\s+/g, " ").trim().slice(0, 300)}`)
    .join("\n");
}
