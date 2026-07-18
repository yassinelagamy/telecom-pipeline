"""ten_minute_usage_etl — generate and process one ten-minute UTC interval.

generate_usage_logs -> wait_for_raw_files -> run_usage_etl -> data_quality_checks

Contracts: SCHEMAS.md (paths, idempotency) and etl/README.md (ETL CLI).
The interval processed is the DAG run's data_interval_start (UTC).
"""

from __future__ import annotations

import gzip
import io
import os
import sys
import tempfile
from datetime import timedelta

import pendulum
from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.providers.apache.spark.operators.spark_submit import SparkSubmitOperator
from airflow.sensors.python import PythonSensor

BUCKET = os.getenv("MINIO_BUCKET", "telecom-lake")
MAX_QUARANTINE_RATE = 0.05
SPARK_PACKAGES = "org.apache.hadoop:hadoop-aws:3.3.4,org.postgresql:postgresql:42.7.3"
INTERVAL_MINUTES = 10


def _s3():
    import boto3
    from botocore.client import Config

    return boto3.client(
        "s3",
        endpoint_url=os.environ["MINIO_ENDPOINT"],
        aws_access_key_id=os.environ["MINIO_ROOT_USER"],
        aws_secret_access_key=os.environ["MINIO_ROOT_PASSWORD"],
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )


def _interval_prefix(root: str, start: pendulum.DateTime) -> str:
    return (f"{root}/usage_logs/date={start.strftime('%Y-%m-%d')}/"
            f"hour={start.strftime('%H')}/minute={start.strftime('%M')}/")


def _count_gzip_lines(s3, prefix: str) -> int:
    total = 0
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            if not obj["Key"].endswith(".gz"):
                continue
            body = s3.get_object(Bucket=BUCKET, Key=obj["Key"])["Body"].read()
            with gzip.open(io.BytesIO(body), "rt", encoding="utf-8") as f:
                total += sum(1 for line in f if line.strip())
    return total


def generate_usage_logs(data_interval_start: pendulum.DateTime, **_) -> None:
    """Generate and idempotently upload this DAG run's ten-minute batch."""
    sys.path.insert(0, "/opt/airflow/generator")
    from generate import generate_interval, write_interval_file
    from upload import upload_file

    events = int(os.getenv("GEN_EVENTS_PER_10_MINUTES", "1667"))
    malformed_rate = float(os.getenv("GEN_MALFORMED_RATE", "0.02"))
    subscribers = int(os.getenv("GEN_NUM_SUBSCRIBERS", "5000"))
    towers = int(os.getenv("GEN_NUM_TOWERS", "200"))
    start = data_interval_start.in_timezone("UTC")

    lines = generate_interval(
        start, INTERVAL_MINUTES, events, malformed_rate, subscribers, towers
    )
    with tempfile.TemporaryDirectory() as tmp:
        path = write_interval_file(start, lines, tmp)
        uri = upload_file(path, start, BUCKET)
    print(f"generated {len(lines)} events for {start.isoformat()} -> {uri}")


def raw_files_present(data_interval_start: pendulum.DateTime, **_) -> bool:
    prefix = _interval_prefix("raw", data_interval_start)
    resp = _s3().list_objects_v2(Bucket=BUCKET, Prefix=prefix, MaxKeys=1)
    found = resp.get("KeyCount", 0) > 0
    print(f"sensor: s3://{BUCKET}/{prefix} -> {'found' if found else 'missing'}")
    return found


