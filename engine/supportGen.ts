/* =============================================================================
   supportGen.ts — a Support playbook written for THIS customer
   -----------------------------------------------------------------------------
   A customer-facing demo is only convincing if the questions its Support agent handles are
   the ones this business's real customers actually ask. A hospital's callers dispute a bill or
   move an appointment; a pest-control customer asks about a recurring plan or a missed visit.
   So one model call reads a digest of the prospect's own profile (what it sells, who calls,
   what the recorded calls were about, the questions its agent already answers) and writes the
   scenarios, the invented account, and what the agent would do for each.

   ⚠️ IT NEVER FAILS A SHARE. Any error, a missing key, or a response that does not validate
   returns the deterministic playbook from src/data/supportPlaybook.ts, marked `source:
   "fallback"`, so creating a customer demo is never blocked on this call and the SE is told
   which one they got.

   ⚠️ THE MODEL DOES NOT CHOOSE THE ESCALATION NUMBER OR THE CUSTOMER'S NAME. The direct line
   is forced to a reserved 555 number and the customer to the person the rest of the demo
   already names, whatever comes back — a public link must not be able to ring a real business,
   and the SMS thread, the voice call and the Salesforce screens should all agree who is calling.

   ⚠️ NOT A PHASE OF `generateProfile`. That pipeline has a five-minute budget enforced by the
   nightly canary (audit:phases), and this is only needed for a demo that gets shared.
   ============================================================================= */

import Anthropic from "@anthropic-ai/sdk";
import { structured } from "./core.ts";
import {
  SupportPlaybook, type CustomerProfile,
} from "../src/data/schema.ts";
import { demoCustomerName, demoDirectLine, fallbackSupportPlaybook } from "../src/data/supportPlaybook.ts";

export interface SupportGenResult { playbook: SupportPlaybook; source: "model" | "fallback"; error?: string }

/** A compact digest of what the profile already knows about who contacts this business. */
export function profileDigest(p: CustomerProfile): string {
  const r: any = p.reports ?? {};
  const cats: string[] = (r.marketingDashboard?.breakdowns ?? [])
    .find((b: any) => /product category/i.test(`${b.title} ${b.dimensionColumn}`))?.rows?.map((x: any) => x.cells?.[0] ?? x.name).filter(Boolean) ?? [];
  const calls: string[] = (r.callReview?.calls ?? []).slice(0, 8).map((c: any) => String(c.summary ?? "").slice(0, 220)).filter(Boolean);
  const qa: string[] = (r.agentConfig?.aiRecommendations?.find((x: any) => x.qaPairs?.length)?.qaPairs ?? []).slice(0, 8).map((q: any) => q.question);
  const locs: string[] = (r.opsDashboard?.locationHandling?.rows ?? []).slice(0, 4).map((x: any) => x.cells?.[0]).filter(Boolean);
  const topics: string[] = (r.voiceScreenpop?.products ?? "").split(/\s*,\s*/).filter(Boolean);
  return [
    `Business: ${p.customerName} (${p.websiteUrl})`,
    `Industry: ${p.industry}`,
    `They call their people: ${p.customerNoun || "customer"}s. A booked visit is called: ${p.bookingTerm || "appointment"}.`,
    r.agentConfig?.serviceArea ? `Service area: ${r.agentConfig.serviceArea}` : "",
    cats.length ? `Product/service categories: ${cats.slice(0, 8).join(", ")}` : "",
    topics.length ? `Specific offerings: ${topics.slice(0, 8).join(", ")}` : "",
    locs.length ? `Locations: ${locs.join(", ")}` : "",
    qa.length ? `Questions their AI agent already answers:\n- ${qa.join("\n- ")}` : "",
    calls.length ? `What recorded calls to this business were about:\n- ${calls.join("\n- ")}` : "",
  ].filter(Boolean).join("\n");
}

const noDashes = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ",");
const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "scenario";

/** Force the fields the model does not get to choose, and clean the text. Exported so the
 *  audit can prove it holds against a hostile response. */
