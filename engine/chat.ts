/* =============================================================================
   chat.ts — the live agent conversation engine (SMS + Voice)
   -----------------------------------------------------------------------------
   Powers the iPhone "Preview Agent" SMS chat and — with { voice: true } — the
   live Voice-agent phone call. Given a compact "brain" (the agent's brand rules
   + Q&A pairs + knowledge, all built at profile-generation time) and the
   conversation so far, it returns the agent's next reply. The two channels are
   DIFFERENT use cases: SMS is a SALES flow (qualify → quote → book a
   consultation); Voice is QUALIFY-AND-ROUTE (gather a couple of details, then
   hand the caller to the right team — never sell, quote, or resolve).

   Uses the FASTEST model (Haiku) so replies feel instant — critical for a live
   phone call. The API key stays server-side (called from the Vite dev endpoint
   / never in the browser).
   ============================================================================= */

import Anthropic from "@anthropic-ai/sdk";
import { slotTable } from "../src/data/voiceBooking.ts";
import { supportSystemPrompt } from "./supportPrompt.ts";
import type { SupportPlaybook } from "../src/data/schema.ts";

const CHAT_MODEL = "claude-haiku-4-5-20251001";

export interface SmsPlaybook {
  goal: string;
  bookingType: string;            // "virtual consultation" | "in-home estimate" | "showroom tour" | "test drive" | "appointment" …
  offer: string;
  providesEstimate: boolean;
  qualifyingQuestions: string[];
}
/* =============================================================================
   VoicePath — one branch of the WORKFLOW DIAGRAM, in the form the prompt needs.
   -----------------------------------------------------------------------------
   ⚠️ **THE DIAGRAM IS THE SOURCE OF TRUTH FOR THE CALL'S LOGIC.** The tree and this
   prompt used to be derived SEPARATELY from `voiceRoutingDemo.queues`, so they shared a
   source but not a model: an SE who used Ask AI to add a branch, rename a team or change
   what a leaf collects saw the diagram change and heard the agent behave exactly as
   before. One model, two renderings — the same rule that made the diagram data in the
   first place.

   It also gives the reverse direction for free: telling Ask AI "ask for the ZIP before
   routing" edits that leaf's chips, so the chip appears ON the diagram and the agent
   starts asking for it. No syncing, because there is only one thing to sync.
   ============================================================================= */
export interface VoicePath {
  /** The intent node's title — "Book a Move", "Existing Order". */
  intent: string;
  /** The caller-intent line under it, if the diagram carries one. */
  recognise?: string;
  /** One per leaf. More than one means this branch splits to different teams. */
  routes: {
    team: string;        // leaf title  — who it hands off to
    /* Set when the diagram has a fourth row: the ANSWER this route belongs to, so the
       agent can follow the caller's own need instead of re-asking what they want. */
    need?: string;
    action: string;      // leaf action — what the agent does there
    collect: string[];   // leaf chips  — what to gather BEFORE handing off
    /**
     * This use case's OWN instruction, from its drawer's instruction box.
     *
     * ⚠️⚠️ **PER NODE (9/21/2026). IT USED TO BE ONE SHARED LIST AND THAT WAS A REAL
     * SILENT BUG:** every voice use case's drawer wrote `agent.informSteps`, so an SE who
     * typed an instruction on "Billing question" rewrote it on "Ready to book now" too.
     * Absent means this node has none and the shared routing steps still govern, so an
     * agent nobody has edited is byte-identical.
     */
    instruction?: string;
    /** The transfer number for this route, when its drawer names one. */
    phone?: string;
  }[];
}

/** One node of the configured SMS workflow. Mirrors `SmsFlowNode` in `workflowDrawers.ts`. */
export interface SmsFlowNode {
  title: string;
  action: string;
  question?: string;
  fallback?: string;
  instruction?: string;
  destination?: string;
  signal?: string;
  collect?: string[];
  answers?: SmsFlowNode[];
}

