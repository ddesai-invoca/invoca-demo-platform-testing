/* =============================================================================
   smsBrain.ts — ONE definition of what the SMS agent knows
   -----------------------------------------------------------------------------
   Two screens now test the same SMS agent:

     • Preview Agent          (/agent-studio/agent/preview) — the iPhone mockup
     • Preview Workflow       (the chat drawer on the SMS workflow page)

   They MUST ask the same questions, in the same order, with the same rules —
   they are previews of ONE agent, and an SE who tunes the questions on one screen
   and sees different behaviour on the other has been shown a lie. Two copies of
   this object would drift on the first edit, so the shape lives here and both
   callers build from it.

   The AGENT CONFIG is passed IN rather than read from the profile, because the
   two callers must obtain it differently and only one of them may register an AI
   scope:

     • PhonePreview calls usePageData(...) — it IS the page whose AI drawer edits
       the agent's questions, so registering is correct there.
     • The workflow drawer must NOT register: the workflow page has already
       registered its DIAGRAM as the editable scope, and a second registration on
       the same page would silently repoint that page's sparkle at the agent
       config instead of the tree. It reads the Preview Agent page's EFFECTIVE
       config via effectiveData(...) instead — so questions edited over there
       still apply here, which is the behaviour you want from two views of one
       agent.
   ============================================================================= */

import type { CustomerProfile, AgentConfigView } from "./schema.ts";

/** Mirrors `SmsWorkflowFlow` in `workflowDrawers.ts`, declared here so the brain type is local. */
export interface SmsFlowNodeShape {
  title: string; action: string;
  question?: string; fallback?: string; instruction?: string;
  destination?: string; signal?: string; collect?: string[];
  answers?: SmsFlowNodeShape[];
}
export interface SmsWorkflowFlowShape {
  intents: { title: string; looksLike: string; rules: string[]; flow: SmsFlowNodeShape[] }[];
}

type Profile = CustomerProfile;
/* PARTIAL on purpose. `agentConfig` is optional on the profile, so PhonePreview's
   base object is built with `...(profile.reports.agentConfig ?? {})` and every
   field arrives optional; the workflow drawer's `effectiveData()` is looser still
   (it returns whatever the AI layer stored). Every field below is read
   defensively, so accepting a partial is honest rather than a cast. */
type AgentConfig = Partial<AgentConfigView> | undefined | null;
type ExtraWorkflow = NonNullable<Profile["reports"]["extraWorkflows"]>[number];

export interface SmsBrain {
  /** A customer SUPPORT workflow's playbook. Its presence selects the containment-first
   *  support prompt on the chat engine, ahead of every other field here. */
  supportPlaybook?: NonNullable<ExtraWorkflow["support"]>;
  smsGreeting?: string;
  customSystem?: string;
  openingMessage?: string;
  agentLabel?: string;
  customerName: string;
  industry: string;
  rules: string[];
  qaPairs: { question: string; answer: string }[];
  knowledge: string[];
  playbook: AgentConfigView["smsPlaybook"] | undefined;
  /**
   * Config an SE or Ask AI CHANGED, for a workflow whose own `systemPrompt` replaces the
   * default flow.
   *
   * ⚠️⚠️ **THIS EXISTS BECAUSE `customSystem` SWALLOWED EVERY EDIT ON SUCH A PAGE.**
   * `buildSystem` returns `customSystem + SMS_FORMAT_RULES` and never reaches the lines that
   * render the questions, the brand rules, the Q&A or the knowledge list — so on an extra
   * workflow's Preview Agent, "ask for their ZIP first" applied, reported success, and
   * changed nothing. Reported directly, 9/3/2026.
   *
   * ⚠️ **ONLY WHAT ACTUALLY DIFFERS FROM THE PROFILE GOES IN HERE.** Appending the prospect's
   * generic playbook questions to a nurture script nobody edited would CONTRADICT that
   * script, and "a self-contradicting prompt is worse than either rule" is a lesson this repo
   * has already paid for twice. Untouched config sends nothing and those workflows behave
   * exactly as they were signed off.
   */
  overrides?: { questions?: string[]; rules?: string[] };
  /** The built-in workflow's configured flow — see the argument note on `buildSmsBrain`. */
  workflow?: SmsWorkflowFlowShape;
  /**
   * The extra workflow's ORDERED FLOW, appended to its own playbook.
   *
   * ⚠️ **THE SMS COUNTERPART TO THE VOICE SPEC'S `informSteps`, and it exists so the two
   * channels' Ask AI behave the same way.** The voice workflow page registers its agent
   * alongside the diagram, so one instruction reshapes the tree AND configures the agent; an
   * SMS extra workflow registered only the diagram, so "open with X" or "confirm the facility
   * before offering anything" had nowhere to land — the model wrote the edit, `applyEdits`
   * found no such path, and the drawer reported success. That is the silent no-op recorded
   * five times in CLAUDE.md.
   *
   * ⚠️ **ABSENT UNLESS THE WORKFLOW AUTHORS `playbookSteps`.** Every workflow written before
   * this carries its flow inside `systemPrompt` prose, so nothing is appended and its prompt
   * is byte-identical.
   */
  steps?: string[];
}

