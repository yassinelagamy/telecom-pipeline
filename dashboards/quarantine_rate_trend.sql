-- Network Ops: hourly malformed/quarantine rate.
--
-- This query intentionally depends on an operational metrics table rather
-- than estimating rejected rows from fact counts. The frozen star schema has
-- no quarantine counts; the ETL/DQ layer must persist its emitted metrics to:
--   dwh.etl_hourly_metrics(hour_utc, raw_rows, valid_rows, quarantine_rows)
SELECT
    hour_utc,
    raw_rows,
    quarantine_rows,
    round(100.0 * quarantine_rows / nullif(raw_rows, 0), 2)
        AS quarantine_rate_pct
FROM dwh.etl_hourly_metrics
ORDER BY hour_utc;
