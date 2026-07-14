-- Orange Egypt Customer Insights: highest activity subscribers.
SELECT
    s.subscriber_id,
    s.plan_type,
    s.city,
    count(*) AS usage_score,
    round(sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0)) / 1048576.0, 2)
        AS data_mb,
    round(sum(coalesce(f.duration_sec, 0)) / 60.0, 2) AS voice_minutes,
    sum(coalesce(f.sms_count, 0)) AS sms_messages
FROM dwh.fact_usage_events AS f
JOIN dwh.dim_subscriber AS s ON s.subscriber_key = f.subscriber_key
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{event_type}}]]
[[AND {{plan_type}}]]
[[AND {{city}}]]
GROUP BY s.subscriber_id, s.plan_type, s.city
ORDER BY usage_score DESC, s.subscriber_id
LIMIT 15;
