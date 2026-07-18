"""Ten-minute telecom usage ETL.

Reads one UTC interval of gzip NDJSON from MinIO, quarantines rows that violate
the frozen raw contract, resolves warehouse dimension keys, and replaces the
same interval in Postgres. The job is designed to be called by Airflow's
SparkSubmitOperator, but can also be run manually with spark-submit.
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Sequence

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F
from pyspark.sql import types as T


UTC = timezone.utc
UUID4_PATTERN = (
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-"
    r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)
UTC_TIMESTAMP_PATTERN = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"
INTEGER_PATTERN = r"^-?\d+$"

# Parse metrics as strings first. This preserves the difference between JSON
# null and a value of the wrong type until validation has finished.
RAW_SCHEMA = T.StructType(
    [
        T.StructField("event_id", T.StringType()),
        T.StructField("subscriber_id", T.StringType()),
        T.StructField("event_type", T.StringType()),
        T.StructField("cell_tower_id", T.StringType()),
        T.StructField("event_ts", T.StringType()),
        T.StructField("duration_sec", T.StringType()),
        T.StructField("sms_count", T.StringType()),
        T.StructField("bytes_up", T.StringType()),
        T.StructField("bytes_down", T.StringType()),
        T.StructField("_corrupt_record", T.StringType()),
    ]
)


@dataclass(frozen=True)
class Settings:
    minio_endpoint: str
    minio_access_key: str
    minio_secret_key: str
    minio_bucket: str
    jdbc_url: str
    jdbc_user: str
    jdbc_password: str
    jdbc_driver: str = "org.postgresql.Driver"
    fact_table: str = "dwh.fact_usage_events"
    output_partitions: int = 4

    @classmethod
    def from_env(cls) -> "Settings":
        host = os.getenv("DWH_POSTGRES_HOST", "postgres-dwh")
        port = os.getenv("DWH_POSTGRES_PORT", "5432")
        database = os.getenv("DWH_POSTGRES_DB", "telecom_dwh")
        jdbc_url = os.getenv(
            "DWH_JDBC_URL",
            f"jdbc:postgresql://{host}:{port}/{database}?stringtype=unspecified",
        )
        return cls(
            minio_endpoint=os.getenv("MINIO_ENDPOINT", "http://minio:9000"),
            minio_access_key=_required_env("MINIO_ROOT_USER"),
            minio_secret_key=_required_env("MINIO_ROOT_PASSWORD"),
            minio_bucket=os.getenv("MINIO_BUCKET", "telecom-lake"),
            jdbc_url=jdbc_url,
            jdbc_user=_required_env("DWH_POSTGRES_USER"),
            jdbc_password=_required_env("DWH_POSTGRES_PASSWORD"),
            output_partitions=int(os.getenv("ETL_OUTPUT_PARTITIONS", "4")),
        )


def _required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise ValueError(f"Required environment variable {name} is not set")
    return value


INTERVAL_MINUTES = 10


def parse_run_start(value: str) -> datetime:
    """Parse an aware UTC timestamp aligned to a ten-minute boundary."""
    normalized = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "run start must be ISO-8601, e.g. 2026-07-14T09:20:00Z"
        ) from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise argparse.ArgumentTypeError("run start must explicitly use UTC")
    parsed = parsed.astimezone(UTC)
    if parsed.minute % INTERVAL_MINUTES or parsed.second or parsed.microsecond:
        raise argparse.ArgumentTypeError(
            "run start must align to a 10-minute UTC boundary"
        )
    return parsed


parse_run_hour = parse_run_start


def build_spark(settings: Settings) -> SparkSession:
    spark = (
        SparkSession.builder.appName("telecom-ten-minute-usage-etl")
        .config("spark.sql.session.timeZone", "UTC")
        .config("spark.hadoop.fs.s3a.endpoint", settings.minio_endpoint)
        .config("spark.hadoop.fs.s3a.access.key", settings.minio_access_key)
        .config("spark.hadoop.fs.s3a.secret.key", settings.minio_secret_key)
        .config("spark.hadoop.fs.s3a.path.style.access", "true")
        .config("spark.hadoop.fs.s3a.connection.ssl.enabled", "false")
        .config(
            "spark.hadoop.fs.s3a.impl",
            "org.apache.hadoop.fs.s3a.S3AFileSystem",
        )
        .getOrCreate()
    )
    spark.conf.set("spark.sql.session.timeZone", "UTC")
    spark.sparkContext.setLogLevel(os.getenv("SPARK_LOG_LEVEL", "WARN"))
    return spark


def interval_paths(bucket: str, run_start: datetime) -> tuple[str, str]:
    partition = (
        f"date={run_start:%Y-%m-%d}/hour={run_start:%H}/minute={run_start:%M}"
    )
    raw = f"s3a://{bucket}/raw/usage_logs/{partition}/part-*.json.gz"
    quarantine = f"s3a://{bucket}/quarantine/usage_logs/{partition}/"
    return raw, quarantine


hour_paths = interval_paths


def validate_records(
    raw_lines: DataFrame, run_start: datetime
) -> tuple[DataFrame, DataFrame]:
    """Return (valid records, quarantine records) for an hour of raw lines."""
    parsed = F.from_json(
        F.col("raw_record"),
        RAW_SCHEMA,
        {"mode": "PERMISSIVE", "columnNameOfCorruptRecord": "_corrupt_record"},
    )
    rows = raw_lines.select("raw_record", parsed.alias("record")).select(
        "raw_record", "record", "record.*"
    )

    rows = (
        rows.withColumn(
            "parsed_event_ts",
            F.when(
                F.col("event_ts").rlike(UTC_TIMESTAMP_PATTERN),
                F.to_timestamp("event_ts", "yyyy-MM-dd'T'HH:mm:ss'Z'"),
            ),
        )
        .withColumn(
            "parsed_duration_sec",
            F.when(F.col("duration_sec").rlike(INTEGER_PATTERN), F.col("duration_sec").cast("int")),
        )
        .withColumn(
            "parsed_sms_count",
            F.when(F.col("sms_count").rlike(INTEGER_PATTERN), F.col("sms_count").cast("int")),
        )
        .withColumn(
            "parsed_bytes_up",
            F.when(F.col("bytes_up").rlike(INTEGER_PATTERN), F.col("bytes_up").cast("long")),
        )
        .withColumn(
            "parsed_bytes_down",
            F.when(F.col("bytes_down").rlike(INTEGER_PATTERN), F.col("bytes_down").cast("long")),
        )
    )

    required_missing = F.lit(False)
    for name in (
        "event_id",
        "subscriber_id",
        "event_type",
        "cell_tower_id",
        "event_ts",
    ):
        required_missing = required_missing | F.col(name).isNull() | (
            F.trim(F.col(name)) == ""
        )

    voice_metrics_valid = (
        (F.col("parsed_duration_sec") > 0)
        & F.col("sms_count").isNull()
        & F.col("bytes_up").isNull()
        & F.col("bytes_down").isNull()
    )
    sms_metrics_valid = (
        (F.col("parsed_sms_count") > 0)
        & F.col("duration_sec").isNull()
        & F.col("bytes_up").isNull()
        & F.col("bytes_down").isNull()
    )
    data_metrics_valid = (
        (F.col("parsed_bytes_up") >= 0)
        & (F.col("parsed_bytes_down") >= 0)
        & F.col("duration_sec").isNull()
        & F.col("sms_count").isNull()
    )
    metrics_valid = (
        ((F.col("event_type") == "voice") & voice_metrics_valid)
        | ((F.col("event_type") == "sms") & sms_metrics_valid)
        | ((F.col("event_type") == "data") & data_metrics_valid)
    )

    interval_start = run_start.strftime("%Y-%m-%dT%H:%M:%SZ")
    interval_end = (run_start + timedelta(minutes=INTERVAL_MINUTES)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    timestamp_outside_interval = F.col("parsed_event_ts").isNotNull() & ~(
        (F.col("parsed_event_ts") >= F.to_timestamp(F.lit(interval_start), "yyyy-MM-dd'T'HH:mm:ss'Z'"))
        & (F.col("parsed_event_ts") < F.to_timestamp(F.lit(interval_end), "yyyy-MM-dd'T'HH:mm:ss'Z'"))
    )

    reason_candidates = F.array(
        F.when(F.col("record").isNull() | F.col("_corrupt_record").isNotNull(), "malformed_json"),
        F.when(required_missing, "missing_required_field"),
        F.when(~F.coalesce(F.col("event_id").rlike(UUID4_PATTERN), F.lit(False)), "invalid_event_id"),
        F.when(
            ~F.coalesce(F.col("subscriber_id").rlike(r"^SUB-\d{6}$"), F.lit(False)),
            "invalid_subscriber_id",
        ),
        F.when(
            ~F.coalesce(F.col("cell_tower_id").rlike(r"^TWR-\d{4}$"), F.lit(False)),
            "invalid_cell_tower_id",
        ),
        F.when(
            ~F.coalesce(F.col("event_type").isin("voice", "sms", "data"), F.lit(False)),
            "invalid_event_type",
        ),
        F.when(F.col("parsed_event_ts").isNull(), "invalid_event_ts"),
        F.when(timestamp_outside_interval, "event_ts_outside_run_interval"),
        F.when(~F.coalesce(metrics_valid, F.lit(False)), "invalid_event_metrics"),
    )
    rows = rows.withColumn(
        "invalid_reasons", F.filter(reason_candidates, lambda reason: reason.isNotNull())
    )

    quarantine = rows.where(F.size("invalid_reasons") > 0).select(
        "raw_record",
        "invalid_reasons",
        F.lit(interval_start).alias("run_start_utc"),
        F.current_timestamp().alias("quarantine_ts"),
    )
    valid = rows.where(F.size("invalid_reasons") == 0).select(
        "event_id",
        "subscriber_id",
        "cell_tower_id",
        F.col("parsed_event_ts").alias("event_ts"),
        "event_type",
        F.col("parsed_duration_sec").alias("duration_sec"),
        F.col("parsed_sms_count").alias("sms_count"),
        F.col("parsed_bytes_up").alias("bytes_up"),
        F.col("parsed_bytes_down").alias("bytes_down"),
    )
    return valid, quarantine


def jdbc_options(settings: Settings) -> dict[str, str]:
    return {
        "url": settings.jdbc_url,
        "user": settings.jdbc_user,
        "password": settings.jdbc_password,
        "driver": settings.jdbc_driver,
        "stringtype": "unspecified",
    }


def resolve_dimension_keys(
    spark: SparkSession, valid: DataFrame, settings: Settings
) -> DataFrame:
    options = jdbc_options(settings)
    subscribers = (
        spark.read.format("jdbc")
        .options(**options, dbtable="dwh.dim_subscriber")
        .load()
        .select("subscriber_id", "subscriber_key")
    )
    towers = (
        spark.read.format("jdbc")
        .options(**options, dbtable="dwh.dim_tower")
        .load()
        .select("cell_tower_id", "tower_key")
    )
    dates = (
        spark.read.format("jdbc")
        .options(**options, dbtable="dwh.dim_date")
        .load()
        .select(F.col("date_key").alias("dim_date_key"))
    )

    keyed = (
        valid.withColumn("date_key", F.date_format("event_ts", "yyyyMMdd").cast("int"))
        .join(F.broadcast(subscribers), "subscriber_id", "left")
        .join(F.broadcast(towers), "cell_tower_id", "left")
        .join(
            F.broadcast(dates),
            F.col("date_key") == F.col("dim_date_key"),
            "left",
        )
    )

    missing = keyed.agg(
        F.sum(F.when(F.col("subscriber_key").isNull(), 1).otherwise(0)).alias("subscriber"),
        F.sum(F.when(F.col("tower_key").isNull(), 1).otherwise(0)).alias("tower"),
        F.sum(F.when(F.col("dim_date_key").isNull(), 1).otherwise(0)).alias("date"),
    ).first()
    missing_counts = {name: int(missing[name] or 0) for name in ("subscriber", "tower", "date")}
    if any(missing_counts.values()):
        raise RuntimeError(
            "Dimension lookup failed; fact load was not changed: "
            + json.dumps(missing_counts, sort_keys=True)
        )

    return keyed.select(
        "event_id",
        "subscriber_key",
        "tower_key",
        "date_key",
        "event_ts",
        "event_type",
        "duration_sec",
        "sms_count",
        "bytes_up",
        "bytes_down",
    )


def delete_interval(spark: SparkSession, settings: Settings, run_start: datetime) -> int:
    """Delete the target interval through Spark's loaded JDBC driver."""
    jvm = spark.sparkContext._gateway.jvm
    properties = jvm.java.util.Properties()
    properties.setProperty("user", settings.jdbc_user)
    properties.setProperty("password", settings.jdbc_password)
    properties.setProperty("stringtype", "unspecified")
    # Packages supplied by spark-submit live in Spark's context classloader,
    # not necessarily Java's system classloader. Instantiate the driver from
    # that loader and connect directly so both deployment modes work.
    loader = jvm.org.apache.spark.util.Utils.getContextOrSparkClassLoader()
    driver = loader.loadClass(settings.jdbc_driver).newInstance()
    connection = driver.connect(settings.jdbc_url, properties)
    if connection is None:
        raise RuntimeError(f"JDBC driver rejected URL {settings.jdbc_url}")
    statement = None
    try:
        connection.setAutoCommit(False)
        sql = (
            f"DELETE FROM {settings.fact_table} "
            "WHERE event_ts >= CAST(? AS timestamptz) "
            "AND event_ts < CAST(? AS timestamptz)"
        )
        statement = connection.prepareStatement(sql)
        statement.setString(1, run_start.isoformat().replace("+00:00", "Z"))
        statement.setString(
            2, (run_start + timedelta(minutes=INTERVAL_MINUTES)).isoformat().replace("+00:00", "Z")
        )
        deleted = statement.executeUpdate()
        connection.commit()
        return int(deleted)
    except Exception:
        connection.rollback()
        raise
    finally:
        if statement is not None:
            statement.close()
        connection.close()


