-- Orange Egypt Network Command Center: validated event volume KPI.
SELECT count(*) AS total_events
FROM dwh.fact_usage_events AS f
JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{event_type}}]]
[[AND {{region}}]];
