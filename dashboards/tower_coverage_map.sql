-- Orange Egypt Network Command Center: tower coordinates and traffic intensity.
SELECT
    t.cell_tower_id,
    t.region,
    t.latitude,
    t.longitude,
    count(f.event_id) AS event_count,
    round(sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0)) / 1048576.0, 2)
        AS data_mb
FROM dwh.fact_usage_events AS f
JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{event_type}}]]
[[AND {{region}}]]
GROUP BY t.cell_tower_id, t.region, t.latitude, t.longitude
ORDER BY event_count DESC;
