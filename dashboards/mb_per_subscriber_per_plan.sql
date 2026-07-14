-- Subscriber Insights: average and total data consumption by plan.
WITH subscriber_data AS (
    SELECT
        s.subscriber_key,
        s.plan_type,
        sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0)) / 1048576.0
            AS data_mb
    FROM dwh.dim_subscriber AS s
    LEFT JOIN dwh.fact_usage_events AS f
        ON f.subscriber_key = s.subscriber_key
       AND f.event_type = 'data'
    WHERE 1 = 1
    [[AND {{event_date}}]]
    [[AND {{plan_type}}]]
    [[AND {{city}}]]
    GROUP BY s.subscriber_key, s.plan_type
)
SELECT
    plan_type,
    round(avg(data_mb), 2) AS avg_mb_per_subscriber,
    round(sum(data_mb), 2) AS total_data_mb,
    count(*) AS subscriber_count
FROM subscriber_data
GROUP BY plan_type
ORDER BY avg_mb_per_subscriber DESC;
