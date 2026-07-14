-- Orange Egypt Customer Insights: customer base by city.
SELECT
    s.city,
    count(*) AS subscriber_count,
    count(*) FILTER (WHERE s.is_active) AS active_subscribers,
    round(100.0 * count(*) FILTER (WHERE s.is_active) / nullif(count(*), 0), 2)
        AS active_rate_pct
FROM dwh.dim_subscriber AS s
WHERE 1 = 1
[[AND {{plan_type}}]]
[[AND {{city}}]]
GROUP BY s.city
ORDER BY subscriber_count DESC, s.city;
