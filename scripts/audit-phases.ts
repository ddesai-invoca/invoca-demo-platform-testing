/* =============================================================================
   audit-phases.ts — the generation pipeline's two standing rules, enforced.
   -----------------------------------------------------------------------------
   `npm run audit:phases`, and it also runs as part of `npm run audit`.

   RULE 1 — INSIGHTS & ANALYTICS IS NEVER A PHASE-1 PHASE.
   Agreed with the user 2026-08-24: a demo must be usable inside five minutes, so
   Insights & Analytics is a PHASE 2 build that happens after phase 1 saves. Today it
   costs ZERO generation seconds, which is better than phase 2 — every Insights screen
   (the Summary Dashboard, Connect AI, the three Report templates, every ts- tile, the
   dashboards an SE creates) is DERIVED at render time from phase-1 data. There is no
   Insights engine phase and no Insights schema slice.

   ⚠️ WHICH IS EXACTLY WHY THIS CHECK EXISTS. "Insights costs nothing" is true because
   nobody has added a phase for it yet, and the standing architecture note describes a
   Phase 2 that WILL mint dimensions server-side. The day someone builds that, the
   cheapest thing to do is drop a thunk into `runPool` beside the other eighteen — and
   generation silently grows by however long that phase takes, on the critical path of
   every SE waiting on a demo. A prose note in CLAUDE.md does not stop that; this does.
   Same instruct-then-enforce pairing as the dash sweep and the outcome story.

   RULE 2 — EVERY PHASE IN THE POOL IS ON THE LAUNCH CHECKLIST.
   A phase missing from `BUILD_STEPS` is invisible on the live build checklist and its
   weight is missing from the progress bar, so the bar stalls on a phase the SE cannot
   see. CLAUDE.md has warned about this in prose since the checklist was built.

   Dependency-free and static: it reads the two source files, so it is as cheap as the
   seed audit and can gate a push.
   ============================================================================= */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* fileURLToPath, not URL.pathname — .pathname is percent-encoded (a space in
   the path becomes %20), which breaks readFileSync for anyone whose checkout
   lives under a path with a space (e.g. "Bulk Demo Calls"). demoStore.ts
   already gets this right; this script and audit-seeds.ts didn't. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const core = readFileSync(join(ROOT, "engine/core.ts"), "utf8");
const launch = readFileSync(join(ROOT, "src/screens/Launch.tsx"), "utf8");

const problems: string[] = [];
let checks = 0;

/* The phase-1 pool: every `phase("<key>", …)` inside the runPool([...]) call, plus the
   two serial prefix phases the pool waits on. Parsed from the source rather than
   imported, because importing engine/core.ts would need an API key and a network. */
const poolStart = core.indexOf("await runPool([");
if (poolStart < 0) {
  problems.push("could not find the runPool([...]) call in engine/core.ts — this audit is stale and is NOT checking anything");
} else {
  const poolEnd = core.indexOf("]);", poolStart);
  const pool = core.slice(poolStart, poolEnd);
  /* ⚠️ `maybe(` COUNTS TOO, AND FORGETTING IT BROKE THIS AUDIT ONCE. Agent-Studio-only
     generations wrap the 13 skippable phases as `maybe("<key>", …)` instead of
     `phase("<key>", …)`; matching only the latter dropped the count from 18 to 5, which
     the self-check below correctly reported as a broken parse. The invariant is unchanged
     — every phase in the pool, however it is wrapped — so this is re-aimed, not loosened. */
  const poolKeys = [...pool.matchAll(/(?:phase|maybe)\(\s*"([^"]+)"/g)].map((m) => m[1]);

  checks++;
  if (poolKeys.length < 10) {
    problems.push(`only ${poolKeys.length} phases parsed out of the pool — the parse is probably broken, so rule 1 is not really being checked`);
  }

  /* ⚠️ MATCH ON THE INSIGHTS SURFACE, NOT ON THE WORD "insights". Three phase-1 phases
     legitimately contain it and are NOT the Insights & Analytics tab:
       digitalInsights   the Digital Journey & Call Attribution REPORT (Reports tab)
       qmInstantInsights the QM Instant Insights DASHBOARD (Dashboards tab)
     A naive /insights/i would fail on both and get itself deleted as a false alarm,
     which is worse than no check. */
  const ALLOWED = new Set(["digitalInsights", "qmInstantInsights"]);
  const INSIGHTS_SURFACE = /(insights?Analytics|liveboard|thoughtspot|^ts[A-Z]|insightsDashboard|insightsTile|insightsReport)/i;

  checks++;
  const smuggled = poolKeys.filter((k) => !ALLOWED.has(k) && INSIGHTS_SURFACE.test(k));
  if (smuggled.length) {
    problems.push(
      `Insights & Analytics phase(s) in the PHASE-1 pool: ${smuggled.join(", ")}. ` +
      "Insights is a phase-2 build (see CLAUDE.md) so a demo is usable in under five " +
      "minutes. Derive it at render time, or run it after phase 1 saves.",
    );
  }

  /* Rule 2: the pool's keys all have a checklist row. */
  checks++;
  const stepKeys = new Set(
    [...launch.matchAll(/\{\s*key:\s*"([^"]+)"/g)].map((m) => m[1]),
  );
  const missing = poolKeys.filter((k) => !stepKeys.has(k));
  if (missing.length) {
    problems.push(
      `phase(s) missing from BUILD_STEPS in Launch.tsx: ${missing.join(", ")}. ` +
      "Their progress is invisible on the live build checklist and their weight is " +
      "missing from the progress bar.",
    );
  }

  console.log(`      phase-1 pool: ${poolKeys.length} phases, ${stepKeys.size} checklist rows`);
}

/* The budget itself lives in engine/canary.ts, which is what actually measures a real
   generation every night. Assert it is still the five minutes the user asked for, so
   nobody relaxes the budget instead of fixing a slow phase. */
checks++;
const canary = readFileSync(join(ROOT, "engine/canary.ts"), "utf8");
const budget = /BUDGET_SECONDS\s*=\s*(\d+)/.exec(canary);
if (!budget) problems.push("BUDGET_SECONDS not found in engine/canary.ts — nothing is enforcing the five-minute budget");
else if (Number(budget[1]) > 300) {
  problems.push(`BUDGET_SECONDS is ${budget[1]}, above the agreed 300s (five minutes)`);
}

if (problems.length) {
  console.log(`\nFAIL  generation phases  (${problems.length} of ${checks} checks)`);
  for (const p of problems) console.log(`        - ${p}`);
  process.exit(1);
}
console.log(`ok    generation phases  (${checks} checks)`);
