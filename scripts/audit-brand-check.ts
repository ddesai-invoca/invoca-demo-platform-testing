/* =============================================================================
   audit-brand-check — the pre-build name/website check (engine/brandCheck.ts).
   Run with `npm run audit:brand` (and by `npm run audit`). Offline: only the pure
   matcher is exercised, so it needs no network.
   Both directions matter: it must fire on the Halstead typo AND stay silent on
   correct pairs, or SEs learn to click past the warning.
   ============================================================================= */
import { compareBrand, distinctiveTokens } from "../engine/brandCheck.ts";

let fail = 0;
const check = (cond: unknown, msg: string) => { console.log(`  ${cond ? "ok  " : "FAIL"}  ${msg}`); if (!cond) fail++; };
const codes = (name: string, host: string, text: string) => compareBrand(name, host, text).map((w) => w.code);

// The reported case: right name, one-letter-off domain that is a real, different site.
check(codes("Halstead Plumbing", "halstedplumbing.com", "Halsted Plumbing | Chicago").join() === "likely-typo",
  "Halstead vs halstedplumbing.com is flagged as a likely typo");
check(compareBrand("Halstead Plumbing", "halstedplumbing.com", "Halsted Plumbing")[0]?.message.includes("halstead"),
  "the warning names the token the SE typed");
// The correct site for the same name passes (possessive on the site, none in the name).
check(codes("Halstead Plumbing", "halsteadsplumbingandheating.com", "Halstead's Plumbing & Heating").length === 0,
  "the correct Halstead site is silent");
check(codes("Halstead Plumbing", "halsteadsplumbingandheating.com", "").length === 0,
  "a correct domain passes even when the page has no readable title");
// A wholly different company is a mismatch, not a typo.
check(codes("Shady Blinds", "acmeroofing.com", "Acme Roofing").join() === "name-mismatch", "an unrelated site is a name-mismatch");
// Ordinary good pairs stay silent.
check(codes("Shady Blinds", "shadyblindsnow.com", "Custom Blinds & Shades").length === 0, "Shady Blinds / shadyblindsnow.com is silent");
check(codes("Roto-Rooter Plumbing and Water Cleanup", "rotorooter.com", "Roto-Rooter").length === 0, "a hyphenated brand matches its site");
check(codes("Dignity Memorial", "dignitymemorial.com", "").length === 0, "multi-word names match a joined domain");
// A name made only of generic words has nothing to compare, so no false alarm.
check(distinctiveTokens("Plumbing Services Inc").length === 0 && codes("Plumbing Services Inc", "x.com", "Anything").length === 0,
  "an all-generic name is not checked");
// Short tokens are never 'near misses' (too many false positives).
check(codes("Ace Hardware", "bcdfoods.com", "BCD Foods").join() === "name-mismatch", "short tokens fall to name-mismatch, never likely-typo");

console.log(fail ? `\n${fail} FAILED` : "\nall ok");
process.exit(fail ? 1 : 0);
