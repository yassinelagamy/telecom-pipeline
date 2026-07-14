-- Orange Egypt Customer Insights: subscriber-base KPI.
SELECT count(*) AS total_subscribers
FROM dwh.dim_subscriber AS s
WHERE 1 = 1
[[AND {{plan_type}}]]
[[AND {{city}}]];
