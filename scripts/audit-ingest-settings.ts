/* =============================================================================
   audit-ingest-settings — Phase 2 of Demo Call Ingest-O-Matic: per-network
   cadence/trend/volume settings, the settings-change classifier, the upload-
   count math, and the real trend_batch.py script's ID-uniqueness guarantee.
   -----------------------------------------------------------------------------
   Run with `npm run audit:ingest-settings` (and by `npm run audit`).
   ============================================================================= */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isFiringDay, computeScheduledRange } from "../engine/ingestOrchestrator.ts";
import {
  classifySettingsChange, applySettingsAction, computeTotalUploads,
  type NetworkSettings, type Cadence, type TrendPeriod,
} from "../engine/ingestNetworkSettings.ts";
import { NETWORKS, agentDir } from "../engine/ingestAgentPaths.ts";
import { DATA_DIR } from "../engine/demoStore.ts";

let fail = 0;
const bad = (msg: string) => { console.log(`  FAIL  ${msg}`); fail++; };
const ok = (msg: string) => console.log(`  ok    ${msg}`);
const check = (cond: unknown, msg: string) => (cond ? ok(msg) : bad(msg));

function baseSettings(over: Partial<NetworkSettings> = {}): NetworkSettings {
  return {
    network: "finance-1752",
    cadence: "daily",
    lastActiveCadence: "daily",
    trend: "hockey-stick",
    trendPeriod: "3-months",
    callsPerUpload: 500,
    batch: { batchId: "x", generatedAt: "2026-01-01T00:00:00.000Z", settingsSnapshot: { cadence: "daily", trend: "hockey-stick", trendPeriod: "3-months", callsPerUpload: 500 }, totalUploads: 90, nextUploadIndex: 40, cycleNumber: 1, files: [] },
    generatingSince: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: { email: "a@b.com", name: "A" },
    ...over,
  };
}
const BY = { email: "admin@invoca.com", name: "Admin" };

// ---- 1. isFiringDay parity with computeScheduledRange ----------------------
console.log("isFiringDay parity:");
{
  const d = (s: string) => new Date(`${s}T12:00:00`);
  let mismatches = 0;
  for (const cadence of ["daily", "weekly", "biweekly", "monthly"] as const) {
    for (let day = 1; day <= 28; day++) {
      const date = d(`2026-09-${String(day).padStart(2, "0")}`);
      const expected = computeScheduledRange(cadence, date) !== null;
      const got = isFiringDay(cadence, date);
      if (expected !== got) mismatches++;
    }
  }
  check(mismatches === 0, "agrees with computeScheduledRange across every day of a month, all 4 cadences");
}

// ---- 2. classifySettingsChange ----------------------------------------------
console.log("classifySettingsChange:");
{
  const active = baseSettings({ cadence: "daily", lastActiveCadence: "daily" });
  check(classifySettingsChange(active, {}) === "noop", "no patch at all is a noop");
  check(classifySettingsChange(active, { cadence: "daily" }) === "noop", "patching to the same value is a noop");
  check(classifySettingsChange(active, { cadence: "off" }) === "pause", "cadence-only change to off is a pause");

  const paused = baseSettings({ cadence: "off", lastActiveCadence: "daily" });
  check(classifySettingsChange(paused, { cadence: "daily" }) === "resume", "cadence-only change back to lastActiveCadence is a resume");
  check(classifySettingsChange(paused, { cadence: "weekly" }) === "regenerate", "cadence-only change to a DIFFERENT active cadence than lastActiveCadence regenerates");

  check(classifySettingsChange(active, { trend: "random" }) === "regenerate", "a trend change alone regenerates");
  check(classifySettingsChange(active, { trendPeriod: "month" }) === "regenerate", "a trend-period change alone regenerates");
  check(classifySettingsChange(active, { callsPerUpload: 600 }) === "regenerate", "a calls-per-upload change alone regenerates");
  check(classifySettingsChange(active, { cadence: "off", trend: "random" }) === "regenerate",
    "cadence-to-off BUNDLED with another field change regenerates, not pauses");

  const neverActive = baseSettings({ cadence: "off", lastActiveCadence: null });
  check(classifySettingsChange(neverActive, { cadence: "daily" }) === "regenerate",
    "turning on a network that has never been active regenerates (no resume target exists)");
}

