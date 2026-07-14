-- Orange Egypt Network Command Center: towers carrying selected traffic.
SELECT count(DISTINCT f.tower_key) AS active_towers
FROM dwh.fact_usage_events AS f
JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{event_type}}]]
[[AND {{region}}]];
