import { useEffect, useMemo } from "react";
import { useProfile } from "./ProfileContext";
import { useAiAssistant } from "./AiAssistantContext";
import { SMS_AGENT_SCOPE_PATH } from "./smsBrain";
import { treeToVoicePaths, VOICE_WORKFLOW_SCOPE_PATH } from "./voicePaths";
import { emptyWorkflowGreeting } from "./workflowChrome";
import { voiceSpecFor, specWithConfig, type VoiceAgentConfig , DEFAULT_ESCALATE_HANDLING, DEFAULT_SUPPORT_INTENT } from "./voiceAgentSpec";
import type { WorkflowTreeModel } from "../components/WorkflowTree";
import type { CustomerProfile, VoiceConversation, VoiceTurn } from "./schema";

/* =============================================================================
   voiceSession.ts — the brain, the spec and the capture, shared by the voice call
   -----------------------------------------------------------------------------
   ⚠️⚠️ **THIS WAS `VoiceCall.tsx`, AND THE BROWSER-SPEECH ENGINE IT HELD IS GONE
   (9/3/2026).** That component was the pre-LiveKit pipeline: browser `SpeechRecognition`
   for ears, `POST /api/chat` for a brain, and `POST /api/tts` for a mouth — and that last
   one was Deepgram or ElevenLabs, called directly with their own API keys. Asked for
   directly: "completely delete everything related to elevenlabs or deepgram... everything to
   do with Voice agents has to go through LiveKit." With those two vendors removed the engine
   had no voice left but the robotic browser one, so keeping it would have meant shipping a
   fallback that sounds nothing like the product.

   ⚠️ **WHAT SURVIVED IS EVERYTHING BOTH ENGINES SHARED**, which is why this file exists at
   all rather than being deleted with the component: `useBrain` (the prompt, read from the
   page's effective config), `useVoiceSpec` (which spec this call is using, including its
   VOICE), `captureVoiceCall` (the single path into the Voice CI report — `audit:voice`
   asserts there is only one) and `buildVoiceConversation`.

   ⚠️ **CONSEQUENCE, STATED: LIVEKIT IS NOW THE ONLY VOICE ENGINE.** Where a server has no
   LiveKit credentials the workflow page says so instead of silently falling back to a
   different-sounding agent. That is the honest failure, and production has always had them.
   ============================================================================= */

interface Msg { role: "user" | "assistant"; content: string; }
/* ⚠️ THE BARGE-IN AND MIC-METER TUNING THAT USED TO LIVE HERE IS GONE WITH THE ENGINE.
   `ALLOW_BARGE_IN`, the VAD thresholds and the meter ceiling all described the browser
   pipeline's own turn-taking. LiveKit publishes the agent's state and handles interruption
   itself (see `liveKitVoice.ts`), so keeping the constants would have implied a knob that
   controls nothing. */

/* The agent's brain: the same brand rules + Q&A + knowledge + playbook the SMS
   Preview Agent uses, re-skinned per prospect at generation time. */
/**
 * Options for a preview that is not the prospect's configured voice workflow.
 *
 * ⚠️ **`scopePath` EXISTS BECAUSE THE KEY WAS HARDCODED.** `useBrain` read
 * `VOICE_WORKFLOW_SCOPE_PATH` — the built-in Voice page — so a call started from a CREATED
 * workflow would have read the configured tree and previewed a diagram the SE was not
 * looking at. That is the same wrong-surface bug as reading the profile instead of the page,
 * one level up.
 */
export interface BrainOpts {
  /** Which page's registered tree to read. Defaults to the built-in Voice workflow. */
  scopePath?: string;
  /** Preview a workflow that has only its starting tree: greet, classify, announce, transfer. */
  minimal?: boolean;
  /**
   * Preview a voice workflow that BOOKS the appointment instead of routing it.
   *
   * ⚠️ Carries its own greeting and locations because an extra workflow is not the prospect's
   * configured agent — its opener is the one an SE authored on that workflow, and using
   * `spec.greeting` here would have the booking agent open with the ROUTING agent's line.
   * `slots` is derived (see `voiceBooking.ts`) and passed in so the prompt, and only the
   * prompt, decides what availability exists.
   */
  booking?: { greeting?: string; locations: string[]; slots: Record<string, string[]> };
  /**
   * Preview a customer SUPPORT workflow: a containment-first agent driven entirely by its
   * playbook (engine/supportPrompt.ts). Like `booking`, it REPLACES the routing machinery
   * rather than trimming it, because the routing prompt forbids resolving issues.
   */
  support?: { playbook: NonNullable<CustomerProfile["reports"]["extraWorkflows"]>[number]["support"]; greeting?: string };
}