// ---- 3. computeTotalUploads --------------------------------------------------
console.log("computeTotalUploads:");
{
  const table: [Exclude<Cadence, "off">, TrendPeriod, number][] = [
    ["daily", "month", 30], ["daily", "3-months", 90], ["daily", "6-months", 180],
    ["weekly", "month", 4], ["weekly", "3-months", 13], ["weekly", "6-months", 26],
    ["biweekly", "month", 2], ["biweekly", "3-months", 6], ["biweekly", "6-months", 13],
    ["monthly", "month", 1], ["monthly", "3-months", 3], ["monthly", "6-months", 6],
  ];
  for (const [cadence, period, expected] of table) {
    check(computeTotalUploads(cadence, period) === expected, `${cadence} x ${period} = ${expected}`);
  }
  check(computeTotalUploads("monthly", "month") >= 1, "the degenerate monthly x month case never computes to zero");
}

// ---- 4. pause/resume leave the batch untouched ------------------------------
console.log("pause/resume round-trip:");
{
  const original = baseSettings({ cadence: "daily", lastActiveCadence: "daily" });
  const paused = applySettingsAction(original, { cadence: "off" }, "pause", BY);
  check(JSON.stringify(paused.batch) === JSON.stringify(original.batch), "pausing leaves the batch byte-identical");
  const resumed = applySettingsAction(paused, { cadence: "daily" }, "resume", BY);
  check(JSON.stringify(resumed.batch) === JSON.stringify(original.batch), "resuming leaves the batch byte-identical");
  check(resumed.batch!.nextUploadIndex === original.batch!.nextUploadIndex, "the pause/resume cursor is untouched");

  const regenerated = applySettingsAction(original, { trend: "random" }, "regenerate", BY);
  check(regenerated.batch === null, "a regenerate clears the stored batch (the orchestrator attaches a fresh one once generation finishes)");
}

// ---- 5. ID-uniqueness across a full generated batch, real script -----------
console.log("trend_batch.py ID-uniqueness (real script, scratch state dir):");
{
  const network = "finance-1752" as const;
  const dir = agentDir(network);
  const python = path.join(dir, ".venv", "bin", "python3");
  const script = path.join(dir, "trend_batch.py");
  if (!fs.existsSync(python) || !fs.existsSync(script)) {
    console.log("  skip  no .venv/trend_batch.py for finance-1752 in this checkout — nothing to exercise");
  } else {
    const realReservedPath = path.join(dir, "state", "reserved_ids.json");
    const realReservedBefore = fs.existsSync(realReservedPath) ? fs.readFileSync(realReservedPath, "utf8") : null;

    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-audit-"));
    const stateDir = path.join(scratchRoot, "state");
    const outDir = path.join(scratchRoot, "out");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "ingest_state.json"), "{}");
    fs.writeFileSync(path.join(stateDir, "reserved_ids.json"), "[]");
    try {
      const stdout = execFileSync(python, [
        script, "--cadence", "daily", "--trend", "hockey-stick", "--period", "month",
        "--calls-per-upload", "500", "--cycle-number", "1", "--out-dir", outDir, "--state-dir", stateDir,
      ], { encoding: "utf8" });
      const parsed = JSON.parse(stdout.trim().split("\n").pop()!) as { totalUploads: number; files: string[] };
      check(parsed.totalUploads === 30, "30 daily files for a 1-month batch");
      const allIds: string[] = [];
      for (const f of parsed.files) {
        const csv = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
        const header = csv[0].split(",");
        const idCol = header.indexOf("ID name");
        for (const line of csv.slice(1)) allIds.push(line.split(",")[idCol]);
      }
      check(allIds.length === 30 * 500, `${30 * 500} total rows across the batch`);
      check(new Set(allIds).size === allIds.length, "every minted ID across the whole batch is unique");

      // The scratch --state-dir must never have touched the real ledger.
      const realReservedAfter = fs.existsSync(realReservedPath) ? fs.readFileSync(realReservedPath, "utf8") : null;
      check(realReservedAfter === realReservedBefore, "the real network's state/reserved_ids.json was not touched by the scratch run");
    } catch (e) {
      bad(`real trend_batch.py invocation failed: ${(e as Error).message}`);
    } finally {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
  }
}

