/* =============================================================================
   audit-ai-rules — the four standing AI-button rules, checked in CI-ish form.
   -----------------------------------------------------------------------------
   These rules are easy to satisfy once and lose later: a screen added next month
   filters an array without keeping its index, or renders a card head with no id, and
   rule 3 silently degrades back to the model guessing — which is exactly the bug
   that started this. Run with `npm run audit:ai`.

   Static checks only, so it is fast and needs no browser. It cannot prove the model
   behaves; it proves the CODE still offers the guarantees.
   ============================================================================= */
import fs from "node:fs";
import path from "node:path";
import { isLockedEdit, isStructuralChange, routeEdits } from "../src/data/editGuard.ts";
import { voiceSpecFor } from "../src/data/voiceAgentSpec.ts";
import { treeToVoicePaths } from "../src/data/voicePaths.ts";
import { collectNames } from "../src/data/workflowDrawers.ts";
import { emptyWorkflowTree, extraTree, ZERO_TRIGGER, INTENT_SALES, INTENT_SUPPORT, SUPPORT_LEAF } from "../src/data/workflowChrome.ts";
import { rowLayout } from "../src/data/workflowRows.ts";
import { smsBranches, smsConfigFor, repairSmsSegments, SMS_TRIGGER } from "../src/data/smsTemplate.ts";
import { smsDrawerFor, drawerFor, SMS_ACTION_LABEL, SMS_ACTION_DESCRIPTION, SMS_ACTION_PROMPT,
  ACTION_DESCRIPTION, ACTION_PROMPT, SMS_ACTION_OPTIONS, SMS_CALLBACK_SIGNAL,
  SMS_DESTINATION_PROMPT, SMS_ROUTE_DESTINATION, SMS_ESCALATE_DESTINATION,
  actionCopy, collectOnSwitch, nodeActionFields, signalOptions, infoFieldOptions,
  SMS_DESTINATION_PLACEHOLDER, smsWorkflowFlow, type ActionKind } from "../src/data/workflowDrawers.ts";
import { buildSmsBrain, SMS_WORKFLOW_SCOPE_PATH, SMS_AGENT_SCOPE_PATH } from "../src/data/smsBrain.ts";
import { buildSmsBrain, smsWorkflowAgentOf, smsWorkflowScopePath,
  type SmsWorkflowAgent } from "../src/data/smsBrain.ts";
import { smsSystemPromptForAudit, __buildVoiceSystemForTest } from "../engine/chat.ts";
import { CustomerProfile } from "../src/data/schema.ts";
import { sweepValue } from "../engine/dashSweep.ts";
import { tollFreeNumber } from "../src/data/smsContactNumber.ts";

const SCREENS = "src/screens";
let fail = 0;
const bad = (msg: string) => { console.log(`  FAIL  ${msg}`); fail++; };
const ok = (msg: string) => console.log(`  ok    ${msg}`);

const files = fs.readdirSync(SCREENS).filter((f) => f.endsWith(".tsx"));
const read = (f: string) => fs.readFileSync(path.join(SCREENS, f), "utf8");
/** Read anything in the repo — the voice-lock checks below span components/ and data/. */
const readAny = (f: string) => fs.readFileSync(f, "utf8");
/**
 * The same file with its comments gone.
 *
 * ⚠️ BECAUSE A CHECK THAT REDDENS ON ITS OWN DOCUMENTATION GETS DELETED AS A NUISANCE. Several
 * notes in this codebase legitimately QUOTE the string they exist to forbid — "the invented
 * `Select a destination...` combobox" is a comment recording a correction, not the control
 * coming back. Same fix `audit:place` and the vendor scan already carry.
 */
const readCode = (f: string) =>
  readAny(f).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
/** Every profile on disk, bundled or in the local demo library — same pattern audit-place.ts uses. */
function load(dir: string, unwrap: (j: any) => any) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => unwrap(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))))
    .filter((p) => p?.id);
}

console.log("\nRule 1 — presentation is never data");
{
  /* A data value reaching a style attribute would let an edit change appearance.
     Boolean toggles between designed states are allowed and are the only exception. */
  let offenders: string[] = [];
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(/style=\{\{[^}]*\}/g)) {
      const frag = m[0];
      /* width/left/height driven by a NUMBER we computed is layout maths, not a data
         string; flag anything interpolating a data string into colour or font. */
      if (/(color|font|background)[^:]*:\s*[^"'\s]*\b(d|data|profile|card|tile)\./.test(frag)) {
        offenders.push(`${f}: ${frag.slice(0, 70)}`);
      }
    }
  }
  offenders.length ? offenders.forEach(bad) : ok("no data value reaches a colour or font");
}

console.log("\nRule 3 — every card head carries a tile id");
{
  for (const f of files) {
    const s = read(f);
    /* Only heads WITHOUT a data-tile. The first version counted every head and so
       failed on files that were fully tagged — a check that cries wolf gets ignored,
       which is worse than no check. */
    const untagged = (s.match(/className="dash-card-head"(?!\s+data-tile)/g) || []).length;
    if (untagged > 0) bad(`${f}: ${untagged} card head(s) with no data-tile — focused edits there can hit another tile`);
  }
  if (!fail) ok("all card heads are tagged");
  /* A card with no path stamps its HEADING as the id instead; the drawer must fall
     back the same way or hiding those cards silently does nothing. */
  {
    const drawer = fs.readFileSync("src/components/AiAssistantDrawer.tsx", "utf8");
    const anyFallback = files.some((f) => read(f).includes("tileId(path) ?? title"));
    anyFallback && drawer.includes("tileId(resolved) ?? (target")
      ? ok("heads and the drawer agree on the heading fallback id")
      : bad("the heading fallback is wired on only one side — hiding will no-op");
  }
}

console.log("\nRule 3 — filtered lists keep their original index");
{
  for (const f of files) {
    const s = read(f);
    /* `.filter(...)` straight into `.map((x, i) =>` means `i` is the FILTERED index.
       Using it as a data path points at the wrong element. */
    if (/\.filter\([^)]*\)\s*\.map\(\([^,)]+,\s*i\)/.test(s) && /path=\{`[^`]*\$\{i\}/.test(s)) {
      bad(`${f}: builds a path from a filtered index — keep the original (map to {b,i} first)`);
    }
  }
  ok("no path is built from a filtered index");
}

console.log("\nRules 2 + 4 — the capabilities are wired");
{
  const drawer = fs.readFileSync("src/components/AiAssistantDrawer.tsx", "utf8");
  const prompt = fs.readFileSync("engine/assistant.ts", "utf8");
  const guard = fs.readFileSync("src/data/editGuard.ts", "utf8");
  drawer.includes("constrainToFocus") ? ok("rule 3 is enforced in code, not just prompted") : bad("constrainToFocus is not wired");
  drawer.includes("hideTile") ? ok("rule 2.3 hide/show is wired") : bad("hide/show is not wired");
  drawer.includes('pathname.startsWith("/reports/")') ? ok("rule 2.3 tiles work in Reports too") : bad("Reports cannot add tiles");
  guard.includes("\\bseries$") ? ok("rule 2.2 length changes are allowed for charts") : bad("chart length changes still blocked");
  prompt.includes("metricColumns") ? ok("rule 2.2 column ops cover breakdown tables") : bad("column ops are report-only");
  prompt.includes("WHICH KIND of chart") ? ok("rule 1 chart-type lock is in the prompt") : bad("chart type is not locked");
  /* A prompt that both allows and forbids the same thing is worse than either: the
     model picked the prohibition and refused to add a column. */
  prompt.includes("NEVER change the number of tiles/rows/series/xLabels")
    ? bad("prompt still carries the old blanket length prohibition — it contradicts rule 2")
    : ok("prompt does not contradict itself on length");
}

/* =============================================================================
   THE SMS WORKFLOW'S FOUR NODE NAMES ARE PRODUCT CHROME.
   -----------------------------------------------------------------------------
   The real Invoca page does not let a user rename the trigger, the conversation-start node
   or the two intent nodes, so the template must always read "Triggered by",
   "Conversation Start", "Sales Inquiry" and "Need Support" — for every prospect, including
   ones generated later. The tree is derived at RENDER time with no schema slice and no
   engine phase, so that is true by construction today; these checks stop it drifting back.

   The failure being guarded against is specific and has happened once: the intent titles
   were derived from each prospect's routing queues (`voiceCopy`), so Shady Blinds read
   "Design Consultation / Existing Order" where the product always shows the same two words.
   ============================================================================= */
console.log("\nThe SMS workflow template's node names are locked");
{
  const wf = fs.readFileSync("src/screens/AgentWorkflow.tsx", "utf8");
  const tree = fs.readFileSync("src/components/WorkflowTree.tsx", "utf8");
  const guard = fs.readFileSync("src/data/editGuard.ts", "utf8");
  const ctx = fs.readFileSync("src/data/AiAssistantContext.tsx", "utf8");

  /* The two literals live in the renderer and were never per-prospect. */
  tree.includes(">Triggered by<") && tree.includes(">Conversation Start<")
    ? ok('"Triggered by" and "Conversation Start" are renderer literals')
    : bad("the trigger / conversation-start titles are no longer literals in WorkflowTree");

  /* ⚠️⚠️ **RE-AIMED 9/17/2026, NOT LOOSENED — AND IT NOW BUILDS THE TREE.** These three read
     the SMS block out of `AgentWorkflow.tsx` and grepped it for `title: INTENT_SALES`, which
     went red the moment the built-in tree moved into `smsTemplate.ts`. That module is pure
     data with no JSX, so node can import it and the checks can assert the REAL tree instead of
     its source text — the same upgrade the extra-workflow checks got when `extraTree` moved,
     and it is strictly stronger: a grep passes against `if (false && ...)`. */
  /* A REAL profile, not a fixture: the template derives its nouns and chips from one, so a
     hand-made object would prove the shape and not the re-skin. */
  const smsProfile = CustomerProfile.parse(
    JSON.parse(readAny("src/data/generated/orlando-health.json")),
  );
  const smsTree = smsBranches(smsProfile);
  smsTree[0]?.title === INTENT_SALES && smsTree[1]?.title === INTENT_SUPPORT
    ? ok("the SMS intents come from the fixed constants")
    : bad(`the SMS intent titles are not the fixed constants (${smsTree.map((b) => b.title).join(" / ")})`);
  const smsSrc = readAny("src/data/smsTemplate.ts");
  /\btitle:\s*c\.(newQ|supQ)\b/.test(smsSrc)
    ? bad("an SMS intent title is derived from the prospect's queues again (c.newQ / c.supQ)")
    : ok("no SMS intent title is derived from a prospect queue");
  smsTree.every((b) => b.locked)
    ? ok("the SMS intent nodes are marked locked")
    : bad("the SMS intent nodes are not marked locked — the AI could rename them");
  smsTree.every((b) => b.leaves.every((l) => l.locked))
    ? ok("both SMS user-group leaves are locked too")
    : bad("an SMS user-group leaf is not locked — the AI could rename the chrome");
  /* ⚠️ AND THE SEGMENTS BELOW THE CHROME MUST STAY EDITABLE, or locking the four boxes would
     have frozen the configuration this diagram exists to show. */
  const seg = smsTree[0]?.leaves?.[0]?.paths ?? [];
  seg.length === 2 && seg.every((s2) => !s2.locked && (s2.paths?.length ?? 0) === 2)
    ? ok("the segments below the chrome are editable and each forks again")
    : bad("the SMS sales branch is not two editable segments that each fork again");

  /* ⚠️ THE VOICE TREE IS LOCKED TOO NOW (8/26/2026), which OVERTURNS the note that used to
     sit in CLAUDE.md saying the voice intents were measured off Invoca's own Voice workflow
     page and must keep deriving from the prospect's queues. The user confirmed the real page
     shows the SAME two words as SMS, so that reading was wrong. Every voice tree now uses the
     constants — the derived default AND the National Van Lines split override, which is
     exactly the place a stale copy of a template survives. */
  /* ⚠️ THE COUNT DROPPED FROM 8 TO 6 BY DESIGN: the built-in SMS tree's two declarations moved
     to `smsTemplate.ts` (asserted above, by building it), leaving the voice default and the
     three SHAPE overrides in this file. Re-aimed with the move rather than relaxed — the
     invariant is that no tree names its own intents, and both halves are still checked. */
  const intents = [...wf.matchAll(/title:\s*INTENT_(?:SALES|SUPPORT)[^\n]*/g)].map((m) => m[0]);
  intents.length >= 6
    ? ok(`every tree in AgentWorkflow declares both intents from the constants (${intents.length})`)
    : bad(`only ${intents.length} intent titles use the constants — a tree names its own`);
  intents.every((l) => l.includes("locked: true"))
    ? ok("every intent node carrying a constant is also locked")
    : bad("an intent node uses a constant but is NOT locked — the AI could rename it");
  /* ⚠️ THE LEAF ROW IS CHROME TOO (8/26/2026). The voice tree's leaves read
     `All ${c.newQ} Users` / `Route to ${c.newQueue}` until the user confirmed the real page
     always shows the group named after the intent and one of a fixed set of actions. Only the
     CHIPS below stay per prospect. Checked because a leaf is the easiest place for a queue
     name to creep back in. */
  const voice = wf.slice(wf.indexOf("const shaped = SHAPE[profile.id]"));
  !/title:\s*`All \$\{c\.(newQ|supQ)\} Users`/.test(wf)
    ? ok("no leaf title derives from a prospect queue name")
    : bad("a leaf title is `All ${c.newQ|supQ} Users` again — the queue name is back");
  !/action:\s*`Route to \$\{c\.(newQueue|supQueue)\}`/.test(wf)
    ? ok("no leaf action derives from a prospect queue name")
    : bad("a leaf action is `Route to ${c.newQueue|supQueue}` again");
  voice.includes("action: LEAF_QUALIFY") && voice.includes("action: LEAF_ESCALATE")
    ? ok("the voice leaves default to Qualify and Support & Escalate")
    : bad("the voice leaf actions are not the two defaults");
  /\.\(title\|subtitle\|action\)\$/.test(readAny("src/data/editGuard.ts"))
    ? ok("LOCKED_KEYS covers action, so a locked leaf's action is refused too")
    : bad("LOCKED_KEYS does not cover action — a locked leaf's action is still editable");
  /locked\?: boolean/.test(readAny("src/components/WorkflowTree.tsx").slice(
      readAny("src/components/WorkflowTree.tsx").indexOf("export interface TreeLeaf"),
      readAny("src/components/WorkflowTree.tsx").indexOf("export interface TreeBranch")))
    ? ok("TreeLeaf declares locked")
    : bad("TreeLeaf no longer declares locked");
  /NEVER read out a user-group label/.test(readAny("engine/chat.ts"))
    ? ok("the voice prompt forbids saying a user-group label aloud")
    : bad("the prompt could have the agent say \"All Sales Inquiry Users\" on a call");

  /* ⚠️ THE FOURTH ROW HAS TO REACH THE PROMPT (8/26/2026). A Qualify leaf's paths are what
     the agent routes on; reading only the leaves would let an SE edit a path, watch the
     diagram redraw, and hear no change — the silent no-op that deriving the prompt from the
     tree exists to close, one row further down. CALLED, not grepped. */
  (() => {
    const t: any = { branches: [{ title: "I", leaves: [{ title: "G", action: "Qualify", chips: ["x"],
      paths: [{ title: "A", action: "Inform & Route", chips: ["p"] },
              { title: "B", action: "Inform & Route", chips: ["q"] }] }] }] };
    const r = treeToVoicePaths(t)[0]?.routes ?? [];
    return r.length === 2 && r.every((x: any) => x.need);
  })()
    ? ok("a Qualify leaf's PATHS reach the prompt, one route per answer")
    : bad("the prompt ignores the diagram's fourth row — editing a path would change nothing");
  (() => {
    /* A leaf with no paths must still contribute itself, or every tree without a fourth row
       loses its routing. */
    const t: any = { branches: [{ title: "I", leaves: [{ title: "G", action: "Route", chips: ["x"] }] }] };
    const r = treeToVoicePaths(t)[0]?.routes ?? [];
    return r.length === 1 && r[0].team === "G" && !r[0].need;
  })()
    ? ok("a leaf with no paths still contributes itself")
    : bad("a pathless leaf no longer produces a route");
  /* ⚠️ THE DIAGRAM'S PILLS ARE THE DRAWER'S "WHAT TO COLLECT" (8/26/2026), and only the row
     below the user groups carries any. Checked because a pill is a label an SE reads off the
     node and then expects to find in the drawer; two lists would drift silently. */
  (() => {
    const inform = collectNames("inform").join("|");
    return inform === "Consumer Zip|Consumer Name" && collectNames("qualify").length === 0;
  })()
    ? ok("the collect table drives the pills: inform collects Zip + Name, qualify collects nothing")
    : bad("the action collect table changed shape — the pills and the drawer can now disagree");
  /* And the prompt still gets a collect list for a leaf with no pills of its own. */
  (() => {
    const t: any = { branches: [{ title: "I", leaves: [{ title: "All Support Users", action: "Support & Escalate" }] }] };
    return (treeToVoicePaths(t)[0]?.routes?.[0]?.collect ?? []).length > 0;
  })()
    ? ok("a pill-less leaf still tells the agent what to collect, from its action")
    : bad("emptying a node's pills left the agent with nothing to collect — a silent no-op");
  !/chips: c\.(newChips|supChips)/.test(wf)
    ? ok("no node labels its pills from the prospect's own vocabulary")
    : bad("a node's pills are minted per prospect again instead of read from the collect table");

  /* The Qualify drawer's segments must READ the tree's path titles rather than rebuild them. */
  /\(l\.paths \?\? \[\]\)\.map\(\(x\) => x\.title\)/.test(readAny("src/data/workflowDrawers.ts"))
    ? ok("the Qualify drawer's segments are the leaf's own path titles")
    : bad("the Qualify drawer rebuilds its segments — it can disagree with the diagram");

  /\btitle:\s*"Book a Move"/.test(wf)
    ? bad("the National Van Lines override carries its own intent name again")
    : ok("the National Van Lines override uses the template's intent names");

  /* The trigger line and Conversation Start are chrome on BOTH channels; `chromeLocked` is
     what makes editGuard refuse them. Without it the AI can rewrite the product's wording. */
  (wf.match(/chromeLocked: true/g) ?? []).length >= 2
    ? ok("both the SMS and Voice trees set chromeLocked")
    : bad("a tree does not set chromeLocked — its trigger line is AI-editable");
  /chromeLocked\?: boolean/.test(readAny("src/components/WorkflowTree.tsx"))
    ? ok("WorkflowTreeModel declares chromeLocked")
    : bad("WorkflowTreeModel no longer declares chromeLocked");
  /* ⚠️ CALLED, NOT GREPPED. The first version of this check tested the SOURCE for
     `CHROME_KEYS.has(path)` and passed happily against `if (false && CHROME_KEYS.has(path))`
     — it was verified against that exact breakage and stayed silent. A text match cannot tell
     you a guard is reachable; running it can. */
  isLockedEdit({ chromeLocked: true, triggeredBy: "x" }, "triggeredBy")
    && isLockedEdit({ chromeLocked: true, startLabel: "x" }, "startLabel")
    ? ok("isLockedEdit actually refuses triggeredBy and startLabel when chromeLocked")
    : bad("isLockedEdit does NOT refuse the chrome fields — chromeLocked is decorative");
  isLockedEdit({ triggeredBy: "x" }, "triggeredBy")
    ? bad("isLockedEdit refuses triggeredBy even WITHOUT chromeLocked — too broad")
    : ok("an unlocked tree keeps its trigger line editable");
  /* ⚠️ THE CHECK IS ABOUT THE WORDING, AND IT READS THE VALUE NOW RATHER THAN THE SOURCE.
     It used to grep AgentWorkflow.tsx for `SMS_TRIGGER = "…"`; the constant was renamed
     `ZERO_TRIGGER` (two captures show the same line on a VOICE workflow) and moved to
     `workflowChrome.ts`, which Node can import — so the check asserts the STRING itself and
     no longer cares where it lives or what it is called. */
  ZERO_TRIGGER === "0 Campaigns, 0 Forms, and 0 Inbound SMS"
    ? ok("the trigger line names inbound SMS, and is one constant for both channels")
    : bad(`the trigger line is not the product's wording: ${ZERO_TRIGGER}`);

  /* ===========================================================================
     What Create Workflow builds: the EMPTY workflow (measured 8/27/2026)
     ⚠️ FUNCTIONAL, NOT GREPPED — these build the real tree and read it, because a text
     match cannot tell you `emptyWorkflowTree` is what the page actually renders.
     =========================================================================== */
  {
    const t = emptyWorkflowTree("Voice");
    const leaves = t.branches.flatMap((b) => b.leaves);
    t.branches.length === 2 && leaves.length === 2
      ? ok("the empty workflow has exactly the four chrome nodes and nothing else")
      : bad(`the empty workflow is not the bare tree (${t.branches.length} branches, ${leaves.length} leaves)`);
    /* The whole point of the empty state: an unconfigured leaf OFFERS an action rather
       than naming one, and advertises no fields it was never told to collect. */
    leaves.every((l) => l.addAction && !l.action && !l.chips?.length)
      ? ok("its user-group leaves offer + Add action, with no action text and no pills")
      : bad("an empty user-group leaf carries an action or pills it cannot have");
    /* A tone is the ACTION's colour; with no action there is no hue to paint. */
    leaves.every((l) => !l.tone)
      ? ok("its leaves are untinted, since a node takes its colour from its action")
      : bad("an empty leaf is tinted by an action nobody configured");
    /* Describing the caller is configuration the SE has not done yet. */
    t.branches.every((b) => !b.subtitle)
      ? ok("its intent nodes carry no caller-intent subtitle")
      : bad("an empty intent node describes a caller the SE never described");
    t.triggeredBy === "0 Campaigns, 0 Forms, and 0 Inbound SMS"
      ? ok("its trigger line is the product's all-zero wording")
      : bad(`its trigger line is not the measured wording: ${t.triggeredBy}`);
    /* Same lock as a configured tree — these four names are the product's either way. */
    t.chromeLocked && t.branches.every((b) => b.locked) && leaves.every((l) => l.locked)
      && isLockedEdit({ ...t, branches: t.branches }, "branches.0.title")
      ? ok("the empty workflow's chrome is locked, and isLockedEdit refuses renaming it")
      : bad("the empty workflow's chrome names are AI-editable");
  }
  /* The route must FAIL CLOSED on an id this prospect has no workflow for: without the
     guard, `isSms` defaults true and a pasted link renders a full SMS page for whichever
     prospect is active. Verified in the browser; pinned here so it cannot be deleted. */
  /if \(id && !created\)/.test(wf)
    ? ok("an unresolvable created-workflow id renders the not-found state")
    : bad("a created-workflow id from another prospect falls through to the SMS tree");

  /* Locked must be ENFORCED, not merely declared — otherwise a rename is a silent no-op. */
  guard.includes("export function isLockedEdit")
    ? ok("isLockedEdit exists")
    : bad("isLockedEdit is gone");
  ctx.includes("isLockedEdit(nextData")
    ? ok("applyEdits refuses a locked rename (counted as blocked, so the drawer says so)")
    : bad("isLockedEdit is defined but never called — a locked rename would silently no-op");
}