export interface ChatBrain {
  customerName: string;
  industry?: string;
  /**
   * A containment-first customer SUPPORT agent, on either channel (engine/supportPrompt.ts).
   * ⚠️ ITS PRESENCE SELECTS THE WHOLE PROMPT, before every other field is read: the routing
   * prompt forbids resolving issues and the sales prompt is an arc toward a booking, and
   * either would contradict an agent whose job is to resolve. Absent on every other brain, so
   * none of them changes.
   */
  supportPlaybook?: SupportPlaybook;
  /** The normal (sales / routing) agent for this prospect. With a supportPlaybook it becomes the
   *  SALES PATH of a two-path agent; see engine/supportPrompt.ts. */
  salesBrain?: ChatBrain;
  /** SMS: the message a Support conversation opens with. */
  smsGreeting?: string;
  rules?: string[];
  qaPairs?: { question: string; answer: string }[];
  knowledge?: string[];
  playbook?: SmsPlaybook;
  serviceArea?: string;   // voice: gate new orders by ZIP (empty/absent = no geo limit)
  /* An extra workflow's own playbook (reports.extraWorkflows[].systemPrompt).
     When set it REPLACES the generated sales persona — a nurture agent has a
     different job on the same channel. Our SMS format rules are still appended
     underneath, so a hand-written prompt can't accidentally produce a wall of
     text or markdown that the phone UI can't render. */
  customSystem?: string;
  /**
   * Agent config the operator CHANGED, for a workflow whose `customSystem` replaces the flow.
   *
   * ⚠️⚠️ **WITHOUT THIS, EVERY Ask AI EDIT ON SUCH A PAGE IS A SILENT NO-OP.** The
   * `customSystem` branch below returns before the questions, rules, Q&A and knowledge are
   * rendered, so an edited question list never reached the model — the drawer reported
   * success and the agent asked the old questions. Reported 9/3/2026.
   *
   * ⚠️ The client sends ONLY what genuinely differs from the prospect's profile, so an
   * untouched workflow gets nothing appended and reads exactly as its author wrote it.
   */
  overrides?: { questions?: string[]; rules?: string[] };
  /**
   * The BUILT-IN SMS workflow's own configuration — the six-row diagram an operator builds in
   * Agent Studio, as the flow this agent must follow.
   *
   * ⚠️⚠️ **BEFORE THIS, THE DIAGRAM REACHED THE AGENT NOWHERE (9/17/2026).** Asked for
   * directly: "if there are changes in the workflow, it also changes it in actual preview agent
   * or preview workflow." Every configured field — the qualify questions, the four inform
   * instructions, the escalation text, both intents' looks-like and rules, each node's collect
   * list — was invisible to the phone, so an SE could build the whole workflow and the preview
   * would ignore it.
   * ⚠️ Derived client-side through the SAME resolver the drawers use, so the agent is told
   * exactly what the SE reads on screen rather than a second interpretation of the config.
   */
  workflow?: {
    intents: { title: string; looksLike: string; rules: string[]; flow: SmsFlowNode[] }[];
  };
  /**
   * The extra workflow's ORDERED FLOW (`reports.extraWorkflows[].playbookSteps`, or whatever
   * the workflow page's Ask AI has edited it to).
   *
   * ⚠️ **A LIST, NOT PROSE, AND THAT IS THE POINT.** It is the SMS counterpart to the voice
   * spec's `informSteps`: an SE asking to "confirm the facility before offering anything"
   * needs a surgical edit to one entry, not a rewrite of a 2,000-character `customSystem`.
   *
   * ⚠️ **RENDERED ONLY IN THE `customSystem` BRANCH, and absent everywhere else.** A workflow
   * that states its flow in prose sets nothing here, so its prompt is byte-identical. Never
   * author BOTH for one workflow: two orderings of one flow is the self-contradicting prompt
   * this file warns about, and the model picks one at random.
   */
  steps?: string[];
  /* The workflow diagram, when the caller came from a page that has one. Opt-in and
     defaulted to absent, so every existing caller keeps the hardcoded flow below. */
  voicePaths?: VoicePath[];
  /**
   * A workflow that has ONLY its starting tree: greet, classify sales vs support, announce,
   * transfer. Nothing else.
   *
   * ⚠️ **THIS EXISTS BECAUSE PREVIEWING AN EMPTY WORKFLOW MUST PREVIEW *THAT* WORKFLOW.**
   * Create Workflow builds a flow with no actions configured (see `emptyWorkflowTree`), and
   * running the prospect's CONFIGURED agent there would have an SE hear the full Marriott
   * agent — ZIP gate, travel dates, six use cases — answering a diagram that shows none of
   * it. Asked for directly: "introduce yourself, thank them for calling the prospect, ask
   * how you can help; then decide sales or support, tell them, and transfer."
   *
   * ⚠️ **OPT-IN AND DEFAULTED OFF**, so no configured prospect's prompt can change. The
   * minimal flow REPLACES the path machinery rather than trimming it: reusing that path
   * emitted "Ask what they need, in their own words" on top of the opening question (a
   * second question this flow must not ask) and named the destination as "the team that
   * handles Sales Inquiry", which is a screen label rather than something to say aloud.
   */
  voiceMinimal?: boolean;
  /**
   * A voice workflow that BOOKS the appointment on the call instead of routing it.
   *
   * ⚠️⚠️ **IT REPLACES THE PATH MACHINERY RATHER THAN TRIMMING IT, for the same reason
   * `voiceMinimal` does.** The routing flow's whole shape is "qualify, then hand off to a
   * team" — its step 3 names a destination and its service-area gate can REFUSE a caller.
   * Both contradict an agent whose job is to end the call with a confirmed appointment, and a
   * self-contradicting prompt is worse than either half (recorded twice in CLAUDE.md).
   *
   * ⚠️ OPT-IN AND DEFAULTED OFF, so no configured prospect's routing agent changes.
   */
  voiceBooking?: boolean;
  /** The locations the caller can be booked into, nearest-first by the agent's own reading. */
  voiceBookingLocations?: string[];
  /** Weekday -> the ONLY times the agent may offer. Derived; see src/data/voiceBooking.ts. */
  voiceBookingSlots?: Record<string, string[]>;
  /** The prospect's own products; used by the capture's analysis, not by the prompt. */
  voiceBookingProducts?: string[];
  /**
   * ⚠️ **AN ALLOW-LIST, AND IT INVERTS THE GATE.** Without it the prompt's rule is "12345 is
   * the only out-of-area ZIP, everything else proceeds" — right for a national business, and
   * exactly backwards for one that serves three ZIP codes and turns the rest away. Present
   * means: only these are in area.
   */
  serviceZips?: string[];
  /** Read verbatim to an out-of-area caller, when the prospect has scripted it. */
  outOfAreaScript?: string;
  /** The agent's opening line, when the prospect has scripted that too. */
  voiceGreeting?: string;
  /**
   * The qualifying question, asked verbatim after the greeting.
   *
   * ⚠️ **ADDED 8/27/2026 BECAUSE EDITING IT WAS A SILENT NO-OP.** The spec has carried a
   * `qualifyQuestion` since it was written, and it reached the drawer and nothing else — the
   * agent inferred a question from the path nodes instead. That was invisible while the only
   * spec was Comfort Keepers', whose GREETING already contains its qualifying question. The
   * moment Ask AI could edit the field, an SE could change the question, watch the drawer
   * update, and hear the agent ask the old one. Observed live.
   */
  voiceQualify?: string;
  /**
   * ⚠️ **THE SPEC'S RULES REPLACE THE BRAND RULES, THEY DO NOT JOIN THEM.** `brandConversationRules`
   * is written for the SMS SALES agent — intro and offer, qualify on services and hours and
   * schedule, estimate then book — and injecting that into a qualify-and-route prompt is what
   * made the agent interrogate callers: it asked who needs care, which services, how many
   * hours, when to begin, all before the ZIP. A routing agent's rules are the ones configured
   * on its own workflow.
   */
  voiceRules?: string[];
  /**
   * ⚠️ **THE CONFIGURED ROUTING STEPS, AND LEAVING THEM OUT WAS A REAL BUG.** The drawer
   * rendered an SE's six numbered steps while the prompt never saw them, so the one that says
   * "if the caller does not provide their full name, ask again — do not route without it" was
   * on screen and not in the agent: asked for a name and refused, it said "that's okay" and
   * transferred anyway. Caught by scripting the refusal rather than the happy path.
   *
   * ⚠️ When present these REPLACE the generated service-area block, because they already say
   * what to check and what to read out. Two overlapping instruction sets in one prompt is how
   * a model ends up splitting the difference.
   */
  voiceSteps?: string[];
  /**
   * What the agent does on the support path, when an operator has changed it from the default.
   *
   * ⚠️ ABSENT UNLESS EDITED, so every untouched agent's prompt is byte-identical — the drawer
   * showed this sentence long before the prompt did, and the point of the field is to close
   * that gap rather than to reword anybody's agent.
   */
  voiceEscalate?: string;
  /**
   * The SUPPORT intent's own description and conversation rules, from its drawer.
   *
   * ⚠️ BOTH ARE NEW (9/21/2026) AND BOTH ARE ABSENT UNLESS EDITED. The Need Support drawer
   * was five READ-ONLY boxes whose contents were hardcoded in `workflowDrawers.ts`, so the
   * agent had never been told any of it. Rendering them only when set keeps every untouched
   * agent's prompt byte-identical.
   */
  voiceSupportIntent?: string;
  voiceSupportRules?: string[];
  /* Per-prospect VOICE routing, from reports.voiceRoutingDemo.queues plus the
     prospect's booking term and product categories. Without it the voice prompt
     used to fall back to hardcoded retail language: it asked every caller for an
     ORDER NUMBER and routed them to "our fulfillment team", which is wrong for a
     hospital, a law firm or a security company. */
  voiceRouting?: {
    newQueue: string;          // queues[0] — new business / booking
    supportQueue: string;      // queues[1] — existing customer
    generalQueue?: string;     // queues[2] — everything else
    bookingTerm: string;       // "Appointment", "Consultation", "Test Drive"
    products?: string[];       // main things they offer, used as spoken examples
    who?: string;              // "patient" | "resident" | "customer"
  };
}
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/* Em dashes and dash-joined clauses are one of the clearest "written by an AI"
   tells, and this text is read by prospects during a demo. Banned outright for
   every agent, on both channels — use a comma, or start a new sentence. */
const NO_DASH_RULE =
  "NEVER use em dashes, en dashes, or a hyphen joining two clauses. " +
  "Use a comma, a full stop, or a new sentence instead. This matters: " +
  "dashes make the message read as machine-written.";

const SMS_FORMAT_RULES = [
  "FORMAT (always): plain text only, no markdown, asterisks, bullets or headings.",
  NO_DASH_RULE,
  "Keep every message to 1-3 short sentences. Never send a wall of text.",
  "One question at a time.",
].join("\n");

/**
 * The VOICE agent's system prompt for a given brain.
 *
 * ⚠️ **EXPORTED SO THE LIVEKIT WORKER CANNOT DRIFT FROM `/api/chat`.** The LiveKit voice agent
 * runs in its own process and needs this exact prompt; the tempting shortcut is to paste a
 * copy into the worker, and then the SE tunes the routing flow on one and the two channels
 * behave differently on the next demo. Same rule `smsBrain.ts` already enforces for the SMS
 * brain: two local copies of one object drift on the first edit.
 *
 * `buildSystem(brain, true)` is the single definition; this is a named door onto it.
 */
