#!/usr/bin/env python3
"""
Post Surfside Healthcare demo calls to the Invoca Call Ingestion API,
network 2160.

Self-contained subagent package: everything this script needs (credentials,
network/campaign IDs, endpoint, custom_data field mapping, send history)
lives inside this folder. It has no dependency on any other network's
files, the root "Bulk Demo Calls" project, or any specific machine -- only
on being handed a CSV and network access to invoca.net.

Pass any "..._WITH_URLS.csv"-style file with an "ID name" and "Audio URL"
column already filled in, and this script builds the request body and
sends it directly -- no separate "build upload file" step.

The custom_data field mapping and campaign/network identity are specific to
network 2160 on purpose -- a different network gets its own folder/script,
never a shared generic one (see AGENT_PROMPT.md).

State is recorded in state/ingest_state.json. external_call_unique_id must
stay unique across this network FOREVER, so this file is the one and only
ledger of everything ever sent here -- never delete or edit it by hand, and
never point two different subagent copies at two different state files for
the same network.

Usage
-----
    cd healthcare-network-2160
    python3 ingest.py --csv "/path/to/some_WITH_URLS.csv" --dry-run
    python3 ingest.py --csv "..." --test
    python3 ingest.py --csv "..." --status
    python3 ingest.py --csv "..."
    python3 ingest.py --csv "..." --only ABC1234 XYZ7890
    python3 ingest.py --csv "..." --retry-failed

The token is read from network_config.env in this same folder and is never
printed or written to any log.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
STATE = HERE / "state" / "ingest_state.json"
CONFIG = HERE / "network_config.env"

LANGUAGE_CODE = "en-US"
NETWORK_TZ = ZoneInfo("America/New_York")  # simplification: one TZ for all regions
SEED = 20260921  # for ANI synthesis only; does not affect what's sent

TIMEOUT = 120
PAUSE = 0.35
OK_CODES = {201, 202}

# partner_name taken from network 2160's actual Custom Data Dictionary
# export (custom_data_dictionary.csv in this folder), not guessed. If
# Invoca adds a new field you need to send, look up its exact partner_name
# in that file first -- do not invent a name.
CUSTOM_DATA = {
    "Region": "Region",
    "Division": "Division",
    "Location": "Facility",
    "Marketing Source": "utm_source",
    "Marketing Medium": "utm_medium",
    "Marketing Campaign": "utm_campaign",
    "Marketing Search Terms": "utm_term",
    "Landing Page": "landing_page",
    "Calling Page": "calling_page",
    "Specialty": "Specialty",
    "Google Click ID": "gclid",
    "Google GBRAID": "gbraid",
    "Google WBRAID": "wbraid",
    "Google Ads Customer ID": "customer_id",
}

# No signals by design, same choice as network 1847: Signal AI is meant to
# detect outcomes from the audio itself.
INCLUDE_SIGNALS = False

# Real area codes for every city seen across this network's CSVs so far.
# Falls back to a generic "555" area code for an unrecognized city rather
# than failing -- fine for demo data, but worth flagging back to the
# parent agent so the table can be extended.
AREA_CODES = {
    "Atlanta": "404", "Augusta": "706", "Baton Rouge": "225", "Biloxi": "228",
    "Boston": "617", "Charleston": "843", "Charlotte": "704", "Columbia": "803",
    "Gulfport": "228", "Hartford": "860", "Houston": "713", "Manchester": "603",
    "Mobile": "251", "Nashville": "615", "New Haven": "203", "New Orleans": "504",
    "Pensacola": "850", "Portland": "207", "Providence": "401", "Raleigh": "919",
    "Savannah": "912", "Springfield": "413", "Tampa": "813", "Worcester": "508",
}

EXCEL_ERRORS = {"#NAME?", "#REF!", "#VALUE!", "#N/A", "#DIV/0!", "#NULL!"}
_ani_pools: dict[str, list[int]] = {}
_ani_rnd = None


def clean(v: str) -> str:
    v = (v or "").strip()
    if v in ("", "__") or v in EXCEL_ERRORS:
        return ""
    return v


def to_iso(stamp: str) -> str:
    """CSV format: 2026-08-02 14:35:28 -> ISO 8601 with offset."""
    dt = datetime.strptime(stamp.strip(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=NETWORK_TZ)
    return dt.isoformat(timespec="milliseconds")


def to_e164(number: str) -> str:
    d = "".join(c for c in (number or "") if c.isdigit())
    if len(d) == 10:
        return f"+1{d}"
    if len(d) == 11 and d.startswith("1"):
        return f"+{d}"
    return number if (number or "").startswith("+") else f"+{d}"


def ani(row: dict) -> str:
    """Real ANI if the CSV has one; otherwise synthesize from city area code.
    Synthetic demo data has no real caller number, so synthesis is the
    expected path for this network's CSVs."""
    global _ani_rnd
    for col in ("Calling Phone Number", "calling_phone_number", "ANI"):
        if row.get(col, "").strip():
            return row[col].strip()
    if _ani_rnd is None:
        import random
        _ani_rnd = random.Random(SEED)
    ac = AREA_CODES.get(row.get("City", "").strip(), "555")
    if ac not in _ani_pools:
        _ani_pools[ac] = list(range(100, 1000))
        _ani_rnd.shuffle(_ani_pools[ac])
    last4 = f"{_ani_pools[ac].pop():04d}" if _ani_pools[ac] else f"{_ani_rnd.randint(200, 9999):04d}"
    return f"{ac}555{last4}"


