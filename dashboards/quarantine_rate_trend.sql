-- Network Ops: hourly malformed/quarantine rate.
--
-- This query intentionally depends on the operational metrics persisted by
-- Airflow's data-quality task rather than estimating rejected rows from fact
-- counts. The table is additive and is not part of the frozen star schema.
SELECT
    run_hour AS hour_utc,
    raw_rows,
    fact_rows,
    quarantine_rows,
    round(100.0 * quarantine_rate::numeric, 2) AS quarantine_rate_pct
FROM dwh.etl_hourly_metrics AS m
WHERE 1 = 1
[[AND {{metric_date}}]]
ORDER BY m.run_hour;
