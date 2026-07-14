SET TIME ZONE 'UTC';

CREATE SCHEMA IF NOT EXISTS dwh;

CREATE TABLE dwh.dim_subscriber (
    subscriber_key BIGSERIAL PRIMARY KEY,
    subscriber_id TEXT UNIQUE NOT NULL,
    plan_type TEXT NOT NULL,
    city TEXT NOT NULL,
    activation_date DATE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE dwh.dim_tower (
    tower_key BIGSERIAL PRIMARY KEY,
    cell_tower_id TEXT UNIQUE NOT NULL,
    region TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL
);

CREATE TABLE dwh.dim_date (
    date_key INT PRIMARY KEY,
    full_date DATE UNIQUE NOT NULL,
    year INT NOT NULL,
    month INT NOT NULL,
    day INT NOT NULL,
    day_of_week INT NOT NULL,
    is_weekend BOOLEAN NOT NULL
);

CREATE TABLE dwh.fact_usage_events (
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

CREATE INDEX fact_usage_events_event_ts_idx
    ON dwh.fact_usage_events (event_ts);
CREATE INDEX fact_usage_events_subscriber_key_idx
    ON dwh.fact_usage_events (subscriber_key);
CREATE INDEX fact_usage_events_tower_key_idx
    ON dwh.fact_usage_events (tower_key);

INSERT INTO dwh.dim_subscriber (
    subscriber_id, plan_type, city, activation_date, is_active
)
SELECT
    'SUB-' || lpad(n::text, 6, '0'),
    (ARRAY['prepaid', 'postpaid', 'business'])[(n % 3) + 1],
    (ARRAY['Cairo', 'Alexandria', 'Giza', 'Mansoura', 'Aswan'])[(n % 5) + 1],
    DATE '2020-01-01' + ((n * 37) % 1825),
    n % 20 <> 0
FROM generate_series(1, 5000) AS n;

INSERT INTO dwh.dim_tower (
    cell_tower_id, region, latitude, longitude
)
SELECT
    'TWR-' || lpad(n::text, 4, '0'),
    (ARRAY['North', 'South', 'East', 'West', 'Central'])[(n % 5) + 1],
    22.0 + ((n * 73) % 900) / 100.0,
    25.0 + ((n * 47) % 1000) / 100.0
FROM generate_series(1, 200) AS n;

INSERT INTO dwh.dim_date (
    date_key, full_date, year, month, day, day_of_week, is_weekend
)
SELECT
    to_char(d, 'YYYYMMDD')::int,
    d::date,
    EXTRACT(YEAR FROM d)::int,
    EXTRACT(MONTH FROM d)::int,
    EXTRACT(DAY FROM d)::int,
    EXTRACT(ISODOW FROM d)::int,
    EXTRACT(ISODOW FROM d)::int IN (6, 7)
FROM generate_series(
    DATE '2025-01-01',
    DATE '2027-12-31',
    INTERVAL '1 day'
) AS d;
