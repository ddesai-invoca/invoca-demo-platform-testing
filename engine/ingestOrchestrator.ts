/* =============================================================================
   ingestOrchestrator.ts — the "parent agent" for Demo Call Ingest-O-Matic
   -----------------------------------------------------------------------------
   Deterministic TypeScript. Computes date ranges, persists run records
   (one-JSON-file-per-record on DATA_DIR, same convention as demoStore.ts),
   and invokes a REAL Claude Agent SDK session per subagent run — it does not
   reimplement ingest.py's logic. See AGENT_PROMPT.md in each subagent folder
   for why: the send/retry/escalate judgment lives there, on purpose, and
   "credits used" (the Agent SDK's own total_cost_usd for the run) only means
   something if a real agent actually ran.

   The orchestrator's only jobs: decide WHEN and WHAT date range, hand a task
   prompt to the right subagent, and read back what happened.
   ============================================================================= */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "./demoStore.ts";
import { agentDir, agentBatchDir, NETWORKS, NETWORK_LABEL, type Network } from "./ingestAgentPaths.ts";
import {
  getNetworkSettings, saveNetworkSettings, cadenceWindowDays,
  type Cadence, type NetworkSettings, type BatchState, type BatchFileEntry,
} from "./ingestNetworkSettings.ts";
import { alert } from "./alerts.ts";

const execFileAsync = promisify(execFile);
const RUNS_DIR = path.join(DATA_DIR, "ingest-runs");

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function ensureRunsDir() { fs.mkdirSync(RUNS_DIR, { recursive: true }); }

// ---- message-level audit trail ----------------------------------------------
// Backend-only, no UI (decision #9) — just needed on disk for later debugging.
// Append-only JSON Lines, deliberately NOT a rewrite-the-whole-file pattern:
// ingest.py's own per-row save_state() already shows what that costs once a
// ledger grows large (O(ledger size) per write); appendFileSync here is
// O(message size) per write, no matter how long a run's transcript gets.
const AUDIT_DIR = path.join(DATA_DIR, "ingest-run-audit");
function appendAuditLine(runId: string, entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(path.join(AUDIT_DIR, `${runId}.jsonl`), line + "\n");
  } catch {
    // Never let audit logging itself break a real ingestion run.
  }
}

// ---- date-range rules -------------------------------------------------------

const iso = (d: Date) => d.toISOString().slice(0, 10);
const dayMs = 24 * 60 * 60 * 1000;
function addDays(d: Date, n: number): Date { return new Date(d.getTime() + n * dayMs); }
function startOfDay(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function lastDayOfPrevMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 0); }
function firstDayOfMonth(y: number, m: number): Date { return new Date(y, m, 1); }

export interface DateRange { start: string; end: string }

/** Ad-hoc request bounds: not in the future, not more than 2 years old. Pure —
 *  takes "now" as a parameter so it's trivially unit-testable. */
export function validateAdhocRange(
  startStr: string, endStr: string, now: Date = new Date(),
): { ok: true } | { ok: false; error: string } {
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (Number.isNaN(+start) || Number.isNaN(+end)) return { ok: false, error: "Enter valid start and end dates." };
  const today = startOfDay(now);
  if (start > end) return { ok: false, error: "The start date must be on or before the end date." };
  if (end > today) return { ok: false, error: "The date range can't include the future." };
  const twoYearsAgo = new Date(today.getFullYear() - 2, today.getMonth(), today.getDate());
  if (start < twoYearsAgo) return { ok: false, error: "The date range can't start more than 2 years ago." };
  return { ok: true };
}

/** The 4 cadence rules, computed off an injectable "now" — returns null on a
 *  tick that isn't a firing moment for that cadence. Anchor days are taken
 *  literally from the brief (1st/8th/22nd/28th for weekly) rather than
 *  re-derived from a strict 7-day grid. Pinned by scripts/audit-ingest-
 *  schedule.ts — still used for the DATE ARITHMETIC (which day is a firing
 *  day) even though Phase 2 no longer uses the date RANGE it returns (dates
 *  are assigned per-file at send time now — see restampFile below). */
