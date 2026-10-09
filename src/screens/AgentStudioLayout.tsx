import { useState, type ReactNode } from "react";
import { CUSTOMER, isCustomerWorkflowPath } from "../customer/mode";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useProfile } from "../data/ProfileContext";
import { CreateWorkflowModal } from "../components/CreateWorkflowModal";
import { useAgentWorkflows, createdWorkflowPath } from "../data/agentWorkflows";
import { WorkflowRowMenu } from "../components/WorkflowRowMenu";
import { useExtraWorkflows } from "../data/quoteWorkflow";

/* Shared chrome for the Agent Studio editor sub-pages (Agent Settings,
   Knowledge Sources, …): header + left sub-nav + sticky footer. The active
   sub-nav item is driven by the current route. Icons match the live Titan/MUI
   set: LibraryBooksIcon / School / AutoAwesome / TransformIcon. */

export function InfoDot() {
  return <span className="material-icons ag-info">info_outline</span>;
}

const SUBNAV = [
  { key: "settings", label: "Agent Settings", icon: "library_books", to: "/agent-studio/agent" },
  { key: "knowledge", label: "Knowledge Sources", icon: "school", to: "/agent-studio/agent/knowledge" },
  { key: "recommendations", label: "AI Recommendations", icon: "auto_awesome", to: "/agent-studio/agent/recommendations" },
];

export function AgentStudioLayout({ children }: { children: ReactNode }) {
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const { profile } = useProfile();
  /* Includes any workflow created by an LSA quote request submitted during this demo,
     newest first — one definition, so a slug that lists here also resolves elsewhere. */
  const extraWfs = useExtraWorkflows(profile);
  const name = profile.customerName;
  const { pathname } = useLocation();
  const { items: created, create, remove } = useAgentWorkflows(profile.id);

  const workflows = [
    { name: `${name} - Voice`, to: "/agent-studio/agent/workflow/voice", icon: "call", status: "Live", warn: false, id: "" },
    { name: `${name} - SMS`, to: "/agent-studio/agent/workflow/sms", icon: "chat", status: "Live", warn: false, id: "" },
    // per-prospect extras (Reyes Law's SMS nurture agent) — keep their own label
    ...extraWfs.map((w) => ({
      name: w.label,
      to: `/agent-studio/agent/workflow/${w.slug}`,
      icon: w.channel === "SMS" ? "chat" : "call",
      status: w.status ?? "Live",
      warn: false,
      id: "",
    })),
    /* ⚠️ **WORKFLOWS THE SE CREATED, AND THEY LOOK DIFFERENT ON PURPOSE.** Measured by
       comparing the two captures: the newly created row carries MUI's warning triangle in
       `#FF7045` and the configured row does not (1 occurrence against 0), so the triangle
       means "this workflow has nothing configured" rather than being decoration. They also
       carry NO status pill — nothing is live about an empty flow. */
    ...created.map((w) => ({
      name: w.name,
      to: createdWorkflowPath(w.id),
      icon: w.channel === "SMS" ? "chat" : "call",
      status: "",
      warn: true,
      id: w.id,
    })),
  ].filter((w) => !CUSTOMER || isCustomerWorkflowPath(w.to));

  return (
    <div className="ag-page">
      <div className="ag-header">
        <div className="ag-header-main">
          <div className="ag-eyebrow">AGENT STUDIO</div>
          <div className="ag-title-row">
            <h1 className="ag-title">{name}</h1>
            <span className="ag-live">Live</span>
          </div>
        </div>
        {/* ⚠️ THE ACTIONS LIVE UP HERE, NOT IN A FOOTER (8/26/2026). The page carried a
            Cancel / Save / Publish bar pinned to the bottom and the real page has NO footer at
            all — a capture of it contains "Go Live" once and the words Save and Cancel zero
            times (its two "Publish" hits are the sidebar's Publishers nav item). Removing the
            bar without putting its action back would have lost the affordance, so Go Live sits
            where the real one does. */}
        <div className="ag-header-right">
          <div className="ag-lastsaved">Last Saved 6/21/2026, 1:01:31 PM</div>
          <button className="ag-golive">Go Live</button>
        </div>
      </div>

      <div className="ag-body">
        <aside className="ag-subnav">
          {SUBNAV.map((s) => {
            const inner = (<><span className="material-icons">{s.icon}</span><span>{s.label}</span></>);
            return s.to ? (
              <Link key={s.key} to={s.to} className={"ag-nav-item" + (pathname === s.to ? " active" : "")}>{inner}</Link>
            ) : (
              <button key={s.key} className="ag-nav-item">{inner}</button>
            );
          })}
          <button className="ag-nav-item ag-nav-workflows">
            <span className="material-icons">transform</span>
            <span>Agent Workflows</span>
          </button>
          <div className="ag-wf-list">
            {workflows.map((w) => (
              <Link to={w.to} className={"ag-wf" + (pathname === w.to ? " active" : "")} key={w.to}>
                <span className="material-icons ag-wf-ic">{w.icon}</span>
                <span className="ag-wf-name">{w.name}</span>
                {w.status ? <span className="ag-wf-status">{w.status}</span> : null}
                {w.warn ? (
                  /* Extracted verbatim from the capture (MUI `warning`, `#FF7045`, 20px). */
                  <svg className="ag-wf-warn" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z" />
                  </svg>
                ) : null}
                {/* ⚠️ ONLY A CREATED ROW'S KEBAB DOES ANYTHING. The built-ins are DERIVED from
                    the prospect, so "delete" would either no-op or appear to work and come
                    back on the next render; they keep the inert kebab the capture shows. */}
                {w.id ? (
                  <WorkflowRowMenu name={w.name} className="ag-wf-kebab" onDelete={() => {
                    remove(w.id);
                    /* Deleting the one you are LOOKING AT would otherwise strand you on the
                       not-found state, which reads as the delete having broken something. */
                    if (pathname === w.to) navigate("/agent-studio/agent/workflow/voice");
                  }} />
                ) : (
                  <span className="material-icons ag-wf-menu">more_vert</span>
                )}
              </Link>
            ))}
            {/* ⚠️ The modal lives on the SHARED chrome, not on one sub-page, because the
                sub-nav that carries this button is shared — the real page offers it from every
                Agent Studio screen. */}
            {!CUSTOMER && (
              <button className="ag-create-wf" onClick={() => setCreateOpen(true)}>
                <span className="material-icons">add</span> Create Workflow
              </button>
            )}
          </div>
        </aside>

        <section className="ag-content">{children}</section>
      </div>

      {/* ⚠️ **WHAT CREATE BUILDS IS NOW MEASURED (8/27/2026): an EMPTY workflow.** A capture
          taken straight after creating one shows a new sub-nav row carrying the typed name and
          a page holding only the four chrome nodes, its two user-group leaves offering
          "+ Add action". It used to navigate to the chosen channel's EXISTING workflow and
          discard the name — faithful to the modal and dishonest about the name, since an SE
          who typed "Marriott - After Hours" landed on "Marriott - Voice". */}
      <CreateWorkflowModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={(wfName, channel) => {
          setCreateOpen(false);
          navigate(createdWorkflowPath(create(wfName, channel).id));
        }}
      />

    </div>
  );
}
