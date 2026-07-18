import json
import os
import sys
from datetime import datetime, timezone

import pytest
from pyspark.sql import SparkSession

from etl.usage_etl import interval_paths, parse_run_start, validate_records


# Local Windows Spark otherwise defaults to a Unix-only `python3` worker.
os.environ["PYSPARK_PYTHON"] = sys.executable


@pytest.fixture(scope="session")
def spark():
    session = (
        SparkSession.builder.master("local[1]")
        .appName("usage-etl-tests")
        .config("spark.ui.enabled", "false")
        .config("spark.pyspark.python", sys.executable)
        .config("spark.sql.session.timeZone", "UTC")
        .getOrCreate()
    )
    yield session
    session.stop()


def raw_frame(spark, records):
    lines = [record if isinstance(record, str) else json.dumps(record) for record in records]
    return spark.createDataFrame([(line,) for line in lines], ["raw_record"])


def valid_voice(**overrides):
    record = {
        "event_id": "9b2f0c1e-6c1a-4b6e-9f3e-1a2b3c4d5e6f",
        "subscriber_id": "SUB-000123",
        "event_type": "voice",
        "cell_tower_id": "TWR-0042",
        "event_ts": "2026-07-14T09:15:32Z",
        "duration_sec": 120,
        "sms_count": None,
        "bytes_up": None,
        "bytes_down": None,
    }
    record.update(overrides)
    return record


def test_parse_run_start_accepts_only_aligned_ten_minute_utc_boundaries():
    assert parse_run_start("2026-07-14T09:20:00Z") == datetime(
        2026, 7, 14, 9, 20, tzinfo=timezone.utc
    )
    with pytest.raises(Exception, match="10-minute"):
        parse_run_start("2026-07-14T09:15:00Z")
    with pytest.raises(Exception, match="UTC"):
        parse_run_start("2026-07-14T09:20:00+02:00")


def test_interval_paths_follow_ten_minute_contract():
    run_start = datetime(2026, 7, 14, 9, 20, tzinfo=timezone.utc)
    assert interval_paths("telecom-lake", run_start) == (
        "s3a://telecom-lake/raw/usage_logs/date=2026-07-14/hour=09/minute=20/part-*.json.gz",
        "s3a://telecom-lake/quarantine/usage_logs/date=2026-07-14/hour=09/minute=20/",
    )


def test_valid_records_are_typed_and_retained(spark):
    hour = datetime(2026, 7, 14, 9, 10, tzinfo=timezone.utc)
    records = [
        valid_voice(),
        valid_voice(
            event_id="b102fce1-1962-4786-a72c-e6439c66de22",
            event_type="sms",
            duration_sec=None,
            sms_count=1,
        ),
        valid_voice(
            event_id="016be932-a709-4704-9f83-e722a9a6ce19",
            event_type="data",
            duration_sec=None,
            bytes_up=0,
            bytes_down=834211,
        ),
    ]
    valid, quarantine = validate_records(raw_frame(spark, records), hour)

    assert valid.count() == 3
    assert quarantine.count() == 0
    result = {row.event_type: row for row in valid.collect()}
    assert result["voice"].duration_sec == 120
    assert result["sms"].sms_count == 1
    assert result["data"].bytes_down == 834211


def test_bad_rows_are_quarantined_with_audit_reasons(spark):
    hour = datetime(2026, 7, 14, 9, 10, tzinfo=timezone.utc)
    records = [
        "{not-json",
        valid_voice(event_ts="not-a-time"),
        valid_voice(event_ts="2026-07-14T09:25:00Z"),
        valid_voice(duration_sec=-1),
        valid_voice(subscriber_id="123"),
        valid_voice(event_type="fax"),
    ]
    valid, quarantine = validate_records(raw_frame(spark, records), hour)

    assert valid.count() == 0
    reasons = [set(row.invalid_reasons) for row in quarantine.collect()]
    assert any("malformed_json" in row for row in reasons)
    assert any("invalid_event_ts" in row for row in reasons)
    assert any("event_ts_outside_run_interval" in row for row in reasons)
    assert any("invalid_event_metrics" in row for row in reasons)
    assert any("invalid_subscriber_id" in row for row in reasons)
    assert any("invalid_event_type" in row for row in reasons)
    assert all(row.raw_record for row in quarantine.collect())


def test_other_event_metrics_must_be_null(spark):
    hour = datetime(2026, 7, 14, 9, 10, tzinfo=timezone.utc)
    invalid_voice = valid_voice(bytes_up=0)
    valid, quarantine = validate_records(raw_frame(spark, [invalid_voice]), hour)

    assert valid.count() == 0
    assert quarantine.first().invalid_reasons == ["invalid_event_metrics"]