// ---- 6. curve math per trend type -------------------------------------------
console.log("curve math (reading generated files from a second real run):");
{
  const network = "finance-1752" as const;
  const dir = agentDir(network);
  const python = path.join(dir, ".venv", "bin", "python3");
  const script = path.join(dir, "trend_batch.py");
  if (fs.existsSync(python) && fs.existsSync(script)) {
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-audit-curve-"));
    const stateDir = path.join(scratchRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "ingest_state.json"), "{}");
    fs.writeFileSync(path.join(stateDir, "reserved_ids.json"), "[]");

    function conversionRateOf(file: string): number {
      const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      const header = rows[0].split(",");
      const answered = header.indexOf("Answered by Agent");
      const submitted = header.indexOf("Application Submitted");
      const qualified = header.indexOf("Qualified Lead");
      let answeredCount = 0, convertedCount = 0;
      for (const line of rows.slice(1)) {
        const cells = line.split(",");
        if (cells[answered] === "0") continue;
        answeredCount++;
        if (cells[submitted] === "1" || cells[qualified] === "1") convertedCount++;
      }
      return answeredCount ? convertedCount / answeredCount : 0;
    }

    function runTrend(trend: string, cycle: number): string[] {
      const outDir = path.join(scratchRoot, `out-${trend}-${cycle}`);
      const stdout = execFileSync(python, [
        script, "--cadence", "daily", "--trend", trend, "--period", "month",
        "--calls-per-upload", "300", "--cycle-number", String(cycle), "--out-dir", outDir, "--state-dir", stateDir,
      ], { encoding: "utf8" });
      return (JSON.parse(stdout.trim().split("\n").pop()!) as { files: string[] }).files;
    }

    try {
      const ramp = runTrend("gradual-increase", 1).map(conversionRateOf);
      check(ramp[0] < ramp[ramp.length - 1], "gradual-increase: last upload's conversion rate exceeds the first's");
      let nonDecreasing = true;
      for (let i = 1; i < ramp.length; i++) if (ramp[i] < ramp[i - 1] - 1e-9) nonDecreasing = false;
      check(nonDecreasing, "gradual-increase: the curve never decreases");

      const stick = runTrend("hockey-stick", 2).map(conversionRateOf);
      const flatPart = stick.slice(0, Math.floor(stick.length * 0.7));
      const flatSpread = Math.max(...flatPart) - Math.min(...flatPart);
      check(flatSpread < 0.05, "hockey-stick: the first ~70% of uploads stay flat");
      check(stick[stick.length - 1] > stick[0] + 0.1, "hockey-stick: the final upload is well above the flat baseline");

      // "random" deliberately targets no rate at all, unlike the other three
      // trends — its conversion rate across uploads should track the
      // template's own natural baseline rather than ramping or sticking.
      const randomRates = runTrend("random", 3).map(conversionRateOf);
      const randomSpread = Math.max(...randomRates) - Math.min(...randomRates);
      check(randomSpread < 0.35, "random: no deliberate ramp — upload-to-upload conversion rate stays within sampling noise, not a trend shape");

      const recoveryFiles = runTrend("answered-recovery", 5);
      function notAnsweredRateOf(file: string): number {
        const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
        const header = rows[0].split(",");
        const answered = header.indexOf("Answered by Agent");
        let na = 0;
        for (const line of rows.slice(1)) if (line.split(",")[answered] === "0") na++;
        return na / (rows.length - 1);
      }
      const recovery = recoveryFiles.map(notAnsweredRateOf);
      check(recovery[0] > recovery[recovery.length - 1], "answered-recovery: not-answered rate drops from first upload to last (mirror-image curve)");
    } catch (e) {
      bad(`curve-math real-script run failed: ${(e as Error).message}`);
    } finally {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
  } else {
    console.log("  skip  no .venv/trend_batch.py for finance-1752 in this checkout");
  }
}

