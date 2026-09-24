import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

/* =============================================================================
   IngestOMatic — /ingest-o-matic
   -----------------------------------------------------------------------------
   Admin tool: schedule and log the bulk synthetic-call ingestion that seeds
   Invoca demo networks (Telecom/1847, Healthcare/2160). Every /api/ingest/*
   route is admin-gated server-side; this screen assumes it's already reachable
   only via the hamburger menu's admin-only row (see LaunchMenu.tsx).

   Plain useState/useEffect data-fetching, no context — matches FeedbackBoard's
   approach; this screen isn't referenced from anywhere else in the app.
   ============================================================================= */

type Network = "telecom-1847" | "healthcare-2160";
type Cadence = "monthly" | "biweekly" | "weekly" | "daily";
type RunStatus = "running" | "done" | "failed";

interface ErrorDetail { code: string; count: number; reason: string; explanation: string; remediation: string }
interface RunRecord {
  id: string; network: Network; requestedAt: string; startedAt: string; finishedAt: string | null;
  status: RunStatus; dateRange: { start: string; end: string };
  requestor: { email: string; name: string } | "Mr. Roboto";
  testMode: boolean; callsIngested: number; errors: number; errorDetails: ErrorDetail[]; creditsUsedUsd: number | null;
}
interface Totals { callsIngested: number; creditsUsedUsd: number; errors: number }
interface Schedule { cadence: Cadence; updatedAt: string; updatedBy: { email: string; name: string } }

const NETWORK_LABEL: Record<Network, string> = {
  "telecom-1847": "Telecom (1847)",
  "healthcare-2160": "Healthcare (2160)",
};
const CADENCE_LABEL: Record<Cadence, string> = {
  monthly: "Monthly — 1st of the month, previous calendar month",
  biweekly: "Biweekly — 1st and 15th, previous half-month",
  weekly: "Weekly — 1st/8th/22nd/28th, preceding ~7 days",
  daily: "Daily — every night, previous calendar day",
};

function money(n: number | null): string {
  if (n === null) return "—";
  return `$${n.toFixed(2)}`;
}
function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    + ", " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function requestorName(r: RunRecord["requestor"]): string {
  return r === "Mr. Roboto" ? "Mr. Roboto (scheduled)" : `${r.name} (${r.email})`;
}
function todayStr(): string { return new Date().toISOString().slice(0, 10); }

