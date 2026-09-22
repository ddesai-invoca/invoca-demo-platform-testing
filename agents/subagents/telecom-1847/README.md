# Telecom Network 1847 Subagent — What's In This Folder

This folder is a self-contained package for one job: getting iTelecom
demo call data into Invoca network 1847. Everything the subagent needs to
do that lives inside this folder — no dependency on your Mac, the rest of
the `Bulk Demo Calls` project, or any other network's files.

## The instructions

**`AGENT_PROMPT.md`**
The subagent's actual instructions — its role, what it's allowed to do,
the step-by-step order it should run things in, when to retry a failure
vs. stop and ask, and the hard rules it must never break (like never
reusing a call ID). This is what you hand the new agent so it knows how to
behave. Important because without it, the agent has scripts but no
judgment about how or when to use them safely.

## The scripts

**`ingest.py`**
The script that actually sends call data to Invoca. Give it a CSV that
already has IDs and audio URLs filled in, and it builds the request for
each row and posts it to Invoca's Call Ingestion API. Supports `--dry-run`
(preview, sends nothing), `--test` (sends 3 real calls), `--status`
(reports what's been sent so far), and a full send. This is the core of
the whole package — everything else exists to feed it a correct CSV.

**`prepare_date_range.py`**
Run this first whenever the task is a date range ("send calls for July
2025") instead of a ready file. It builds a new CSV by taking rows from
`template_calls.csv`, giving each one a brand-new, never-used-before call
ID, and reassigning its date to fall inside the requested range. It
reuses the existing audio recordings rather than creating new ones.
Important because dates can't just be shifted onto old IDs — an ID can
only ever be used once on this network, forever. This script exists
specifically to avoid repeating that mistake.

## The reference data

**`template_calls.csv`**
The bank of real call content this network draws from: cities, marketing
data (UTM tags, click IDs, etc.), call outcomes, and already-hosted audio
URLs on GitHub. `prepare_date_range.py` pulls rows from here — this file
is the raw material for every new date-range batch. Important because
it's the only source of call content the subagent has; without it,
`prepare_date_range.py` has nothing to build a new CSV from.

**`custom_data_dictionary.csv`**
Network 1847's official list of valid custom-data field names
(`partner_name`s). `ingest.py` already has the mapping it needs baked in,
so this file is just a reference — useful if the agent is ever asked to
send a field that isn't already mapped, so it can look up the correct
exact name instead of guessing. Important for avoiding silently-dropped
or rejected fields if the task ever expands.

**`network_config.env`**
This network's credentials: API token, network ID, campaign ID, and API
endpoint. `ingest.py` and `prepare_date_range.py` both read from this file.
Important — and sensitive. This should never be shown, logged, printed, or
copied to any other network's subagent folder. If this file goes missing,
nothing in this folder can send anything.

## The state folder

**`state/ingest_state.json`**
The permanent record of every call ID ever sent to network 1847 and what
happened to it (accepted, failed, with what error). This is what lets
`ingest.py` avoid ever sending the same ID twice and lets `--status` give
an accurate report. Critically important — this file should never be
edited by hand, deleted, or replaced. Losing it wouldn't just lose
history; it could lead to accidental duplicate-send attempts.

**`state/reserved_ids.json`**
Every ID `prepare_date_range.py` has ever minted, whether or not it's been
sent yet. Checked together with `ingest_state.json` so that generating a
new batch never accidentally reuses an ID that's sitting in an
already-built CSV but hasn't been sent yet. Same rule as above — don't
edit or delete this by hand.

## Generated batch files

**`www.itelecomservices.com_calls_<start>_to_<end>_WITH_URLS_ALL.csv`**
(there are currently three of these, for May, June, and July 2025)

These are outputs of `prepare_date_range.py` — ready-to-send batches for
specific date ranges, each with fresh IDs and reused audio. They aren't
required for the subagent to function; they're just the work product of
past runs. As of the last check: the May batch was fully sent (499/499
accepted), the June batch was partially sent (360/499), and the July
batch was generated but not yet sent at all. You can leave these here as
a record, hand a specific one to the agent to finish sending, or delete
ones you no longer need — `ingest.py` always checks `state/ingest_state.json`
first, so deleting a batch file never loses the record of what was
already sent from it.

## Not part of the package

**`.venv/`** — a local Python environment created the first time a script
needed the `requests` library installed. It's just plumbing; nothing
reads or depends on its exact contents, and it's fine to leave it, delete
it (a script will recreate it if needed), or not copy it when moving this
folder elsewhere.

**`.DS_Store`** — a hidden macOS Finder file with no connection to this
project. Safe to ignore or delete; it'll just reappear next time Finder
looks at this folder.