def patient_type(row: dict) -> str:
    """Derived field -> custom_data 'patient_type'. Not a single CSV column."""
    if row.get("New Patient", "").strip() == "1":
        return "new"
    if row.get("Existing Patient", "").strip() == "1":
        return "existing"
    return ""


def outcome_of(row: dict) -> str:
    if row.get("Not Answered by Agent") == "1":
        return "unanswered"
    if row.get("Appointment Booked") == "1":
        return "appointment_booked"
    if row.get("Appointment Rescheduled") == "1":
        return "appointment_rescheduled"
    if row.get("New Patient") == "1":
        return "new_patient"
    if row.get("Existing Patient") == "1":
        return "existing_patient"
    return "other"


def load_config() -> dict[str, str]:
    if not CONFIG.exists():
        sys.exit(f"missing {CONFIG}. This subagent cannot run without its network_config.env.")
    cfg = {}
    for line in CONFIG.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip()
    required = ("INVOCA_API_TOKEN", "INVOCA_NETWORK_ID", "INVOCA_CAMPAIGN_ID", "INVOCA_ENDPOINT")
    missing = [k for k in required if not cfg.get(k)]
    if missing:
        sys.exit(f"network_config.env is missing: {', '.join(missing)}")
    return cfg


def load_state() -> dict:
    if STATE.exists():
        return json.loads(STATE.read_text())
    return {}


def save_state(state: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1, sort_keys=True))


def build_body(row: dict, campaign_id: str) -> dict:
    call = {
        "external_call_unique_id": row["ID name"].strip(),
        "start_time": to_iso(row["Call Start Time"]),
        "destination_phone_number": to_e164(row["Called Phone Number"]),
        "calling_phone_number": to_e164(ani(row)),
        "advertiser_campaign_id_from_network": int(campaign_id),
        "call_direction": row.get("call_direction", "inbound").strip() or "inbound",
        "recording_url": row["Audio URL"].strip(),
        "language_code": LANGUAGE_CODE,
    }
    body: dict = {"call": call}

    custom_data = [
        {"name": partner, "value": clean(row.get(col, ""))}
        for col, partner in CUSTOM_DATA.items()
        if clean(row.get(col, ""))
    ]
    pt = patient_type(row)
    if pt:
        custom_data.append({"name": "patient_type", "value": pt})
    if custom_data:
        body["custom_data"] = custom_data
    if INCLUDE_SIGNALS:
        body["signals"] = []
    return body