export function IngestOMatic() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [totals, setTotals] = useState<Totals>({ callsIngested: 0, creditsUsedUsd: 0, errors: 0 });
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [cadences, setCadences] = useState<Cadence[]>([]);
  const [errors, setErrors] = useState<(ErrorDetail & { date: string; network: Network })[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [panel, setPanel] = useState<"schedule" | "add" | "errors" | null>(null);

  const [cadenceChoice, setCadenceChoice] = useState<Cadence>("monthly");
  const [savingSchedule, setSavingSchedule] = useState(false);

  const [network, setNetwork] = useState<Network>("telecom-1847");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [testMode, setTestMode] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    try {
      const [runsRes, scheduleRes] = await Promise.all([
        fetch("/api/ingest/runs"),
        fetch("/api/ingest/schedule"),
      ]);
      const runsData = await runsRes.json();
      if (!runsRes.ok) throw new Error(runsData?.error || "Could not load the ingestion log.");
      const scheduleData = await scheduleRes.json();
      if (!scheduleRes.ok) throw new Error(scheduleData?.error || "Could not load the schedule.");
      setRuns(runsData.runs ?? []);
      setTotals(runsData.totals ?? { callsIngested: 0, creditsUsedUsd: 0, errors: 0 });
      setSchedule(scheduleData.schedule ?? null);
      setCadences(scheduleData.cadences ?? []);
      if (scheduleData.schedule?.cadence) setCadenceChoice(scheduleData.schedule.cadence);
    } catch (e: any) {
      setLoadError(e?.message || "Could not load Ingest-O-Matic.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Poll while anything is in flight — the only state that can change on its own.
  useEffect(() => {
    if (!runs.some((r) => r.status === "running")) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [runs, load]);

  useEffect(() => {
    if (panel !== "errors") return;
    fetch("/api/ingest/errors").then((r) => r.json()).then((d) => setErrors(d.errors ?? [])).catch(() => {});
  }, [panel]);

  async function saveSchedule() {
    setSavingSchedule(true);
    try {
      const res = await fetch("/api/ingest/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cadence: cadenceChoice }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || "Could not save the schedule.");
      setSchedule(d.schedule);
      setToast("Schedule saved.");
      setTimeout(() => setToast(""), 4000);
    } catch (e: any) {
      setToast(e?.message || "Could not save the schedule.");
    } finally {
      setSavingSchedule(false);
    }
  }

  async function submitAdhoc(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/ingest/adhoc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network, start, end, testMode }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || "Could not submit the request.");
      setToast("Request submitted — watch the log below.");
      setTimeout(() => setToast(""), 4000);
      await load();
    } catch (e: any) {
      setSubmitError(e?.message || "Could not submit the request.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="ing-page"><p className="ing-empty">Loading…</p></div>;

  return (
    <div className="ing-page">
      <div className="ing-wrap">
        <div className="ing-top">
          <div>
            <p className="ing-eyebrow">Admin tool</p>
            <h1 className="ing-h1">Demo Call Ingest-O-Matic</h1>
          </div>
          <Link className="ing-back" to="/">Back to the launch page</Link>
        </div>

        {loadError && <p className="ing-error">{loadError}</p>}
        {toast && <p className="ing-toast">{toast}</p>}

        <div className="ing-tiles">
          <div className="ing-tile">
            <span className="ing-tile-label">Calls ingested, all time</span>
            <span className="ing-tile-value">{totals.callsIngested.toLocaleString()}</span>
          </div>
          <div className="ing-tile">
            <span className="ing-tile-label">Credits used, all time</span>
            <span className="ing-tile-value">{money(totals.creditsUsedUsd)}</span>
          </div>
          <div className="ing-tile">
            <span className="ing-tile-label">Errors, all time</span>
            <span className="ing-tile-value">{totals.errors.toLocaleString()}</span>
          </div>
        </div>

        <div className="ing-body">
          <div className="ing-main">
            <h2 className="ing-h2">Ingestion log</h2>
            <div className="ing-table-wrap">
              <table className="ing-table">
                <thead>
                  <tr>
                    <th>Date</th><th>Network</th><th>Date range</th><th>Calls ingested</th>
                    <th>Errors</th><th>Credits used</th><th>Requestor</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.length === 0 && (
                    <tr><td colSpan={7} className="ing-empty-row">No ingestion runs yet.</td></tr>
                  )}
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>{when(r.requestedAt)}</td>
                      <td>{NETWORK_LABEL[r.network] ?? r.network}</td>
                      <td>{r.dateRange.start} – {r.dateRange.end}</td>
                      <td>
                        {r.status === "running"
                          ? <span className="ing-badge ing-badge-running">running…</span>
                          : r.callsIngested.toLocaleString()}
                      </td>
                      <td>{r.status === "running" ? "—" : r.errors}</td>
                      <td>{r.status === "running" ? "—" : money(r.creditsUsedUsd)}</td>
                      <td>{requestorName(r.requestor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="ing-side">
            <button className={"ing-side-btn" + (panel === "schedule" ? " ing-side-btn-on" : "")}
              onClick={() => setPanel(panel === "schedule" ? null : "schedule")}>
              <span className="material-icons">event_repeat</span> Adjust schedule
            </button>
            {panel === "schedule" && (
              <div className="ing-panel">
                {schedule && (
                  <p className="ing-hint">
                    Currently <b>{CADENCE_LABEL[schedule.cadence]}</b>.
                  </p>
                )}
                {cadences.map((c) => (
                  <label key={c} className="ing-radio">
                    <input type="radio" name="cadence" checked={cadenceChoice === c}
                      onChange={() => setCadenceChoice(c)} />
                    {CADENCE_LABEL[c]}
                  </label>
                ))}
                <button className="ing-primary" disabled={savingSchedule} onClick={() => void saveSchedule()}>
                  {savingSchedule ? "Saving…" : "Save schedule"}
                </button>
              </div>
            )}

            <button className={"ing-side-btn" + (panel === "add" ? " ing-side-btn-on" : "")}
              onClick={() => setPanel(panel === "add" ? null : "add")}>
              <span className="material-icons">add_call</span> Add calls
            </button>
            {panel === "add" && (
              <form className="ing-panel" onSubmit={(e) => void submitAdhoc(e)}>
                <label className="ing-field">
                  Network
                  <select value={network} onChange={(e) => setNetwork(e.target.value as Network)}>
                    <option value="telecom-1847">{NETWORK_LABEL["telecom-1847"]}</option>
                    <option value="healthcare-2160">{NETWORK_LABEL["healthcare-2160"]}</option>
                  </select>
                </label>
                <label className="ing-field">
                  Start date
                  <input type="date" required value={start} max={todayStr()} onChange={(e) => setStart(e.target.value)} />
                </label>
                <label className="ing-field">
                  End date
                  <input type="date" required value={end} max={todayStr()} onChange={(e) => setEnd(e.target.value)} />
                </label>
                <label className="ing-check">
                  <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
                  Test mode (dry-run + 3-call test batch only, no full send)
                </label>
                {submitError && <p className="ing-error">{submitError}</p>}
                <button className="ing-primary" type="submit" disabled={submitting}>
                  {submitting ? "Submitting…" : "Submit"}
                </button>
              </form>
            )}

            <button className={"ing-side-btn" + (panel === "errors" ? " ing-side-btn-on" : "")}
              onClick={() => setPanel(panel === "errors" ? null : "errors")}>
              <span className="material-icons">error_outline</span> Errors
            </button>
            {panel === "errors" && (
              <div className="ing-panel">
                {errors.length === 0 && <p className="ing-hint">No errors recorded.</p>}
                {errors.map((e, i) => (
                  <div key={i} className="ing-error-card">
                    <div className="ing-error-top">
                      <span>{when(e.date)}</span>
                      <span>{NETWORK_LABEL[e.network] ?? e.network}</span>
                    </div>
                    <p className="ing-error-explain">{e.explanation}</p>
                    <p className="ing-error-fix"><b>Recommended fix:</b> {e.remediation}</p>
                  </div>
                ))}
                <a className="ing-secondary" href="/api/ingest/errors/report" target="_blank" rel="noopener noreferrer">
                  Download report
                </a>
              </div>
            )}

            <a className="ing-side-btn" href="/ingest-o-matic-readme.html" target="_blank" rel="noopener noreferrer">
              <span className="material-icons">menu_book</span> Read Me
              <span className="material-icons ing-side-ext">open_in_new</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
