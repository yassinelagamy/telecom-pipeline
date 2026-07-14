"""Generate + upload a range of historical hours into MinIO.

Default: the 48 completed UTC hours ending at the last fully-elapsed hour.

Usage:
    python backfill.py [--hours 48] [--end 2026-07-14T09]
"""

import argparse
import os
import tempfile
from datetime import datetime, timedelta, timezone

from generate import generate_hour, parse_hour, write_hour_file
from upload import upload_file


def last_complete_hour() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--hours", type=int, default=48)
    p.add_argument("--end", help="last UTC hour to fill, e.g. 2026-07-14T09 "
                                 "(default: last completed hour)")
    args = p.parse_args()

    end = parse_hour(args.end) if args.end else last_complete_hour()
    events = int(os.getenv("GEN_EVENTS_PER_HOUR", "10000"))
    rate = float(os.getenv("GEN_MALFORMED_RATE", "0.02"))
    subs = int(os.getenv("GEN_NUM_SUBSCRIBERS", "5000"))
    towers = int(os.getenv("GEN_NUM_TOWERS", "200"))

    total = 0
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(args.hours - 1, -1, -1):
            hour = end - timedelta(hours=i)
            lines = generate_hour(hour, events, rate, subs, towers)
            path = write_hour_file(hour, lines, tmp)
            uri = upload_file(path, hour)
            os.remove(path)
            total += len(lines)
            print(f"{hour:%Y-%m-%dT%H}: {len(lines):>6} events -> {uri}")
    print(f"backfill done: {args.hours} hours, {total} events")


if __name__ == "__main__":
    main()
