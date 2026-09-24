#!/usr/bin/env python3
"""
Build a ready-to-ingest CSV for network 1847 for ANY requested date range,
using this network's content template but with fresh IDs and reassigned
dates. Run this BEFORE ingest.py whenever the parent agent hands you a date
range instead of a CSV path.

Why this exists
----------------
Dates cannot be shifted onto a new range while keeping the old IDs.
external_call_unique_id must be unique across this network forever, so a
file that reuses IDs -- even with different dates -- is correctly treated
by ingest.py as 100% duplicate and refused outright. (This is exactly what
happened to an earlier Aug-2026 file: its dates were shifted from the Nov
2025 batch but its IDs weren't, so it collided with everything already
sent and could not be ingested.)

What it does
------------
  - Reads template_calls.csv (this network's bank of real call content:
    cities, marketing data, outcomes, and already-hosted GitHub audio URLs)
  - For each row: mints a brand-new 7-character ID, unique against every ID
    ever sent to this network (state/ingest_state.json) and every ID this
    script has minted before (state/reserved_ids.json) -- and reassigns
    "Call Start Time" / "Start Time Min" / "Start Time Max" to a date
    inside the requested range (time-of-day is preserved, dates are spread
    evenly across the range in template row order)
  - Leaves everything else -- Audio URL included -- untouched. The
    recording content doesn't depend on which date it's tagged with, so
    existing audio is reused as-is under the new ID.
  - Writes the result to --out (or an auto-generated filename) and records
    every minted ID in state/reserved_ids.json so a second prep run (even
    for a different range) never mints the same ID twice.

Usage
-----
    python3 prepare_date_range.py --start 7/1/2025 --end 7/30/2025
    python3 prepare_date_range.py --start 7/1/2025 --end 7/30/2025 --count 150
    python3 prepare_date_range.py --start 7/1/2025 --end 7/30/2025 --out custom_name.csv

Then hand the printed output path to ingest.py as normal:
    python3 ingest.py --csv "<path printed above>" --dry-run
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).parent
TEMPLATE = HERE / "template_calls.csv"
STATE = HERE / "state" / "ingest_state.json"
RESERVED = HERE / "state" / "reserved_ids.json"

ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O/1/I/L, read-aloud safe
ID_LEN = 7
DATE_COLS = ["Start Time Min", "Start Time Max", "Call Start Time"]
FMT = "%-m/%-d/%y %H:%M"
FMT_PARSE = "%m/%d/%y %H:%M"


def load_used_ids() -> set[str]:
    used = set()
    if STATE.exists():
        used |= set(json.loads(STATE.read_text()).keys())
    if RESERVED.exists():
        used |= set(json.loads(RESERVED.read_text()))
    return used


def save_reserved(ids: set[str]) -> None:
    RESERVED.parent.mkdir(parents=True, exist_ok=True)
    existing = set(json.loads(RESERVED.read_text())) if RESERVED.exists() else set()
    RESERVED.write_text(json.dumps(sorted(existing | ids), indent=1))


def mint_ids(n: int, used: set[str], seed: int) -> list[str]:
    rnd = random.Random(seed)
    minted: list[str] = []
    seen = set(used)
    while len(minted) < n:
        cid = "".join(rnd.choice(ID_ALPHABET) for _ in range(ID_LEN))
        if cid not in seen:
            seen.add(cid)
            minted.append(cid)
    return minted


def daterange_days(start: datetime, end: datetime) -> list[datetime]:
    days = []
    d = start
    while d.date() <= end.date():
        days.append(d)
        d += timedelta(days=1)
    return days


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", required=True, help="e.g. 7/1/2025")
    ap.add_argument("--end", required=True, help="e.g. 7/30/2025, inclusive")
    ap.add_argument("--count", type=int, help="rows to generate (default: all rows in the template)")
    ap.add_argument("--out", help="output CSV path (default: auto-named from the date range)")
    ap.add_argument("--seed", type=int, default=None, help="override the RNG seed (default: derived from --start/--end)")
    args = ap.parse_args()

    if not TEMPLATE.exists():
        sys.exit(f"missing {TEMPLATE}. This subagent needs its content template to prepare new date ranges.")

    try:
        start = datetime.strptime(args.start, "%m/%d/%Y")
        end = datetime.strptime(args.end, "%m/%d/%Y")
    except ValueError:
        sys.exit("--start/--end must be M/D/YYYY, e.g. 7/1/2025")
    if end < start:
        sys.exit("--end is before --start")

    with open(TEMPLATE, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        fields = list(reader.fieldnames or [])
        rows = list(reader)
    for c in DATE_COLS + ["ID name", "Audio URL"]:
        if c not in fields:
            sys.exit(f"template_calls.csv is missing expected column {c!r}")

    n = args.count or len(rows)
    if n > len(rows):
        sys.exit(f"--count {n} exceeds the template's {len(rows)} available rows")
    picks = rows[:n]

    days = daterange_days(start, end)
    seed = args.seed if args.seed is not None else int(start.strftime("%Y%m%d")) + int(end.strftime("%Y%m%d"))

    used = load_used_ids()
    new_ids = mint_ids(n, used, seed)

    out_rows = []
    for i, row in enumerate(picks):
        new_row = dict(row)
        new_row["ID name"] = new_ids[i]
        target_day = days[i % len(days)]
        for c in DATE_COLS:
            raw = (row[c] or "").strip()
            if not raw or raw == "__":
                continue
            orig = datetime.strptime(raw, FMT_PARSE)
            new_dt = target_day.replace(hour=orig.hour, minute=orig.minute)
            new_row[c] = new_dt.strftime(FMT)
        # Audio URL intentionally untouched -- same hosted recording, new ID.
        out_rows.append(new_row)

    out_path = Path(args.out) if args.out else HERE / (
        f"www.itelecomservices.com_calls_{start:%Y-%m-%d}_to_{end:%Y-%m-%d}_WITH_URLS_ALL.csv"
    )
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(out_rows)

    save_reserved(set(new_ids))

    print(f"wrote {out_path}")
    print(f"  rows           : {len(out_rows)}")
    print(f"  date range     : {start:%Y-%m-%d} .. {end:%Y-%m-%d}  ({len(days)} distinct days)")
    print(f"  new unique IDs : {len(new_ids)} (none reused, none previously sent)")
    print(f"  audio          : reused as-is from template_calls.csv (no regeneration needed)")
    print(f"\nnext: python3 ingest.py --csv \"{out_path}\" --dry-run")
    return 0


if __name__ == "__main__":
    sys.exit(main())