export function voiceSystemPrompt(brain: ChatBrain): string {
  return buildSystem(brain, true);
}

/**
 * The SMS prompt for a brain, so the audit can read it.
 *
 * ⚠️ **A NAMED DOOR ONTO `buildSystem(brain, false)`, NOT A SECOND DEFINITION** — the same
 * reasoning as `voiceSystemPrompt`. The audit needs to assert what an empty workflow's CHAT
 * preview actually says, and the alternative was reproducing the prompt in the test, which
 * would then pass while the real one drifted.
 */
export function smsSystemPromptForAudit(brain: ChatBrain): string {
  return buildSystem(brain, false);
}

/**
 * The operator's own changes, appended after a workflow's scripted playbook.
 *
 * ⚠️ **IT SAYS WHICH SIDE WINS.** Appending a second question list without that produces two
 * competing instructions, and the model picks one at random — the failure recorded twice in
 * CLAUDE.md (the column-edit prompt, and the out-of-area script fighting step 3). Empty when
 * nothing was edited, and the caller drops it.
 *
 * ⚠️ The question wording mirrors the main flow's step 2 verbatim, so a question list behaves
 * the same whichever branch renders it.
 */
function overrideBlock(brain: ChatBrain): string {
  const o = brain.overrides;
  if (!o) return "";
  const parts: string[] = [
    `CONFIGURATION CHANGES — these were set for this agent AFTER the playbook above was written. Where the two disagree, THIS SECTION WINS.`,
  ];
  if (o.questions?.length) {
    parts.push(
      `Ask these questions ONE AT A TIME, IN THIS EXACT ORDER, waiting for each answer before asking the next. Do not skip any, do not reorder them, do not combine two into one message, and do not add questions of your own. If the customer already answered one, acknowledge it and move to the next in the list:`,
      o.questions.map((q, i) => `${i + 1}. ${q}`).join("\n"),
    );
  }
  if (o.rules?.length) {
    parts.push(`Conversation rules:`, o.rules.map((r) => `- ${r}`).join("\n"));
  }
  return parts.join("\n");
}

/**
 * The workflow's own ordered flow, rendered under its playbook.
 *
 * ⚠️ **NUMBERED, WITH "DO NOT SKIP, DO NOT REORDER" — the wording is copied from step 2 of the
 * main flow and from `overrideBlock` deliberately.** A bulleted list of steps reads to the
 * model as a MENU: that exact mistake is recorded in CLAUDE.md against the Preview Agent's
 * questions, where the agent skipped straight to the second one.
 *
 * ⚠️ **IT IS PART OF THE PLAYBOOK, SO IT CLAIMS NO PRECEDENCE.** `overrideBlock` says "THIS
 * SECTION WINS" because it carries changes made AFTER the playbook was written and would
 * otherwise compete with it. These steps ARE the playbook's flow, and a section that
 * out-ranked the operator's later edits would invert the order those two were fixed in.
 */
function stepsBlock(brain: ChatBrain): string {
  const s = brain.steps;
  if (!s?.length) return "";
  return [
    "THE FLOW. Work through these steps IN THIS ORDER, one message at a time, waiting for the reply before moving on. Adapt the wording to what the person says, but do not skip a step, do not reorder them, and do not combine two into one message:",
    s.map((x, i) => `${i + 1}. ${x}`).join("\n"),
  ].join("\n");
}

/**
 * The configured workflow, rendered as the flow the agent must follow.
 *
 * ⚠️ NESTED AND EXPLICITLY CONDITIONAL ("If they answer …"), because a flat list of every node
 * loses the one thing the diagram encodes: which question follows which answer.
 */
function workflowBlock(brain: ChatBrain): string {
  const wf = brain.workflow;
  if (!wf?.intents?.length) return "";
  const node = (n: SmsFlowNode, depth: number): string[] => {
    const pad = "  ".repeat(depth + 1);
    const out: string[] = [];
    const head = `${pad}${n.title} — action: ${n.action}`;
    out.push(head);
    if (n.question) out.push(`${pad}  ASK, in your own words but to this effect: "${n.question}"`);
    if (n.fallback) out.push(`${pad}  If you cannot tell from their answer: ${n.fallback}`);
    if (n.instruction) out.push(`${pad}  DO THIS: ${n.instruction}`);
    if (n.collect?.length) out.push(`${pad}  Gather while you are here: ${n.collect.join(", ")}.`);
    if (n.destination) out.push(`${pad}  Where to send them: ${n.destination}`);
    for (const a of n.answers ?? []) {
      out.push(`${pad}  If they answer "${a.title}":`);
      out.push(...node(a, depth + 2));
    }
    return out;
  };
  /* ⚠️⚠️ IT ENRICHES THE SALES FLOW, IT DOES NOT REPLACE IT — and the wording has to say so.
     The generated SMS prompt is a SALES arc (open, qualify, estimate, schedule, confirm); this
     is a ROUTING flow. Declaring "THIS SECTION WINS" beside it, the way `overrideBlock` does
     for a hand-written playbook, would produce two competing flows for one conversation — the
     self-contradicting prompt this file already records twice. And replacing the sales arc
     outright would turn every prospect's SMS demo into a routing conversation, losing the
     qualify-quote-book beat that is the whole point of the channel. */
  const lines: string[] = [
    `CONFIGURED WORKFLOW — an operator built this in Agent Studio for THIS agent, so it is what`,
    `they want you to do. Use it for classification and routing, and follow the questions and`,
    `instructions on the path you land in. It does not replace the conversation flow above:`,
    `where a question appears in both, ask it ONCE.`,
    ``,
    `First, decide which intent the consumer has:`,
  ];
  wf.intents.forEach((i, n) => {
    lines.push(`${n + 1}. ${i.title}${i.looksLike ? ` — ${i.looksLike}` : ""}`);
    for (const r of i.rules ?? []) lines.push(`   - ${r}`);
  });
  lines.push(``, `Then follow that intent's flow, ONE step at a time, and never skip ahead:`);
  for (const i of wf.intents) {
    if (!i.flow.length) continue;
    lines.push(`${i.title}:`);
    for (const n of i.flow) lines.push(...node(n, 0));
  }
  return lines.join("\n");
}

/**
 * The playbook's qualifying questions, minus anything the workflow already gathers.
 *
 * ⚠️⚠️ **WITHOUT THIS THE AGENT ASKS TWICE, AND THAT EXACT BUG IS ALREADY RECORDED HERE FOR
 * VOICE** ("the voice agent was re-asking ZIP and name"): the service-area check and the path's
 * own collect list were two independent blocks nobody reconciled. The SMS workflow's nodes
 * collect a ZIP and a name too, so feeding the playbook's script in untouched reproduces it.
 *
 * ⚠️ **CONSERVATIVE AND STRUCTURAL, NOT SEMANTIC.** It drops a question only when the workflow
 * demonstrably gathers that same datum — a zip or a name — because those are the two that
 * actually recur. Anything else (timeline, property details, budget) is genuinely a second
 * question and is left alone. Same conservatism as `dedupeCollect`.
 */
