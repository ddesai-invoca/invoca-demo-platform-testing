#!/usr/bin/env python3
"""
Build (or restamp) a whole trend-shaped upload batch for network 3062 —
Phase 2 of Demo Call Ingest-O-Matic. Invoked directly by the TypeScript
orchestrator (engine/ingestOrchestrator.ts), never by the agent itself: the
trend math and the ID/date work it depends on are deterministic, so they
stay out of agent judgment the same way prepare_date_range.py's ID minting
already does.

Two modes
---------
Generate (default): builds every upload file for one settings-save's worth
of a cadence x trend x trend-period combination in a single run, e.g. 90
daily files for a 3-month hockey stick. Each file gets fresh, permanently-
reserved IDs (same mechanism as prepare_date_range.py) and a row mix that
hits that upload's target answered/converted rate for the chosen trend.
Template dates are left untouched here on purpose -- see Restamp.

Restamp (--restamp): a much smaller job. One already-built file's dates get
reassigned to fall inside a window ending "today", right before that file
is actually sent. Dates are deliberately NOT baked in at generation time --
a multi-day outage's catch-up sends should carry dates for when they
actually went out, not for whenever the batch happened to be built.

What decides "answered" and "conversion" for this network
-----------------------------------------------------------
Read from trend_config.json in this same folder, not hardcoded here --
these columns and their polarity differ per network (one network's
"Answered by Agent" can mean the opposite of another's), so a shared
hardcoded rule would eventually repeat a real bug this project already had
once with a shared ringback script.

Usage
-----
    .venv/bin/python3 trend_batch.py --cadence daily --trend hockey-stick \\
        --period 3-months --calls-per-upload 500 --cycle-number 1 \\
        --out-dir /path/to/batch/dir

    .venv/bin/python3 trend_batch.py --restamp /path/to/upload-0041.csv \\
        --end 2026-10-09 --window-days 1

Prints one JSON line on success (generate mode only):
    {"totalUploads": 90, "files": ["/path/upload-0000.csv", ...]}
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
TREND_CONFIG = HERE / "trend_config.json"
STATE = HERE / "state" / "ingest_state.json"
RESERVED = HERE / "state" / "reserved_ids.json"

ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O/1/I/L, read-aloud safe
ID_LEN = 7
DATE_COLS = ["Start Time Min", "Start Time Max", "Call Start Time"]
FMT = "%Y-%m-%d %H:%M:%S"

PERIOD_DAYS = {"month": 30, "3-months": 90, "6-months": 180}
CADENCE_STEP_DAYS = {"daily": 1, "weekly": 7, "biweekly": 14, "monthly": 30}

# The trend shape's low/high bounds are derived from this network's OWN
# baseline rate in template_calls.csv, not a fixed global percentage -- a
# flat 10%/40% would be meaningless for a network whose real conversion
# rate is, say, 60%. Clamped so a very low or very high baseline still
# produces a visible ramp rather than collapsing to a flat line.
RAMP_LOW_MULT = 0.4
RAMP_HIGH_MULT = 2.2
RAMP_MIN = 0.02
RAMP_MAX = 0.9


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


def compute_total_uploads(cadence: str, period: str) -> int:
    return max(1, round(PERIOD_DAYS[period] / CADENCE_STEP_DAYS[cadence]))


def load_trend_config() -> dict:
    if not TREND_CONFIG.exists():
        sys.exit(f"missing {TREND_CONFIG}. This subagent needs its trend config to shape upload batches.")
    return json.loads(TREND_CONFIG.read_text())


def row_matches(row: dict, rule: dict) -> bool:
    return (row.get(rule["column"], "") or "").strip() == str(rule["value"])


def split_pools(rows: list[dict], cfg: dict) -> tuple[list[dict], list[dict], list[dict]]:
    """-> (not_answered, converted, non_converted). converted/non_converted
    are both subsets of the ANSWERED rows -- conversion only means anything
    among calls that were actually answered."""
    not_answered_rule = cfg["notAnswered"]
    conversion_rules = cfg["conversion"]
    not_answered, answered = [], []
    for row in rows:
        (not_answered if row_matches(row, not_answered_rule) else answered).append(row)
    converted, non_converted = [], []
    for row in answered:
        is_converted = any(row_matches(row, r) for r in conversion_rules)
        (converted if is_converted else non_converted).append(row)
    return not_answered, converted, non_converted


def ramp_bounds(baseline: float) -> tuple[float, float]:
    low = max(RAMP_MIN, baseline * RAMP_LOW_MULT)
    high = min(RAMP_MAX, max(low + 0.01, baseline * RAMP_HIGH_MULT))
    return low, high


def target_rate(trend: str, i: int, n: int, low: float, high: float) -> float:
    """Returns this upload's target rate for whichever axis `trend` shapes
    (conversion for gradual-increase/hockey-stick, not-answered for
    answered-recovery). Callers decide which axis; this is pure curve math."""
    if n <= 1:
        return (low + high) / 2  # no ramp possible over a single point
    frac = i / (n - 1)
    if trend == "gradual-increase":
        return low + (high - low) * frac
    if trend == "hockey-stick":
        if frac < 0.8:
            return low
        tail = (frac - 0.8) / 0.2
        return low + (high - low) * tail
    if trend == "answered-recovery":
        # Mirror of hockey-stick: starts HIGH, sharp drop in the final 20%.
        if frac < 0.8:
            return high
        tail = (frac - 0.8) / 0.2
        return high - (high - low) * tail
    return (low + high) / 2  # unused by "random", which ignores targets entirely


def sample_with_replacement(pool: list[dict], n: int, rnd: random.Random) -> list[dict]:
    if not pool or n <= 0:
        return []
    return [rnd.choice(pool) for _ in range(n)]


def mint_and_place(rows: list[dict], used: set[str], seed: int, fields: list[str]) -> tuple[list[dict], set[str]]:
    ids = mint_ids(len(rows), used, seed)
    out = []
    for row, cid in zip(rows, ids):
        new_row = dict(row)
        new_row["ID name"] = cid
        out.append({f: new_row.get(f, "") for f in fields})
    return out, used | set(ids)


def generate(args: argparse.Namespace) -> None:
    if not TEMPLATE.exists():
        sys.exit(f"missing {TEMPLATE}. This subagent needs its content template to build upload batches.")
    with open(TEMPLATE, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        fields = list(reader.fieldnames or [])
        rows = list(reader)
    for c in DATE_COLS + ["ID name", "Audio URL"]:
        if c not in fields:
            sys.exit(f"template_calls.csv is missing expected column {c!r}")

    cfg = load_trend_config()
    not_answered_pool, converted_pool, non_converted_pool = split_pools(rows, cfg)
    answered_count = len(converted_pool) + len(non_converted_pool)
    baseline_not_answered = len(not_answered_pool) / len(rows) if rows else 0.0
    baseline_conversion = (len(converted_pool) / answered_count) if answered_count else 0.0

    n_rate_low, n_rate_high = ramp_bounds(baseline_not_answered)
    c_rate_low, c_rate_high = ramp_bounds(baseline_conversion)

    total_uploads = compute_total_uploads(args.cadence, args.period)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    state_dir_override = Path(args.state_dir) if args.state_dir else None
    used = load_used_ids() if not state_dir_override else _load_used_ids_from(state_dir_override)

    seed_base = args.cycle_number * 10_000_019  # arbitrary large prime offset per cycle

    out_files: list[str] = []
    for i in range(total_uploads):
        rnd = random.Random(seed_base + i)
        if args.trend == "random":
            shuffled = list(rows)
            rnd.shuffle(shuffled)
            picks = sample_with_replacement(shuffled, args.calls_per_upload, rnd)
        else:
            if args.trend == "answered-recovery":
                target_na = target_rate(args.trend, i, total_uploads, n_rate_low, n_rate_high)
                target_conv = baseline_conversion
            else:  # gradual-increase, hockey-stick
                target_na = baseline_not_answered
                target_conv = target_rate(args.trend, i, total_uploads, c_rate_low, c_rate_high)

            n_not_answered = round(args.calls_per_upload * target_na)
            n_answered = args.calls_per_upload - n_not_answered
            n_converted = round(n_answered * target_conv)
            n_non_converted = n_answered - n_converted

            picks = (
                sample_with_replacement(not_answered_pool, n_not_answered, rnd)
                + sample_with_replacement(converted_pool, n_converted, rnd)
                + sample_with_replacement(non_converted_pool, n_non_converted, rnd)
            )
            rnd.shuffle(picks)

        placed, used = mint_and_place(picks, used, seed_base + i, fields)
        if not state_dir_override:
            save_reserved(set(r["ID name"] for r in placed))

        out_path = out_dir / f"upload-{i:04d}.csv"
        with open(out_path, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=fields)
            w.writeheader()
            w.writerows(placed)
        out_files.append(str(out_path))

    print(json.dumps({"totalUploads": total_uploads, "files": out_files}))


def _load_used_ids_from(state_dir: Path) -> set[str]:
    """Test-only override (--state-dir) so ID-collision behaviour can be
    exercised against a scratch ledger instead of a real network's. Does
    NOT write reserved_ids.json back anywhere -- a test run must not leave
    IDs permanently reserved against the real network."""
    used = set()
    state_file = state_dir / "ingest_state.json"
    reserved_file = state_dir / "reserved_ids.json"
    if state_file.exists():
        used |= set(json.loads(state_file.read_text()).keys())
    if reserved_file.exists():
        used |= set(json.loads(reserved_file.read_text()))
    return used


def daterange_days(start: datetime, end: datetime) -> list[datetime]:
    days = []
    d = start
    while d.date() <= end.date():
        days.append(d)
        d += timedelta(days=1)
    return days


def restamp(args: argparse.Namespace) -> None:
    path = Path(args.restamp)
    if not path.exists():
        sys.exit(f"missing {path}")
    end = datetime.strptime(args.end, "%Y-%m-%d")
    start = end - timedelta(days=args.window_days - 1)
    days = daterange_days(start, end)

    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        fields = list(reader.fieldnames or [])
        rows = list(reader)

    for i, row in enumerate(rows):
        target_day = days[i % len(days)]
        for c in DATE_COLS:
            raw = (row.get(c) or "").strip()
            if not raw or raw == "__":
                continue
            try:
                orig = datetime.strptime(raw, FMT)
            except ValueError:
                continue  # already restamped or otherwise non-standard; leave it
            new_dt = target_day.replace(hour=orig.hour, minute=orig.minute, second=orig.second)
            row[c] = new_dt.strftime(FMT)

    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)

    print(json.dumps({"restamped": str(path), "start": start.strftime("%Y-%m-%d"), "end": args.end}))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cadence", choices=list(CADENCE_STEP_DAYS))
    ap.add_argument("--trend", choices=["gradual-increase", "hockey-stick", "random", "answered-recovery"])
    ap.add_argument("--period", choices=list(PERIOD_DAYS))
    ap.add_argument("--calls-per-upload", type=int)
    ap.add_argument("--cycle-number", type=int, default=1)
    ap.add_argument("--out-dir")
    ap.add_argument("--state-dir", help="test-only override for ID-collision checks against a scratch ledger")
    ap.add_argument("--restamp", help="restamp mode: path to one already-built upload file")
    ap.add_argument("--end", help="restamp mode: ISO date the window ends on (inclusive)")
    ap.add_argument("--window-days", type=int, help="restamp mode: how many days the window spans")
    args = ap.parse_args()

    if args.restamp:
        if not args.end or not args.window_days:
            sys.exit("--restamp requires --end and --window-days")
        restamp(args)
        return 0

    missing = [f"--{k.replace('_','-')}" for k, v in (
        ("cadence", args.cadence), ("trend", args.trend), ("period", args.period),
        ("calls_per_upload", args.calls_per_upload), ("out_dir", args.out_dir),
    ) if not v]
    if missing:
        sys.exit(f"generate mode requires: {', '.join(missing)}")
    generate(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
