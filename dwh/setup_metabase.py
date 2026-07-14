"""Idempotently initialize Metabase and register the Telecom DWH database."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request


BASE_URL = os.getenv("METABASE_URL", "http://metabase:3000").rstrip("/")
DATABASE_NAME = "Telecom DWH"


def request(method: str, path: str, payload=None, session_id: str | None = None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if session_id:
        headers["X-Metabase-Session"] = session_id
    req = urllib.request.Request(
        BASE_URL + path, data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            body = response.read()
            return json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Metabase {method} {path} failed: {exc.code} {body}") from exc


def wait_for_metabase(attempts: int = 90) -> None:
    for _ in range(attempts):
        try:
            if request("GET", "/api/health").get("status") == "ok":
                return
        except (OSError, RuntimeError, AttributeError):
            pass
        time.sleep(2)
    raise TimeoutError("Metabase did not become healthy")


def database_payload() -> dict[str, object]:
    return {
        "engine": "postgres",
        "name": DATABASE_NAME,
        "details": {
            "host": os.getenv("DWH_POSTGRES_HOST", "postgres-dwh"),
            "port": int(os.getenv("DWH_POSTGRES_PORT", "5432")),
            "dbname": os.getenv("DWH_POSTGRES_DB", "telecom_dwh"),
            "user": os.environ["DWH_POSTGRES_USER"],
            "password": os.environ["DWH_POSTGRES_PASSWORD"],
            "ssl": False,
        },
    }


def initialize() -> None:
    wait_for_metabase()
    email = os.environ["MB_ADMIN_EMAIL"]
    password = os.environ["MB_ADMIN_PASSWORD"]
    properties = request("GET", "/api/session/properties")
    token = properties.get("setup-token")

    if token:
        request(
            "POST",
            "/api/setup",
            {
                "token": token,
                "user": {
                    "email": email,
                    "first_name": "Telecom",
                    "last_name": "Admin",
                    "password": password,
                    "site_name": os.getenv("MB_SITE_NAME", "Telecom Analytics"),
                },
                "prefs": {
                    "site_name": os.getenv("MB_SITE_NAME", "Telecom Analytics"),
                    "allow_tracking": False,
                },
                "database": database_payload(),
            },
        )
        print("Metabase initialized; Telecom DWH registered")
        return

    session = request(
        "POST", "/api/session", {"username": email, "password": password}
    )["id"]
    databases = request("GET", "/api/database", session_id=session)
    entries = databases.get("data", databases) if isinstance(databases, dict) else databases
    if any(database.get("name") == DATABASE_NAME for database in entries):
        print("Metabase already initialized; Telecom DWH already registered")
        return
    request("POST", "/api/database", database_payload(), session_id=session)
    print("Metabase already initialized; Telecom DWH registered")


if __name__ == "__main__":
    initialize()
