# Telecom Usage Data Pipeline

End-to-end telecom analytics pipeline: **10-minute event generation → MinIO data lake → Airflow-orchestrated PySpark ETL → star-schema Postgres warehouse → Orange Egypt analytics frontend + Metabase**.

```
Log Generator ──> MinIO (raw)  ──> PySpark ETL ──> Postgres DWH ──> Metabase
                       ▲                │
                       └── Airflow (every 10 minutes) ──┘
```

## Architecture

| Layer | Tech | Purpose |
|-------|------|---------|
| **Data Lake** | MinIO (S3-compatible) | Raw NDJSON logs partitioned into UTC 10-minute windows |
| **Orchestration** | Airflow 2.9.3 | 10-minute generation, ETL runs, and quality gates |
| **Transform** | PySpark 3.5.1 | Validates raw logs → quarantines malformed → joins dims → loads facts |
| **Warehouse** | Postgres 16 | 3-dim star schema + operational metrics table |
| **Analytics** | Orange frontend + Metabase 0.62.4 | Branded operations interface plus analyst authoring |

## Quick start

Clone, set up environment, and boot the stack:

```bash
cd telecom-pipeline
cp .env.example .env
docker compose up -d
```

Services come up on:

| Service | URL | Credentials |
|---------|-----|-------------|
| **MinIO console** | http://localhost:9001 | admin / (from `.env`) |
| **Airflow** | http://localhost:8080 | admin / (from `.env`) |
| **Orange analytics** | http://localhost:8088 | Custom live operations interface |
| **Metabase** | http://localhost:3000 | auto-initialized |
| **Postgres** | localhost:5432 | dwh_user / (from `.env`) |

Data is seeded on startup:
- **MinIO:** 48 hours of historical logs (2026-07-12T07 → 2026-07-14T06)
- **Postgres:** 5,000 subscribers, 200 towers, ~1,100 dates; idempotent DDL
- **Metabase:** pre-provisioned dashboards querying live warehouse data

## Live 10-minute operation

Airflow runs `ten_minute_usage_etl` every 10 minutes. Each run generates a
new batch of voice, SMS, and data events, uploads it to MinIO, validates and
quarantines records with PySpark, loads PostgreSQL, and records data-quality
metrics. The DAG uses `catchup=False`, so it starts with the next live interval.

```bash
docker compose exec airflow-scheduler airflow dags unpause ten_minute_usage_etl
docker compose exec airflow-scheduler airflow dags list-runs -d ten_minute_usage_etl
```

The task flow is `generate_usage_logs -> wait_for_raw_files -> run_usage_etl
-> data_quality_checks`. Raw and quarantine paths use
`date=YYYY-MM-DD/hour=HH/minute=MM` partitions. Rerunning an interval replaces
only that interval, so no duplicate facts are produced.

## Legacy hourly backfill

The standalone generator can still create historical hour-sized files when
needed. Live processing is handled only by `ten_minute_usage_etl`.

```bash
docker compose run --rm generator backfill.py --hours 48
```

## Data contracts (frozen)

Three frozen contracts ensure schema stability across all four teams/phases:

### 1. Raw log schema (NDJSON, gzip)

One JSON object per line, UTC timestamps, ~2% intentionally malformed rows. See [SCHEMAS.md](SCHEMAS.md) for the complete contract including validation rules and examples.

| Field | Type | Notes |
|-------|------|-------|
| `event_id` | uuid | Primary key |
| `subscriber_id` | string | Format `SUB-000123` |
| `event_type` | enum: `voice\|sms\|data` | Determines metric field |
| `cell_tower_id` | string | Format `TWR-0042` |
| `event_ts` | ISO-8601 UTC | Always UTC |
| `duration_sec` / `sms_count` / `bytes_up,down` | metric | One per event type, rest null |

Raw logs land in `raw/usage_logs/date=YYYY-MM-DD/hour=HH/minute=MM/part-*.json.gz`; malformed rows go to the matching `quarantine/usage_logs/...` partition for auditability.

### 2. Warehouse schema (star, idempotent)

3 dimensions (subscriber, tower, date) + 1 fact (usage events) + 1 ops table (ETL metrics):

