# Orange Egypt analytics frontend

This service is the presentation layer for the telecom pipeline. It keeps
Postgres and Metabase as the analytical foundation while providing the Orange
Egypt-specific interface that Metabase Community Edition cannot white-label.

The interface follows the supplied Orange Egypt reference with:

- a two-level black navigation header and square orange brand block;
- sharp-cornered orange/black buttons and active navigation states;
- a large feature panel with two stacked operational highlights;
- a horizontal service-style selection rail;
- responsive KPI, chart, map, quality, and detail-table sections;
- live date, usage-type, region, plan, and city selections;
- Overview, Network, Customers, and Data Quality views;
- CSV export, fullscreen, language-direction toggle, and ten-minute refresh.

## Qlik-style analytics workbench

On top of the base interface, the app implements an associative analysis
model inspired by Qlik Sense:

- **Associative selections** — click any chart element (donut slice, legend,
  region/plan/city bar, popover value) to select it; every visual re-filters.
  Field value lists show Qlik's three states: **green** selected, **white**
  possible (with live event counts), **grey** excluded under the current
  selection. Multi-select within a field is OR, across fields is AND.
- **Selection bar** — one chip per selected value with individual removal,
  plus Clear-all. The `‹ ›` rail arrows step **back/forward through selection
  history** (up to 60 steps).
- **Bookmarks** — save/apply/delete named selection states (localStorage).
- **Compare mode (alternate states)** — `⇄ Compare` pins the current
  selection as **state A**; keep selecting to form **state B**. A strip shows
  both states side by side with per-KPI deltas, and the traffic chart overlays
  state A as a dashed line.
- **Smart search** — the top-bar search matches values across all dimensions
  ("cai" → City Cairo · 14.2K events); click a hit to toggle it.
- **Traffic heatmap** — weekday × UTC-hour intensity matrix (7 × 24 cells).
- **Granularity switch** — hour/day toggle on the traffic trend.
- **Tables** — click headers to sort, per-table search boxes, CSV export.

### API

| Endpoint | Purpose |
|----------|---------|
| `/api/network` | KPIs, trend (`granularity=hour\|day`), heatmap, regions, mix, towers, quarantine |
| `/api/customers` | Subscriber KPIs, plans, cities, weekday split, top subscribers |
| `/api/filters` | Associative panel: per-field values with counts under the rest of the selection |

All filter params accept comma-separated multi-values (e.g.
`region=North,South`). Rapid successive selections are raced safely — only
the newest request renders (last-write-wins).

Start the full stack with `docker compose up -d --build`, then open:

`http://localhost:8088`

The API validates all filter values and uses parameterized SQL. It does not
expose database credentials to the browser.
