/* One Knowledge Sources row, opened: the readable contents of that document or page, generated from
   the profile (see src/data/knowledgeDocs.ts). Reached from the table's links. */
import { Link, useSearchParams } from "react-router-dom";
import { useProfile } from "../data/ProfileContext";
import { AgentStudioLayout } from "./AgentStudioLayout";
import { knowledgeDocFor, knowledgeSourcesFor } from "../data/knowledgeDocs";

export function KnowledgeDoc() {
  const { profile } = useProfile();
  const [params] = useSearchParams();
  const all = knowledgeSourcesFor(profile, profile.reports.agentConfig?.knowledgeSources);
  const src = all[Number(params.get("i"))];
  return (
    <AgentStudioLayout>
      <p className="kd-back"><Link to="/agent-studio/agent/knowledge">Knowledge Sources</Link></p>
      {!src ? <p className="ks-sub">That source was not found.</p> : (() => {
        const d = knowledgeDocFor(profile, src);
        return (
          <article className="kd-doc">
            <h2 className="ag-section-title">{d.title}</h2>
            <p className="ks-sub">{d.kind === "Document" ? "Document the agent learned from" : "Web page the agent learned from"}
              {d.liveUrl && <> · <a className="ks-link" href={d.liveUrl} target="_blank" rel="noopener noreferrer">Open the live page</a></>}</p>
            {d.sections.map((s) => (
              <section key={s.heading} className="kd-sec">
                <h3 className="kd-h">{s.heading}</h3>
                {s.lines.map((l, i) => <p key={i} className="kd-p">{l}</p>)}
              </section>
            ))}
          </article>
        );
      })()}
    </AgentStudioLayout>
  );
}