```sql
dwh.dim_subscriber (subscriber_key PK, subscriber_id UNIQUE, plan_type, city, activation_date, is_active)
dwh.dim_tower      (tower_key PK, cell_tower_id UNIQUE, region, lat, lon)
dwh.dim_date       (date_key PK, full_date, year, month, day, day_of_week, is_weekend)
dwh.fact_usage_events (event_id PK, subscriber_key FK, tower_key FK, date_key FK,
                        event_ts, event_type, duration_sec, sms_count, bytes_up/down, load_ts)
dwh.etl_hourly_metrics (run_hour PK, raw_rows, quarantine_rows, quarantine_rate, fact_rows, load_ts)
```

All DDL is idempotent (CREATE TABLE IF NOT EXISTS, ON CONFLICT for upserts); safe to re-run. Full schema in [SCHEMAS.md](SCHEMAS.md) and [dwh/ddl.sql](dwh/ddl.sql).

### 3. Operational idempotency

Each DAG run idempotently:

```sql
DELETE FROM dwh.fact_usage_events WHERE event_ts >= :hour AND event_ts < :hour+1 hour;
INSERT INTO dwh.fact_usage_events (...) SELECT * FROM validated_data;
```

Re-running the same 10-minute interval produces zero duplicates. Testing: [etl/tests/](etl/tests/).

## Dashboards & analytics

Two live Metabase dashboards auto-refresh every 10 minutes:

### Network Ops

Operational view for the NOC team:

- **Hourly traffic by event type** — stacked area chart (voice, SMS, data volume over time)
- **Top 10 towers by events** — bar chart with region annotations
- **Data usage per subscriber tier** — grouped by plan type (prepaid/postpaid/business)

### Subscriber Insights

User-facing analytics:

- **Quarantine rate trend** — line chart showing malformed row rate per hour (operational SLA)
- **Weekday vs. weekend usage** — side-by-side volume and bytes comparison
- **Top SMS usage by city** — regional breakdown for marketing

All queries live in [dashboards/](dashboards/) and are documented. Dashboards use `ON REFRESH` to stay current with each ETL run.

## Repository structure

```
telecom-pipeline/
├── docker-compose.yml        # 5-service stack (MinIO, Airflow, Postgres, Metabase, job utilities)
├── .env.example              # Copy to .env; all creds + env vars
├── SCHEMAS.md                # FROZEN contracts (raw schema, path conventions, DWH schema)
├── README.md                 # This file
│
├── generator/                # Dev A — log generation & backfill
│   ├── generate.py           # Deterministic NDJSON generator; ~2% malformed rows
│   ├── upload.py             # Boto3 uploader to MinIO raw path convention
│   ├── backfill.py           # Batch generate + upload N historical hours
│   ├── Dockerfile            # Lightweight Python image
│   └── requirements.txt       # boto3
│
├── etl/                      # Shared Phase 2 (Dev A + Dev B) — PySpark job
│   ├── usage_etl.py          # Main ETL: reads MinIO → validates → joins dims → writes fact
│   ├── README.md             # CLI interface, integration test guide
│   ├── tests/
│   │   ├── test_usage_etl.py # Unit tests for validation, quarantine, joins
│   │   └── integration/      # docker-compose.yml overlay for ephemeral E2E runs
│   └── requirements.txt
│
├── airflow/                  # Dev A — orchestration & DAG
│   ├── Dockerfile            # Airflow 2.9.3 + Java 17 + Spark 3.5.1
│   ├── dags/
│   │   └── ten_minute_usage_etl.py # Generate → sensor → Spark → DQ checks
│   └── logs/                 # Generated at runtime
│
├── dwh/                      # Dev B — warehouse + seeds
│   ├── ddl.sql               # Idempotent star schema + metrics table
│   ├── seed.py               # Generate 5k subscribers, 200 towers, 1k+ dates
│   └── tests/
│       └── test_dwh.py       # DDL idempotency, seed volumes
│
├── dashboards/               # Dev B — analytics SQL + Metabase definitions
│   ├── README.md             # Dashboard guide + query explanations
│   ├── *.sql                 # 5 analytical queries (Network Ops, Subscriber Insights)
│   ├── dashboard_definitions.json  # Metabase dashboard structure (exportable)
│   ├── provision_metabase.py       # Declarative dashboard + card provisioner
│   └── tests/
│       └── test_dashboards.py      # Query correctness against seeded data
│
└── docs/                     # Screenshots, architecture diagrams, runbooks
    └── [generated during Phase 4]
```

