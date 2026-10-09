import type { TreeBranch, TreeLeaf, TreePath } from "../components/WorkflowTree";
import type { CustomerProfile } from "./schema";
import { fallbackSupportPlaybook } from "./supportPlaybook";
import { INTENT_SALES, INTENT_SUPPORT, SUPPORT_LEAF, LEAF_QUALIFY, LEAF_ESCALATE } from "./workflowChrome";

/* =============================================================================
   smsTemplate.ts — the built-in SMS workflow, for every prospect
   -----------------------------------------------------------------------------
   Asked for directly (9/17/2026), with thirteen SingleFile captures of a real Greenix SMS
   workflow attached: "this is the workflow i want to replicate for all prospects."

   Everything here is MEASURED or DERIVED from those captures, which live beside this file in
   `reference/agent-workflow/sms-*.html`:

     sms-tree.html                    the whole diagram: node types, positions, chips
     sms-drawer-trigger.html          "Triggered by"
     sms-drawer-intent-{sales,support}.html
     sms-drawer-qualify-{new-vs-existing,zip,phone}.html
     sms-drawer-inform-{serviceable-true,serviceable-false,found-true,found-false}.html
     sms-drawer-escalate.html
     sms-drawer-qualify-empty.html    the EDITABLE state: white fields, an Add button, Cancel/Apply

   ⚠️⚠️ **THE SHAPE IS THE PRODUCT'S; THE WORDS ARE THE PROSPECT'S.** The captured tree is
   three levels deep below each intent, and the product's own react-flow node types say why:
   every node under an intent is a `segment`, whether it is "All Sales Inquiry Users", "New
   Customer, No" or "Serviceable=true". So the structure below is reproduced exactly — a
   new-versus-existing question, then a serviceability check on one side and an account lookup
   on the other — while every noun, every number and every instruction is re-skinned from this
   prospect's own profile. Greenix's pest lists, its two real support numbers and its MCP tool
   names are all gone; see the notes at each of them.

   ⚠️ **DERIVED, NOT GENERATED.** No schema slice and no engine phase, so all 145 profiles on
   disk get this diagram immediately and generation time is unchanged — the same call
   `workflowDrawers`, `LocationComparisonDashboard` and the voice tree itself already make.

   ⚠️ **ONE SOURCE FOR THE DIAGRAM AND THE DRAWERS.** The node titles ARE the Qualify drawer's
   Answers/Segments and the chips ARE its What To Collect list. This file builds both from the
   same values, because two copies disagree the first time either is tuned and the symptom is
   the worst kind: the diagram says one thing, the drawer says another, and nothing fails. That
   lesson is recorded four times in CLAUDE.md.
   ============================================================================= */

/* ⚠️⚠️ **THE CHROME NAMES COME FROM `workflowChrome.ts`, NOT A SECOND COPY HERE.** The first
   version of this file declared its own `SMS_INTENT_SALES = "Sales Inquiry"` and friends, and
   `audit:ai` caught it immediately — three checks that pin those four boxes as locked chrome
   read the shared constants, so a template naming them itself is a tree "naming its own" and
   the lock could drift silently. Same reason this repo has one `isProspect`, one `leadSlug` and
   one `voiceCopy`. Only the names the captures add that did not exist yet are declared below. */
export { INTENT_SALES as SMS_INTENT_SALES, INTENT_SUPPORT as SMS_INTENT_SUPPORT,
  SUPPORT_LEAF as SMS_SUPPORT_LEAF, LEAF_QUALIFY as ACT_QUALIFY,
  LEAF_ESCALATE as ACT_ESCALATE } from "./workflowChrome";

/** The sales user group, and the Inform action as this page spells it. */
export const SMS_SALES_LEAF = `All ${INTENT_SALES} Users`;
/* ⚠️ "Inform", NOT `LEAF_INFORM`'s "Inform & Route". Measured on all four Inform leaves in
   sms-tree.html: the SMS page's action line reads the single word. The voice page's reads
   "Inform & Route", which is what that constant is for, so the two stay separate. */
export const ACT_INFORM = "Inform";

