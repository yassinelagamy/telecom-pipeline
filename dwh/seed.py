"""Deterministically seed the telecom warehouse dimensions.

The Postgres container uses seed.sql on first initialization. This equivalent
Python entry point supports explicit reseeding and local development.
"""

from __future__ import annotations

import os
from datetime import date, timedelta
from typing import Iterator


PLANS = ("prepaid", "postpaid", "business")
CITIES = ("Cairo", "Alexandria", "Giza", "Mansoura", "Aswan")
REGIONS = ("North", "South", "East", "West", "Central")
DATE_START = date(2025, 1, 1)
DATE_END = date(2027, 12, 31)


def subscriber_rows(count: int = 5_000) -> Iterator[tuple[object, ...]]:
    for number in range(1, count + 1):
        yield (
            f"SUB-{number:06d}",
            PLANS[number % len(PLANS)],
            CITIES[number % len(CITIES)],
            date(2020, 1, 1) + timedelta(days=(number * 37) % 1825),
            number % 20 != 0,
        )


def tower_rows(count: int = 200) -> Iterator[tuple[object, ...]]:
    for number in range(1, count + 1):
        yield (
            f"TWR-{number:04d}",
            REGIONS[number % len(REGIONS)],
            22.0 + ((number * 73) % 900) / 100.0,
            25.0 + ((number * 47) % 1000) / 100.0,
        )


def date_rows(
    start: date = DATE_START, end: date = DATE_END
) -> Iterator[tuple[object, ...]]:
    current = start
    while current <= end:
        yield (
            int(current.strftime("%Y%m%d")),
            current,
            current.year,
            current.month,
            current.day,
            current.isoweekday(),
            current.isoweekday() in (6, 7),
        )
        current += timedelta(days=1)


def connect():
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            "Install dwh/requirements.txt before running the Python seeder"
        ) from exc
    return psycopg.connect(
        host=os.getenv("DWH_POSTGRES_HOST", "localhost"),
        port=os.getenv("DWH_POSTGRES_PORT", "5432"),
        dbname=os.getenv("DWH_POSTGRES_DB", "telecom_dwh"),
        user=os.environ["DWH_POSTGRES_USER"],
        password=os.environ["DWH_POSTGRES_PASSWORD"],
    )


def seed() -> dict[str, int]:
    subscribers = list(subscriber_rows())
    towers = list(tower_rows())
    dates = list(date_rows())
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.executemany(
                """INSERT INTO dwh.dim_subscriber
                       (subscriber_id, plan_type, city, activation_date, is_active)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (subscriber_id) DO UPDATE SET
                       plan_type = EXCLUDED.plan_type,
                       city = EXCLUDED.city,
                       activation_date = EXCLUDED.activation_date,
                       is_active = EXCLUDED.is_active""",
                subscribers,
            )
            cursor.executemany(
                """INSERT INTO dwh.dim_tower
                       (cell_tower_id, region, latitude, longitude)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (cell_tower_id) DO UPDATE SET
                       region = EXCLUDED.region,
                       latitude = EXCLUDED.latitude,
                       longitude = EXCLUDED.longitude""",
                towers,
            )
            cursor.executemany(
                """INSERT INTO dwh.dim_date
                       (date_key, full_date, year, month, day, day_of_week, is_weekend)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (date_key) DO UPDATE SET
                       full_date = EXCLUDED.full_date,
                       year = EXCLUDED.year,
                       month = EXCLUDED.month,
                       day = EXCLUDED.day,
                       day_of_week = EXCLUDED.day_of_week,
                       is_weekend = EXCLUDED.is_weekend""",
                dates,
            )
    counts = {
        "subscribers": len(subscribers),
        "towers": len(towers),
        "dates": len(dates),
    }
    print(
        "seeded " + " ".join(f"{name}={count}" for name, count in counts.items())
    )
    return counts


if __name__ == "__main__":
    seed()
