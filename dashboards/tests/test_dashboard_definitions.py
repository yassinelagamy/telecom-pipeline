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
    assert dashboard_names == [
        "Orange Egypt | Network Command Center",
        "Orange Egypt | Customer & Usage Insights",
    ]
    assert len(card_names) == len(set(card_names)) == 22
    assert "Quarantine Rate Trend" in card_names
    assert "Tower Coverage Map" in card_names
    assert "Subscriber Usage Detail" in card_names


def test_every_provisioned_card_has_sql_and_valid_layout():
    for dashboard in definitions():
        for card in dashboard["cards"]:
            sql_path = ROOT / card["sql_file"]
            assert sql_path.exists()
            assert "SELECT" in sql_path.read_text().upper()
            assert card["display"] in {"line", "bar", "pie", "map", "scalar", "table"}
            assert card["layout"]["size_x"] > 0
            assert card["layout"]["size_y"] > 0


def test_card_filter_tags_match_sql_and_dashboard_parameters():
    for dashboard in definitions():
        templates = dashboard["filter_templates"]
        parameter_ids = {parameter["id"] for parameter in dashboard["parameters"]}
        assert all("." in template["alias"] for template in templates.values())
        for card in dashboard["cards"]:
            sql = (ROOT / card["sql_file"]).read_text()
            for filter_name in card.get("filters", []):
                assert filter_name in templates
                assert templates[filter_name]["parameter"] in parameter_ids
                assert "{{" + filter_name + "}}" in sql


def test_orange_brand_palette_is_declared_and_used():
    payload = json.loads((ROOT / "dashboard_definitions.json").read_text())
    assert payload["brand"]["primary"] == "#FF7900"
    rendered = json.dumps(payload["dashboards"])
    assert "#FF7900" in rendered


def test_provisioner_uses_dimension_targets_for_field_filters():
    source = (ROOT / "provision_metabase.py").read_text()
    assert '["dimension", ["template-tag", item["tag"]]]' in source


def test_quarantine_query_does_not_fake_metrics_from_fact_counts():
    sql = (ROOT / "quarantine_rate_trend.sql").read_text()
    assert "dwh.etl_interval_metrics" in sql
    assert "dwh.fact_usage_events" not in sql
    assert "run_start AS interval_start" in sql
    assert "quarantine_rate::numeric" in sql