/* ⚠️ THE CONDITION LABELS ARE VERBATIM, INCLUDING THEIR UNEVEN SPACING. The capture reads
   `found= true` and `found = false` — one space before the equals on one and after it on the
   other. That is what the SE typed, it is what the product draws, and tidying it would be the
   replica drifting from the thing it replicates. Left exactly as measured. */
export const SEG_SERVICEABLE_YES = "Serviceable=true";
export const SEG_SERVICEABLE_NO = "Serviceable=false";
export const SEG_FOUND_YES = "found= true";
export const SEG_FOUND_NO = "found = false";

/** One row of a What To Collect list: the chip, and the italic line under it in the drawer. */
export interface CollectItem { name: string; help: string }

/**
 * A demo phone number for this prospect.
 *
 * ⚠️ **555 IS RESERVED FOR FICTION.** The captures carry Greenix's two real support numbers
 * (844-233-7378 and 833-729-4353). Shipping either would put a real company's switchboard on
 * 145 prospects' screens, so the number is rebuilt on the prospect's own area code with the
 * reserved exchange — it reads local and cannot connect. Same rule as the Google Search ad's
 * call extension and `workflowDrawers.demoPhone`.
 */
function demoPhone(p: CustomerProfile): string {
  const area = (p.reports.voiceScreenpop?.callerPhone ?? "").match(/(\d{3})/)?.[1] ?? "805";
  return `${area}-555-0142`;
}

/** The prospect's own product-category dimension, which is what a caller asks about. */
function categoryLabel(p: CustomerProfile): string {
  const b = p.reports.marketingDashboard.breakdowns.find((x) => /Product Category/i.test(x.title));
  return b?.dimensionColumn?.trim() || "Product Category";
}

/**
 * The collect pool, re-skinned.
 *
 * ⚠️⚠️ **GREENIX'S TEN FIELDS ARE NOT ALL PORTABLE, AND TWO WERE DROPPED RATHER THAN
 * TRANSLATED.** "Pest Types" carries a pest-control meaning no other vertical has, and
 * "Property Type"/"Business Type" are a residential-versus-commercial split that reads wrong
 * for a hospital or a hotel. Inventing a per-vertical equivalent for each would be minting
 * field names the product does not have — the refusal this repo already makes for ZIP3
 * guesses and fabricated accreditations. What survives is either platform chrome (the two
 * names, Lead Score, Disposition) or genuinely derived from the prospect (the category, the
 * customer noun), so every entry reads correctly on all 145 profiles.
 */
export function collectPool(p: CustomerProfile): Record<string, CollectItem> {
  const noun = p.customerNoun;
  const cat = categoryLabel(p);
  return {
    first: { name: "Consumer First Name", help: "The first name of the caller." },
    last: { name: "Consumer Last Name", help: "The last name of the caller." },
    category: { name: cat, help: `What the caller needs help with, matched against ${p.customerName}'s own catalogue.` },
    zip: { name: "Serviceable Zip", help: `Consumer's zipcode is serviceable by ${p.customerName}.` },
    score: { name: "Lead Score", help: "Derived qualification outcome based on zip serviceability and catalogue coverage." },
    isNew: { name: `New ${noun}`, help: `The caller is a new ${noun.toLowerCase()} with ${p.customerName}.` },
    isExisting: { name: `Existing ${noun}`, help: `The caller is an existing ${noun.toLowerCase()} with ${p.customerName}.` },
    /* ⚠️ THE ENUM IS SHORTENED, NOT COPIED. Greenix's list carries `spam_drop`, two
       space-separated values and a parenthetical about not translating one of them — that
       account's own operational vocabulary. These four are the outcomes this template's own
       four leaves can actually produce, so the field cannot describe a branch that is not drawn. */
    disposition: { name: "Disposition", help: "The conversation outcome. Exactly one of: qualified_lead, existing_customer, geo_disqualified, no_account_match." },
  };
}

/* ⚠️ THE PER-LEAF ORDER IS THE CAPTURE'S. Each Inform leaf lists the same pool in its own
   order, leading with the two fields that matter on that branch — which is what makes the four
   nodes' visible chips differ (the node shows four, then `...`). Measured per leaf:
     Serviceable=true   first, last, Pest Types, Serviceable Zip, ...
     Serviceable=false  first, last, Property Type, Business Type, ...
     found= true        first, last, Serviceable Zip, Existing Customer, ...
     found = false      no collect list at all */
