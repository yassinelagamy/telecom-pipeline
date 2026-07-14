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

Start the full stack with `docker compose up -d --build`, then open:

`http://localhost:8088`

The API validates all filter values and uses parameterized SQL. It does not
expose database credentials to the browser.