/**
 * The workflow page's scope key — ONE definition, read by `useBrain` and `useVoiceSpec`.
 *
 * ⚠️ Two copies of this string is how a call ends up reading a DIFFERENT page's tree from
 * the one the SE is looking at, which is the wrong-surface bug `BrainOpts` exists to fix.
 */
function treeScopeKey(profileId: string, opts?: BrainOpts): string {
  return `${profileId}::${opts?.scopePath ?? VOICE_WORKFLOW_SCOPE_PATH}`;
}

/**
 * The prospect's spec with the workflow page's own overrides laid over it.
 *
 * ⚠️ **EXTRACTED SO THE TTS VOICE COMES FROM THE SAME PLACE THE PROMPT DOES (9/3/2026).**
 * `VoiceCallLive` needs the chosen voice to put on the token, and re-deriving it there would
 * mean a second copy of the scope key and the merge — so the moment somebody changed one, the
 * agent would speak in a voice the Details tab was not showing. `useBrain` calls this too, so
 * there is exactly one answer to "which spec is this call using".
 */
export function useVoiceSpec(opts?: BrainOpts) {
  const { profile, profileId } = useProfile();
  const { effectiveData } = useAiAssistant();
  const effTree = effectiveData(treeScopeKey(profileId, opts)) as
    (WorkflowTreeModel & { agent?: VoiceAgentConfig }) | undefined;
  return useMemo(
    () => specWithConfig(voiceSpecFor(profile), effTree?.agent),
    [profile, effTree?.agent],
  );
}

