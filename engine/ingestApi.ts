/* =============================================================================
   ingestApi.ts — Demo Call Ingest-O-Matic routes
   -----------------------------------------------------------------------------
     GET   /api/ingest/networks                 every network's settings
     POST  /api/ingest/networks/:network/preview  { cadence?, trend?, trendPeriod?, callsPerUpload? }
                                                 -> the confirm-dialog copy, computed, nothing saved
     PUT   /api/ingest/networks/:network/settings  same patch shape -> applies it
     GET   /api/ingest/networks/:network/status    { generating, notConfigured } — lightweight poll target

     POST  /api/ingest/adhoc           submit a date-range request
                                        { network, start, end, testMode? }
     GET   /api/ingest/runs            log + all-time totals for the dashboard
     GET   /api/ingest/jobs/:id        poll a single run (in-flight or done)
     GET   /api/ingest/errors          derived error log
     GET   /api/ingest/errors/report   downloadable plain-text error report

   Shaped exactly like demoApi.ts/feedbackApi.ts: returns null for a path it
   doesn't own, so server.ts and the Vite dev server can mount it the same way.

   ADMIN ONLY, the whole feature — this dispatches real Claude Agent SDK runs
   against real Invoca networks, so every route below is gated.
   ============================================================================= */

import {
  validateAdhocRange, enqueueIngestJob, getRun, listRuns, allTimeTotals, errorLog,
  regenerateBatch,
} from "./ingestOrchestrator.ts";
import {
  getNetworkSettings, saveNetworkSettings, listAllNetworkSettings, legacyCadence,
  classifySettingsChange, applySettingsAction, describeSettingsAction,
  CADENCES, TRENDS, TREND_PERIODS, CALLS_PER_UPLOAD_MAX,
  type Cadence, type Trend, type TrendPeriod, type SettingsPatch,
} from "./ingestNetworkSettings.ts";
import { NETWORKS, NETWORK_LABEL, requiredEnvVarNames, type Network } from "./ingestAgentPaths.ts";

export interface ApiResult {
  status: number;
  body: unknown;
  binary?: { buffer: Buffer; headers: Record<string, string> };
}
const ok = (body: unknown): ApiResult => ({ status: 200, body });
const err = (status: number, error: string): ApiResult => ({ status, body: { error } });

export interface IngestUser { email: string; name: string }

function buildErrorReport(): { buffer: Buffer; filename: string } {
  const rows = errorLog();
  const lines = [
    "Demo Call Ingest-O-Matic — Error Report",
    `Generated ${new Date().toLocaleString("en-US")}`,
    "",
  ];
  if (!rows.length) {
    lines.push("No errors recorded.");
  } else {
    for (const r of rows) {
      lines.push(
        `Date: ${new Date(r.date).toLocaleString("en-US")}`,
        `Network: ${NETWORK_LABEL[r.network] ?? r.network}`,
        `Count: ${r.count}`,
        `Code/reason: ${r.code} — ${r.reason}`,
        `What this means: ${r.explanation}`,
        `Recommended fix: ${r.remediation}`,
        "",
        "----------------------------------------",
        "",
      );
    }
  }
  return { buffer: Buffer.from(lines.join("\n"), "utf8"), filename: `ingest-error-report-${new Date().toISOString().slice(0, 10)}.txt` };
}

/** Validates a proposed settings patch's shape, without regard to what it
 *  would actually DO (that's classifySettingsChange's job) — shared by the
 *  preview and save routes so the two can't disagree about what a valid
 *  patch looks like. */
function validatePatch(body: any): { ok: true; patch: SettingsPatch } | { ok: false; error: string } {
  const patch: SettingsPatch = {};
  if (body?.cadence !== undefined) {
    const cadence = body.cadence as Cadence;
    if (!CADENCES.includes(cadence)) return { ok: false, error: `Cadence must be one of: ${CADENCES.join(", ")}.` };
    patch.cadence = cadence;
  }
  if (body?.trend !== undefined) {
    const trend = body.trend as Trend;
    if (!TRENDS.includes(trend)) return { ok: false, error: `Trend must be one of: ${TRENDS.join(", ")}.` };
    patch.trend = trend;
  }
  if (body?.trendPeriod !== undefined) {
    const trendPeriod = body.trendPeriod as TrendPeriod;
    if (!TREND_PERIODS.includes(trendPeriod)) return { ok: false, error: `Trend period must be one of: ${TREND_PERIODS.join(", ")}.` };
    patch.trendPeriod = trendPeriod;
  }
  if (body?.callsPerUpload !== undefined) {
    const n = Number(body.callsPerUpload);
    if (!Number.isFinite(n) || n < 1 || n > CALLS_PER_UPLOAD_MAX) {
      return { ok: false, error: `Calls per upload must be a number between 1 and ${CALLS_PER_UPLOAD_MAX}.` };
    }
    patch.callsPerUpload = Math.round(n);
  }
  return { ok: true, patch };
}