export function computeScheduledRange(cadence: Exclude<Cadence, "off">, now: Date): DateRange | null {
  const day = now.getDate();
  const y = now.getFullYear();
  const m = now.getMonth();

  if (cadence === "daily") {
    const yest = addDays(startOfDay(now), -1);
    return { start: iso(yest), end: iso(yest) };
  }

  if (cadence === "monthly") {
    if (day !== 1) return null;
    const end = lastDayOfPrevMonth(now);
    const start = new Date(end.getFullYear(), end.getMonth(), 1);
    return { start: iso(start), end: iso(end) };
  }

  if (cadence === "biweekly") {
    if (day === 1) {
      const end = lastDayOfPrevMonth(now);
      const start = new Date(end.getFullYear(), end.getMonth(), 15);
      return { start: iso(start), end: iso(end) };
    }
    if (day === 15) {
      const start = firstDayOfMonth(y, m);
      const end = new Date(y, m, 14);
      return { start: iso(start), end: iso(end) };
    }
    return null;
  }

  // weekly: anchors 1, 8, 22, 28 — each requesting the preceding ~7 days.
  if ([1, 8, 22, 28].includes(day)) {
    const end = addDays(startOfDay(now), -1);
    const start = addDays(startOfDay(now), -7);
    return { start: iso(start), end: iso(end) };
  }
  return null;
}

/** Boolean-only firing check for Phase 2's per-network scheduler — reuses
 *  computeScheduledRange's exact day arithmetic (never a second, separately
 *  maintained copy of it) and just discards the range it returns. */
export function isFiringDay(cadence: Exclude<Cadence, "off">, now: Date): boolean {
  return computeScheduledRange(cadence, now) !== null;
}

// ---- run records -------------------------------------------------------

/** "partial" = the agent reported before the full send actually finished
 *  (its own error_details carry an INCOMPLETE_IN_PROGRESS entry) — a
 *  snapshot, not a final tally. Kept distinct from "done" so the dashboard
 *  never shows a mid-send count as if the run were complete. */
export type RunStatus = "running" | "done" | "partial" | "failed";

export interface ErrorDetail {
  code: string;
  count: number;
  reason: string;
  explanation: string;
  remediation: string;
}

export interface RunRecord {
  id: string;
  network: Network;
  requestedAt: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  dateRange: DateRange;
  requestor: { email: string; name: string } | "Mr. Roboto";
  testMode: boolean;
  callsIngested: number;
  errors: number;
  errorDetails: ErrorDetail[];
  creditsUsedUsd: number | null;
  agentSessionId?: string;
  rawFinalText?: string;
  /** The last ledger-derived "new rows since this run started" count a
   *  reconciliation pass saw — used to detect the background script going
   *  quiet (two checks ten minutes apart with no further growth) versus
   *  still genuinely sending. */
  reconcileProgress?: number;
  reconcileCheckedAt?: string;
}

// ---- reconciling a "partial" run against the real ledger --------------------
//
// Investigated live 2026-10-13: when an agent reports INCOMPLETE_IN_PROGRESS
// (per its own AGENT_PROMPT.md instructions, for a full send that's taking
// longer than it's willing to keep the session open), its Agent SDK session
// ends right there — but the ingest.py process it started keeps running as
// a detached background process, independent of that session, and keeps
// appending to state/ingest_state.json as it actually finishes the send.
// Nothing was ever going back to find out what it did. A "Partial" run
// confirmed to have fully succeeded in the background, 416 more calls
// accepted after the agent's own last snapshot, with the dashboard still
// frozen on the stale number.
//
// Rather than parse the agent's own prose for a CSV filename (fragile, and
// ad-hoc runs let the agent name its own file), every ledger entry already
// carries a timestamp (ingest.py's `ts`), so "what did THIS run's send do"
// is just "every ledger entry written at or after this run's startedAt" —
// safe to attribute to this run specifically because the per-network
// concurrency guard (sendingNow) means at most one send is ever writing to
// a given network's ledger at a time. NOTE: ingest.py's save_state() writes
// with `sort_keys=True`, so the ledger's key order is alphabetical by call
// ID, not insertion order — the timestamp on each entry, not its position
// in the file, is the only thing that's safe to filter on here.
const LEDGER_OK_CODES = new Set([201, 202]); // mirrors ingest.py's OK_CODES