export function useBrain(opts?: BrainOpts) {
  const { profile, profileId } = useProfile();
  const { effectiveData, registerBase } = useAiAssistant();

  /* ⚠️⚠️ **THE VOICE CALL USED TO READ THE RAW PROFILE, SO EVERY AI EDIT WAS A SILENT
     NO-OP HERE.** The SMS phone reads the effective config through `usePageData` and the
     SMS workflow drawer through `effectiveData`; this was the one surface of the three
     still reading `profile.reports.agentConfig` directly. An SE who used Ask AI to change
     the agent's rules, greeting or questions got a success message and a call that behaved
     exactly as before — the failure mode this repo keeps re-learning.

     ⚠️ **`effectiveData`, NEVER `usePageData`.** The workflow page has already registered
     its DIAGRAM as the AI scope and `registerScope` is last-write-wins, so calling
     `usePageData` here would silently repoint that page's sparkle from the tree to the
     agent config and kill "add a branch" with no visible cause. Same reason
     `WorkflowChatPreview` uses this pattern.

     ⚠️ The scope is the PREVIEW AGENT page's, because `agentConfig` is one object shared by
     both channels — so an edit made there governs the spoken call too, and the two agents
     cannot disagree about their own rules. */
  const agentKey = `${profileId}::${SMS_AGENT_SCOPE_PATH}`;
  /* `applyEdits` refuses a key with no base, so an SE who starts a call without ever opening
     the Preview Agent tab would make edits that did nothing. This fills the base WITHOUT
     making it the active scope. */
  useEffect(() => { registerBase(agentKey, profile.reports.agentConfig); },
    [agentKey, profile.reports.agentConfig, registerBase]);

  const ac = useMemo(
    () => (effectiveData(agentKey) as typeof profile.reports.agentConfig | undefined)
      ?? profile.reports.agentConfig,
    [effectiveData, agentKey, profile.reports.agentConfig],
  );

  /* ⚠️ THE DIAGRAM IS THE CALL'S LOGIC. Read the workflow page's EFFECTIVE tree — the same
     object its sparkle edits — and hand it to the prompt as routing paths, so an SE who
     adds a branch or changes what a leaf collects hears the agent follow it on the next
     call. Read, never registered: `usePageData` here would repoint that page's own sparkle
     away from the tree, which is the trap `WorkflowChatPreview` documents.

     Absent a tree (a call started somewhere with no diagram) this is empty and the prompt
     falls back to its original hardcoded flow. */
  const treeKey = treeScopeKey(profileId, opts);
  const effTree = effectiveData(treeKey) as
    (WorkflowTreeModel & { agent?: VoiceAgentConfig }) | undefined;
  /* ⚠️⚠️ **THE AGENT'S CONFIG IS READ FROM THE PAGE, NOT FROM THE PROFILE (8/27/2026).**
     This was `voiceSpecFor(profile)`, i.e. the BASE spec — so an SE who told Ask AI "greet
     callers with X" or "only serve these ZIP codes" watched the diagram and drawers update
     and then heard the agent on the phone use the old greeting anyway. The edit landed; it
     just never reached the one surface that matters. Same failure the tree itself had before
     `treeToVoicePaths` started reading effective data, one field down.

     `specWithConfig` lays the page's config over the base rather than replacing it, so a
     partial override cannot drop the routing steps and quietly stop the agent asking for a
     name. */
  const spec = useMemo(
    () => specWithConfig(voiceSpecFor(profile), effTree?.agent),
    [profile, effTree?.agent],
  );
  const voicePaths = useMemo(() => treeToVoicePaths(effTree), [effTree]);
  /* ⚠️⚠️ **A MINIMAL PREVIEW MUST NOT INHERIT THE CONFIGURED AGENT'S FIELDS.** The prospect's
     spec carries a ZIP allow-list, routing steps, conversation rules and a greeting that asks
     a two-way booking question — all of it correct for the configured workflow and all of it
     wrong for one with no actions. Returning the spec fields here and merely adding a flag
     would leave the prompt carrying a service-area gate for a flow whose whole point is that
     nothing is configured, which is the self-contradicting prompt this repo has already been
     bitten by once. So they are dropped at the source, and the greeting is the empty
     workflow's own. */
  const minimal = !!opts?.minimal;
  const booking = opts?.booking;
  return {
    customerName: profile.customerName,
    industry: profile.industry,
    rules: ac?.brandConversationRules ?? [],
    qaPairs: ac?.aiRecommendations?.find((r) => r.qaPairs?.length)?.qaPairs ?? [],
    knowledge: ac?.knowledgeSources?.map((k) => k.name) ?? [],
    playbook: ac?.smsPlaybook,
    serviceArea: ac?.serviceArea,
    voicePaths,
    /* ⚠️ THE SPEC REACHES THE LIVE CALL, which is the whole point of it. Without these three
       the diagram and the drawers would show this prospect's configuration while the agent on
       the phone used the generic derived flow — the two-surfaces-disagreeing failure this
       repo keeps hitting, in its most visible form: a prospect hears the wrong greeting. */
    voiceMinimal: minimal,
    ...(opts?.support?.playbook ? { supportPlaybook: opts.support.playbook } : {}),
    /* ⚠️⚠️ **THE BOOKING FLOW DROPS THE SAME FIELDS THE MINIMAL FLOW DOES, AND FOR THE SAME
       REASON.** The service-area gate can REFUSE a caller and the routing steps name a team to
       hand off to; a booking agent must do neither. Leaving them in would put a refusal and a
       booking instruction in one prompt, which is the self-contradicting shape that already
       cost this repo a debugging session (the out-of-area script fighting step 3). The booking
       flow states the location policy itself: nearest boutique, virtual as the fallback. */
    voiceBooking: !!booking,
    voiceBookingLocations: booking?.locations,
    /* ⚠️ THE PROSPECT'S OWN PRODUCTS, read off the screen-pop the rest of the demo already
       shows, so the Lead this call creates names a product the dashboards also name. */
    voiceBookingProducts: booking
      ? (profile.reports.voiceScreenpop?.products ?? "").split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean)
      : undefined,
    voiceBookingSlots: booking?.slots,
    serviceZips: minimal || booking ? undefined : spec?.serviceZips,
    outOfAreaScript: minimal || booking ? undefined : spec?.outOfAreaScript,
    voiceGreeting: opts?.support?.playbook ? (opts.support.greeting?.trim() || undefined)
      : minimal ? emptyWorkflowGreeting(profile.customerName)
      /* The workflow's own opener, then whatever the SE edited on it, then the prospect's. */
      : booking ? (booking.greeting?.trim() || spec?.greeting)
      : spec?.greeting,
    voiceQualify: minimal || booking ? undefined : spec?.qualifyQuestion,
    /* ⚠️⚠️ **THE ROUTING WORKFLOW'S RULES ARE DROPPED TOO, AND THAT WAS MEASURED RATHER THAN
       ASSUMED.** They were kept at first on the reasoning that rules are "how the agent
       sounds, not what it does". On the very first real call the agent collected the name and
       then asked "What brings you in today? Are you looking to view watches, jewelry, or
       something else?" — a qualifying question from the OTHER workflow, inserted between two
       steps of this one. Those rules are the routing agent's configuration; a booking
       workflow's flow is self-contained and says so in its own hard rules. */
    voiceRules: minimal || booking ? undefined : spec?.rules,
    voiceSteps: minimal || booking ? undefined : spec?.informSteps,
    /* ⚠️ SENT ONLY WHEN IT DIFFERS FROM THE DEFAULT, so an untouched agent's prompt is
       byte-identical to before this field existed. Absent on a minimal or booking flow for the
       same reason the steps are: those replace the routing machinery rather than trimming it. */
    voiceEscalate: minimal || booking || !spec?.escalateHandling
      || spec.escalateHandling === DEFAULT_ESCALATE_HANDLING ? undefined : spec.escalateHandling,
    /* ⚠️ THE SUPPORT INTENT, ON THE SAME RULE AS THE ESCALATION ABOVE: sent only when it
       DIFFERS from what the drawer used to hardcode, so an agent nobody has edited emits the
       exact prompt it did before these two fields existed. */
    voiceSupportIntent: minimal || booking || !spec?.supportIntent
      || spec.supportIntent === DEFAULT_SUPPORT_INTENT ? undefined : spec.supportIntent,
    voiceSupportRules: minimal || booking || !spec?.supportRules?.length
      ? undefined : spec.supportRules,
    /* Per-prospect routing for the voice prompt. Same source the workflow
       diagram uses (voiceRoutingDemo.queues), so the spoken call and the
       diagram name the same teams. Without this the prompt fell back to
       hardcoded retail language and asked every caller, including a hospital's,
       for an order number. */
    voiceRouting: (() => {
      const q = profile.reports.voiceRoutingDemo?.queues ?? [];
      if (!q.length) return undefined;
      const name = (i: number) => q[i]?.name;
      return {
        newQueue: name(0) ?? "the new enquiries team",
        supportQueue: name(1) ?? "the support team",
        generalQueue: name(2),
        bookingTerm: profile.bookingTerm,
        products: profile.reports.marketingDashboard.breakdowns
          .find((b) => /Product Category/i.test(b.title))?.rows.map((x) => x.name),
        who: /patient/i.test(name(1) ?? "") ? "patient"
          : /resident/i.test(name(1) ?? "") ? "resident" : "customer",
      };
    })(),
  };
}

