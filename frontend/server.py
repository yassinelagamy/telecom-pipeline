"""Orange Egypt analytics frontend API and static-file server."""

from __future__ import annotations

import json
import os
from datetime import date, datetime, timezone
from decimal import Decimal
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    import psycopg
    from psycopg.rows import dict_row
except ModuleNotFoundError:  # Allows contract tests before container dependencies exist.
    psycopg = None
    dict_row = None


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
PORT = int(os.getenv("FRONTEND_PORT", "8088"))

EVENT_TYPES = {"data", "voice", "sms"}
REGIONS = {"North", "South", "East", "West", "Central"}
PLANS = {"prepaid", "postpaid", "business"}
CITIES = {"Cairo", "Alexandria", "Giza", "Mansoura", "Aswan"}


def connect():
    if psycopg is None:
        raise RuntimeError("psycopg is required to connect to the warehouse")
    return psycopg.connect(
        host=os.getenv("DWH_POSTGRES_HOST", "postgres-dwh"),
        port=int(os.getenv("DWH_POSTGRES_PORT", "5432")),
        dbname=os.getenv("DWH_POSTGRES_DB", "telecom_dwh"),
        user=os.getenv("DWH_POSTGRES_USER", "dwh_user"),
        password=os.environ["DWH_POSTGRES_PASSWORD"],
        row_factory=dict_row,
        connect_timeout=5,
    )


