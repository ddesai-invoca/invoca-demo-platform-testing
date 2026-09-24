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
import { query } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "./demoStore.ts";
import { agentDir, NETWORKS, NETWORK_LABEL, type Network } from "./ingestAgentPaths.ts";
import { alert } from "./alerts.ts";

const RUNS_DIR = path.join(DATA_DIR, "ingest-runs");
const SCHEDULE_FILE = path.join(DATA_DIR, "ingest-schedule.json");

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function ensureRunsDir() { fs.mkdirSync(RUNS_DIR, { recursive: true }); }

export type Cadence = "monthly" | "biweekly" | "weekly" | "daily";
export const CADENCES: Cadence[] = ["monthly", "biweekly", "weekly", "daily"];

export interface ScheduleConfig {
  cadence: Cadence;
  updatedAt: string;
  updatedBy: { email: string; name: string };
  /** Guards the scheduler tick against re-firing the same computed range more
   *  than once (a 10-minute tick evaluates a firing day many times, and a
   *  restart on that same day must not double-dispatch either). */
  lastFiredKey?: string;
}

const DEFAULT_SCHEDULE: ScheduleConfig = {
  cadence: "monthly",
  updatedAt: new Date(0).toISOString(),
  updatedBy: { email: "system", name: "System default" },
};

export function getSchedule(): ScheduleConfig {
  try {
    return { ...DEFAULT_SCHEDULE, ...JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf8")) };
  } catch {
    return DEFAULT_SCHEDULE;
  }
}

export function saveSchedule(cadence: Cadence, by: { email: string; name: string }): ScheduleConfig {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const next: ScheduleConfig = { cadence, updatedAt: new Date().toISOString(), updatedBy: by };
  writeAtomic(SCHEDULE_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** Persists just the scheduler's own dedupe key, without disturbing the rest
 *  of the config (a save from the UI and a save from the tick can race, but
 *  the tick only ever touches this one field). */
function markFired(key: string): void {
  const current = getSchedule();
  writeAtomic(SCHEDULE_FILE, JSON.stringify({ ...current, lastFiredKey: key }, null, 2));
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
 *  re-derived from a strict 7-day grid. */
export function computeScheduledRange(cadence: Cadence, now: Date): DateRange | null {
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

// ---- run records -------------------------------------------------------

export type RunStatus = "running" | "done" | "failed";

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

function buildTaskPrompt(network: Network, range: DateRange, testMode: boolean): string {
  const scope = testMode
    ? "TEST MODE: run through the dry-run and the built-in 3-call test batch (per your operating procedure), then STOP. Do NOT proceed to a full send, however good the test batch looks."
    : "Run your full operating procedure through to completion: dry-run, test batch, then the full send.";
  return [
    `You are being asked to ingest calls for ${NETWORK_LABEL[network]} for the date range ${range.start} to ${range.end} (inclusive).`,
    `Start with step 0 of your operating procedure (prepare_date_range.py) to build a CSV for this range, then proceed through the rest of your procedure exactly as documented in AGENT_PROMPT.md.`,
    scope,
    `Report back honestly even if you had to stop early or escalate per your own rules — the structured output should reflect exactly what actually happened, not what was intended.`,
  ].join("\n\n");
}

export interface RunJobInput {
  network: Network;
  dateRange: DateRange;
  requestor: RunRecord["requestor"];
  testMode: boolean;
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
    const task = buildTaskPrompt(input.network, input.dateRange, input.testMode);

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
      rec.status = "done";
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

const inFlight = new Map<string, Promise<RunRecord>>();

export function enqueueIngestJob(input: RunJobInput): { runId: string } {
  const id = newRunId(input.network);
  const p = runIngestJob(input, id).finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return { runId: id };
}

/** Scheduler entry point: dispatches the same computed range to BOTH networks,
 *  guarded so a 10-minute tick re-evaluating the same firing day doesn't
 *  double-dispatch (persisted, so a restart on the same day doesn't either). */
export function maybeDispatchScheduled(now: Date): void {
  const schedule = getSchedule();
  const range = computeScheduledRange(schedule.cadence, now);
  if (!range) return;
  const key = `${schedule.cadence}:${range.start}:${range.end}`;
  if (key === schedule.lastFiredKey) return;
  markFired(key);
  for (const network of NETWORKS) {
    void runIngestJob({ network, dateRange: range, requestor: "Mr. Roboto", testMode: false });
  }
}
