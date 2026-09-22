# Healthcare Network 2160 Subagent — What's In This Folder

This folder is a self-contained package for one job: getting Surfside
Healthcare demo call data into Invoca network 2160. Everything the
subagent needs to do that lives inside this folder — no dependency on your
Mac, the rest of the `Bulk Demo Calls` project, or the Telecom subagent's
files. It's the same design as `subagents/telecom-network-1847/`, adapted
to this network's data.

## The instructions

**`AGENT_PROMPT.md`**
The subagent's actual instructions — its role, what it's allowed to do,
the step-by-step order it should run things in, when to retry a failure
vs. stop and ask, and the hard rules it must never break (like never
reusing a call ID). Hand this to the new agent so it knows how to behave,
not just what scripts exist. It also documents the one thing specific to
this network: a derived `patient_type` custom_data field that isn't a
straight column copy.

## The scripts

**`ingest.py`**
The script that actually sends call data to Invoca. Give it a CSV that
already has IDs and audio URLs filled in, and it builds the request for
each row and posts it to network 2160's Call Ingestion API. Supports
`--dry-run` (preview, sends nothing), `--test` (sends 3 real calls),
`--status` (reports what's been sent so far), and a full send. This is the
core of the whole package.

**`prepare_date_range.py`**
Run this first whenever the task is a date range ("send calls for July
2025") instead of a ready file. It builds a new CSV by taking rows from
`template_calls.csv`, giving each one a brand-new, never-used-before call
ID, and reassigning its date to fall inside the requested range, reusing
the existing audio recordings rather than creating new ones. Important
because an ID can only ever be used once on this network, forever —
shifting dates onto an old ID is what breaks re-ingestion.

## The reference data

**`template_calls.csv`**
The bank of real call content this network draws from: cities, marketing
data, specialties, patient-type flags, and already-hosted audio URLs on
GitHub. `prepare_date_range.py` pulls rows from here. This is the only
source of call content the subagent has.

**`custom_data_dictionary.csv`**
Network 2160's official list of valid custom-data field names
(`partner_name`s). `ingest.py` already has the mapping it needs baked in,
so this file is just a reference — useful if the agent is ever asked to
send a field that isn't already mapped, so it can look up the correct
exact name instead of guessing.

**`network_config.env`**
This network's credentials: API token, network ID, campaign ID, and API
endpoint. Both scripts read from this file. Sensitive — should never be
shown, logged, printed, or copied to another network's subagent folder.
Without this file, nothing here can send anything.

## The state folder

**`state/ingest_state.json`**
The permanent record of every call ID ever sent to network 2160 and what
happened to it. Seeded with the 499 calls already sent earlier in this
project (all accepted). This is what lets `ingest.py` avoid ever sending
the same ID twice and lets `--status` give an accurate report. Never edit
this by hand, delete it, or replace it.

**`state/reserved_ids.json`**
Every ID `prepare_date_range.py` has ever minted, whether or not it's been
sent yet. Checked together with `ingest_state.json` so a new batch never
reuses an ID sitting in an already-built-but-not-yet-sent CSV. Same rule —
don't edit or delete this by hand.

## Not part of the package

**`.venv/`** (if present) — a local Python environment created the first
time a script needed the `requests` library installed. Just plumbing;
safe to delete or leave, and safe to not copy when moving this folder.

**`.DS_Store`** (if present) — a hidden macOS Finder file with no
connection to this project. Safe to ignore or delete.
