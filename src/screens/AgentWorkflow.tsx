import { useState, useMemo } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useAgentWorkflows } from "../data/agentWorkflows";
import { INTENT_SALES, INTENT_SUPPORT, SUPPORT_LEAF, ZERO_TRIGGER, emptyWorkflowTree,
  extraTree, LEAF_QUALIFY, LEAF_ESCALATE, LEAF_INFORM } from "../data/workflowChrome";
import { useProfile } from "../data/ProfileContext";
import { AgentStudioLayout } from "./AgentStudioLayout";
import { VoicePreviewIllustration } from "../components/VoicePreviewIllustration";
import { WorkflowChatPreview } from "../components/WorkflowChatPreview";
import { VoiceCallLive } from "./VoiceCallLive";
import { useLiveKitReady, preloadVoiceEngine } from "../data/liveKitVoice";
import { WorkflowTree, type WorkflowTreeModel, type TreeBranch, type TreePath } from "../components/WorkflowTree";
import { usePageData } from "../components/GeneratedTiles";
import { useAiAssistant } from "../data/AiAssistantContext";
import { AgentWorkflowDetails } from "./AgentWorkflowDetails";
import { bookingSlots } from "../data/voiceBooking";
import { WorkflowNodeDrawer } from "../components/WorkflowNodeDrawer";
import { drawerFor } from "../data/workflowDrawers";
import { SMS_TRIGGER, smsBranches, smsConfigFor, repairSmsSegments } from "../data/smsTemplate";
import { smsDrawerFor } from "../data/workflowDrawers";
import { voiceSpecFor, agentConfigOf } from "../data/voiceAgentSpec";
import { voiceCopy } from "../data/voiceCopy";
import type { VoiceUseCase } from "../data/voiceUseCases";
import { isProspect } from "../data/prospect";
import { smsWorkflowAgentOf } from "../data/smsBrain";
import { useExtraWorkflows } from "../data/quoteWorkflow";

/* Agent Studio → a workflow's Definition (flow diagram). Opened from a workflow
   in the left sub-nav. Template flow (Conversation Start → classify intent →
   Sales / Support branches) with the title derived from the customer + channel. */


/**
 * Use cases -> path nodes.
 *
 * ⚠️ **`collect` IS THE PILLS AND THE PROMPT'S COLLECT LIST, from ONE array.** The pills used
 * to come from `collectNames(actionKind)` — a table keyed by the ACTION — which was fine while
 * every branch collected the same two things and wrong the moment they differ: a cancellation
 * wants a confirmation number, not a ZIP. Reading both from the use case is what stops the
 * diagram advertising a field the agent never asks for.
 *
 * ⚠️ Returns `undefined` rather than `[]` for an empty list, so a leaf with no use cases is
 * byte-identical to one that never had the prop.
 */
function useCaseNodes(cases: VoiceUseCase[], tone: "green" | "orange"): TreePath[] | undefined {
  if (!cases?.length) return undefined;
  return cases.map((u) => ({
    title: u.title,
    action: LEAF_INFORM,
    tone,
    chips: u.collect,
    ...(u.route ? { route: u.route } : {}),
  }));
}

/* THE TREE MODEL, derived per prospect.

   Reproduces exactly what the four hand-built trees rendered, but as DATA, so the
   AI drawer can rename any node, add a branch or remove one and the renderer
   works the layout out (see components/WorkflowTree.tsx). Nothing is persisted in
   the schema and no engine phase is involved, so every prospect already on disk
   gets an editable diagram immediately.

   The National Van Lines two-leaf split used to be a separate 100-line component
   with its own canvas size and connector coordinates. It is now just a branch
   with two leaves, which the layout absorbs — and any prospect can be given the
   same shape by asking the AI for it. */
/* ⚠️ THE SMS TEMPLATE'S NODE NAMES ARE FIXED FOR EVERY PROSPECT, because the real product
   does not let a user rename them (confirmed against the live Agent Management page
   8/24/2026). Two of the four were never at risk — "Triggered by" and "Conversation Start"
   are literals in WorkflowTree.tsx. The INTENT names were being derived from each prospect's
   own routing queues, which is why Shady Blinds showed "Design Consultation" / "Existing
   Order" where the product always shows "Sales Inquiry" / "Need Support".

   ⚠️ AND THEY ARE `locked`, so the AI cannot rename them either. Without that flag the
   assistant would accept "rename this node", write the edit and change nothing — see
   `editGuard.isLockedEdit` for why a refusal beats a silent no-op.

   ⚠️ THE TRIGGER LINE IS THE PRODUCT'S TOO: "0 Campaigns, 0 Forms, and 0 Inbound SMS". Ours
   said "0 campaigns and 0 forms", which is the VOICE wording — it never mentioned SMS on a
   screen whose whole subject is SMS.

   ⚠️ SCOPED TO THE SMS TEMPLATE. The Voice tree's intent nodes still derive from the
   prospect's real queues and carry caller-intent subtitles, because those were measured off
   Invoca's own Voice workflow page. Lock those too only against evidence from that screen. */

/* ⚠️ THE THREE DEFAULT LEAF ACTIONS MOVED TO `workflowChrome.ts` (9/8/2026), ALONGSIDE
   `extraTree`, FOR THE SAME REASON THE INTENT NAMES DID: this screen imports `useProfile`,
   which reaches `profiles.ts` and its Vite-only `import.meta.glob`, so nothing here can be
   imported by `npm run audit:ai` — which is why the extra-workflow checks were reduced to
   GREPPING this file's source. They are the product's own action names, not this screen's.
   Nothing about the values changed in the move. */

