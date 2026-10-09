import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

/* =============================================================================
   IngestOMatic — /ingest-o-matic
   -----------------------------------------------------------------------------
   Admin tool: schedule and log the bulk synthetic-call ingestion that seeds
   Invoca demo networks. Every /api/ingest/* route is admin-gated server-side;
   this screen assumes it's already reachable only via the hamburger menu's
   admin-only row (see LaunchMenu.tsx).

   Phase 2: each network runs its own independent cadence/trend/volume,
   replacing the single global schedule Phase 1 had. Plain useState/useEffect
   data-fetching, no context — matches FeedbackBoard's approach; this screen
   isn't referenced from anywhere else in the app.
   ============================================================================= */

type Network =
  | "telecom-1847"
  | "healthcare-2160"
  | "law-3062"
  | "finance-1752"
  | "insurance-3102"
  | "home-services-2751";
type Cadence = "monthly" | "biweekly" | "weekly" | "daily" | "off";
type Trend = "gradual-increase" | "hockey-stick" | "random" | "answered-recovery";
type TrendPeriod = "month" | "3-months" | "6-months";
type RunStatus = "running" | "done" | "partial" | "failed";
type SettingsAction = "noop" | "pause" | "resume" | "regenerate";

interface ErrorDetail { code: string; count: number; reason: string; explanation: string; remediation: string }
interface RunRecord {
  id: string; network: Network; requestedAt: string; startedAt: string; finishedAt: string | null;
  status: RunStatus; dateRange: { start: string; end: string };
  requestor: { email: string; name: string } | "Mr. Roboto";
  testMode: boolean; callsIngested: number; errors: number; errorDetails: ErrorDetail[]; creditsUsedUsd: number | null;
}
interface Totals { callsIngested: number; creditsUsedUsd: number; errors: number }

interface BatchState {
  totalUploads: number;
  nextUploadIndex: number;
  cycleNumber: number;
}
interface NetworkSettings {
  network: Network;
  cadence: Cadence;
  lastActiveCadence: Exclude<Cadence, "off"> | null;
  trend: Trend;
  trendPeriod: TrendPeriod;
  callsPerUpload: number;
  batch: BatchState | null;
  generatingSince: string | null;
  updatedAt: string;
  updatedBy: { email: string; name: string };
  notConfigured: boolean;
}

