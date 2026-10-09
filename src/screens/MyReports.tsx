import { useState } from "react";
import { CUSTOMER } from "../customer/mode";
import { Link } from "react-router-dom";
import { useProfile } from "../data/ProfileContext";
import type { GumloopArtifact } from "../data/schema";
import { openArtifact, VOICE_AI_ROUTING_ID, VOICE_AI_SCREENPOP_ID, type ArtifactOverrides } from "../artifacts";
import { hasTierReports } from "../data/signalTiers";
import { useVoiceCapture } from "../data/VoiceCaptureContext";
import { useSmsCapture } from "../data/SmsCaptureContext";
import { latestTransferredCall, voiceAiRouting, voiceAiScreenpop } from "../data/voiceAiArtifacts";

/* My Reports — the landing page for the Reports nav item. Lists a customer's
   saved reports; clicking the built Digital Journey report opens it. The other
   rows are realistic saved-report entries (the real list behaves the same — most
   saved reports are just names/schedules). Derived from customerName, so this
   works for any generated prospect with no engine change. */
interface ReportRow {
  name: string;
  type: string;
  createdAt: string;
  to?: string;   // set → clickable link to a built (in-platform) report
  artifact?: GumloopArtifact;  // set → Gumloop leave-behind (opens in a new tab; status shown)
}

/* ⚠️ **THE PROSPECT'S NAME IS NOT IN THESE TITLES (9/15/2026).** Asked for directly:
   *"remove (company name) for the report title for all prospects, for example AI SMS
   Conversation Intelligence (Aptive) remove the (Aptive)."* Every row used to carry it, which
   is redundant on a screen that only ever lists ONE prospect's reports — the network switcher
   above already says whose account this is.
   ⚠️ **THE OTHER PARENTHESES STAY, and they are a different thing entirely**: (Silver),
   (Gold), (Voice AI) and (LSA) qualify WHICH report this is, not whose. Dropping those would
   collapse four distinct rows into duplicates. `customerName` is gone from the signature
   rather than left unused, since `noUnusedParameters` is on. */
function reportsFor(
  hasConversation: boolean,
  hasSmsConversation: boolean,
  hasVoiceConversation: boolean,
  artifacts: GumloopArtifact[],
  tiers: boolean,
  voiceAi: boolean,
  hasLsaConversation: boolean,
): ReportRow[] {
  const rows: ReportRow[] = [
    { name: "Digital Journey & Call Attribution Report", type: "Interaction Details", createdAt: "6/25/26 7:35 am", to: "/reports/digital-insights" },
  ];
  if (hasConversation) {
    rows.push({ name: "Conversation Intelligence", type: "Interaction Details", createdAt: "6/25/26 7:41 am", to: "/reports/conversation-intelligence" });
  }
  /* ⚠️ HEALTH SPRING ONLY — the Signal AI Silver / Gold pair, added 8/24/2026 for an upsell
     conversation. Same template as the row above; what differs is which signals fire, what
     badges they carry, and which Gold-only panels exist. Gated on the prospect, so no other
     account grows two reports it did not ask for. */
  if (hasConversation && tiers) {
    rows.push({ name: "Conversation Intelligence (Silver)", type: "Interaction Details", createdAt: "8/24/26 9:02 am", to: "/reports/conversation-intelligence/silver" });
    rows.push({ name: "Conversation Intelligence (Gold)", type: "Interaction Details", createdAt: "8/24/26 9:04 am", to: "/reports/conversation-intelligence/gold" });
  }
  if (hasSmsConversation) {
    rows.push({ name: "AI SMS Conversation Intelligence", type: "Interaction Details", createdAt: "6/25/26 7:44 am", to: "/reports/sms-conversation-intelligence" });
  }
  /* ⚠️⚠️ **GATED ON A REAL QUOTE-REQUEST THREAD, NOT ON THE PROSPECT (9/15/2026).** Asked for
     directly: *"push the conversation into reports as well, call it AI SMS Conversation
     Intelligence (LSA)."* There is no seeded LSA example — the thread only exists once an SE
     submits the form and replies to it in Preview Agent — so listing the row unconditionally
     would put an EMPTY report in front of a prospect. Same reasoning as the (Voice AI) pair
     above, which is gated on a transferred call rather than on the account.
     ⚠️ It sits directly under the general SMS report because the two are siblings, and the
     general one now EXCLUDES these threads — see the screen's own header. */
  if (hasLsaConversation) {
    rows.push({ name: "AI SMS Conversation Intelligence (LSA)", type: "Interaction Details", createdAt: "just now", to: "/reports/sms-conversation-intelligence/lsa" });
  }

  if (hasVoiceConversation) {
    rows.push({ name: "AI Voice Conversation Intelligence", type: "Interaction Details", createdAt: "6/25/26 7:45 am", to: "/reports/voice-conversation-intelligence" });
  }
  /* ⚠️ **THE (Voice AI) PAIR EXISTS ONLY AFTER A REAL TRANSFERRED CALL** (8/27/2026). They tell
     one continuous story with the call the SE just had: the routing demo replays that
     conversation and shows it being matched to the department the agent actually named, and the
     screenpop shows what the receiving rep sees when it lands. Listing them on a cold demo
     would put an empty leave-behind in front of a prospect, so they are gated on the call, not
     on the prospect. */
  if (voiceAi) {
    rows.push({ name: `Voice Routing Demo (Voice AI)`, type: "AI Artifact", createdAt: "just now",
      artifact: { id: VOICE_AI_ROUTING_ID, name: "Voice Routing Demo (Voice AI)", status: "complete" } });
    rows.push({ name: `Voice Screenpop (Voice AI)`, type: "AI Artifact", createdAt: "just now",
      artifact: { id: VOICE_AI_SCREENPOP_ID, name: "Voice Screenpop (Voice AI)", status: "complete" } });
  }
  // Gumloop leave-behinds — open in a new browser tab once complete; status shows in the Schedule Status column.
  for (const a of artifacts) {
    rows.push({
      name: a.name,
      type: "AI Artifact",
      createdAt: a.createdAt ?? "—",
      artifact: a,
    });
  }
  return rows;
}

