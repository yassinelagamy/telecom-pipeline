-- Subscriber Insights: usage mix for weekdays versus weekends.
SELECT
    CASE WHEN d.is_weekend THEN 'Weekend' ELSE 'Weekday' END AS day_type,
    f.event_type,
    count(*) AS event_count,
    round(sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0)) / 1073741824.0, 3)
        AS data_gb,
    round(sum(coalesce(f.duration_sec, 0)) / 60.0, 2) AS voice_minutes,
    sum(coalesce(f.sms_count, 0)) AS sms_messages
FROM dwh.fact_usage_events AS f
JOIN dwh.dim_date AS d ON d.date_key = f.date_key
GROUP BY d.is_weekend, f.event_type
ORDER BY d.is_weekend, f.event_type;
