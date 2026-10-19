/* =============================================================================
   ingestReporting.ts — Invoca's fiscal calendar + run aggregation for the
   Ingest-O-Matic reporting panel.
   -----------------------------------------------------------------------------
   Pure functions, no React: IngestOMatic.tsx already fetches every RunRecord
   via /api/ingest/runs (the Ingestion log table renders all of them today),
   so this derives the daily series and the quarter/fiscal-year estimates
   client-side from that same data rather than adding a new backend route.

   Invoca's fiscal year does NOT follow the calendar year:
     Q1: Feb-Apr   Q2: May-Jul   Q3: Aug-Oct   Q4: Nov-Jan
   A fiscal year is named for the calendar year it ENDS in — Feb 2026
   through Jan 2027 is "FY27" (e.g. 2026-10-19 is FY27 Q3). All boundaries
   are computed in UTC calendar terms, consistent with how RunRecord
   timestamps (and the rest of this screen) already treat dates.
   ============================================================================= */

export type Quarter = 1 | 2 | 3 | 4;

export interface FiscalPeriod {
  fiscalYear: number; // e.g. 2027, displayed as "FY27"
  quarter: Quarter;
  quarterStart: Date;
  quarterEnd: Date; // inclusive, end of day
  yearStart: Date;
  yearEnd: Date; // inclusive, end of day
}

const Q_START_MONTH = [1, 4, 7, 10]; // 0-indexed: Feb, May, Aug, Nov
const Q_END_MONTH = [3, 6, 9, 0]; // 0-indexed: Apr, Jul, Oct, Jan (Jan belongs to the fiscal year itself)
const Q_END_DAY = [30, 31, 31, 31];

export function fiscalYearLabel(fiscalYear: number): string {
  return `FY${String(fiscalYear).slice(-2)}`;
}

function quarterRange(fiscalYear: number, quarter: Quarter): { start: Date; end: Date } {
  const idx = quarter - 1;
  const startYear = fiscalYear - 1;
  const endYear = quarter === 4 ? fiscalYear : fiscalYear - 1;
  const start = new Date(Date.UTC(startYear, Q_START_MONTH[idx], 1));
  const end = new Date(Date.UTC(endYear, Q_END_MONTH[idx], Q_END_DAY[idx], 23, 59, 59, 999));
  return { start, end };
}

export function fiscalPeriodOf(date: Date): FiscalPeriod {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1; // 1-12
  const fiscalYear = m >= 2 ? y + 1 : y;
  const quarter: Quarter = m >= 2 && m <= 4 ? 1 : m >= 5 && m <= 7 ? 2 : m >= 8 && m <= 10 ? 3 : 4;
  const { start: quarterStart, end: quarterEnd } = quarterRange(fiscalYear, quarter);
  const yearStart = new Date(Date.UTC(fiscalYear - 1, 1, 1));
  const yearEnd = new Date(Date.UTC(fiscalYear, 0, 31, 23, 59, 59, 999));
  return { fiscalYear, quarter, quarterStart, quarterEnd, yearStart, yearEnd };
}

function daysBetweenInclusive(a: Date, b: Date): number {
  const ms = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate())
    - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  return Math.floor(ms / 86_400_000) + 1;
}

export interface IngestRunLike {
  requestedAt: string;
  callsIngested: number;
  errors: number;
  creditsUsedUsd: number | null;
}

export interface DailyPoint {
  date: string; // YYYY-MM-DD, UTC
  callsIngested: number;
  errors: number;
  creditsUsedUsd: number;
}

/** One point per calendar day from `start` through `asOf` (inclusive), zero-
 *  filled for days with no runs — a flat line at zero before activity began
 *  is the honest shape, not a gap. */
export function dailySeries(runs: IngestRunLike[], start: Date, asOf: Date): DailyPoint[] {
  const byDay = new Map<string, { callsIngested: number; errors: number; creditsUsedUsd: number }>();
  for (const r of runs) {
    const t = new Date(r.requestedAt);
    if (t < start || t > asOf) continue;
    const key = t.toISOString().slice(0, 10);
    const bucket = byDay.get(key) ?? { callsIngested: 0, errors: 0, creditsUsedUsd: 0 };
    bucket.callsIngested += r.callsIngested || 0;
    bucket.errors += r.errors || 0;
    bucket.creditsUsedUsd += r.creditsUsedUsd || 0;
    byDay.set(key, bucket);
  }
  const days = daysBetweenInclusive(start, asOf);
  const out: DailyPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const bucket = byDay.get(key) ?? { callsIngested: 0, errors: 0, creditsUsedUsd: 0 };
    out.push({ date: key, ...bucket });
  }
  return out;
}

export interface FiscalEstimate {
  label: string;
  periodStart: Date;
  periodEnd: Date;
  daysElapsed: number;
  daysTotal: number;
  actualCalls: number;
  actualErrors: number;
  actualCostUsd: number;
  projectedCalls: number;
  projectedCostUsd: number;
}

/** A simple, transparent run-rate projection: the average daily pace so far
 *  THIS period, extrapolated across the days remaining in it. Not a
 *  forecast model — just "actual to date, plus what the current pace would
 *  add by period end" — which is what the UI states outright rather than
 *  presenting a misleadingly precise number. */
export function estimateForPeriod(runs: IngestRunLike[], start: Date, end: Date, asOf: Date, label: string): FiscalEstimate {
  const clampedAsOf = asOf < start ? start : asOf > end ? end : asOf;
  const daysTotal = daysBetweenInclusive(start, end);
  const daysElapsed = daysBetweenInclusive(start, clampedAsOf);
  const daysRemaining = Math.max(0, daysTotal - daysElapsed);

  let actualCalls = 0, actualErrors = 0, actualCostUsd = 0;
  for (const r of runs) {
    const t = new Date(r.requestedAt);
    if (t >= start && t <= clampedAsOf) {
      actualCalls += r.callsIngested || 0;
      actualErrors += r.errors || 0;
      actualCostUsd += r.creditsUsedUsd || 0;
    }
  }

  const dailyCallRate = daysElapsed > 0 ? actualCalls / daysElapsed : 0;
  const dailyCostRate = daysElapsed > 0 ? actualCostUsd / daysElapsed : 0;

  return {
    label, periodStart: start, periodEnd: end, daysElapsed, daysTotal,
    actualCalls, actualErrors, actualCostUsd,
    projectedCalls: actualCalls + dailyCallRate * daysRemaining,
    projectedCostUsd: actualCostUsd + dailyCostRate * daysRemaining,
  };
}
