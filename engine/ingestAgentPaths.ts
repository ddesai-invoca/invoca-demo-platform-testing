/* =============================================================================
   ingestAgentPaths.ts — where each ingestion subagent's files live, and how its
   secrets/state get materialized at boot.
   -----------------------------------------------------------------------------
   Each subagent (agents/subagents/<network>/) is a self-contained package ported
   from the standalone "Bulk Demo Calls" project: AGENT_PROMPT.md, ingest.py,
   prepare_date_range.py, template_calls.csv, custom_data_dictionary.csv are
   committed to git as-is. Two things are NOT committed, because the Python
   scripts hardcode both relative to their own folder (`HERE = Path(__file__).parent`)
   and neither can be redirected via an env var without editing that Python:

     - network_config.env  (plaintext Invoca API credentials)
     - state/               (the permanent send-history ledger — must survive a
                              redeploy, so it cannot live in the git checkout)

   So this module writes network_config.env from server env vars on every boot,
   and symlinks state/ onto DATA_DIR (the same persistent-disk resolution
   demoStore.ts uses) — mirroring that file's one-time-migration-on-boot style
   rather than inventing a new one.
   ============================================================================= */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./demoStore.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");

export type Network =
  | "telecom-1847"
  | "healthcare-2160"
  | "law-3062"
  | "finance-1752"
  | "insurance-3102"
  | "home-services-2751";
export const NETWORKS: Network[] = [
  "telecom-1847",
  "healthcare-2160",
  "law-3062",
  "finance-1752",
  "insurance-3102",
  "home-services-2751",
];

export const NETWORK_LABEL: Record<Network, string> = {
  "telecom-1847": "Telecom (network 1847)",
  "healthcare-2160": "Healthcare (network 2160)",
  "law-3062": "Law (network 3062)",
  "finance-1752": "Finance (network 1752)",
  "insurance-3102": "Insurance (network 3102)",
  "home-services-2751": "Home Services (network 2751)",
};

/** The git-tracked folder: AGENT_PROMPT.md, scripts, content bank. */
export function agentDir(network: Network): string {
  return path.join(REPO, "agents", "subagents", network);
}

/** The persistent-disk folder this network's send-history ledger actually lives
 *  in — survives a redeploy, unlike the git checkout. */
export function agentStateDir(network: Network): string {
  return path.join(DATA_DIR, "ingest-agents", network, "state");
}

/** Where a network's generated trend batches (the Phase 2 cached upload
 *  CSVs) live — persistent disk, not the git checkout, same reasoning as
 *  agentStateDir: these are generated working files, not source, and must
 *  survive a redeploy since a batch can span months of real-world time. */
export function agentBatchDir(network: Network): string {
  return path.join(DATA_DIR, "ingest-agents", network, "batches");
}

/* Env var naming matches the comment already present in the original
   network_config.env files (e.g. "INVOCA_API_TOKEN_HEALTHCARE"), so this is
   following a convention that already existed rather than inventing one. */
const ENV_SUFFIX: Record<Network, string> = {
  "telecom-1847": "TELECOM",
  "healthcare-2160": "HEALTHCARE",
  "law-3062": "LAW",
  "finance-1752": "FINANCE",
  "insurance-3102": "INSURANCE",
  "home-services-2751": "HOME_SERVICES",
};

/** The exact four env var names this network needs — for boot-time logging
 *  and any other place that has to tell a human what's missing, rather than
 *  guessing the suffix from the network id (which produced the wrong name,
 *  e.g. "INVOCA_*_HEALTHCARE-2160" instead of "INVOCA_*_HEALTHCARE"). */
export function requiredEnvVarNames(network: Network): string[] {
  const suffix = ENV_SUFFIX[network];
  return ["INVOCA_API_TOKEN", "INVOCA_NETWORK_ID", "INVOCA_CAMPAIGN_ID", "INVOCA_ENDPOINT"].map((k) => `${k}_${suffix}`);
}