export function finalizePlaybook(pb: SupportPlaybook, profile: CustomerProfile): SupportPlaybook {
  const seen = new Set<string>();
  const scenarios = pb.scenarios.slice(0, 6).map((s) => {
    let id = kebab(s.id || s.title);
    while (seen.has(id)) id += "-2";
    seen.add(id);
    return {
      id,
      title: noDashes(s.title).slice(0, 60),
      whoCalls: noDashes(s.whoCalls).slice(0, 240),
      opener: noDashes(s.opener).slice(0, 240),
      lookup: noDashes(s.lookup).slice(0, 700),
      resolve: s.resolve.slice(0, 6).map((x) => noDashes(x).slice(0, 300)),
      escalateWhen: s.escalateWhen.slice(0, 5).map((x) => noDashes(x).slice(0, 200)),
    };
  });
  return {
    customer: {
      name: demoCustomerName(profile),
      account: noDashes(pb.customer.account).slice(0, 40),
      summary: pb.customer.summary.slice(0, 8).map((x) => noDashes(x).slice(0, 200)),
    },
    systems: pb.systems.slice(0, 6).map((x) => noDashes(x).slice(0, 40)),
    scenarios,
    escalation: {
      directLine: demoDirectLine(profile),
      hours: noDashes(pb.escalation.hours).slice(0, 140),
      callbackWindow: noDashes(pb.escalation.callbackWindow).slice(0, 60),
    },
  };
}

export async function generateSupportPlaybook(profile: CustomerProfile, apiKey?: string): Promise<SupportGenResult> {
  const fallback = () => fallbackSupportPlaybook(profile);
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) return { playbook: fallback(), source: "fallback", error: "No API key on the server." };
  try {
    const client = new Anthropic({ apiKey: key, maxRetries: 3 });
    const name = demoCustomerName(profile);
    const today = new Date().toISOString().slice(0, 10);
    const prompt =
      `TODAY'S DATE IS ${today}. Every date, renewal, payment and appointment you invent must be consistent with today: past events within the last two months, upcoming ones within the next six weeks, and nothing in a past year unless it is a "customer since" date. Never write a date that is already long past as if it were upcoming.\n\n` +
      `You are designing the SUPPORT side of a live demo of an AI customer-service agent for this business, to be shown to that business's own executives.\n\n` +
      `${profileDigest(profile)}\n\n` +
      `The demo's premise: the AI agent is connected to the business's billing, customer-record, scheduling and ticketing systems, so it can look things up and take action for an EXISTING customer, and it is built around CONTAINMENT: resolving the issue without a human wherever it reasonably can. You invent all the data, so make it specific and internally consistent.\n\n` +
      `Write a playbook:\n` +
      `- customer: an invented existing customer named exactly "${name}". account is an account or member number in a format this kind of business really uses. summary is 5 to 7 concrete invented facts a support agent would see on screen for this business (plan or service, tenure, balance or last payment with real-looking figures and dates, next visit or renewal, contact details on file). They must fit ${profile.customerName}'s industry, not a generic subscription.\n` +
      `- systems: 3 to 5 named systems this kind of business really runs (for example a patient billing system, a policy admin system, a dispatch tool). Plain names.\n` +
      `- scenarios: exactly 5. Choose the five things this business's existing customers most often call or text about, drawn from the categories and call topics above. Include a billing or payment issue, a cancellation or change of service, and a technical or service problem, phrased the way THIS business would. Each: a short GENERIC title of two to six words with no dates, dollar amounts, names or model numbers (\"Reschedule an upcoming service\", not \"Reschedule the 2026-10-06 oil change\"); who in this business raises it; a realistic first message from that person (natural, a little messy, first person); what the agent pulls up, with the invented facts and figures it finds; 2 to 4 ordered steps the agent takes to resolve it itself using its system access (real actions like applying a credit, rebooking, sending a confirmation, updating a record); and 2 or 3 specific situations that must go to a human.\n` +
      `- Every scenario is raised by the customer named above, or by a family member or authorized contact you list in that customer's account summary. Every scenario is about an EXISTING customer's account or service, never a first-time prospect.\n` +
      `- Every scenario's title must describe the SAME request as its opening message and its lookup. Re-read each one before returning and fix any mismatch.\n` +
      `- escalation: hours a human answers in one short phrase (for example "Monday to Friday, 8 AM to 6 PM Eastern"), and how soon a scheduled callback happens (for example "within one business hour"). directLine can be any placeholder, it will be replaced.\n\n` +
      `Style: plain, concrete, no marketing language. Never use em dashes, en dashes or hyphens between clauses. Do not mention that this is a demo inside the scenario text.`;
    const raw = await structured<SupportPlaybook>(client, SupportPlaybook, prompt, 10000);
    if (!raw.scenarios?.length) throw new Error("The model returned no scenarios.");
    return { playbook: finalizePlaybook(raw, profile), source: "model" };
  } catch (e: any) {
    return { playbook: fallback(), source: "fallback", error: e?.message || String(e) };
  }
}