interface LedgerEntry { code: number; ts: string; source_csv?: string; error?: unknown }

function readLedger(network: Network): Record<string, LedgerEntry> {
  try {
    const raw = fs.readFileSync(path.join(agentDir(network), "state", "ingest_state.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Reconciles every "partial" run against its network's real ledger. Called
 *  on the same 10-minute tick as the scheduler (see server.ts): on each
 *  pass, counts ledger entries written since the run's startedAt. If that
 *  count grew since the last pass, the background send is still working —
 *  just note the new count and check again next tick. If it's unchanged
 *  since the last pass (ten quiet minutes from a script that saves its
 *  state after every single call), the background process is presumed
 *  finished (or dead) either way, and the record is finalized with the
 *  real numbers instead of the agent's last, stale snapshot. */
export function reconcilePartialRuns(): void {
  for (const r of listRuns()) {
    if (r.status !== "partial") continue;
    const startedAtMs = new Date(r.startedAt).getTime();
    const ledger = readLedger(r.network);
    const newEntries = Object.values(ledger)
      .filter((e) => !isNaN(new Date(e.ts).getTime()) && new Date(e.ts).getTime() >= startedAtMs);
    const newTotal = newEntries.length;

    if (r.reconcileProgress === undefined || newTotal > r.reconcileProgress) {
      r.reconcileProgress = newTotal;
      r.reconcileCheckedAt = new Date().toISOString();
      saveRun(r);
      continue; // first look, or still growing — check again next tick
    }

    // Unchanged since the last tick: the background send has gone quiet.
    const newOk = newEntries.filter((e) => LEDGER_OK_CODES.has(e.code)).length;
    const newFail = newTotal - newOk;
    const byCode = new Map<number, number>();
    for (const e of newEntries) if (!LEDGER_OK_CODES.has(e.code)) byCode.set(e.code, (byCode.get(e.code) ?? 0) + 1);

    r.callsIngested = newOk;
    r.errors = newFail;
    r.errorDetails = [...byCode.entries()].map(([code, count]) => ({
      code: String(code),
      count,
      reason: `${count} call(s) failed with code ${code} during the background send (seen after the agent's own session had already ended).`,
      explanation: "The agent reported an in-progress snapshot and stopped watching; this network's ledger (state/ingest_state.json) is what actually recorded the send finishing, which is where this number comes from instead.",
      remediation: code === 0
        ? "Check this network's state/ingest_state.json for these IDs' recorded exception."
        : `Review why Invoca returned ${code} for these calls before retrying.`,
    }));
    r.status = "done";
    r.finishedAt = new Date().toISOString();
    saveRun(r);
  }
}

function runFile(id: string): string { return path.join(RUNS_DIR, `${id}.json`); }

function saveRun(rec: RunRecord): RunRecord {
  ensureRunsDir();
  writeAtomic(runFile(rec.id), JSON.stringify(rec, null, 2));
  return rec;
}

export function getRun(id: string): RunRecord | null {
  try { return JSON.parse(fs.readFileSync(runFile(id), "utf8")) as RunRecord; }
  catch { return null; }
}

export function listRuns(): RunRecord[] {
  ensureRunsDir();
  const out: RunRecord[] = [];
  for (const name of fs.readdirSync(RUNS_DIR)) {
    if (!name.endsWith(".json")) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(RUNS_DIR, name), "utf8"))); }
    catch (e) { console.error(`[ingest] skipping unreadable run ${name}:`, (e as Error).message); }
  }
  return out.sort((a, b) => (b.requestedAt ?? "").localeCompare(a.requestedAt ?? ""));
}