const ORDER = {
  serviceableYes: ["first", "last", "category", "zip", "score", "isNew", "isExisting", "disposition"],
  serviceableNo: ["first", "last", "zip", "category", "isNew", "isExisting", "disposition"],
  foundYes: ["first", "last", "zip", "isExisting", "isNew", "category", "score", "disposition"],
  foundNo: [] as string[],
} as const;

const listOf = (p: CustomerProfile, keys: readonly string[]): CollectItem[] => {
  const pool = collectPool(p);
  return keys.map((k) => pool[k]).filter(Boolean);
};
/** The four Inform leaves, as the collect pool orders them. */
export type SmsCollectKey = keyof typeof ORDER;
export const collectFor = (p: CustomerProfile, which: SmsCollectKey): CollectItem[] =>
  listOf(p, ORDER[which]);

/* ---- what each node's drawer says ------------------------------------------
   Kept beside the tree rather than in `workflowDrawers.ts` so the segment titles, the chips and
   the instructions are built once from one prospect. */

export interface SmsQualifyCopy { question: string; segments: string[]; fallback: string }

export function qualifyCopy(p: CustomerProfile): Record<"root" | "newSide" | "existingSide", SmsQualifyCopy> {
  const noun = p.customerNoun;
  const lower = noun.toLowerCase();
  return {
    root: {
      question: `Are you a new or existing ${p.customerName} ${lower}?`,
      segments: [`New ${noun}, Yes`, `Existing ${noun}, Yes`],
      fallback: `Sorry, I didn't quite catch that. Are you a new ${lower} or do you already have ${p.customerName} service?`,
    },
    newSide: {
      question: "To check we are in your area, may I get your zip code?",
      segments: [SEG_SERVICEABLE_YES, SEG_SERVICEABLE_NO],
      /* ⚠️ **THE MCP TOOL NAMES ARE DELIBERATELY GONE**, on the user's own call when asked.
         The capture instructs the agent to call `greenix_check_zip_serviceable_greenhl` and
         `greenix_check_pest_serviceable_greenh`; those are that account's own configured
         integrations, and a `<slug>_check_zip_serviceable` on 145 prospects would be inventing
         an integration none of them has. The INSTRUCTION survives in plain English, which is
         what the field is for. */
      fallback: `Check the zip code against the service area before telling the consumer they are covered. `
        + `Set ${SEG_SERVICEABLE_YES} only once the zip code is confirmed inside it, and ${SEG_SERVICEABLE_NO} otherwise. `
        + `Do not decide either way before you have the zip code.`,
    },
    existingSide: {
      question: "What's the phone number tied to your account?",
      segments: [SEG_FOUND_YES, SEG_FOUND_NO],
      fallback: `Look the consumer up by the phone number they gave. Set ${SEG_FOUND_YES} only if an account comes back, `
        + `and ${SEG_FOUND_NO} if none does. Do not decide before the lookup has answered.`,
    },
  };
}

