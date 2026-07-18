"""Orange Egypt analytics frontend API and static-file server."""

from __future__ import annotations

import json
import os
import gzip
import re
import threading
import time
from collections import OrderedDict
from datetime import date, datetime, timezone
from decimal import Decimal
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    import psycopg
    from psycopg.rows import dict_row
    try:
        from psycopg_pool import ConnectionPool, PoolTimeout
    except ModuleNotFoundError:
        ConnectionPool = None
        PoolTimeout = RuntimeError
except ModuleNotFoundError:  # Allows contract tests before container dependencies exist.
    psycopg = None
    dict_row = None
    ConnectionPool = None
    PoolTimeout = RuntimeError


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
PORT = int(os.getenv("FRONTEND_PORT", "8088"))
CACHE_TTL_SECONDS = int(os.getenv("FRONTEND_CACHE_TTL", "20"))
CACHE_MAX_ENTRIES = int(os.getenv("FRONTEND_CACHE_MAX", "256"))

EVENT_TYPES = {"data", "voice", "sms"}
REGIONS = {"North", "South", "East", "West", "Central"}
PLANS = {"prepaid", "postpaid", "business"}
CITIES = {"Cairo", "Alexandria", "Giza", "Mansoura", "Aswan"}

CROSS_DIMENSIONS = {
    "region": ("t.region", "Region"),
    "plan": ("s.plan_type", "Plan"),
    "city": ("s.city", "City"),
    "event_type": ("f.event_type", "Usage type"),
    "tower": ("t.cell_tower_id", "Tower"),
    "subscriber": ("s.subscriber_id", "Subscriber"),
}
CROSS_METRICS = {
    "events": ("count(*)", "Usage events"),
    "data_mb": (
        "round(sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0)) "
        "/ 1048576.0, 2)",
        "Data traffic (MB)",
    ),
    "voice_minutes": (
        "round(sum(coalesce(f.duration_sec, 0)) / 60.0, 2)",
        "Voice minutes",
    ),
    "sms_messages": ("sum(coalesce(f.sms_count, 0))", "SMS messages"),
    "subscribers": ("count(DISTINCT f.subscriber_key)", "Unique subscribers"),
}

ANALYTICS_CATALOG = {
    "dimensions": [
        {"id": "event_type", "label": "Usage type", "group": "Service", "filterable": True, "splittable": True},
        {"id": "region", "label": "Region", "group": "Geography", "filterable": True, "splittable": True},
        {"id": "tower", "label": "Tower", "group": "Geography", "filterable": True, "splittable": True},
        {"id": "plan", "label": "Plan", "group": "Customer", "filterable": True, "splittable": True},
        {"id": "city", "label": "City", "group": "Customer", "filterable": True, "splittable": True},
        {"id": "subscriber", "label": "Subscriber", "group": "Customer", "filterable": True, "splittable": False},
    ],
    "measures": [
        {"id": "events", "label": "Usage events", "format": "integer", "description": "Validated usage events", "certified": True},
        {"id": "data_mb", "label": "Data traffic (MB)", "format": "megabytes", "description": "Uploaded plus downloaded bytes", "certified": True},
        {"id": "voice_minutes", "label": "Voice minutes", "format": "minutes", "description": "Completed voice duration", "certified": True},
        {"id": "sms_messages", "label": "SMS messages", "format": "integer", "description": "Messages carried", "certified": True},
        {"id": "subscribers", "label": "Unique subscribers", "format": "integer", "description": "Distinct active subscribers", "certified": True},
    ],
    "drill_paths": [
        {"id": "geography", "label": "Network geography", "dimensions": ["region", "tower"]},
        {"id": "customer", "label": "Customer segmentation", "dimensions": ["plan", "city", "subscriber"]},
        {"id": "service", "label": "Service to network", "dimensions": ["event_type", "region", "tower"]},
    ],
    "chart_types": ["bar", "stacked", "line", "pie"],
    "selection_states": ["selected", "possible", "alternative", "excluded"],
}

_pool = None
_pool_lock = threading.Lock()
_cache: OrderedDict[str, tuple[float, object]] = OrderedDict()
_cache_lock = threading.Lock()
_cache_stats = {"hits": 0, "misses": 0, "evictions": 0}


