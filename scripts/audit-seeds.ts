/* =============================================================================
   audit-seeds.ts — run the canary's data-quality rules over the demos on disk.
   -----------------------------------------------------------------------------
   `npm run audit`

   The nightly canary (engine/canary.ts) audits ONE freshly generated prospect, which
   catches a regression the day after it ships. It cannot see the demos already
   committed to the repo or already sitting in a library, and that is exactly the gap
   that let a broken Digital Journey report reach 39 demos: generation started
   inventing an app-owned `cells` field on Aug 4 and nobody looked until Aug 13.

   So this runs the SAME auditProfile() over every bundled seed, plus any local demo
   in .data/demos, and exits non-zero on failure. Same rules, no second copy to drift.

   Deliberately dependency-free and fast (no API calls, no network): it reads JSON off
   disk, so it is cheap enough to run before a push.
   ============================================================================= */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditProfile } from "../engine/canary.ts";

/* fileURLToPath, not URL.pathname — see audit-phases.ts for why. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function load(dir: string, unwrap: (j: any) => any): { name: string; profile: any }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ name: f, profile: unwrap(JSON.parse(readFileSync(join(dir, f), "utf8"))) }))
    .filter((x) => x.profile);
}

const targets = [
  ...load(join(ROOT, "src/data/generated"), (j) => j),          // bundled seeds, in git
  ...load(join(ROOT, ".data/demos"), (j) => j.profile),          // local library, git-ignored
];

if (!targets.length) {
  console.log("No demo JSON found. Nothing to audit.");
  process.exit(0);
}

let failed = 0;
for (const { name, profile } of targets) {
  const { checks, failures } = auditProfile(profile);
  if (failures.length) {
    failed++;
    console.log(`\nFAIL  ${name}  (${failures.length} of ${checks} checks)`);
    for (const f of failures) console.log(`        - ${f}`);
  } else {
    console.log(`ok    ${name}  (${checks} checks)`);
  }
}

console.log(`\n${targets.length - failed} of ${targets.length} demos pass.`);
/* Non-zero so this can gate a push or a CI step later without any rewiring. */
process.exit(failed ? 1 : 0);