function dedupeQuestions(brain: ChatBrain, questions: string[]): string[] {
  const wf = brain.workflow;
  if (!wf?.intents?.length) return questions;
  const gathered: string[] = [];
  const walk = (n: SmsFlowNode) => {
    gathered.push(...(n.collect ?? []), n.question ?? "");
    (n.answers ?? []).forEach(walk);
  };
  wf.intents.forEach((i) => i.flow.forEach(walk));
  const all = gathered.join(" ").toLowerCase();
  const asksZip = /\bzip\b|\bpostcode\b|\bpostal code\b/.test(all);
  const asksName = /\bname\b/.test(all);
  return questions.filter((q) => {
    const t = q.toLowerCase();
    if (asksZip && /\bzip\b|\bpostcode\b|\bpostal code\b/.test(t)) return false;
    if (asksName && /\b(full name|your name|first name|last name)\b/.test(t)) return false;
    return true;
  });
}

function buildSystem(brain: ChatBrain, voice: boolean): string {
  /* ⚠️ FIRST, before `customSystem`, the sales persona and the routing flow: see `supportPlaybook`. */
  if (brain.supportPlaybook)
    return supportSystemPrompt(
      { ...brain, supportPlaybook: brain.supportPlaybook }, voice, { noDash: NO_DASH_RULE, sms: SMS_FORMAT_RULES },
      brain.salesBrain ? buildSystem({ ...brain.salesBrain, supportPlaybook: undefined, salesBrain: undefined }, voice) : undefined,
    );
  /* A workflow-supplied playbook wins over the generated persona, with our
     channel format rules appended so the phone UI stays renderable. */
  if (!voice && brain.customSystem) {
    /* ⚠️ THE OVERRIDE BLOCK STATES ITS OWN PRECEDENCE, which is the only way to append to a
       hand-written playbook without creating the self-contradicting prompt this file warns
       about elsewhere. It is emitted ONLY for config that actually differs from the
       prospect's profile, so a workflow nobody has edited is byte-identical to before. */
    /* ⚠️ ORDER MATTERS: playbook, then its own flow, then the operator's later changes, then
       the channel's format rules. `overrideBlock` says it wins, so it has to come AFTER the
       steps it may be overriding. */
    return [brain.customSystem, stepsBlock(brain), overrideBlock(brain), SMS_FORMAT_RULES]
      .filter(Boolean).join("\n\n");
  }
  const rules = (brain.rules ?? []).map((r) => `- ${r}`).join("\n");
  const qa = (brain.qaPairs ?? [])
    .map((p) => `Q: ${p.question}\nA: ${p.answer}`)
    .join("\n\n");
  const knowledge = (brain.knowledge ?? []).map((k) => `- ${k}`).join("\n");

  // Voice and SMS are DIFFERENT use cases:
  //   • Voice = qualify-and-ROUTE (never sell, quote, or resolve — hand off)
  //   • SMS   = SALES: qualify → quote → book a consultation
  if (voice) return buildVoiceSystem(brain, rules, knowledge);

  /* ⚠️⚠️ **AN EMPTY WORKFLOW BEHAVES THE SAME ON EITHER CHANNEL.** `voiceMinimal` is named
     for where it started, and the reason it applies here too is the same lie in a different
     drawer: an SMS workflow that Create Workflow just built has no actions, and the chat
     preview would otherwise run the prospect's CONFIGURED SMS agent — qualifying questions,
     an offer, a booking — against a diagram that shows none of it.

     The only channel difference is the wording: this hands the conversation over rather than
     transferring a call, and it stays inside the SMS format rules. */
  if (brain.voiceMinimal) {
    return [
      `You are ${brain.customerName}'s AI assistant, replying by TEXT MESSAGE${brain.industry ? ` for a ${brain.industry} business` : ""}.`,
      `This workflow has only its starting tree, so your job is EXACTLY this and nothing more:`,
      `1. Your first message: thank them for texting ${brain.customerName}, say who you are, and ask how you can help today.`,
      `2. Read their reply. Ask NOTHING else — no ZIP code, no name, no dates, no reference number, no product questions.`,
      `3. Decide which ONE of these two teams they need:`,
      `   - the sales team: a new enquiry — buying, booking, pricing, availability, anything they do not already have.`,
      `   - the support team: an existing customer — changing or cancelling something, a problem, a charge, anything they already have.`,
      `   If it is genuinely unclear, ask ONE short clarifying question, then decide.`,
      `4. Acknowledge what they need in one short sentence, then hand off, ENDING your message with exactly one of these lines, word for word:`,
      `   "I'm handing you over to the sales team now."`,
      `   "I'm handing you over to the support team now."`,
      ``,
      `NEVER quote prices, availability or promotions, and never try to resolve the issue yourself. Once you have handed off, stop.`,
      ``,
      SMS_FORMAT_RULES,
    ].join("\n");
  }

  // ---- SMS sales / quote / book flow -------------------------------------
  // The playbook is chosen per prospect from research; fall back to sensible
  // generics so the agent still works if a profile lacks one.
  const p = brain.playbook;
  const bookingType = p?.bookingType?.trim() || "appointment";
  const goal = p?.goal?.trim() || `answer questions, qualify the customer, and schedule a ${bookingType}`;
  const offer = p?.offer?.trim() || "";
  const providesEstimate = p?.providesEstimate ?? false;
  const questions = dedupeQuestions(brain, p?.qualifyingQuestions?.length
    ? p.qualifyingQuestions
    : ["what they're looking for and any key details", "their timeline", "their ZIP code, to confirm service availability"]);
  /* NUMBERED, not bulleted. The Preview Agent's AI drawer lets an SE set exactly
     which questions the phone asks; a bullet list plus "adapt naturally" read as
     a menu, and the agent skipped straight to the second question. Numbering them
     and forbidding reordering is what makes "exactly these, in this order" true. */
  const qList = questions.map((q, i) => `   ${i + 1}) ${q}`).join("\n");

  return [
    NO_DASH_RULE,
    `You are the SMS sales assistant for ${brain.customerName}${brain.industry ? `, a ${brain.industry} business` : ""}.`,
    `You are texting a prospective customer. Your goal: ${goal}.`,
    ``,
    `CONVERSATION FLOW — follow this path start to finish. Adapt your WORDING to what the customer says, never the order of the steps or the set of questions below:`,
    `1. Open: briefly introduce yourself as ${brain.customerName}'s AI agent.${offer ? ` Mention this offer: "${offer}".` : ""} Ask if they'd like to get started.`,
    `2. Qualify — ask these questions ONE AT A TIME, IN THIS EXACT ORDER, waiting for each answer before asking the next. Do not skip any, do not reorder them, do not combine two into one message, and do not add questions of your own. If the customer already answered one, acknowledge it and move to the next in the list:`,
    qList,
    providesEstimate
      ? `3. Estimate: confirm you can help/serve their area, then give a PRELIMINARY price estimate as a RANGE based on what they shared. Say the exact price is confirmed at the ${bookingType}, and offer to schedule one.`
      : `3. Recap: briefly recap what they're looking for, then recommend scheduling a ${bookingType} to move forward and offer to set it up.`,
    `4. Schedule: proactively OFFER a specific available day and time yourself for the ${bookingType} (e.g. "I have availability this Friday at 12:00 PM") and ask if they'd like you to lock it in. Do NOT ask the customer to pick a time from scratch — suggest one.`,
    `5. Confirm: once they agree, restate the confirmed ${bookingType} day and time, tell them they'll get a reminder text shortly before with a number to call, and thank them for choosing ${brain.customerName}.`,
    ``,
    `STYLE:`,
    `- NEVER use emojis.`,
    `- Write PLAIN TEXT only — no markdown, asterisks, bullet points, or formatting. This is a text message.`,
    `- Keep every message SHORT, like a real SMS (usually 1–2 sentences). One question at a time.`,
    providesEstimate
      ? `- You MAY give a rough preliminary price RANGE, but the exact price is set at the ${bookingType}.`
      : `- Do not invent specific prices; pricing/details are handled at the ${bookingType}.`,
    `- Refer to what you're scheduling as a "${bookingType}".`,
    `- Only discuss ${brain.customerName}'s products and services. If asked something off-topic, gently steer back.`,
    /* ⚠️ AFTER the flow and STYLE, BEFORE the brand rules — it is configuration for this agent,
       so it belongs with the other operator-set sections rather than buried under them. */
    workflowBlock(brain) ? `\n${workflowBlock(brain)}` : ``,
    rules ? `\nBRAND CONVERSATION RULES (follow these; they carry brand-specific offers, terms, and numbers):\n${rules}` : ``,
    qa ? `\nAPPROVED Q&A (use these as ground truth for common questions):\n${qa}` : ``,
    knowledge ? `\nKNOWLEDGE SOURCES (what you learned the business from):\n${knowledge}` : ``,
  ].join("\n");
}

