#!/usr/bin/env python3
"""
Post the Amount column to already-ingested calls via Invoca's Signal API,
network 2751.

Why this is a separate step from ingest.py: the Call Ingestion API's
custom_data only accepts plain strings -- there is no revenue type, so a
dollar amount sent that way is inert text, never real revenue Invoca can
report on. The Signal API has an actual `revenue` field per signal, and it
finds the call by `external_call_unique_id` -- the same "ID name" value
ingest.py already sent -- so revenue can be attached after the fact with
no change to ingestion itself.

The signal name used here ("Revenue") does NOT need to already exist in
this network's Signal AI configuration. Unlike the Call Ingestion API,
the Signal API accepts any name and preserves the casing of the first
time it's reported (per Invoca's own Signal API docs). It is deliberately
generic and identical across every revenue-bearing network's copy of this
script -- there is nothing here that needs to match an audio-detected
signal, so there is no per-network signal-name mapping to maintain.

It is idempotent: signals are keyed on name + partner_unique_id, so
re-posting the same call updates rather than duplicates. Safe to re-run.

Only calls that ingest.py already sent AND Invoca already accepted (per
state/ingest_state.json) are eligible -- a call that was never ingested,
or that failed ingestion, has nothing to attach revenue to.

A call is only eligible once at least MIN_AGE_MINUTES (60 by default,
override with --min-age-minutes) has passed since ingest.py's own
timestamp for it -- that is the time Invoca needs to finish processing an
ingested call before it can be found by external_call_unique_id. A call
that hasn't cleared that age yet is simply held back for the next run,
not dropped; running this script again and again (e.g. once an hour) is
the intended way to use it, since each run only ever sends what is both
new and old enough. If a call that should have cleared the age check
still 404s, that's unusual -- retry it explicitly with --retry-failed
rather than assuming it will fix itself.

IMPORTANT, and the reason --csv isn't the only source of rows: under any
recurring cadence, the CSV you're handed each run is the one JUST sent to
ingest.py -- so its rows are always too new to be eligible THIS run. If
this script only ever looked at that one file, revenue would never
actually go out: the file that's finally old enough is always a PAST
run's file, which a single-file design would never look at again. So
every --csv you're ever given is remembered in
state/known_csvs.json, and every run re-checks ALL of them -- not just
today's -- for rows that have now cleared the age gate. A CSV is dropped
from that list automatically once every revenue-bearing row in it has
been signaled (nothing left in it that could ever still need checking),
so the list stays small rather than growing forever.

Usage
-----
    cd telecom-1847
    python3 apply_revenue_signal.py --csv "/path/to/same_file_sent_to_ingest.py.csv" --dry-run
    python3 apply_revenue_signal.py --csv "..." --test
    python3 apply_revenue_signal.py --csv "..." --status
    python3 apply_revenue_signal.py --csv "..."
    python3 apply_revenue_signal.py --csv "..." --retry-failed

The token is read from network_config.env in this same folder -- the same
file ingest.py reads -- and is never printed or written to any log.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).parent
INGEST_STATE = HERE / "state" / "ingest_state.json"
STATE = HERE / "state" / "revenue_signal_state.json"
KNOWN_CSVS = HERE / "state" / "known_csvs.json"
CONFIG = HERE / "network_config.env"

# Network-specific: this network's template calls this column "Revenue".
# Telecom's own copy of this script reads "Amount" instead -- that is the
# one line that differs between networks.
REVENUE_COLUMN = "Revenue"

# Network-specific: the outcome column that actually means "this call
# converted". A Revenue value is only ever meant to exist on a row where
# this also reads "1" (verified against template_calls.csv: zero rows
# disagree) -- but that is a property of the DATA, not something this
# script enforced on its own until now. A row where one is set without
# the other is corrupt, and the hard rule below ("never invent or adjust
# a revenue value") cuts both ways: a stray amount on a non-conversion is
# just as much an invented value as fixing a malformed one would be, so
# it is refused rather than silently sent.
CONVERSION_COLUMN = "Purchase"

# This network's own set of codes that mean ingest.py's send succeeded.
# Taken from ingest.py's own OK_CODES in this same folder -- keep the two
# in sync if ingest.py's ever changes.
INGEST_OK_CODES = {201, 202}

SIGNAL_ENDPOINT = "https://www.invoca.net/api/2018-02-01/transactions.json"
SIGNAL_NAME = "Revenue"
PARTNER_UNIQUE_ID = "home-services-2751-revenue"

TIMEOUT = 120
PAUSE = 0.35
OK_CODES = {200, 201}

# How long to wait after ingest.py's own timestamp before a call is eligible
# for a revenue signal, so Invoca has had time to fully process the ingested
# call before we search for it by external_call_unique_id. Overridable with
# --min-age-minutes (e.g. 0, to verify against a call you know has landed
# without waiting a real hour).
MIN_AGE_MINUTES = 60

EXCEL_ERRORS = {"#NAME?", "#REF!", "#VALUE!", "#N/A", "#DIV/0!", "#NULL!"}
MONEY_RE = re.compile(r"^-?\d+(\.\d{1,2})?$")


def clean(v: str) -> str:
    v = (v or "").strip()
    if v in ("", "__") or v in EXCEL_ERRORS:
        return ""
    return v


def revenue_of(row: dict) -> str:
    """The row's revenue value, formatted exactly as the Signal API wants
    it: no currency symbol, no thousands separator, up to 2 decimal
    places. Returns "" if there's nothing to send or the value doesn't
    look like a clean number -- this script never guesses at a malformed
    value, it reports it instead."""
    raw = clean(row.get(REVENUE_COLUMN, ""))
    if not raw:
        return ""
    stripped = raw.replace("$", "").replace(",", "").strip()
    if not MONEY_RE.match(stripped):
        return ""
    return stripped


def converted(row: dict) -> bool:
    """True iff this network's own conversion flag says this call is a
    real conversion. The Revenue column is only ever supposed to carry a
    value when this is true -- see CONVERSION_COLUMN above."""
    return clean(row.get(CONVERSION_COLUMN, "")) == "1"


def revenue_if_converted(row: dict) -> str:
    """The row's revenue, but ONLY when the conversion flag agrees -- a
    Revenue value by itself is not proof of a sale. A row where the two
    disagree (a dollar amount with no conversion flag, or a conversion
    flag with no amount) is corrupt data, and this treats it exactly like
    a malformed amount: nothing is sent, never guessed at."""
    revenue = revenue_of(row)
    if not revenue or not converted(row):
        return ""
    return revenue


def load_config() -> dict[str, str]:
    if not CONFIG.exists():
        sys.exit(f"missing {CONFIG}. This subagent cannot run without its network_config.env.")
    cfg = {}
    for line in CONFIG.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip()
    if not cfg.get("INVOCA_API_TOKEN"):
        sys.exit("network_config.env is missing: INVOCA_API_TOKEN")
    return cfg


def load_json(p: Path) -> dict:
    return json.loads(p.read_text()) if p.exists() else {}


def save_state(state: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1, sort_keys=True))


def load_known_csvs() -> list[str]:
    if not KNOWN_CSVS.exists():
        return []
    try:
        return json.loads(KNOWN_CSVS.read_text())
    except (json.JSONDecodeError, OSError):
        return []


def save_known_csvs(paths: list[str]) -> None:
    KNOWN_CSVS.parent.mkdir(parents=True, exist_ok=True)
    KNOWN_CSVS.write_text(json.dumps(sorted(set(paths)), indent=1))


def load_rows(path: Path) -> list[dict]:
    """Read one CSV's rows, tagging each with where it came from (used only
    for the state ledger's source_csv field, never a real CSV column so it
    can't collide with one). A file that's gone missing or unreadable is
    reported and skipped rather than crashing the whole sweep over one bad
    path -- the caller is still told about it via the returned empty list."""
    try:
        rows = list(csv.DictReader(open(path, newline="", encoding="utf-8-sig")))
    except OSError as exc:
        print(f"  warning: could not read {path} ({exc}) -- skipping it this run")
        return []
    for r in rows:
        r["__source__"] = path.name
    return rows


def fully_resolved(path: Path, state: dict) -> bool:
    """True once every revenue-bearing row in this CSV has already been
    successfully signaled -- i.e. nothing in it could ever still need a
    future run to check. A missing file is treated as resolved too: there
    is nothing left to do about a CSV that no longer exists on disk."""
    if not path.exists():
        return True
    for row in load_rows(path):
        cid = row.get("ID name", "").strip()
        if not cid or not revenue_if_converted(row):
            continue
        entry = state.get(cid)
        if not entry or entry.get("code") not in OK_CODES:
            return False
    return True


def resolve_tracked_csvs(csv_path: Path, state: dict) -> list[Path]:
    """Add csv_path to the remembered set and drop anything now fully
    resolved or no longer on disk, returning the paths this run should
    sweep. Pure -- does not write state/known_csvs.json itself, so a
    --dry-run computing this stays genuinely side-effect-free; the caller
    persists the result on a real run."""
    known = {str(Path(p).resolve()) for p in load_known_csvs()}
    known.add(str(csv_path.resolve()))
    kept = [p for p in known if not fully_resolved(Path(p), state)]
    return [Path(p) for p in kept]


def build_body(row: dict, revenue: str) -> dict:
    return {
        "search": {"external_call_unique_id": row["ID name"].strip()},
        "partner_unique_id": PARTNER_UNIQUE_ID,
        "signals": [{"name": SIGNAL_NAME, "revenue": revenue}],
    }


def eligible_rows(rows: list[dict], ingest_state: dict,
                   min_age_minutes: int = MIN_AGE_MINUTES) -> tuple[list[dict], Counter]:
    """Split the CSV into rows worth sending a revenue signal for right now,
    and a tally of why the rest were left out -- never silently drop a row
    without being able to say why. A row that is otherwise eligible but was
    only just ingested is held back (not dropped) until it clears
    min_age_minutes, so a run made too soon after ingestion simply leaves it
    for the next run rather than sending it early."""
    skipped: Counter = Counter()
    out = []
    now = datetime.now()
    min_age = timedelta(minutes=min_age_minutes)
    for row in rows:
        cid = row.get("ID name", "").strip()
        if not cid:
            skipped["no ID name"] += 1
            continue
        revenue = revenue_if_converted(row)
        if not revenue:
            if revenue_of(row) and not converted(row):
                skipped["revenue present but conversion flag not set -- not sending"] += 1
            elif converted(row) and not revenue_of(row):
                skipped["conversion flag set but no revenue on this row"] += 1
            else:
                skipped["no revenue on this row"] += 1
            continue
        ingest_entry = ingest_state.get(cid)
        if not ingest_entry:
            skipped["never ingested"] += 1
            continue
        if ingest_entry.get("code") not in INGEST_OK_CODES:
            skipped["ingestion was not accepted"] += 1
            continue
        try:
            ingested_at = datetime.strptime(ingest_entry["ts"], "%Y-%m-%dT%H:%M:%S")
        except (KeyError, ValueError):
            skipped["ingest timestamp unreadable"] += 1
            continue
        if now - ingested_at < min_age:
            skipped[f"too recent (< {min_age_minutes}m since ingestion)"] += 1
            continue
        out.append(row)
    return out, skipped


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", help="the same CSV already sent to ingest.py for this network")
    ap.add_argument("--dry-run", action="store_true", help="print a sample body, send nothing")
    ap.add_argument("--test", action="store_true", help="send 3 calls and stop")
    ap.add_argument("--status", action="store_true", help="summarise everything ever sent")
    ap.add_argument("--only", nargs="*", metavar="ID", help="send only these call IDs")
    ap.add_argument("--limit", type=int, help="send at most N calls")
    ap.add_argument("--retry-failed", action="store_true",
                    help="also retry calls whose signal post previously failed")
    ap.add_argument("--min-age-minutes", type=int, default=MIN_AGE_MINUTES,
                    help=f"skip calls ingested less than this long ago (default {MIN_AGE_MINUTES})")
    args = ap.parse_args()

    cfg = load_config()
    state = load_json(STATE)

    if args.status:
        done = [k for k, v in state.items() if v["code"] in OK_CODES]
        fail = {k: v for k, v in state.items() if v["code"] not in OK_CODES}
        print(f"network                : {cfg.get('INVOCA_NETWORK_ID', '?')}")
        print(f"signal name            : {SIGNAL_NAME}")
        print(f"total ever attempted   : {len(state)}")
        print(f"accepted by Invoca     : {len(done)}")
        print(f"failed                 : {len(fail)}")
        if fail:
            print(f"\nfailures by status code: {dict(Counter(v['code'] for v in fail.values()))}")
            for cid, v in list(fail.items())[:15]:
                print(f"  {cid}  {v['code']}  {str(v.get('error'))[:90]}")
        return 0

    if not args.csv:
        sys.exit("--csv is required (unless using --status)")
    csv_path = Path(args.csv)
    if not csv_path.exists():
        sys.exit(f"missing {csv_path}")
    own_rows = load_rows(csv_path)
    if not own_rows:
        sys.exit(f"{csv_path.name} has no data rows.")

    # Sweep every CSV this network has ever been pointed at, not just this
    # run's -- see the module docstring for why a single-file design would
    # mean revenue never actually goes out under a recurring cadence.
    tracked = resolve_tracked_csvs(csv_path, state)
    if not args.dry_run:
        save_known_csvs([str(p) for p in tracked])
    rows_by_id: dict[str, dict] = {}
    for p in tracked:
        for row in load_rows(p):
            cid = row.get("ID name", "").strip()
            if cid and cid not in rows_by_id:
                rows_by_id[cid] = row
    rows = list(rows_by_id.values())

    ingest_state = load_json(INGEST_STATE)
    eligible, skipped = eligible_rows(rows, ingest_state, args.min_age_minutes)

    todo = eligible
    if args.only:
        want = set(args.only)
        todo = [r for r in eligible if r["ID name"].strip() in want]
    elif args.test:
        already = {k for k, v in state.items() if v["code"] in OK_CODES}
        todo = [r for r in eligible if r["ID name"].strip() not in already][:3]
    else:
        todo = [r for r in eligible
                if r["ID name"].strip() not in state
                or (args.retry_failed and state[r["ID name"].strip()]["code"] not in OK_CODES)]
    if args.limit:
        todo = todo[: args.limit]

    if args.dry_run:
        sample = eligible[0] if eligible else (rows[0] if rows else None)
        print(f"endpoint      : {SIGNAL_ENDPOINT}")
        print(f"partner id    : {PARTNER_UNIQUE_ID}")
        print(f"min age       : {args.min_age_minutes} minute(s) since ingestion")
        print(f"this run's csv: {csv_path.name}")
        print(f"tracking      : {len(tracked)} known CSV(s), {len(rows)} total row(s) across them")
        print(f"auth          : raw token in the Authorization header (from network_config.env, not shown)")
        print(f"eligible      : {len(eligible)}")
        print(f"would send    : {len(todo)}")
        print(f"already ok    : {sum(1 for v in state.values() if v['code'] in OK_CODES)}")
        if skipped:
            print(f"skipped       : {dict(skipped)}")
        if sample is not None:
            revenue = revenue_if_converted(sample) or "0.00"
            print(f"\nsample request body:\n{json.dumps(build_body(sample, revenue), indent=2)}")
        return 0

    if not todo:
        print("nothing to send.")
        if skipped:
            print(f"skipped: {dict(skipped)}")
        print("Run --status to see what's already been signaled.")
        return 0

    try:
        import requests
    except ImportError:
        sys.exit("requests not installed. Run: pip install requests")

    headers = {"Content-type": "application/json", "Authorization": cfg["INVOCA_API_TOKEN"]}

    print(f"endpoint   : {SIGNAL_ENDPOINT}")
    print(f"this run's csv: {csv_path.name}")
    print(f"tracking   : {len(tracked)} known CSV(s)")
    print(f"eligible   : {len(eligible)} (skipped: {dict(skipped)})" if skipped else f"eligible   : {len(eligible)}")
    print(f"sending    : {len(todo)} call(s)\n")

    counts: Counter = Counter()
    for n, row in enumerate(todo, 1):
        cid = row["ID name"].strip()
        revenue = revenue_if_converted(row)
        body = build_body(row, revenue)
        try:
            resp = requests.post(SIGNAL_ENDPOINT, headers=headers, json=body, timeout=TIMEOUT)
            code = resp.status_code
            try:
                payload = resp.json()
            except ValueError:
                payload = {"raw": resp.text[:300]}
        except Exception as exc:  # noqa: BLE001
            code, payload = 0, {"exception": f"{type(exc).__name__}: {exc}"}

        entry = {"code": code, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "revenue": revenue,
                  "source_csv": row.get("__source__", csv_path.name)}
        if code in OK_CODES:
            counts["ok"] += 1
            mark, detail = "ok  ", f"revenue {revenue}"
        else:
            entry["error"] = payload
            counts[f"fail {code}"] += 1
            mark, detail = "FAIL", json.dumps(payload)[:140]
        state[cid] = entry
        print(f"  [{n}/{len(todo)}] {mark} {cid}  {code}  {detail}")
        save_state(state)
        time.sleep(PAUSE)

    print(f"\n{dict(counts)}")
    print(f"state saved to state/{STATE.name}")

    if counts["ok"] and args.test:
        print("\nTest signals accepted. Verify them in Invoca, then send the rest with:")
        print(f"  python3 apply_revenue_signal.py --csv \"{csv_path}\"")
    if any(k.startswith("fail") for k in counts):
        print("\nSome signals failed. A 404 usually means the call hasn't landed in "
              "Invoca yet -- wait and retry. Nothing else is auto-retried.")
        print(f"  python3 apply_revenue_signal.py --csv \"{csv_path}\" --retry-failed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
