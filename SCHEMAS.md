# SCHEMAS.md — Frozen Data Contracts (v1.0)

> **Status: FROZEN after Day 1.** Any change requires agreement from both
> developers (A + B) and a PR that updates this file, the generator, the ETL,
> and the DDL in the same change.

---

## 1. Raw log schema (NDJSON, one object per line, gzip)

Produced by `generator/`, consumed by `etl/usage_etl.py`.

| Field | Type | Nullability | Notes |
|-------|------|-------------|-------|
| `event_id` | string (uuid4) | required | Primary key downstream |
| `subscriber_id` | string | required | Format `SUB-000123` (6-digit, zero-padded) |
| `event_type` | string enum | required | `voice` \| `sms` \| `data` |
| `cell_tower_id` | string | required | Format `TWR-0042` (4-digit, zero-padded) |
| `event_ts` | string (ISO-8601 UTC) | required | e.g. `2026-07-14T09:15:32Z` — **always UTC (D8)** |
| `duration_sec` | int | voice only, else `null` | > 0 |
| `sms_count` | int | sms only, else `null` | > 0 (usually 1) |
| `bytes_up` | long | data only, else `null` | >= 0 |
| `bytes_down` | long | data only, else `null` | >= 0 |

Example:

```json
{"event_id":"9b2f0c1e-6c1a-4b6e-9f3e-1a2b3c4d5e6f","subscriber_id":"SUB-000123","event_type":"voice","cell_tower_id":"TWR-0042","event_ts":"2026-07-14T09:15:32Z","duration_sec":120,"sms_count":null,"bytes_up":null,"bytes_down":null}
```

**Malformed rows:** ~2% of generated rows are intentionally malformed
(missing required fields, unparseable timestamps, negative values, wrong
event_type). The ETL must route these to the quarantine prefix (D7), never
drop them silently.

### Validation rules (what makes a row "good")

1. All required fields present and non-null.
2. `event_type` in (`voice`, `sms`, `data`).
3. `event_ts` parses as ISO-8601 UTC.
4. Metric matching the event type is present and non-negative;
   metrics for other event types are null.
5. `subscriber_id` / `cell_tower_id` match their formats. (Unknown-but-valid
   IDs are *not* quarantined; they just fail the dim join and get flagged in
   the DQ task.)

---

## 2. Data-lake path conventions (MinIO, bucket `telecom-lake`)

```
raw/usage_logs/date=YYYY-MM-DD/hour=HH/part-*.json.gz
quarantine/usage_logs/date=YYYY-MM-DD/hour=HH/
```

`date`/`hour` are the **UTC event hour**, not the load time.

---

## 3. Warehouse schema (Postgres `telecom_dwh`, schema `dwh`)

```sql
dwh.dim_subscriber (
    subscriber_key   BIGSERIAL PRIMARY KEY,
    subscriber_id    TEXT UNIQUE NOT NULL,
    plan_type        TEXT NOT NULL,          -- e.g. prepaid | postpaid | business
    city             TEXT NOT NULL,
    activation_date  DATE NOT NULL,
    is_active        BOOLEAN NOT NULL DEFAULT true
);

dwh.dim_tower (
    tower_key        BIGSERIAL PRIMARY KEY,
    cell_tower_id    TEXT UNIQUE NOT NULL,
    region           TEXT NOT NULL,
    latitude         DOUBLE PRECISION NOT NULL,
    longitude        DOUBLE PRECISION NOT NULL
);

dwh.dim_date (
    date_key         INT PRIMARY KEY,        -- YYYYMMDD
    full_date        DATE UNIQUE NOT NULL,
    year             INT NOT NULL,
    month            INT NOT NULL,
    day              INT NOT NULL,
    day_of_week      INT NOT NULL,           -- ISO: 1=Mon .. 7=Sun
    is_weekend       BOOLEAN NOT NULL
);

dwh.fact_usage_events (
    event_id         UUID PRIMARY KEY,
    subscriber_key   BIGINT NOT NULL REFERENCES dwh.dim_subscriber(subscriber_key),
    tower_key        BIGINT NOT NULL REFERENCES dwh.dim_tower(tower_key),
    date_key         INT    NOT NULL REFERENCES dwh.dim_date(date_key),
    event_ts         TIMESTAMPTZ NOT NULL,
    event_type       TEXT NOT NULL,
    duration_sec     INT,
    sms_count        INT,
    bytes_up         BIGINT,
    bytes_down       BIGINT,
    load_ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON dwh.fact_usage_events (event_ts);
CREATE INDEX ON dwh.fact_usage_events (subscriber_key);
CREATE INDEX ON dwh.fact_usage_events (tower_key);
```

Seed volumes: **5,000 subscribers**, **200 towers**,
`dim_date` covering **2025-01-01 → 2027-12-31**.

### Additive operational table (agreed Dev A + Dev B, 2026-07-14)

Not part of the analytical star schema; written by the DAG's data-quality
task each run (upsert on `run_hour`, so reruns stay idempotent). Feeds the
quarantine-rate dashboard card.

```sql
dwh.etl_hourly_metrics (
    run_hour TIMESTAMPTZ PRIMARY KEY,
    raw_rows INT, quarantine_rows INT, quarantine_rate DOUBLE PRECISION,
    fact_rows INT, load_ts TIMESTAMPTZ DEFAULT now()
)
```

---

## 4. Idempotency contract (D6)

For each DAG run covering hour `H`:

```sql
DELETE FROM dwh.fact_usage_events
WHERE event_ts >= 'H' AND event_ts < 'H + 1 hour';
```

…then insert the freshly transformed rows. A rerun of any hour must produce
zero duplicate rows.

---

## 5. Fixed names & ports (reference)

| Component | Value |
|-----------|-------|
| MinIO bucket | `telecom-lake` |
| Postgres DB / schema | `telecom_dwh` / `dwh` |
| DAG id | `hourly_usage_etl` (`@hourly`, catchup=True, max_active_runs=1) |
| Ports | MinIO 9000/9001 · Airflow 8080 · Postgres 5432 · Metabase 3000 · Spark UI 4040 |