def connect():
    if psycopg is None:
        raise RuntimeError("psycopg is required to connect to the warehouse")
    global _pool
    if ConnectionPool is not None:
        with _pool_lock:
            if _pool is None:
                _pool = ConnectionPool(
                    kwargs={
                        "host": os.getenv("DWH_POSTGRES_HOST", "postgres-dwh"),
                        "port": int(os.getenv("DWH_POSTGRES_PORT", "5432")),
                        "dbname": os.getenv("DWH_POSTGRES_DB", "telecom_dwh"),
                        "user": os.getenv("DWH_POSTGRES_USER", "dwh_user"),
                        "password": os.environ["DWH_POSTGRES_PASSWORD"],
                        "row_factory": dict_row,
                        "connect_timeout": 5,
                    },
                    min_size=1,
                    max_size=8,
                    timeout=5,
                    open=True,
                )
        return _pool.connection(timeout=5)
    return psycopg.connect(
        host=os.getenv("DWH_POSTGRES_HOST", "postgres-dwh"),
        port=int(os.getenv("DWH_POSTGRES_PORT", "5432")),
        dbname=os.getenv("DWH_POSTGRES_DB", "telecom_dwh"),
        user=os.getenv("DWH_POSTGRES_USER", "dwh_user"),
        password=os.environ["DWH_POSTGRES_PASSWORD"],
        row_factory=dict_row,
        connect_timeout=5,
    )


def cache_get(key: str):
    now = time.monotonic()
    with _cache_lock:
        cached = _cache.get(key)
        if cached and now - cached[0] <= CACHE_TTL_SECONDS:
            _cache.move_to_end(key)
            _cache_stats["hits"] += 1
            return cached[1]
        if cached:
            del _cache[key]
        _cache_stats["misses"] += 1
    return None


def cache_set(key: str, payload):
    with _cache_lock:
        _cache[key] = (time.monotonic(), payload)
        _cache.move_to_end(key)
        while len(_cache) > CACHE_MAX_ENTRIES:
            _cache.popitem(last=False)
            _cache_stats["evictions"] += 1


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


def enum_values(params, name: str, allowed: set[str]) -> list[str]:
    """Multi-select variant: repeated params and/or comma-separated values."""
    raw = params.get(name, [])
    values: list[str] = []
    for entry in raw:
        for value in entry.split(","):
            value = value.strip()
            if not value:
                continue
            if value not in allowed:
                raise ValueError(f"Invalid {name}")
            if value not in values:
                values.append(value)
    return values


def identifier_values(params, name: str, pattern: str) -> list[str]:
    """Validate dynamic high-cardinality identifiers before parameter binding."""
    raw = params.get(name, [])
    values: list[str] = []
    for entry in raw:
        for value in entry.split(","):
            value = value.strip()
            if not value:
                continue
            if len(value) > 64 or not re.fullmatch(pattern, value):
                raise ValueError(f"Invalid {name}")
            if value not in values:
                values.append(value)
    if len(values) > 50:
        raise ValueError(f"Too many {name} selections")
    return values


def in_clause(clauses: list, values: list, column: str, selected: list[str]):
    if len(selected) == 1:
        clauses.append(f"{column} = %s")
        values.append(selected[0])
    elif selected:
        clauses.append(f"{column} IN ({', '.join(['%s'] * len(selected))})")
        values.extend(selected)


def date_value(params, name: str) -> str | None:
    value = clean_value(params, name)
    if value:
        date.fromisoformat(value)
    return value


def usage_filters(params: dict[str, list[str]], include_customer=True,
                  skip: str | None = None):
    """WHERE clause for the current selection state.

    `skip` omits one dimension's own selection — the associative panel
    (/api/filters) needs sibling values within a field to stay selectable.
    """
    clauses = ["1 = 1"]
    values: list[str] = []
    start = date_value(params, "date_from")
    end = date_value(params, "date_to")
    event_type = enum_values(params, "event_type", EVENT_TYPES)
    region = enum_values(params, "region", REGIONS)
    plan = enum_values(params, "plan", PLANS)
    city = enum_values(params, "city", CITIES)
    tower = identifier_values(params, "tower", r"TWR-[0-9]{4}")
    subscriber = identifier_values(params, "subscriber", r"SUB-[0-9]{6}")
    if start:
        clauses.append("f.event_ts >= %s::date")
        values.append(start)
    if end:
        clauses.append("f.event_ts < %s::date + interval '1 day'")
        values.append(end)
    if skip != "event_type":
        in_clause(clauses, values, "f.event_type", event_type)
    if skip != "region":
        in_clause(clauses, values, "t.region", region)
    if include_customer and skip != "plan":
        in_clause(clauses, values, "s.plan_type", plan)
    if include_customer and skip != "city":
        in_clause(clauses, values, "s.city", city)
    if skip != "tower":
        in_clause(clauses, values, "t.cell_tower_id", tower)
    if include_customer and skip != "subscriber":
        in_clause(clauses, values, "s.subscriber_id", subscriber)
    return " AND ".join(clauses), values


