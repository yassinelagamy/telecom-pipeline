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


def test_frontend_contains_reference_driven_orange_controls():
    html = (ROOT / "frontend" / "static" / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "frontend" / "static" / "styles.css").read_text(encoding="utf-8")
    assert "utility-bar" in html
    assert "service-rail" in html
    assert "orange<sup>™</sup>" in html
    assert "--orange: #ff7900" in css
    assert "border-radius: 0" in css


def test_compose_exposes_orange_frontend():
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    assert "orange-frontend:" in compose
    assert "${ORANGE_FRONTEND_PORT:-8088}:8088" in compose
