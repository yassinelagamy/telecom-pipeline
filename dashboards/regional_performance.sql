-- Orange Egypt Network Command Center: regional operating summary.
SELECT
    t.region,
    count(*) AS event_count,
    round(sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0)) / 1073741824.0, 2)
        AS data_gb,
    round(sum(coalesce(f.duration_sec, 0)) / 60.0, 2) AS voice_minutes,
    sum(coalesce(f.sms_count, 0)) AS sms_messages,
    count(DISTINCT t.tower_key) AS active_towers
FROM dwh.fact_usage_events AS f
JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{event_type}}]]
[[AND {{region}}]]
GROUP BY t.region
ORDER BY event_count DESC, t.region;