def subscriber_filters(params: dict[str, list[str]]):
    clauses = ["1 = 1"]
    values: list[str] = []
    in_clause(clauses, values, "s.plan_type", enum_values(params, "plan", PLANS))
    in_clause(clauses, values, "s.city", enum_values(params, "city", CITIES))
    in_clause(
        clauses,
        values,
        "s.subscriber_id",
        identifier_values(params, "subscriber", r"SUB-[0-9]{6}"),
    )
    return " AND ".join(clauses), values


def plan_data_filters(params: dict[str, list[str]]):
    """Return fact join filters for plan-level data usage.

    Date predicates stay in the LEFT JOIN so subscribers with no data events
    remain in the denominator, matching the Metabase plan-consumption card.
    """
    clauses = ["f.subscriber_key = s.subscriber_key", "f.event_type = 'data'"]
    values: list[str] = []
    start = date_value(params, "date_from")
    end = date_value(params, "date_to")
    if start:
        clauses.append("f.event_ts >= %s::date")
        values.append(start)
    if end:
        clauses.append("f.event_ts < %s::date + interval '1 day'")
        values.append(end)
    return " AND ".join(clauses), values


def granularity_value(params) -> str:
    value = clean_value(params, "granularity") or "hour"
    if value not in {"hour", "day"}:
        raise ValueError("Invalid granularity")
    return value


def metric_filters(params: dict[str, list[str]]):
    clauses = ["1 = 1"]
    values: list[str] = []
    start = date_value(params, "date_from")
    end = date_value(params, "date_to")
    if start:
        clauses.append("m.run_start >= %s::date")
        values.append(start)
    if end:
        clauses.append("m.run_start < %s::date + interval '1 day'")
        values.append(end)
    return " AND ".join(clauses), values


def cross_choice(params, name: str, allowed: dict, default: str | None = None):
    value = clean_value(params, name)
    if value is None:
        return default
    if value not in allowed:
        raise ValueError(f"Invalid {name}")
    return value


