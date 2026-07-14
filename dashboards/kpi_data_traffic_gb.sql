-- Orange Egypt Network Command Center: carried data volume KPI.
SELECT round(
    sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0)) / 1073741824.0,
    2
) AS data_traffic_gb
FROM dwh.fact_usage_events AS f
JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{event_type}}]]
[[AND {{region}}]];
