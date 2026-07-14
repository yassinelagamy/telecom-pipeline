# Phase 2: hourly PySpark ETL

`usage_etl.py` processes exactly one UTC hour. It reads gzip NDJSON from the
frozen raw path, overwrites that hour's quarantine output, resolves warehouse
dimension keys, then deletes and reloads the corresponding fact partition.

The Spark 3.5 submission needs the S3A and Postgres JDBC connectors. The Hadoop
AWS version must match the Hadoop client bundled with the chosen Spark image;
Spark 3.5.0's standard Hadoop 3 distribution uses the following coordinates:

```bash
spark-submit \
  --packages org.apache.hadoop:hadoop-aws:3.3.4,org.postgresql:postgresql:42.7.3 \
  etl/usage_etl.py --run-hour 2026-07-14T09:00:00Z
```

Runtime configuration is read from the existing `.env` names:

- `MINIO_ENDPOINT`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_BUCKET`
- `DWH_POSTGRES_HOST`, `DWH_POSTGRES_PORT`, `DWH_POSTGRES_DB`
- `DWH_POSTGRES_USER`, `DWH_POSTGRES_PASSWORD`
- Optional: `DWH_JDBC_URL`, `ETL_OUTPUT_PARTITIONS`

The process prints one machine-readable line prefixed with `ETL_METRICS`. A
dimension miss fails the run before the delete, preserving the previously
loaded fact partition.

Run the transformation tests from the repository root:

```bash
python -m pytest -q etl/tests
```

## Real-service integration check

The integration overlay uses the running MinIO service, an ephemeral Postgres
warehouse seeded to the frozen dimension contract, and the official Spark
3.5.1 Python image. It does not modify the main Compose file or its volumes.

```bash
docker compose -f docker-compose.yml \
  -f etl/tests/integration/docker-compose.yml up -d postgres-dwh

docker compose -f docker-compose.yml \
  -f etl/tests/integration/docker-compose.yml run --rm spark-etl \
  --run-hour 2026-07-14T09:00:00Z
```

Run the second command again for the idempotency check. `inserted_fact_rows`
must remain constant and `deleted_fact_rows` on the second run must equal it.

Against the production Compose warehouse, use the runner-only overlay:

```bash
docker compose -f docker-compose.yml \
  -f etl/docker-compose.runner.yml run --rm spark-etl \
  --run-hour 2026-07-14T09:00:00Z
```