/* VOICE = qualify-and-route (distinct from the SMS sales flow). The agent gathers
   a couple of details and hands the caller to the right team; it never sells,
   quotes prices, or resolves issues. Two paths: new order vs. existing/support.
   Re-skins per prospect via the business context (name / industry / brand rules). */
const aOrAn = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");
/* Spoken aloud, so "Shady Blinds's assistant" grates. Names ending in s take a
   bare apostrophe. */
const poss = (n: string) => (/s$/i.test(n) ? `${n}'` : `${n}'s`);

/**
 * How the agent should NAME a team out loud.
 *
 * ⚠️ **THE DIAGRAM STOPPED CONTAINING A SPEAKABLE DESTINATION (8/26/2026).** Its leaves used to
 * read `All Design Consultation Users` / `Route to Design Consultation` — the prospect's own
 * queue — and the prompt put that straight into the handoff line. Now the leaf is product
 * chrome (`All Sales Inquiry Users` / `Qualify`), so the same line would have had the agent
 * SAY "I'm transferring you to All Sales Inquiry Users", i.e. read a user-group label aloud on
 * a live call. That is the kind of thing a prospect notices immediately.
 *
 * The real queue names still exist on the brain, from `voiceRoutingDemo.queues`, so they are
 * offered here as the words to use. The model picks which fits rather than us mapping branch
 * index to queue index — a positional map breaks the moment an SE adds a third branch.
 */
/**
 * A user-group label, which is a SCREEN label and must never be said on a call.
 *
 * ⚠️ `voicePaths` falls back to the leaf title when a branch names no destination, and that
 * title is the product's own locked chrome ("All Sales Inquiry Users"). So a route's `team` is
 * either a real desk or one of those, and only the first is speakable — which is why this
 * tests the SHAPE rather than trusting the field to be one or the other.
 */
function isGroupLabel(team: string): boolean {
  return /^all\b.*\busers$/i.test(team.trim());
}

/** ", then transfer them to <team>" — only when the branch names a real one. */
function destination(team: string): string {
  const t = (team ?? "").trim();
  return t && !isGroupLabel(t) ? `, then transfer them to ${t}` : "";
}

function namingRule(r: NonNullable<ChatBrain["voiceRouting"]>): string {
  const teams = [r.newQueue, r.supportQueue, r.generalQueue].filter(Boolean) as string[];
  return [
    `NAMING THE TEAM WHEN YOU HAND OFF:`,
    /* ⚠️ ONE TEAM PER LINE, NOT A COMMA LIST. A real queue name can CONTAIN a comma — Shady
       Blinds has "Existing Order, Support" — so `join(", ")` turned two teams into three. */
    ...(teams.length
      ? [`- These are the teams, one per line. Use whichever fits what the caller needs:`,
         ...teams.map((t) => `    • ${t}`)]
      : [`- Refer to the team by what it does ("our scheduling team").`]),
    `- NEVER read out a user-group label such as "All Sales Inquiry Users" or "All Support Users". Those are screen labels, not words anyone says on a phone call.`,
    ``,
  ].join("\n");
}

