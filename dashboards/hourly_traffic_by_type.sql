-- Network Ops: event volume by UTC hour and usage type.
SELECT
    date_trunc('hour', f.event_ts) AS hour_utc,
    f.event_type,
    count(*) AS event_count
FROM dwh.fact_usage_events AS f
GROUP BY 1, 2
ORDER BY 1, 2;