def data_quality_checks(data_interval_start: pendulum.DateTime, **_) -> None:
    """Fail if the interval is empty, has null FKs, or quarantine is >= 5%.

    On success, upserts interval metrics into dwh.etl_hourly_metrics
    (additive ops table, see SCHEMAS.md) for the quarantine-rate dashboard.
    """
    import psycopg2

    start = data_interval_start
    end = start.add(minutes=INTERVAL_MINUTES)
    conn = psycopg2.connect(
        host=os.environ["DWH_POSTGRES_HOST"],
        port=os.environ.get("DWH_POSTGRES_PORT", "5432"),
        dbname=os.environ["DWH_POSTGRES_DB"],
        user=os.environ["DWH_POSTGRES_USER"],
        password=os.environ["DWH_POSTGRES_PASSWORD"],
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT count(*),
                          count(*) FILTER (WHERE subscriber_key IS NULL
                                              OR tower_key IS NULL
                                              OR date_key IS NULL)
                   FROM dwh.fact_usage_events
                   WHERE event_ts >= %s AND event_ts < %s""",
                (start.isoformat(), end.isoformat()),
            )
            fact_rows, null_fks = cur.fetchone()

        if fact_rows == 0:
            raise ValueError(f"DQ fail: 0 fact rows for interval {start.isoformat()}")
        if null_fks:
            raise ValueError(f"DQ fail: {null_fks} fact rows with null dimension keys")

        s3 = _s3()
        raw_rows = _count_gzip_lines(s3, _interval_prefix("raw", start))
        quarantine_rows = _count_gzip_lines(s3, _interval_prefix("quarantine", start))
        rate = quarantine_rows / raw_rows if raw_rows else 1.0
        if rate >= MAX_QUARANTINE_RATE:
            raise ValueError(
                f"DQ fail: quarantine rate {rate:.2%} >= {MAX_QUARANTINE_RATE:.0%} "
                f"({quarantine_rows}/{raw_rows})")

        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO dwh.etl_hourly_metrics
                       (run_hour, raw_rows, quarantine_rows, quarantine_rate, fact_rows)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (run_hour) DO UPDATE SET
                       raw_rows = EXCLUDED.raw_rows,
                       quarantine_rows = EXCLUDED.quarantine_rows,
                       quarantine_rate = EXCLUDED.quarantine_rate,
                       fact_rows = EXCLUDED.fact_rows,
                       load_ts = now()""",
                (start.isoformat(), raw_rows, quarantine_rows, rate, fact_rows),
            )
        conn.commit()
    finally:
        conn.close()

    print(f"DQ ok: fact_rows={fact_rows} null_fks=0 "
          f"quarantine={quarantine_rows}/{raw_rows} ({rate:.2%}) — metrics upserted")


default_args = {
    "owner": "dev-a",
    "retries": 2,
    "retry_delay": timedelta(minutes=1),
    "retry_exponential_backoff": True,
    "max_retry_delay": timedelta(minutes=5),
    # Email stub: flips on once SMTP is configured in the environment (Phase 4+).
    "email": ["alerts@example.com"],
    "email_on_failure": True,
}

with DAG(
    dag_id="ten_minute_usage_etl",
    description="Every 10 minutes: generate -> MinIO -> Spark -> Postgres DWH",
    schedule="*/10 * * * *",
    start_date=pendulum.datetime(2026, 7, 17, 0, 0, tz="UTC"),
    catchup=False,
    is_paused_upon_creation=False,
    max_active_runs=1,
    dagrun_timeout=timedelta(minutes=30),
    default_args=default_args,
    tags=["telecom", "etl"],
) as dag:

    generate_batch = PythonOperator(
        task_id="generate_usage_logs",
        python_callable=generate_usage_logs,
    )

    wait_for_raw_files = PythonSensor(
        task_id="wait_for_raw_files",
        python_callable=raw_files_present,
        mode="reschedule",
        poke_interval=15,
        timeout=60 * 5,
    )

    run_usage_etl = SparkSubmitOperator(
        task_id="run_usage_etl",
        application="/opt/airflow/etl/usage_etl.py",
        conn_id="spark_local",
        packages=SPARK_PACKAGES,
        application_args=[
            "--run-start",
            "{{ data_interval_start.strftime('%Y-%m-%dT%H:%M:00Z') }}",
        ],
        conf={"spark.ui.enabled": "false"},
        verbose=False,
    )

    dq_checks = PythonOperator(
        task_id="data_quality_checks",
        python_callable=data_quality_checks,
    )

    generate_batch >> wait_for_raw_files >> run_usage_etl >> dq_checks