const NETWORK_LABEL: Record<Network, string> = {
  "telecom-1847": "Telecom (1847)",
  "healthcare-2160": "Healthcare (2160)",
  "law-3062": "Law (3062)",
  "finance-1752": "Finance (1752)",
  "insurance-3102": "Insurance (3102)",
  "home-services-2751": "Home Services (2751)",
};
const CADENCE_LABEL: Record<Cadence, string> = {
  off: "Off",
  daily: "Daily",
  weekly: "Weekly",
  biweekly: "Bi-weekly",
  monthly: "Monthly",
};
const TREND_LABEL: Record<Trend, string> = {
  "gradual-increase": "Gradual conversion increase",
  "hockey-stick": "Conversion hockey stick",
  random: "Random",
  "answered-recovery": "Sharp decrease in unanswered calls",
};
const TREND_PERIOD_LABEL: Record<TrendPeriod, string> = {
  month: "1 month",
  "3-months": "3 months",
  "6-months": "6 months",
};
const FIRINGS_PER_YEAR: Record<Exclude<Cadence, "off">, number> = {
  daily: 365, weekly: 52, biweekly: 26, monthly: 12,
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

interface Draft { cadence: Cadence; trend: Trend; trendPeriod: TrendPeriod; callsPerUpload: number }
function draftOf(s: NetworkSettings): Draft {
  return { cadence: s.cadence, trend: s.trend, trendPeriod: s.trendPeriod, callsPerUpload: s.callsPerUpload };
}
function draftEquals(a: Draft, b: Draft): boolean {
  return a.cadence === b.cadence && a.trend === b.trend && a.trendPeriod === b.trendPeriod && a.callsPerUpload === b.callsPerUpload;
}

function ConfirmDialog({ message, busy, onCancel, onConfirm }: {
  message: string; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="ing-dialog-overlay" role="dialog" aria-modal="true">
      <div className="ing-dialog">
        <p className="ing-dialog-msg">{message}</p>
        <div className="ing-dialog-actions">
          <button className="ing-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="ing-primary" disabled={busy} onClick={onConfirm}>{busy ? "Saving…" : "Confirm"}</button>
        </div>
      </div>
    </div>
  );
}

function NetworkRow({
  settings, cadences, trends, trendPeriods, callsPerUploadMax, expanded, onToggle, onSaved,
}: {
  settings: NetworkSettings;
  cadences: Cadence[]; trends: Trend[]; trendPeriods: TrendPeriod[]; callsPerUploadMax: number;
  expanded: boolean; onToggle: () => void; onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  // Re-sync the draft from the server only when a save actually landed
  // (updatedAt moved) — never while the admin is mid-edit on this row.
  useEffect(() => { setDraft(draftOf(settings)); }, [settings.updatedAt]);

  const [confirming, setConfirming] = useState<{ action: SettingsAction; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  const locked = !!settings.generatingSince;
  const dirty = !draftEquals(draft, draftOf(settings));
  const annual = draft.cadence === "off" ? null : FIRINGS_PER_YEAR[draft.cadence] * draft.callsPerUpload;

  async function handleSaveClick() {
    setToast("");
    try {
      const res = await fetch(`/api/ingest/networks/${settings.network}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || "Could not preview this change.");
      if (d.action === "noop") { setToast("Nothing changed."); return; }
      setConfirming({ action: d.action, message: d.message });
    } catch (e: any) {
      setToast(e?.message || "Could not preview this change.");
    }
  }

  async function handleConfirm() {
    if (!confirming) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/ingest/networks/${settings.network}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || "Could not save settings.");
      setConfirming(null);
      onSaved();
    } catch (e: any) {
      setToast(e?.message || "Could not save settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ing-net-row">
      <button className="ing-net-head" onClick={onToggle} type="button">
        <span className="material-icons ing-net-chevron">{expanded ? "expand_less" : "expand_more"}</span>
        <span className="ing-net-name">{NETWORK_LABEL[settings.network]}</span>
        <span className={"ing-net-cadence" + (settings.cadence === "off" ? " ing-net-cadence-off" : "")}>
          {CADENCE_LABEL[settings.cadence]}
        </span>
        {settings.notConfigured && <span className="ing-net-tag ing-net-tag-warn">not configured</span>}
        {locked && <span className="ing-net-tag ing-net-tag-busy">Generating…</span>}
      </button>

      {expanded && (
        <div className="ing-net-body">
          {settings.notConfigured && (
            <p className="ing-hint ing-net-warn-hint">
              This network's Invoca credentials aren't set yet — cadence and trend can still be configured, but
              scheduled uploads will fail until that's fixed.
            </p>
          )}
          {toast && <p className="ing-error">{toast}</p>}

          <fieldset className="ing-net-fields" disabled={locked}>
            <label className="ing-field">
              Cadence
              <select value={draft.cadence} onChange={(e) => setDraft((d) => ({ ...d, cadence: e.target.value as Cadence }))}>
                {cadences.map((c) => <option key={c} value={c}>{CADENCE_LABEL[c]}</option>)}
              </select>
            </label>
            <label className="ing-field">
              Trend
              <select value={draft.trend} onChange={(e) => setDraft((d) => ({ ...d, trend: e.target.value as Trend }))}>
                {trends.map((t) => <option key={t} value={t}>{TREND_LABEL[t]}</option>)}
              </select>
            </label>
            <label className="ing-field">
              Trend period
              <select value={draft.trendPeriod} onChange={(e) => setDraft((d) => ({ ...d, trendPeriod: e.target.value as TrendPeriod }))}>
                {trendPeriods.map((tp) => <option key={tp} value={tp}>{TREND_PERIOD_LABEL[tp]}</option>)}
              </select>
            </label>
            <label className="ing-field">
              Calls per upload
              <input
                type="number" min={1} max={callsPerUploadMax} value={draft.callsPerUpload}
                onChange={(e) => setDraft((d) => ({ ...d, callsPerUpload: Math.max(1, Number(e.target.value) || 1) }))}
              />
            </label>
          </fieldset>

          <p className="ing-hint">
            {annual === null
              ? "This network will not upload automatically while cadence is Off."
              : `≈ ${annual.toLocaleString()} calls/year at this cadence and volume.`}
          </p>
          {settings.batch && (
            <p className="ing-hint">
              Upload {Math.min(settings.batch.nextUploadIndex + 1, settings.batch.totalUploads)} of {settings.batch.totalUploads}
              {settings.batch.cycleNumber > 1 ? ` (cycle ${settings.batch.cycleNumber})` : ""}.
            </p>
          )}

          <button className="ing-primary" disabled={!dirty || locked} onClick={() => void handleSaveClick()}>
            Save settings
          </button>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          message={confirming.message}
          busy={saving}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void handleConfirm()}
        />
      )}
    </div>
  );
}

export function IngestOMatic() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [totals, setTotals] = useState<Totals>({ callsIngested: 0, creditsUsedUsd: 0, errors: 0 });

  const [networks, setNetworks] = useState<NetworkSettings[]>([]);
  const [cadences, setCadences] = useState<Cadence[]>([]);
  const [trends, setTrends] = useState<Trend[]>([]);
  const [trendPeriods, setTrendPeriods] = useState<TrendPeriod[]>([]);
  const [callsPerUploadMax, setCallsPerUploadMax] = useState(2000);
  const [legacyCadenceValue, setLegacyCadenceValue] = useState<string | null>(null);
  const [expandedNetwork, setExpandedNetwork] = useState<Network | null>(null);

  const [errors, setErrors] = useState<(ErrorDetail & { date: string; network: Network })[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [panel, setPanel] = useState<"add" | "errors" | null>(null);

  const [network, setNetwork] = useState<Network>("telecom-1847");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [testMode, setTestMode] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    try {
      const [runsRes, networksRes] = await Promise.all([
        fetch("/api/ingest/runs"),
        fetch("/api/ingest/networks"),
      ]);
      const runsData = await runsRes.json();
      if (!runsRes.ok) throw new Error(runsData?.error || "Could not load the ingestion log.");
      const networksData = await networksRes.json();
      if (!networksRes.ok) throw new Error(networksData?.error || "Could not load network settings.");
      setRuns(runsData.runs ?? []);
      setTotals(runsData.totals ?? { callsIngested: 0, creditsUsedUsd: 0, errors: 0 });
      setNetworks(networksData.networks ?? []);
      setCadences(networksData.cadences ?? []);
      setTrends(networksData.trends ?? []);
      setTrendPeriods(networksData.trendPeriods ?? []);
      if (networksData.callsPerUploadMax) setCallsPerUploadMax(networksData.callsPerUploadMax);
      setLegacyCadenceValue(networksData.legacyCadence ?? null);
    } catch (e: any) {
      setLoadError(e?.message || "Could not load Ingest-O-Matic.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Poll while anything is in flight — a run, or a network mid-generation.
  useEffect(() => {
    const anyRunning = runs.some((r) => r.status === "running");
    const anyGenerating = networks.some((n) => !!n.generatingSince);
    if (!anyRunning && !anyGenerating) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [runs, networks, load]);

  useEffect(() => {
    if (panel !== "errors") return;
    fetch("/api/ingest/errors").then((r) => r.json()).then((d) => setErrors(d.errors ?? [])).catch(() => {});
  }, [panel]);

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

        <div className="ing-net-card">
          <h2 className="ing-h2">Network settings</h2>
          {legacyCadenceValue && (
            <p className="ing-hint ing-net-legacy">
              Previously shared across every network: <b>{legacyCadenceValue}</b>. Each network below now has its own
              cadence, trend, and volume — none were carried forward automatically.
            </p>
          )}
          <div className="ing-net-list">
            {networks.map((n) => (
              <NetworkRow
                key={n.network}
                settings={n}
                cadences={cadences}
                trends={trends}
                trendPeriods={trendPeriods}
                callsPerUploadMax={callsPerUploadMax}
                expanded={expandedNetwork === n.network}
                onToggle={() => setExpandedNetwork(expandedNetwork === n.network ? null : n.network)}
                onSaved={() => void load()}
              />
            ))}
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
                        {r.status === "running" ? (
                          <span className="ing-badge ing-badge-running">running…</span>
                        ) : r.status === "partial" ? (
                          <>
                            {r.callsIngested.toLocaleString()}{" "}
                            <span className="ing-badge ing-badge-partial" title="The agent reported before the full send finished — this is a snapshot, not the final count. See its error details for the follow-up command.">
                              partial — still sending
                            </span>
                          </>
                        ) : (
                          r.callsIngested.toLocaleString()
                        )}
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
                    <option value="law-3062">{NETWORK_LABEL["law-3062"]}</option>
                    <option value="finance-1752">{NETWORK_LABEL["finance-1752"]}</option>
                    <option value="insurance-3102">{NETWORK_LABEL["insurance-3102"]}</option>
                    <option value="home-services-2751">{NETWORK_LABEL["home-services-2751"]}</option>
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
