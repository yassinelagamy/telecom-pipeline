# Telecom Usage Data Pipeline

End-to-end batch pipeline: simulated telecom usage logs → MinIO data lake →
hourly PySpark ETL (orchestrated by Airflow) → Postgres star-schema DWH →
Metabase dashboards.

```
Log Generator ──> MinIO (raw)  ──> PySpark ETL ──> Postgres DWH ──> Metabase
                       ▲                │
                       └── Airflow (hourly DAG) ──┘
```

## Quick start

```bash
cp .env.example .env      # edit passwords
docker compose up -d
```

| Service | URL |
|---------|-----|
| MinIO console | http://localhost:9001 |
| Airflow | http://localhost:8080 |
| Postgres | localhost:5432 (`telecom_dwh`) |
| Metabase | http://localhost:3000 |

Contracts (raw log schema, path conventions, DWH schema) live in
[SCHEMAS.md](SCHEMAS.md) and are **frozen** — see that file before changing
anything data-shaped.

## Layout

```
generator/       Dev A — log generator + MinIO uploader
etl/             Shared — PySpark job (Phase 2)
airflow/dags/    Dev A — hourly DAG
dwh/             Dev B — DDL + seed scripts
dashboards/      Dev B — SQL + Metabase exports
docs/            screenshots, architecture diagram
```

*(Full setup, backfill, and dashboard docs land in Phase 4.)*