function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ---- capture helpers (client-side; Date/Math.random are fine here) --------
   Builds the VoiceConversation record captured into the AI Voice Conversation
   Intelligence report when the call ends. Mirrors PhonePreview's SMS capture. */
const HEX = "0123456789ABCDEF";
function hex(n: number): string { return Array.from({ length: n }, () => HEX[Math.floor(Math.random() * 16)]).join(""); }
function genId(): string { return `${hex(4)}-${hex(12)}`; }
function clock(d: Date): string { let h = d.getHours(); const m = d.getMinutes(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${String(m).padStart(2, "0")} ${ap}`; }
function listTime(d: Date): string { let h = d.getHours(); const m = d.getMinutes(); const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12; return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)} ${h}:${String(m).padStart(2, "0")} ${ap}`; }
function startTime(d: Date): string { let h = d.getHours(); const m = d.getMinutes(); const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12; return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)} ${h}:${String(m).padStart(2, "0")} ${ap}`; }
function longDate(d: Date): string { return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }); }

/* Best-effort pull of a caller name from what they said. */
function extractName(messages: Msg[]): { first: string; last: string; display: string } {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const match = m.content.match(/(?:my name is|it'?s|i'?m|this is)\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?/);
    if (match) {
      const first = match[1], last = match[2] || "";
      return { first, last, display: last ? `${first[0]} ${last}` : first };
    }
  }
  return { first: "—", last: "—", display: "Voice Lead" };
}

/**
 * Capture a finished call into the AI Voice Conversation Intelligence report, then analyse it.
 *
 * ⚠️⚠️ **SHARED BY BOTH CALL ENGINES, AND IT HAD TO BE.** `VoiceCall` and `VoiceCallLive` each
 * carried their own copy of this, and the copies diverged the moment one gained a feature:
 * `destinations` and the `outcome` patch were added to the OLD engine only, so a real LiveKit
 * call — which is the one every configured environment actually runs — captured fine and never
 * stored an outcome, and the two (Voice AI) rows silently never appeared. Reported as "I had
 * the conversation, it transferred me, and it wasn't there."
 *
 * The report's own capture is why the duplication survived so long: both copies worked
 * perfectly for the thing they were written for. Anything added here reaches both engines.
 */
export function captureVoiceCall(
  profile: { id: string; customerName: string; bookingTerm: string; customerNoun?: string },
  brain: {
    voicePaths?: { routes: { team: string }[] }[];
    /* Present only for a booking workflow; see the note at the analyze call below. */
    voiceBookingSlots?: Record<string, string[]>;
    voiceBookingLocations?: string[];
    voiceBookingProducts?: string[];
  },
  msgs: Msg[],
  durationSecs: number,
  addCaptured: (profileId: string, conv: VoiceConversation) => void,
  patchCaptured: (profileId: string, id: string, patch: Partial<VoiceConversation>) => void,
): void {
  const conv = buildVoiceConversation(msgs, durationSecs);
  addCaptured(profile.id, conv);
  fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName: profile.customerName,
      bookingTerm: profile.bookingTerm,
      customerNoun: profile.customerNoun,
      channel: "voice",
      /* ⚠️ THE DEPARTMENTS THIS WORKFLOW CAN ROUTE TO, so the analysis CLASSIFIES rather than
         extracting the agent's spoken paraphrase — see the note on `AnalyzeInput.destinations`.
         Read off the same `voicePaths` the prompt was built from, so the list the model chooses
         from is exactly the list the agent was routing against. */
      destinations: [...new Set(
        (brain.voicePaths ?? []).flatMap((p) => p.routes.map((r) => r.team)).filter(Boolean),
      )],
      /* ⚠️ AND FOR A BOOKING WORKFLOW, THE ONLY DAYS / TIMES / PLACES AN APPOINTMENT MAY BE
         REPORTED AT — read off the very table the prompt offered, so the analysis can only
         report a slot the agent actually had. The Salesforce Calendar renders this, and a
         paraphrased time would put an appointment on screen the call never offered. */
      bookingDays: brain.voiceBookingSlots ? Object.keys(brain.voiceBookingSlots) : undefined,
      bookingTimes: brain.voiceBookingSlots
        ? [...new Set(Object.values(brain.voiceBookingSlots).flat())] : undefined,
      bookingLocations: brain.voiceBookingLocations,
      /* The prospect's own products, so a booked Lead's Product of Interest is one of theirs
         rather than the caller's paraphrase — see `AnalyzeInput.bookingProducts`. */
      bookingProducts: brain.voiceBookingProducts,
      transcript: conv.transcript.map((t) => ({ speaker: t.speaker, text: t.text })),
    }),
  })
    .then((r) => r.json())
    .then((d) => {
      const patch: Partial<VoiceConversation> = {};
      if (Array.isArray(d?.signals) && d.signals.length) patch.signals = d.signals;
      /* ⚠️ THE OUTCOME GATES THE TWO (Voice AI) ARTIFACTS. Stored only when the model returned a
         well-formed one, so a failed analysis leaves the call with no outcome and those rows
         simply do not appear. */
      if (d?.outcome && typeof d.outcome.transferred === "boolean") patch.outcome = d.outcome;
      if (Object.keys(patch).length) patchCaptured(profile.id, conv.id, patch);
    })
    .catch(() => { /* leave signals empty; the report shows an analyzing note */ });
}

export function buildVoiceConversation(messages: Msg[], durationSecs: number): VoiceConversation {
  const now = new Date();
  const id = genId();
  const transcript: VoiceTurn[] = messages.map((m, i) => ({
    speaker: m.role === "assistant" ? "agent" : "consumer",
    time: clock(new Date(now.getTime() + i * 12000)),
    text: m.content,
  }));
  const nm = extractName(messages);
  return {
    id,
    time: listTime(now),
    active: true,
    date: longDate(now),
    transcript,
    signals: [],
    voiceInfo: {
      callRecordId: id,
      callStartTime: startTime(now),
      duration: mmss(durationSecs),
      destinationPhone: "877-936-2933",
      source: "805-336-1120",
      promoNumberDescription: "Voice — Paid Search",
      connectionStatus: "Connected",
      callerId: `805-555-${String(1000 + Math.floor(Math.random() * 9000)).slice(0, 4)}`,
      repeatCaller: "No",
      city: "Santa Barbara",
      region: "CA",
      phoneType: "Mobile",
      displayName: nm.display,
      firstName: nm.first,
      lastName: nm.last,
      gender: "—",
      destinationTimeZone: "Pacific Time (US & Canada)",
      finalCampaign: "Default: Voice Campaign",
      finalCampaignId: "9970118",
    },
  };
}