export function informCopy(p: CustomerProfile): Record<"serviceableYes" | "serviceableNo" | "foundYes" | "foundNo", string> {
  const phone = demoPhone(p);
  return {
    serviceableYes: [
      `Ask for the consumer's full name once and split it into first and last yourself. Only ask a follow-up if they gave a single name.`,
      `Ask for the consumer's best phone number so a ${p.customerName} team member can follow up with details.`,
      `Never answer coverage or availability from memory — those verdicts come only from the confirmed status above.`,
      `The lead and its data are submitted automatically once everything is collected — never claim you submitted or processed anything yourself.`,
      `Before the lead exists, never hint at submitting, connecting or putting anything through. If the consumer asks whether you have submitted anything, do not answer with a promise.`,
      `In your final turn, let them know a ${p.customerName} team member will be following up with details shortly. Thank them warmly for their interest and close the conversation.`,
    ].join("\n"),
    serviceableNo: [
      `Let the consumer know that ${p.customerName} does not currently serve their area, and thank them for getting in touch.`,
      `Do not offer a ${p.bookingTerm.toLowerCase()}, a date or a callback, and do not take payment details.`,
      `If they would like to check again later, share ${phone} so they can call directly.`,
    ].join("\n"),
    foundYes: [
      `Confirm you have found the account without reading back any details the consumer did not give you.`,
      `Ask what they need help with today and capture it in their own words.`,
      `Never promise a specific ${p.bookingTerm.toLowerCase()} date, arrival window or same-day availability.`,
      `In your final turn, let them know a ${p.customerName} team member will follow up shortly and close the conversation.`,
    ].join("\n"),
    foundNo: [
      `Let the consumer know that a ${p.customerName} team member was not able to locate an account associated with their information.`,
      `Ask them whether there is another number associated with the account.`,
      `Let them know the ${p.customerName} team can help locate it, and share ${phone} for them to call directly.`,
    ].join("\n"),
  };
}

/**
 * Everything the drawers edit, and everything the diagram is drawn from.
 *
 * ⚠️⚠️ **ONE OBJECT, BECAUSE APPLY HAS TO SAVE (9/17/2026).** Asked for directly: the fields
 * are editable, `Add` really adds, and Apply persists. That only works if the drawer's fields
 * are part of the object the PAGE registers as its Ask AI scope — `applyEdits` writes into that
 * store, which is what gives these edits persistence per demo, an undo step and the `readOnly`
 * check on somebody else's demo for free. Deriving the drawer copy separately would mean Apply
 * writing somewhere nothing reads, which is the silent no-op this repo has been bitten by six
 * times.
 *
 * ⚠️ **AND THE TREE IS BUILT FROM THE SAME OBJECT**, which is what makes `Add` visible: a
 * Qualify node's `segments` ARE its child nodes' titles, exactly as the capture shows, so
 * appending one grows the diagram rather than editing a list nobody draws.
 */
export interface SmsConfig {
  /* ⚠️⚠️ **NO `segments` HERE, AND THAT IS THE IMPORTANT PART.** A Qualify node's answers ARE
     the child nodes on the row below, so they already have a home — the tree — and
     `workflowDrawers` has read them from it since 8/27 with the note that says why: "the
     diagram draws these as nodes on the row below, so two derivations disagree the first time
     anybody edits one." Registering them a second time here would be the duplicated-field trap
     behind all three of the 8/27 voice bugs, and worse, Ask AI would happily write to the copy
     nobody draws. `Add` therefore appends to the TREE, which is what makes a new answer appear
     as a node. Only the fields the diagram cannot draw live in this object. */
  qualify: Record<SmsQualifyNode, { question: string; fallback: string }>;
  inform: { serviceableYes: string; serviceableNo: string; foundYes: string; foundNo: string };
  escalate: string;
  intents: {
    sales: { looksLike: string; rules: string[] };
    support: { looksLike: string; rules: string[] };
  };
  /**
   * The text fields of segments an SE has ADDED, which the template knows nothing about.
   *
   * ⚠️⚠️ **FLAT KEYS DIRECTLY ON `sms`, AND THE NESTING IS WHAT MADE THE FIRST ATTEMPT A SILENT
   * NO-OP.** `setByPath` refuses a path whose INTERMEDIATE key is missing ("bad path → no-op",
   * deliberately, so the model cannot invent paths) and only ever creates the LAST segment. A
   * demo that already carries an SMS override has `sms` but no `sms.extra`, so every write to
   * `sms.extra.<id>__question` walked into a missing `extra` and vanished — no error, no refusal
   * warning, Apply reporting success. Measured on the reported demo.
   *
   * One level down from a key that always exists is the only reliable target, so these live on
   * `sms` itself as `extra__<nodeId>__<field>`.
   *
   * ⚠️ **THE GENERAL RULE, worth more than this field:** a new field on an object that screens
   * already have overrides for must sit at a path whose parents are all present in those stored
   * overrides, or writes to it are silently lost on exactly the demos people have been using.
   *
   * ⚠️ **NODE IDS ARE POSITIONAL**, so deleting an answer shifts the ids after it and their text
   * would follow the wrong node. Acceptable while only ADDED answers use this and the template's
   * own three Qualify nodes are at fixed positions; it is the reason to key on something stable
   * if segments ever become reorderable.
   */
  [extra: `extra__${string}`]: string | undefined;
}