def cross_payload(params: dict[str, list[str]]):
    """Aggregate a selected metric across one or two chosen dimensions.

    Column and aggregate expressions come only from server-side whitelists;
    user selections and the result limit remain regular query parameters.
    """
    dimension = cross_choice(params, "dimension", CROSS_DIMENSIONS, "region")
    split_by = cross_choice(params, "split_by", CROSS_DIMENSIONS)
    metric = cross_choice(params, "metric", CROSS_METRICS, "events")
    if split_by == dimension:
        raise ValueError("split_by must differ from dimension")
    try:
        limit = int(clean_value(params, "limit") or "10")
    except ValueError as error:
        raise ValueError("Invalid limit") from error
    if limit < 3 or limit > 20:
        raise ValueError("Invalid limit")

    dimension_column, dimension_label = CROSS_DIMENSIONS[dimension]
    metric_expression, metric_label = CROSS_METRICS[metric]
    split_column = CROSS_DIMENSIONS[split_by][0] if split_by else None
    split_label = CROSS_DIMENSIONS[split_by][1] if split_by else None
    split_select = f"{split_column}::text" if split_column else "'All'::text"
    split_group = ", 2" if split_column else ""
    where, values = usage_filters(params)
    joins = """
        FROM dwh.fact_usage_events AS f
        JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
        JOIN dwh.dim_subscriber AS s ON s.subscriber_key = f.subscriber_key
    """
    with connect() as connection, connection.cursor() as cursor:
        rows = many(
            cursor,
            f"""
            WITH grouped AS (
                SELECT {dimension_column}::text AS dimension_value,
                       {split_select} AS series_value,
                       {metric_expression} AS metric_value
                {joins}
                WHERE {where}
                GROUP BY 1{split_group}
            ), ranked_dimensions AS (
                SELECT {dimension_column}::text AS dimension_value,
                       {metric_expression} AS total_value
                {joins}
                WHERE {where}
                GROUP BY 1
                ORDER BY total_value DESC, dimension_value
                LIMIT %s
            )
            SELECT g.dimension_value, g.series_value, g.metric_value,
                   r.total_value
            FROM grouped AS g
            JOIN ranked_dimensions AS r USING (dimension_value)
            ORDER BY r.total_value DESC, g.dimension_value, g.metric_value DESC,
                     g.series_value
            """,
            [*values, *values, limit],
        )
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dimension": dimension,
        "dimension_label": dimension_label,
        "split_by": split_by,
        "split_label": split_label,
        "metric": metric,
        "metric_label": metric_label,
        "limit": limit,
        "rows": rows,
    }


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
                m.run_start AS latest_interval
            FROM dwh.etl_interval_metrics AS m
            WHERE {metric_where}
            ORDER BY m.run_start DESC
            LIMIT 1
            """,
            metric_values,
        )
        grain = granularity_value(params)
        traffic_trend = many(
            cursor,
            f"""
            SELECT date_trunc('{grain}', f.event_ts) AS hour_utc,
                   f.event_type, count(*) AS event_count
            {joins}
            WHERE {where}
            GROUP BY 1, 2
            ORDER BY 1, 2
            """,
            values,
        )
        heatmap = many(
            cursor,
            f"""
            SELECT extract(isodow FROM f.event_ts)::int AS day_of_week,
                   extract(hour FROM f.event_ts)::int AS hour_of_day,
                   count(*) AS event_count
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
            SELECT m.run_start AS interval_start,
                   round(100.0 * m.quarantine_rate::numeric, 2) AS rate_pct,
                   m.raw_rows, m.quarantine_rows, m.fact_rows
            FROM dwh.etl_interval_metrics AS m
            WHERE {metric_where}
            ORDER BY m.run_start
            """,
            metric_values,
        )
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "granularity": grain,
        "kpis": {**kpis, **latest_quality},
        "traffic_trend": traffic_trend,
        "heatmap": heatmap,
        "regions": regions,
        "service_mix": service_mix,
        "towers": towers,
        "top_towers": towers[:10],
        "quarantine": quarantine,
    }


FILTER_FIELDS = {
    "event_type": ("f.event_type", EVENT_TYPES),
    "region": ("t.region", REGIONS),
    "plan": ("s.plan_type", PLANS),
    "city": ("s.city", CITIES),
}

SEARCHABLE_FIELDS = {
    "tower": ("t.cell_tower_id", "Tower"),
    "subscriber": ("s.subscriber_id", "Subscriber"),
}


def filters_payload(params: dict[str, list[str]]):
    """Associative model: per field, every value with its event count under the
    rest of the selection (the field's own selection excluded, so sibling
    values stay selectable — Qlik's white/green/grey states)."""
    joins = """
        FROM dwh.fact_usage_events AS f
        JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
        JOIN dwh.dim_subscriber AS s ON s.subscriber_key = f.subscriber_key
    """
    fields = {}
    with connect() as connection, connection.cursor() as cursor:
        for name, (column, allowed) in FILTER_FIELDS.items():
            where, values = usage_filters(params, skip=name)
            rows = many(
                cursor,
                f"""
                SELECT {column} AS value, count(*) AS event_count
                {joins}
                WHERE {where}
                GROUP BY 1
                ORDER BY event_count DESC
                """,
                values,
            )
            counts = {row["value"]: row["event_count"] for row in rows}
            selected = enum_values(params, name, allowed)
            fields[name] = [
                {
                    "value": value,
                    "event_count": counts.get(value, 0),
                    "selected": value in selected,
                    "possible": counts.get(value, 0) > 0,
                }
                for value in sorted(allowed)
            ]
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "fields": fields,
    }


def values_payload(params: dict[str, list[str]]):
    """Search high-cardinality associative dimensions without returning all values."""
    field = clean_value(params, "field")
    if field not in SEARCHABLE_FIELDS:
        raise ValueError("Invalid field")
    query = clean_value(params, "q") or ""
    if len(query) > 64:
        raise ValueError("Invalid q")
    try:
        limit = int(clean_value(params, "limit") or "30")
    except ValueError as error:
        raise ValueError("Invalid limit") from error
    if limit < 1 or limit > 100:
        raise ValueError("Invalid limit")
    column, label = SEARCHABLE_FIELDS[field]
    where, values = usage_filters(params, skip=field)
    if query:
        where += f" AND {column} ILIKE %s"
        values.append(f"%{query}%")
    joins = """
        FROM dwh.fact_usage_events AS f
        JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
        JOIN dwh.dim_subscriber AS s ON s.subscriber_key = f.subscriber_key
    """
    with connect() as connection, connection.cursor() as cursor:
        rows = many(
            cursor,
            f"""
            SELECT {column}::text AS value, count(*) AS event_count
            {joins}
            WHERE {where}
            GROUP BY 1
            ORDER BY event_count DESC, value
            LIMIT %s
            """,
            [*values, limit],
        )
    selected = identifier_values(
        params,
        field,
        r"TWR-[0-9]{4}" if field == "tower" else r"SUB-[0-9]{6}",
    )
    for row in rows:
        row["selected"] = row["value"] in selected
        row["possible"] = row["event_count"] > 0
    return {"field": field, "label": label, "query": query, "rows": rows}


