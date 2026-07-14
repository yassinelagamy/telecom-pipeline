-- Orange Egypt Network Command Center: carried SMS volume KPI.
SELECT sum(coalesce(f.sms_count, 0)) AS sms_messages
FROM dwh.fact_usage_events AS f
JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{event_type}}]]
[[AND {{region}}]];
