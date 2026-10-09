# Insurance Network (Best Coverage Policy) Subagent — What's In This Folder

This folder is a self-contained package for one job: getting Best Coverage
Policy (fictional insurance demo company, www.bestcoveragepolicy.com) demo
call data into Invoca network 3102. Everything the subagent needs to do
that lives inside this folder — no dependency on your Mac, the rest of the
`Bulk Demo Calls` project, or the Telecom/Healthcare/Law/Finance/Home-
Services subagents' files. It's the same design as
`subagents/finance-network-1752/` and the other networks, adapted to this
network's data.

## *** The custom_data mapping is still unverified ***

Unlike the dictionary, the credentials are real — `network_config.env`
has a working token, network ID (3102), campaign ID, and endpoint, so
`ingest.py` will run. But no real Custom Data Dictionary export for THIS
network has been obtained yet:

- `custom_data_dictionary.csv` is a conservative guess, not a real export
  — see its own header comment. The `CUSTOM_DATA` mapping baked into
  `ingest.py` must be re-verified against a genuine export before trusting
  a full send, since any individual field name could be silently rejected.

The basic call fields (start time, phone numbers, recording URL) don't
depend on this dictionary and will work regardless. Always run
`--dry-run` then `--test` before a full send — see AGENT_PROMPT.md.

## The instructions

**`AGENT_PROMPT.md`**
The subagent's actual instructions — its role, what it's allowed to do,
the step-by-step order it should run things in, when to retry a failure
vs. stop and ask, and the hard rules it must never break (like never
reusing a call ID, and never trusting the custom_data mapping as final
until it's verified).

## The scripts

**`ingest.py`**
The script that actually sends call data to Invoca. Give it a CSV that
already has IDs and audio URLs filled in, and it builds the request for
each row and posts it to network 3102's Call Ingestion API. Supports
`--dry-run` (preview, sends nothing), `--test` (sends 3 real calls),
`--status` (reports what's been sent so far), and a full send.

**`prepare_date_range.py`**
Run this first whenever the task is a date range ("send calls for
September 2026") instead of a ready file. It builds a new CSV by taking
rows from `template_calls.csv`, giving each one a brand-new, never-used-
before call ID, and reassigning its date to fall inside the requested
range, reusing the existing audio recordings rather than creating new
ones. Important because an ID can only ever be used once on this network,
forever — shifting dates onto an old ID is what breaks re-ingestion.

## The reference data

**`template_calls.csv`**
The bank of real call content this network draws from: 499 rows (397
answered + 102 unanswered/ringback) covering 25 cities, marketing data,
policy-inquiry/enrollment outcome flags, and already-hosted audio URLs on
GitHub (`Demo-call-audio-files/Insurance Calls/`). `prepare_date_range.py`
pulls rows from here. This is the only source of call content the
subagent has.

**`custom_data_dictionary.csv`**
**Not a real export** — see the file's own header comment. A conservative
guess at this network's valid custom-data field names (`partner_name`s),
built from fields shared by at least 3 of this project's other networks.
`ingest.py` already has a matching mapping baked in, but both should be
replaced/re-verified against a genuine Custom Data Dictionary export for
network 3102 specifically.

**`network_config.env`**
This network's real credentials: API token, network ID (3102), campaign
ID, and API endpoint. Both scripts read from this file. Sensitive —
should never be shown, logged, printed, or copied to another network's
subagent folder.

## The state folder

**`state/ingest_state.json`**
The permanent record of every call ID ever sent to this network and what
happened to it. Starts empty — this network has never had a real
ingestion run. This is what lets `ingest.py` avoid ever sending the same
ID twice and lets `--status` give an accurate report. Never edit this by
hand, delete it, or replace it.

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