function networkConfigEnvContents(network: Network): string | null {
  const suffix = ENV_SUFFIX[network];
  const keys = {
    INVOCA_API_TOKEN: process.env[`INVOCA_API_TOKEN_${suffix}`],
    INVOCA_NETWORK_ID: process.env[`INVOCA_NETWORK_ID_${suffix}`],
    INVOCA_CAMPAIGN_ID: process.env[`INVOCA_CAMPAIGN_ID_${suffix}`],
    INVOCA_ENDPOINT: process.env[`INVOCA_ENDPOINT_${suffix}`],
  };
  if (Object.values(keys).some((v) => !v)) return null;
  return Object.entries(keys).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Regenerates network_config.env for one subagent from server env vars.
 *  Returns false (and writes nothing) when any of the four vars are missing —
 *  the caller decides whether that's fatal (production) or just "this network
 *  isn't wired up locally yet" (dev). */
function materializeConfig(network: Network): boolean {
  const contents = networkConfigEnvContents(network);
  if (!contents) return false;
  writeAtomic(path.join(agentDir(network), "network_config.env"), contents);
  return true;
}

/** Ensures agents/subagents/<network>/state is a symlink onto the persistent
 *  disk, carrying over any real ledger already sitting in the checkout (a
 *  one-time move), and REPAIRS it if it's a symlink pointing somewhere else
 *  than the current DATA_DIR resolution.
 *
 *  That repair case is not hypothetical: this whole project directory was
 *  renamed once (mid-project), and a symlink created before that rename
 *  keeps pointing at the OLD absolute path forever — `isSymbolicLink()`
 *  alone can't tell a healthy symlink from a dangling one, so the original
 *  version of this function treated "it's a symlink" as "already wired up"
 *  and never looked twice. `fs.Stats.isDirectory()` from `lstatSync` only
 *  describes the SYMLINK itself (always false for a symlink); checking the
 *  RESOLVED target's type is what actually detects a dangling link. */
function materializeStateSymlink(network: Network): void {
  const dir = agentDir(network);
  const linkPath = path.join(dir, "state");
  const diskPath = agentStateDir(network);
  fs.mkdirSync(diskPath, { recursive: true });

  let lstat: fs.Stats | null = null;
  try { lstat = fs.lstatSync(linkPath); } catch { /* nothing there yet */ }

  if (lstat?.isSymbolicLink()) {
    let resolvesToADirectory = false;
    try { resolvesToADirectory = fs.statSync(linkPath).isDirectory(); } catch { /* dangling */ }
    if (resolvesToADirectory && fs.readlinkSync(linkPath) === diskPath) return; // already correct

    // Either dangling, or pointing at a stale pre-rename path. Carry over
    // anything still reachable through the old target before repointing —
    // best-effort, since a renamed/moved folder usually means the old
    // target is gone for good and there's nothing left to carry.
    if (resolvesToADirectory) {
      const staleTarget = linkPath; // following the symlink reads the OLD location
      for (const name of fs.readdirSync(staleTarget)) {
        const from = path.join(staleTarget, name);
        const to = path.join(diskPath, name);
        if (!fs.existsSync(to)) fs.copyFileSync(from, to);
      }
    }
    fs.rmSync(linkPath, { force: true });
    fs.symlinkSync(diskPath, linkPath);
    return;
  }

  if (lstat?.isDirectory()) {
    // Real directory (first boot after porting these files in) — carry its
    // ledger onto the disk once, then replace it with the symlink.
    for (const name of fs.readdirSync(linkPath)) {
      const from = path.join(linkPath, name);
      const to = path.join(diskPath, name);
      if (!fs.existsSync(to)) fs.copyFileSync(from, to);
    }
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
  fs.symlinkSync(diskPath, linkPath);
}

/** Regenerates (or repairs) this network's `.venv`, used so the agent never
 *  has to discover `requests` is missing and improvise its own throwaway
 *  venv mid-run (see AGENT_PROMPT.md's "What you have" note on `.venv/`).
 *  Returns whether `requests` is now genuinely importable from it.
 *
 *  A prior boot's `pip` binary EXISTING is not proof its install step
 *  actually finished — a boot can die between creating the venv and
 *  finishing `pip install`, or partway through pip's own install — so this
 *  verifies by actually importing `requests`, and rebuilds if that fails,
 *  rather than trusting a `pip` binary being present forever. */
function materializeVenv(network: Network): boolean {
  const dir = agentDir(network);
  const venv = path.join(dir, ".venv");
  const python = path.join(venv, "bin", "python3");
  const pip = path.join(venv, "bin", "pip");
  const importsRequests = () => {
    try { execFileSync(python, ["-c", "import requests"], { stdio: "pipe" }); return true; }
    catch { return false; }
  };
  if (fs.existsSync(python) && importsRequests()) return true;
  try {
    execFileSync("python3", ["-m", "venv", ".venv"], { cwd: dir, stdio: "pipe" });
    execFileSync(pip, ["install", "-q", "-r", "requirements.txt"], { cwd: dir, stdio: "pipe" });
    return importsRequests();
  } catch (e) {
    console.error(`[ingest] could not set up a Python environment for ${network} (need python3 on PATH):`, (e as Error).message);
    return false;
  }
}

/** Called once at boot (server.ts and the Vite dev plugin). Idempotent. */
export function materializeIngestAgents(): { ready: Network[]; notConfigured: Network[]; venvBroken: Network[] } {
  const ready: Network[] = [];
  const notConfigured: Network[] = [];
  const venvBroken: Network[] = [];
  for (const network of NETWORKS) {
    materializeStateSymlink(network);
    if (!materializeVenv(network)) venvBroken.push(network);
    if (materializeConfig(network)) ready.push(network);
    else notConfigured.push(network);
  }
  return { ready, notConfigured, venvBroken };
}
