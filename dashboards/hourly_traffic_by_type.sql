-- Network Ops: event volume by UTC hour and usage type.
SELECT
    date_trunc('hour', f.event_ts) AS hour_utc,
    f.event_type,
    count(*) AS event_count
FROM dwh.fact_usage_events AS f
JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{event_type}}]]
[[AND {{region}}]]
GROUP BY 1, 2
ORDER BY 1, 2;
