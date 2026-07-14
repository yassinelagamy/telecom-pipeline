-- Orange Egypt Network Command Center: selected service mix.
SELECT f.event_type, count(*) AS event_count
FROM dwh.fact_usage_events AS f
JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{event_type}}]]
[[AND {{region}}]]
GROUP BY f.event_type
ORDER BY event_count DESC;