/* ---- an EXTRA workflow gets the same locked chrome (9/2/2026) --------------
   ⚠️ REPORTED, AND THIS FILE HAD RECORDED THE OPPOSITE AS DELIBERATE. The note under the SMS
   template said extra workflows "keep their own authored branch names, because a nurture
   flow's node is not 'Sales Inquiry'". That exception was wrong: the two intents and the two
   user groups are product chrome on EVERY SMS workflow, and what an authored workflow
   contributes is the USE CASES on the row beneath them. `extraTree` used to draw each branch
   as its own top-level intent node with an unlocked `${title} Users` leaf, so a new workflow
   rendered four intent nodes where the product always shows two, none of them locked. */
{
  /* ⚠️ **THESE USED TO GREP `AgentWorkflow.tsx` FOR `title: INTENT_SALES` AND COUNT
     `locked: true` OCCURRENCES, because that screen cannot be imported by node.** `extraTree`
     moved into `workflowChrome.ts` on 9/8/2026 for exactly that reason, so every check below
     now BUILDS a tree and reads it. This file already records why the difference matters: a
     grep once passed against `if (false && CHROME_KEYS.has(path))`. */
  const authored = [
    { title: "Ready to Book", action: "Book Appointment", tone: "green" as const, chips: ["Brand"], intent: "sales" as const },
    { title: "Human Requested", action: "Warm Hand-off", tone: "orange" as const, chips: ["Callback Window"], intent: "support" as const },
  ];
  const built = extraTree({
    slug: "probe", label: "Probe - SMS - Extra", channel: "SMS",
    startLabel: "SMS · probe", systemPrompt: "Probe.", branches: authored,
  } as never);

  built.branches.map((b) => b.title).join("|") === `${INTENT_SALES}|${INTENT_SUPPORT}`
    ? ok("extraTree draws the two chrome intents, not the authored branch titles")
    : bad(`extraTree's intent nodes are ${built.branches.map((b) => b.title).join("|")}`);
  const leaves = built.branches.flatMap((b) => b.leaves);
  leaves.map((l) => l.title).join("|") === `All ${INTENT_SALES} Users|${SUPPORT_LEAF}`
    ? ok("and the two chrome user-group leaves")
    : bad(`extraTree's leaf titles are ${leaves.map((l) => l.title).join("|")}`);
  built.branches.every((b) => b.locked) && leaves.every((l) => l.locked)
    ? ok("all four chrome nodes are marked locked")
    : bad("a chrome node in a built extra tree is not locked — one of the boxes is renameable");
  leaves.map((l) => l.action).join("|") === "Qualify|Support & Escalate"
    ? ok("its leaves carry the same two default actions as the voice tree")
    : bad(`extraTree's leaf actions are ${leaves.map((l) => l.action).join("|")}`);
  /* THE ORIGINAL DEFECT: each authored branch drawn as its own top-level intent node. */
  built.branches.length === 2 && leaves.length === 2
    ? ok("no authored branch is mapped onto an intent node or a leaf again")
    : bad(`extraTree drew ${built.branches.length} intents and ${leaves.length} leaves, not 2 and 2`);
  /* ...and each authored branch reaches the USE CASE row under the leaf its `intent` names. */
  leaves[0].paths?.map((pth) => pth.title).join() === "Ready to Book"
    && leaves[1].paths?.map((pth) => pth.title).join() === "Human Requested"
    ? ok("and each authored branch lands under the locked leaf its intent names")
    : bad("an authored branch landed under the wrong locked leaf");

  /* ⚠️ AND "LOCKED" MUST MEAN REFUSED, NOT MERELY DRAWN. Run against the tree just BUILT
     rather than a hand-written copy of it: a flag that is set and never consulted is the
     silent no-op this file exists to stop, and a literal here could drift from the builder. */
  const tree = built;
  const refused = ["branches.0.title", "branches.1.title",
    "branches.0.leaves.0.title", "branches.1.leaves.0.title",
    "branches.0.leaves.0.action", "branches.1.leaves.0.action"];
  refused.every((pth) => isLockedEdit(tree, pth))
    ? ok("every one of the four boxes (and both leaf actions) is REFUSED by editGuard")
    : bad(`a chrome edit is allowed: ${refused.find((pth) => !isLockedEdit(tree, pth))}`);
  const editable = ["branches.0.leaves.0.paths.0.title", "branches.0.leaves.0.paths.0.action",
    "branches.0.leaves.0.paths.0.chips.0", "branches.1.leaves.0.paths.0.title"];
  editable.every((pth) => !isLockedEdit(tree, pth))
    ? ok("and the use cases below stay editable, which is the whole point")
    : bad(`a use-case edit is refused: ${editable.find((pth) => isLockedEdit(tree, pth))}`);
}

/* =============================================================================
   AN Ask AI EDIT MUST REACH THE SMS AGENT, EVEN ON AN EXTRA WORKFLOW
   -----------------------------------------------------------------------------
   Reported 9/3/2026: "the AI said that they applied but none of them actually applied...
   the opening message still hasnt changed." Two independent silent no-ops, both only on a
   Preview Agent opened for an extra workflow:

     1. `wf.openingMessage` came FIRST in `buildSmsBrain`, ahead of the AI-editable
        `smsPlaybook.greeting` — and it is read from the RAW profile, so the edit could never
        win no matter how many times it was made.
     2. `buildSystem` returns early on `customSystem`, so the questions, rules, Q&A and
        knowledge were never rendered into the prompt at all.

   These call the real functions against a real workflow shape, because both defects were
   invisible to types and to every existing check.
   ============================================================================= */
console.log("\nAsk AI edits reach the SMS agent (extra workflows)");
{
  const wf = {
    slug: "sms-nurture", label: "Test - SMS - Nurture", channel: "sms" as const,
    openingMessage: "Hi {name}, this is the workflow's own scripted opener.",
    systemPrompt: "You are a nurture agent. Re-engage the customer warmly.",
    triggeredBy: "No-response follow-up", startLabel: "classify", branches: [],
  } as never;
  const profile = {
    customerName: "Testco", industry: "Testing",
    reports: { agentConfig: {
      brandConversationRules: ["Original rule."],
      smsPlaybook: { bookingType: "appointment", qualifyingQuestions: ["Original question?"] },
    }, voiceScreenpop: { callerName: "Dana Probe" }, extraWorkflows: [wf] },
  } as never;
  const raw = (profile as never as { reports: { agentConfig: unknown } }).reports.agentConfig as never;

  /* ⚠️ UNTOUCHED MUST BE BYTE-IDENTICAL. Appending a prospect's generic playbook to a
     hand-written nurture script nobody edited would contradict it — the self-contradicting
     prompt this repo has already paid for twice. */
  const b0 = buildSmsBrain(profile, raw, wf);
  b0.openingMessage === wf.openingMessage
    ? ok("an unedited workflow still opens with its own scripted line")
    : bad(`an unedited workflow's opener changed: ${b0.openingMessage}`);
  b0.overrides === undefined
    ? ok("and sends no config overrides")
    : bad(`an unedited workflow sent overrides: ${JSON.stringify(b0.overrides)}`);
  const p0 = smsSystemPromptForAudit(b0 as never);
  !/CONFIGURATION CHANGES/.test(p0)
    ? ok("so its prompt carries no override block")
    : bad("an unedited workflow's prompt gained an override block");

  /* THE REPORTED BUG: an edited greeting must win. */
  const edited = { ...raw, smsPlaybook: { ...raw.smsPlaybook, greeting: "Hi {name}, the edited opener." } };
  buildSmsBrain(profile, edited as never, wf).openingMessage === "Hi {name}, the edited opener."
    ? ok("an edited greeting BEATS the workflow's scripted opener")
    : bad("an edited greeting is still ignored — the reported no-op is back");

  /* THE SECOND BUG: edited questions must survive `customSystem`. */
  const qs = ["Edited question one?", "Edited question two?"];
  const b2 = buildSmsBrain(profile, { ...raw, smsPlaybook: { ...raw.smsPlaybook, qualifyingQuestions: qs } } as never, wf);
  const p2 = smsSystemPromptForAudit(b2 as never);
  qs.every((q) => p2.includes(q))
    ? ok("edited questions reach the prompt despite a custom system prompt")
    : bad("edited questions are still swallowed by customSystem");
  /* ...and must say which side wins, or the model picks one at random. */
  /THIS SECTION WINS/.test(p2)
    ? ok("and the override block states its own precedence")
    : bad("the override block does not say it outranks the playbook above");
  p2.includes(wf.systemPrompt)
    ? ok("while the workflow's own playbook is still there")
    : bad("appending the overrides dropped the workflow's playbook");
  /* An edited rule list travels the same way. */
  const b3 = buildSmsBrain(profile, { ...raw, brandConversationRules: ["A brand new rule."] } as never, wf);
  /A brand new rule\./.test(smsSystemPromptForAudit(b3 as never))
    ? ok("edited brand rules reach it too")
    : bad("edited brand rules are still swallowed");

  /* ⚠️ AND THE DRAWER MUST SHOW WHAT THE PHONE WILL SEND. Its row used to fall back to a
     DERIVED default, so on such a page it displayed an opening message the agent never sends
     and handed the model that same wrong text as the "current" one. */
  const drawer = readAny("src/components/AiAssistantDrawer.tsx");
  /active\.greetingFallback/.test(drawer)
    ? ok("the drawer's greeting row considers the workflow's own opener")
    : bad("the drawer can still show an opening message the agent never sends");
  const phone = readAny("src/screens/PhonePreview.tsx");
  /* ⚠️ WIDENED 9/8/2026, NOT WEAKENED. It required `greetingFallback:` to be followed
     IMMEDIATELY by `wf?.openingMessage`, and the value is now
     `wfAgent?.greeting ?? wf?.openingMessage` — the workflow page can edit that opener, so the
     authored one is only the last resort. The stricter half of what this check meant moved to
     its own assertion in the Ask AI section below, which pins the EFFECTIVE value. */
  /greetingFallback:[^,}]*wf\?\.openingMessage/.test(phone)
    ? ok("and the Preview Agent page tells it what that opener is")
    : bad("the Preview Agent page no longer passes the workflow's opener to the drawer");
}


/* =============================================================================
   ORLANDO HEALTH'S FIVE ER MESSAGING WORKFLOWS (9/8/2026)
   -----------------------------------------------------------------------------
   Built from the sign-off doc "Orlando Health - AI Messaging Scenarios for Demo Video":
   five scenarios, five `reports.extraWorkflows` entries. The doc's five ground rules apply
   to every scenario, so they are checked on every workflow rather than spot-checked on one.

   ⚠️ THESE ARE DATA CHECKS ON PURPOSE, and grepping DATA is not the anti-pattern this file
   warns about — the trap was an audit matching its own DOCUMENTATION (a comment naming the
   Geocoding API). A prompt string IS the deliverable here: if the ground rules are not in it,
   the agent does not have them.
   ============================================================================= */