/* `isProspect` moved to src/data/prospect.ts when the franchise AI dashboard needed the same
   test. ONE implementation, several callers — see the note at the top of that file. */

/* PER-PROSPECT *SMS* SHAPE OVERRIDES, matched by prospect name.

   ⚠️ THIS TABLE SHRANK when the four node names were locked into the template above. Three
   of the five things that made Comfort Keepers' tree different turned out to be the
   PRODUCT's, not the prospect's — the trigger line, the two intent names and the support
   leaf title — so they moved into the template and every prospect gets them. What is left is
   genuinely this prospect's configuration:
     - the sales action is "Schedule Callback", with a PHONE icon, not "Schedule <bookingTerm>"
     - one chip, "Consumer Name", where the default carries two
   Keeping the whole tree here instead would have frozen a copy of the template that stops
   tracking it — the same drift the SMS brain note warns about. */
const SMS_SHAPE: { prospect: string; tree: () => Pick<WorkflowTreeModel, "triggeredBy" | "branches"> }[] = [
  {
    prospect: "comfort keepers",
    tree: () => ({
      triggeredBy: ZERO_TRIGGER,
      branches: [
        {
          title: INTENT_SALES, icon: "cart", locked: true,
          leaves: [{
            title: `All ${INTENT_SALES} Users`, action: "Schedule Callback",
            tone: "green", actionIcon: "phone", chips: ["Consumer Name"],
          }],
        },
        {
          title: INTENT_SUPPORT, icon: "headset", locked: true,
          leaves: [{
            title: SUPPORT_LEAF, action: "Support & Escalate",
            tone: "orange", warn: true,
          }],
        },
      ],
    }),
  },
];

/* PER-PROSPECT SHAPE OVERRIDES.

   National Van Lines routes a new move to two different teams, which used to be a
   separate 100-line component with its own canvas size and hand-placed connector
   coordinates (VOICE_SPLIT + VoiceFlowTreeSplit). It is now just a branch with two
   leaves, and the computed layout absorbs it — the same shape the AI can now
   produce for any prospect on request.

   Kept as a default rather than dropped, because it was a delivered change: an SE
   opening that demo should still find the tree they were shown. */
const SHAPE: Record<string, (c: ReturnType<typeof voiceCopy>) => TreeBranch[] | null> = {
  "national-van-lines": (c) => [
    {
      /* ⚠️ THE INTENT NAME IS THE TEMPLATE'S, EVEN HERE. This override exists for the
         two-team SPLIT, which is genuinely this prospect's configuration; the node it hangs
         off is the same locked "Sales Inquiry" every other account shows. It used to read
         "Book a Move", which is exactly the drift the SMS note warns about — an override
         that quietly keeps a copy of a template that has since changed. */
      title: INTENT_SALES, icon: "cart", locked: true,
      subtitle: "Caller wants to book a move and is not an existing customer",
      leaves: [
        /* No pills: these are user-group leaves, the row the rule above clears. The split
           itself is what this override exists for. */
        { title: "All Inter-State Users", action: "Route to Inter-State Move (Team A)", tone: "green" },
        { title: "All Local Move Users", action: "Route to Local Move (Team B)", tone: "green" },
      ],
    },
    {
      title: INTENT_SUPPORT, subtitle: c.supSub, icon: "headset", locked: true,
      /* ⚠️ THE SUPPORT PATH IS THE TEMPLATE'S, even in this override. Only the SALES branch
         differs for this prospect (two teams instead of one); this side was still carrying
         `All ${c.supQ} Users` / `Route to ${c.supQueue}` — a copy of the default from before
         the leaf became chrome, which is exactly the drift that shrank the Comfort Keepers
         override. An override should differ only where it genuinely differs. */
      leaves: [{ title: SUPPORT_LEAF, action: LEAF_ESCALATE, tone: "orange", locked: true }],
    },
  ],
};