export function allTimeTotals(): { callsIngested: number; creditsUsedUsd: number; errors: number } {
  return listRuns().reduce(
    (acc, r) => ({
      callsIngested: acc.callsIngested + (r.callsIngested || 0),
      creditsUsedUsd: acc.creditsUsedUsd + (r.creditsUsedUsd || 0),
      errors: acc.errors + (r.errors || 0),
    }),
    { callsIngested: 0, creditsUsedUsd: 0, errors: 0 },
  );
}

/** Every run's error detail, folded into a flat list for the error log/report. */
export function errorLog(): (ErrorDetail & { date: string; network: Network })[] {
  const out: (ErrorDetail & { date: string; network: Network })[] = [];
  for (const r of listRuns()) {
    for (const d of r.errorDetails ?? []) out.push({ ...d, date: r.requestedAt, network: r.network });
  }
  return out;
}

/** Any run still "running" after this long is presumed killed by a restart/
 *  deploy, not actually in progress — called once at boot so the dashboard
 *  never shows a permanently-stuck spinner. */
const STALE_RUN_MS = 30 * 60 * 1000;
export function reconcileStaleRuns(): number {
  const now = Date.now();
  let n = 0;
  for (const r of listRuns()) {
    if (r.status !== "running") continue;
    if (now - new Date(r.startedAt).getTime() < STALE_RUN_MS) continue;
    r.status = "failed";
    r.finishedAt = new Date().toISOString();
    r.errorDetails = [{
      code: "orchestrator",
      count: 1,
      reason: "Run left in progress across a server restart/deploy.",
      explanation: "This request was still running when the server restarted, so it never got to report back what happened.",
      remediation: "Submit the request again. If it keeps happening, check whether deploys are landing while long ingestion runs are in flight.",
    }];
    saveRun(r);
    n++;
  }
  return n;
}

// ---- the agent invocation -------------------------------------------------

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    calls_ingested: { type: "integer" },
    errors: { type: "integer" },
    error_details: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string" },
          count: { type: "integer" },
          reason: { type: "string" },
          explanation: { type: "string" },
          remediation: { type: "string" },
        },
        required: ["code", "count", "reason", "explanation", "remediation"],
      },
    },
  },
  required: ["calls_ingested", "errors", "error_details"],
} as const;

function buildTaskPrompt(network: Network, range: DateRange, testMode: boolean, cachedFile?: string): string {
  const scope = testMode
    ? "TEST MODE: run through the dry-run and the built-in 3-call test batch (per your operating procedure), then STOP. Do NOT proceed to a full send, however good the test batch looks."
    : "Run your full operating procedure through to completion: dry-run, test batch, then the full send.";
  const step0 = cachedFile
    ? `A CSV has already been prepared for you at ${cachedFile} by this network's deterministic trend-shaping script. Do NOT run prepare_date_range.py and do not modify this file in any way — using exactly this file IS step 0. Start at step 1 of your operating procedure (dry-run) against that file, then proceed through the rest of your procedure exactly as documented in AGENT_PROMPT.md.`
    : `Start with step 0 of your operating procedure (prepare_date_range.py) to build a CSV for this range, then proceed through the rest of your procedure exactly as documented in AGENT_PROMPT.md.`;
  return [
    `You are being asked to ingest calls for ${NETWORK_LABEL[network]} for the date range ${range.start} to ${range.end} (inclusive).`,
    step0,
    scope,
    `Report back honestly even if you had to stop early or escalate per your own rules — the structured output should reflect exactly what actually happened, not what was intended.`,
    `A full send of several hundred rows can legitimately take many minutes to finish — that is expected, not a problem. Wait for it to actually complete (per your operating procedure's step 3) before giving your final report. Only report calls_ingested as a mid-send snapshot if you've genuinely exhausted a long wait as your procedure describes, and if so, flag it with error code INCOMPLETE_IN_PROGRESS rather than presenting it as the final tally.`,
  ].join("\n\n");
}

