/* =============================================================================
   ingestApi.ts — Demo Call Ingest-O-Matic routes
   -----------------------------------------------------------------------------
     GET   /api/ingest/schedule        current cadence
     PUT   /api/ingest/schedule        change cadence          { cadence }
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
  getSchedule, saveSchedule, CADENCES, type Cadence,
} from "./ingestOrchestrator.ts";
import { NETWORKS, NETWORK_LABEL, type Network } from "./ingestAgentPaths.ts";

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

  if (p === "/api/ingest/schedule") {
    if (method === "GET") return ok({ schedule: getSchedule(), cadences: CADENCES });
    if (method === "PUT") {
      const cadence = body?.cadence as Cadence;
      if (!CADENCES.includes(cadence)) return err(400, `Cadence must be one of: ${CADENCES.join(", ")}.`);
      return ok({ schedule: saveSchedule(cadence, user) });
    }
    return err(405, "Method not allowed.");
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
