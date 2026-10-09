import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

/* =============================================================================
   FeedbackBoard — /feedback
   -----------------------------------------------------------------------------
   Two audiences, one screen, decided by the server:

     • A submitter sees THEIR items and where each one stands. That is the whole
       reason to show them anything: the alternative is feedback disappearing into
       a void, which teaches people to stop sending it.
     • An admin sees everything and can move an item along. Reaching "Complete"
       emails the person who asked.

   The filtering is the SERVER's (feedbackApi), never a client-side hide: another
   person's text must not be in the payload at all.
   ============================================================================= */

interface Attachment { name: string; type: string; size: number; file: string }
interface Item {
  id: string; kind: "feedback" | "feature" | "callback"; title: string; body: string;
  page?: string; status: string; createdAt: string; updatedAt: string;
  submitter: { name: string; email: string };
  note?: string; notifiedAt?: string; attachments?: Attachment[];
  /* Only on a `callback`: what a customer on a shared demo asked for (engine/callbacks.ts). */
  callback?: { prospect: string; channel: "sms" | "voice"; want: "callback" | "live"; phone?: string };
}

const TONE: Record<string, string> = {
  "New": "fbb-new", "In review": "fbb-review", "Planned": "fbb-planned",
  "In progress": "fbb-progress", "Complete": "fbb-done", "Declined": "fbb-declined",
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    + ", " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function FeedbackBoard() {
  const [items, setItems] = useState<Item[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [admin, setAdmin] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [toast, setToast] = useState("");
  const [filter, setFilter] = useState<string>("All");
  /* ---- the note that goes out WITH the completion email (9/16/2026) ----------
     Asked for directly: "allow me to add a comment when i change status of any
     Feedback & feature requests to complete before the email gets send out, and the
     email includes the comment."

     ⚠️⚠️ **THE COMMENT IS `rec.note`, NOT A NEW FIELD — because the plumbing already
     existed and nothing could reach it.** PATCH has always accepted `note`, the board
     has always rendered it, and `completionEmail` has always included it in both the
     text and the HTML. What was missing was any way to WRITE one: the status `<select>`
     PATCHed `{ status }` alone, so the field was effectively dead. Adding a second
     `completionComment` would have duplicated a path that works.
     ⚠️ **ONE PATCH, WHICH IS WHY THE COMMENT CANNOT ARRIVE AFTER THE EMAIL.** The
     handler assigns `rec.note` BEFORE it builds the mail, so sending them together is
     ordering-correct by construction rather than by luck — `audit:app` pins that order. */
  const [composing, setComposing] = useState<{ item: Item; text: string } | null>(null);
  /* Feedback/support and feature requests are triaged differently: one is "is
     something broken", the other is a backlog. Mixing them in one list means
     reading past the wrong kind to find the one you came for. */
  const [tab, setTab] = useState<"feedback" | "feature" | "callback">("feedback");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/feedback");
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || "Could not load.");
      setItems(d.items ?? []);
      setStatuses(d.statuses ?? []);
      setAdmin(!!d.admin);
      setEmailEnabled(!!d.emailEnabled);
    } catch (e: any) { setError(e?.message || "Could not load."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function setStatus(item: Item, status: string, note?: string) {
    setBusyId(item.id);
    setComposing(null);
    try {
      const res = await fetch(`/api/feedback/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        /* `note` is omitted unless the composer produced one, so every other status
           change leaves an existing note exactly as it was. Sending `note: ""` would
           silently wipe it. */
        body: JSON.stringify(note === undefined ? { status } : { status, note }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || "Could not update.");
      setItems((prev) => prev.map((x) => (x.id === item.id ? d.item : x)));
      /* Say what actually happened with the email rather than assuming it went.
         An admin who thinks the person was told, when they were not, is worse off
         than one who knows the credential is missing. */
      if (d.mailed) {
        setToast(d.mailed.sent
          ? `Emailed ${item.submitter.name.split(/\s+/)[0]} that it's done.`
          : `Marked complete, but the email did not send (${d.mailed.reason}).`);
        setTimeout(() => setToast(""), 6000);
      }
    } catch (e: any) { setError(e?.message || "Could not update."); }
    finally { setBusyId(""); }
  }

  /* ⚠️ LAND WHERE SOMETHING IS WAITING, ONCE. The board used to open on "Feedback / Support"
     unconditionally, which for an SE whose only items are callbacks is an empty tab with the
     one thing that matters hiding behind a second click. A callback is time-sensitive (somebody
     asked to be rung), so an open one wins; otherwise the first tab that has anything. Only on
     the first load, so it never yanks the view out from under someone who is browsing. */
  const landed = useRef(false);
  useEffect(() => {
    if (loading || landed.current || !items.length) return;
    landed.current = true;
    const isOpen = (i: Item) => i.status !== "Complete" && i.status !== "Declined";
    if (items.some((i) => i.kind === "callback" && isOpen(i))) setTab("callback");
    else if (!items.some((i) => i.kind === tab)) setTab((items[0].kind as typeof tab));
  }, [loading, items, tab]);

  const ofKind = items.filter((i) => i.kind === tab);
  const shown = filter === "All" ? ofKind : ofKind.filter((i) => i.status === filter);
  const counts = statuses.map((s) => [s, ofKind.filter((i) => i.status === s).length] as const);
  const nFeedback = items.filter((i) => i.kind === "feedback").length;
  const nFeature = items.filter((i) => i.kind === "feature").length;
  const nCallback = items.filter((i) => i.kind === "callback").length;
  /* An open item is one nobody has finished with. Surfaced per tab so the split
     answers "what still needs me?" at a glance. */
  const open = (k: string) => items.filter((i) => i.kind === k && i.status !== "Complete" && i.status !== "Declined").length;

  return (
    <div className="fbb-page">
      <div className="fbb-wrap">
        <div className="fbb-top">
          <div>
            <p className="fbb-eyebrow">{admin ? "All submissions" : "What you've sent"}</p>
            <h1 className="fbb-h1">Feedback &amp; feature requests</h1>
          </div>
          <Link className="fbb-back" to="/">Back to the launch page</Link>
        </div>

        {admin && !emailEnabled && (
          <div className="fbb-warn">
            <span className="material-icons">info</span>
            <span>
              Email is not configured, so marking something Complete will not notify anyone.
              Set <code>SMTP_USER</code> and <code>SMTP_APP_PASSWORD</code> to turn it on.
            </span>
          </div>
        )}

        {items.length > 0 && (
          <div className="fbb-tabs" role="tablist" aria-label="Submission type">
            {([["feedback", "Feedback / Support", nFeedback], ["feature", "Feature requests", nFeature], ["callback", "Callbacks", nCallback]] as const)
              /* ⚠️ A TAB ONLY WHEN THERE IS SOMETHING IN IT — an empty "Callbacks" tab on every
                 board would be noise for the people who never share a demo. */
              .filter(([k, , n]) => k !== "callback" || n > 0)
              .map(([k, label, n]) => (
                <button key={k} role="tab" aria-selected={tab === k}
                  className={"fbb-tab" + (tab === k ? " fbb-tab-on" : "")}
                  onClick={() => { setTab(k as "feedback" | "feature" | "callback"); setFilter("All"); }}>
                  {label}
                  <span className="fbb-tab-n">{n}</span>
                  {open(k) > 0 && <span className="fbb-tab-open" title={`${open(k)} still open`}>{open(k)} open</span>}
                </button>
              ))}
          </div>
        )}

        {statuses.length > 0 && ofKind.length > 0 && (
          <div className="fbb-filters">
            <button className={"fbb-chip" + (filter === "All" ? " fbb-chip-on" : "")}
              onClick={() => setFilter("All")}>All <b>{ofKind.length}</b></button>
            {counts.filter(([, n]) => n > 0).map(([s, n]) => (
              <button key={s} className={"fbb-chip" + (filter === s ? " fbb-chip-on" : "")}
                onClick={() => setFilter(s)}>{s} <b>{n}</b></button>
            ))}
          </div>
        )}

        {error && <p className="fbb-error">{error}</p>}
        {loading && <p className="fbb-empty">Loading…</p>}

        {!loading && items.length === 0 && (
          <div className="fbb-empty-card">
            <span className="material-icons">campaign</span>
            <p className="fbb-empty-title">Nothing here yet</p>
            <p className="fbb-empty-sub">
              Use the Support button on the launch page to send something. You'll see it here,
              and {emailEnabled ? "you'll get an email once it's done." : "its status will update here."}
            </p>
          </div>
        )}

        {!loading && items.length > 0 && shown.length === 0 && (
          <p className="fbb-empty">Nothing here{filter === "All" ? "" : ` with status "${filter}"`}.</p>
        )}

        <div className="fbb-list">
          {shown.map((i) => (
            <article key={i.id} className="fbb-card">
              <div className="fbb-card-top">
                <span className={"fbb-kind " + (i.kind === "feature" ? "fbb-kind-feat" : i.kind === "callback" ? "fbb-kind-cb" : "fbb-kind-fb")}>
                  {i.kind === "feature" ? "Feature request" : i.kind === "callback" ? (i.callback?.want === "live" ? "Wants a person" : "Callback") : "Feedback"}
                </span>
                <span className={"fbb-status " + (TONE[i.status] || "fbb-new")}>{i.status}</span>
                {i.notifiedAt && <span className="fbb-notified" title={`Submitter emailed ${when(i.notifiedAt)}`}>
                  <span className="material-icons">mark_email_read</span></span>}
              </div>

              <h2 className="fbb-card-title">{i.title}</h2>
              {i.kind === "callback" && (
                <p className="fbb-cb">
                  <b>{i.callback?.phone ?? (i.callback?.want === "live" ? "Wanted to speak to a person right away" : "No number captured in text, see the read-back below")}</b>
                  <span>{i.callback?.channel === "voice" ? " · voice call" : " · text chat"}</span>
                </p>
              )}
              <p className="fbb-card-body">{i.body}</p>

              <div className="fbb-meta">
                {admin && i.kind !== "callback" && <span className="fbb-who">{i.submitter.name}</span>}
                <span>{when(i.createdAt)}</span>
                {i.page && i.page !== "/" && <span className="fbb-from">from <code>{i.page}</code></span>}
              </div>

              {(i.attachments?.length ?? 0) > 0 && (
                <div className="fbb-atts">
                  {i.attachments!.map((a) => {
                    const href = `/api/feedback/${i.id}/files/${encodeURIComponent(a.file)}`;
                    /* Only raster images preview inline. SVG is served as a download
                       by the API precisely so it cannot run here, so it gets the
                       file treatment too. */
                    const isImg = a.type.startsWith("image/") && a.type !== "image/svg+xml";
                    return (
                      <a key={a.file} className={"fbb-att" + (isImg ? " fbb-att-img" : "")}
                        href={href} target="_blank" rel="noopener noreferrer" title={a.name}>
                        {isImg
                          ? <img src={href} alt={a.name} loading="lazy" />
                          : <><span className="material-icons">description</span><span>{a.name}</span></>}
                      </a>
                    );
                  })}
                </div>
              )}

              {i.note && <p className="fbb-note"><b>Note:</b> {i.note}</p>}

              {(admin || i.kind === "callback") && (
                <div className="fbb-admin">
                  <label>
                    Status
                    <select value={i.status} disabled={busyId === i.id}
                      onChange={(e) => {
                        const next = e.target.value;
                        /* ⚠️ ONLY WHEN AN EMAIL WILL ACTUALLY GO OUT. "Complete" is the
                           one terminal status (`TERMINAL` in feedbackStore), and
                           `notifiedAt` means this person has already been told — so
                           re-completing an already-notified item saves straight through
                           rather than offering to write a comment nobody will receive. */
                        if (next === "Complete" && !i.notifiedAt && i.kind !== "callback") {
                          setComposing({ item: i, text: i.note ?? "" });
                          return;
                        }
                        void setStatus(i, next);
                      }}>
                      {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                  {busyId === i.id && <span className="fbb-busy">saving…</span>}
                  {i.status === "Complete" && !i.notifiedAt && emailEnabled &&
                    <span className="fbb-hint">not emailed</span>}
                </div>
              )}

              {composing?.item.id === i.id && (
                <div className="fbb-say">
                  <label className="fbb-say-lbl" htmlFor={`say-${i.id}`}>
                    {/* Say who reads it and what happens, rather than "add a comment".
                        An admin should not have to guess whether this is internal. */}
                    {emailEnabled
                      ? `Anything to tell ${i.submitter.name.split(/\s+/)[0]}? It goes in the email.`
                      : `Anything to add? Email is not configured, so this is saved on the item.`}
                  </label>
                  <textarea
                    id={`say-${i.id}`}
                    className="fbb-say-box"
                    rows={3}
                    maxLength={4000}
                    autoFocus
                    placeholder="Optional. For example: shipped today, the dropdown now shows just the voice name."
                    value={composing.text}
                    onChange={(e) => setComposing({ item: i, text: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Escape") setComposing(null); }}
                  />
                  <div className="fbb-say-act">
                    <button className="fbb-say-send" disabled={busyId === i.id}
                      onClick={() => void setStatus(i, "Complete", composing.text.trim())}>
                      {emailEnabled ? "Mark complete & email" : "Mark complete"}
                    </button>
                    <button className="fbb-say-cancel" onClick={() => setComposing(null)}>Cancel</button>
                  </div>
                  {/* Optional is optional, and it says so — an empty note simply omits
                      that line from the email, which `completionEmail` already handles.
                      ⚠️ IT HAS TO HONOUR `emailEnabled` TOO. The first version said "send the
                      email without a comment" unconditionally, directly under a label that
                      had just explained email is not configured — the two lines contradicted
                      each other on any server without a mailer. Caught by reading the rendered
                      panel, not by a type. */}
                  <p className="fbb-say-note">
                    {emailEnabled
                      ? "Leave it blank to send the email without a comment."
                      : "Leave it blank to just mark it complete."}
                  </p>
                </div>
              )}
            </article>
          ))}
        </div>
      </div>

      {toast && <div className="fbb-toast" role="status">{toast}</div>}
    </div>
  );
}
