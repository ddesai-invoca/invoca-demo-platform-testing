# Home Services Network (Shady Blinds) Subagent — What's In This Folder

This folder is a self-contained package for one job: getting Shady Blinds
(fictional home-services/window-treatment demo company,
www.shadyblinds.com) demo call data into Invoca network 2751. Everything
the subagent needs to do that lives inside this folder — no dependency on
your Mac, the rest of the `Bulk Demo Calls` project, or the
Telecom/Healthcare/Law/Finance/Insurance subagents' files. It's the same
design as `subagents/finance-network-1752/` and the other networks,
adapted to this network's data.

## The instructions

**`AGENT_PROMPT.md`**
The subagent's actual instructions — its role, what it's allowed to do,
the step-by-step order it should run things in, when to retry a failure
vs. stop and ask, and the hard rules it must never break (like never
reusing a call ID). It also documents the things specific to this
network: no revenue/Amount field or Region field in this network's real
dictionary (so neither is sent, even though the CSV has modeled revenue
data), a fixed single destination phone number for every row, and the
real, verified partner_names for every field that is sent.

## The scripts

**`ingest.py`**
The script that actually sends call data to Invoca. Give it a CSV that
already has IDs and audio URLs filled in, and it builds the request for
each row and posts it to network 2751's Call Ingestion API. Supports
`--dry-run` (preview, sends nothing), `--test` (sends 3 real calls),
`--status` (reports what's been sent so far), and a full send.

**`prepare_date_range.py`**
Run this first whenever the task is a date range ("send calls for October
2026") instead of a ready file. It builds a new CSV by taking rows from
`template_calls.csv`, giving each one a brand-new, never-used-before call
ID, and reassigning its date to fall inside the requested range, reusing
the existing audio recordings rather than creating new ones. Important
because an ID can only ever be used once on this network, forever —
shifting dates onto an old ID is what breaks re-ingestion.

## The reference data

**`template_calls.csv`**
The bank of real call content this network draws from: 499 rows (394
answered + 105 unanswered/ringback) covering 40 cities, marketing data,
purchase/appointment/warranty/cancel outcome flags, agent assignments
matched to the written transcripts, revenue, and already-hosted audio URLs
on GitHub (`Demo-call-audio-files/Home Services Calls/`).
`prepare_date_range.py` pulls rows from here. This is the only source of
call content the subagent has.

**`custom_data_dictionary.csv`**
Network 2751's official, real Custom Data Dictionary export (obtained
2026-10-07). `ingest.py` already has the mapping it needs baked in, so
this file is just a reference — useful if the agent is ever asked to send
a field that isn't already mapped, so it can look up the correct exact
name instead of guessing.

**`network_config.env`**
This network's real credentials: API token, network ID (2751), campaign
ID, and API endpoint. Both scripts read from this file. Sensitive —
should never be shown, logged, printed, or copied to another network's
subagent folder. Without this file, nothing here can send anything.

## The state folder

**`state/ingest_state.json`**
The permanent record of every call ID ever sent to this network and what
happened to it. Starts empty — this network has never had a real
ingestion run before. This is what lets `ingest.py` avoid ever sending the
same ID twice and lets `--status` give an accurate report. Never edit
this by hand, delete it, or replace it.

**`state/reserved_ids.json`**
Every ID `prepare_date_range.py` has ever minted, whether or not it's been
sent yet. Checked together with `ingest_state.json` so a new batch never
reuses an ID sitting in an already-built-but-not-yet-sent CSV. Same rule —
don't edit or delete this by hand.

## Not part of the package

**`.venv/`** — a local Python environment with `requests` already
installed. Just plumbing; safe to delete or leave, and safe to not copy
when moving this folder.

**`.DS_Store`** (if present) — a hidden macOS Finder file with no
connection to this project. Safe to ignore or delete.