function deriveTree(
  profile: ReturnType<typeof useProfile>["profile"],
  isSms: boolean,
  channelLabel: string,
): WorkflowTreeModel {
  const c = voiceCopy(profile);

  if (isSms) {
    const smsShaped = SMS_SHAPE.find((o) => isProspect(profile, o.prospect))?.tree();
    if (smsShaped) return { variant: "sms", startLabel: `${channelLabel} · classify intent`,
      ...smsShaped };
    /* ⚠️⚠️ **THE BUILT-IN SMS TREE IS THE MEASURED SIX-ROW TEMPLATE NOW (9/17/2026)**, asked
       for directly with thirteen captures of a real Greenix SMS workflow: "this is the workflow
       i want to replicate for all prospects." What it replaced was a three-row tree ending in
       `Schedule ${bookingTerm}` / Support & Escalate — which was itself measured, off an older
       capture, and is kept nowhere: the new shape IS this page now.

       ⚠️ **SCOPED TO THE BUILT-IN WORKFLOW, ON THE USER'S OWN CALL when asked.** The seven
       authored extra workflows (Orlando Health's five ER trees, Avi & Co - New, the generated
       quote-request ones) keep their own shapes, because those were authored for specific
       scenarios and flattening them onto one template would throw that away. They render
       through `extraTree`, which this does not touch.

       ⚠️ `geo: "smsV2"` is the measured geometry of the real page — 248px nodes on a 296
       column pitch and a 168 row pitch — and is opt-in for exactly the same reason: the extra
       workflows stay on `sms`, which is what they were signed off at. See `workflowRows.ts`. */
    return {
      variant: "sms",
      geo: "smsV2",
      triggeredBy: SMS_TRIGGER,
      startLabel: `${channelLabel} · classify intent`,
      /* Same chrome lock: the trigger line is the product's exact wording, so it was
         inconsistent for the AI to be able to rewrite it while the intents were refused. */
      chromeLocked: true,
      branches: smsBranches(profile),
    };
  }

  const shaped = SHAPE[profile.id]?.(c);
  const spec = voiceSpecFor(profile);
  return {
    variant: "voice",
    triggeredBy: "2 campaigns and 0 forms",
    startLabel: "Voice · classify intent",
    /* Trigger line and Conversation Start are the product's, not the prospect's. */
    chromeLocked: true,
    branches: shaped ?? [
      {
        /* ⚠️ THE VOICE INTENTS ARE THE SAME TWO WORDS THE SMS TEMPLATE USES, and locked for
           the same reason: the real product does not let a user rename them (confirmed
           8/25/2026). They USED to derive from each prospect's own routing queues, which is
           why Shady Blinds read "Design Consultation" / "Existing Order" and AutoNation
           "Test Drive" / "Service Appointment" on a screen that always shows these two.

           ⚠️ THE PROSPECT-SPECIFIC PART MOVED DOWN A ROW, IT DID NOT DISAPPEAR. The queue
           name now lives where it is genuinely configuration — the leaf title and its route
           action — so the diagram still names this prospect's own teams. Only the intent
           label is generic, because in the product it always is. */
        title: INTENT_SALES, subtitle: spec.intent.split("\n")[0], icon: "cart", locked: true,
        /* ⚠️ ONLY THE ROW BELOW THE USER GROUPS CARRIES PILLS (8/26/2026), and they are the
           drawer's own "What To Collect" rather than a second list that happens to look like
           it. They used to be the prospect's vocabulary — "Blinds", "Timeline", "Issue Type" —
           minted per node, so a node advertised collecting one thing while its drawer said
           another. `collectNames` reads the single table in `workflowDrawers`. */
        leaves: [{
          /* ⚠️ THE LEAF IS CHROME TOO (8/26/2026). It read `All ${c.newQ} Users` /
             `Route to ${c.newQueue}` — the prospect's own queue — where the real page always
             shows the user group named after the intent and one of a fixed set of actions.
             So the whole top of the tree down to and including this row is the product's, and
             only the CHIPS below it are configuration.

             ⚠️ CONSEQUENCE, AND IT IS REAL: the diagram no longer contains a destination the
             agent could name aloud. `buildVoiceSystem` therefore stopped reading a group label
             into the spoken handoff — see the note there. */
          title: `All ${INTENT_SALES} Users`,
          action: LEAF_QUALIFY,
          tone: "green",
          locked: true,
          /* ⚠️ QUALIFY ASKS A QUESTION AND ROUTES ON THE ANSWER, so its leaf has one child per
             answer. These titles ARE the Qualify drawer's answers: one list, two renderings,
             so the diagram and the drawer cannot disagree.

             ⚠️ **AS MANY BRANCHES AS THE PROSPECT NEEDS (8/27/2026).** This was a fixed PAIR,
             and the type enforced it — so "add a third use case" was impossible rather than
             merely absent. The row is configuration, not chrome; only the four nodes above it
             are the product's. */
          paths: useCaseNodes(spec.useCases.sales, "green"),
        }],
      },
      {
        title: INTENT_SUPPORT, subtitle: c.supSub, icon: "headset", locked: true,
        leaves: [{
          title: SUPPORT_LEAF,
          action: LEAF_ESCALATE,
          tone: "orange",
          locked: true,
          /* ⚠️ **THE SUPPORT NODE BRANCHES TOO NOW, and this file used to say it must not** —
             "Support & Escalate does not branch; giving it paths would draw a fork the product
             does not have." That was wrong about the product and, more importantly, wrong about
             the demo: an existing customer rings to DO something (change it, cancel it, query a
             charge), each wanting a different reference number and a different team. With no
             branches the agent asked every support caller the same two questions and routed
             them all to one queue.

             ⚠️ A prospect whose spec defines none (Comfort Keepers) still renders NO paths, so
             its diagram is untouched. */
          paths: useCaseNodes(spec.useCases.support, "orange"),
        }],
      },
    ],
  };
}

/* ⚠️ **BOTH GLYPHS ARE EXTRACTED VERBATIM from the capture's own svg paths**, per the
   standing use-the-real-icons rule — not Material ligatures that merely look similar. Read
   off the rendered DOM at 20px with their computed fills: the check is MUI `check_circle` in
   `#2CBF58` (the palette green, NOT the platform's `#0d7a3e`), the undo is MUI `undo` taking
   the disabled ink from `currentColor`. */
function CheckCircle() {
  return (
    <svg className="wf-ic20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8z" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg className="wf-ic20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8" />
    </svg>
  );
}

