/* =============================================================================
   ingestNetworkSettings.ts — Phase 2: per-network Ingest-O-Matic settings
   -----------------------------------------------------------------------------
   Replaces the single global ScheduleConfig (one cadence for every network)
   with one JSON file per network, same one-file-per-record convention
   RunRecord/demoStore.ts already use. Each network gets its own cadence,
   trend, trend period, calls-per-upload, and its own cached upload batch.

   No boot-time migration of the old global ingest-schedule.json — every
   network simply reads as this module's default ("off") until an admin
   explicitly configures it. The old file's cadence applied uniformly to
   every network with no trend/volume behind it; silently promoting that
   into a real per-network trend/volume config would start real sends
   nobody actually confirmed. legacyCadence() surfaces the old value for
   display only, so nothing visible is lost, but nothing is carried forward
   automatically either.
   ============================================================================= */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./demoStore.ts";
import { NETWORKS, type Network } from "./ingestAgentPaths.ts";

const SETTINGS_DIR = path.join(DATA_DIR, "ingest-settings");
const LEGACY_SCHEDULE_FILE = path.join(DATA_DIR, "ingest-schedule.json");

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export type Cadence = "monthly" | "biweekly" | "weekly" | "daily" | "off";
export const CADENCES: Cadence[] = ["off", "daily", "weekly", "biweekly", "monthly"];
export const ACTIVE_CADENCES: Exclude<Cadence, "off">[] = ["daily", "weekly", "biweekly", "monthly"];

/** "answered-recovery" = the written spec's "sharp decrease in unanswered
 *  calls" — named for what it shapes (the not-answered rate recovering
 *  toward normal), not for the shape itself, since "hockey-stick" already
 *  owns that name for the conversion-rate trend. */
export type Trend = "gradual-increase" | "hockey-stick" | "random" | "answered-recovery";
export const TRENDS: Trend[] = ["gradual-increase", "hockey-stick", "random", "answered-recovery"];

export type TrendPeriod = "month" | "3-months" | "6-months";
export const TREND_PERIODS: TrendPeriod[] = ["month", "3-months", "6-months"];

/** How many upload events a cadence×period combination produces. Mirrored
 *  exactly in trend_batch.py (--cadence/--period take the same literals) —
 *  if this table and that script's table ever disagree, the orchestrator's
 *  BatchState.totalUploads (trusted from the script's own stdout) wins, so
 *  a drift here only breaks the *preview* copy, never a real send. */
const PERIOD_DAYS: Record<TrendPeriod, number> = { month: 30, "3-months": 90, "6-months": 180 };
const CADENCE_STEP_DAYS: Record<Exclude<Cadence, "off">, number> = {
  daily: 1, weekly: 7, biweekly: 14, monthly: 30,
};
export function computeTotalUploads(cadence: Exclude<Cadence, "off">, period: TrendPeriod): number {
  return Math.max(1, Math.round(PERIOD_DAYS[period] / CADENCE_STEP_DAYS[cadence]));
}

/** The date window (ending "today") that one upload's rows get spread
 *  across at send time — see ingestOrchestrator.ts's restamp step. */
export function cadenceWindowDays(cadence: Exclude<Cadence, "off">): number {
  return CADENCE_STEP_DAYS[cadence];
}

export interface BatchFileEntry {
  path: string;
  index: number;
}

export interface BatchState {
  batchId: string;
  generatedAt: string;
  settingsSnapshot: { cadence: Cadence; trend: Trend; trendPeriod: TrendPeriod; callsPerUpload: number };
  totalUploads: number;
  /** The pause/resume cursor — this one field IS what "Off then On" has to
   *  leave untouched. Never reset except by a genuine regenerate. */
  nextUploadIndex: number;
  cycleNumber: number;
  files: BatchFileEntry[];
}

export interface NetworkSettings {
  network: Network;
  cadence: Cadence;
  /** What "turn it back on" restores to. Set whenever cadence moves away
   *  from "off" to something active; left alone while already active. */
  lastActiveCadence: Exclude<Cadence, "off"> | null;
  trend: Trend;
  trendPeriod: TrendPeriod;
  callsPerUpload: number;
  /** Per-network scheduler dedupe guard — replaces the single global one a
   *  10-minute tick re-evaluating the same firing day used to share. */
  lastFiredKey?: string;
  batch: BatchState | null;
  /** Persisted, not just an in-memory lock — see reconcileStaleGenerations
   *  in ingestOrchestrator.ts. Non-null while a batch is being generated. */
  generatingSince: string | null;
  updatedAt: string;
  updatedBy: { email: string; name: string };
}

export const CALLS_PER_UPLOAD_MAX = 2000;
export const DEFAULT_CALLS_PER_UPLOAD = 500;

function defaultSettings(network: Network): NetworkSettings {
  return {
    network,
    cadence: "off",
    lastActiveCadence: null,
    trend: "random",
    trendPeriod: "month",
    callsPerUpload: DEFAULT_CALLS_PER_UPLOAD,
    batch: null,
    generatingSince: null,
    updatedAt: new Date(0).toISOString(),
    updatedBy: { email: "system", name: "System default" },
  };
}

function settingsFile(network: Network): string { return path.join(SETTINGS_DIR, `${network}.json`); }