export interface RunJobInput {
  network: Network;
  dateRange: DateRange;
  requestor: RunRecord["requestor"];
  testMode: boolean;
  /** Phase 2: a batch file already built by trend_batch.py and restamped
   *  for today. When set, the agent is told to skip prepare_date_range.py
   *  entirely and work directly from this file. Absent for ad-hoc requests,
   *  which still build their own CSV the way they always have. */
  cachedFile?: string;
}

function newRunId(network: Network): string {
  return `${network}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function runIngestJob(input: RunJobInput, id: string = newRunId(input.network)): Promise<RunRecord> {
  const now = new Date().toISOString();
  let rec: RunRecord = {
    id,
    network: input.network,
    requestedAt: now,
    startedAt: now,
    finishedAt: null,
    status: "running",
    dateRange: input.dateRange,
    requestor: input.requestor,
    testMode: input.testMode,
    callsIngested: 0,
    errors: 0,
    errorDetails: [],
    creditsUsedUsd: null,
  };
  saveRun(rec);

  try {
    const cwd = agentDir(input.network);
    const promptMd = fs.readFileSync(path.join(cwd, "AGENT_PROMPT.md"), "utf8");
    const task = buildTaskPrompt(input.network, input.dateRange, input.testMode, input.cachedFile);

    let finalText = "";
    let structured: any = null;
    let creditsUsedUsd = 0;
    let sessionId: string | undefined;

    for await (const message of query({
      prompt: task,
      options: {
        cwd,
        systemPrompt: { type: "custom", prompt: promptMd },
        allowedTools: ["Bash", "Read"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        model: process.env.INGEST_AGENT_MODEL || undefined,
        outputFormat: { type: "json_schema", schema: REPORT_SCHEMA },
      },
    })) {
      appendAuditLine(id, {
        type: message.type,
        subtype: (message as any).subtype,
        summary: JSON.stringify(message).slice(0, 2000),
      });
      if (message.type === "result") {
        sessionId = message.session_id;
        creditsUsedUsd = message.total_cost_usd ?? 0;
        if (message.subtype === "success") {
          finalText = message.result ?? "";
          structured = (message as any).structured_output ?? null;
        } else {
          finalText = `Agent stopped early: ${message.subtype}`;
        }
      }
    }

    rec.agentSessionId = sessionId;
    rec.creditsUsedUsd = creditsUsedUsd;
    rec.rawFinalText = finalText.slice(0, 4000);

    if (structured) {
      rec.callsIngested = Number(structured.calls_ingested) || 0;
      rec.errors = Number(structured.errors) || 0;
      rec.errorDetails = Array.isArray(structured.error_details) ? structured.error_details : [];
      // The agent's own signal for "this is a mid-send snapshot, not a
      // final tally" (see AGENT_PROMPT.md step 3) — keep it visibly
      // distinct from a genuinely completed run rather than both reading
      // as "done" with a number that looks final either way.
      rec.status = rec.errorDetails.some((d) => d.code === "INCOMPLETE_IN_PROGRESS") ? "partial" : "done";
    } else {
      rec.status = "failed";
      rec.errorDetails = [{
        code: "orchestrator",
        count: 1,
        reason: "Agent run did not produce the expected structured report.",
        explanation: "The automated agent finished, but didn't report back in the format this dashboard expects, so its results couldn't be recorded.",
        remediation: "Check the run's raw output (stored with this record) and, if this keeps happening, review AGENT_PROMPT.md's reporting instructions.",
      }];
    }
  } catch (e) {
    rec.status = "failed";
    rec.errorDetails = [{
      code: "orchestrator",
      count: 1,
      reason: String((e as Error)?.message || e),
      explanation: "Something went wrong starting or running the automated ingestion agent, before it could even attempt the request.",
      remediation: "Check the server logs for this run's id, and confirm the Anthropic API key and this network's credentials are set correctly.",
    }];
    void alert({
      key: `ingest:${input.network}`,
      title: `Ingest-O-Matic run failed for ${NETWORK_LABEL[input.network]}`,
      detail: String((e as Error)?.message || e),
    });
  } finally {
    rec.finishedAt = new Date().toISOString();
    saveRun(rec);
  }
  return rec;
}

// ---- fire-and-forget job runner --------------------------------------------

// `sendingNow` is the single per-network "an Agent SDK session already owns
// this network" guard, shared by BOTH the ad-hoc path below and the
// scheduled path further down. Investigated live 2026-10-13: two ad-hoc
// "Add calls" submissions for the same network, 8 minutes apart, left the
// FIRST one stuck "running" with zero Agent SDK messages ever produced —
// the exact same signature as the scheduled-dispatch bug, just triggered by
// same-network concurrency instead of cross-network concurrency. The
// ad-hoc path had no concurrency guard at all before this; a second
// submission for a busy network is now rejected outright (409) rather than
// silently started and left to hang.
const generatingNow = new Set<Network>();
const sendingNow = new Set<Network>();

const inFlight = new Map<string, Promise<RunRecord>>();

export function isNetworkBusy(network: Network): boolean {
  return sendingNow.has(network);
}

export function enqueueIngestJob(input: RunJobInput): { runId: string } | { busy: true } {
  if (sendingNow.has(input.network)) return { busy: true };
  sendingNow.add(input.network);
  const id = newRunId(input.network);
  const p = runIngestJob(input, id).finally(() => {
    inFlight.delete(id);
    sendingNow.delete(input.network);
  });
  inFlight.set(id, p);
  return { runId: id };
}

// ---- Phase 2: trend batches ------------------------------------------------
//
// Trend-shaping is always a deterministic script (trend_batch.py, one copy
// per network), never agent judgment — the same hard rule AGENT_PROMPT.md
// already enforces for prepare_date_range.py's IDs/dates. The orchestrator
// calls it directly (execFile, not an Agent SDK session) to build a whole
// network's upload batch in one shot, then the existing agent-invocation
// pipeline (runIngestJob/buildTaskPrompt) just sends whichever cached file
// is next, exactly as it already knows how to send an ad-hoc CSV.

/** Serializes every scheduled dispatch across ALL networks, one Agent SDK
 *  session at a time. Investigated live 2026-10-13: every scheduled run,
 *  for every network, every day since Phase 2 shipped, sat "running" for
 *  ~24h with ZERO Agent SDK messages ever produced (confirmed via the
 *  message-level audit trail below — not one line was ever written for any
 *  of them), until the next day's restart reconciled it as failed. A solo
 *  ad-hoc dispatch, run the exact same way through the exact same
 *  runIngestJob(), worked immediately. The one structural difference: the
 *  scheduler used to kick off all six networks' sessions at once
 *  (unawaited), within milliseconds of each other. Chaining them is the
 *  fix under test — a later network's dispatch just waits its turn instead
 *  of racing five others to start a Claude Agent SDK session in the same
 *  process at the same instant. */
let dispatchChain: Promise<void> = Promise.resolve();

/** Direct-shells trend_batch.py to build a network's whole upload batch.
 *  Not an agent session — this is pure deterministic row/ID math, nothing
 *  here calls for judgment. */
async function generateFullBatch(network: Network, settings: NetworkSettings, cycleNumber: number): Promise<BatchState> {
  const outDir = path.join(agentBatchDir(network), `${network}-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const python = path.join(agentDir(network), ".venv", "bin", "python3");
  const script = path.join(agentDir(network), "trend_batch.py");
  const { stdout } = await execFileAsync(python, [
    script,
    "--cadence", settings.cadence,
    "--trend", settings.trend,
    "--period", settings.trendPeriod,
    "--calls-per-upload", String(settings.callsPerUpload),
    "--cycle-number", String(cycleNumber),
    "--out-dir", outDir,
  ], { maxBuffer: 16 * 1024 * 1024 });
  // The script may print progress lines before its one JSON summary line —
  // take the last line, same tolerance pattern as parsing the agent's own
  // fenced JSON report elsewhere in this file.
  const lastLine = stdout.trim().split("\n").pop() ?? "{}";
  const parsed = JSON.parse(lastLine) as { totalUploads: number; files: string[] };
  const files: BatchFileEntry[] = parsed.files.map((p, index) => ({ path: p, index }));
  return {
    batchId: path.basename(outDir),
    generatedAt: new Date().toISOString(),
    settingsSnapshot: {
      cadence: settings.cadence, trend: settings.trend,
      trendPeriod: settings.trendPeriod, callsPerUpload: settings.callsPerUpload,
    },
    totalUploads: parsed.totalUploads,
    nextUploadIndex: 0,
    cycleNumber,
    files,
  };
}

