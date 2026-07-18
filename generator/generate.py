"""Telecom usage log generator.

Produces one UTC interval of NDJSON usage events (gzip) following the data
contract in SCHEMAS.md. ~2% of rows are intentionally malformed to exercise
the ETL quarantine path (D7).

Deterministic per interval: the RNG is seeded from the interval start, so a
rerun reproduces identical data (useful for idempotency testing, D6).

Usage:
    python generate.py --start 2026-07-14T09:20 [--minutes 10] [--events 1667]
"""

import argparse
import gzip
import json
import os
import random
import uuid
import zlib
from datetime import datetime, timedelta, timezone

EVENT_TYPES = ["voice", "sms", "data"]
EVENT_WEIGHTS = [0.35, 0.25, 0.40]

# Traffic intensity by UTC hour of day (night trough, evening peak).
DIURNAL = [0.30, 0.25, 0.22, 0.20, 0.22, 0.30, 0.45, 0.65,
           0.85, 1.00, 1.05, 1.10, 1.15, 1.10, 1.05, 1.00,
           1.05, 1.15, 1.30, 1.35, 1.25, 1.00, 0.70, 0.45]


def parse_interval_start(s: str) -> datetime:
    try:
        dt = datetime.strptime(s, "%Y-%m-%dT%H:%M")
    except ValueError:
        dt = datetime.strptime(s, "%Y-%m-%dT%H")
    return dt.replace(tzinfo=timezone.utc)


parse_hour = parse_interval_start


def subscriber_pool(n: int):
    ids = [f"SUB-{i:06d}" for i in range(1, n + 1)]
    # Heavy-user skew: weight ~ 1/rank^0.6
    weights = [1.0 / (r ** 0.6) for r in range(1, n + 1)]
    return ids, weights


def tower_pool(n: int):
    ids = [f"TWR-{i:04d}" for i in range(1, n + 1)]
    weights = [1.0 / (r ** 0.4) for r in range(1, n + 1)]
    return ids, weights


def make_event(rng: random.Random, ts_start: datetime, duration_seconds: int,
               subs, towers) -> dict:
    event_type = rng.choices(EVENT_TYPES, weights=EVENT_WEIGHTS, k=1)[0]
    ts = ts_start + timedelta(seconds=rng.uniform(0, duration_seconds))
    ev = {
        "event_id": str(uuid.UUID(int=rng.getrandbits(128), version=4)),
        "subscriber_id": rng.choices(subs[0], weights=subs[1], k=1)[0],
        "event_type": event_type,
        "cell_tower_id": rng.choices(towers[0], weights=towers[1], k=1)[0],
        "event_ts": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "duration_sec": None,
        "sms_count": None,
        "bytes_up": None,
        "bytes_down": None,
    }
    if event_type == "voice":
        ev["duration_sec"] = max(1, int(rng.lognormvariate(4.0, 1.0)))  # ~median 55s
    elif event_type == "sms":
        ev["sms_count"] = 1 if rng.random() < 0.9 else rng.randint(2, 5)
    else:  # data
        down = int(rng.lognormvariate(13.0, 1.5))  # ~median 440 KB
        ev["bytes_down"] = down
        ev["bytes_up"] = int(down * rng.uniform(0.05, 0.3))
    return ev


def corrupt(rng: random.Random, ev: dict) -> str:
    """Return a malformed serialized row (one of several failure modes)."""
    mode = rng.randint(1, 6)
    bad = dict(ev)
    if mode == 1:                       # missing required field
        del bad[rng.choice(["event_id", "subscriber_id", "event_ts", "event_type"])]
    elif mode == 2:                     # unparseable timestamp
        bad["event_ts"] = rng.choice(["14/07/2026 09:15", "not-a-time", "2026-13-40T99:99:99Z"])
    elif mode == 3:                     # negative metric
        if bad["event_type"] == "voice":
            bad["duration_sec"] = -rng.randint(1, 500)
        else:
            bad["event_type"] = "voice"
            bad["duration_sec"] = -rng.randint(1, 500)
    elif mode == 4:                     # invalid event_type
        bad["event_type"] = rng.choice(["video", "VOICE", "", None])
    elif mode == 5:                     # null required field
        bad["subscriber_id"] = None
    else:                               # truncated JSON (parse failure)
        return json.dumps(bad)[: rng.randint(20, 60)]
    return json.dumps(bad)


def generate_interval(start: datetime, minutes: int, events: int,
                      malformed_rate: float, n_subs: int,
                      n_towers: int) -> list[str]:
    seed = zlib.crc32(start.strftime("%Y-%m-%dT%H:%M").encode())
    rng = random.Random(seed)
    subs, towers = subscriber_pool(n_subs), tower_pool(n_towers)
    n = max(1, int(events * DIURNAL[start.hour]))
    lines = []
    for _ in range(n):
        ev = make_event(rng, start, minutes * 60, subs, towers)
        if rng.random() < malformed_rate:
            lines.append(corrupt(rng, ev))
        else:
            lines.append(json.dumps(ev))
    return lines


def generate_hour(hour: datetime, events: int, malformed_rate: float,
                  n_subs: int, n_towers: int) -> list[str]:
    return generate_interval(hour, 60, events, malformed_rate, n_subs, n_towers)


def write_interval_file(start: datetime, lines: list[str], out_dir: str) -> str:
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"part-{start.strftime('%Y%m%d%H%M')}-0000.json.gz")
    with gzip.open(path, "wt", encoding="utf-8", newline="\n") as f:
        for line in lines:
            f.write(line + "\n")
    return path


write_hour_file = write_interval_file


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--start", help="UTC interval start, e.g. 2026-07-14T09:20")
    p.add_argument("--hour", help=argparse.SUPPRESS)
    p.add_argument("--minutes", type=int, default=10)
    p.add_argument("--events", type=int,
                   default=int(os.getenv("GEN_EVENTS_PER_10_MINUTES", "1667")),
                   help="baseline events per interval before diurnal scaling")
    p.add_argument("--malformed-rate", type=float,
                   default=float(os.getenv("GEN_MALFORMED_RATE", "0.02")))
    p.add_argument("--subscribers", type=int,
                   default=int(os.getenv("GEN_NUM_SUBSCRIBERS", "5000")))
    p.add_argument("--towers", type=int,
                   default=int(os.getenv("GEN_NUM_TOWERS", "200")))
    p.add_argument("--out", default="./data", help="local output directory")
    args = p.parse_args()

    start_arg = args.start or args.hour
    if not start_arg:
        p.error("--start is required")
    start = parse_interval_start(start_arg)
    lines = generate_interval(start, args.minutes, args.events,
                              args.malformed_rate, args.subscribers, args.towers)
    path = write_interval_file(start, lines, args.out)
    print(f"wrote {len(lines)} events -> {path}")


if __name__ == "__main__":
    main()
