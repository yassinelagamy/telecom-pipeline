from pathlib import Path

import pytest

from frontend import server


ROOT = Path(__file__).resolve().parents[2]


def test_usage_filters_are_parameterized_and_ordered():
    params = {
        "date_from": ["2026-07-12"],
        "date_to": ["2026-07-14"],
        "event_type": ["data"],
        "region": ["North"],
        "plan": ["prepaid"],
        "city": ["Cairo"],
    }
    clause, values = server.usage_filters(params)
    assert "%s" in clause
    assert "data" not in clause
    assert values == ["2026-07-12", "2026-07-14", "data", "North", "prepaid", "Cairo"]


def test_invalid_filter_values_are_rejected():
    with pytest.raises(ValueError, match="Invalid region"):
        server.usage_filters({"region": ["DROP TABLE"]})
    with pytest.raises(ValueError):
        server.usage_filters({"date_from": ["not-a-date"]})


def test_plan_data_date_filters_stay_parameterized():
    clause, values = server.plan_data_filters({
        "date_from": ["2026-07-12"],
        "date_to": ["2026-07-14"],
    })
    assert "f.event_type = 'data'" in clause
    assert clause.count("%s") == 2
    assert values == ["2026-07-12", "2026-07-14"]


def test_cross_analysis_choices_are_whitelisted():
    assert server.cross_choice({}, "dimension", server.CROSS_DIMENSIONS, "region") == "region"
    assert server.cross_choice(
        {"metric": ["data_mb"]}, "metric", server.CROSS_METRICS, "events"
    ) == "data_mb"
    with pytest.raises(ValueError, match="Invalid dimension"):
        server.cross_choice(
            {"dimension": ["f.event_ts; DROP TABLE dwh.fact_usage_events"]},
            "dimension",
            server.CROSS_DIMENSIONS,
            "region",
        )


def test_high_cardinality_identifiers_are_safe_and_bounded():
    assert server.identifier_values({"tower": ["TWR-0001,TWR-0200"]}, "tower", r"TWR-[0-9]{4}") == ["TWR-0001", "TWR-0200"]
    assert server.identifier_values({"subscriber": ["SUB-000123"]}, "subscriber", r"SUB-[0-9]{6}") == ["SUB-000123"]
    with pytest.raises(ValueError, match="Invalid tower"):
        server.identifier_values({"tower": ["TWR-1' OR 1=1"]}, "tower", r"TWR-[0-9]{4}")


def test_catalog_exposes_governed_free_analytics_capabilities():
    catalog = server.catalog_payload()
    assert catalog["engine"]["chart_library"] == "Apache ECharts 6.1"
    assert any(item["id"] == "subscriber" for item in catalog["dimensions"])
    assert all(item["certified"] for item in catalog["measures"])
    assert ["plan", "city", "subscriber"] in [path["dimensions"] for path in catalog["drill_paths"]]


def test_frontend_contains_reference_driven_orange_controls():
    html = (ROOT / "frontend" / "static" / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "frontend" / "static" / "styles.css").read_text(encoding="utf-8")
    assert "utility-bar" in html
    assert "service-rail" in html
    assert "orange<sup>™</sup>" in html
    assert 'data-workspace="commercial"' in html
    assert 'button.dataset.workspace === "commercial" ? "customers" : "network"' in (
        ROOT / "frontend" / "static" / "app.js"
    ).read_text(encoding="utf-8")
    for chart_id in (
        "topTowerChart", "regionDataChart", "planDataChart",
        "cityActivityChart", "topSubscriberChart", "qualityVolumeChart",
        "crossChart",
    ):
        assert f'id="{chart_id}"' in html
    assert 'data-view="cross"' in html
    assert 'id="crossDimension"' in html
    assert 'id="crossSplit"' in html
    assert 'id="chartTooltip"' in html
    assert 'id="crossDrillPath"' in html
    assert 'id="crossChartType"' in html
    assert 'id="alertButton"' in html
    assert 'id="shareButton"' in html
    assert '/vendor/echarts.min.js' in html
    assert (ROOT / "frontend" / "static" / "vendor" / "echarts.min.js").stat().st_size > 1_000_000
    assert "--orange: #ff7900" in css
    assert "border-radius: 0" in css


def test_compose_exposes_orange_frontend():
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    assert "orange-frontend:" in compose
    assert "${ORANGE_FRONTEND_PORT:-8088}:8088" in compose
