/* =============================================================================
   supportPlaybook.ts — the customer Support workflow, from a SupportPlaybook
   -----------------------------------------------------------------------------
   Pure and React-free, so the generator (engine/), the previews and the audit can all
   import it. Three things live here:

     • `fallbackSupportPlaybook(profile)` — a deterministic playbook built from the prospect's
       own profile. It is what a shared demo gets when the model call is unavailable, so
       creating a share NEVER fails on it, and it is also what the audit exercises.
     • `supportWorkflows(profile, playbook)` — the two ExtraWorkflows (SMS + Voice) that put the
       playbook in Agent Studio, so a customer can open the workflow and read what is behind the
       diagram.
     • `supportBrain(...)` — the ChatBrain for either channel. A customer session never sends
       one (engine/share.ts uses a stored snapshot); staff build it here when they share a demo.

   ⚠️ The escalation options are SIMULATED. The direct line is a reserved 555 number and a
   callback is captured, never dialled — a public demo link must not be able to ring a real
   person or business.
   ============================================================================= */

import { salesBrainFor } from "./salesPath.ts";
import type { CustomerProfile, ExtraWorkflow, SupportPlaybook, SupportScenario } from "./schema.ts";

export const SUPPORT_SMS_SLUG = "support-sms";
export const SUPPORT_VOICE_SLUG = "support-voice";
/** The keys a customer session's brain snapshots are stored under (engine/share.ts). */
export const SUPPORT_BRAIN_KEYS = { sms: "sms-support", voice: "voice-support" } as const;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A reserved 555 number in the prospect's own area code (0100-0199 is the fiction block). */
export function demoDirectLine(profile: { id: string; reports?: any }): string {
  const digits = String(profile.reports?.voiceScreenpop?.callerPhone ?? "").replace(/\D/g, "");
  const area = digits.length >= 10 ? digits.slice(-10, -7) : "800";
  let h = 0; for (const c of String(profile.id ?? "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `(${area}) 555-01${String(h % 100).padStart(2, "0")}`;
}

/** The existing customer the demo pretends is calling. Prefer the person the rest of the demo
 *  already names (the screen-pop caller), so the SMS thread, the voice call and the Salesforce
 *  screens all agree about who this is. */
export function demoCustomerName(profile: CustomerProfile): string {
  const n = String((profile.reports as any)?.voiceScreenpop?.callerName ?? "").trim();
  return n || "Jordan Ellis";
}

/** Deterministic, vertical-neutral playbook built from the profile alone. */
export function fallbackSupportPlaybook(profile: CustomerProfile): SupportPlaybook {
  const noun = (profile.customerNoun || "customer").toLowerCase();
  const booking = (profile.bookingTerm || "appointment").toLowerCase();
  const name = demoCustomerName(profile);
  const first = name.split(" ")[0];
  const biz = profile.customerName;
  const scenarios: SupportScenario[] = [
    {
      id: "billing",
      title: "Billing question",
      whoCalls: `Existing ${noun}s who see a charge they don't recognise or want to know when a payment posts.`,
      opener: "Hi, I was charged $89 on the 3rd and I'm not sure what it's for.",
      lookup: `${first}'s last invoice was #10482 for $89.00 on the 3rd: $74.50 for the regular service plus a $14.50 late fee from a payment that posted two days after the due date. No other charges this month.`,
      resolve: [
        "Confirm which charge they mean, then explain it plainly using the invoice above.",
        "If they accept it, offer to email the itemised invoice.",
        "If the late fee is the complaint, offer the one-time courtesy waiver the account is eligible for and confirm it has been applied.",
      ],
      escalateWhen: ["They dispute the underlying service charge itself", "They ask for a refund over $100", "They mention a chargeback or their bank"],
    },
    {
      id: "cancellation",
      title: "Cancel or change my service",
      whoCalls: `${cap(noun)}s who want to stop, pause or downgrade.`,
      opener: "I need to cancel my plan.",
      lookup: `${first} is on the standard monthly plan at $74.50 a month, 14 months in, with no contract end date. A pause option (up to 60 days) and a lower tier at $49 a month are both available.`,
      resolve: [
        "Ask, once and kindly, what is behind the decision.",
        "If it is cost or timing, offer the pause or the $49 tier and say exactly what changes.",
        "If they still want to cancel, confirm the end date, that no further charges follow, and send the confirmation.",
      ],
      escalateWhen: ["They are cancelling because of a complaint about service quality", "They ask to speak to a manager", "They have an open dispute on the account"],
    },
    {
      id: "technical",
      title: `Problem with my ${booking} or service`,
      whoCalls: `${cap(noun)}s who booked something and now need it moved, or something did not go as expected.`,
      opener: `I need to reschedule my ${booking}, nobody confirmed it.`,
      lookup: `${first} has a ${booking} on Thursday at 10:30 AM. A confirmation went out by email on Monday but not by text, which is why it looks unconfirmed. Openings this week: Friday 9:00 AM and Saturday 11:00 AM.`,
      resolve: [
        "Confirm the existing booking and explain the missing text.",
        "Offer the two openings, move the booking to the one they pick, and confirm by text.",
      ],
      escalateWhen: ["They report the issue has already happened more than once", "They say it is urgent or a safety concern", "Nothing offered works for them"],
    },
    {
      id: "account",
      title: "Account or contact details",
      whoCalls: `${cap(noun)}s who moved, changed numbers or cannot sign in.`,
      opener: "I changed my phone number and I'm not getting your texts.",
      lookup: `The number on ${first}'s account ends in 0142 and the account email is on file. A verified update can be made by texting a confirmation code to the number on file.`,
      resolve: [
        "Verify them with a code sent to the number on file, or the email if they no longer have that phone.",
        "Update the number, confirm it back to them, and tell them what they will receive going forward.",
      ],
      escalateWhen: ["They cannot pass verification", "They suspect someone else has access to the account"],
    },
  ];
  return {
    customer: {
      name,
      account: `Account ${10000 + (name.length * 977) % 89999}`,
      summary: [
        `${biz} ${noun} for 14 months`,
        "Standard monthly plan, $74.50 a month",
        "Last payment $89.00 on the 3rd, including a $14.50 late fee",
        `Next ${booking}: Thursday, 10:30 AM`,
        "Phone number ends in 0142; email on file",
      ],
    },
    systems: ["Billing", "Customer records", "Scheduling", "Ticketing"],
    scenarios,
    escalation: { directLine: demoDirectLine(profile), hours: "Monday to Friday, 8 AM to 6 PM local time", callbackWindow: "within one business hour" },
  };
}

/** The opener each channel starts with. */
export function supportGreeting(profile: Pick<CustomerProfile, "customerName">, channel: "sms" | "voice"): string {
  return channel === "voice"
    ? `Thanks for calling ${profile.customerName}. I'm the AI assistant. How can I help you today?`
    : `Hi, this is ${profile.customerName}. I'm the AI assistant. How can I help you today?`;
}

/** The two workflows that put the playbook in Agent Studio. Branches are the SCENARIOS, so the
 *  diagram a customer opens and the agent they talk to are built from one list. */
export function supportWorkflows(profile: CustomerProfile, pb: SupportPlaybook): ExtraWorkflow[] {
  const branches: ExtraWorkflow["branches"] = pb.scenarios.map((s) => ({
    title: s.title,
    action: "Resolve",
    tone: "blue",
    intent: "support",
    chips: ["Account lookup", ...(s.resolve.length > 1 ? ["Self-service fix"] : [])].slice(0, 3),
  }));
  branches.push({ title: "Needs a person", action: "Escalate", tone: "orange", intent: "support", chips: ["Live agent", "Callback", "Direct line"] });
  const common = (channel: "SMS" | "Voice"): ExtraWorkflow => ({
    slug: channel === "SMS" ? SUPPORT_SMS_SLUG : SUPPORT_VOICE_SLUG,
    label: `${profile.customerName} - ${channel} - Customer Support`,
    channel,
    status: "Live",
    triggeredBy: channel === "SMS" ? "Existing customer texts the support line" : "Existing customer calls the support line",
    startLabel: `${channel === "SMS" ? "SMS" : "Voice"} · resolve or escalate`,
    branches,
    /* The prompt itself is built from `support` by the chat engine on BOTH channels; this text
       is what the workflow's own screens show, so it says what the agent does. */
    systemPrompt: `Containment-first customer support for ${profile.customerName}. Resolves billing, cancellation, service and account questions using the customer's account record, and escalates to a person, a scheduled callback, or a direct line when it cannot.`,
    openingMessage: supportGreeting(profile, channel === "SMS" ? "sms" : "voice"),
    openingMessageWins: true,
    support: pb,
  });
  return [common("SMS"), common("Voice")];
}

/** The ChatBrain for a Support agent on either channel. Only what the support prompt reads. */
export function supportBrain(profile: CustomerProfile, pb: SupportPlaybook, channel: "sms" | "voice") {
  return {
    customerName: profile.customerName,
    industry: profile.industry,
    supportPlaybook: pb,
    /* The normal agent becomes the sales path; the playbook is the support path. Sharing must never fail on a
       profile too thin to build the sales side from: it then degrades to the support path alone. */
    salesBrain: (() => { try { return salesBrainFor(profile, channel); } catch { return undefined; } })(),
    ...(channel === "voice"
      ? { voiceGreeting: supportGreeting(profile, "voice") }
      : { smsGreeting: supportGreeting(profile, "sms") }),
  };
}