export async function handleIngestApi(
  method: string,
  urlPath: string,
  body: any,
  user: IngestUser,
  isAdminUser: boolean,
): Promise<ApiResult | null> {
  const p = urlPath.split("?")[0].replace(/\/+$/, "");
  if (!p.startsWith("/api/ingest")) return null;

  if (!isAdminUser) return err(403, "Demo Call Ingest-O-Matic is admin-only.");

  if (p === "/api/ingest/networks" && method === "GET") {
    const networks = listAllNetworkSettings().map((s) => ({
      ...s,
      notConfigured: requiredEnvVarNames(s.network).some((v) => !process.env[v]),
    }));
    return ok({
      networks,
      cadences: CADENCES,
      trends: TRENDS,
      trendPeriods: TREND_PERIODS,
      callsPerUploadMax: CALLS_PER_UPLOAD_MAX,
      legacyCadence: legacyCadence(),
    });
  }

  const previewMatch = /^\/api\/ingest\/networks\/([^/]+)\/preview$/.exec(p);
  if (previewMatch && method === "POST") {
    const network = previewMatch[1] as Network;
    if (!NETWORKS.includes(network)) return err(404, "Unknown network.");
    const v = validatePatch(body);
    if (!v.ok) return err(400, v.error);
    const current = getNetworkSettings(network);
    const action = classifySettingsChange(current, v.patch);
    const { message, totalUploads } = describeSettingsAction(NETWORK_LABEL[network], action, current, v.patch);
    return ok({ action, message, totalUploads });
  }

  const settingsMatch = /^\/api\/ingest\/networks\/([^/]+)\/settings$/.exec(p);
  if (settingsMatch && method === "PUT") {
    const network = settingsMatch[1] as Network;
    if (!NETWORKS.includes(network)) return err(404, "Unknown network.");
    const current = getNetworkSettings(network);
    if (current.generatingSince) return err(409, `${NETWORK_LABEL[network]} is still generating its last settings change — try again shortly.`);
    const v = validatePatch(body);
    if (!v.ok) return err(400, v.error);
    const action = classifySettingsChange(current, v.patch);
    const next = applySettingsAction(current, v.patch, action, { email: user.email, name: user.name });
    saveNetworkSettings(network, next);
    if (action === "regenerate" && next.cadence !== "off") void regenerateBatch(network);
    return ok({ settings: next, action });
  }

  const statusMatch = /^\/api\/ingest\/networks\/([^/]+)\/status$/.exec(p);
  if (statusMatch && method === "GET") {
    const network = statusMatch[1] as Network;
    if (!NETWORKS.includes(network)) return err(404, "Unknown network.");
    const settings = getNetworkSettings(network);
    return ok({ generating: !!settings.generatingSince, notConfigured: requiredEnvVarNames(network).some((v) => !process.env[v]) });
  }

  if (p === "/api/ingest/adhoc" && method === "POST") {
    const network = body?.network as Network;
    if (!NETWORKS.includes(network)) return err(400, `Pick a network: ${NETWORKS.join(", ")}.`);
    const start = String(body?.start ?? "");
    const end = String(body?.end ?? "");
    const v = validateAdhocRange(start, end);
    if (!v.ok) return err(400, v.error);
    const { runId } = enqueueIngestJob({
      network,
      dateRange: { start, end },
      requestor: { email: user.email, name: user.name },
      testMode: !!body?.testMode,
    });
    return ok({ runId });
  }

  if (p === "/api/ingest/runs" && method === "GET") {
    return ok({ runs: listRuns(), totals: allTimeTotals() });
  }

  const jobMatch = /^\/api\/ingest\/jobs\/([^/]+)$/.exec(p);
  if (jobMatch && method === "GET") {
    const rec = getRun(jobMatch[1]);
    return rec ? ok({ run: rec }) : err(404, "Not found.");
  }

  if (p === "/api/ingest/errors" && method === "GET") {
    return ok({ errors: errorLog() });
  }

  if (p === "/api/ingest/errors/report" && method === "GET") {
    const { buffer, filename } = buildErrorReport();
    return {
      status: 200,
      body: null,
      binary: {
        buffer,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      },
    };
  }

  return err(404, "Not found.");
}