export function getNetworkSettings(network: Network): NetworkSettings {
  try {
    return { ...defaultSettings(network), ...JSON.parse(fs.readFileSync(settingsFile(network), "utf8")) };
  } catch {
    return defaultSettings(network);
  }
}

export function saveNetworkSettings(network: Network, next: NetworkSettings): NetworkSettings {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  writeAtomic(settingsFile(network), JSON.stringify(next, null, 2));
  return next;
}

export function listAllNetworkSettings(): NetworkSettings[] {
  return NETWORKS.map(getNetworkSettings);
}

/** The old shared cadence, if the Phase 1 schedule file is still sitting on
 *  disk — display-only, read on every call rather than cached, since this
 *  is just a one-line "here's what it used to say" note in the UI. */
export function legacyCadence(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(LEGACY_SCHEDULE_FILE, "utf8"));
    return typeof raw?.cadence === "string" ? raw.cadence : null;
  } catch {
    return null;
  }
}

export type SettingsAction = "noop" | "pause" | "resume" | "regenerate";

export interface SettingsPatch {
  cadence?: Cadence;
  trend?: Trend;
  trendPeriod?: TrendPeriod;
  callsPerUpload?: number;
}

/** The one function that decides what a settings save actually does —
 *  shared by the preview route (confirm-dialog copy) and the save route
 *  (what really happens), so the two can never disagree about which case
 *  a given change falls into. */
export function classifySettingsChange(current: NetworkSettings, patch: SettingsPatch): SettingsAction {
  const next: NetworkSettings = { ...current, ...patch };
  const unchanged = next.cadence === current.cadence && next.trend === current.trend
    && next.trendPeriod === current.trendPeriod && next.callsPerUpload === current.callsPerUpload;
  if (unchanged) return "noop";

  const onlyCadenceChanged = next.trend === current.trend
    && next.trendPeriod === current.trendPeriod && next.callsPerUpload === current.callsPerUpload
    && next.cadence !== current.cadence;

  if (onlyCadenceChanged && current.cadence !== "off" && next.cadence === "off") return "pause";
  if (onlyCadenceChanged && current.cadence === "off" && current.lastActiveCadence !== null
    && next.cadence === current.lastActiveCadence) return "resume";

  // Any other change — including cadence-to-off bundled with a trend/period/
  // volume change in the same save — regenerates. Deliberately no partial-
  // reuse optimization (see the Phase 2 plan's decision #4).
  return "regenerate";
}

/** Pure settings transformation — never shells out, never generates a
 *  batch. The caller (ingestOrchestrator.ts) is responsible for actually
 *  running trend_batch.py when this returns a "regenerate" shape; this
 *  function only decides what the STORED settings should look like. */
export function applySettingsAction(
  current: NetworkSettings, patch: SettingsPatch, action: SettingsAction, by: { email: string; name: string },
): NetworkSettings {
  const next: NetworkSettings = { ...current, ...patch, updatedAt: new Date().toISOString(), updatedBy: by };
  if (patch.cadence !== undefined && patch.cadence !== "off") next.lastActiveCadence = patch.cadence;
  if (action === "regenerate") {
    // Cleared now; the orchestrator attaches a real batch once generation
    // finishes (or leaves it null if the new cadence is "off" — nothing to
    // generate against with no active cadence).
    next.batch = null;
  }
  // "pause"/"resume"/"noop" leave `batch` exactly as the spread above left it.
  return next;
}

/** Plain-English description of what `action` will actually do, for the
 *  blocking confirm dialog every settings change shows. `totalUploads` is
 *  only meaningful for "regenerate". `label` is the caller's already-
 *  formatted display name (NETWORK_LABEL[network]) — this module stays
 *  UI-agnostic rather than importing NETWORK_LABEL itself. */
export function describeSettingsAction(
  label: string, action: SettingsAction, current: NetworkSettings, patch: SettingsPatch,
): { message: string; totalUploads?: number } {
  switch (action) {
    case "noop":
      return { message: "No changes to save." };
    case "pause": {
      const remaining = current.batch ? current.batch.totalUploads - current.batch.nextUploadIndex : 0;
      return {
        message: remaining > 0
          ? `${label} will pause after its next scheduled upload. Cached files for the remaining ${remaining} upload(s) are preserved and will resume automatically when you turn it back on.`
          : `${label} will pause. It has no cached uploads left to preserve.`,
      };
    }
    case "resume": {
      const b = current.batch;
      return {
        message: b
          ? `${label} will resume at upload ${b.nextUploadIndex + 1} of ${b.totalUploads}, continuing its current ${current.trend} trend.`
          : `${label} will resume. No batch has been generated yet, so one will be built on its next scheduled upload.`,
      };
    }
    case "regenerate": {
      const next: NetworkSettings = { ...current, ...patch };
      if (next.cadence === "off") {
        return { message: `${label}'s cached uploads will be cleared. It will stay off until a cadence is chosen again.` };
      }
      const totalUploads = computeTotalUploads(next.cadence, next.trendPeriod);
      return {
        message: `This clears ${label}'s cached uploads and regenerates all ${totalUploads} file(s) with a new ${next.trend} trend. ${label}'s settings will be locked until that finishes.`,
        totalUploads,
      };
    }
  }
}