def scalar(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def json_default(value):
    converted = scalar(value)
    if converted is value:
        raise TypeError(f"Cannot JSON encode {type(value).__name__}")
    return converted


def one(cursor, sql: str, values: list):
    cursor.execute(sql, values)
    row = cursor.fetchone()
    return {key: scalar(value) for key, value in row.items()} if row else {}


def many(cursor, sql: str, values: list):
    cursor.execute(sql, values)
    return [
        {key: scalar(value) for key, value in row.items()}
        for row in cursor.fetchall()
    ]


def clean_value(params: dict[str, list[str]], name: str) -> str | None:
    value = params.get(name, [""])[0].strip()
    return value or None


def enum_value(params, name: str, allowed: set[str]) -> str | None:
    value = clean_value(params, name)
    if value is not None and value not in allowed:
        raise ValueError(f"Invalid {name}")
    return value


def date_value(params, name: str) -> str | None:
    value = clean_value(params, name)
    if value:
        date.fromisoformat(value)
    return value


def usage_filters(params: dict[str, list[str]], include_customer=True):
    clauses = ["1 = 1"]
    values: list[str] = []
    start = date_value(params, "date_from")
    end = date_value(params, "date_to")
    event_type = enum_value(params, "event_type", EVENT_TYPES)
    region = enum_value(params, "region", REGIONS)
    plan = enum_value(params, "plan", PLANS)
    city = enum_value(params, "city", CITIES)
    if start:
        clauses.append("f.event_ts >= %s::date")
        values.append(start)
    if end:
        clauses.append("f.event_ts < %s::date + interval '1 day'")
        values.append(end)
    if event_type:
        clauses.append("f.event_type = %s")
        values.append(event_type)
    if region:
        clauses.append("t.region = %s")
        values.append(region)
    if include_customer and plan:
        clauses.append("s.plan_type = %s")
        values.append(plan)
    if include_customer and city:
        clauses.append("s.city = %s")
        values.append(city)
    return " AND ".join(clauses), values


def subscriber_filters(params: dict[str, list[str]]):
    clauses = ["1 = 1"]
    values: list[str] = []
    plan = enum_value(params, "plan", PLANS)
    city = enum_value(params, "city", CITIES)
    if plan:
        clauses.append("s.plan_type = %s")
        values.append(plan)
    if city:
        clauses.append("s.city = %s")
        values.append(city)
    return " AND ".join(clauses), values


def metric_filters(params: dict[str, list[str]]):
    clauses = ["1 = 1"]
    values: list[str] = []
    start = date_value(params, "date_from")
    end = date_value(params, "date_to")
    if start:
        clauses.append("m.run_hour >= %s::date")
        values.append(start)
    if end:
        clauses.append("m.run_hour < %s::date + interval '1 day'")
        values.append(end)
    return " AND ".join(clauses), values


def network_payload(params: dict[str, list[str]]):
    where, values = usage_filters(params)
    metric_where, metric_values = metric_filters(params)
    joins = """
        FROM dwh.fact_usage_events AS f
        JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
        JOIN dwh.dim_subscriber AS s ON s.subscriber_key = f.subscriber_key
    """
    with connect() as connection, connection.cursor() as cursor:
        kpis = one(
            cursor,
            f"""
            SELECT
                count(*) AS total_events,
                round(sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0))
                    / 1073741824.0, 2) AS data_gb,
                round(sum(coalesce(f.duration_sec, 0)) / 60.0, 2) AS voice_minutes,
                sum(coalesce(f.sms_count, 0)) AS sms_messages,
                count(DISTINCT f.tower_key) AS active_towers,
                count(DISTINCT f.subscriber_key) AS active_subscribers
            {joins}
            WHERE {where}
            """,
            values,
        )
        latest_quality = one(
            cursor,
            f"""
            SELECT
                round(100.0 * m.quarantine_rate::numeric, 2) AS quarantine_rate_pct,
                m.raw_rows,
                m.fact_rows,
                m.run_hour AS latest_hour
            FROM dwh.etl_hourly_metrics AS m
            WHERE {metric_where}
            ORDER BY m.run_hour DESC
            LIMIT 1
            """,
            metric_values,
        )
        hourly = many(
            cursor,
            f"""
            SELECT date_trunc('hour', f.event_ts) AS hour_utc,
                   f.event_type, count(*) AS event_count
            {joins}
            WHERE {where}
            GROUP BY 1, 2
            ORDER BY 1, 2
            """,
            values,
        )
        regions = many(
            cursor,
            f"""
            SELECT t.region, count(*) AS event_count,
                   round(sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0))
                       / 1073741824.0, 2) AS data_gb,
                   count(DISTINCT f.tower_key) AS active_towers
            {joins}
            WHERE {where}
            GROUP BY t.region
            ORDER BY event_count DESC
            """,
            values,
        )
        service_mix = many(
            cursor,
            f"""
            SELECT f.event_type, count(*) AS event_count
            {joins}
            WHERE {where}
            GROUP BY f.event_type
            ORDER BY event_count DESC
            """,
            values,
        )
        towers = many(
            cursor,
            f"""
            SELECT t.cell_tower_id, t.region, t.latitude, t.longitude,
                   count(*) AS event_count,
                   count(DISTINCT f.subscriber_key) AS unique_subscribers,
                   round(sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0))
                       / 1048576.0, 2) AS data_mb,
                   round(sum(coalesce(f.duration_sec, 0)) / 60.0, 2) AS voice_minutes,
                   sum(coalesce(f.sms_count, 0)) AS sms_messages
            {joins}
            WHERE {where}
            GROUP BY t.cell_tower_id, t.region, t.latitude, t.longitude
            ORDER BY event_count DESC, t.cell_tower_id
            """,
            values,
        )
        quarantine = many(
            cursor,
            f"""
            SELECT m.run_hour AS hour_utc,
                   round(100.0 * m.quarantine_rate::numeric, 2) AS rate_pct,
                   m.raw_rows, m.quarantine_rows
            FROM dwh.etl_hourly_metrics AS m
            WHERE {metric_where}
            ORDER BY m.run_hour
            """,
            metric_values,
        )
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "kpis": {**kpis, **latest_quality},
        "hourly": hourly,
        "regions": regions,
        "service_mix": service_mix,
        "towers": towers,
        "top_towers": towers[:10],
        "quarantine": quarantine,
    }


