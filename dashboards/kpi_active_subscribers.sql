-- Orange Egypt Customer Insights: active subscriber-base KPI.
SELECT count(*) FILTER (WHERE s.is_active) AS active_subscribers
FROM dwh.dim_subscriber AS s
WHERE 1 = 1
[[AND {{plan_type}}]]
[[AND {{city}}]];
