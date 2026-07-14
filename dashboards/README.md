# Metabase dashboards

The dashboard layer is defined by five reviewed SQL files and
`dashboard_definitions.json`. `provision_metabase.py` creates or updates the
saved questions and the **Network Ops** and **Subscriber Insights** dashboards.

## Provision

Set `MB_ADMIN_EMAIL`, `MB_ADMIN_PASSWORD`, and optionally `METABASE_URL`, then
run:

```bash
python dashboards/provision_metabase.py
```

The provisioner is idempotent: reruns update the same questions and dashboards.
Each saved question and dashboard uses a 600-second result-cache policy.

For a wallboard that refreshes every 10 minutes, append `#refresh=600` to its
dashboard URL. Metabase supports refresh intervals through the dashboard URL,
for example `http://localhost:3000/dashboard/4#refresh=600`.

## Network Ops

- **Hourly Traffic by Type** (`hourly_traffic_by_type.sql`) — hourly event
  counts split by voice, SMS, and data.
- **Top 10 Towers** (`top_10_towers.sql`) — event load plus data MB, voice
  minutes, and SMS totals for the busiest towers.
- **Quarantine Rate Trend** (`quarantine_rate_trend.sql`) — approved SQL for
  hourly raw/quarantine metrics. This card remains intentionally unprovisioned
  until the ETL persists `dwh.etl_hourly_metrics`; the frozen star schema does
  not contain raw or quarantine counts.

## Subscriber Insights

- **Average MB per Subscriber by Plan**
  (`mb_per_subscriber_per_plan.sql`) — average and total data MB for prepaid,
  postpaid, and business plans, including subscribers with zero data events.
- **Weekday vs Weekend Usage** (`weekday_vs_weekend_usage.sql`) — event mix,
  data GB, voice minutes, and SMS totals by day type.

All timestamps and hourly groupings are UTC. The dashboards query the fact and
dimension tables directly, so new successful DAG partitions appear without
reprovisioning.
