-- Orange Egypt Network Command Center: exportable tower performance detail.
SELECT
    t.cell_tower_id,
    t.region,
    t.latitude,
    t.longitude,
    count(*) AS event_count,
    count(DISTINCT f.subscriber_key) AS unique_subscribers,
    round(sum(coalesce(f.bytes_up, 0) + coalesce(f.bytes_down, 0)) / 1073741824.0, 3)
        AS data_gb,
    round(sum(coalesce(f.duration_sec, 0)) / 60.0, 2) AS voice_minutes,
    sum(coalesce(f.sms_count, 0)) AS sms_messages,
    min(f.event_ts) AS first_event_utc,
    max(f.event_ts) AS last_event_utc
FROM dwh.fact_usage_events AS f
JOIN dwh.dim_tower AS t ON t.tower_key = f.tower_key
WHERE 1 = 1
[[AND {{event_date}}]]
[[AND {{event_type}}]]
[[AND {{region}}]]
GROUP BY t.cell_tower_id, t.region, t.latitude, t.longitude
ORDER BY event_count DESC, t.cell_tower_id;
