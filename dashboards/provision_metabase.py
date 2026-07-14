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


def ensure_dashboard(session_id: str, definition: dict) -> dict:
    dashboards = as_list(request("GET", "/api/dashboard", session_id=session_id))
    existing = next(
        (item for item in dashboards if item.get("name") == definition["name"]),
        None,
    )
    payload = {
        "name": definition["name"],
        "description": definition["description"],
        "cache_ttl": 600,
    }
    if existing:
        return request(
            "PUT", f"/api/dashboard/{existing['id']}", payload, session_id
        )
    return request("POST", "/api/dashboard", payload, session_id)


def ensure_card(
    session_id: str, database_id: int, dashboard_id: int, definition: dict
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
            "native": {"query": sql, "template-tags": {}},
        },
        "cache_ttl": 600,
    }
    if existing:
        return request("PUT", f"/api/card/{existing['id']}", payload, session_id)
    payload["dashboard_id"] = dashboard_id
    payload["size"] = {
        "size_x": definition["layout"]["size_x"],
        "size_y": definition["layout"]["size_y"],
    }
    return request("POST", "/api/card", payload, session_id)


def provision() -> dict[str, int]:
    definitions = json.loads(
        (ROOT / "dashboard_definitions.json").read_text(encoding="utf-8")
    )
    session_id = login()
    database_id = find_database(session_id)
    results: dict[str, int] = {}
    for definition in definitions["dashboards"]:
        dashboard = ensure_dashboard(session_id, definition)
        dashboard_id = int(dashboard["id"])
        for card in definition["cards"]:
            ensure_card(session_id, database_id, dashboard_id, card)
        results[definition["name"]] = dashboard_id
        print(
            f"provisioned dashboard={definition['name']!r} "
            f"id={dashboard_id} cards={len(definition['cards'])} "
            f"url={BASE_URL}/dashboard/{dashboard_id}#refresh=600"
        )
    return results


if __name__ == "__main__":
    provision()