export type SmsQualifyNode = "root" | "newSide" | "existingSide";

/** The template's own defaults for this prospect — the base the override store sits on top of. */
export function smsConfigFor(p: CustomerProfile): SmsConfig {
  const i = intentCopy(p);
  const q = qualifyCopy(p);
  const ask = (k: SmsQualifyNode) => ({ question: q[k].question, fallback: q[k].fallback });
  return {
    qualify: { root: ask("root"), newSide: ask("newSide"), existingSide: ask("existingSide") },
    inform: informCopy(p),
    escalate: escalateCopy(p),
    intents: { sales: { looksLike: i.sales.looksLike, rules: [...i.sales.rules] },
      support: { looksLike: i.support.looksLike, rules: [...i.support.rules] } },
  };
}

/** The two intents' own descriptions and rules, for the Intent Details drawer. */
export function intentCopy(p: CustomerProfile) {
  const noun = p.customerNoun.toLowerCase();
  const rules = p.reports.agentConfig?.brandConversationRules ?? [];
  return {
    sales: {
      looksLike: `The consumer is a prospective ${noun} interested in starting ${p.customerName} service, `
        + `or an existing ${noun} who wants to add or upgrade what they already have.\n\n`
        + `They are NOT: existing ${noun}s with billing questions, scheduling issues, complaints about current `
        + `service, status requests, cancellation requests or account management needs — those consumers belong in ${INTENT_SUPPORT}.`,
      /* ⚠️ THE RULES ARE THE PROSPECT'S OWN `brandConversationRules`, not a second list. That
         is the SMS sales playbook the Preview Agent screen edits and `buildSmsBrain` sends to
         the model, so this drawer and the agent cannot describe different rules. */
      rules,
    },
    support: {
      looksLike: `The consumer is an existing ${p.customerName} ${noun} reaching out about their current account `
        + `or service. They may need to reschedule, ask about billing or payments, report a concern, change or `
        + `cancel their plan, or check on status. They may be messaging from a recognised or unrecognised number.\n\n`
        + `They are NOT: prospective ${noun}s who want to start new ${p.customerName} service, or existing `
        + `${noun}s looking to add or upgrade — those consumers belong in ${INTENT_SALES}.`,
      /* ⚠️ THE SUPPORT INTENT SHIPS WITH NO RULES, rather than inventing support policy nobody
         configured. The drawer renders the product's own empty state for that. */
      rules: [] as string[],
    },
  };
}

/** How the agent should handle an escalation, for the Support & Escalate drawer. */
export const escalateCopy = (p: CustomerProfile): string => [
  `Attempt to resolve the consumer's issue using available knowledge and account information.`,
  `Escalate immediately if the consumer expresses frustration or dissatisfaction, asks to speak with a person `
  + `or supervisor, raises a billing dispute, requests a cancellation or refund, reports a problem that recurred `
  + `after recent service, or has an issue that cannot be resolved in this conversation.`,
  `When escalating, let the consumer know you are handing them to a ${p.customerName} support specialist and `
  + `direct them to call ${demoPhone(p)}.`,
].join("\n");

/* ⚠️ THE TRIGGER LINE IS THE CAPTURE'S, and it is NOT the old all-zero one. `ZERO_TRIGGER`
   reads "0 Campaigns, 0 Forms, and 0 Inbound SMS" — right for a workflow nobody has wired,
   which is what it was written for. A LIVE SMS workflow has an inbound number and the forms
   that hand off to it, and the capture reads exactly this. */
export const SMS_TRIGGER = "0 Campaigns, 2 Forms, and 1 Inbound SMS";

