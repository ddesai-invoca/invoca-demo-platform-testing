import type { DailyPoint } from "../data/ingestReporting";

/* Calls ingested + errors share a LEFT axis (both are counts, and errors
   genuinely being tiny next to calls is the honest picture — not something
   to inflate with a false secondary scale). Cost is dollars, a different
   unit entirely, so it gets its own RIGHT axis — same dual-axis convention
   BarLineChart already uses elsewhere in this app for a bars+line pair,
   extended here to three independent line series. No existing chart
   component takes this exact shape (two left-axis lines + one right-axis
   line), so this is purpose-built for this panel rather than forced into
   one designed for something else. */

const CALLS_COLOR = "#2666f9";
const ERRORS_COLOR = "#e4131b";
const COST_COLOR = "#00b388";

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const step = Math.pow(10, Math.floor(Math.log10(v))) / 2;
  return Math.ceil(v / step) * step;
}

export function IngestReportChart({ points, height = 320 }: { points: DailyPoint[]; height?: number }) {
  const W = 900, H = height, padL = 56, padR = 64, padT = 36, padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = points.length;

  const leftMax = niceMax(Math.max(...points.map((p) => Math.max(p.callsIngested, p.errors)), 1));
  const rightMax = niceMax(Math.max(...points.map((p) => p.creditsUsedUsd), 1));
  const ticks = 5;

  const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const yLeft = (v: number) => padT + plotH - (v / leftMax) * plotH;
  const yRight = (v: number) => padT + plotH - (v / rightMax) * plotH;

  const labelEvery = Math.max(1, Math.ceil(n / 12));
  const line = (vals: number[], toY: (v: number) => number) => vals.map((v, i) => `${x(i)},${toY(v)}`).join(" ");

  if (n === 0) {
    return <p className="ing-empty">No activity in this window yet.</p>;
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ing-report-svg" width="100%">
      {/* legend */}
      <g>
        <line x1={padL} y1={16} x2={padL + 16} y2={16} stroke={CALLS_COLOR} strokeWidth={2} />
        <text x={padL + 20} y={20} className="ing-chart-legend">Calls ingested</text>
        <line x1={padL + 150} y1={16} x2={padL + 166} y2={16} stroke={ERRORS_COLOR} strokeWidth={2} />
        <text x={padL + 170} y={20} className="ing-chart-legend">Errors</text>
        <line x1={padL + 240} y1={16} x2={padL + 256} y2={16} stroke={COST_COLOR} strokeWidth={2} />
        <text x={padL + 260} y={20} className="ing-chart-legend">Agent cost ($)</text>
      </g>

      {/* left-axis gridlines + labels (the axis the grid belongs to) */}
      {Array.from({ length: ticks + 1 }, (_, t) => {
        const val = (leftMax / ticks) * t;
        const yy = yLeft(val);
        return (
          <g key={t}>
            <line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="#eceef1" strokeWidth={1} />
            <text x={padL - 10} y={yy + 4} textAnchor="end" className="ing-chart-axis">{Math.round(val)}</text>
          </g>
        );
      })}
      {/* right-axis labels only — no second gridline set, same convention this app's dual-axis charts already use */}
      {Array.from({ length: ticks + 1 }, (_, t) => {
        const val = (rightMax / ticks) * t;
        return (
          <text key={t} x={W - padR + 10} y={yRight(val) + 4} textAnchor="start" className="ing-chart-axis">
            ${val < 10 ? val.toFixed(1) : Math.round(val)}
          </text>
        );
      })}

      {/* x labels */}
      {points.map((p, i) =>
        (i % labelEvery === 0 || i === n - 1)
          ? <text key={p.date} x={x(i)} y={H - 10} textAnchor="middle" className="ing-chart-axis">{p.date.slice(5)}</text>
          : null
      )}

      {/* lines */}
      <polyline points={line(points.map((p) => p.callsIngested), yLeft)} fill="none" stroke={CALLS_COLOR} strokeWidth={1.5} />
      <polyline points={line(points.map((p) => p.errors), yLeft)} fill="none" stroke={ERRORS_COLOR} strokeWidth={1.5} />
      <polyline points={line(points.map((p) => p.creditsUsedUsd), yRight)} fill="none" stroke={COST_COLOR} strokeWidth={1.5} />
    </svg>
  );
}
