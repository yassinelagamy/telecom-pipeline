-- Orange Egypt Network Command Center: latest available DQ rejection rate.
SELECT round(100.0 * m.quarantine_rate::numeric, 2) AS quarantine_rate_pct
FROM dwh.etl_hourly_metrics AS m
WHERE 1 = 1
[[AND {{metric_date}}]]
ORDER BY m.run_hour DESC
LIMIT 1;
