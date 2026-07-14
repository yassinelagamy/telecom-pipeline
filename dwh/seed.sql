-- Deterministic, idempotent dimension seeds used during first container init.
SET TIME ZONE 'UTC';

INSERT INTO dwh.dim_subscriber (
    subscriber_id, plan_type, city, activation_date, is_active
)
SELECT
    'SUB-' || lpad(n::text, 6, '0'),
    (ARRAY['prepaid', 'postpaid', 'business'])[(n % 3) + 1],
    (ARRAY['Cairo', 'Alexandria', 'Giza', 'Mansoura', 'Aswan'])[(n % 5) + 1],
    DATE '2020-01-01' + ((n * 37) % 1825),
    n % 20 <> 0
FROM generate_series(1, 5000) AS n
ON CONFLICT (subscriber_id) DO UPDATE SET
    plan_type = EXCLUDED.plan_type,
    city = EXCLUDED.city,
    activation_date = EXCLUDED.activation_date,
    is_active = EXCLUDED.is_active;

INSERT INTO dwh.dim_tower (
    cell_tower_id, region, latitude, longitude
)
SELECT
    'TWR-' || lpad(n::text, 4, '0'),
    (ARRAY['North', 'South', 'East', 'West', 'Central'])[(n % 5) + 1],
    22.0 + ((n * 73) % 900) / 100.0,
    25.0 + ((n * 47) % 1000) / 100.0
FROM generate_series(1, 200) AS n
ON CONFLICT (cell_tower_id) DO UPDATE SET
    region = EXCLUDED.region,
    latitude = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude;

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
) AS d
ON CONFLICT (date_key) DO UPDATE SET
    full_date = EXCLUDED.full_date,
    year = EXCLUDED.year,
    month = EXCLUDED.month,
    day = EXCLUDED.day,
    day_of_week = EXCLUDED.day_of_week,
    is_weekend = EXCLUDED.is_weekend;