function buildVoiceSystem(brain: ChatBrain, rules: string, knowledge: string): string {
  const serviceArea = brain.serviceArea?.trim();
  /* Fall back to neutral wording rather than retail wording when a profile has
     no routing data, so an old profile degrades to "book an appointment /
     existing customer" instead of asking a patient for an order number. */
  const r = brain.voiceRouting ?? {
    newQueue: "the new enquiries team",
    supportQueue: "the support team",
    bookingTerm: "appointment",
  };
  const book = (r.bookingTerm || "appointment").toLowerCase();
  const who = r.who || "customer";
  const products = r.products ?? [];

  /* ⚠️ WHEN THE CALLER CAME FROM A PAGE WITH A DIAGRAM, THE DIAGRAM IS THE FLOW.
     Absent one, everything below is exactly what it always was — this is opt-in and
     defaulted to today's behaviour, so nothing that does not pass a tree changes.

     ⚠️ AND IT IS TOTAL: the tree is user-editable through Ask AI, so this has to survive
     any shape it is handed — no branches, ten leaves, empty chips. A branch with nothing
     to collect simply has no collect line; a tree with no branches falls through to the
     hardcoded flow rather than emitting an empty CALL FLOW the model would improvise on. */
  const zips = brain.serviceZips ?? [];
  const steps = brain.voiceSteps ?? [];
  const paths = brain.voiceMinimal || brain.voiceBooking
    ? []   /* the minimal and booking flows own the whole block; see their notes */
    : (brain.voicePaths ?? []).filter((p) => p.intent?.trim() && p.routes?.length);

  /* ⚠️⚠️ **DON'T ASK TWICE (9/2/2026).** Reported directly: the agent asked for the caller's
     ZIP code (or name) once during the service-area check in step 2, then asked for the SAME
     field again once it reached the path's own "collecting X, Y, Z" line — because those two
     blocks are built from two independent inputs (`voiceSteps` and each path's `chips`) that
     have never been reconciled. `deriveUseCases` puts "Consumer Name" on EVERY sales and
     support use case by design, and "Consumer Zip" is the default `where` for any vertical
     that isn't a hotel/home-service/senior-care business — so this was not an Avi & Co
     quirk, it repeats on any prospect with a service-area check at all. Verified on Comfort
     Keepers too: its generic template asks for the caller's full name in step 4, then every
     single path asked for "Consumer Name" again.

     Both deductions below are computed FRESH from `zips`/`steps`/`serviceArea`, the same
     values that already decide whether step 2 exists, so there is no second flag to fall
     out of sync with them:
     - a ZIP is asked in step 2 whenever ANY of the three service-area branches fires
       (custom steps, an allow-list, or the demo's single-ZIP fallback) — that block's whole
       purpose is asking for a ZIP, so this can never misfire;
     - a full name is asked in step 2 only when the steps TEXT actually says so, which is
       true of `stepsForZips`'s own wording and of a custom step that mentions it too. A
       custom step that never asks for a name leaves "Consumer Name" alone, so the field is
       still gathered exactly once, just later in the path. */
  const zipAlreadyAsked = steps.length > 0 || zips.length > 0 || !!serviceArea;
  const nameAlreadyAsked = steps.some((st) => /\bfull name\b/i.test(st));
  const dedupeCollect = (fields: string[]): string[] => fields.filter((f) => {
    const norm = f.trim().toLowerCase();
    if (zipAlreadyAsked && norm === "consumer zip") return false;
    if (nameAlreadyAsked && norm === "consumer name") return false;
    return true;
  });
  /* ⚠️ A WORKFLOW WITH NOTHING CONFIGURED, previewed honestly: exactly the four chrome nodes
     the diagram draws, and not one question more. `SALES_TEAM`/`SUPPORT_TEAM` are the generic
     names the user asked for, and they are the honest ones — an empty workflow has no
     configured queue, so naming the prospect's real desks would credit it with routing
     somebody has not set up. */
  const minimalFlow = [
    `CALL FLOW — this workflow has only its starting tree, so the call is EXACTLY this and nothing more:`,
    brain.voiceGreeting
      ? `1. OPEN with exactly this line, word for word: "${brain.voiceGreeting}"`
      : `1. OPEN: thank them for calling ${brain.customerName}, say you are its AI assistant, then ask how you can help today.`,
    `2. LISTEN to their answer. Ask NOTHING else — no ZIP code, no name, no dates, no reference number, no product questions.`,
    `3. DECIDE, from what they just said, which ONE of these two teams they need:`,
    `   • the sales team — a new enquiry: buying, booking, pricing, availability, anything they do not already have.`,
    `   • the support team — an existing customer: changing or cancelling something, a problem, a charge, anything they already have.`,
    `   If it is genuinely unclear, ask ONE short clarifying question, then decide. Never ask more than one.`,
    /* ⚠️ "EXACTLY ONE OF THESE" ON ITS OWN GOT READ AS THE WHOLE UTTERANCE: the agent replied
       just "Transferring you to the sales team now." to a caller who had explained what they
       wanted, which is abrupt on a demo call. The acknowledgement is asked for first and the
       scripted line is named as the ENDING, not the reply. */
    `4. ACKNOWLEDGE what they need in one short, warm sentence that shows you heard them, then`,
    `   transfer, ENDING your reply with exactly one of these lines, word for word:`,
    `   • "Transferring you to the sales team now."`,
    `   • "Transferring you to the support team now."`,
    ``,
  ];
  /* ⚠️⚠️ **THE BOOKING FLOW: THIS AGENT FINISHES THE JOB INSTEAD OF HANDING IT OVER.**
     Asked for 9/3/2026, as a third Avi & Co voice workflow. Every line here is deliberate:

     • the times are QUOTED FROM A TABLE, so the agent cannot invent availability. An
       invented slot is the one thing on this call a prospect could check against a real
       diary, and it is also what would desynchronise the Salesforce Calendar the SE opens
       next.
     • it says a WEEKDAY and a TIME, never a calendar date — the Calendar screen owns the
       date, and two independent claims about it would eventually disagree.
     • the location comes from the ZIP, nearest boutique first, with a VIRTUAL consultation
       as the fallback when the caller says it is too far. That is what the user chose when
       asked, and it matches the out-of-area behaviour the routing agent already has.
     • it NEVER transfers. The whole point of this workflow is that nobody is routed. */
  const bookingLocations = brain.voiceBookingLocations ?? [];
  const bookingFlow = [
    `CALL FLOW — you BOOK the ${book} on this call yourself. You never transfer the caller and never hand them to a team.`,
    brain.voiceGreeting
      ? `1. OPEN with exactly this line, word for word: "${brain.voiceGreeting}" Then wait for their answer.`
      : `1. OPEN: greet them as ${poss(brain.customerName)} AI assistant and ask how you can help. Then wait for their answer.`,
    `2. If they want to come in, visit, or book: continue. If they need help with something they have already bought, say a specialist will follow up and take their name and number — do NOT transfer them, this workflow has nobody to transfer to.`,
    `3. COLLECT, ONE QUESTION PER MESSAGE, waiting for each answer before asking the next: first their FULL NAME, then their ZIP CODE. Never ask for both in one breath, and never ask for either twice.`,
    bookingLocations.length
      ? `4. LOCATION, from their ZIP: ${poss(brain.customerName)} locations are ${bookingLocations.join(", ")}. Work out which is closest to their ZIP, name it, and ask if that works for them.\n   • If they say it is too far, or they would rather not travel, offer a VIRTUAL consultation instead and book that. Say "virtual consultation" so it is unambiguous.\n   • Never book someone into a location they have not agreed to.`
      : `4. LOCATION: ask which location suits them and use their answer.`,
    `5. TIMELINE: ask how soon they are looking to come in.`,
    `6. WEEKDAY: ask which weekday works best for them.`,
    brain.voiceBookingSlots && Object.keys(brain.voiceBookingSlots).length
      ? `7. TIMES — offer ONLY the times listed for the weekday they chose, read them out, and let them pick one. These are the whole of your availability; if they ask for anything else, say those are the times you have and offer the nearest one:\n${slotTable(brain.voiceBookingSlots)}`
      : `7. TIMES: offer two or three times on that weekday and let them pick one.`,
    `8. CONFIRM THE BOOKING and say clearly that it is booked. Repeat back, in one message: their name, the weekday, the time, and the location (or that it is a virtual consultation). Say the word "booked" so there is no doubt.`,
    `9. Then ask if there is anything they would like ready for the visit, answer briefly, and close warmly.`,
    ``,
    `HARD RULES FOR THIS CALL:`,
    `• NEVER offer, imply, or agree to a time that is not in the list above.`,
    `• NEVER say a calendar date (no "the 20th", no "09/20"). The weekday and the time are the appointment.`,
    `• NEVER transfer, route, or promise a callback from a department.`,
    `• NEVER ask for payment details, card numbers, or account numbers.`,
    /* ⚠️ THE CAP THE ROUTING FLOW ALREADY HAS. Without it the model volunteers a qualifying
       question of its own between steps — observed on the first real call. */
    `• ASK NOTHING BEYOND THE FLOW ABOVE. Do not add your own qualifying questions.`,
    ``,
  ];
  const flow = brain.voiceBooking ? bookingFlow : brain.voiceMinimal ? minimalFlow : paths.length ? [
    `CALL FLOW — follow the routing your team configured, adapting naturally to what the caller says:`,
    brain.voiceGreeting
      /* ⚠️ VERBATIM WHEN SCRIPTED. An SE who typed the opening line expects to hear it, not a
         paraphrase of it — this is the first thing a prospect hears on the demo call. */
      ? `1. OPEN with exactly this line, word for word: "${brain.voiceGreeting}"`
        + (brain.voiceQualify?.trim() && !brain.voiceGreeting.includes("?")
          /* ⚠️ ONLY WHEN THE GREETING DID NOT ALREADY ASK. Comfort Keepers' greeting IS its
             qualifying question, so appending it there would have the agent ask twice. */
          ? ` Then ask exactly this, word for word: "${brain.voiceQualify.trim()}"`
          : ``)
        + ` Then wait for their answer and work out which of these they need:`
      : `1. OPEN: greet them as ${poss(brain.customerName)} AI assistant, then work out which of these the caller needs:`,
    ...paths.map((p) => `   • ${p.intent}${p.recognise ? ` — ${p.recognise}` : ""}`),
    /* ⚠️ TWO GATES, AND WHICH ONE APPLIES IS THE PROSPECT'S OWN CONFIGURATION. An allow-list
       turns every unlisted ZIP away and reads the scripted apology verbatim; without one the
       demo rule stands, where a single ZIP is the only refusal so an SE can show the happy path
       with any number they like. Getting these the wrong way round either books callers a
       franchise cannot serve or turns away every caller in the demo. */
    /* The SE's own steps win outright — see the note at `voiceSteps`.
       ⚠️ **BUT AN ALLOW-LIST STILL HAS TO REACH THE PROMPT AS FACT.** With steps present the
       ZIP list used to vanish entirely, so an SE who set both got an agent that knew the
       policy and not the ZIP codes it applies to — the same lands-and-does-nothing shape one
       level over. The list goes in as DATA and the steps stay the only POLICY, so the two can
       never contradict. Skipped when the steps already recite the ZIPs (which
       `stepsForZips` does), to avoid saying it twice. */
    steps.length
      ? `\n2. THEN FOLLOW THESE STEPS EXACTLY, in order, and do not skip one:`
        + (zips.length && !zips.every((z) => steps.some((st) => st.includes(z)))
          ? `\n   Service-area ZIP codes: ${zips.join(", ")}.`
          : ``)
        + `\n${steps.join("\n")}`
      /* ⚠️⚠️ **THE SCRIPT STATES THE OUT-OF-AREA POLICY; THIS MUST NOT ALSO HARDCODE A
         REFUSAL.** It used to say "say exactly this and then END the call, asking nothing
         further and routing nobody" and then quote the script. That agrees with a script that
         turns the caller away and flatly contradicts one that offers them another location —
         and the refusal came first, so the agent hung up on callers an SE had just told it to
         redirect. Measured on Avi & Co, whose three showrooms were meant to produce a
         nearest-location offer. What survives is the SAFETY property (never route someone to
         somewhere they have not agreed to), which is true either way and needs no guess about
         what the script says. */
      : zips.length
      ? `\n2. SERVICE-AREA CHECK, before routing anyone who wants NEW service: ask for their ZIP code. ${brain.customerName}'s service area is these ZIP codes: ${zips.join(", ")}. If the caller's ZIP is one of them, briefly confirm you serve their area and continue. If it is ANYTHING else, say exactly this: "${brain.outOfAreaScript ?? `Thank you for calling ${brain.customerName}. Unfortunately we do not currently serve your area.`}" Then follow the caller's answer. Never route or book a caller to a location they have not agreed to, and if there is nothing you can offer them, close the call politely without routing.`
      : serviceArea
      ? `\n2. SERVICE-AREA CHECK, before routing anyone who wants NEW service: ask for their ZIP code. Treat "12345" as the ONLY out-of-area ZIP — if they say it, politely apologise, explain ${brain.customerName} serves ${serviceArea}, say you cannot book them, then STOP: ask nothing else and do not route. For ANY other ZIP, briefly confirm you serve their area and continue.`
      : ``,
    ``,
    ...paths.flatMap((p) => {
      /* ⚠️ DO NOT UNION THE COLLECT LISTS WHEN THE ROUTES ARE ANSWERS. Sibling teams share
         what they need, so unioning was right — but a Qualify leaf's routes are ALTERNATIVES,
         and unioning them told the agent to ask a caller booking an appointment for their
         "Issue Type" as well. When a route carries `need` its own line states what to
         collect, so the shared line is suppressed. Caught by reading the built prompt, not
         by any type. */
      const answered = p.routes.some((r2) => r2.need);
      const collect = answered
        ? []
        : dedupeCollect([...new Set(p.routes.flatMap((r2) => r2.collect ?? []).filter(Boolean))]);
      const lines = [`PATH: ${p.intent.toUpperCase()}`];
      if (collect.length) {
        lines.push(`   - Collect these, ONE question at a time, in this order: ${collect.join(", ")}. Ask for them in your own words, naturally.`);
      } else if (!answered) {
        lines.push(`   - Ask what they need, in their own words.`);
      }
      /* ⚠️⚠️ **A USE CASE'S OWN INSTRUCTION AND TRANSFER NUMBER REACH THE CALL (9/21/2026).**
         Both are configured in that node's drawer and neither used to be rendered anywhere —
         the instruction wrote a shared list and the phone was a read-only derived number, so
         two of the five rows on a voice action drawer changed nothing the agent said. Printed
         under the route they belong to, and only when the node actually carries one, so a
         workflow nobody has edited emits exactly the block it always did. */
      const nodeLines = (r2: (typeof p.routes)[number], indent: string): string[] => {
        const out: string[] = [];
        if (r2.instruction) {
          out.push(`${indent}Follow these instructions for this route, in order, and do not skip one:`);
          for (const st of r2.instruction.split("\n").map((x) => x.trim()).filter(Boolean)) {
            out.push(`${indent}  ${st}`);
          }
        }
        if (r2.phone) out.push(`${indent}Transfer this route to ${r2.phone}.`);
        return out;
      };
      if (p.routes.length === 1) {
        const r2 = p.routes[0];
        lines.push(`   - Then ${r2.action.toLowerCase()}, confirm, and transfer them to the team that handles ${p.intent}.`);
        lines.push(...nodeLines(r2, "   - "));
      } else {
        lines.push(`   - Then hand off to whichever of these fits what they told you, confirming before you transfer:`);
        /* ⚠️ THE DIAGRAM DOES NOT ENCODE *WHY* A BRANCH SPLITS, so the criterion is not
           invented here — the model is told to choose on what the caller said and the
           leaf's own action wording, which is the only honest instruction available. */
        for (const r2 of p.routes) {
          if (r2.need) {
            const c = dedupeCollect(r2.collect ?? []);
            lines.push(`      • If they say ${r2.need}: ${r2.action.toLowerCase()}${c.length ? `, collecting ${c.join(", ")}` : ""}${destination(r2.team)}.`);
          } else {
            lines.push(`      • ${r2.team} — ${r2.action}`);
          }
          lines.push(...nodeLines(r2, "        "));
        }
      }
      lines.push(``);
      return lines;
    }),
    /* ⚠️⚠️ THE ESCALATION INSTRUCTION HAS TO REACH **THIS** FLOW TOO, and the first attempt put
       it only in the hardcoded one below — which is emitted exactly when a prospect has NO use
       cases, i.e. for none of them. The drawer's field would have been a dead control on every
       real workflow. Caught by reading the built prompt rather than the diff. */
    ...(brain.voiceEscalate
      ? [`WHEN THE CALLER NEEDS THE SUPPORT TEAM: ${brain.voiceEscalate}`, ``]
      : []),
    /* ⚠️ THE SUPPORT INTENT'S OWN WORDS, when an SE has typed any — how to recognise it and
       the rules that govern it. Rendered next to the escalation instruction because that is
       the same path of the call. */
    ...(brain.voiceSupportIntent
      ? [`RECOGNISING A SUPPORT CALLER: ${brain.voiceSupportIntent}`, ``]
      : []),
    ...(brain.voiceSupportRules?.length
      ? [`RULES FOR THE SUPPORT PATH:`,
         ...brain.voiceSupportRules.map((r) => `- ${r}`), ``]
      : []),
  ] : [
    `CALL FLOW, adapt naturally to what the caller says:`,
    `1. OPEN: greet them as ${poss(brain.customerName)} AI assistant and ask whether they are calling to book ${aOrAn(book)} ${book}, or need help as an existing ${who}. Phrase it naturally for this business. Wait for their answer.`,
    ``,
    `PATH A: BOOKING ${book.toUpperCase()} (new ${who})`,
    serviceArea
      ? `   - FIRST ask for their ZIP code. SERVICE-AREA CHECK: treat "12345" as the ONLY out-of-area ZIP. If they say 12345, politely apologise, explain ${brain.customerName} serves ${serviceArea}, say you cannot book them, then STOP: do not ask anything else or route them. For ANY other ZIP, briefly confirm you serve their area and continue.`
      : ``,
    products.length
      ? `   - Ask which of these they need: ${products.slice(0, 4).join(", ")}. Offer them as spoken examples, not a list.`
      : `   - Ask what they need help with, in their own words.`,
    `   - Then ask how soon they need it.`,
    `   - Then ROUTE on urgency:`,
    `      • URGENT (today, this week, ASAP): treat as a HOT LEAD. Offer to connect them to ${r.newQueue}, confirm, then say "OK, I'm transferring you to ${r.newQueue} now."`,
    `      • Still deciding or comparing: offer ${r.generalQueue ?? r.newQueue} instead, same confirm-then-transfer wording.`,
    ``,
    `PATH B: EXISTING ${who.toUpperCase()}`,
    `   a. Ask for whatever reference they have so the team can find them: the name on the account, and a reference or account number if they have one. Do NOT invent a required format.`,
    `   b. Then ask what the issue is, in their own words.`,
    /* ⚠️ THE OPERATOR'S OWN ESCALATION INSTRUCTION, when they have set one, right where the
       support path is described. Absent unless edited, so the default flow is unchanged. */
    ...(brain.voiceEscalate ? [`   c. ${brain.voiceEscalate}`]
      : [`   c. Do NOT try to solve it. Once you have who they are AND what the issue is, offer to connect them to ${r.supportQueue}, confirm, then transfer ("Transferring you now.").`]),
    `      If it clearly is not a ${r.supportQueue} matter, route to ${r.generalQueue ?? r.supportQueue} instead.`,
    ``,
  ];

  /* ⚠️⚠️ **A BRACKETED PLACEHOLDER WOULD BE READ ALOUD.** Asked to offer the nearest showroom,
     the model wrote an out-of-area script containing the literal token `[CLOSEST_LOCATION]` —
     a template it expected something downstream to fill in, and nothing does. On a live call
     the agent either says the bracket out loud or improvises past it, on the first thing a
     prospect hears after giving their ZIP. Rather than sniffing for one vocabulary of
     placeholder names, any `[ALL_CAPS]` token left in the flow gets ONE instruction telling
     the agent to resolve it from what it already knows and never speak the bracket. */
  const placeholders = [...new Set(
    flow.join("\n").match(/\[[A-Z][A-Z0-9_ ]{2,}\]/g) ?? [],
  )];
  const placeholderRule = placeholders.length
    ? `PLACEHOLDERS: the lines above contain ${placeholders.join(", ")}. These are fill-ins, NOT words to say. Replace each one with the real value for THIS caller — the nearest location by name, their own details, whatever the token stands for — working it out from the service area and steps above. Never read a square bracket or its contents aloud.`
    : ``;

  return [
    NO_DASH_RULE,
    `You are the AI phone assistant for ${brain.customerName}${brain.industry ? `, a ${brain.industry} business` : ""}.`,
    `You are on a LIVE PHONE CALL. Your ONLY job is to QUALIFY the caller and ROUTE them to the right team — you do NOT sell, quote prices, or resolve issues yourself. You gather a couple of details, then hand the caller off.`,
    ``,
    ...flow,
    placeholderRule,
    paths.length && !brain.voiceMinimal ? namingRule(r) : ``,
    /* ⚠️ AN EXPLICIT CEILING ON WHAT IT MAY ASK. Listing the flow was not enough on its own —
       the model filled the gaps with sensible-sounding sales questions, which on a routing call
       reads as an interrogation and buries the one thing the demo is showing. */
    brain.voiceMinimal
      /* ⚠️ THE CAP MATTERS MOST HERE. With no fields to collect the model will happily fill
         the silence with qualifying questions, which is exactly what this flow must not do. */
      ? `ASK NOTHING BEYOND THE FLOW ABOVE. This workflow has no actions configured yet, so the ONLY thing you ask is the opening question (plus at most one clarifying question). Do NOT ask for a ZIP code, a name, dates, a reference number, a budget, or which product they want. As soon as you can tell sales from support, say which team and transfer.\n`
      : paths.length
      ? `ASK NOTHING BEYOND THE FLOW ABOVE. The only things you ask are the opening question and the fields listed under the path the caller chooses. Do NOT ask about budget, pricing, schedules, hours, which services they want, when they want to start, or who the care is for. The moment you have the listed fields, confirm and transfer.\n`
      : ``,
    `STYLE & RULES:`,
    `- This is a SPOKEN call: talk naturally and briefly (1–2 sentences), ask ONE question at a time, then stop and wait.`,
    `- NEVER use emojis, markdown, or formatting — your words are read aloud by a text-to-speech voice.`,
    `- NEVER quote prices, availability, or promotions. NEVER attempt to resolve a support issue yourself — only qualify and route.`,
    `- Only discuss ${brain.customerName}'s products and services; if the caller goes off-topic, gently steer back.`,
    /* ⚠️ THE BACKSTOP FOR EVERYTHING THE STRUCTURAL DEDUPE ABOVE CANNOT SEE — a caller who
       volunteers their name before being asked, or gives their ZIP while answering a
       different question. The fields removed from the flow above cover the guaranteed
       duplicates; this covers the rest, the same instruct-then-enforce pairing the dash rule
       and the placeholder rule already use elsewhere in this file. */
    `- NEVER ask for anything you already have. If the caller already gave you their name, ZIP code, or anything else earlier in this call, whether you asked for it or they volunteered it, use what you have and move on. Track what you have gathered so far as the call progresses.`,
    /* The workflow's own rules when it has them, the brand rules only as a fallback. */
    brain.voiceRules?.length
      ? `\nCONVERSATION RULES configured on this workflow:\n${brain.voiceRules.map((r) => `- ${r}`).join("\n")}`
      : rules ? `\nBRAND CONTEXT (brand-specific terms, teams, and numbers):\n${rules}` : ``,
    knowledge ? `\nKNOWLEDGE SOURCES (what you learned the business from):\n${knowledge}` : ``,
  ].join("\n");
}

