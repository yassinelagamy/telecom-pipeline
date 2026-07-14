-- Orange Egypt Customer Insights: exportable subscriber activity detail.
SELECT
    s.subscriber_id,
    s.plan_type,
    s.city,
    s.activation_date,
    s.is_active,
    count(*) AS event_count,
    count(*) FILTER (WHERE f.event_type = 'data') AS data_events,
    count(*) FILTER (WHERE f.event_type = 'voice') AS voice_events,
    count(*) FILTER (WHERE f.event_type = 'sms') AS sms_events,
    round(sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0)) / 1048576.0, 2)
        AS data_mb,
    round(sum(coalesce(f.duration_sec, 0)) / 60.0, 2) AS voice_minutes,
    sum(coalesce(f.sms_count, 0)) AS sms_messages,
    max(f.event_ts) AS last_activity_utc
FROM dwh.fact_usage_events AS f
JOIN dwh.dim_subscriber AS s ON s.subscriber_key = f.subscriber_key
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{event_type}}]]
[[AND {{plan_type}}]]
[[AND {{city}}]]
GROUP BY s.subscriber_id, s.plan_type, s.city, s.activation_date, s.is_active
ORDER BY event_count DESC, s.subscriber_id;