/**
 * The scope path an SMS extra workflow's page registers, i.e. where its `agent` half lives.
 *
 * ⚠️ **ONE DEFINITION, BECAUSE TWO SURFACES READ IT AND THEY ARE DIFFERENT PAGES.** The
 * workflow page writes it (Ask AI, and the Details tab's Custom Greeting); the Preview Agent
 * opens in a SEPARATE TAB at `/agent-studio/agent/preview?wf=<slug>` and has to read it back
 * to honour the edit. A second copy of this string is how one of them ends up reading a key
 * nobody writes, which looks exactly like an edit that applied and did nothing.
 */
export const smsWorkflowScopePath = (slug: string): string =>
  `/agent-studio/agent/workflow/${slug}`;

/**
 * What an SMS extra workflow's Ask AI may configure: the fields the DIAGRAM CANNOT DRAW.
 *
 * ⚠️ **EACH FIELD HAS EXACTLY ONE HOME, the same rule the voice page's `agent` half follows.**
 * Anything the tree draws (intent subtitles, leaf titles, use-case titles, chips) stays in the
 * tree and only there. These two are invisible on the diagram and belong to THIS workflow
 * rather than to the prospect's shared agent, which is why they live here and not under the
 * Preview Agent page's `agentConfig`:
 *   - `greeting`   — the workflow's own `openingMessage`
 *   - `steps`      — its own `playbookSteps`
 *
 * ⚠️ **`rules` AND `questions` ARE DELIBERATELY NOT HERE.** They already have a home: the
 * prospect's `brandConversationRules` and `smsPlaybook.qualifyingQuestions`, edited on the
 * Preview Agent page and reaching a custom-playbook workflow through `overrides`. Registering
 * them here too would give one field two homes, and the first edit to either would strand the
 * other — the duplicated-field failure behind all three of the 8/27 voice bugs.
 */
export interface SmsWorkflowAgent {
  greeting?: string;
  steps?: string[];
}

/**
 * The `agent` half to register beside an SMS extra workflow's diagram.
 *
 * ⚠️ **OMITS AN ABSENT FIELD RATHER THAN WRITING `undefined`**, the same contract
 * `agentConfigOf` follows on the voice side: `editGuard` treats `undefined -> value` as a type
 * flip unless the path is creatable, and the model is told a field exists when it does not.
 */
export function smsWorkflowAgentOf(wf: ExtraWorkflow): SmsWorkflowAgent {
  return {
    ...(wf.openingMessage ? { greeting: wf.openingMessage } : {}),
    ...(wf.playbookSteps?.length ? { steps: wf.playbookSteps } : {}),
  };
}

function aOrAn(word: string): string {
  return /^[aeiou]/i.test(word.trim()) ? "an" : "a";
}

/* THE AGENT'S OPENING MESSAGE, when nothing has set one.

   Derived, not generated: every profile already on disk predates the `greeting`
   field, and an engine phase to add one would mean regenerating all of them. The
   playbook already carries prospect-specific prose we can lean on, so this reads
   as that business rather than as a template.

   The `offer` is dropped in VERBATIM as its own sentence rather than folded into
   one. Splicing it mid-sentence needs the first letter lowercased, which is fine
   for "Save with..." and wrong for "72 Hour Sale..." or a brand name; a separate
   sentence needs no case surgery and cannot mangle anyone's offer.

   Side effect worth knowing: the opening line is now the SAME on every run. It
   used to be improvised by the model each time the tab opened, so an SE could not
   rehearse against it. */
export function defaultGreeting(customerName: string, playbook: AgentConfigView["smsPlaybook"] | undefined): string {
  const booking = playbook?.bookingType?.trim() || "appointment";
  const offer = playbook?.offer?.trim() ?? "";
  const offerSentence = offer ? ` ${/[.!?]$/.test(offer) ? offer : offer + "."}` : "";
  /* {name} is resolved at render by resolveGreeting(). Kept as a TOKEN in the
     stored text rather than a baked-in name so the greeting stays portable: the
     same demo re-opened against a different caller still addresses the right
     person, and an SE editing it can move the name around. */
  return `Hi {name}, I'm ${customerName}'s AI assistant. I can help you book ${aOrAn(booking)} ${booking}.${offerSentence} Would you like to get started?`;
}

