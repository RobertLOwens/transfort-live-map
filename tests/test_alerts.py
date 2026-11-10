"""pytest tests/ — alert scraping against a saved copy of the Transfort page."""
import json
from pathlib import Path

from pipeline import alerts

FX = Path(__file__).parent / "fixtures"
STOPS = json.loads((Path(__file__).parents[1] / "web/data/schedule.json").read_text())["stops"]


def built():
    return alerts.build((FX / "rideralerts.html").read_text(), STOPS, fetched_at="2026-11-03T17:05:00+00:00")


def test_shared_alerts_are_merged_across_routes():
    d = built()
    detour = next(a for a in d["alerts"] if a["text"].startswith("Routes 6 and HORN"))
    assert sorted(detour["routes"]) == ["6", "HORN"]
    assert detour["kind"] == "detour" and detour["start"] == "2026-10-05" and detour["end"] is None


def test_stop_numbers_and_intersections_link_to_gtfs():
    d = built()
    by_text = {a["text"][:12]: a for a in d["alerts"]}
    rt81 = {s["code"]: s["role"] for s in by_text["Rt 81 Colleg"]["stops"]}
    assert rt81 == {"1462": "closed", "1699": "new"}
    closure = by_text["Route 16 sto"]["stops"]
    assert [s["name"] for s in closure] == ["Harmony & Wheaton (e Of)"] and closure[0]["role"] == "closed"
    new_stop = by_text["Route 3 serv"]["stops"][0]
    assert new_stop["code"] == "244" and new_stop["id"] is None      # not in the GTFS yet


def test_maps_and_docs_belong_to_routes():
    docs = built()["docs"]
    assert [d["title"] for d in docs["HORN"]] == ["SB HORN Engineering Lot Detour", "NB HORN Engineering Lot Detour"]
    assert docs["HORN"][0]["start"] == "2026-10-20"


def test_layout_change_is_reported():
    try:
        alerts.parse("<html><body>No table</body></html>")
    except ValueError as e:
        assert "layout" in str(e)
    else:
        raise AssertionError("expected ValueError")