def customer_payload(params: dict[str, list[str]]):
    where, values = usage_filters(params)
    subscriber_where, subscriber_values = subscriber_filters(params)
    joins = """
        FROM dwh.fact_usage_events AS f
        JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
        JOIN dwh.dim_subscriber AS s ON s.subscriber_key = f.subscriber_key
    """
    with connect() as connection, connection.cursor() as cursor:
        subscriber_kpis = one(
            cursor,
            f"""
            SELECT count(*) AS total_subscribers,
                   count(*) FILTER (WHERE s.is_active) AS active_subscribers
            FROM dwh.dim_subscriber AS s
            WHERE {subscriber_where}
            """,
            subscriber_values,
        )
        usage_kpis = one(
            cursor,
            f"""
            SELECT
                round(sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0))
                    / 1048576.0 / nullif(count(DISTINCT s.subscriber_key), 0), 2)
                    AS avg_data_mb,
                round(sum(coalesce(f.duration_sec, 0)) / 60.0
                    / nullif(count(DISTINCT s.subscriber_key), 0), 2)
                    AS avg_voice_minutes
            {joins}
            WHERE {where}
            """,
            values,
        )
        plans = many(
            cursor,
            f"""
            SELECT s.plan_type, count(*) AS event_count,
                   count(DISTINCT s.subscriber_key) AS active_users,
                   round(sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0))
                       / 1073741824.0, 2) AS data_gb
            {joins}
            WHERE {where}
            GROUP BY s.plan_type
            ORDER BY event_count DESC
            """,
            values,
        )
        cities = many(
            cursor,
            f"""
            SELECT s.city, count(*) AS subscriber_count,
                   count(*) FILTER (WHERE s.is_active) AS active_subscribers
            FROM dwh.dim_subscriber AS s
            WHERE {subscriber_where}
            GROUP BY s.city
            ORDER BY subscriber_count DESC
            """,
            subscriber_values,
        )
        weekday = many(
            cursor,
            f"""
            SELECT CASE WHEN d.is_weekend THEN 'Weekend' ELSE 'Weekday' END AS day_type,
                   f.event_type, count(*) AS event_count
            {joins}
            JOIN dwh.dim_date AS d ON d.date_key = f.date_key
            WHERE {where}
            GROUP BY d.is_weekend, f.event_type
            ORDER BY d.is_weekend, f.event_type
            """,
            values,
        )
        top_subscribers = many(
            cursor,
            f"""
            SELECT s.subscriber_id, s.plan_type, s.city,
                   count(*) AS event_count,
                   round(sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0))
                       / 1048576.0, 2) AS data_mb,
                   round(sum(coalesce(f.duration_sec, 0)) / 60.0, 2) AS voice_minutes,
                   sum(coalesce(f.sms_count, 0)) AS sms_messages,
                   max(f.event_ts) AS last_activity
            {joins}
            WHERE {where}
            GROUP BY s.subscriber_id, s.plan_type, s.city
            ORDER BY event_count DESC, s.subscriber_id
            LIMIT 50
            """,
            values,
        )
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "kpis": {**subscriber_kpis, **usage_kpis},
        "plans": plans,
        "cities": cities,
        "weekday": weekday,
        "top_subscribers": top_subscribers,
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def json_response(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, default=json_default).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/health":
                self.json_response({"status": "ok"})
                return
            if parsed.path == "/api/network":
                self.json_response(network_payload(parse_qs(parsed.query)))
                return
            if parsed.path == "/api/customers":
                self.json_response(customer_payload(parse_qs(parsed.query)))
                return
        except (ValueError, KeyError) as error:
            self.json_response({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        except (psycopg.Error if psycopg else RuntimeError):
            self.json_response(
                {"error": "The analytics warehouse is temporarily unavailable."},
                HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return
        if parsed.path and "." not in parsed.path.rsplit("/", 1)[-1]:
            self.path = "/"
        super().do_GET()

    def log_message(self, message, *args):
        print(f"frontend: {message % args}")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Orange Egypt analytics frontend listening on :{PORT}")
    server.serve_forever()