/* THE ONE PLACE {name} IS RESOLVED.

   The caller comes from the Voice Screenpop, deliberately: that is a real person
   from elsewhere in this prospect's story, so the SMS thread and the screenpop
   name the same customer instead of inventing a second one.

   Both the phone and the Ask AI drawer call this, so the row in the drawer shows
   the exact text the phone sends. Two copies of this substitution would drift the
   moment one of them handled the fallback differently. */
export function resolveGreeting(text: string, profile: Profile): string {
  const first = (profile.reports.voiceScreenpop?.callerName ?? "").split(/\s+/)[0];
  return text.replace(/\{name\}/g, first || "there");
}

/** The `brain` POST body for /api/chat. `wf` is an extra workflow (e.g. a nurture
 *  playbook) whose systemPrompt REPLACES the default sales flow. */
/** Same-shape comparison, so a re-ordered list counts as a change and a re-render does not. */
function changed(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

/**
 * What the SE or Ask AI has changed, relative to the prospect's own profile.
 *
 * Computed from `profile.reports.agentConfig` (the base) against the effective config, which
 * is why this needs no extra argument: the raw config is already on the profile.
 */
function editedSlices(profile: Profile, ac: AgentConfig): SmsBrain["overrides"] {
  const raw = profile.reports.agentConfig as AgentConfig;
  const out: NonNullable<SmsBrain["overrides"]> = {};
  const q = ac?.smsPlaybook?.qualifyingQuestions;
  if (Array.isArray(q) && q.length && changed(q, raw?.smsPlaybook?.qualifyingQuestions)) out.questions = q.map(String);
  const r = ac?.brandConversationRules;
  if (Array.isArray(r) && r.length && changed(r, raw?.brandConversationRules)) out.rules = r.map(String);
  return out.questions || out.rules ? out : undefined;
}

/**
 * @param wfAgent The EFFECTIVE `agent` half from the workflow page's own scope, when the
 *   caller can obtain it. Absent for the built-in SMS agent (there is no such page) and
 *   absent when nobody has edited the workflow, in which case every value below falls back
 *   to the authored data and the brain is byte-identical to before this parameter existed.
 */
export function buildSmsBrain(
  profile: Profile,
  ac: AgentConfig,
  wf?: ExtraWorkflow,
  wfAgent?: SmsWorkflowAgent | null,
  /**
   * The BUILT-IN workflow's own configuration, so the diagram reaches the agent.
   *
   * ⚠️⚠️ **THE WHOLE POINT OF THE 9/17/2026 CHANGE.** Asked for directly: "if there are changes
   * in the workflow, it also changes it in actual preview agent or preview workflow." Before it,
   * this function read `agentConfig` and an extra workflow's own prompt and NOTHING from the
   * six-row template, so every configured question, instruction, intent and collect list was
   * invisible to the phone.
   * ⚠️ Passed IN rather than derived here, exactly as `wfAgent` is: the caller is the page that
   * holds the effective tree, and deriving it here would mean this module importing the drawer
   * builder for one field.
   * ⚠️ Absent for an EXTRA workflow, which states its own flow in `systemPrompt`/`playbookSteps`
   * — two flows for one conversation is the contradiction this file keeps recording.
   */
  workflow?: SmsWorkflowFlowShape | null,
): SmsBrain {
  return {
    ...(workflow && !wf ? { workflow } : {}),
    customSystem: wf?.systemPrompt,
    /* Precedence: an extra workflow's scripted line wins (it is the whole point of
       that workflow), then whatever the SE or the AI set, then the derived default.
       Always non-empty now, so the phone never improvises its own opener. */
    /* ⚠️⚠️ **AN EXPLICITLY SET GREETING WINS OVER THE WORKFLOW'S SCRIPTED LINE, AND THE OLD
       ORDER WAS A SILENT NO-OP (9/3/2026).** Reported directly: "in the ask AI feature i
       asked for a couple of changes, the AI said that they applied but none of them actually
       applied... the opening message still hasnt changed."

       `wf?.openingMessage` used to come FIRST, and it is read from the RAW profile — so on a
       Preview Agent opened for an extra workflow, an SE (or Ask AI) could set
       `smsPlaybook.greeting`, watch the drawer's row update, be told it applied, and hear the
       phone open with the old line forever. `smsPlaybook.greeting` is absent until somebody
       sets it (verified across the demos on disk: Avi & Co and Reyes Law both carry a
       workflow opener and NO stored greeting), so its mere PRESENCE means a human or the
       assistant put it there — which is exactly the thing that should win.

       Unedited, this is byte-identical to the old behaviour: no stored greeting, so the
       workflow's own opener is still what the agent says. */
    /* ⚠️ `wfAgent.greeting` SITS WHERE `wf.openingMessage` DID, not ahead of the stored
       greeting. Its BASE *is* `wf.openingMessage` (see `smsWorkflowAgentOf`), so an unedited
       workflow resolves to exactly the same string as before; when the workflow page's Ask AI
       or its Details tab rewrites the opener, this is the line the phone actually sends.
       Putting it first would have re-created the very precedence bug fixed on 9/3: a
       workflow-side value outranking a greeting a human explicitly set. */
    /* ⚠️⚠️ ONE WORKFLOW KIND JUMPS THE QUEUE, AND ONLY ONE (9/12/2026). A workflow generated
       from a live LSA quote request sets `openingMessageWins`, because its opener quotes what
       somebody typed into the form SECONDS ago — where the rule below exists to stop a line
       authored MONTHS ago beating an SE's edit. Measured: 3 of 15 profiles ship a stored
       `smsPlaybook.greeting` (Aptive, Denver Health, Marriott), and without this the whole
       "the agent replies to what you typed" beat would open with the generic line on exactly
       those three — a silent no-op of the kind this file already records five times.
       ⚠️ An edit made ON that workflow still wins over its generated opener: `wfAgent.greeting`
       is checked first, so Ask AI and the Details tab keep working as they do everywhere. */
    openingMessage: (wf?.openingMessageWins
      ? (wfAgent?.greeting?.trim() || wf?.openingMessage)
      : undefined)
      || ac?.smsPlaybook?.greeting?.trim()
      || wfAgent?.greeting?.trim()
      || wf?.openingMessage
      || defaultGreeting(profile.customerName, ac?.smsPlaybook),
    agentLabel: wf?.label,
    /* ⚠️ A SUPPORT workflow is its own agent end to end (engine/supportPrompt.ts), so the
       playbook rides on the brain and the greeting is the workflow's own line. */
    ...(wf?.support ? { supportPlaybook: wf.support, smsGreeting: wf.openingMessage } : {}),
    customerName: profile.customerName,
    industry: profile.industry,
    rules: ac?.brandConversationRules ?? [],
    qaPairs: ac?.aiRecommendations?.find((r) => r.qaPairs?.length)?.qaPairs ?? [],
    knowledge: ac?.knowledgeSources?.map((k) => k.name) ?? [],
    playbook: ac?.smsPlaybook,
    /* Only when a custom flow would otherwise swallow them — everywhere else these already
       reach the prompt through `rules` and `playbook`, and sending them twice would have the
       agent read one list as an override of itself. */
    overrides: wf?.systemPrompt ? editedSlices(profile, ac) : undefined,
    /* The edited flow when the page has one, the authored flow otherwise, and absent when the
       workflow states its flow in prose instead. Rendered by `engine/chat.ts`. */
    ...(() => {
      const steps = wfAgent?.steps ?? wf?.playbookSteps;
      return steps?.length ? { steps: steps.map(String) } : {};
    })(),
  };
}

/** The scope key whose AI edits define the SMS agent's questions. Both previews
 *  point at the Preview Agent page, so an edit made there governs both. */
export const SMS_AGENT_SCOPE_PATH = "/agent-studio/agent/preview";
/**
 * The BUILT-IN SMS workflow page's scope, whose tree and `sms` config now drive the agent.
 *
 * ⚠️ ONE DEFINITION, THREE READERS — this page writes it and both previews read it. Two copies
 * of a key string is how one side ends up reading a key nobody writes, which is the exact trap
 * `smsWorkflowScopePath` was extracted to avoid for the extra workflows.
 */
export const SMS_WORKFLOW_SCOPE_PATH = "/agent-studio/agent/workflow/sms";

/* Shared /api/chat call with the same transient-failure backoff both previews
   need, and the same markdown strip (the model occasionally emits ** or ` and a
   text message never contains those). */
export async function askSmsAgent(brain: SmsBrain, history: { role: "user" | "assistant"; content: string }[]): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * attempt));
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brain, messages: history }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (res.ok) return String(data.reply ?? "").replace(/\*\*|__|`/g, "") || "…";
      lastErr = new Error(data?.error || "Chat failed.");
      if (res.status < 500 && res.status !== 429) break;   // non-transient → stop
    } catch (e: any) {
      lastErr = e instanceof Error ? e : new Error("Network error. Please try again.");
    }
  }
  throw lastErr ?? new Error("Chat failed.");
}