/** Generates (or regenerates) a network's batch, persisting the "generating"
 *  lock around it so a crash mid-generation is recoverable on the next boot
 *  (see reconcileStaleGenerations) rather than leaving settings stuck
 *  showing "Generating…" forever. Idempotent against a same-process race
 *  via `generatingNow`. */
export async function regenerateBatch(network: Network, cycleNumber?: number): Promise<NetworkSettings> {
  if (generatingNow.has(network)) return getNetworkSettings(network);
  generatingNow.add(network);
  let settings = getNetworkSettings(network);
  saveNetworkSettings(network, { ...settings, generatingSince: new Date().toISOString() });
  try {
    const nextCycle = cycleNumber ?? (settings.batch?.cycleNumber ?? 0) + 1;
    const batch = await generateFullBatch(network, settings, nextCycle);
    settings = getNetworkSettings(network); // re-read: a setting could have changed while generating
    settings = saveNetworkSettings(network, { ...settings, batch, generatingSince: null });
  } catch (e) {
    settings = getNetworkSettings(network);
    settings = saveNetworkSettings(network, { ...settings, generatingSince: null });
    void alert({
      key: `ingest-generate:${network}`,
      title: `Ingest-O-Matic batch generation failed for ${NETWORK_LABEL[network]}`,
      detail: String((e as Error)?.message || e),
    });
  } finally {
    generatingNow.delete(network);
  }
  return settings;
}