/**
 * The Need Support side below "All Support Users": the same Qualify shape as the sales side (a
 * Qualify node, two forks, an Inform under each), with the prospect's own support scenarios as the
 * terminals plus a person to hand to. The agent behind it assumes access to the customer's systems
 * (billing, records, scheduling, ticketing) and resolves from what it finds; see
 * `engine/supportPrompt.ts`. The titles come from the SAME deterministic playbook the customer demo
 * is built from, so the diagram and the agent name the same scenarios.
 */
function supportPaths(
  p: CustomerProfile,
  forked: (title: string, kids: TreePath[]) => TreePath,
  leaf: (title: string) => TreePath,
): TreePath[] {
  const t = fallbackSupportPlaybook(p).scenarios.map((x) => x.title);
  return [
    forked("Billing and plan", [leaf(t[0] ?? "Billing question"), leaf(t[1] ?? "Cancel or change my service")]),
    forked("Booking and account", [leaf(t[2] ?? "Problem with my booking"), leaf(t[3] ?? "Account or contact details")]),
    { title: "Needs a person", action: LEAF_ESCALATE, actionIcon: "headsetMic", tone: "orange", actionKind: "escalate",
      chips: ["Live agent", "Callback"] },
  ];
}

/**
 * The built-in SMS workflow's branches, for any prospect.
 *
 * ⚠️ Everything down to and including the two user-group leaves is `locked` product chrome, the
 * same rule the voice tree follows: the real page does not let a user rename those four boxes,
 * so `editGuard.isLockedEdit` must refuse a write rather than letting the AI write a field the
 * renderer ignores. The segments BELOW them are configuration and stay editable.
 */
export function smsBranches(p: CustomerProfile): TreeBranch[] {
  const q = qualifyCopy(p);
  const chips = (which: keyof typeof ORDER) => collectFor(p, which).map((c) => c.name);

  /* ⚠️ A SEGMENT LIST OF ANY LENGTH DRAWS, which is the whole point of `Add`. The captured tree
     has exactly two answers on each of its three Qualify nodes, and hardcoding that pair would
     make a third segment a stored value nobody renders. The two leading answers keep their own
     forks (that is the captured shape); anything an SE adds beyond them draws as a terminal,
     because there is nothing configured under it yet. */
  const informLeaf = (title: string, which: keyof typeof ORDER): TreePath => ({
    title, action: ACT_INFORM, actionIcon: "info", tone: "blue", actionKind: "inform",
    ...(ORDER[which].length ? { chips: chips(which) } : {}),
  });
  const extra = (titles: string[], from: number): TreePath[] =>
    titles.slice(from).map((t) => ({ title: t, action: ACT_INFORM, actionIcon: "info",
      tone: "blue" as const, actionKind: "inform" as const }));

  const forked = (title: string, kids: TreePath[]): TreePath => ({
    title, action: LEAF_QUALIFY, actionIcon: "callSplit", tone: "blue", actionKind: "qualify", paths: kids,
  });

  const newSide = [
    informLeaf(q.newSide.segments[0] ?? SEG_SERVICEABLE_YES, "serviceableYes"),
    informLeaf(q.newSide.segments[1] ?? SEG_SERVICEABLE_NO, "serviceableNo"),
    ...extra(q.newSide.segments, 2),
  ];
  /* ⚠️ NO CHIPS ON `found = false`, AS MEASURED — its drawer carries no What To Collect list at
     all, so the node draws none. An invented list would be the diagram advertising a collection
     the drawer does not describe, which is the exact disagreement this file exists to prevent. */
  const existingSide = [
    informLeaf(q.existingSide.segments[0] ?? SEG_FOUND_YES, "foundYes"),
    informLeaf(q.existingSide.segments[1] ?? SEG_FOUND_NO, "foundNo"),
    ...extra(q.existingSide.segments, 2),
  ];

  /* The support side's terminals carry no collect list from the sales table: what the agent does
     there is look the account up, which is a lookup, not something the consumer is asked for. */
  const informLeafPlain = (title: string): TreePath => ({
    title, action: ACT_INFORM, actionIcon: "info", tone: "blue", actionKind: "inform", chips: ["Account lookup"],
  });

  const sales: TreeLeaf = {
    title: SMS_SALES_LEAF, action: LEAF_QUALIFY, actionIcon: "callSplit", locked: true,
    tone: "blue", actionKind: "qualify",
    paths: [
      forked(q.root.segments[0] ?? "New, No", newSide),
      forked(q.root.segments[1] ?? "Existing, Yes", existingSide),
      ...extra(q.root.segments, 2),
    ],
  };

  /* ⚠️⚠️ **THE INTENT NODES CARRY THEIR DESCRIPTION, AND IT IS THE SAME STRING THE DRAWER
     SHOWS.** Reported as missing: "the Sales Inquiry and Need Support are missing their
     description, which should match what's in the box when clicked." Measured on the real node —
     16px/400 at the title's own ink, clamped to TWO lines with an ellipsis, which is where the
     "..." comes from. Clamped in CSS rather than cut in the data, because the FULL text is what
     the Intent Details drawer renders and what the agent's prompt is built from; truncating the
     string would have shortened all three at once. */
  const intents = intentCopy(p);

  return [
    { title: INTENT_SALES, subtitle: intents.sales.looksLike, icon: "cart", locked: true, leaves: [sales] },
    {
      title: INTENT_SUPPORT, subtitle: intents.support.looksLike, icon: "headsetMic", locked: true,
      leaves: [{
        title: SUPPORT_LEAF, action: LEAF_QUALIFY, actionIcon: "callSplit", locked: true,
        tone: "blue", actionKind: "qualify", paths: supportPaths(p, forked, informLeafPlain),
      }],
    },
  ];
}