export async function chatReply(
  brain: ChatBrain,
  messages: ChatMessage[],
  apiKey?: string,
  opts?: { voice?: boolean }
): Promise<string> {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set.");
  // maxRetries bumped above the SDK default (2) so brief Anthropic "overloaded"
  // (529) / rate-limit (429) blips are retried with backoff before we ever error.
  const client = new Anthropic({ apiKey: key, maxRetries: 4 });
  const voice = opts?.voice ?? false;

  // With no history yet, prompt the agent to open with a greeting.
  const convo: ChatMessage[] = messages.length
    ? messages
    : [{ role: "user", content: voice
        ? "(A caller just picked up the phone. Speak step 1 (OPEN) out loud: greet them as the AI assistant and ask whether they need help with a new order or an existing order / support. Keep it to 1–2 spoken sentences. Do NOT ask a qualifying question yet.)"
        : "(A new customer just texted in. Send step 1 of the conversation flow: introduce yourself, mention any current offer, and ask if they'd like to get started. Do NOT ask a qualifying question yet.)" }];

  const resp = await client.messages.create({
    model: CHAT_MODEL,
    max_tokens: 300,
    system: buildSystem(brain, voice),
    messages: convo,
  });
  const text = resp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("")
    .trim();
  return stripDashes(text) || "…";
}

/* The NO_DASH_RULE in the prompt is advisory and the model ignores it often
   enough to matter, so strip them for real on the way out. Prospects read this
   text during a demo and dash-joined clauses are the clearest AI tell.

   Only SPACED dashes and em/en dashes are touched, so hyphenated words survive:
   "rear-ended", "EV-qualified" and "24-48h" all pass through unchanged. */
export function stripDashes(s: string): string {
  return s
    .replace(/\s*[—–]\s*/g, ", ")     // em/en dash anywhere
    .replace(/ +- +/g, ", ")           // spaced hyphen used as a connector
    .replace(/,\s*,/g, ",")            // collapse any doubled commas
    .replace(/,\s*([.!?])/g, "$1")     // ", ." -> "."
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* Test hook: lets a script assert the voice prompt re-skins per prospect
   without standing up the whole app or spending an API call. */
export const __buildVoiceSystemForTest = (brain: ChatBrain) =>
  buildVoiceSystem(brain, "", "");
