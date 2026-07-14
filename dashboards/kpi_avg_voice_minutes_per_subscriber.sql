-- Orange Egypt Customer Insights: average voice use per selected subscriber.
SELECT round(
    sum(coalesce(f.duration_sec, 0)) / 60.0
        / nullif(count(DISTINCT s.subscriber_key), 0),
    2
) AS avg_voice_minutes
FROM dwh.dim_subscriber AS s
LEFT JOIN dwh.fact_usage_events AS f
    ON f.subscriber_key = s.subscriber_key
   AND f.event_type = 'voice'
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{plan_type}}]]
[[AND {{city}}]];