def customer_payload(params: dict[str, list[str]]):
    where, values = usage_filters(params)
    subscriber_where, subscriber_values = subscriber_filters(params)
    plan_join, plan_date_values = plan_data_filters(params)
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
        plan_data = many(
            cursor,
            f"""
            WITH subscriber_data AS (
                SELECT s.subscriber_key, s.plan_type,
                       sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0))
                           / 1048576.0 AS data_mb
                FROM dwh.dim_subscriber AS s
                LEFT JOIN dwh.fact_usage_events AS f ON {plan_join}
                WHERE {subscriber_where}
                GROUP BY s.subscriber_key, s.plan_type
            )
            SELECT plan_type,
                   round(avg(data_mb), 2) AS avg_mb_per_subscriber,
                   round(sum(data_mb), 2) AS total_data_mb,
                   count(*) AS subscriber_count
            FROM subscriber_data
            GROUP BY plan_type
            ORDER BY avg_mb_per_subscriber DESC, plan_type
            """,
            [*plan_date_values, *subscriber_values],
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
        "plan_data": plan_data,
        "cities": cities,
        "weekday": weekday,
        "top_subscribers": top_subscribers,
    }


def catalog_payload():
    return {
        "version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "engine": {
            "name": "Orange Associative Analytics",
            "chart_library": "Apache ECharts 6.1",
            "cache_ttl_seconds": CACHE_TTL_SECONDS,
            "connection_pool": ConnectionPool is not None,
        },
        **ANALYTICS_CATALOG,
    }


def system_payload():
    with _cache_lock:
        cache = {**_cache_stats, "entries": len(_cache), "ttl_seconds": CACHE_TTL_SECONDS}
    requests = cache["hits"] + cache["misses"]
    cache["hit_rate_pct"] = round(cache["hits"] / requests * 100, 1) if requests else 0
    return {
        "status": "ok",
        "cache": cache,
        "pool": {"enabled": ConnectionPool is not None, "max_size": 8},
        "time_utc": datetime.now(timezone.utc).isoformat(),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def json_response(self, payload, status=HTTPStatus.OK, *, cache_status=None,
                      duration_ms=None):
        body = json.dumps(payload, default=json_default).encode("utf-8")
        compressed = "gzip" in self.headers.get("Accept-Encoding", "") and len(body) > 1024
        if compressed:
            body = gzip.compress(body, compresslevel=5)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Vary", "Accept-Encoding")
        if compressed:
            self.send_header("Content-Encoding", "gzip")
        if cache_status:
            self.send_header("X-Analytics-Cache", cache_status)
        if duration_ms is not None:
            self.send_header("Server-Timing", f"analytics;dur={duration_ms:.1f}")
        self.end_headers()
        self.wfile.write(body)

    def analytics_response(self, parsed, factory):
        params = parse_qs(parsed.query)
        key = f"{parsed.path}:{json.dumps(params, sort_keys=True, separators=(',', ':'))}"
        started = time.perf_counter()
        payload = cache_get(key)
        cache_status = "HIT" if payload is not None else "MISS"
        if payload is None:
            payload = factory(params)
            cache_set(key, payload)
        self.json_response(
            payload,
            cache_status=cache_status,
            duration_ms=(time.perf_counter() - started) * 1000,
        )

    def do_GET(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/health":
                self.json_response({"status": "ok"})
                return
            if parsed.path == "/api/catalog":
                self.json_response(catalog_payload())
                return
            if parsed.path == "/api/system":
                self.json_response(system_payload())
                return
            if parsed.path == "/api/network":
                self.analytics_response(parsed, network_payload)
                return
            if parsed.path == "/api/customers":
                self.analytics_response(parsed, customer_payload)
                return
            if parsed.path == "/api/filters":
                self.analytics_response(parsed, filters_payload)
                return
            if parsed.path == "/api/cross":
                self.analytics_response(parsed, cross_payload)
                return
            if parsed.path == "/api/values":
                self.analytics_response(parsed, values_payload)
                return
        except (ValueError, KeyError) as error:
            self.json_response({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        except ((psycopg.Error, PoolTimeout, RuntimeError) if psycopg else RuntimeError):
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
