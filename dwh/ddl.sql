-- Telecom warehouse schema. Safe to execute repeatedly.
SET TIME ZONE 'UTC';

CREATE SCHEMA IF NOT EXISTS dwh;

CREATE TABLE IF NOT EXISTS dwh.dim_subscriber (
    subscriber_key BIGSERIAL PRIMARY KEY,
    subscriber_id TEXT UNIQUE NOT NULL,
    plan_type TEXT NOT NULL,
    city TEXT NOT NULL,
    activation_date DATE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS dwh.dim_tower (
    tower_key BIGSERIAL PRIMARY KEY,
    cell_tower_id TEXT UNIQUE NOT NULL,
    region TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS dwh.dim_date (
    date_key INT PRIMARY KEY,
    full_date DATE UNIQUE NOT NULL,
    year INT NOT NULL,
    month INT NOT NULL,
    day INT NOT NULL,
    day_of_week INT NOT NULL,
    is_weekend BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS dwh.fact_usage_events (
    event_id UUID PRIMARY KEY,
    subscriber_key BIGINT NOT NULL REFERENCES dwh.dim_subscriber(subscriber_key),
    tower_key BIGINT NOT NULL REFERENCES dwh.dim_tower(tower_key),
    date_key INT NOT NULL REFERENCES dwh.dim_date(date_key),
    event_ts TIMESTAMPTZ NOT NULL,
    event_type TEXT NOT NULL,
    duration_sec INT,
    sms_count INT,
    bytes_up BIGINT,
    bytes_down BIGINT,
    load_ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fact_usage_events_event_ts_idx
    ON dwh.fact_usage_events (event_ts);
CREATE INDEX IF NOT EXISTS fact_usage_events_subscriber_key_idx
    ON dwh.fact_usage_events (subscriber_key);
CREATE INDEX IF NOT EXISTS fact_usage_events_tower_key_idx
    ON dwh.fact_usage_events (tower_key);

-- Migrate the original hourly metrics contract without losing existing runs.
DO $migration$
BEGIN
    IF to_regclass('dwh.etl_interval_metrics') IS NULL
       AND to_regclass('dwh.etl_hourly_metrics') IS NOT NULL THEN
        ALTER TABLE dwh.etl_hourly_metrics RENAME TO etl_interval_metrics;
    END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS dwh.etl_interval_metrics (
    run_start TIMESTAMPTZ PRIMARY KEY,
    raw_rows INT NOT NULL,
    quarantine_rows INT NOT NULL,
    quarantine_rate DOUBLE PRECISION NOT NULL,
    fact_rows INT NOT NULL,
    load_ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $migration$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'dwh' AND table_name = 'etl_interval_metrics'
          AND column_name = 'run_hour'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'dwh' AND table_name = 'etl_interval_metrics'
          AND column_name = 'run_start'
    ) THEN
        ALTER TABLE dwh.etl_interval_metrics RENAME COLUMN run_hour TO run_start;
    END IF;
END
$migration$;
