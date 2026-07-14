# Orange Egypt analytics dashboards

The Metabase layer provides two Orange Egypt–styled telecom dashboards backed
by the live Postgres warehouse. The design uses Orange `#FF7900`, black,
charcoal, white, and neutral gray throughout. All hourly timestamps are UTC.

## Dashboards

### Orange Egypt | Network Command Center

Shared selections: **Date**, **Usage Type**, and **Region**.

- KPI ribbon: total usage events, data traffic GB, voice minutes, SMS messages,
  active towers, and the latest quarantine rate.
- Hourly traffic trend and traffic-mix visualizations.
- Regional performance ranking and a latitude/longitude tower map.
- Top-10 tower ranking and an hourly quarantine-rate trend.
- Exportable tower performance detail for investigation and drill-through.

Local URL: `http://localhost:3000/dashboard/4#refresh=600`

### Orange Egypt | Customer & Usage Insights

Shared selections: **Date**, **Usage Type**, **Plan**, and **City**.

- KPI ribbon: total subscribers, active subscribers, average data MB, and
  average voice minutes per subscriber.
- Plan-level data consumption and subscriber distribution by city.
- Weekday-versus-weekend service behavior.
- Top subscriber activity and exportable customer-level usage detail.

Local URL: `http://localhost:3000/dashboard/5#refresh=600`

## Qlik-style capability mapping

| Qlik-style capability | Implementation in this project |
|---|---|
| Sheet selections | Dashboard parameters mapped to every compatible native-SQL card |
| Selection propagation | Date/category selections rerun all mapped KPIs, charts, maps, and tables |
| KPI objects | Ten scalar KPI cards across the two dashboards |
| Trend and comparison charts | Line, bar, and pie visualizations with a shared Orange palette |
| Geographic analysis | Tower pin map using warehouse latitude/longitude and traffic intensity |
| Detail/drill workflow | Tower and subscriber detail tables plus Metabase question navigation |
| Export | Metabase CSV/XLSX/JSON export on saved questions and detail tables |
| Bookmarked views | Filter values can be preserved in dashboard URLs/bookmarks |
| Wallboard mode | `#refresh=600` enables ten-minute refresh; Metabase also supports fullscreen |
| Alerts/subscriptions | Available through Metabase after an administrator configures email or Slack |
| Access control | Available through Metabase collections, groups, and database permissions |

Metabase is not Qlik Sense: it does not provide Qlik's proprietary associative
engine, selection-state model, QVD layer, or Qlik scripting language. The
project implements the closest practical equivalents supported by the selected
Metabase architecture. Application-wide logo replacement and full white-label
branding require a Metabase commercial plan; this repository applies branding
to dashboard names, descriptions, layout, and visualization colors.

## Provision

Set `MB_ADMIN_EMAIL`, `MB_ADMIN_PASSWORD`, and optionally `METABASE_URL`, then
run:

```bash
python dashboards/provision_metabase.py
```

The provisioner is idempotent. It discovers current Metabase field IDs,
creates or updates saved questions, upgrades the original dashboard IDs in
place, installs shared filters, and reapplies the deterministic 24-column
layout. Reprovisioning does not create duplicate cards.

The dashboards use a 600-second result-cache policy. Successful Airflow loads
appear automatically without reprovisioning.

## Verification

Run dashboard contract tests with:

```bash
python -m pytest -q dashboards/tests
```

The tests verify unique dashboard/card names, SQL presence, filter-template
coverage, supported visualizations, valid layouts, the operational quarantine
source, and the Orange primary color.
