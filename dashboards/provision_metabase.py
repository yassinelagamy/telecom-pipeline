"""Create or update the telecom Metabase questions and dashboards."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
BASE_URL = os.getenv("METABASE_URL", "http://localhost:3000").rstrip("/")
DATABASE_NAME = "Telecom DWH"


def request(method: str, path: str, payload=None, session_id: str | None = None):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if session_id:
        headers["X-Metabase-Session"] = session_id
    req = urllib.request.Request(
        BASE_URL + path, data=body, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            content = response.read()
            return json.loads(content) if content else None
    except urllib.error.HTTPError as exc:
        content = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Metabase {method} {path} failed: {exc.code} {content}"
        ) from exc


def as_list(response) -> list[dict]:
    if isinstance(response, list):
        return response
    if isinstance(response, dict):
        return response.get("data", [])
    return []


def login() -> str:
    response = request(
        "POST",
        "/api/session",
        {
            "username": os.environ["MB_ADMIN_EMAIL"],
            "password": os.environ["MB_ADMIN_PASSWORD"],
        },
    )
    return response["id"]


def find_database(session_id: str) -> int:
    databases = as_list(request("GET", "/api/database", session_id=session_id))
    database = next(
        (item for item in databases if item.get("name") == DATABASE_NAME), None
    )
    if not database:
        raise RuntimeError(f"Metabase database {DATABASE_NAME!r} is not registered")
    return int(database["id"])


def field_index(session_id: str, database_id: int) -> dict[tuple[str, str], int]:
    """Return current Metabase field IDs keyed by warehouse table and field."""
    metadata = request(
        "GET", f"/api/database/{database_id}/metadata", session_id=session_id
    )
    return {
        (table["name"], field["name"]): int(field["id"])
        for table in metadata.get("tables", [])
        if table.get("schema") == "dwh"
        for field in table.get("fields", [])
    }


def ensure_dashboard(session_id: str, definition: dict) -> dict:
    dashboards = as_list(request("GET", "/api/dashboard", session_id=session_id))
    accepted_names = {definition["name"], *definition.get("legacy_names", [])}
    existing = next(
        (item for item in dashboards if item.get("name") in accepted_names),
        None,
    )
    payload = {
        "name": definition["name"],
        "description": definition["description"],
        "cache_ttl": 600,
        "width": "full",
    }
    if existing:
        return request(
            "PUT", f"/api/dashboard/{existing['id']}", payload, session_id
        )
    return request("POST", "/api/dashboard", payload, session_id)


def template_tags(
    definition: dict, fields: dict[tuple[str, str], int]
) -> dict[str, dict]:
    tags = {}
    for item in definition.get("filters", []):
        field_key = (item["table"], item["field"])
        if field_key not in fields:
            raise RuntimeError(f"Metabase field is missing: dwh.{field_key[0]}.{field_key[1]}")
        tags[item["tag"]] = {
            "id": item["tag"],
            "name": item["tag"],
            "display-name": item.get("display_name", item["tag"].replace("_", " ").title()),
            "type": "dimension",
            "dimension": ["field", fields[field_key], None],
            "widget-type": item.get("widget_type", "category"),
            "alias": item["alias"],
        }
    return tags


def expand_filters(dashboard: dict, card: dict) -> dict:
    """Expand compact filter names from the dashboard-level filter catalog."""
    expanded = dict(card)
    catalog = dashboard.get("filter_templates", {})
    expanded["filters"] = [
        {"tag": name, **catalog[name]} if isinstance(name, str) else name
        for name in card.get("filters", [])
    ]
    return expanded


def ensure_card(
    session_id: str,
    database_id: int,
    dashboard_id: int,
    definition: dict,
    fields: dict[tuple[str, str], int],
) -> dict:
    cards = as_list(request("GET", "/api/card", session_id=session_id))
    existing = next(
        (item for item in cards if item.get("name") == definition["name"]), None
    )
    sql = (ROOT / definition["sql_file"]).read_text(encoding="utf-8")
    payload = {
        "name": definition["name"],
        "description": definition["description"],
        "display": definition["display"],
        "visualization_settings": definition["visualization_settings"],
        "dataset_query": {
            "database": database_id,
            "type": "native",
            "native": {
                "query": sql,
                "template-tags": template_tags(definition, fields),
            },
        },
        "cache_ttl": 600,
        "dashboard_id": dashboard_id,
        "parameter_mappings": [
            {
                "parameter_id": item["parameter"],
                "target": ["dimension", ["template-tag", item["tag"]]],
            }
            for item in definition.get("filters", [])
        ],
    }
    if existing:
        return request("PUT", f"/api/card/{existing['id']}", payload, session_id)
    payload["size"] = {
        "size_x": definition["layout"]["size_x"],
        "size_y": definition["layout"]["size_y"],
    }
    return request("POST", "/api/card", payload, session_id)


def configure_dashboard(session_id: str, dashboard_id: int, definition: dict) -> None:
    """Install shared parameters, mappings, and the deterministic grid layout."""
    request(
        "PUT",
        f"/api/dashboard/{dashboard_id}",
        {
            "name": definition["name"],
            "description": definition["description"],
            "cache_ttl": 600,
            "width": "full",
            "parameters": definition.get("parameters", []),
        },
        session_id,
    )
    dashboard = request("GET", f"/api/dashboard/{dashboard_id}", session_id=session_id)
    dashcards_by_name = {
        item.get("card", {}).get("name"): item
        for item in dashboard.get("dashcards", [])
    }
    cards = []
    for card_definition in definition["cards"]:
        item = dashcards_by_name.get(card_definition["name"])
        if not item:
            raise RuntimeError(
                f"Card {card_definition['name']!r} is not attached to dashboard {dashboard_id}"
            )
        layout = card_definition["layout"]
        cards.append(
            {
                "id": int(item["id"]),
                "card_id": int(item["card_id"]),
                "dashboard_tab_id": item.get("dashboard_tab_id"),
                "row": layout["row"],
                "col": layout["col"],
                "size_x": layout["size_x"],
                "size_y": layout["size_y"],
                "visualization_settings": item.get("visualization_settings", {}),
                "parameter_mappings": [
                    {
                        "parameter_id": filter_definition["parameter"],
                        "card_id": int(item["card_id"]),
                        "target": [
                            "dimension",
                            ["template-tag", filter_definition["tag"]],
                        ],
                    }
                    for filter_definition in card_definition.get("filters", [])
                ],
                "series": item.get("series", []),
            }
        )
    request(
        "PUT",
        f"/api/dashboard/{dashboard_id}",
        {"dashcards": cards},
        session_id,
    )


def provision() -> dict[str, int]:
    definitions = json.loads(
        (ROOT / "dashboard_definitions.json").read_text(encoding="utf-8")
    )
    session_id = login()
    database_id = find_database(session_id)
    fields = field_index(session_id, database_id)
    results: dict[str, int] = {}
    for definition in definitions["dashboards"]:
        definition = dict(definition)
        definition["cards"] = [
            expand_filters(definition, card) for card in definition["cards"]
        ]
        dashboard = ensure_dashboard(session_id, definition)
        dashboard_id = int(dashboard["id"])
        for card in definition["cards"]:
            ensure_card(session_id, database_id, dashboard_id, card, fields)
        configure_dashboard(session_id, dashboard_id, definition)
        results[definition["name"]] = dashboard_id
        print(
            f"provisioned dashboard={definition['name']!r} "
            f"id={dashboard_id} cards={len(definition['cards'])} "
            f"url={BASE_URL}/dashboard/{dashboard_id}#refresh=600"
        )
    return results


if __name__ == "__main__":
    provision()