def validate_csv(rows: list[dict], csv_path: Path) -> None:
    """Catch the common, fixable problems before attempting any send.
    This is the extent of the 'adjustments' this script makes on its own --
    it will trim/clean values below, but it will NOT invent IDs, guess at
    dates, or reinterpret ambiguous columns. Anything it can't safely fix
    is a hard stop, not a guess."""
    if not rows:
        sys.exit(f"{csv_path.name} has no data rows.")
    missing_id = [r for r in rows if not r.get("ID name", "").strip()]
    missing_url = [r for r in rows if not r.get("Audio URL", "").strip()]
    if missing_id or missing_url:
        sys.exit(f"{csv_path.name} is missing 'ID name' on {len(missing_id)} row(s) and "
                  f"'Audio URL' on {len(missing_url)} row(s) -- this script only sends "
                  f"calls that already have an ID and a hosted audio URL. Do not guess "
                  f"or fabricate either; report back to the parent agent instead.")
    ids = [r["ID name"].strip() for r in rows]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        sys.exit(f"{csv_path.name} has duplicate 'ID name' values within itself: "
                  f"{sorted(dupes)[:10]}. Each ID must be unique. Do not de-duplicate "
                  f"by guessing which row is correct; report back instead.")
    bad_dates = []
    for r in rows:
        try:
            to_iso(r["Call Start Time"])
        except Exception:
            bad_dates.append(r.get("ID name", "?"))
    if bad_dates:
        sys.exit(f"{len(bad_dates)} row(s) have a 'Call Start Time' that isn't in "
                  f"YYYY-MM-DD HH:MM:SS format, e.g. row(s): {bad_dates[:10]}. Fix the "
                  f"source CSV's date format upstream rather than reformatting blindly here.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", help="path to a *_WITH_URLS.csv for network 2160 (not needed with --status)")
    ap.add_argument("--dry-run", action="store_true", help="print a sample body, send nothing")
    ap.add_argument("--test", action="store_true",
                    help="send 3 diverse calls (unanswered, appointment booked, other) and stop")
    ap.add_argument("--status", action="store_true", help="summarise everything ever sent to this network")
    ap.add_argument("--only", nargs="*", metavar="ID", help="send only these call IDs")
    ap.add_argument("--limit", type=int, help="send at most N calls")
    ap.add_argument("--retry-failed", action="store_true",
                    help="also retry calls that previously failed (never retries 409)")
    args = ap.parse_args()

    cfg = load_config()
    state = load_state()

    if args.status:
        done = [k for k, v in state.items() if v["code"] in OK_CODES]
        fail = {k: v for k, v in state.items() if v["code"] not in OK_CODES}
        print(f"network              : {cfg['INVOCA_NETWORK_ID']}")
        print(f"total ever attempted : {len(state)}")
        print(f"accepted by Invoca   : {len(done)}")
        print(f"failed               : {len(fail)}")
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
    rows = list(csv.DictReader(open(csv_path, newline="", encoding="utf-8-sig")))
    validate_csv(rows, csv_path)

    todo = rows
    if args.only:
        want = set(args.only)
        todo = [r for r in rows if r["ID name"].strip() in want]
    elif args.test:
        accepted = {k for k, v in state.items() if v["code"] in OK_CODES}
        picks, seen = [], set()
        for r in rows:
            cid = r["ID name"].strip()
            o = outcome_of(r)
            key = "unanswered" if o == "unanswered" else ("booked" if o == "appointment_booked" else "other")
            if key not in seen and cid not in accepted:
                seen.add(key)
                picks.append(r)
            if len(picks) == 3:
                break
        todo = picks
    else:
        todo = [r for r in rows
                if r["ID name"].strip() not in state
                or (args.retry_failed
                    and state[r["ID name"].strip()]["code"] not in OK_CODES
                    and state[r["ID name"].strip()]["code"] != 409)]
    if args.limit:
        todo = todo[: args.limit]

    if args.dry_run:
        body = build_body(rows[0], cfg["INVOCA_CAMPAIGN_ID"])
        print(f"endpoint    : {cfg['INVOCA_ENDPOINT']}")
        print(f"network     : {cfg['INVOCA_NETWORK_ID']}")
        print(f"campaign    : {cfg['INVOCA_CAMPAIGN_ID']}")
        print(f"csv         : {csv_path.name}  ({len(rows)} rows)")
        print(f"auth        : raw token in the Authorization header (from network_config.env, not shown)")
        print(f"would send  : {len(todo)}")
        print(f"already ok  : {sum(1 for v in state.values() if v['code'] in OK_CODES)}")
        print(f"\nsample request body:\n{json.dumps(body, indent=2)}")
        return 0

    if not todo:
        print("nothing to send. Run --status to see what's already been accepted.")
        return 0

    try:
        import requests
    except ImportError:
        sys.exit("requests not installed. Run: pip install requests")

    headers = {"Content-type": "application/json", "Authorization": cfg["INVOCA_API_TOKEN"]}

    print(f"endpoint : {cfg['INVOCA_ENDPOINT']}")
    print(f"network  : {cfg['INVOCA_NETWORK_ID']}")
    print(f"campaign : {cfg['INVOCA_CAMPAIGN_ID']}")
    print(f"csv      : {csv_path.name}")
    print(f"signals  : {'included' if INCLUDE_SIGNALS else 'none (omitted by design)'}")
    print(f"sending  : {len(todo)} call(s)\n")

    counts = Counter()
    for n, row in enumerate(todo, 1):
        cid = row["ID name"].strip()
        body = build_body(row, cfg["INVOCA_CAMPAIGN_ID"])
        o = outcome_of(row)
        try:
            resp = requests.post(cfg["INVOCA_ENDPOINT"], headers=headers, json=body, timeout=TIMEOUT)
            code = resp.status_code
            try:
                payload = resp.json()
            except ValueError:
                payload = {"raw": resp.text[:300]}
        except Exception as exc:  # noqa: BLE001
            code, payload = 0, {"exception": f"{type(exc).__name__}: {exc}"}

        entry = {"code": code, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "source_csv": csv_path.name}
        if code in OK_CODES:
            entry["cuid"] = payload.get("cuid")
            counts["ok"] += 1
            mark = "ok  "
            detail = f"cuid {payload.get('cuid')}"
        else:
            entry["error"] = payload
            counts[f"fail {code}"] += 1
            mark = "FAIL"
            detail = json.dumps(payload)[:140]
        state[cid] = entry
        print(f"  [{n}/{len(todo)}] {mark} {cid} ({o}) {code}  {detail}")
        save_state(state)
        time.sleep(PAUSE)

    print(f"\n{dict(counts)}")
    print(f"state saved to state/{STATE.name}")

    if counts["ok"] and args.test:
        print("\nTest calls accepted. Verify them in Invoca, then send the rest with:")
        print(f"  python3 ingest.py --csv \"{csv_path}\"")
    if any(k.startswith("fail") for k in counts):
        print("\nSome calls failed. Nothing was re-sent, so their IDs are still free.")
        print(f"Fix the cause, then: python3 ingest.py --csv \"{csv_path}\" --retry-failed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
