-- Orange Egypt Customer Insights: average data use per selected subscriber.
SELECT round(
    sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0)) / 1048576.0
        / nullif(count(DISTINCT s.subscriber_key), 0),
    2
) AS avg_data_mb
FROM dwh.dim_subscriber AS s
LEFT JOIN dwh.fact_usage_events AS f
    ON f.subscriber_key = s.subscriber_key
   AND f.event_type = 'data'
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{plan_type}}]]
[[AND {{city}}]];