/* Schedule Status cell for a Gumloop row: Creating… (pulsing) / Failed.
   Complete artifacts show no status label (a dash, like every other row). */
function StatusCell({ status }: { status: GumloopArtifact["status"] }) {
  if (status === "failed") return <span className="rp-status rp-status-failed">Failed</span>;
  if (status === "creating") return (
    <span className="rp-status rp-status-creating">
      <span className="rp-status-dot" />Creating…
    </span>
  );
  return <span className="rp-dash">—</span>;
}

const TABS = ["Saved", "Requested", "Subscriptions"] as const;

export function MyReports() {
  const { profile } = useProfile();
  const { capturedFor } = useVoiceCapture();
  /* ⚠️ The (LSA) report exists only once a quote-request thread does — see `reportsFor`. */
  const hasLsa = useSmsCapture().capturedFor(profile.id).some((c) => c.lsa);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Saved");
  const [search, setSearch] = useState("");

  /* The newest call that actually ended in a transfer, or null — see `voiceAiArtifacts`. */
  const call = latestTransferredCall(capturedFor(profile.id));
  const overrides: ArtifactOverrides = call
    ? {
        voiceRoutingDemo: voiceAiRouting(profile, call) ?? undefined,
        voiceScreenpop: voiceAiScreenpop(profile, call) ?? undefined,
      }
    : {};
  /* ⚠️ GATED ON THE RENDERED SLICES, not merely on the call. A prospect with no seeded
     `voiceRoutingDemo` cannot produce one, and a row that opens nothing is worse than no row. */
  const hasVoiceAi = !!overrides.voiceRoutingDemo && !!overrides.voiceScreenpop;
  const allRows = reportsFor(!!profile.reports.conversationIntelligence, !!profile.reports.smsConversationIntelligence, !!profile.reports.voiceConversationIntelligence, profile.reports.gumloopArtifacts ?? [], hasTierReports(profile), hasVoiceAi, hasLsa);
  /* Customer build: only the two AI conversation reports. */
  const all = CUSTOMER ? allRows.filter((r) => r.to === "/reports/sms-conversation-intelligence" || r.to === "/reports/voice-conversation-intelligence") : allRows;
  const rows = search.trim()
    ? all.filter((r) => r.name.toLowerCase().includes(search.trim().toLowerCase()))
    : all;

  return (
    <div className="report-surface rp-page">
      <h1 className="rp-heading">My Reports</h1>

      <div className="rp-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={"rp-tab" + (t === tab ? " active" : "")}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Saved" ? (
        <>
          <input
            className="rp-search"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <div className="rp-editcols"><a href="#">Edit Columns</a></div>

          <div className="rp-table-scroll">
            <table className="rp-table">
              <thead>
                <tr>
                  <th className="rp-name-col sorted">Name <span className="material-icons">arrow_downward</span></th>
                  <th>Report Type</th>
                  <th>Created At</th>
                  <th>Schedule Frequency</th>
                  <th>Schedule Status</th>
                  <th className="rp-actions-col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={r.artifact && r.artifact.status !== "complete" ? "rp-row-pending" : undefined}>
                    <td>
                      <div className="rp-name-cell">
                        <span className="material-icons rp-star">star_border</span>
                        {r.artifact ? (
                          r.artifact.status === "complete" ? (
                            <button
                              className="rp-link rp-link-btn"
                              onClick={() => openArtifact(profile, r.artifact!, overrides)}
                              title="Opens in a new tab"
                            >
                              {r.name}
                              <span className="material-icons rp-ext">open_in_new</span>
                            </button>
                          ) : (
                            <span className="rp-link rp-link-disabled">{r.name}</span>
                          )
                        ) : r.to ? (
                          <Link className="rp-link" to={r.to}>{r.name}</Link>
                        ) : (
                          <a className="rp-link" href="#">{r.name}</a>
                        )}
                      </div>
                    </td>
                    <td>{r.type}</td>
                    <td>{r.createdAt}</td>
                    <td className="rp-dash">—</td>
                    <td>{r.artifact ? <StatusCell status={r.artifact.status} /> : <span className="rp-dash">—</span>}</td>
                    <td className="rp-actions-col"><span className="material-icons rp-kebab">more_vert</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rp-footer">
            <div className="rp-perpage">
              <span className="rp-select">25 <span className="material-icons">expand_more</span></span>
              records per page
            </div>
            <div className="rp-pageinfo">
              <span className="rp-entries">Showing 1 to {rows.length} of {rows.length} entries</span>
              <span className="rp-pager">
                <button className="rp-page-arrow">&larr;</button>
                <button className="rp-page-num active">1</button>
                <button className="rp-page-arrow">&rarr;</button>
              </span>
            </div>
          </div>
        </>
      ) : (
        <div className="rp-empty">No {tab.toLowerCase()} reports.</div>
      )}
    </div>
  );
}