export function AgentWorkflow() {
  const { profile, profileId } = useProfile();
  /* Includes any workflow created by an LSA quote request submitted during this demo,
     newest first — one definition, so a slug that lists here also resolves elsewhere. */
  const extraWfs = useExtraWorkflows(profile);
  const { channel, id } = useParams();
  const { pathname } = useLocation();
  /* The route param is a slug, not just sms|voice: extra workflows add their
     own (e.g. "sms-nurture"). Resolve those first so they don't fall through to
     the built-in SMS tree. */
  const extra = extraWfs.find((w) => w.slug === channel);
  /* A workflow the SE created with the Create Workflow modal. `/workflow/new/:id` is its
     own route, so `id` is set only here and every other path behaves exactly as before. */
  const { byId } = useAgentWorkflows(profile.id);
  const created = id ? byId(id) : undefined;
  const isSms = created ? created.channel === "SMS"
    : extra ? extra.channel === "SMS" : (channel ?? "sms") !== "voice";
  const channelLabel = created ? created.channel : extra ? extra.channel : isSms ? "SMS" : "Voice";
  const workflowName = created ? created.name
    : extra ? extra.label : `${profile.customerName} - ${channelLabel}`;

  /* The diagram is this page's DATA. Registering it as the AI scope is what lets
     the drawer rename a node, add a branch or remove one; the renderer recomputes
     the layout from whatever it is handed. SMS and Voice are different pathnames,
     so their edits and undo stacks are separate. `title` gives the drawer a real
     scope label. */
  /* ⚠️⚠️ **THE VOICE PAGE REGISTERS THE AGENT'S CONFIG ALONGSIDE ITS DIAGRAM (8/27/2026).**
     Asked for directly: an SE should be able to describe what they want the voice agent to
     do and have Ask AI build the tree AND configure the agent. Only the DIAGRAM was
     registered before, so "greet callers with X" or "only serve these ZIPs" had nowhere to
     land: the model would write the edit, `applyEdits` would find no such path, and the
     drawer reported success while nothing changed. That is the silent no-op this file warns
     about three times over.

     ⚠️ **ONE OBJECT, NOT TWO SCOPES.** `registerScope` is last-write-wins, so a second
     `usePageData` here would repoint this page's sparkle away from the tree and break "add a
     branch" with no visible cause (see the note in `WorkflowChatPreview`). Merging `agent`
     into the SAME registered object also lets ONE instruction return edits to both — which
     is exactly what "tell it what you want the agent to do" needs.

     ⚠️ **EACH FIELD HAS EXACTLY ONE HOME, or the two renderings fight.** Anything the
     diagram DRAWS (intent subtitles, leaf titles, path titles, chips) lives in the tree and
     only there. Anything it CANNOT draw (the greeting, the conversation rules, the ZIP
     allow-list, the routing steps) lives under `agent`. A `segments` copy under `agent` would
     duplicate the path nodes and the first edit to either would desync the diagram from the
     prompt. */
  /* ⚠️ **A CREATED WORKFLOW REGISTERS NO `agent` HALF, and that is deliberate.** The agent
     config belongs to the prospect's CONFIGURED voice agent — greeting, rules, ZIP
     allow-list. Attaching it here would let an SE edit the live agent's greeting from a
     workflow that has no actions, and the Ask AI drawer would promise "Build this voice
     agent" on a page whose whole state is that nothing is built. It gets the tree only, so
     the drawer offers "Change this workflow" instead. */
  const baseAgent = useMemo(
    () => (isSms || extra || created ? null : voiceSpecFor(profile)),
    [isSms, extra, created, profile],
  );
  const baseTree = useMemo(() => ({
    title: `${workflowName} workflow`,
    ...(created ? emptyWorkflowTree(channelLabel)
       : extra ? extraTree(extra)
       : deriveTree(profile, isSms, channelLabel)),
    /* ⚠️⚠️ **A BOOKING WORKFLOW REGISTERS AN AGENT HALF; EVERY OTHER EXTRA WORKFLOW STILL
       DOES NOT.** `baseAgent` is null for extras, which is right for the SMS ones — their
       playbook is their `systemPrompt` and they have no voice config. A booking workflow is
       spoken, so without this the Details tab would correctly report "no agent configured"
       and an SE could not choose its voice or edit its opener. Only the two fields that
       workflow actually owns; the routing spec's ZIP gate and steps deliberately stay out,
       because the booking flow states its own location policy. */
    /* ⚠️⚠️ **AN SMS EXTRA WORKFLOW REGISTERS AN AGENT HALF TOO NOW (9/8/2026), asked for
       directly: "make sure the Ask AI performs the same way the Voice AI workflow does."**
       Before this, `baseAgent` was null for every extra and only the booking branch below
       added one, so on an SMS workflow page Ask AI could reshape the diagram and NOTHING
       else: "open with X" or "confirm the facility before offering anything" had nowhere to
       land, `applyEdits` found no such path, and the drawer reported success. That is the
       silent no-op this file records five times, and it is the same gap the voice page closed
       on 8/27.

       ⚠️ **ONLY THE TWO FIELDS THE DIAGRAM CANNOT DRAW, and `smsWorkflowAgentOf` is the one
       definition of which those are.** The workflow's opener and its ordered flow are
       invisible on the tree and belong to THIS workflow; its rules and questions are the
       prospect's shared agent config, already edited on the Preview Agent page, and giving
       them a second home here is the duplicated-field trap that caused all three of the
       8/27 voice bugs. */
    ...(baseAgent ? { agent: agentConfigOf(baseAgent) }
      : extra?.bookingLocations?.length ? { agent: { greeting: extra.openingMessage ?? "" } }
      : extra && isSms ? { agent: smsWorkflowAgentOf(extra) }
      : {}),
    /* ⚠️⚠️ **THE BUILT-IN SMS WORKFLOW REGISTERS AN `sms` HALF, AND THAT IS WHAT LETS THE
       DRAWERS' Apply ACTUALLY SAVE (9/17/2026).** Asked for directly with the captures: the
       fields are editable and Apply persists. `applyEdits` writes into the object the page
       registers, so a field the drawers edit has to be IN it — otherwise Apply writes a path
       nothing reads and reports success, the silent no-op recorded six times in CLAUDE.md.
       Riding the page's existing scope also hands these edits persistence per demo, an undo
       step, and the `readOnly` refusal on somebody else's demo, all for free.

       ⚠️ **ONLY THE BUILT-IN TREE, and only what the diagram cannot draw.** An authored extra
       workflow has its own `systemPrompt` and its own shape, so it gets none of this; and the
       segment titles are deliberately absent, because those are the child NODES — see the
       note on `SmsConfig`. */
    ...(isSms && !extra && !created ? { sms: smsConfigFor(profile) } : {}),
  }), [created, extra, profile, isSms, channelLabel, workflowName, baseAgent]);
  /* This page's sparkle edits the DIAGRAM, and only the diagram. The SMS agent is a
     different thing living in a different scope, and it has its own sparkle inside
     the Preview Workflow chat. */
  /* ⚠️ THE BUILT-IN SMS TREE ONLY. An authored extra workflow and a freshly created one both
     render an SMS diagram too, and neither is this template: their nodes carry actions with no
     captured drawer. One flag, read by the node-click gate, the drawer builder and Apply, so
     those three can never disagree about which diagram is on screen. */
  const smsTemplated = isSms && !extra && !created;
  const rawTree = usePageData(baseTree);
  /* ⚠️ REPAIRS SEGMENTS WRITTEN BEFORE A NEW ANSWER INHERITED ITS SIBLINGS' ACTION. Read-time,
     identity-preserving, and scoped to the built-in template — see `repairSmsSegments`. */
  const tree = useMemo(
    () => (smsTemplated
      ? { ...rawTree, branches: repairSmsSegments(rawTree.branches ?? []) }
      : rawTree),
    [rawTree, smsTemplated],
  );
  /* ---- The Preview Workflow drawer's OWN Ask AI + undo (the voice side) -------------
     Asked for directly: "just like how the SMS Agent preview workflow has a Ask AI and undo
     button in the preview workflow, do it for the Voice Agent preview workflow as well, and
     have the drawer come in from the right."

     ⚠️⚠️ **IT TARGETS THIS PAGE'S OWN SCOPE, WHICH IS THE ONE REAL DIFFERENCE FROM THE SMS
     PAIR.** `WorkflowChatPreview` has to carry a scope key because the SMS agent's config
     lives on ANOTHER page (Preview Agent) — hence its `registerBase` and its separate undo
     stack. On a voice workflow the agent's config IS this page's data: `baseAgent` is merged
     into the very object registered above, precisely so one instruction can reshape the
     diagram and configure the agent together. So there is nothing to register and nothing to
     synthesise — the key is the page's own, and this pair is a second door onto the scope the
     top-bar sparkle already edits, opened from where an SE is actually looking.
     ⚠️ Undo therefore SHARES the page's stack, which is correct rather than a compromise: one
     scope has one history, and a voice edit reaches the tree and the agent at once, so two
     stacks could undo half of one instruction.
     ⚠️ **AND IT OPENS ON THE LEFT, like the SMS chat's**: this drawer is on the right, so a
     right-hand panel covers the very thing being configured. */
  const { openDrawer, undo, canUndo, readOnly, applyEdits } = useAiAssistant();
  const pageKey = `${profileId}::${pathname}`;
  const smsBase = useMemo(() => smsConfigFor(profile), [profile]);
  /* ⚠️ **GATED ON THE REGISTERED DATA'S SHAPE, NOT THE PATHNAME** — the same signal
     `pageHint` keys its empty state off. A CREATED workflow deliberately registers no `agent`
     half ("Build this voice agent" would be a promise on a page whose whole state is that
     nothing is built), so a sparkle there would offer to change what an agent says when the
     preview it sits in is the minimal greet-classify-hand-off flow. No agent, no pair. */
  const voiceAgentConfigured = !!(tree as { agent?: unknown }).agent;
  /* ⚠️ THE TABS WERE TWO INERT BUTTONS with `active` hardcoded on Definition. Local state
     rather than a route: the real page keeps one URL per workflow, and a query parameter
     would have to be carried by every link that reaches this screen. */
  const [tab, setTab] = useState<"definition" | "details">("definition");
  const [voicePreview, setVoicePreview] = useState(false);
  const [inCall, setInCall] = useState(false);
  const liveKitReady = useLiveKitReady();
  /* Which diagram node has its drawer open, by the id WorkflowTree hands back. */
  const [openNode, setOpenNode] = useState<string | null>(null);
  const closeVoice = () => { setVoicePreview(false); setInCall(false); };
  /* Preview Workflow is channel-specific: Voice slides in the call drawer, SMS
     opens the chat drawer that tests the same agent as the Preview Agent screen.
     Until now the SMS button was inert — it rendered and did nothing. */
  const [smsPreview, setSmsPreview] = useState(false);
  /* Absent for the built-in pages, so their calls behave exactly as before. */
  /* ⚠️ THE GREETING COMES FROM THE EFFECTIVE TREE, NOT THE RAW WORKFLOW, so an opener edited
     on the Details tab is the one the call opens with. Reading `extra.openingMessage` here
     instead would be the same landed-and-ignored shape fixed elsewhere today. */
  const brainOpts = created
    ? { scopePath: pathname, minimal: true }
    : extra?.support
    ? { scopePath: pathname, support: { playbook: extra.support, greeting: (tree as { agent?: { greeting?: string } }).agent?.greeting || extra.openingMessage } }
    : extra?.bookingLocations?.length
    ? {
        scopePath: pathname,
        booking: {
          greeting: (tree as { agent?: { greeting?: string } }).agent?.greeting || extra.openingMessage,
          locations: extra.bookingLocations,
          slots: bookingSlots(profile.id),
        },
      }
    : undefined;

  /* ⚠️⚠️ **THE ROUTE IS GATED, NOT JUST THE SUB-NAV ROW.** With an `:id` that this prospect
     has no workflow for — a pasted or bookmarked link, or a switch to another prospect
     mid-demo — `created` is undefined, `channel` is undefined too, and `isSms` defaults to
     TRUE: measured, opening Marriott's created workflow while AutoNation was active rendered
     a complete, plausible **"Agent Workflow: AutoNation - SMS"**. A page that looks
     legitimate and is not what the URL asked for is exactly the failure the AI-Conversion
     dashboard's note describes ("gating only the row leaves a bookmarked URL rendering a
     full dashboard for whichever prospect is active"), and it is the same silent fall-through
     as the stale-store bug two commits back. It fails closed instead. */
  if (id && !created) {
    return (
      <AgentStudioLayout>
        <div className="wf-top"><h2 className="wf-title">Workflow not found</h2></div>
        <p className="wf-missing">
          This workflow does not belong to {profile.customerName}.{" "}
          <Link to="/agent-studio/agent/workflow/voice">Open the Voice workflow</Link> instead.
        </p>
      </AgentStudioLayout>
    );
  }

  return (
    <AgentStudioLayout>
      <div className="wf-top">
        {/* ⚠️ A CREATED WORKFLOW IS TITLED BY ITS OWN NAME, with no "Agent Workflow:" prefix —
            that is what the capture's h2 reads (20/28 `#15243E`). The two built-in pages keep
            their prefix: dropping it there would change screens nobody asked about, and it is
            flagged for the user rather than done quietly. */}
        <h2 className="wf-title">{created ? workflowName : `Agent Workflow: ${workflowName}`}</h2>
        <div className="wf-top-actions">
          {/* ⚠️ **`Saved` AND `Undo` ARE MEASURED, AND THEY ARE DIFFERENT KINDS OF THING.**
              Comparing the two captures settles it: the disabled `Undo` is on BOTH, so it is
              permanent workflow-page chrome, while `Saved` appears ONLY on the freshly created
              one — a transient state from the create that just happened. Both are rendered on
              this page only; adding `Undo` to the two built-in pages would change them, so
              that is raised separately rather than done here. */}
          {created && (
            <>
              <span className="wf-saved"><CheckCircle />Saved</span>
              <button className="wf-undo" disabled title="Nothing to undo yet">
                <UndoIcon />Undo
              </button>
            </>
          )}
          {isSms && !created && <button className="wf-preview wf-preview-agent" onClick={() => window.open(
            extra ? `/agent-studio/agent/preview?wf=${encodeURIComponent(extra.slug)}`
                  : "/agent-studio/agent/preview",
            "_blank", "noopener")}>Preview Agent</button>}
          {/* ⚠️ **ENABLED, AS MEASURED — and it previews THIS workflow.** It was briefly
              disabled here, because a preview would have run the prospect's CONFIGURED agent
              (ZIP gate, travel dates, six use cases) against a diagram that shows none of it.
              Asked for directly instead: on an empty workflow the agent greets, asks how it
              can help, decides sales or support from the answer, says which, and transfers.
              That IS the four chrome nodes — Conversation Start classifies intent, and the two
              user groups are the destinations — so the preview is honest and the departure
              from the capture is gone. `brainOpts.minimal` builds that flow. */}
          <button className="wf-preview"
            onClick={() => {
              if (isSms) { setSmsPreview(true); return; }
              /* ⚠️ Start the `livekit-client` download NOW rather than on the click that
                 starts the call — the drawer's only content is "start a test call", so this
                 is the earliest honest signal that a call is coming. It warms the CHUNK only;
                 see `preloadVoiceEngine` for why it must not pre-mint a token. */
              preloadVoiceEngine();
              setVoicePreview(true);
            }}>
            Preview Workflow
          </button>
        </div>
      </div>
      {isSms && smsPreview && (
        <WorkflowChatPreview
          workflowName={workflowName}
          wfSlug={extra?.slug}
          /* ⚠️ HANDED DOWN FROM THE EFFECTIVE TREE, not re-read from the raw workflow. This
             drawer must never call `usePageData` (a second registration would repoint this
             page's sparkle from the diagram to the agent), and the page has already resolved
             the override — so passing it is both correct and cheaper than a second lookup.
             Without it, an opener changed by Ask AI on this very page would leave the chat
             still greeting with the authored line. */
          wfAgent={(tree as { agent?: { greeting?: string; steps?: string[] } }).agent}
          minimal={!!created}
          onClose={() => setSmsPreview(false)}
        />
      )}
      {!isSms && voicePreview && (
        <div className="vp-root">
          <div className="vp-backdrop" onClick={closeVoice} />
          <div className="vp-drawer" role="dialog" aria-modal="true">
            <div className="vp-head">
              <span className="vp-title">Preview: {workflowName} (Draft)</span>
              <div className="vp-actions">
                {/* Hidden until the header is hovered, like the SMS chat's pair: close is
                    part of the captured drawer, these two are OURS, and at rest the replica
                    should still read as the capture.
                    ⚠️ `side: "left"`, the same as the SMS chat's — asked for directly. The
                    drawer being edited sits on the RIGHT, so a right-hand panel lands on top
                    of it and its backdrop dims and blocks it; on the left it sits beside the
                    preview with no backdrop, and only the panel takes clicks. */}
                {voiceAgentConfigured && (
                  <>
                    <button
                      className="vp-icon vp-icon-ai vp-icon-hover"
                      onClick={() => openDrawer({ scope: "agent", key: pageKey,
                                                  label: `${profile.customerName} voice agent`,
                                                  side: "left" })}
                      title="Ask AI - change what this agent says and does"
                      aria-label="Ask AI to change what this agent says and does"
                    >
                      <span className="material-icons">auto_awesome</span>
                    </button>
                    <button
                      className={"vp-icon vp-icon-hover" + (canUndo(pageKey) && !readOnly ? "" : " vp-icon-off")}
                      onClick={() => canUndo(pageKey) && !readOnly && undo(pageKey)}
                      disabled={!canUndo(pageKey) || readOnly}
                      title={canUndo(pageKey) && !readOnly ? "Undo the last AI change to this agent" : "Nothing to undo"}
                      aria-label="Undo the last AI change to this agent"
                    >
                      <span className="material-icons">undo</span>
                    </button>
                  </>
                )}
                <button className="vp-close" onClick={closeVoice} aria-label="Close preview"><span className="material-icons">close</span></button>
              </div>
            </div>
            {inCall ? (
              /* ⚠️⚠️ **LIVEKIT IS THE ONLY ENGINE NOW (9/3/2026).** This used to fall back to
                 the browser-speech engine when LiveKit was unconfigured. That engine's mouth
                 was Deepgram or ElevenLabs through `/api/tts`, and both vendors were removed
                 on request — so the fallback would have spoken in the robotic browser voice,
                 which is worse for a demo than an honest refusal.
                 ⚠️ **THE SCOPE PATH IS THIS PAGE'S, NOT THE BUILT-IN VOICE PAGE'S.** `useBrain`
                 hardcoded `VOICE_WORKFLOW_SCOPE_PATH`, so without this a call started here
                 would read the CONFIGURED tree and preview a diagram the SE is not looking
                 at — the same wrong-surface bug as reading the profile instead of the page. */
              liveKitReady
                ? <VoiceCallLive onEnd={() => setInCall(false)} brainOpts={brainOpts} />
                : (
                  <div className="vp-body">
                    <VoicePreviewIllustration />
                    <h3 className="vp-h">Voice calls are not configured here</h3>
                    <p className="vp-sub">
                      The voice agent runs on LiveKit, and this server has no LiveKit
                      credentials. Add LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET to
                      enable live test calls.
                    </p>
                  </div>
                )
            ) : (
              <div className="vp-body">
                <VoicePreviewIllustration />
                <h3 className="vp-h">Preview Your Voice Agent</h3>
                <p className="vp-sub">Start a live test call to speak to your agent as you configure and iterate.</p>
                <button className="vp-startcall" onClick={() => setInCall(true)}><span className="material-icons">call</span>Start Call</button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="wf-tabs">
        <button
          className={"wf-tab" + (tab === "definition" ? " active" : "")}
          onClick={() => setTab("definition")}
        >Definition</button>
        <button
          className={"wf-tab" + (tab === "details" ? " active" : "")}
          onClick={() => setTab("details")}
        >Details</button>
      </div>

      {tab === "details" ? (
        /* ⚠️ THE SCOPE KEY IS BUILT THE SAME WAY `usePageData` BUILDS IT (profileId ::
           pathname), because the voice and greeting written here have to land on the very
           override this page reads back through `tree`. A different key would store the
           choice under a page nobody is looking at — the hardcoded-destination bug the Add
           Tile flow already paid for. */
        <AgentWorkflowDetails
          scopeKey={`${profileId}::${pathname}`}
          isSms={isSms}
          agent={(tree as { agent?: { voice?: string; greeting?: string } }).agent}
          triggeredBy={tree.triggeredBy}
        />
      ) : (
      <>

      <div className="wf-toolbar">
        <div className="wf-viewtoggle">
          <button className="wf-view active"><span className="material-icons">chevron_left</span>Flow view</button>
          <button className="wf-view"><span className="material-icons">table_chart</span>Table view</button>
        </div>
      </div>

      {/* ⚠️⚠️ **THE DECORATIVE MINIMAP SITS ON THE LAST NODE OF A FOUR-COLUMN SMS TREE, and it
          is the SAME defect the voice canvas already hides it for (9/8/2026).** Measured on
          this page at 1440x1000: `sms-er-new-vs-existing` (4 use cases) puts "Clinical or
          Emotional Reply" and its action text underneath the minimap's box, while a 3-use-case
          tree clears it. So it has been true since 9/2 for Avi & Co's `sms-new` and Reyes Law's
          `sms-nurture`, both of which carry four branches; these workflows are the third and
          fourth to hit it.

          ⚠️ **THE CONDITION IS THE FOURTH ROW, NOT A COLUMN COUNT.** `app.css` already hides
          this element on the voice canvas with the note "Voice tree is taller, so it doesn't
          overlap the leaves", and a use-case row is exactly what makes an SMS tree that tall.
          Keying off a column threshold instead would put a hardcoded geometry number back into
          the code this component exists to compute.

          ⚠️ **NO OTHER DIAGRAM CHANGES, and that is the reason for the narrow test.** The
          built-in SMS tree, the Comfort Keepers override and a created workflow all have
          leaves with no `paths`, so none of them gets the class. */}
      <div className={"wf-canvas" + (isSms
        ? (tree.branches.some((b) => b.leaves.some((l) => l.paths?.length)) ? " wf-canvas-tall" : "")
        : " wf-canvas-voice")}>
        {/* ⚠️⚠️ **THE SMS CAPTURE ARRIVED, SO THIS IS CLICKABLE NOW (9/17/2026)** — twelve of
              them, one per node. The note this replaces said exactly that: "give me an SMS
              capture and this becomes `onNode={setOpenNode}` unconditionally." It is still not
              quite unconditional, and the reason is the same one it was gated for originally:
              an AUTHORED extra workflow's leaves carry actions with no captured drawer ("Book
              Appointment", "Refer to Primary Care"), so they would fall through to a drawer
              confidently naming the wrong action. The built-in template's nodes all map to a
              captured drawer, so those open; an extra workflow's still do not. */}
            <WorkflowTree model={tree} onNode={smsTemplated || !isSms ? setOpenNode : undefined} />
        {/* ⚠️ THE DRAWER IS RESOLVED FROM THE EFFECTIVE TREE, so a node the AI renamed opens a
            drawer naming the same thing. `drawerFor` returns null for a node the real page has
            no drawer for — Conversation Start — and nothing opens rather than an empty panel. */}
        {(() => {
          const d = !openNode ? null
            /* ⚠️⚠️ **THE EFFECTIVE CONFIG, NOT THE BASE — and reading the base here would have
               been a silent no-op of exactly the kind this feature exists to avoid.** `tree` is
               what `usePageData` returns, so its `sms` half already carries every Apply and every
               Ask AI edit; `smsBase` is the template's untouched defaults. Hand the drawer the
               base and it opens showing the pre-edit text, Apply then writes that stale copy
               back, and an edit made a minute ago is silently undone. Same trap `drawerFor`
               records for the voice spec. */
            /* ⚠️ THE BASE IS SPREAD UNDER THE STORED CONFIG, not just used when it is missing.
               A demo whose override was saved before a field existed would otherwise hand the
               drawer a config with that key absent — which is exactly how a click on an added
               segment threw and took the whole diagram down with it. Shallow is enough: every
               key of `SmsConfig` is replaced wholesale when it is edited, never half-written. */
            : smsTemplated ? smsDrawerFor(profile, tree, openNode,
                { ...smsBase, ...((tree as { sms?: Partial<typeof smsBase> }).sms ?? {}) })
            : drawerFor(profile, tree, openNode);
          return d ? (
            <WorkflowNodeDrawer d={d} onClose={() => setOpenNode(null)}
              /* ⚠️ APPLY WRITES THROUGH `applyEdits` INTO THIS PAGE'S OWN SCOPE, which is what
                 gives a drawer edit persistence per demo, an undo step on the page's stack, and
                 the refusal on somebody else's demo — none of which a bespoke writer would get.
                 ⚠️ **THE VOICE WORKFLOW WAS ADDED 9/21/2026, ON REQUEST** — its drawers were
                 read-only because nobody had asked, not because they could not write: the page
                 has registered its `agent` half beside the tree since 8/27, which is how Ask AI
                 already configures that agent. So the write targets existed and only the
                 drawers' `edits` paths were missing.
                 ⚠️ STILL ABSENT for an authored extra workflow and a created one: neither has a
                 config slot for a node the template never made, so an edit there would have
                 nowhere to land. */
              onApply={smsTemplated || (!isSms && !created) ? (es) => {
                applyEdits(pageKey, es.map((e) => ({ path: e.path, value: JSON.stringify(e.value) })));
              } : undefined} />
          ) : null;
        })()}

        {/* The zoom cluster is rendered by WorkflowTree, which owns the scale. */}

        <div className="wf-minimap">
          <span className="wf-mini-node" style={{ top: 10, left: 40 }} />
          <span className="wf-mini-node" style={{ top: 34, left: 34 }} />
          <span className="wf-mini-node" style={{ top: 58, left: 18 }} />
          <span className="wf-mini-node" style={{ top: 58, left: 60 }} />
        </div>
      </div>
      </>
      )}
    </AgentStudioLayout>
  );
}