console.log("\nOrlando Health's five ER messaging workflows");
{
  const profile = CustomerProfile.parse(
    JSON.parse(readAny("src/data/generated/orlando-health.json")),
  );
  const wfs = profile.reports.extraWorkflows ?? [];

  wfs.length === 5
    ? ok("all five scenarios are authored as workflows")
    : bad(`${wfs.length} extra workflows, expected five (one per scenario)`);
  new Set(wfs.map((w) => w.slug)).size === wfs.length
    ? ok("every slug is unique, so each routes to its own page")
    : bad("two workflows share a slug — one of them is unreachable");
  wfs.every((w) => w.channel === "SMS")
    ? ok("all five are SMS")
    : bad(`a scenario workflow is not SMS: ${wfs.find((w) => w.channel !== "SMS")?.slug}`);

  /* ⚠️ AN ABSENT `intent` SILENTLY DEFAULTS TO THE SALES SIDE. That is right for the
     workflows authored before the field existed and wrong here: a clinical or emotional
     reply must hang under the SUPPORT leaf, and a typo in the field name would put it
     quietly on the sales side with no visible symptom. */
  wfs.every((w) => w.branches.every((b) => b.intent === "sales" || b.intent === "support"))
    ? ok("every use case declares which locked leaf it hangs under")
    : bad(`a use case has no explicit intent: ${wfs.find((w) => w.branches.some((b) => !b.intent))?.slug}`);
  /* Ground rule 2: any clinical or emotional message hands off immediately, so every one of
     these trees needs a support path for that to be somewhere on the diagram. */
  wfs.every((w) => w.branches.some((b) => b.intent === "support"))
    ? ok("each has a support-side use case, which is where the doc's hand-off rule lands")
    : bad(`a workflow has no support path: ${wfs.find((w) => !w.branches.some((b) => b.intent === "support"))?.slug}`);
  /* Scenario 4's whole point is the context travelling, and the chips ARE that context. */
  wfs.every((w) => w.branches.every((b) => (b.chips?.length ?? 0) > 0))
    ? ok("every use case names what it collects, so the diagram shows what travels")
    : bad("a use case collects nothing, so the hand-off carries no context");

  /* ---- the doc's ground rules, on all five ------------------------------- */
  /* Ground rule 4: the opt-out language appears in the FIRST outbound message. */
  wfs.every((w) => /Reply STOP to opt out\./.test(w.openingMessage ?? ""))
    ? ok("every opening message carries the opt out line")
    : bad(`an opening message has no opt out line: ${wfs.find((w) => !/Reply STOP to opt out\./.test(w.openingMessage ?? ""))?.slug}`);
  /* Ground rule 3: the location is INFERRED from the facility they checked into, so the
     agent must never ask. A ZIP question is the shape this repo's other SMS playbooks use,
     which is exactly why it would be easy to paste in here. */
  const asksLocation = (s: string) => /\bzip\b|\bzip code\b|where are you/i.test(s);
  wfs.every((w) => !asksLocation(w.openingMessage ?? "") && !(w.playbookSteps ?? []).some(asksLocation))
    ? ok("none of them asks for a ZIP or where the patient is")
    : bad(`a workflow asks for the patient's location: ${wfs.find((w) => asksLocation(w.openingMessage ?? "") || (w.playbookSteps ?? []).some(asksLocation))?.slug}`);
  /* Ground rules 1, 5 and 6, checked as the promises the prompt has to contain. */
  const RULES: [string, RegExp][] = [
    ["never diagnoses or judges urgency", /never assess symptoms/i],
    ["hands off on a clinical or emotional message", /clinical or emotional message ends the flow/i],
    ["never books anything itself", /never book, schedule, move or cancel anything yourself/i],
    ["refers to scheduling with the context attached", /context of this conversation goes with them/i],
    ["never states a wait time as a number", /never state a wait time as a number/i],
    /* ⚠️ **CAUGHT IN A LIVE PREVIEW: THE AGENT MINTED A PHONE NUMBER.** Asked to refer a
       patient to scheduling, it produced "Call Orlando Health scheduling at 321-841-5111" —
       plausible, unverifiable, and shown to a real prospect in a demo video. The doc writes
       "Call [number]" and leaves it to us. 407-303-5910 is Orlando Health's own callback
       number ELSEWHERE IN THIS DEMO (a call transcript in `conversationIntelligence`), so
       naming it is deriving rather than inventing, and it keeps the five workflows consistent
       with the story around them. */
    ["is given the one real scheduling number", /407-303-5910/],
    ["is forbidden from inventing a number or a facility", /never invent a phone number/i],
  ];
  for (const [label, re] of RULES) {
    const missing = wfs.find((w) => !re.test(w.systemPrompt));
    missing
      ? bad(`${missing.slug}'s playbook does not say it ${label}`)
      : ok(`every playbook says the agent ${label}`);
  }

  /* ---- the trees ---------------------------------------------------------- */
  /* ⚠️ BUILT, NOT ASSUMED. This is what "make sure the Tree matches" means: five real
     workflows through the real `extraTree`, each drawing the same locked chrome the voice
     tree does with its authored use cases on the row below. */
  for (const w of wfs) {
    const t = extraTree(w);
    const lv = t.branches.flatMap((b) => b.leaves);
    const cases = lv.flatMap((l) => l.paths ?? []);
    const chromeOk = t.variant === "sms"
      && t.branches.map((b) => b.title).join("|") === `${INTENT_SALES}|${INTENT_SUPPORT}`
      && lv.map((l) => l.title).join("|") === `All ${INTENT_SALES} Users|${SUPPORT_LEAF}`
      && t.branches.every((b) => b.locked) && lv.every((l) => l.locked);
    chromeOk && cases.length === w.branches.length
      ? ok(`${w.slug}: locked chrome plus ${cases.length} use cases`)
      : bad(`${w.slug}: tree is wrong — ${t.branches.length} intents, ${lv.length} leaves, ${cases.length} of ${w.branches.length} use cases`);
    /* The four boxes must be REFUSED on this prospect's own trees, not just flagged. */
    ["branches.0.title", "branches.1.title", "branches.0.leaves.0.title", "branches.1.leaves.0.title"]
      .every((pth) => isLockedEdit(t, pth))
      ? ok(`  and its four chrome boxes are refused by editGuard`)
      : bad(`${w.slug}: a chrome box is renameable`);
  }
}

/* =============================================================================
   Ask AI ON AN SMS WORKFLOW BEHAVES LIKE THE VOICE ONE (9/8/2026)
   -----------------------------------------------------------------------------
   Asked for directly: "make sure the Ask AI performs the same way the Voice AI workflow
   does." The voice page registers `{ ...tree, agent }` as ONE object, so a single
   instruction reshapes the diagram AND configures the agent. An SMS extra workflow
   registered only the diagram, so "open with X" or "confirm the facility first" had nowhere
   to land: the model wrote the edit, `applyEdits` found no such path, and the drawer
   reported success. Same silent no-op, one channel over.

   ⚠️ EVERY CHECK BELOW READS THE BUILT PROMPT OR CALLS THE REAL GUARD. "The drawer said it
   applied" is not evidence — that lesson is recorded four times in CLAUDE.md.
   ============================================================================= */
