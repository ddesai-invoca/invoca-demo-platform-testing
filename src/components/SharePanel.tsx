import type React from "react";
/* SharePanel — the customer link for one demo: create it, see the link and password, extend it,
   turn it off. Owner/admin only (the server enforces it; a refusal shows as an error here).
   With `auto`, it creates the share as soon as it opens — the "also create a customer demo"
   checkbox on Launch — so the SE lands on the finished link and password. */
import { useCallback, useEffect, useState } from "react";
import { useDemoLibrary, type ShareStatus } from "../data/DemoLibraryContext";

const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const STATE: Record<string, string> = { live: "Live", "soft-expired": "Agents off (read-only)", expired: "Expired", revoked: "Revoked" };

export function SharePanel({ demoId, prospect, auto, days: autoDays, onClose, inline }: {
  demoId: string; prospect: string; auto?: boolean; days?: number; onClose: () => void;
  /** Render in the page (Settings) instead of as a modal. */
  inline?: boolean;
}) {
  const { getShare, createShare, extendShare, revokeShare } = useDemoLibrary();
  const [share, setShare] = useState<ShareStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(autoDays ?? 30);
  const [copied, setCopied] = useState<string | null>(null);

  const run = useCallback(async (label: string, f: () => Promise<ShareStatus | null>) => {
    setBusy(label); setError(null);
    const r = await f();
    setBusy(null);
    if (!r) setError("That didn't work. Only the demo's owner or an admin can manage its customer link.");
    else setShare(r);
    return r;
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (auto) { await run("Creating", () => createShare(demoId, { days: autoDays, support: true })); }
      else { const r = await getShare(demoId); if (alive) setShare(r); }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoId]);

  const url = share ? `${location.origin}${share.path}` : "";
  const copy = (k: string, v: string) => { navigator.clipboard?.writeText(v).then(() => { setCopied(k); setTimeout(() => setCopied(null), 1500); }).catch(() => {}); };

  /* A plain function, not a component: a component defined here would remount its children on every render. */
  const wrap = (children: React.ReactNode) => inline
    ? <div className="shp shp-inline">{children}</div>
    : <div className="confirm-overlay" onClick={onClose}><div className="confirm-box shp" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Customer demo link">{children}</div></div>;
  return wrap(
      <>
        <h3 className="shp-h">{inline ? "Customer-facing, password-protected link" : `Customer demo for ${prospect}`}</h3>
        {loading || busy === "Creating" ? (
          <p className="shp-p">{busy === "Creating" ? "Building the support agents and the link. This takes about 30 seconds…" : "Loading…"}</p>
        ) : !share ? (
          <>
            <p className="shp-p">Give {prospect} a private link to a hands-on version of this demo: live Support agents (chat and voice), the Agent Studio workflows (Voice and SMS), and the two AI conversation reports. No dashboards, no Ask AI.</p>
            <label className="shp-row">Live agents stay on for <input className="shp-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value) || 30)} /> days</label>
            <div className="shp-actions">
              {!inline && <button className="confirm-cancel" onClick={onClose}>Cancel</button>}
              <button className="launch-btn shp-go" onClick={() => run("Creating", () => createShare(demoId, { days, support: true }))}>Create customer link</button>
            </div>
          </>
        ) : (
          <>
            <div className="shp-state"><span className={"shp-pill shp-" + share.state}>{STATE[share.state]}</span>
              <span className="shp-dates">Agents until {fmt(share.softExpiresAt)} · link ends {fmt(share.hardCutoffAt)}</span></div>
            <div className="shp-field"><span>Link</span><code>{url}</code><button onClick={() => copy("url", url)}>{copied === "url" ? "Copied" : "Copy"}</button></div>
            <div className="shp-field"><span>Password</span><code>{share.password ?? "(changed: the demo was renamed)"}</code>{share.password && <button onClick={() => copy("pw", share.password!)}>{copied === "pw" ? "Copied" : "Copy"}</button>}</div>
            <p className="shp-p shp-note">The password is the customer's name, lowercase with no spaces or punctuation. Callback and live-agent requests from their conversations arrive in your Inbox{share.supportSource === "fallback" ? ". The Support scenarios are generic ones: the AI generator was unavailable, so refresh the agents later for tailored ones" : ""}.</p>
            <div className="shp-actions shp-wrap">
              <button onClick={() => run("Extending", () => extendShare(demoId, 30))} disabled={!!busy}>Extend 30 days</button>
              <button onClick={() => run("Creating", () => createShare(demoId, { days: 30, support: true }))} disabled={!!busy}>Refresh agents</button>
              {share.state !== "revoked" && <button className="shp-danger" onClick={() => run("Revoking", () => revokeShare(demoId))} disabled={!!busy}>Turn off link</button>}
              {!inline && <button className="launch-btn shp-go" onClick={onClose}>Done</button>}
            </div>
          </>
        )}
        {error && <div className="launch-error">{error}</div>}
      </>
  );
}