/**
 * Repair segments written before a new answer inherited its siblings' action (9/17/2026).
 *
 * ⚠️⚠️ **A STALE NODE IS IDENTIFIED BY THE ABSENCE OF `actionKind`, AND THAT IS RELIABLE.** The
 * template has always set it, so the only way a segment reaches the store without one is the old
 * Apply path, which hardcoded `action: "Inform"` whatever its siblings were doing. That is why the
 * reported node read "Inform" in a Qualify row and rendered white: the tint is keyed on the kind.
 *
 * ⚠️ **AT READ TIME, NOT AS A MIGRATION**, the same call `toSteps` and the marketing-source rename
 * already make: the override store is per demo and syncs to the shared record, so a node created
 * before the fix can reach a colleague's browser where no migration ever ran. Repairing on read
 * fixes every one of them at once and needs nothing re-issued.
 *
 * ⚠️ **AND IT SELF-HEALS.** The drawer reads the EFFECTIVE tree, so once this has repaired a node
 * the next Apply writes the corrected action back to the store through `segmentNodes`.
 *
 * Returns the SAME object when nothing needed repairing, so it never costs a re-render.
 */
export function repairSmsSegments(branches: TreeBranch[]): TreeBranch[] {
  let touched = false;
  const fix = (kids: TreePath[]): TreePath[] => {
    /* The peers under one question agree on what they do, so the first configured sibling is the
       answer — exactly the rule Apply now uses for a brand-new one. */
    const model = kids.find((k) => k.actionKind);
    const out = kids.map((k) => {
      const inner = k.paths?.length ? fix(k.paths) : k.paths;
      const needs = !k.actionKind;
      if (!needs && inner === k.paths) return k;
      if (needs) touched = true;
      return {
        ...k,
        ...(needs && model
          ? { action: model.action, actionIcon: model.actionIcon, actionKind: model.actionKind, tone: model.tone }
          : needs
            /* No configured sibling to copy: fall back to the action's own wording rather than
               inventing one, so a hand-authored node still reads as what it says. */
            ? { actionKind: /qualify/i.test(k.action) ? "qualify" as const
                : /escalate/i.test(k.action) ? "escalate" as const : "inform" as const }
            : {}),
        ...(inner !== k.paths ? { paths: inner } : {}),
      };
    });
    return touched ? out : kids;
  };
  const next = branches.map((b) => {
    const leaves = b.leaves.map((l) => {
      if (!l.paths?.length) return l;
      const p = fix(l.paths);
      return p === l.paths ? l : { ...l, paths: p };
    });
    return leaves.every((l, i) => l === b.leaves[i]) ? b : { ...b, leaves };
  });
  return touched ? next : branches;
}