console.log("\nAsk AI configures an SMS extra workflow, not just its diagram");
{
  const profile = CustomerProfile.parse(
    JSON.parse(readAny("src/data/generated/orlando-health.json")),
  );
  const ac = profile.reports.agentConfig as never;
  const wf = (profile.reports.extraWorkflows ?? [])[0];
  const prompt = (a?: SmsWorkflowAgent | null) =>
    smsSystemPromptForAudit(buildSmsBrain(profile as never, ac, wf as never, a) as never);

  /* ---- the base the page registers --------------------------------------- */
  const base = smsWorkflowAgentOf(wf as never);
  base.greeting === wf.openingMessage && base.steps?.length === wf.playbookSteps?.length
    ? ok("the agent half offers the workflow's own opener and its ordered flow")
    : bad(`the registered agent half is wrong: ${JSON.stringify(base)}`);
  /* ⚠️ THE DIAGRAM'S OWN FIELDS MUST NOT BE IN IT. One field, one home: a `branches` or
     `chips` copy under `agent` would duplicate the tree and the first edit to either would
     desync the diagram from the prompt — the cause of all three 8/27 voice bugs. */
  !("rules" in base) && !("questions" in base) && !("branches" in base)
    ? ok("and nothing the diagram draws, nor the prospect's shared rules and questions")
    : bad(`the agent half duplicates a field that has another home: ${Object.keys(base)}`);

  /* ---- unedited must be byte-identical ----------------------------------- */
  const p0 = prompt(null);
  (wf.playbookSteps ?? []).every((st) => p0.includes(st)) && p0.includes(wf.systemPrompt)
    ? ok("an unedited workflow's authored flow and playbook both reach the model")
    : bad("an unedited workflow's authored flow does not reach the prompt");
  p0 === prompt(undefined)
    ? ok("and passing no agent half at all is identical to passing null")
    : bad("the new parameter changes the prompt when it is absent");
  /THE FLOW\./.test(p0) && /1\. /.test(p0) && /do not reorder them/.test(p0)
    ? ok("the flow is numbered and forbidden from being reordered, not a bullet menu")
    : bad("the flow block is not numbered or does not forbid reordering");

  /* ---- THE REPORTED GAP: an edit has to reach the model ------------------ */
  const EDITED_OPENER = "This is Orlando Health, and this line was set by Ask AI.";
  buildSmsBrain(profile as never, ac, wf as never, { greeting: EDITED_OPENER }).openingMessage === EDITED_OPENER
    ? ok("an opener set on the workflow page is what the agent sends")
    : bad("an opener set on the workflow page is ignored — the no-op is back");
  const EDITED_STEPS = ["Confirm which facility they checked into.", "Then offer the nearest alternative."];
  const p1 = prompt({ steps: EDITED_STEPS });
  EDITED_STEPS.every((st) => p1.includes(st)) && !(wf.playbookSteps ?? []).some((st) => p1.includes(st))
    ? ok("an edited flow REPLACES the authored one in the prompt, rather than joining it")
    : bad("an edited flow does not replace the authored steps — the model gets two orderings");

  /* ---- and a workflow that states its flow in prose is untouched ---------- */
  const prose = { ...wf, playbookSteps: undefined } as never;
  const pProse = smsSystemPromptForAudit(buildSmsBrain(profile as never, ac, prose) as never);
  !/THE FLOW\./.test(pProse)
    ? ok("a workflow with no playbookSteps gains no flow block (Avi & Co and Reyes Law are untouched)")
    : bad("a prose-playbook workflow gained a flow block it never authored");

  /* ---- the guard has to allow the edits the feature is made of ------------ */
  isStructuralChange(["a", "b", "c"], ["a", "b"], "agent.steps") === false
    ? ok("editGuard lets the flow change length, so a step can be added or dropped")
    : bad("editGuard refuses a length change on agent.steps — 'add a step' is dead");
  /* ⚠️ **THE FIRST PROBE HERE WAS WRONG, AND IT MATTERS WHICH PATH IS USED.** It asserted
     that `series` was still blocked — but `/\bseries$/i` has been a length exemption since
     the standing AI-button rules, so the check failed on correct code. The thing to prove is
     that the new exemption is SCOPED: a BARE `steps` (some other screen's array) is still
     refused, while `agent.steps` is not. */
  isStructuralChange(["a", "b", "c"], ["a", "b"], "steps") === true
    ? ok("while a bare steps array elsewhere is still blocked, so the exemption stayed scoped")
    : bad("the agent.steps exemption widened rule 2 to every steps array in the app");

  /* ---- the write key and the read key must be the SAME key ---------------- */
  /* ⚠️ THE WORKFLOW PAGE WRITES IT AND A DIFFERENT TAB READS IT BACK. The Preview Agent
     opens at `/agent-studio/agent/preview?wf=<slug>`, so it cannot use `usePageData`'s own
     key and has to rebuild the workflow page's. If the two ever disagree the edit lands in a
     scope nobody consults, which looks exactly like an edit that applied and did nothing. */
  const route = readAny("src/App.tsx").includes('path="/agent-studio/agent/workflow/:channel"');
  route && smsWorkflowScopePath("probe-slug") === "/agent-studio/agent/workflow/probe-slug"
    ? ok("smsWorkflowScopePath rebuilds the workflow route's own pathname")
    : bad("smsWorkflowScopePath does not match the route the workflow page is mounted at");

  /* ---- the four surfaces have to be wired, and only a grep can see a screen -
     `AgentWorkflow.tsx` and `PhonePreview.tsx` both reach `import.meta.glob` through
     `useProfile`, so node cannot import them. These are the narrowest possible greps: each
     names the one call that closes one half of the loop, and the functional checks above
     already prove the code those calls reach actually works. */
  const page = readAny("src/screens/AgentWorkflow.tsx");
  /extra && isSms \? \{ agent: smsWorkflowAgentOf\(extra\) \}/.test(page)
    ? ok("the SMS workflow page registers the agent half beside its diagram")
    : bad("the SMS workflow page registers only the diagram again — Ask AI can only reshape the tree");
  /wfAgent=\{\(tree as/.test(page)
    ? ok("and hands the EFFECTIVE half to the Preview Workflow chat")
    : bad("Preview Workflow reads the raw workflow, so an edited opener would not show there");
  const phone = readAny("src/screens/PhonePreview.tsx");
  /* ⚠️ THE ARITY IS NOT THE INVARIANT — this pinned the exact call `buildSmsBrain(profile, ac,
     wf, wfAgent)` and went red the day a fifth argument was added for the built-in workflow's
     own config. What matters is that the tab reads that scope and hands the half to the brain. */
  /smsWorkflowScopePath\(wf\.slug\)/.test(phone) && /buildSmsBrain\(profile, ac, wf, wfAgent/.test(phone)
    ? ok("and the Preview Agent tab reads that scope back across the tab boundary")
    : bad("the Preview Agent tab never reads the workflow's agent half — the edit is a no-op there");
  /* ⚠️⚠️ **THE DRAWER'S GREETING ROW MUST SHOW THE EFFECTIVE OPENER, and the first build of
     this feature did not — caught in the browser, not by a type.** With the opener edited on
     the workflow page, the phone's first bubble read the new line while the drawer's OPENING
     MESSAGE row still showed the authored one. That is defect 3 of the 9/3 report coming back
     through a new door, and it matters because the drawer hands the model that same text as
     "the current opening message". */
  /greetingFallback: wfAgent\?\.greeting \?\? wf\?\.openingMessage/.test(phone)
    ? ok("and the drawer's greeting row shows the EFFECTIVE opener, not the authored one")
    : bad("the drawer can show an opening message the agent no longer sends");
  /* ⚠️ **COMMENTS STRIPPED FIRST, AND THE FIRST VERSION OF THIS CHECK FAILED WITHOUT IT.**
     That file's own header says "It must NEVER call `usePageData`", so a bare grep matched
     its documentation rather than its code and reported the rule as broken. `audit:place`
     already carries this exact fix, for the same reason. */
  const chat = readAny("src/components/WorkflowChatPreview.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  !/usePageData/.test(chat)
    ? ok("the chat drawer still registers no scope, so the page's sparkle stays on the tree")
    : bad("WorkflowChatPreview calls usePageData — it would repoint the page's sparkle");

  /* ⚠️ AND THE DRAWER MUST OFFER THE RIGHT CHANNEL. Registering an `agent` half made the
     empty state fall into the VOICE branch: "Build Orlando Health's voice agent", suggesting
     an opener beginning "Thanks for calling", on a screen whose whole subject is texts. */
  /* ⚠️ **THE CONDITION IS ASSERTED VERBATIM, AND THE FIRST VERSION OF THIS CHECK DID NOT
     FIRE.** It located the SMS body by searching for `d?.variant === "sms"` and then read the
     copy inside it — so disabling the branch as `if (false && d?.variant === "sms")` left the
     search string in place and the check passed against dead code. That is the same failure
     this file records verbatim: "a grep passed against `if (false && CHROME_KEYS.has(path))`".
     Verified to fire, both by disabling the branch and by voicing its copy. */
  const drawer = readAny("src/components/AiAssistantDrawer.tsx");
  drawer.includes('if (d?.agent && d?.variant === "sms") {')
    ? ok("the drawer branches on the channel before offering to build an agent")
    : bad("the SMS branch's guard is gone or has been disabled");
  const smsHint = drawer.slice(drawer.indexOf('if (d?.agent && d?.variant === "sms") {'),
    drawer.indexOf("if (d?.agent) {"));
  smsHint.includes("SMS agent") && !smsHint.includes("Thanks for calling")
    ? ok("its empty state offers to build the SMS agent, not a voice one")
    : bad("the SMS workflow page's Ask AI still offers a VOICE agent");
  smsHint.includes("open with Hi {name}")
    ? ok("and its example opener uses the {name} token the agent actually resolves")
    : bad("the SMS hint's example opener is not in the shape resolveGreeting expects");
}

/* =============================================================================
   THE DASH SWEEP MUST LEAVE `playbookSteps` ALONE (9/8/2026)
   -----------------------------------------------------------------------------
   Same reasoning `systemPrompt` was exempted for on 9/2: these are instructions to the
   model, never shown to a patient, and `\s{2,}` collapsing a blank line turned Reyes Law's
   bulleted playbook into one comma-joined paragraph that is not recoverable. The LIST form
   is why it needed its own rule: the object walk skips a SKIP_KEY only when the value is a
   string, so an array keyed `playbookSteps` was recursed into and swept step by step.
   ============================================================================= */
console.log("\nThe dash sweep leaves a workflow's flow alone");
{
  const count = { n: 0 };
  const swept = sweepValue({
    playbookSteps: ["Ask the brand - then the reference.", "Confirm - and hand off."],
    openingMessage: "Hi there - this is a message to a patient.",
  }, count) as { playbookSteps: string[]; openingMessage: string };
  swept.playbookSteps[0] === "Ask the brand - then the reference."
    ? ok("a dash inside a step survives, as it does inside a systemPrompt")
    : bad(`the sweep rewrote a playbook step: ${swept.playbookSteps[0]}`);
  swept.openingMessage === "Hi there, this is a message to a patient."
    ? ok("while an openingMessage is still swept, because a patient reads it")
    : bad(`openingMessage was not swept: ${swept.openingMessage}`);
}

/* =============================================================================
   THE SMS THREAD HEADER SHOWS A TOLL-FREE NUMBER, NOT THE PROSPECT'S NAME (9/8/2026)
   -----------------------------------------------------------------------------
   Asked for directly, against the phone mockup's contact pill (selected element:
   ".sms-namepill", reading "Orlando Health"): *"For all prospects i want you to change the
   contact information from the name of the prospect to a random 1-800 number."* A real
   iPhone Messages thread only shows a NAME when the sender is a saved contact; this is a
   cold business number, so digits are the more faithful mockup even before the ask.

   `tollFreeNumber(profileId)` lives in `src/data/smsContactNumber.ts` — its own file, not
   inline in `PhonePreview.tsx`, for the same reason `workflowChrome.ts` and
   `workflowRows.ts` are their own files: that screen imports `useProfile`, which reaches
   `profiles.ts` and its Vite-only `import.meta.glob`, so node cannot import it and a
   function stranded there could only be grepped, not called and swept for real collisions.
   ============================================================================= */
console.log("\nThe SMS thread header shows a stable toll-free number, not the prospect's name");
{
  const profiles = [...load("src/data/generated", (j: any) => j),
    ...load(".data/demos", (j: any) => j.profile)];
  const seen = new Set<string>();
  const ids = profiles.filter((p) => p?.id && !seen.has(p.id) && seen.add(p.id)).map((p) => p.id as string);

  ids.length >= 10
    ? ok(`swept ${ids.length} real profile ids`)
    : bad(`only found ${ids.length} profiles to sweep — load() may be broken`);

  const numbers = ids.map((id) => tollFreeNumber(id));
  numbers.every((n) => /^\(800\) 555-0\d{3}$/.test(n))
    ? ok("every number is shaped (800) 555-0XXX, the reserved-for-fiction exchange")
    : bad(`a number is not in the 555-0XXX shape: ${numbers.find((n) => !/^\(800\) 555-0\d{3}$/.test(n))}`);

  new Set(numbers).size === numbers.length
    ? ok(`all ${numbers.length} prospects get a distinct number — zero collisions`)
    : bad(`two prospects share a number, over ${numbers.length} profiles`);

  ids.every((id) => tollFreeNumber(id) === tollFreeNumber(id))
    ? ok("the number is a pure function of the profile id — stable across calls")
    : bad("the number is not deterministic");

  /* ⚠️ THE 555-01XX BLOCK (100 VALUES) WAS TRIED FIRST AND COLLIDED TWICE OVER 17 REAL
     PROFILES — proof the wider 555-0XXX shape (1,000 values) is really in effect is that at
     least one real id lands OUTSIDE the narrower 100-value block. */
  const outside01xx = numbers.some((n) => !/^\(800\) 555-01\d{2}$/.test(n));
  outside01xx
    ? ok("at least one number falls outside the narrower 555-01XX block, proving the wider range is live")
    : bad("every number still fits the old 100-value 555-01XX block — the widening may have regressed");

  const phone = readAny("src/screens/PhonePreview.tsx");
  /tollFreeNumber\(profile\.id\)/.test(phone)
    ? ok("the contact pill renders the toll-free number, not profile.customerName")
    : bad("the sms-namepill no longer calls tollFreeNumber — the prospect's name may be back");
  !/sms-namepill">\{profile\.customerName\}/.test(phone)
    ? ok("and the old customerName render is gone, not just shadowed")
    : bad("the old customerName render is still present alongside the new one");
}

/* =============================================================================
   THE TREE'S ROWS ARE SYMMETRIC AND NEVER CROWDED (9/8/2026)
   -----------------------------------------------------------------------------
   Reported directly: *"There isnt any symmetry, in the branch in the tree diagram... Sometimes
   the sales Inquiry branch is different length to the Need support. or the the branch line is
   too close to the Conversation Start box."*

   Both halves were the same root cause: `GEO`'s row constants are FIXED while node heights are
   MEASURED, so every gap in the diagram was `(a constant) - (however tall the text made the row
   above)`. Measured before the fix, across the seven Orlando Health workflow pages: the stub
   under Conversation Start was **4px** on the two whose subtitle wraps to a second line, 23px
   on the five that fit one line and 73px on the voice tree; and the built-in SMS tree's sales
   leaf stood **142px against the support leaf's 75px** because it carries two chips.

   ⚠️ THESE CALL THE REAL `rowLayout` OVER ADVERSARIAL HEIGHTS rather than checking one tree.
   A single example passing is what let this ship: five of the seven pages looked fine.
   ============================================================================= */
console.log("\nThe workflow tree's rows are symmetric and never crowded");
{
  const MIN_GAP = 30;
  /* One-line through five-line boxes, and a deliberately absurd one, on both channels and
     with and without each optional row. */
  const HS = [43, 65, 84, 103, 142, 400];
  let worst = Infinity, worstCase = "";
  let inverted = 0, cases = 0;
  for (const variant of ["sms", "voice"] as const) {
    for (const split of [false, true]) {
      for (const paths of [false, true]) {
        for (const trigger of HS) for (const start of HS) for (const intent of HS) for (const leaf of HS) {
          cases++;
          const R = rowLayout(variant, { trigger, start, intent, leaf }, { split, paths });
          /* Every connector the tree DRAWS, as (from, to) pairs. A row that is not drawn
             (`subBusY`/`leafBusY`/`pathTop` are 0 then) is deliberately excluded. */
          const gaps: [string, number][] = [
            ["trigger->start", R.startTop - R.triggerBottom],
            ["start->bus", R.busY - R.startBottom],
            ["bus->intent", R.intentTop - R.busY],
            ...(split
              ? [["intent->subBus", R.subBusY - R.intentBottom] as [string, number],
                 ["subBus->leaf", R.leafTop - R.subBusY] as [string, number]]
              : [["intent->leaf", R.leafTop - R.intentBottom] as [string, number]]),
            ...(paths
              ? [["leaf->leafBus", R.leafBusY - R.leafBottom] as [string, number],
                 ["leafBus->path", R.pathTop - R.leafBusY] as [string, number]]
              : []),
          ];
          for (const [name, gap] of gaps) {
            if (gap < 0) inverted++;
            if (gap < worst) { worst = gap; worstCase = `${name} = ${gap} (${variant}, trigger ${trigger}, start ${start}, intent ${intent}, leaf ${leaf})`; }
          }
        }
      }
    }
  }
  inverted === 0
    ? ok(`no connector points upwards, over ${cases} height combinations`)
    : bad(`${inverted} connectors are inverted — a line drawn bottom-to-top renders as nothing`);
  worst >= MIN_GAP
    ? ok(`every connector is at least ${MIN_GAP} design units long (shortest seen ${worst})`)
    : bad(`a connector is only ${worst} units long: ${worstCase}`);

  /* ⚠️ MONOTONE, which is the promise that no signed-off diagram moved. Taller text may push a
     row DOWN and must never pull one up. */
  const base = rowLayout("sms", { trigger: 65, start: 65, intent: 43, leaf: 75 }, { split: false, paths: true });
  const taller = rowLayout("sms", { trigger: 84, start: 84, intent: 64, leaf: 142 }, { split: false, paths: true });
  (["startTop", "busY", "intentTop", "leafTop", "leafBusY", "pathTop"] as const)
    .every((k) => taller[k] >= base[k])
    ? ok("taller text only ever pushes a row down, never up")
    : bad("a row moved UP when the text above it grew");

  /* ⚠️ THE VOICE TREE MUST BE BYTE-IDENTICAL. Its own gaps (103 / 73 / 100) already exceed
     MIN_GAP, so the shift stays 0 and every row sits exactly on its measured constant. Pinned
     because those numbers came off a real Invoca capture, not from us. */
  const v = rowLayout("voice", { trigger: 65, start: 65, intent: 84, leaf: 75 }, { split: false, paths: true });
  v.startTop === 176 && v.busY === 314 && v.intentTop === 344 && v.leafTop === 528
    && v.leafBusY === 660 && v.pathTop === 700
    ? ok("the voice tree still sits on the constants measured from the capture")
    : bad(`the voice tree moved: ${JSON.stringify(v)}`);

  /* ⚠️ AND THE ROWS MUST BE LEVELLED, or the gaps above prove nothing: they are computed from
     ONE height per row, so a renderer that let siblings keep their own heights would draw
     unequal stems from the same row however clean this arithmetic is. */
  const tree = readAny("src/components/WorkflowTree.tsx");
  /const levelRow = /.test(tree) && /el\.style\.minHeight = ""/.test(tree)
    ? ok("levelRow clears minHeight before measuring, so a row shrinks as well as grows")
    : bad("row levelling is gone, or measures its own applied height and can only grow");
  /* ⚠️ THIS READS `workflowRows.ts`, NOT THE COMPONENT. The arithmetic moved there so the
     sweep above could call it without React; the check followed it one commit later than it
     should have, and reported a defect that did not exist. */
  const rows = readAny("src/data/workflowRows.ts");
  /\bintentBottom = intentTop \+ h\.intent\b/.test(rows) && /\bleafBottom = leafTop \+ h\.leaf\b/.test(rows)
    ? ok("and a row's bottom is one number, so every stem leaving it is the same length")
    : bad("per-node bottoms are back — two branches can be different lengths again");
}

/* =============================================================================
   ASK AI'S ONE DIRECTOR MODEL, PLATFORM-WIDE (9/3/2026, widened 9/11/2026)
   -----------------------------------------------------------------------------
   Every "Ask AI" surface runs the same strong model now — Opus, adaptive thinking,
   effort:"high", streamed — so an SE describing a multi-part instruction on ANY page gets it
   translated into coordinated edits rather than one plausible fragment. This replaced a
   two-tier split (a fast/cheap Haiku path for most pages, the strong path only for the voice
   workflow) whose failure mode was invisible: a partial Haiku answer to a multi-part
   instruction looks like a normal success. Three things have to stay true or the feature
   silently degrades, and none of them shows up as a type error:
     • every request reaches the strong model (a stray edit reintroducing a fast/slow split
       would silently make some pages worse again);
     • the call streams (the SDK refuses a non-streaming call it estimates could exceed 10
       minutes, which Opus plus adaptive thinking reaches);
     • the frontend always requests the stream, so the SE sees the real progress bar rather
       than a spinner with no signal for 15-25 seconds.
   ============================================================================= */
{
  const a = readAny("engine/assistant.ts");

  /^const MODEL = "claude-opus-5";$/m.test(a)
    ? ok("Ask AI runs on Opus 5")
    : bad("the Ask AI model is missing or is no longer Opus 5");

  /* ⚠️ NO FAST/CHEAP PATH SHOULD EXIST ANY MORE — a reintroduced two-tier split is exactly
     the silent-degradation shape this section exists to catch. */
  !/FAST_MODEL/.test(a) && !/if \(!director\)/.test(a)
    ? ok("there is no separate fast/cheap model path — every page gets the same treatment")
    : bad("a fast/cheap path has come back — some pages are silently getting a weaker model again");

  /* ⚠️ isVoiceAgentPage() STILL EXISTS, but only to gate the voice-specific PROMPT CONTENT
     (fields like agent.greeting/informSteps that simply don't exist off that page's data) —
     never the model, transport or effort. Naming those fields on a page whose data lacks
     them is how the model invents a path and writes the edit somewhere else. */
  /function isVoiceAgentPage\(/.test(a) && (a.match(/isVoiceAgentPage\(/g) ?? []).length >= 2
    ? ok("the voice-agent gate still scopes the voice-specific prompt content")
    : bad("isVoiceAgentPage is gone or no longer used to scope the voice brief");

  /* ⚠️ ADAPTIVE THINKING AND effort ARE OPUS-ONLY — Haiku 400s on either. There is no more
     Haiku path in this file, so both should simply always be present on the one model call
     rather than conditioned on anything. */
  /* ⚠️ REQUIRES A SPACE AFTER THE COLON, on purpose: this file's own header comment two
     screens up writes `effort:"high"` (no space) as prose, and a looser regex matched that
     instead of the real `output_config: { effort: "high", ... }` call — a check that passed
     against documentation, not code. */
  /thinking:\s*\{\s*type:\s*"adaptive"/.test(a) && /effort:\s+"high"/.test(a)
    ? ok("every request gets adaptive thinking and effort:\"high\"")
    : bad("adaptive thinking or effort:\"high\" is missing from the one model call");

  /* ⚠️ STREAMING IS A REQUIREMENT, NOT A NICETY: the SDK refuses a non-streaming call it
     estimates could exceed 10 minutes, which Opus plus adaptive thinking reaches. */
  /client\.messages\.stream\(/.test(a) && /finalMessage\(\)/.test(a)
    ? ok("the one model call streams")
    : bad("the model call no longer streams — it will fail on long answers");

  /* ⚠️ "omitted" IS THE DEFAULT ON OPUS 5 and streams EMPTY thinking text, so the progress
     note would render blank and the bar would move on nothing. */
  /display:\s*"summarized"/.test(a)
    ? ok("thinking is summarized, so the progress note carries real reasoning")
    : bad("thinking display is back to omitted — the progress note will be empty");

  /* ⚠️ THE BAR MUST NEVER PRINT 100 BEFORE THE JSON HAS PARSED. */
  a.indexOf('pct: 100') > a.indexOf("JSON.parse(text)")
    ? ok("100% is reported only after the answer parses")
    : bad("the bar can reach 100% before there is an answer");

  /* The six voices are named so "make it a man's voice" resolves to a real id. */
  /VOICE_OPTIONS\.map\(/.test(a) && /agent\.voice/.test(a)
    ? ok("the prompt names the real voices from voiceOptions")
    : bad("the prompt no longer names the offered voices");

  /* ⚠️ A LIST EDIT IS A REPLACEMENT, and a short array is indistinguishable from a deliberate
     removal to editGuard — so the whole-list contract is instruction-only and worth pinning. */
  /REPLACES THE WHOLE LIST/.test(a)
    ? ok("the whole-list contract is stated")
    : bad("nothing tells the model a list edit replaces the whole list");

  /* ⚠️ AND THE OLD TIMIDITY MUST NOT COME BACK. These two lines were written to stop a WEAK
     model wrecking a working agent and are exactly what stopped a strong one doing the job. */
  !/leave them alone unless the user is changing which areas are served/i.test(a)
    ? ok("informSteps are no longer fenced off")
    : bad("the 'leave informSteps alone' fence is back — behaviour edits will be declined");
  !/THE OPENING QUESTION IS TWO-WAY AND STAYS THAT WAY/.test(a)
    ? ok("the opening question can be rewritten when asked")
    : bad("the two-way opening question fence is back");

  /* ⚠️ BOTH TWINS OR NEITHER — the standing rule for these endpoint pairs. */
  const vite = readAny("vite.config.ts"), server = readAny("server.ts");
  /input\?\.stream/.test(vite) && /input\?\.stream/.test(server)
    ? ok("both endpoint twins serve the progress stream")
    : bad("only one twin streams — dev and prod now disagree");
  /X-Accel-Buffering/.test(vite) && /X-Accel-Buffering/.test(server)
    ? ok("both twins disable proxy buffering")
    : bad("a proxy can buffer the stream into one jump at the end");

  /* ⚠️ A STREAM THAT ENDS WITHOUT `done` MUST FAIL LOUDLY. Falling through would report
     success having changed nothing — the silent no-op this repo has recorded five times. */
  const drawer2 = readAny("src/components/AiAssistantDrawer.tsx");
  /if \(!r\) throw new Error\("The connection closed/.test(drawer2)
    ? ok("a dropped stream reports a failure, not a silent success")
    : bad("a dropped stream falls through and reads as success");
  /aiad-prog-fill/.test(drawer2) && /aiad-prog-pct/.test(drawer2)
    ? ok("the drawer renders a bar and a percentage")
    : bad("the progress bar is gone");

  /* ⚠️ THE DRAWERS MUST ALWAYS REQUEST THE STREAM NOW (9/11/2026) — there is no page whose
     request answers fast enough not to need it any more, so a `wantsStream` test keyed on
     the page's data shape (the old Haiku/Opus split) would silently leave some pages showing
     no progress bar for a 15-25s wait. */
  /const wantsStream = true;/.test(drawer2)
    ? ok("AiAssistantDrawer always requests the stream")
    : bad("AiAssistantDrawer is still conditionally requesting the stream");

  const insightsDrawer = readAny("src/components/InsightsAskDrawer.tsx");
  /* ⚠️ THE FILE ALSO CONTAINS AN UNRELATED `{ stream: true }` — the TextDecoder's OWN option
     in its SSE reader (`dec.decode(value, { stream: true })`), which a bare `/stream:\s*true/`
     matches regardless of whether the REQUEST actually asks for one. Anchored to the request
     body, which is the only place `canCreateTiles: true` appears. */
  /canCreateTiles: true,\s*\n\s*stream: true,/.test(insightsDrawer)
    ? ok("InsightsAskDrawer requests the stream too")
    : bad("InsightsAskDrawer never asks for a stream — it will hang silently for 15-25s");
  /if \(err\) throw new Error\(err\);/.test(insightsDrawer) && /if \(!result\) throw new Error\("The connection closed/.test(insightsDrawer)
    ? ok("InsightsAskDrawer also fails loudly on a dropped stream")
    : bad("InsightsAskDrawer can read a dropped stream as a silent success");
}

console.log("\nThe Preview Workflow drawer's own Ask AI + undo (voice side)");
{
  /* Asked for directly (9/16/2026): the SMS preview chat has carried its own sparkle and
     undo since 8/26, and the voice Preview Workflow drawer had neither — the only way to
     change what the voice agent says was the top-bar sparkle on the page behind it.

     ⚠️ THE TWO PAIRS ARE NOT THE SAME WIRING, and these checks pin the difference. The SMS
     agent's config lives on ANOTHER page, so that drawer carries a scope key and calls
     registerBase. A voice workflow's agent config IS this page's data (merged into the
     object the diagram registers), so the voice pair targets the PAGE's own key and shares
     its undo stack. A voice pair that grew its own key would be editing a scope nothing
     renders — the silent no-op this file records six times. */
  const wfSrc = readAny("src/screens/AgentWorkflow.tsx");
  const wf = wfSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const css = readAny("src/styles/app.css");

  /vp-icon vp-icon-ai vp-icon-hover/.test(wf)
    ? ok("the voice preview header renders an Ask AI sparkle")
    : bad("the voice Preview Workflow drawer has no Ask AI button");
  /vp-icon-off/.test(wf) && /undo\(pageKey\)/.test(wf)
    ? ok("it renders an undo beside it, keyed to the same scope")
    : bad("the voice preview's undo is missing or points at another scope");

  /* ⚠️ THE PAGE'S OWN KEY, and it must be built the way `usePageData` builds it or the pair
     edits a scope the page never registered. */
  /const pageKey = `\$\{profileId\}::\$\{pathname\}`/.test(wf)
    ? ok("it targets this page's own scope key")
    : bad("the voice pair no longer uses the page's own scope key");
  /const key = `\$\{profileId\}::\$\{pathname\}`/.test(readAny("src/components/GeneratedTiles.tsx"))
    ? ok("usePageData still builds that same key, so the two agree")
    : bad("usePageData's key shape changed — the voice pair now edits nothing");
  /openDrawer\(\{ scope: "agent", key: pageKey,/.test(wf)
    ? ok("it opens the drawer on that key as an agent focus")
    : bad("the voice sparkle no longer opens an agent focus on the page key");

  /* ⚠️ ON THE LEFT, which is what was asked for — the same side the SMS chat uses, and for
     the same reason: the drawer being configured sits on the RIGHT, so a right-hand panel
     lands on top of it and its backdrop dims and blocks it. Omitting `side` would silently
     fall back to the platform default, which IS the right, so this has to be asserted
     positively rather than by the absence of anything. */
  /side: "left"/.test(wf)
    ? ok("the voice drawer opens on the LEFT, beside the preview it configures")
    : bad("the voice sparkle no longer passes side: left — it will cover the preview");
  /side\?: "left";/.test(readAny("src/data/AiAssistantContext.tsx"))
    ? ok("`left` is still the opt-in the focus offers")
    : bad("AssistantFocus.side changed shape — the left placement may no longer apply");
  /\.aiad--left\.aiad--open \{ pointer-events: none; \}/.test(css)
    ? ok("a left drawer still lets the preview beside it take clicks")
    : bad("the left drawer now swallows clicks meant for the preview it sits beside");

  /* ⚠️ THE VOICE DRAWER IS 500px, THE CHAT 400, so the left panel must reserve 100px more
     when the voice one is up or it covers the drawer it sits beside — MEASURED at 20px of
     overlap on a 900px viewport and 88px at 800px before this rule. Keyed off the voice
     drawer being on screen, so the SMS chat's placement is untouched at every width. */
  /body:has\(\.vp-root\) \.aiad--left \.aiad-panel \{\s*width: min\(420px, max\(300px, calc\(100vw - 512px\)\)\);/.test(css)
    ? ok("the left panel reserves the voice drawer's full 500px while it is open")
    : bad("the left panel still reserves only the chat's 400px — it will cover the voice drawer below ~920px");
  /* ⚠️ THIS CHECK WAS WRONG FIRST and failed on correct code — it tried to match the 412px
     from the `.aiad--left .aiad-panel` selector through to its width line, and that rule's
     own explanatory comment is longer than the window the pattern allowed. `412px` appears
     nowhere else in the stylesheet, so its mere presence is the invariant. */
  (css.match(/calc\(100vw - 412px\)/g) || []).length === 1
    ? ok("and the chat's own 412px reserve is unchanged")
    : bad("the SMS chat's left-panel width moved — that screen is signed off");
  /side: "left"/.test(readAny("src/components/WorkflowChatPreview.tsx"))
    ? ok("the SMS chat still opens on the left too")
    : bad("the SMS chat's drawer moved — it must stay left of the chat it exists to watch");

  /* ⚠️ GATED ON THE REGISTERED DATA'S SHAPE. A created workflow registers no `agent` half,
     so a sparkle there would offer to change what an agent says on a page whose whole state
     is that nothing is configured. */
  /const voiceAgentConfigured = !!\(tree as \{ agent\?: unknown \}\)\.agent;/.test(wf)
    ? ok("the pair is gated on the page actually registering an agent half")
    : bad("the voice pair is no longer gated on an agent being configured");
  /\{voiceAgentConfigured && \(/.test(wf)
    ? ok("and the gate really wraps the two buttons")
    : bad("the gate is computed but nothing is behind it");

  /readOnly/.test(wf) && /canUndo\(pageKey\) && !readOnly/.test(wf)
    ? ok("undo stands down on a demo this SE cannot edit")
    : bad("the voice undo ignores readOnly — it would no-op with no explanation");

  /* ⚠️ ITS OWN PREFIX. Reusing `.wcp-icon` would mean a value changed for one drawer
     restyles the other, which this repo has already paid for once (79 deleted `.cd-` rules). */
  !/wcp-icon/.test(wf)
    ? ok("it uses its own .vp- classes rather than the chat drawer's")
    : bad("the voice header borrows .wcp-icon — one prefix per screen");
  /\.vp-icon-hover \{ opacity: 0;/.test(css) && /\.vp-head:hover \.vp-icon-hover/.test(css)
    ? ok("the pair is hidden until the header is hovered, like the chat's")
    : bad("the voice pair is always visible — the captured header no longer reads as captured");
  /\.vp-title \{ flex: 1;/.test(css)
    ? ok(".vp-title takes the slack, so the icons group at the right")
    : bad(".vp-title lost flex: 1 — space-between will spread the icons across the header");
  /\.vp-actions \{/.test(css)
    ? ok("the icons sit in their own row rather than inheriting the header's 12px gap")
    : bad(".vp-actions is gone");
}

/* =============================================================================
   THE BUILT-IN SMS WORKFLOW: six rows, and drawers that really save (9/17/2026)
   ============================================================================= */
console.log("\nThe built-in SMS workflow template");
{
  const p = CustomerProfile.parse(JSON.parse(readAny("src/data/generated/aptive.json")));
  const cfg = smsConfigFor(p);
  const tree = { variant: "sms" as const, geo: "smsV2" as const, triggeredBy: SMS_TRIGGER,
    startLabel: "SMS · classify intent", chromeLocked: true, branches: smsBranches(p) };

  /* ---- the shape, against the capture ---- */
  const sales = tree.branches[0].leaves[0];
  (sales.paths?.length === 2 && sales.paths.every((x) => x.paths?.length === 2))
    ? ok("three levels below the intent, as the capture draws them")
    : bad("the sales branch is not two forks of two");
  const leaves = sales.paths?.flatMap((x) => x.paths ?? []) ?? [];
  leaves.length === 4 && leaves.every((l) => l.action === "Inform")
    ? ok("four Inform leaves on the bottom row")
    : bad("the bottom row is not four Inform leaves");
  /* ⚠️ MEASURED: `found = false`'s drawer carries no What To Collect list, so its node draws no
     chips. An invented list is the diagram advertising a collection the drawer does not have. */
  (leaves[3].chips ?? []).length === 0 && (leaves[0].chips ?? []).length > 0
    ? ok("the last leaf carries no chips, as captured, while the others do")
    : bad("chip presence on the bottom row does not match the capture");
  /* ⚠️ VERBATIM, UNEVEN SPACING INCLUDED — `found= true` and `found = false`. */
  leaves[2].title === "found= true" && leaves[3].title === "found = false"
    ? ok("the condition labels keep the capture's own spacing")
    : bad("a condition label was tidied — the replica is drifting from the capture");

  /* ---- re-skinned, not Greenix ---- */
  const all = JSON.stringify([tree, cfg]);
  /\bgreenix/i.test(all)
    ? bad("Greenix's own name leaked into another prospect's template")
    : ok("nothing in the template names Greenix");
  /(844-233-7378|833-729-4353|8887181241)/.test(all)
    ? bad("one of Greenix's real support numbers is in the template")
    : ok("Greenix's real phone numbers are gone");
  /* ⚠️ THE USER'S OWN CALL when asked: drop the MCP references rather than minting a
     `<slug>_check_zip_serviceable` for 145 prospects that have no such integration. */
  /_mcp|mcp tool|greenhl|search_website/i.test(all)
    ? bad("an MCP tool reference survived — the user asked for these to be dropped")
    : ok("no MCP tool names anywhere in the template");
  /555-0\d{3}/.test(JSON.stringify(cfg))
    ? ok("phone numbers use the reserved 555 exchange")
    : bad("the template's phone numbers are not on the 555 exchange");
  const noun = p.customerNoun;
  sales.paths?.[0]?.title.includes(noun) && sales.paths?.[1]?.title.includes(noun)
    ? ok(`the two answers re-skin to the prospect's own noun (${noun})`)
    : bad("the new/existing answers do not use the prospect's customerNoun");

  /* ---- the drawers ---- */
  const dTrig = smsDrawerFor(p, tree, "trigger", cfg);
  const dInt = smsDrawerFor(p, tree, "intent-0", cfg);
  const dQual = smsDrawerFor(p, tree, "leaf-0-0", cfg);
  const dInf = smsDrawerFor(p, tree, "sub-0-0-0-0", cfg);
  const dEsc = smsDrawerFor(p, tree, "path-1-0-2", cfg);
  smsDrawerFor(p, tree, "start", cfg) === null
    ? ok("Conversation Start opens nothing, exactly as on the voice page")
    : bad("Conversation Start opens a drawer the real page does not have");
  (dTrig?.kind === "trigger" && dTrig.rows?.length === 3 && dTrig.links?.length === 3)
    ? ok("the trigger drawer lists its forms and number, with three links")
    : bad("the SMS trigger drawer is missing its rows or its third link");
  (dQual?.kind === "action" && dQual.action === "qualify" && dQual.segments?.length === 2)
    ? ok("the Qualify drawer's answers come from the tree's own child nodes")
    : bad("the Qualify drawer's segments are not the tree's children");
  /* ⚠️ MEASURED: an SMS Inform drawer has NO phone row; the escalate one has a destination. */
  (dInf?.kind === "action" && dInf.phone === undefined && (dInf.collect?.length ?? 0) > 0)
    ? ok("the SMS Inform drawer has no phone row but does collect fields")
    : bad("the SMS Inform drawer still renders a phone row");
  (dEsc?.kind === "action" && dEsc.phone === undefined && !!dEsc.destinationPrompt)
    ? ok("the SMS escalate drawer asks for a destination, not a number")
    : bad("the SMS escalate drawer is not shaped like the capture");
  /* ⚠️ THE FOUR STRINGS THAT DIFFER FROM VOICE. Sharing one table would put "transfer them to
     the right queue" on a text conversation. */
  SMS_ACTION_DESCRIPTION.inform === "Provide information to the caller."
    && SMS_ACTION_PROMPT.inform === "How should the agent inform users?"
    && SMS_ACTION_LABEL.inform === "Inform"
    && SMS_ACTION_DESCRIPTION.inform !== ACTION_DESCRIPTION.inform
    && SMS_ACTION_PROMPT.inform !== ACTION_PROMPT.inform
    ? ok("the SMS copy is the measured SMS copy, not the voice copy")
    : bad("the SMS drawer copy has drifted back towards the voice strings");

  /* ---- editable only where it can save ---- */
  [dInt, dQual, dInf, dEsc].every((x) => x && "edits" in x && !!x.edits)
    ? ok("every configurable SMS drawer carries write-back paths")
    : bad("an SMS drawer is editable with nowhere to write — Apply would be a lie");
  /* ⚠️ THE TEST IS "NO WRITE PATHS", NOT "AN `edits` KEY SET TO undefined" — the first version
     of this check asked `"edits" in added`, which is FALSE when the builder simply omits the key,
     i.e. exactly the state it was trying to confirm. It failed on correct code. */
  const noWrites = (x: unknown) => !((x as { edits?: unknown })?.edits);
  /* ⚠️ RE-AIMED 9/17/2026, NOT LOOSENED. This asked for a READ-ONLY DRAWER on an id that is not
     in the tree, which was the old fallback's behaviour; the drawer now resolves the node from
     the tree and so opens NOTHING for an id that names no node — the stronger outcome, and the
     one this check's own failure message already allowed. The invariant was never "a drawer
     appears", it is "no node borrows another node's write paths". */
  const ghost = smsDrawerFor(p, tree, "path-0-0-9", cfg);
  const borrowed = JSON.stringify((ghost as { edits?: unknown } | null)?.edits ?? {});
  (ghost === null || (noWrites(ghost) && !borrowed.includes("paths.0")))
    ? ok("an id that names no node opens nothing rather than borrowing another node's copy")
    : bad("an unconfigured segment claims another node's write paths");
  /* ⚠️ THE SEGMENT PATH POINTS AT THE TREE, NOT A COPY OF THE TITLES. */
  (dQual?.kind === "action" && dQual.edits?.segments === "branches.0.leaves.0.paths")
    ? ok("Add writes the tree's own child nodes, so a new answer draws as a node")
    : bad("the segments path does not point at the tree's children");
  (dQual?.kind === "action" && (dQual.segmentNodes?.length ?? 0) === 2)
    ? ok("the answers' own nodes ride along, so renaming one cannot flatten its branch")
    : bad("segmentNodes is missing — a rename would destroy the branch under it");
  /* ⚠️⚠️ RE-AIMED 9/21/2026, ON REQUEST — the voice drawers were read-only because nobody had
     asked, and this check pinned that. Asked for directly ("i dont see the updated stuff in the
     voice workflow"), so the invariant moves from "no write paths" to "every write path goes
     to a home the AGENT actually reads". That is the thing worth guarding: the voice page has
     registered its `agent` half since 8/27, so a field could always have been given a home —
     what must never happen is a field given a home the prompt ignores. */
  {
    const vTree = { variant: "voice" as const, triggeredBy: "2 campaigns and 0 forms",
      startLabel: "Voice · classify intent", branches: [] as never[] };
    const v = drawerFor(p, { ...vTree, branches: smsBranches(p) }, "leaf-0-0");
    (v?.kind === "action" && v.edits?.question === "agent.qualifyQuestion"
      && v.edits?.fallback === "agent.qualifyFallback")
      ? ok("a voice Qualify writes to the agent's own config, which the call reads back")
      : bad("a voice drawer writes somewhere the agent never reads");
  }

  /* ---- the measured palette (9/17/2026) ---------------------------------------
     Reported: "the boxes and pills are not the right color", "the background dots are too far
     apart and also make them lighter", and the intents "are missing their description". Every
     value below came off `reference/agent-workflow/sms-tree-v2.html`, which serialises its
     emotion CSS, so these are real computed styles rather than screenshot readings. */
  {
    const css = readAny("src/styles/app.css");
    const v2 = css.slice(css.indexOf(".wf-v2 .wf-node {"));
    /* A card is tinted by its ACTION: the hue at 8%, a 5px left edge, no other border. */
    const tint = (k: string, hue: string) =>
      new RegExp(`\\.wf-v2 \\.wf-act-${k}\\s*\\{[^}]*rgba\\(${hue},\\.08\\)[^}]*border-left: 5px solid #`).test(v2);
    tint("qualify", "208,193,242") && tint("inform", "38,102,249") && tint("escalate", "255,112,69")
      ? ok("each action tints its card at 8% with a 5px left edge, as measured")
      : bad("an action tint is not the measured 8% + 5px edge");
    /(#440066)/.test(v2) && /(#11228c)/.test(v2) && /(#b33b00)/.test(v2)
      ? ok("the action text takes the measured dark ink of its own hue")
      : bad("an action ink is missing — the measured inks are #440066 / #11228c / #b33b00");
    /\.wf-v2 \.wf-act-\w+ \.wf-leaf-action \.wf-svg-ic \{ background: rgba\([\d,]+,\.12\)/.test(v2)
      ? ok("the glyph sits in a box of its hue at 12%")
      : bad("the icon box is not the hue at 12%");
    /* The chip is neutral and fully rounded — ours had been white on a green border. */
    /\.wf-v2 \.wf-chip \{[^}]*background: #e7e9eb;[^}]*border: none;[^}]*font-size: 12px;[^}]*border-radius: 100px/.test(v2)
      ? ok("the chip is #E7E9EB at 12px and radius 100px with no border")
      : bad("the chip does not match the measured pill");
    /\.wf-v2 \.wf-node \{[^}]*border-radius: 6px;[^}]*border-color: #e7e9eb;[^}]*box-shadow: none/.test(v2)
      ? ok("the card is radius 6, #E7E9EB, and flat")
      : bad("the card radius / border / shadow is not the measured one");
    /\.wf-v2\.wf-tree \.wf-start \{ background: #d4e0fe/.test(v2)
      ? ok("Conversation Start is the platform's own #D4E0FE")
      : bad("Conversation Start is not #D4E0FE");
    /* The description: same 16px as the title, its ink, flush left, two-line clamp. */
    /\.wf-v2 \.wf-node-sub \{[^}]*font-size: 16px;[^}]*color: var\(--color-text-title\);[^}]*padding-left: 0/.test(v2)
      ? ok("the intent description is 16px at the title's ink, flush left")
      : bad("the intent description is still the small muted indented one");
    /-webkit-line-clamp: 2/.test(css)
      ? ok("it clamps to two lines, which is where the ellipsis comes from")
      : bad("the two-line clamp is gone — a paragraph would render in full");
    /* Connectors: 1px, coloured by the node they point at. */
    /\.wf-v2 \.wf-l \{ stroke-width: 1; stroke: #d0d3d8/.test(v2)
      && /\.wf-v2 \.wf-l-act-inform\s*\{ stroke: #2666f9/.test(v2)
      ? ok("connectors are 1px and take their target's colour")
      : bad("connectors are not the measured 1px / target-coloured");
    /* The dots. */
    /radial-gradient\(#91919a 0\.5px, transparent 0\.5px\)/.test(css) && /background-size: 16px 16px/.test(css)
      ? ok("the canvas dots are a 1px #91919A dot on a 16px grid")
      : bad("the canvas dots are not the measured gap and size");

    /* ⚠️⚠️ THE NON-REGRESSION THAT MATTERS: the SHARED classes must be untouched, because the
       voice tree and seven authored extra workflows draw them. */
    const base = css.slice(css.indexOf(".wf-node { position: absolute"), css.indexOf(".wf-v2 .wf-node {"));
    /border-radius: 8px/.test(base) && /box-shadow: 0 1px 3px/.test(base) && /#d9dee4/.test(base)
      ? ok("the shared .wf-node keeps its own radius, shadow and border")
      : bad("the shared .wf-node was restyled — that reaches the voice tree and every extra workflow");
    /\.wf-chip \{ background: rgba\(255,255,255,\.7\)/.test(base)
      ? ok("the shared .wf-chip is unchanged")
      : bad("the shared .wf-chip was restyled");
    /* Arrowheads are an ATTRIBUTE, so they cannot be scoped in CSS — they must be opt-in. */
    /const lineFor = \(k\?: string, arrows = true\)/.test(readAny("src/components/WorkflowTree.tsx"))
      ? ok("arrowheads are opt-in, so no other diagram grows them")
      : bad("arrowheads are unconditional — every workflow diagram would gain them");

    /* ⚠️ ONE SOURCE: the node's description IS the drawer's, or the two disagree the first time
       either is edited — the failure this whole feature exists to avoid. */
    const d0 = smsDrawerFor(p, tree, "intent-0", cfg);
    (d0?.kind === "intent" && tree.branches[0].subtitle === d0.looksLike && !!d0.looksLike)
      ? ok("the intent node's description is the very string its drawer shows")
      : bad("the node description and the drawer's have drifted apart");
  }

  /* ---- content-sized terminals, and repairing a stale answer (9/17/2026) --------
     Reported: "the boxes should not be all sizes, they change based on the number of pills", and
     an answer added in a Qualify drawer came out saying Inform, white and untinted. */
  {
    const tsx = readAny("src/components/WorkflowTree.tsx");
    /* ⚠️ MEASURED: the real bottom row is 152 / 152 / 176 / 78 — every node sizes to its own
       content, and the one with no pills is less than half its neighbours. Rows ABOVE still
       level, because a row's bottom is where the next row's stems start. */
    /const levelRow = \(els: \(HTMLDivElement \| null\)\[\], fallback: number, level = true\)/.test(tsx)
      && /if \(level\) live\.forEach/.test(tsx)
      ? ok("levelRow can be told not to apply, which is what leaves the last row content-sized")
      : bad("levelRow always applies — the last row would be levelled to its tallest node again");
    /const lastRow = anySubs \? "sub" : anyPaths \? "path" : "leaf"/.test(tsx)
      ? ok("which row is last is computed from the tree, not named")
      : bad("the last row is hardcoded — a tree of a different depth would level the wrong one");
    /const lvl = \(row: string\) => !\(v2 && row === lastRow\)/.test(tsx)
      ? ok("only the measured SMS page skips levelling, so the voice tree keeps its level row")
      : bad("the skip is not scoped to v2 — the voice tree's six use cases would go ragged");

    /* ⚠️ A NEW ANSWER INHERITS ITS SIBLINGS' ACTION. Peers under one question agree on what they
       do, which is why the answers of a Qualify are Qualifies and theirs are Informs. */
    const wnd = readAny("src/components/WorkflowNodeDrawer.tsx");
    /const sibling = was\?\.\[0\]/.test(wnd) && /action: sibling\.action/.test(wnd)
      ? ok("Apply gives a brand-new answer its siblings' action, not a hardcoded Inform")
      : bad("a new answer is still hardcoded — it would read Inform in a row of Qualifies");

    /* ---- repairSmsSegments, against real shapes ---- */
    const stale = [{ title: "Test", action: "Inform", tone: "blue" }] as never[];
    const withSibs = [
      { title: "New", action: "Qualify", actionIcon: "callSplit", actionKind: "qualify", tone: "blue" },
      ...stale,
    ] as never[];
    const rep = repairSmsSegments([{ title: "I", leaves: [{ title: "L", action: "Qualify", paths: withSibs }] }] as never);
    const fixed = (rep[0].leaves[0].paths ?? [])[1] as { action?: string; actionKind?: string };
    fixed?.actionKind === "qualify" && fixed?.action === "Qualify"
      ? ok("a stale answer takes its configured sibling's action and kind")
      : bad(`a stale answer was not repaired from its sibling (${JSON.stringify(fixed)})`);
    /* No sibling to copy: fall back to what the node itself says rather than inventing. */
    const alone = repairSmsSegments([{ title: "I", leaves: [{ title: "L", action: "Qualify", paths: stale }] }] as never);
    ((alone[0].leaves[0].paths ?? [])[0] as { actionKind?: string })?.actionKind === "inform"
      ? ok("with no sibling it infers the kind from the action's own wording")
      : bad("a lone stale answer was not given a kind");
    /* ⚠️ IDENTITY WHEN NOTHING NEEDS REPAIR, or this would re-render on every pass. */
    const clean = smsBranches(p);
    repairSmsSegments(clean) === clean
      ? ok("a tree that needs no repair comes back as the same object")
      : bad("repairSmsSegments copies a clean tree — that is a re-render every pass");
  }

  /* ---- drag the whitespace to move the diagram (9/17/2026) --------------------
     Asked for directly: "give the user the ability to click on any white space in the workflow
     box and move the diagram around." The real pane does this and carries `cursor: grab`. */
  {
    const tsx = readAny("src/components/WorkflowTree.tsx");
    const css = readAny("src/styles/app.css");
    /\.wf-scroll \{[^}]*cursor: grab/.test(css) && /\.wf-scroll\.wf-panning \{ cursor: grabbing/.test(css)
      ? ok("the scroller advertises the drag with grab / grabbing, as the real pane does")
      : bad("the pan affordance is missing — nothing tells anyone the whitespace is draggable");
    /\.wf-scroll\.wf-panning \{[^}]*user-select: none/.test(css)
      ? ok("text selection is suppressed only WHILE panning")
      : bad("a pan would select text across the diagram, or selection is killed at rest");
    /* ⚠️⚠️ THE ONE THAT MATTERS: a pointerdown on a node, a zoom button or the minimap must be
       left alone, or a drag would swallow the click that opens a drawer. */
    /closest\("\.wf-node, \.wf-zoom, \.wf-minimap"\)\) return;/.test(tsx)
      ? ok("a pointerdown on a node or a control is left alone, so nodes stay clickable")
      : bad("the pan does not exempt nodes and controls — it would eat their clicks");
    /e\.pointerType === "touch"\) return;/.test(tsx)
      ? ok("touch is left to the browser, so a gesture cannot move the diagram twice")
      : bad("touch is handled here as well as natively — one gesture would pan twice");
    /e\.button !== 0/.test(tsx)
      ? ok("only the primary button pans")
      : bad("a right-click or middle-click would start a pan");
    /try \{ el\.setPointerCapture\(e\.pointerId\); \} catch/.test(tsx)
      ? ok("the pointer capture is guarded, so a vanished pointer cannot throw mid-gesture")
      : bad("setPointerCapture is unguarded — it throws if the pointer is already gone");
    /* ⚠️ IMPERATIVE, NOT STATE: a setState per drag start would re-render the whole tree
       mid-gesture for the sake of one cursor. */
    /el\.classList\.add\("wf-panning"\)/.test(tsx) && !/useState.*panning/i.test(tsx)
      ? ok("the panning class is toggled imperatively, so a drag causes no re-render")
      : bad("panning is held in state — every drag would re-render the diagram");
    /* ⚠️⚠️ **RE-AIMED, AND THE OLD ASSERTION WAS THE WRONG INVARIANT (9/17/2026).** It pinned the
       pan to `scrollLeft`, which a screen recording of the real page then disproved: the diagram
       can be dragged clean past the edge, leaving bare canvas behind it, and a scroll offset can
       only ever travel inside the content. What actually has to hold is that the pan is its OWN
       transform on `.wf-fit` and does not touch the fit SCALE on `.wf-tree`. */
    /setPan\(d\.px \+ \(e\.clientX - d\.x\), d\.py \+ \(e\.clientY - d\.y\)\)/.test(tsx)
      ? ok("the drag moves its own pan, unbounded, so the diagram can leave the frame")
      : bad("the drag no longer sets the free pan");
    /transform: `scale\(\$\{scale\}\)`/.test(tsx)
      ? ok("the fit scale still owns `.wf-tree`'s transform, untouched by the pan")
      : bad("the pan and the fit scale are fighting over one transform");
    /\.wf-fit \{[^}]*transform: translate\(var\(--wf-px, 0px\), var\(--wf-py, 0px\)\)/.test(css)
      ? ok("the pan is a translate on the fit box, driven by custom properties")
      : bad("the pan translate is gone from .wf-fit");
    /* No scrollbars, which is what was asked for — and the box must still scroll from script,
       because that is what the zoom anchor and Fit to view use. */
    /\.wf-scroll \{[^}]*overflow: hidden/.test(css)
      ? ok("the scroller shows no bars, as the real pane does not")
      : bad("the scrollbars are back");
    /* The dots travel with the diagram, as react-flow's own background pattern does. */
    /\.wf-scroll \{[^}]*background-position: var\(--wf-px, 0px\) var\(--wf-py, 0px\)/.test(css)
      ? ok("the dot grid moves with the pan")
      : bad("the dots stay put while the diagram moves under them");
    /* ⚠️ THE ZOOM ANCHOR HAS TO KNOW ABOUT THE PAN, or zooming after a drag snaps the diagram
       back by the pan distance and the node under the cursor slides away. */
    /cx: \(el\.scrollLeft \+ px - pan\.current\.x\) \/ from/.test(tsx)
      ? ok("the zoom anchor subtracts the pan, so zooming after a drag holds its focal point")
      : bad("the zoom anchor ignores the pan — a zoom after a drag would jump");
    /* ⚠️ AND FIT TO VIEW IS THE ONLY WAY BACK once the diagram has been pushed off the edge. */
    /setPan\(0, 0\);/.test(tsx)
      ? ok("Fit to view clears the pan, which is the way back from an off-screen drag")
      : bad("Fit to view leaves the pan — a diagram dragged away could not be recovered");
  }

  /* ---- the drawer's action is the NODE's action (9/17/2026) --------------------
     Reported: "the Action in this example [is] Qualify, it should match the action in the
     context drawer." Measured before the fix: all eight template nodes agreed and both
     SE-added ones read Qualify on the node and Inform in the drawer. */
  {
    /* An added answer, exactly as Apply writes one: inherits its siblings' Qualify. */
    const added = JSON.parse(JSON.stringify(tree)) as typeof tree;
    const sibs = added.branches[0].leaves[0].paths!;
    sibs.push({ ...sibs[0], title: "Added", paths: undefined } as never);
    const ids: [string, string][] = [
      ["leaf-0-0", "qualify"], ["leaf-1-0", "qualify"], ["path-1-0-2", "escalate"],
      ["path-0-0-0", "qualify"], ["path-0-0-1", "qualify"],
      ["sub-0-0-0-0", "inform"], ["sub-0-0-1-1", "inform"],
      ["path-0-0-2", "qualify"],
    ];
    const wrong = ids.filter(([id, want]) => {
      const d = smsDrawerFor(p, added, id, cfg);
      return !(d?.kind === "action" && d.action === want);
    });
    wrong.length === 0
      ? ok("every node's drawer describes that node's own action, added segments included")
      : bad(`${wrong.length} node(s) open a drawer for the wrong action: ${wrong.map(([i]) => i).join(", ")}`);
    /* ⚠️ THE ADDED NODE'S ANSWERS ARE ITS OWN CHILDREN, at a path derived from its id, so `Add`
       works there too rather than being a dead control. */
    const dAdded = smsDrawerFor(p, added, "path-0-0-2", cfg);
    (dAdded?.kind === "action" && dAdded.edits?.segments === "branches.0.leaves.0.paths.2.paths")
      ? ok("an added Qualify node's Add writes its own children")
      : bad("an added Qualify node has no segments path — Add would be inert");
    /* ⚠️⚠️ FLAT KEYS, NOT NESTED, and this is the bug that cost the most time: `setByPath`
       refuses a path whose INTERMEDIATE key is missing and only creates the LAST one, so
       `sms.extra.<id>__question` vanished silently on any demo that already had an SMS
       override — no error, no refusal, Apply reporting success. */
    (dAdded?.kind === "action" && dAdded.edits?.question === "sms.extra__path-0-0-2__question")
      ? ok("an added segment's text writes to a FLAT key on sms, whose parent always exists")
      : bad(`the added segment's write path is nested again (${dAdded?.kind === "action" ? dAdded.edits?.question : "?"})`);
    !/extra: Record<string, string>/.test(readAny("src/data/smsTemplate.ts"))
      ? ok("there is no nested `extra` map to walk into")
      : bad("the nested extra map is back — writes to it are a silent no-op on existing demos");
    /^sms\.extra__/.test("sms.extra__path-0-0-2__question")
      && !isStructuralChange(undefined, "hi", "sms.extra__path-0-0-2__question")
      ? ok("the first text typed into an added segment is allowed through the guard")
      : bad("editGuard blocks the first write to an added segment");
    /* ⚠️ AND THE CONFIG READ TOLERATES AN OVERRIDE SAVED BEFORE A FIELD EXISTED — without the
       base spread, one click on an added segment threw and the boundary tore down the whole
       diagram, so EVERY node stopped opening. */
    /\{ \.\.\.smsBase, \.\.\.\(\(tree as \{ sms\?: Partial<typeof smsBase> \}\)\.sms \?\? \{\}\) \}/
      .test(readAny("src/screens/AgentWorkflow.tsx"))
      ? ok("the base is spread under the stored config, so a missing field cannot throw")
      : bad("a demo whose override predates a field would crash the diagram on a node click");
  }

  /* ---- the Action dropdown's five actions (9/17/2026) ----------------------------
     Measured from five captures of ONE drawer with the combobox switched between them. The
     option LIST and its order are from a screenshot — every capture saved with the list closed
     (`aria-expanded=false`), so there is no listbox markup anywhere. */
  {
    const css = readAny("src/styles/app.css");
    const drawerSrc = readAny("src/components/WorkflowNodeDrawer.tsx");
    const treeSrc = readAny("src/components/WorkflowTree.tsx");
    const dr = readAny("src/data/workflowDrawers.ts");

    /* the five, in the screenshot's order */
    JSON.stringify(SMS_ACTION_OPTIONS) ===
      JSON.stringify(["callback", "qualify", "inform", "informRoute", "escalate"])
      ? ok("the dropdown offers the five actions in the order the screenshot lists them")
      : bad(`the action list or its order has drifted: ${SMS_ACTION_OPTIONS.join(", ")}`);
    JSON.stringify(SMS_ACTION_OPTIONS.map((k) => SMS_ACTION_LABEL[k])) ===
      JSON.stringify(["Schedule Callback", "Qualify", "Inform", "Inform & Route", "Support & Escalate"])
      ? ok("each option reads the label the capture carries")
      : bad("an action's label is not the measured one");

    /* ⚠️⚠️ THE SHAPES DIFFER MORE THAN THE NAMES DO, and this is the heart of the feature.
       Built by putting each kind on a real node and asking for its drawer. */
    const shaped = (k: ActionKind) => {
      const t = JSON.parse(JSON.stringify(tree)) as typeof tree;
      const node = t.branches[0].leaves[0].paths![0].paths![0] as Record<string, unknown>;
      Object.assign(node, nodeActionFields(k));
      const d = smsDrawerFor(p, t, "sub-0-0-0-0", cfg);
      return d?.kind === "action" ? d : null;
    };
    const callback = shaped("callback");
    const route = shaped("informRoute");
    const inform = shaped("inform");
    const esc = shaped("escalate");

    /* ⚠️ SCHEDULE CALLBACK HAS NO INSTRUCTION BOX AT ALL — Description, its fixed signal, then
       What To Collect. `SMS_ACTION_PROMPT` has no key for it and the type says so. */
    (!("callback" in SMS_ACTION_PROMPT) && actionCopy("sms", "callback").prompt === null)
      ? ok("Schedule Callback has no instruction prompt, as measured")
      : bad("a prompt label has been invented for Schedule Callback");
    (callback?.action === "callback" && !callback.destinationPrompt)
      ? ok("Schedule Callback carries no destination row")
      : bad("Schedule Callback grew a destination row");
    SMS_CALLBACK_SIGNAL === "SMS Scheduled Callback"
      ? ok("Schedule Callback's fixed signal is the measured string")
      : bad("the callback signal string has drifted");
    /* ⚠️ ITS SIGNAL IS A CHIP, NOT A PICKER, and its label carries no "(optional)". */
    (/kind === "callback" \? \(/.test(drawerSrc) && /wnd-signal/.test(drawerSrc)
      && /\.wnd-signal\s*\{/.test(css))
      ? ok("the callback signal renders as a fixed chip rather than a combobox")
      : bad("Schedule Callback's signal is a picker again");
    JSON.stringify(collectOnSwitch("callback").map((f) => f.name)) === JSON.stringify(["Consumer Name"])
      ? ok("switching to Schedule Callback seeds What To Collect with Consumer Name")
      : bad("the callback collect default is not the measured Consumer Name");
    (["qualify", "inform", "informRoute", "escalate"] as ActionKind[])
      .every((k) => collectOnSwitch(k).length === 0)
      ? ok("switching to any other action leaves What To Collect empty, as measured")
      : bad("an action other than callback seeds collect fields on switch");

    /* ⚠️ ONLY TWO OF THE FIVE HAVE A DESTINATION, and they word it differently. */
    (route?.destinationPrompt === SMS_ROUTE_DESTINATION
      && esc?.destinationPrompt === SMS_ESCALATE_DESTINATION
      && SMS_ROUTE_DESTINATION !== SMS_ESCALATE_DESTINATION)
      ? ok("Inform & Route and Support & Escalate each carry their own destination wording")
      : bad("the two destination rows have been merged or reworded");
    (!inform?.destinationPrompt && !SMS_DESTINATION_PROMPT.inform && !SMS_DESTINATION_PROMPT.qualify)
      ? ok("plain Inform still has no destination row, which is what separates it from Inform & Route")
      : bad("Inform grew a destination row");

    /* every description verbatim */
    const descs: [ActionKind, string][] = [
      ["callback", "Your agent will find a time and send the user a priority number to call back during business hours. This carries over all digital attribution from the initial text engagement (and the call that originally triggered the SMS)."],
      ["informRoute", "The agent will answer the users' question and guide them to the right next step — a link, phone number, or resource."],
      ["inform", "Provide information to the caller."],
    ];
    descs.every(([k, v]) => SMS_ACTION_DESCRIPTION[k] === v)
      ? ok("each new action's Description is the capture's own copy")
      : bad("an action Description has drifted from the capture");
    SMS_ACTION_PROMPT.informRoute === "How should the agent inform and route users?"
      ? ok("Inform & Route asks the SMS question, not the voice one")
      : bad("Inform & Route's prompt is not the measured SMS wording");

    /* ⚠️⚠️ THE NODE'S ACTION TEXT *IS* THE DRAWER'S LABEL, by construction rather than by care. */
    (SMS_ACTION_OPTIONS as ActionKind[]).every((k) => nodeActionFields(k).action === SMS_ACTION_LABEL[k])
      ? ok("a node's action text is the same value as its drawer's label for all five")
      : bad("a node's action text can disagree with its drawer's label again");

    /* ⚠️⚠️ THE ID TABLES MUST NOT SHADOW THE NODE — the bug the first working build shipped:
       `sub-0-0-0-0` is in `SMS_INFORM`, so a node switched to Schedule Callback drew correctly
       and REOPENED AS INFORM. */
    callback?.action === "callback"
      ? ok("a template node switched to another action opens THAT action's drawer")
      : bad("an id table is shadowing the node's own action again");
    /* and the wording fallback must not let "Inform & Route" fall into plain inform */
    {
      const t = JSON.parse(JSON.stringify(tree)) as typeof tree;
      const n = t.branches[0].leaves[0].paths![0].paths![0] as Record<string, unknown>;
      n.action = "Inform & Route"; delete n.actionKind;
      const d = smsDrawerFor(p, t, "sub-0-0-0-0", cfg);
      (d?.kind === "action" && d.action === "informRoute")
        ? ok("a node whose wording says Inform & Route is not read as plain Inform")
        : bad("the wording fallback swallows Inform & Route into inform");
    }

    /* ⚠️⚠️ RE-AIMED THE SAME DAY IT WAS WRITTEN, ON THE USER'S OWN INSTRUCTION — *"add the drop
       and the screen to ANY action context drawer… and make sure all those fields in the drawer
       is editable as well"*, with both LOCKED chrome drawers selected. So a locked leaf now DOES
       offer the picker, and the check has to assert what the lock still means rather than what
       it used to: the four boxes' NAMES stay un-editable, which is what was actually reported
       back in August, and `editGuard` still refuses those. Deleting the check instead would
       have left nothing watching either half. */
    const lockedLeaf = smsDrawerFor(p, tree, "path-1-0-2", cfg);
    (lockedLeaf?.kind === "action" && !!lockedLeaf.actionSlot)
      ? ok("every action drawer offers the picker, locked chrome leaves included")
      : bad("a locked leaf still has no action picker");
    (isLockedEdit(tree, "branches.1.leaves.0.title")
      && isLockedEdit(tree, "branches.1.leaves.0.subtitle"))
      ? ok("a locked leaf's NAME is still refused, which is what the lock was always about")
      : bad("the chrome boxes can be renamed again");
    (inform?.actionSlot?.path === "branches.0.leaves.0.paths.0.paths"
      && inform?.actionSlot?.index === 0)
      ? ok("a configurable node's slot points at its own containing array")
      : bad("the action slot does not resolve to the node's own position");
    /* ⚠️ THE WRITE IS THE CONTAINING ARRAY, the one shape already proven by `segments`. */
    /actionSlot\.path|const \{ path, index, nodes \} = d\.actionSlot/.test(drawerSrc)
      ? ok("the action writes through the containing array rather than a deeper per-field path")
      : bad("the action write no longer goes through the proven array path");

    /* the picker is read-only where there is nowhere to write (every voice drawer) */
    /const canPick = live && !!d\.actionSlot;/.test(drawerSrc)
      ? ok("the picker needs a slot, so the voice drawers keep their static combobox")
      : bad("the action picker is no longer gated on having somewhere to write");
    /* ⚠️ the voice copy tables stay keyed on the three the voice captures measured */
    /ACTION_LABEL: Record<VoiceActionKind, string>/.test(dr)
      ? ok("the voice tables are keyed on the three voice kinds, so none was invented for voice")
      : bad("voice copy has been invented for the SMS-only actions");

    /* the two new tints, scoped, plus the lowercase class */
    (/\.wf-v2 \.wf-act-informroute\s*\{/.test(css) && /\.wf-v2 \.wf-act-callback\s*\{/.test(css)
      && /#33e5c9/i.test(css) && /#2cbf58/i.test(css) && /#007e73/i.test(css) && /#0d5400/i.test(css))
      ? ok("both new actions are tinted from the titan palette, scoped to .wf-v2")
      : bad("a new action's tint is missing or unscoped");
    /wf-act-\$\{k\.toLowerCase\(\)\}/.test(treeSrc)
      ? ok("the action class is lowercased, so informRoute cannot yield a camelCase selector")
      : bad("actClass no longer lowercases, so .wf-act-informRoute would never match");

    /* the captures are in the repo */
    (["schedule-callback", "qualify", "inform", "inform-route", "support-escalate"]
      .every((n) => fs.existsSync(`reference/agent-workflow/sms-action-${n}.html`)))
      ? ok("all five Action captures are in the repo")
      : bad("an Action capture is missing from reference/agent-workflow");
  }

  /* ---- every field in an action drawer is editable (9/17/2026) ---------------------
     Asked for with both LOCKED chrome drawers selected: "add the drop and the screen to any
     action context drawer… and make sure all those fields in the drawer is editable as well". */
  {
    const drawerSrc = readAny("src/components/WorkflowNodeDrawer.tsx");
    const guard = readAny("src/data/editGuard.ts");

    /* ⚠️⚠️ THE DESTINATION IS A TEXT INPUT, NOT THE COMBOBOX WE HAD INVENTED. Measured
       `<input name=destination type=text>` with these placeholders in BOTH the original capture
       and the switched ones. */
    (SMS_DESTINATION_PLACEHOLDER.escalate === "e.g. https://yourwebsite.com/support or +1-800-555-0100"
      && SMS_DESTINATION_PLACEHOLDER.informRoute === "e.g. https://yourwebsite.com/signup or +1-800-555-0100")
      ? ok("the destination carries the capture's own placeholder for each action")
      : bad("a destination placeholder is not the measured one");
    !/Select a destination\.\.\./.test(readCode("src/components/WorkflowNodeDrawer.tsx"))
      ? ok("the invented 'Select a destination...' combobox is gone")
      : bad("the destination is a fabricated combobox again");

    const esc = smsDrawerFor(p, tree, "path-1-0-2", cfg);
    (esc?.kind === "action" && esc.destinationPlaceholder && esc.edits?.destination
      && /^sms\.extra__path-1-0-2__destination$/.test(esc.edits.destination))
      ? ok("the destination has somewhere to write, on a flat key whose parent exists")
      : bad("the destination is editable with nowhere to write, or writes to a nested path");

    /* ⚠️ THE SIGNAL OPTIONS ARE THE PROSPECT'S OWN, off the Signal Manager list. */
    const sigs = signalOptions(p);
    (sigs.length >= 5 && esc?.kind === "action"
      && JSON.stringify(esc.signalChoices) === JSON.stringify(sigs))
      ? ok(`the signal picker offers this prospect's own ${sigs.length} signals`)
      : bad("the signal options are not the prospect's own");
    (esc?.kind === "action" && esc.edits?.signal === "sms.extra__path-1-0-2__signal")
      ? ok("the chosen signal has somewhere to write")
      : bad("the signal picker writes nowhere");
    {
      /* a prospect with no Signal Manager slice offers none rather than inventing a list */
      const bare = JSON.parse(JSON.stringify(p)) as typeof p;
      delete (bare.reports as { signalManager?: unknown }).signalManager;
      signalOptions(bare).length === 0
        ? ok("a prospect with no Signal Manager offers no signals rather than invented ones")
        : bad("signals are invented for a prospect that has none");
    }

    /* ⚠️⚠️ THE COLLECT LIST *IS* THE NODE'S `chips`, NOT A SECOND COPY — the first build stored
       it under its own key and the DIAGRAM'S PILLS DID NOT MOVE when a field was added, which is
       the two-sources-for-one-fact failure this file records repeatedly. */
    (!/extra__\$\{nodeId\}__collect|edits\.collect/.test(readAny("src/data/workflowDrawers.ts"))
      && /next\.chips = draft\.collect/.test(drawerSrc))
      ? ok("the collect list writes the node's own chips, so the pills always agree with it")
      : bad("What To Collect is stored apart from the pills again");
    !/__collect\$/.test(guard)
      ? ok("no dead guard pattern left behind for the retired collect key")
      : bad("the guard still carries a pattern for a key nothing writes");
    /* the chips the template configures still reach the drawer, with their help text */
    const inf = smsDrawerFor(p, tree, "sub-0-0-0-0", cfg);
    (inf?.kind === "action" && (inf.collect?.length ?? 0) >= 4
      && inf.collect!.every((f) => !!f.help))
      ? ok("a template node's configured collect fields still render with their help text")
      : bad("a configured collect field lost its help line");
    /* ⚠️ AND EVERY ONE OF THEM IS REMOVABLE — the × was drawn from the start and did nothing. */
    /wnd-chip-x/.test(drawerSrc) && /\.wnd-chip-x\s*\{/.test(readAny("src/styles/app.css"))
      ? ok("each collect chip's × is a real button")
      : bad("the collect chip's × is decorative again");
    /* an already-added field is not offered twice */
    /\.filter\(\(n\) => !\(live && !!d\.actionSlot \? draft\.collect : /.test(drawerSrc)
      ? ok("a field already on the node is not offered again")
      : bad("the info-field picker can add the same field twice");
    infoFieldOptions(p).some((f) => f.name === "Consumer Name")
      ? ok("Consumer Name is offered, as the Schedule Callback capture shows it seeded")
      : bad("the measured Consumer Name field is not offered");

    /* ONE combobox component for all three, and all three close on pick */
    (drawerSrc.match(/<Combo\s/g) ?? []).length === 3
      ? ok("one Combo serves the action, the signal and the info field")
      : bad("the three pickers are no longer one component");
    (drawerSrc.match(/setOpenCombo\(null\)/g) ?? []).length >= 3
      ? ok("every picker closes when something is chosen")
      : bad("a picker stays open after a selection");
    /openId={openCombo}/.test(drawerSrc) && !/const \[pick, setPick\]/.test(drawerSrc)
      ? ok("one open-picker id, so opening one list closes the others")
      : bad("the pickers track their open state separately again");
  }

  /* ---- the config is bi-directional (9/17/2026) ------------------------------------
     Asked for directly: "can we make the config bi directional, so if there are changes in the
     workflow, it also changes it in actual preview agent or preview workflow, and vice versa, if
     i use ask AI to make changes, it should make those changes in the workflow."
     ⚠️ MEASURED FIRST: the built-in workflow reached the agent NOWHERE. */
  {
    const phone = readCode("src/screens/PhonePreview.tsx");
    const chat = readCode("src/components/WorkflowChatPreview.tsx");
    const drawer = readCode("src/components/AiAssistantDrawer.tsx");
    const ctxSrc = readCode("src/data/AiAssistantContext.tsx");

    /* ⚠️⚠️ THE FLOW IS DERIVED THROUGH THE DRAWER BUILDER, so the agent is told exactly what the
       SE reads on screen. A second walk of the config is how the two come to disagree. */
    const flow = smsWorkflowFlow(p, tree as never, cfg);
    (flow?.intents?.length === 2 && flow.intents[0].flow.length === 1)
      ? ok("the workflow's own config derives into a flow the agent can be given")
      : bad("the workflow no longer derives into a flow");
    const root = flow!.intents[0].flow[0];
    (root.question === cfg.qualify.root.question && root.action === "Qualify")
      ? ok("the derived flow carries the node's configured question and its action")
      : bad("the derived flow has drifted from the node's own config");
    const kid = root.answers?.[0];
    (kid?.answers?.[0]?.instruction === cfg.inform.serviceableYes
      && (kid?.answers?.[0]?.collect?.length ?? 0) > 0)
      ? ok("and the inform instruction and collect list three rows down")
      : bad("the deeper rows' instructions or collect lists are missing from the flow");
    (flow!.intents[0].looksLike === cfg.intents.sales.looksLike)
      ? ok("both intents' classification copy reaches the flow")
      : bad("the intents' looks-like copy is missing");

    /* ⚠️ AN EDIT MOVES IT — the whole point. */
    {
      const edited = JSON.parse(JSON.stringify(cfg)) as typeof cfg;
      edited.qualify.root.question = "Probe: termites?";
      edited.inform.serviceableYes = "Probe: a tech calls within the hour.";
      const f2 = smsWorkflowFlow(p, tree as never, edited)!;
      const r2 = f2.intents[0].flow[0];
      (r2.question === "Probe: termites?"
        && r2.answers![0].answers![0].instruction === "Probe: a tech calls within the hour.")
        ? ok("editing a node's question or instruction moves what the agent is told")
        : bad("an edited node does not change the agent's flow");
    }

    /* ⚠️ IT REACHES THE PROMPT, and an EXTRA workflow's does not (it states its own flow). */
    const brain = buildSmsBrain(p, p.reports.agentConfig!, undefined, null, flow);
    (brain as { workflow?: unknown }).workflow
      ? ok("the built-in workflow's flow is on the brain the previews send")
      : bad("the flow never reaches the brain");
    const extraBrain = buildSmsBrain(p, p.reports.agentConfig!,
      { slug: "x", label: "x", channel: "SMS", status: "Live", triggeredBy: "x",
        startLabel: "x", branches: [] } as never, null, flow);
    !(extraBrain as { workflow?: unknown }).workflow
      ? ok("an extra workflow gets none of it, so one conversation never has two flows")
      : bad("an extra workflow is handed a second flow as well as its own");
    const prompt = smsSystemPromptForAudit(brain as never);
    (/CONFIGURED WORKFLOW/.test(prompt) && prompt.includes(cfg.qualify.root.question)
      && prompt.includes(cfg.inform.serviceableYes))
      ? ok("the prompt carries the configured workflow, questions and instructions included")
      : bad("the configured workflow is missing from the built prompt");
    /* ⚠️ AND IT MUST NOT CLAIM TO WIN. Declaring precedence beside the sales arc would be two
       competing flows for one conversation — the self-contradicting prompt this file records. */
    (/does not replace the conversation flow above/.test(prompt)
      && !/CONFIGURED WORKFLOW[\s\S]{0,240}THIS SECTION WINS/.test(prompt))
      ? ok("the workflow block enriches the sales flow rather than declaring it wins")
      : bad("the workflow block fights the conversation flow it sits beside");
    const bare = smsSystemPromptForAudit(buildSmsBrain(p, p.reports.agentConfig!) as never);
    !/CONFIGURED WORKFLOW/.test(bare)
      ? ok("a brain with no workflow builds the prompt exactly as before")
      : bad("the workflow block leaks into a prompt that has no workflow");

    /* ⚠️⚠️ NOTHING IS ASKED TWICE. The voice agent's re-asking of ZIP and name is already in
       this file; the workflow's nodes collect a zip, so feeding the script in untouched
       reproduces it on SMS. */
    {
      const qs = p.reports.agentConfig!.smsPlaybook!.qualifyingQuestions;
      const withWf = smsSystemPromptForAudit(brain as never);
      const zipQ = qs.find((q) => /zip/i.test(q));
      (zipQ && !withWf.includes(zipQ) && bare.includes(zipQ))
        ? ok("a question the workflow already collects is dropped from the numbered script")
        : bad("the agent asks for something the workflow already gathered");
      const keep = qs.filter((q) => !/zip/i.test(q));
      keep.every((q) => withWf.includes(q))
        ? ok("every genuinely distinct question survives the dedupe")
        : bad("the dedupe is eating questions the workflow does not cover");
    }

    /* ---- the plumbing, both ways ---- */
    const oneKey = /SMS_WORKFLOW_SCOPE_PATH = "\/agent-studio\/agent\/workflow\/sms"/
      .test(readCode("src/data/smsBrain.ts"));
    (oneKey && phone.includes("SMS_WORKFLOW_SCOPE_PATH") && chat.includes("SMS_WORKFLOW_SCOPE_PATH"))
      ? ok("one definition of the workflow's scope key, read by both previews")
      : bad("a preview builds the workflow scope key itself — one side will read a key nobody writes");
    (/smsWorkflowFlow\(/.test(phone) && /smsWorkflowFlow\(/.test(chat))
      ? ok("both previews derive the flow, so they cannot disagree about the agent")
      : bad("only one preview obeys the workflow");
    /workflow: undefined/.test(chat)
      ? ok("a created (empty) workflow's preview is still given no flow")
      : bad("an empty workflow previews a flow its diagram shows nothing of");

    /* ⚠️⚠️ ASK AI'S EDITS GO TO THE SCOPE THAT OWNS THE FIELD, NOT A SECOND COPY. */
    (/linkKey\?: string;/.test(ctxSrc) && /linkAs\?: string;/.test(ctxSrc))
      ? ok("a scope can name another scope its Ask AI may also edit")
      : bad("the linked scope is gone, so Ask AI can only edit its own page");
    /prev\.linkKey === s\.linkKey && prev\.linkAs === s\.linkAs/.test(ctxSrc)
      && /linkKey: s\.linkKey, linkAs: s\.linkAs/.test(ctxSrc)
      ? ok("registerScope carries the link in BOTH the equality test and the object")
      : bad("registerScope drops the link silently — it type-checks and never arrives");
    /* ⚠️ THE REAL FUNCTION, not a grep for one. The first version of this check asked only
       whether a router existed, and passed against a router edited to route nothing. */
    {
      const batch = [
        { path: "smsPlaybook.qualifyingQuestions", value: "[]" },
        { path: "workflow.sms.qualify.root.question", value: "\"q\"" },
      ];
      const { mine, theirs } = routeEdits(batch, "workflow");
      (mine.length === 1 && mine[0].path === "smsPlaybook.qualifyingQuestions"
        && theirs.length === 1 && theirs[0].path === "sms.qualify.root.question")
        ? ok("a workflow-prefixed edit is stripped and routed to the scope that owns it")
        : bad("a workflow edit made from the preview is stored as a copy in the preview's scope");
      const none = routeEdits(batch, undefined);
      (none.mine.length === 2 && none.theirs.length === 0)
        ? ok("a page with no linked scope keeps every edit, so no other screen changes")
        : bad("routing fires on a page that declared no link");
      /* ⚠️ A PATH THAT MERELY STARTS WITH THE WORD IS NOT A PREFIX MATCH. */
      const near = routeEdits([{ path: "workflowNotes" }], "workflow");
      near.mine.length === 1
        ? ok("the prefix test needs the dot, so `workflowNotes` stays on this page")
        : bad("the prefix match is a bare substring and would steal a sibling field");
      /applyEditsRouted\(/.test(drawer) && /routeEdits\(edits, active\.linkAs\)/.test(drawer)
        ? ok("and the drawer applies its batches through it")
        : bad("the drawer no longer routes its edits");
    }
    /\[active\.linkAs\]: linked/.test(drawer)
      ? ok("and the model is shown that scope's data under the prefix it must use")
      : bad("the model cannot see the workflow it is being asked to change");
    /* ⚠️ THE CONTEXT CAP ATE IT ONCE — 12,012 characters, the workflow sliced off the end and
       the JSON left unterminated. */
    /const CAP = 40000;/.test(drawer) && /\{ \[active\.linkAs\]: _dropped, \.\.\.own \}/.test(drawer)
      ? ok("the context cap fits the workflow, and degrades by dropping it rather than slicing")
      : bad("the context can be truncated into malformed JSON again");
    phone.includes("linkAs: \"workflow\"") && !/linkAs: "workflow"[\s\S]{0,80}branches/.test(phone)
      ? ok("the preview exposes the workflow's TEXT config, not structural control of the tree")
      : bad("the preview's Ask AI can restructure the diagram, which the geometry cannot draw");
  }

  /* ---- the voice workflow's drawers, on request (9/21/2026) ------------------------
     "i dont see the updated stuff in the voice workflow" — the picker, editable fields and
     Add, mirrored onto voice. The tree itself must NOT change: that was the one constraint. */
  {
    /* ⚠️ A REAL VOICE TREE, not the SMS template. The first version of these checks reused
       `smsBranches`, whose path nodes carry no chips — so the per-node collect check compared
       against an empty list and failed on correct code. Same shape as `auditTreePaths` in
       audit-voice.ts, which exists for exactly this reason. */
    const vspec = voiceSpecFor(p);
    const ucNode = (u: { title: string; collect: string[]; route?: string }) => ({
      title: u.title, action: "Inform & Route", chips: u.collect,
      ...(u.route ? { route: u.route } : {}),
    });
    const vTree = { variant: "voice" as const, triggeredBy: "2 campaigns and 0 forms",
      startLabel: "Voice · classify intent",
      branches: [
        { title: "Sales Inquiry", subtitle: vspec.intent.split("\n")[0],
          leaves: [{ title: "All Sales Inquiry Users", action: "Qualify",
            paths: vspec.useCases.sales.map(ucNode) }] },
        { title: "Need Support", subtitle: "Existing customer",
          leaves: [{ title: "All Support Users", action: "Support & Escalate" }] },
      ] };
    const q = drawerFor(p, vTree as never, "leaf-0-0");
    const esc = drawerFor(p, vTree as never, "leaf-1-0");
    const page = readCode("src/screens/AgentWorkflow.tsx");
    const spec = readCode("src/data/voiceAgentSpec.ts");
    const chatSrc = readCode("engine/chat.ts");

    /* every voice action drawer can be applied at all */
    /onApply=\{smsTemplated \|\| \(!isSms && !created\)/.test(page)
      ? ok("the built-in voice workflow's drawers can Apply")
      : bad("voice drawers are read-only again, or a created workflow gained an Apply");
    (q?.kind === "action" && !!q.actionSlot && esc?.kind === "action" && !!esc.actionSlot)
      ? ok("both voice chrome leaves offer the action picker, as on SMS")
      : bad("a voice leaf has no action slot");
    (q?.kind === "action" && q.edits?.segments === "branches.0.leaves.0.paths"
      && (q.segmentNodes?.length ?? 0) > 0)
      ? ok("Add on a voice Qualify writes the tree's own child nodes")
      : bad("Add on voice writes a list of strings, so a new answer would not draw");

    /* ⚠️⚠️ EVERY WRITE GOES SOMEWHERE THE AGENT READS — the whole point, and the thing that
       separates this from a drawer full of controls that change nothing spoken. */
    (esc?.kind === "action" && esc.edits?.handling === "agent.escalateHandling")
      ? ok("the escalation instruction has a home instead of being a literal in the drawer")
      : bad("the escalation instruction is a dead control again");
    /escalateHandling\?: string;/.test(spec) && /DEFAULT_ESCALATE_HANDLING/.test(spec)
      ? ok("and one definition of its default, shared by the drawer and the prompt")
      : bad("the escalation default is duplicated or gone");
    /* ⚠️ IT MUST REACH THE **PATHS-DRIVEN** FLOW. The first build put it only in the hardcoded
       fallback, which is emitted exactly when a prospect has no use cases — i.e. for none of
       them, making the field dead on every real workflow. */
    (chatSrc.match(/brain\.voiceEscalate/g) ?? []).length >= 2
      ? ok("the escalation instruction reaches both the configured and the fallback flow")
      : bad("the escalation instruction only reaches one flow — dead on the other");
    /* ⚠️⚠️ A USE CASE'S DRAWER DESCRIBES **THAT** USE CASE. Reported against the last row: the
       node drew "Consumer Name, Service Address, Timeline" and its drawer listed the generic
       Consumer Zip / Consumer Name, so the diagram and the drawer disagreed about one node. */
    {
      const uc0 = drawerFor(p, vTree as never, "path-0-0-0");
      const uc1 = drawerFor(p, vTree as never, "path-0-0-1");
      const chipsOf = (id: string) => {
        const seg = id.match(/^path-(\d+)-(\d+)-(\d+)$/)!;
        return (vTree.branches[+seg[1]].leaves[+seg[2]].paths?.[+seg[3]] as { chips?: string[] })?.chips ?? [];
      };
      (uc0?.kind === "action"
        && JSON.stringify(uc0.collect?.map((f) => f.name)) === JSON.stringify(chipsOf("path-0-0-0")))
        ? ok("a use case's What To Collect is its own node's chips")
        : bad("a use case's drawer lists a generic collect table, contradicting its node");
      (uc0?.kind === "action" && uc1?.kind === "action"
        && JSON.stringify(uc0.collect) !== JSON.stringify(uc1.collect))
        ? ok("and two different use cases show two different lists")
        : bad("every use case shows the same collect list");
      /* ⚠️ THE SHARED STEP BOX IS USUALLY EMPTY — `informSteps` is only the service-area gate,
         so 10 of the 15 profiles have none. A bare empty box reads as broken. */
      (uc0?.kind === "action" && !!uc0.handlingPlaceholder)
        ? ok("the shared routing-steps box names what belongs in it when unset")
        : bad("an unconfigured instruction box renders blank with no hint");
    }
    /* ⚠️⚠️ **RE-AIMED 9/21/2026, NOT LOOSENED.** This used to assert every use case writes the
       SAME shared `agent.informSteps` list — which was the exact bug reported: editing one
       use case's instruction rewrote it on every other one, because there was only one flat
       list for all of them to share. The invariant that survives is stronger: a use case's
       instruction now writes its OWN flat key, as a string (not the shared array), and that
       string has to actually reach the built PROMPT for the node that has it and be absent
       from a node that does not — proven by building the real prompt, not by reading a path
       string. */
    {
      const uc0 = drawerFor(p, vTree as never, "path-0-0-0");
      (uc0?.kind === "action" && typeof uc0.edits?.handling === "string"
        && /^agent\.extra__path-0-0-0__handling$/.test(uc0.edits.handling) && !uc0.handlingList)
        ? ok("a use case's instruction writes its OWN per-node key, as a string")
        : bad("a use case writes the shared step list again, or as an array");

      const paths = treeToVoicePaths({
        variant: "voice",
        agent: { "extra__path-0-0-0__handling": "SENTINEL_INSTRUCTION_ONLY_ON_PATH_0" },
        branches: [{ title: "Sales Inquiry", leaves: [{ title: "All Sales Inquiry Users", action: "Qualify",
          paths: [
            { title: "A", action: "Inform & Route", chips: ["Consumer Name"], route: "Team A" },
            { title: "B", action: "Inform & Route", chips: ["Consumer Name"], route: "Team B" },
          ] }] }],
      } as never);
      const prompt = __buildVoiceSystemForTest({ customerName: "Audit Co", voicePaths: paths } as never);
      const hits = prompt.split("SENTINEL_INSTRUCTION_ONLY_ON_PATH_0").length - 1;
      hits === 1
        ? ok("and that instruction reaches the built prompt, exactly once, on its own node")
        : bad(`a per-node instruction reached the prompt ${hits} times, not exactly once`);
    }

    /* ⚠️⚠️ AND THE TREE ITSELF IS UNTOUCHED — the one thing that was asked to stay put. */
    const css = readAny("src/styles/app.css");
    !/\.wf-act-[a-z]+\s*\{/.test(css.replace(/\.wf-v2 \.wf-act-[a-z]+/g, ""))
      ? ok("the SMS action tints are still scoped to .wf-v2, so voice nodes are unstyled by them")
      : bad("an action tint escaped .wf-v2 and would repaint the voice tree");
    /* ⚠️ `marker-end` IS AN ATTRIBUTE, so no stylesheet scope can keep it off another diagram —
       only this conditional can. Measured in the browser too: the voice tree renders 0 markers. */
    /\.\.\.\(arrows \? \{ markerEnd:/.test(readCode("src/components/WorkflowTree.tsx"))
      ? ok("arrowheads are still opt-in, so the voice diagram keeps none")
      : bad("arrowheads are no longer gated and would appear on the voice tree");
  }

  /* ---- the sixth row's geometry ---- */
  {
    let bad6 = 0, shortest = Infinity;
    for (const t of [40, 65, 93, 140, 400]) for (const st of [40, 69, 120]) {
      for (const it of [46, 93, 180]) for (const lf of [56, 81, 160]) {
        const R = rowLayout("smsV2", { trigger: t, start: st, intent: it, leaf: lf, path: lf },
          { split: false, paths: true, subs: true });
        const gaps = [R.startTop - R.triggerBottom, R.busY - R.startBottom,
          R.intentTop - R.busY, R.leafTop - R.intentBottom, R.leafBusY - R.leafBottom,
          R.pathTop - R.leafBusY, R.pathBusY - R.pathBottom, R.subTop - R.pathBusY];
        for (const g of gaps) { if (g < 0) bad6++; shortest = Math.min(shortest, g); }
      }
    }
    bad6 === 0 && shortest >= 0
      ? ok(`no connector inverts on the six-row tree (135 combinations, shortest ${shortest})`)
      : bad(`${bad6} inverted connectors on the six-row tree (shortest ${shortest})`);
    /* ⚠️ THE SIXTH ROW IS GATED, or every tree with a use-case row would grow two rows it never
       draws — `rowAt` mutates the shared shift, the trap this file already records. */
    const off = rowLayout("sms", { trigger: 65, start: 65, intent: 64, leaf: 88 },
      { split: false, paths: true });
    off.pathBusY === 0 && off.subTop === 0 && off.pathBottom === 0
      ? ok("a tree with no sub-row gets no sixth-row geometry at all")
      : bad("the sixth row is computed for a tree that does not draw it");
  }
}

console.log(fail ? `\n${fail} check(s) failed\n` : "\nAll AI-rule checks passed\n");
process.exit(fail ? 1 : 0);