// ---- 7. column-polarity handling (home-services-shaped, inverted) ----------
console.log("column-polarity handling:");
{
  const network = "home-services-2751" as const;
  const dir = agentDir(network);
  const python = path.join(dir, ".venv", "bin", "python3");
  const script = path.join(dir, "trend_batch.py");
  const cfgPath = path.join(dir, "trend_config.json");
  if (fs.existsSync(python) && fs.existsSync(script) && fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    check(cfg.notAnswered.column === "Answered by Agent" && cfg.notAnswered.value === "0",
      "home-services-2751's trend_config.json captures its inverted 'Answered by Agent' polarity ('0' means not answered, not '1')");

    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-audit-polarity-"));
    const stateDir = path.join(scratchRoot, "state");
    const outDir = path.join(scratchRoot, "out");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "ingest_state.json"), "{}");
    fs.writeFileSync(path.join(stateDir, "reserved_ids.json"), "[]");
    try {
      const stdout = execFileSync(python, [
        script, "--cadence", "weekly", "--trend", "answered-recovery", "--period", "month",
        "--calls-per-upload", "300", "--cycle-number", "1", "--out-dir", outDir, "--state-dir", stateDir,
      ], { encoding: "utf8" });
      const files = (JSON.parse(stdout.trim().split("\n").pop()!) as { files: string[] }).files;
      const firstRows = fs.readFileSync(files[0], "utf8").split("\n").filter(Boolean);
      const header = firstRows[0].split(",");
      const answeredCol = header.indexOf("Answered by Agent");
      const naCount = firstRows.slice(1).filter((l) => l.split(",")[answeredCol] === "0").length;
      check(naCount > 0 && naCount < firstRows.length - 1,
        "a real pool split against the inverted column produces both answered and not-answered rows (not everything in one bucket)");
    } catch (e) {
      bad(`polarity real-script run failed: ${(e as Error).message}`);
    } finally {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
  } else {
    console.log("  skip  no .venv/trend_batch.py/trend_config.json for home-services-2751 in this checkout");
  }
}

// ---- 8. audit-trail JSONL never carries a credential-shaped string --------
console.log("audit-trail credential scan:");
{
  const AUDIT_DIR = path.join(DATA_DIR, "ingest-run-audit");
  if (!fs.existsSync(AUDIT_DIR)) {
    console.log("  skip  no ingest-run-audit/ on this disk yet — nothing to scan");
  } else {
    const CREDENTIAL_PATTERN = /INVOCA_API_TOKEN\s*=\s*\S/;
    let leaks = 0;
    for (const name of fs.readdirSync(AUDIT_DIR)) {
      if (!name.endsWith(".jsonl")) continue;
      const text = fs.readFileSync(path.join(AUDIT_DIR, name), "utf8");
      if (CREDENTIAL_PATTERN.test(text)) leaks++;
    }
    check(leaks === 0, "no audit-trail file contains an 'INVOCA_API_TOKEN=<value>' shaped string");
  }
  // Prove the detector itself actually fires, rather than trusting an absence
  // of files to mean the check works.
  const sample = JSON.stringify({ ts: "x", summary: "oops INVOCA_API_TOKEN=abc123 leaked" });
  check(/INVOCA_API_TOKEN\s*=\s*\S/.test(sample), "the detector pattern genuinely matches a planted leak (not a tautological check)");
}

console.log(`\nnetworks covered: ${NETWORKS.join(", ")}`);
console.log(fail ? `\n${fail} ingest-settings check(s) failed\n` : "\nAll ingest-settings checks passed\n");
process.exit(fail ? 1 : 0);
