-- Network Ops: busiest towers across the loaded reporting window.
SELECT
    t.cell_tower_id,
    t.region,
    count(*) AS event_count,
    round(sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0)) / 1048576.0, 2)
        AS total_data_mb,
    round(sum(coalesce(f.duration_sec, 0)) / 60.0, 2) AS voice_minutes,
    sum(coalesce(f.sms_count, 0)) AS sms_messages
FROM dwh.fact_usage_events AS f
JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{event_type}}]]
[[AND {{region}}]]
GROUP BY t.cell_tower_id, t.region
ORDER BY event_count DESC, t.cell_tower_id
LIMIT 10;
