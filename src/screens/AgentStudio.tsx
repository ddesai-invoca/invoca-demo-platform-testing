import { Link } from "react-router-dom";
import { CUSTOMER, isCustomerWorkflowPath } from "../customer/mode";
import { useProfile } from "../data/ProfileContext";
import { useAgentWorkflows, createdWorkflowPath, type CreatedWorkflow } from "../data/agentWorkflows";
import { WorkflowRowMenu } from "../components/WorkflowRowMenu";
import { useExtraWorkflows } from "../data/quoteWorkflow";

/* Agent Studio — one AI agent per customer with a Voice + SMS workflow.
   All names derive from the customer, so this re-skins for any prospect.
   The agent and its workflows open the agent configuration editor. */
/* One row shape for both the derived workflows and the created ones, so the map below does
   not have to narrow a union per cell. `created` is what tells them apart. */
interface WfRow {
  label: string; to: string; status: string; channel: string; type: string;
  triggeredBy: string; updated: string; live: string; created?: CreatedWorkflow;
}

/** `MM/DD/YYYY h:mm AM/PM`, the format this table's own date cells use. */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  const h = d.getHours() % 12 || 12;
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} `
    + `${h}:${p(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

export function AgentStudio() {
  const { profile, profileId } = useProfile();
  /* Includes any workflow created by an LSA quote request submitted during this demo,
     newest first — one definition, so a slug that lists here also resolves elsewhere. */
  const extraWfs = useExtraWorkflows(profile);
  const name = profile.customerName;
  const updated = "07/10/2026 1:46 PM";
  const { items: created, remove } = useAgentWorkflows(profileId);

  /* The standard pair, plus any per-prospect extras from
     reports.extraWorkflows (Reyes Law's SMS nurture agent). Extras carry their
     own label verbatim, so they aren't forced into the "<name> - <channel>"
     shape — a nurture agent needs a third segment. */
  const workflows = [
    { label: `Workflow: ${name} - Voice`, to: "/agent-studio/agent/workflow/voice", status: "Live", channel: "Voice", type: "Network", triggeredBy: "1 Campaign", updated, live: updated },
    { label: `Workflow: ${name} - SMS`, to: "/agent-studio/agent/workflow/sms", status: "Live", channel: "SMS", type: "Network", triggeredBy: "1 Campaign", updated, live: updated },
    ...extraWfs.map((w) => ({
      label: `Workflow: ${w.label}`,
      to: `/agent-studio/agent/workflow/${w.slug}`,
      status: w.status ?? "Live",
      channel: w.channel,
      type: "Network",
      triggeredBy: w.triggeredBy ?? "1 Campaign",
      updated, live: updated,
    })),
    /* ⚠️ **WORKFLOWS THE SE CREATED (8/27/2026), asked for directly: "when the workflow is
       created it should show in the list, and also be able to delete".** Every cell is
       DERIVED rather than invented: the channel is what the modal collected, the date is its
       own `createdAt`, "0 Campaigns" is the wording its own trigger node carries, and
       "Went Live On" is the same "-" the agent row already uses for never — because it never
       has. The one word not read off a capture of THIS table is the status, and "Draft" is
       the product's own: it is what the editor header shows for this agent. */
    ...created.map((w) => ({
      label: `Workflow: ${w.name}`,
      to: createdWorkflowPath(w.id),
      status: "Draft",
      channel: w.channel,
      type: "Network",
      triggeredBy: "0 Campaigns",
      updated: stamp(w.createdAt),
      live: "-",
      created: w,
    })),
  ].filter((w) => !CUSTOMER || isCustomerWorkflowPath(w.to)) as WfRow[];

  return (
    <div className="as-page">
      <div className="as-head">
        <h1 className="as-title">Agent Studio</h1>
        <button className="as-create"><span className="material-icons">add</span>Create AI Agent</button>
      </div>

      <table className="as-table">
        <thead>
          <tr>
            <th className="as-col-name">Name</th>
            <th>Status</th>
            <th>Channel</th>
            <th>Type</th>
            {!CUSTOMER && <th>Triggered By</th>}
            <th className="as-sorted">Last Updated <span className="material-icons">arrow_downward</span></th>
            <th>Went Live On</th>
            <th className="as-col-menu"></th>
          </tr>
        </thead>
        <tbody>
          <tr className="as-agent-row">
            <td className="as-name">
              <span className="material-icons as-chevron">expand_more</span>
              <Link to="/agent-studio/agent" className="as-link">Agent: {name}</Link>
            </td>
            <td></td>
            <td></td>
            <td>Network</td>
            <td></td>
            <td>{updated}</td>
            <td className="as-dash">-</td>
            <td className="as-menu"><span className="material-icons">more_vert</span></td>
          </tr>
          {workflows.map((w) => (
            <tr className="as-wf-row" key={w.to}>
              <td className="as-name as-indent"><Link to={w.to} className="as-link">{w.label}</Link></td>
              {/* A created workflow is not live, so it must not wear the live pill's green. */}
              <td><span className={w.created ? "as-status-draft" : "as-status-live"}>{w.status}</span></td>
              <td>{w.channel}</td>
              <td>{w.type}</td>
              {!CUSTOMER && <td><span className="as-pill">{w.triggeredBy}</span></td>}
              <td>{w.updated}</td>
              <td className={w.live === "-" ? "as-dash" : undefined}>{w.live}</td>
              <td className="as-menu">
                {w.created ? (
                  <WorkflowRowMenu name={w.created.name} onDelete={() => remove(w.created!.id)} />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
