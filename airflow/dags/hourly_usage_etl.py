"""hourly_usage_etl — orchestrates the Phase 2 PySpark job for one UTC hour.

wait_for_raw_files (sensor) -> run_usage_etl (spark-submit) -> data_quality_checks

Contracts: SCHEMAS.md (paths, idempotency) and etl/README.md (ETL CLI).
The hour processed is the DAG run's data_interval_start (UTC).
"""

from __future__ import annotations

import gzip
import io
import os
from datetime import timedelta

import pendulum
from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.providers.apache.spark.operators.spark_submit import SparkSubmitOperator
from airflow.sensors.python import PythonSensor

BUCKET = os.getenv("MINIO_BUCKET", "telecom-lake")
MAX_QUARANTINE_RATE = 0.05
SPARK_PACKAGES = "org.apache.hadoop:hadoop-aws:3.3.4,org.postgresql:postgresql:42.7.3"


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


def _hour_prefix(root: str, hour: pendulum.DateTime) -> str:
    return (f"{root}/usage_logs/date={hour.strftime('%Y-%m-%d')}/"
            f"hour={hour.strftime('%H')}/")


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


def raw_files_present(data_interval_start: pendulum.DateTime, **_) -> bool:
    prefix = _hour_prefix("raw", data_interval_start)
    resp = _s3().list_objects_v2(Bucket=BUCKET, Prefix=prefix, MaxKeys=1)
    found = resp.get("KeyCount", 0) > 0
    print(f"sensor: s3://{BUCKET}/{prefix} -> {'found' if found else 'missing'}")
    return found


def data_quality_checks(data_interval_start: pendulum.DateTime, **_) -> None:
    """Fail the run if: fact hour is empty, any FK is null, or quarantine >= 5%.

    On success, upserts the hour's metrics into dwh.etl_hourly_metrics
    (additive ops table, see SCHEMAS.md) for the quarantine-rate dashboard.
    """
    import psycopg2

    start = data_interval_start
    end = start.add(hours=1)
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
            raise ValueError(f"DQ fail: 0 fact rows for hour {start.isoformat()}")
        if null_fks:
            raise ValueError(f"DQ fail: {null_fks} fact rows with null dimension keys")

        s3 = _s3()
        raw_rows = _count_gzip_lines(s3, _hour_prefix("raw", start))
        quarantine_rows = _count_gzip_lines(s3, _hour_prefix("quarantine", start))
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
    "retry_delay": timedelta(minutes=2),
    "retry_exponential_backoff": True,
    "max_retry_delay": timedelta(minutes=20),
    # Email stub: flips on once SMTP is configured in the environment (Phase 4+).
    "email": ["alerts@example.com"],
    "email_on_failure": True,
}

with DAG(
    dag_id="hourly_usage_etl",
    description="Hourly telecom usage ETL: MinIO raw -> Spark -> Postgres DWH",
    schedule="@hourly",
    start_date=pendulum.datetime(2026, 7, 12, 7, tz="UTC"),  # first backfilled hour
    catchup=True,
    max_active_runs=1,
    dagrun_timeout=timedelta(hours=1),
    default_args=default_args,
    tags=["telecom", "etl"],
) as dag:

    wait_for_raw_files = PythonSensor(
        task_id="wait_for_raw_files",
        python_callable=raw_files_present,
        mode="reschedule",
        poke_interval=60,
        timeout=60 * 30,
    )

    run_usage_etl = SparkSubmitOperator(
        task_id="run_usage_etl",
        application="/opt/airflow/etl/usage_etl.py",
        conn_id="spark_local",
        packages=SPARK_PACKAGES,
        application_args=[
            "--run-hour",
            "{{ data_interval_start.strftime('%Y-%m-%dT%H:00:00Z') }}",
        ],
        conf={"spark.ui.enabled": "false"},
        verbose=False,
    )

    dq_checks = PythonOperator(
        task_id="data_quality_checks",
        python_callable=data_quality_checks,
    )

    wait_for_raw_files >> run_usage_etl >> dq_checks
