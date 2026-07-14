import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def definitions():
    return json.loads((ROOT / "dashboard_definitions.json").read_text())[
        "dashboards"
    ]


def test_dashboard_and_card_names_are_unique():
    dashboards = definitions()
    dashboard_names = [dashboard["name"] for dashboard in dashboards]
    card_names = [card["name"] for dashboard in dashboards for card in dashboard["cards"]]
    assert dashboard_names == ["Network Ops", "Subscriber Insights"]
    assert len(card_names) == len(set(card_names)) == 4


def test_every_provisioned_card_has_sql_and_valid_layout():
    for dashboard in definitions():
        for card in dashboard["cards"]:
            sql_path = ROOT / card["sql_file"]
            assert sql_path.exists()
            assert "SELECT" in sql_path.read_text().upper()
            assert card["display"] in {"line", "bar"}
            assert card["layout"]["size_x"] > 0
            assert card["layout"]["size_y"] > 0


def test_quarantine_query_does_not_fake_metrics_from_fact_counts():
    sql = (ROOT / "quarantine_rate_trend.sql").read_text()
    assert "dwh.etl_hourly_metrics" in sql
    assert "dwh.fact_usage_events" not in sql
