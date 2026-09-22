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

export type Network = "telecom-1847" | "healthcare-2160";
export const NETWORKS: Network[] = ["telecom-1847", "healthcare-2160"];

export const NETWORK_LABEL: Record<Network, string> = {
  "telecom-1847": "Telecom (network 1847)",
  "healthcare-2160": "Healthcare (network 2160)",
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

/* Env var naming matches the comment already present in the original
   network_config.env files (e.g. "INVOCA_API_TOKEN_HEALTHCARE"), so this is
   following a convention that already existed rather than inventing one. */
const ENV_SUFFIX: Record<Network, string> = {
  "telecom-1847": "TELECOM",
  "healthcare-2160": "HEALTHCARE",
};

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
 *  one-time move, guarded so it only ever happens once). */
function materializeStateSymlink(network: Network): void {
  const dir = agentDir(network);
  const linkPath = path.join(dir, "state");
  const diskPath = agentStateDir(network);
  fs.mkdirSync(diskPath, { recursive: true });

  let stat: fs.Stats | fs.Dir | null = null;
  try { stat = fs.lstatSync(linkPath); } catch { /* nothing there yet */ }

  if (stat && (stat as fs.Stats).isSymbolicLink?.()) return; // already wired up

  if (stat && (stat as fs.Stats).isDirectory()) {
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

function materializeVenv(network: Network): void {
  const dir = agentDir(network);
  const venv = path.join(dir, ".venv");
  const pip = path.join(venv, "bin", "pip");
  if (fs.existsSync(pip)) return;
  try {
    execFileSync("python3", ["-m", "venv", ".venv"], { cwd: dir, stdio: "pipe" });
    execFileSync(pip, ["install", "-q", "-r", "requirements.txt"], { cwd: dir, stdio: "pipe" });
  } catch (e) {
    console.error(`[ingest] could not set up a Python environment for ${network} (need python3 on PATH):`, (e as Error).message);
  }
}

/** Called once at boot (server.ts and the Vite dev plugin). Idempotent. */
export function materializeIngestAgents(): { ready: Network[]; notConfigured: Network[] } {
  const ready: Network[] = [];
  const notConfigured: Network[] = [];
  for (const network of NETWORKS) {
    materializeStateSymlink(network);
    materializeVenv(network);
    if (materializeConfig(network)) ready.push(network);
    else notConfigured.push(network);
  }
  return { ready, notConfigured };
}