/** Restamps one already-built file's dates to fall inside a window ending
 *  "today" — deferred to send time (not baked in at generation time) so a
 *  multi-day outage's catch-up sends carry correct, non-stale dates. Still
 *  a deterministic script call, never agent judgment. */
async function restampFile(network: Network, filePath: string, endDate: string, windowDays: number): Promise<void> {
  const python = path.join(agentDir(network), ".venv", "bin", "python3");
  const script = path.join(agentDir(network), "trend_batch.py");
  await execFileAsync(python, [script, "--restamp", filePath, "--end", endDate, "--window-days", String(windowDays)]);
}

/** Sends one network's next upload: regenerates a fresh cycle first if the
 *  current batch is exhausted (decision #8 — brand-new IDs, never a replay
 *  of the first file), restamps that file's dates for today, then runs the
 *  existing agent pipeline against it exactly as an ad-hoc request. Always
 *  advances the cursor in `finally`, win or lose — a failed day's content
 *  doesn't block tomorrow's, the same way a failed ad-hoc run doesn't block
 *  the next one. */
async function dispatchNextUpload(network: Network): Promise<void> {
  if (sendingNow.has(network)) return;
  sendingNow.add(network);
  try {
    let settings = getNetworkSettings(network);
    if (settings.cadence === "off") return;
    const cadence = settings.cadence;

    if (!settings.batch || settings.batch.nextUploadIndex >= settings.batch.totalUploads) {
      settings = await regenerateBatch(network, (settings.batch?.cycleNumber ?? 0) + 1);
    }
    if (!settings.batch) return; // generation failed; already alerted in regenerateBatch

    const entry = settings.batch.files[settings.batch.nextUploadIndex];
    const today = new Date().toISOString().slice(0, 10);
    try {
      await restampFile(network, entry.path, today, cadenceWindowDays(cadence));
      await runIngestJob({
        network,
        dateRange: { start: today, end: today }, // display only — the file's own rows carry the real spread across the cadence window
        requestor: "Mr. Roboto",
        testMode: false,
        cachedFile: entry.path,
      });
    } finally {
      const fresh = getNetworkSettings(network);
      if (fresh.batch) {
        saveNetworkSettings(network, { ...fresh, batch: { ...fresh.batch, nextUploadIndex: fresh.batch.nextUploadIndex + 1 } });
      }
    }
  } finally {
    sendingNow.delete(network);
  }
}

