-- Orange Egypt Network Command Center: carried voice duration KPI.
SELECT round(sum(coalesce(f.duration_sec, 0)) / 60.0, 2) AS voice_minutes
FROM dwh.fact_usage_events AS f
JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{event_type}}]]
[[AND {{region}}]];
