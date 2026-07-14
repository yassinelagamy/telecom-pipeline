from datetime import date

from dwh.seed import date_rows, subscriber_rows, tower_rows


def test_subscriber_seed_contract():
    rows = list(subscriber_rows())
    assert len(rows) == 5_000
    assert rows[0][0] == "SUB-000001"
    assert rows[-1][0] == "SUB-005000"
    assert len({row[0] for row in rows}) == 5_000


def test_tower_seed_contract():
    rows = list(tower_rows())
    assert len(rows) == 200
    assert rows[0][0] == "TWR-0001"
    assert rows[-1][0] == "TWR-0200"
    assert len({row[0] for row in rows}) == 200


def test_date_seed_contract_and_iso_weekends():
    rows = list(date_rows())
    assert len(rows) == 1_095
    assert rows[0][0:2] == (20250101, date(2025, 1, 1))
    assert rows[-1][0:2] == (20271231, date(2027, 12, 31))
    saturday = next(row for row in rows if row[1] == date(2025, 1, 4))
    assert saturday[5:] == (6, True)