## Development & testing

Run the full test suite:

```bash
# Unit tests (generator, ETL, DWH, dashboards)
docker compose run --rm generator python -m pytest -q etl/tests dwh/tests dashboards/tests
```

Manual verification:

```bash
# Check MinIO bucket
docker compose exec minio mc ls -r local/telecom-lake | wc -l   # 48 partition files

# Inspect a raw log file
docker compose exec minio mc cat local/telecom-lake/raw/usage_logs/date=2026-07-12/hour=07/part-*.json.gz | gunzip | head -3 | python -m json.tool

# Query the DWH
docker compose exec postgres-dwh psql -U dwh_user -d telecom_dwh -c "SELECT count(*) FROM dwh.fact_usage_events"

# Check Airflow DAG status
docker compose exec airflow-scheduler airflow dags list-runs -d ten_minute_usage_etl -o plain
```

## Troubleshooting

**Airflow DAG paused or not visible:**

Ensure the DAG is unpaused and the scheduler is running:

```bash
docker compose exec airflow-scheduler airflow dags unpause ten_minute_usage_etl
docker compose logs airflow-scheduler | grep -i error
```

**Spark package resolution timeout:**

First run downloads hadoop-aws + JDBC from Maven (slow). Subsequent runs use a cached volume (`spark-ivy-cache`). If it fails:

```bash
docker volume rm telecom-pipeline_spark-ivy-cache
docker compose up -d  # Rebuilds volume
```

**Postgres connection refused:**

Check the container is healthy:

```bash
docker compose exec postgres-dwh pg_isready -U dwh_user -d telecom_dwh
```

**Metabase dashboards show no data:**

Metabase caches query results. Force refresh with the dashboard's "Refresh" button or clear the cache:

```bash
docker compose restart metabase
```

## Key decisions (see SCHEMAS.md for rationale)

| # | Topic | Decision |
|---|-------|----------|
| D1 | Raw log format | NDJSON (gzip), one object per line — splittable by Spark |
| D2 | BI tool | Metabase — faster setup, zero-config Postgres connector |
| D3 | Orchestrator | Airflow 2.9.3 (LocalExecutor) — industry standard, lightweight |
| D4 | Spark runtime | PySpark 3.5.1, `local[*]` inside Airflow container — no cluster needed |
| D5 | Warehouse model | Star schema (1 fact, 3 dims) — simple, dashboard-friendly |
| D6 | Idempotency | Delete-hour-partition-then-insert — safe reruns, no dedup logic |
| D7 | Malformed rows | Quarantine to `quarantine/` prefix — auditability, never silently dropped |
| D8 | Timezones | UTC everywhere; `TIMESTAMPTZ` in Postgres — eliminates timezone bugs |
| D9 | Secrets | `.env` (gitignored) + `.env.example` — no hardcoded creds |
| D10 | Git flow | Feature branches, PR + cross-review, `main` protected — team discipline |

## Acceptance criteria (sign-off checklist)

✅ `git clone` + `.env` + `docker compose up -d` brings up all services  
✅ Hourly DAG runs green and is idempotent on rerun  
✅ Malformed rows land in quarantine; quarantine rate visible on a dashboard  
✅ Both dashboards show data advancing hour over hour  
✅ README lets a newcomer run everything without asking questions  
✅ Repo tagged `v1.0`, pushed to GitHub, with screenshots in `docs/`  

## Team & timeline

**Project:** 10 working days | **Version:** 1.0

**Dev A (You):** Phases 0, 1 (MinIO + Airflow + generator + 48h backfill), 3 (DAG + DQ), 4 (this README + verification)

**Codex (Dev B):** Phases 1 (Postgres + Metabase + seeds), 2 (PySpark ETL), 4 (dashboards + analytics SQL)

**Shared:** Phase 2 ETL pairing; Phase 4 cross-review, tag, push

---

For detailed schema contracts, see [SCHEMAS.md](SCHEMAS.md).  
For ETL interface and testing, see [etl/README.md](etl/README.md).  
For dashboard queries and Metabase setup, see [dashboards/README.md](dashboards/README.md).