/** Scheduler entry point: each network's own cadence/trend/volume settings
 *  decide WHETHER it fires today, guarded per-network so a 10-minute tick
 *  re-evaluating the same firing day doesn't double-dispatch (persisted, so
 *  a restart on the same day doesn't either). The decision of which
 *  networks fire today is made eagerly, synchronously, for all of them in
 *  this tick — but the actual dispatches are chained onto `dispatchChain`
 *  rather than fired concurrently, so they run one network's Agent SDK
 *  session at a time (see the note on `dispatchChain`). A network's own
 *  settings are re-read fresh when its turn in the chain actually comes
 *  up, so one queued behind a long-running sibling still reflects
 *  whatever is true by the time it runs (e.g. cadence turned off in the
 *  meantime, or "today" having rolled over). */
export function maybeDispatchScheduled(now: Date): void {
  for (const network of NETWORKS) {
    const settings = getNetworkSettings(network);
    if (settings.cadence === "off") continue;
    if (settings.generatingSince || generatingNow.has(network) || sendingNow.has(network)) continue;
    if (!isFiringDay(settings.cadence, now)) continue;
    const key = `${settings.cadence}:${now.toISOString().slice(0, 10)}`;
    if (key === settings.lastFiredKey) continue;
    saveNetworkSettings(network, { ...settings, lastFiredKey: key });
    dispatchChain = dispatchChain.then(() => dispatchNextUpload(network)).catch((e) => {
      void alert({
        key: `ingest-schedule-dispatch:${network}`,
        title: `Scheduled ingest dispatch failed for ${NETWORK_LABEL[network]}`,
        detail: String((e as Error)?.message || e),
      });
    });
  }
}

/** Any network left "generating" after this long is presumed killed by a
 *  restart/deploy, not actually in progress — called once at boot so the
 *  settings UI never shows a permanently-stuck "Generating…" row. Mirrors
 *  reconcileStaleRuns above. Batch generation is a fast deterministic
 *  script, not an agent call, so the timeout here is much shorter. */
const STALE_GENERATION_MS = 10 * 60 * 1000;
export function reconcileStaleGenerations(): number {
  let n = 0;
  for (const network of NETWORKS) {
    const settings = getNetworkSettings(network);
    if (!settings.generatingSince) continue;
    if (Date.now() - new Date(settings.generatingSince).getTime() < STALE_GENERATION_MS) continue;
    saveNetworkSettings(network, { ...settings, generatingSince: null });
    void alert({
      key: `ingest-generate-stale:${network}`,
      title: `Ingest-O-Matic batch generation for ${NETWORK_LABEL[network]} was interrupted`,
      detail: "Left \"generating\" across a server restart/deploy, so it's been cleared rather than left stuck locked. If this network has no usable batch, saving its settings again will regenerate one.",
    });
    n++;
  }
  return n;
}
