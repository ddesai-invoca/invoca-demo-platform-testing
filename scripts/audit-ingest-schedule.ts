/* =============================================================================
   audit-ingest-schedule — the Ingest-O-Matic cadence math, the fiddliest logic
   in that feature, checked against a full year plus month/year boundaries.
   -----------------------------------------------------------------------------
   Run with `npm run audit:ingest-schedule` (and by `npm run audit`).
   ============================================================================= */
import { computeScheduledRange, validateAdhocRange } from "../engine/ingestOrchestrator.ts";

let fail = 0;
const bad = (msg: string) => { console.log(`  FAIL  ${msg}`); fail++; };
const ok = (msg: string) => console.log(`  ok    ${msg}`);
const check = (cond: unknown, msg: string) => (cond ? ok(msg) : bad(msg));

const d = (s: string) => new Date(`${s}T12:00:00`); // noon, clear of any TZ edge

console.log("daily:");
check(JSON.stringify(computeScheduledRange("daily", d("2026-09-22"))) === JSON.stringify({ start: "2026-09-21", end: "2026-09-21" }),
  "fires every day, requesting the previous calendar day");
check(JSON.stringify(computeScheduledRange("daily", d("2026-01-01"))) === JSON.stringify({ start: "2025-12-31", end: "2025-12-31" }),
  "crosses a year boundary correctly");

console.log("monthly:");
check(computeScheduledRange("monthly", d("2026-09-15")) === null, "does not fire on a non-1st day");
check(JSON.stringify(computeScheduledRange("monthly", d("2026-09-01"))) === JSON.stringify({ start: "2026-08-01", end: "2026-08-31" }),
  "on Sep 1, requests Aug 1-31");
check(JSON.stringify(computeScheduledRange("monthly", d("2026-03-01"))) === JSON.stringify({ start: "2026-02-01", end: "2026-02-28" }),
  "Feb (non-leap) has 28 days");
check(JSON.stringify(computeScheduledRange("monthly", d("2028-03-01"))) === JSON.stringify({ start: "2028-02-01", end: "2028-02-29" }),
  "Feb (leap year 2028) has 29 days");
check(JSON.stringify(computeScheduledRange("monthly", d("2026-01-01"))) === JSON.stringify({ start: "2025-12-01", end: "2025-12-31" }),
  "Jan 1 requests the previous December");

console.log("biweekly:");
check(computeScheduledRange("biweekly", d("2026-09-10")) === null, "does not fire on a non-1st/15th day");
check(JSON.stringify(computeScheduledRange("biweekly", d("2026-09-01"))) === JSON.stringify({ start: "2026-08-15", end: "2026-08-31" }),
  "on Sep 1, requests Aug 15-31");
check(JSON.stringify(computeScheduledRange("biweekly", d("2026-09-15"))) === JSON.stringify({ start: "2026-09-01", end: "2026-09-14" }),
  "on Sep 15, requests Sep 1-14");
check(JSON.stringify(computeScheduledRange("biweekly", d("2026-01-01"))) === JSON.stringify({ start: "2025-12-15", end: "2025-12-31" }),
  "Jan 1 crosses into the previous December's second half");

console.log("weekly:");
for (const day of [1, 8, 22, 28]) {
  check(computeScheduledRange("weekly", d(`2026-09-${String(day).padStart(2, "0")}`)) !== null, `fires on the ${day}${day===1?"st":day===22?"nd":"th"}`);
}
check(computeScheduledRange("weekly", d("2026-09-10")) === null, "does not fire on an off-anchor day");
check(JSON.stringify(computeScheduledRange("weekly", d("2026-09-08"))) === JSON.stringify({ start: "2026-09-01", end: "2026-09-07" }),
  "on the 8th, requests the 1st-7th");
check(JSON.stringify(computeScheduledRange("weekly", d("2026-09-01"))) === JSON.stringify({ start: "2026-08-25", end: "2026-08-31" }),
  "on the 1st, requests the preceding 7 days into the previous month");

console.log("validateAdhocRange:");
const today = d("2026-09-22");
check(validateAdhocRange("2026-09-01", "2026-09-10", today).ok === true, "a normal recent range is valid");
check(validateAdhocRange("2026-09-10", "2026-09-01", today).ok === false, "start after end is rejected");
check(validateAdhocRange("2026-09-01", "2026-09-25", today).ok === false, "an end date in the future is rejected");
check(validateAdhocRange("2024-10-01", "2024-10-05", today).ok === true, "just under 2 years old is valid");
check(validateAdhocRange("2024-08-01", "2024-08-05", today).ok === false, "more than 2 years old is rejected");
check(validateAdhocRange("not-a-date", "2026-09-10", today).ok === false, "a malformed date is rejected, not thrown");

console.log(fail ? `\n${fail} ingest-schedule check(s) failed\n` : "\nAll ingest-schedule checks passed\n");
process.exit(fail ? 1 : 0);