delete_hour = delete_interval


def write_fact(fact: DataFrame, settings: Settings) -> None:
    (
        fact.coalesce(settings.output_partitions)
        .write.format("jdbc")
        .options(**jdbc_options(settings), dbtable=settings.fact_table)
        .mode("append")
        .save()
    )


def run(run_start: datetime, settings: Settings) -> dict[str, object]:
    spark = build_spark(settings)
    raw_path, quarantine_path = interval_paths(settings.minio_bucket, run_start)
    try:
        raw_lines = spark.read.text(raw_path).select(F.col("value").alias("raw_record")).cache()
        total_rows = raw_lines.count()
        if total_rows == 0:
            raise RuntimeError(f"No raw usage records found at {raw_path}")

        valid, quarantine = validate_records(raw_lines, run_start)
        valid = valid.cache()
        quarantine = quarantine.cache()
        valid_rows = valid.count()
        quarantine_rows = quarantine.count()

        # Overwrite makes quarantine deterministic on interval reruns.
        (
            quarantine.write.mode("overwrite")
            .option("compression", "gzip")
            .json(quarantine_path)
        )

        fact = resolve_dimension_keys(spark, valid, settings).cache()
        fact_rows = fact.count()
        deleted_rows = delete_interval(spark, settings, run_start)
        write_fact(fact, settings)

        metrics = {
            "run_start_utc": run_start.isoformat().replace("+00:00", "Z"),
            "raw_rows": total_rows,
            "valid_rows": valid_rows,
            "quarantine_rows": quarantine_rows,
            "quarantine_rate": quarantine_rows / total_rows,
            "deleted_fact_rows": deleted_rows,
            "inserted_fact_rows": fact_rows,
            "raw_path": raw_path,
            "quarantine_path": quarantine_path,
        }
        print("ETL_METRICS " + json.dumps(metrics, sort_keys=True))
        return metrics
    finally:
        spark.stop()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--run-start",
        required=True,
        type=parse_run_start,
        help="UTC interval start, e.g. 2026-07-14T09:20:00Z",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    run(args.run_start, Settings.from_env())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
