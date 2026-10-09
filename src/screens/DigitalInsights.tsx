import { useMemo } from "react";
import { Link } from "react-router-dom";
import { withCallingPage } from "../data/callingPage";
import { useProfile } from "../data/ProfileContext";
import { BarChart } from "../components/BarChart";
import { DataTable } from "../components/DataTable";
import { Pill } from "../components/Pill";
import { usePageData, DashAssistant } from "../components/GeneratedTiles";

export function DigitalInsights() {
  const { profile } = useProfile();
  /* Registers this page as the AI scope and returns the slice with any
     edits made ON THIS PAGE overlaid (see usePageData). */
  const base = useMemo(() => withCallingPage(profile.reports.digitalInsights), [profile.reports.digitalInsights]);
  const r = usePageData(base);
  const totalInteractions = r.chart.reduce((s, d) => s + d.value, 0);

  return (
    <div className="report-surface">
      <div className="breadcrumb">
        <Link to="/reports">My Reports</Link>
        <span className="sep">&rsaquo;</span>
        <span className="current">Interactions</span>
      </div>

      <div className="title-row">
        <h1 className="title">{r.title}</h1>
        <div className="title-actions">
          <span className="material-icons">star_border</span>
          <span className="material-icons">share</span>
          <span className="material-icons">get_app</span>
          <span className="material-icons">schedule</span>
          <button className="save-btn">Save</button>
          <span className="material-icons more">more_vert</span>
        </div>
      </div>

      <div className="toolbar">
        <div className="view-toggle">
          <div className="view-btn active"><span className="material-icons">grid_on</span></div>
          <div className="view-btn"><span className="material-icons">view_agenda</span></div>
        </div>
        <Pill>{`Custom:  ${r.dateRange}`}</Pill>
        <Pill closable>{r.filterLabel}</Pill>
        <button className="add-btn"><span className="material-icons">add</span></button>
      </div>

      <BarChart
        legend={r.chartLegend}
        data={r.chart}
        yMax={r.yMax}
        yTicks={r.yTicks}
      />

      <div className="table-meta">
        <span className="total">Total Interactions: {totalInteractions}</span>
        <span className="links">
          <a href="#">Edit Columns</a>
          <span className="divider">|</span>
          <a href="#">Reset Sorting</a>
        </span>
      </div>

      <DataTable
        dimensionColumns={r.dimensionColumns}
        signalColumns={r.signalColumns}
        rows={r.rows}
      />
      {/* Renders any tile the AI added on this page, and the hidden-tile rules.
          Without it both were silent no-ops here: the tile was stored and never
          drawn, and "remove that tile" reported success and changed nothing. */}
      <DashAssistant />
    </div>
  );
}
