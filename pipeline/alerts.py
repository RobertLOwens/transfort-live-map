"""Transfort rider alerts: scrape, structure, and tie to the GTFS network.

Transfort publishes alerts as an HTML table on its WordPress site (there is no
GTFS-Realtime alerts feed). This module turns that table into structured JSON
the web app can use:

  * which GTFS routes an alert affects (from the route link in each row)
  * what kind of alert it is (detour / stop closure / info / vehicle)
  * effective dates, full text, and linked detour maps
  * which stops it names, matched to GTFS stops by stop number (#1462) or by
    intersection name ("Harmony and Wheaton"), with a role: closed / new / affected

    python -m pipeline.alerts --schedule web/data/schedule.json --out web/data/alerts.json
    python -m pipeline.alerts --html tests/fixtures/rideralerts.html ...   # offline
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path

from bs4 import BeautifulSoup

ALERTS_URL = "https://ridetransfort.com/rider-info-rider-alerts/"

# /routes/<slug>/ on ridetransfort.com -> GTFS route_id
SLUG_TO_ROUTE = {"gold": "GOLD", "horn": "HORN", "foothills-shuttle": "FHS", "max": "MAX",
                 "flex": "FLEX", "ada": "ADA", "ada-shuttle": "ADA"}

KIND_RULES = [  # first match wins; drives icon + colour in the app
    (re.compile(r"detour", re.I), "detour"),
    (re.compile(r"clos", re.I), "closure"),
    (re.compile(r"vehicle", re.I), "vehicle"),
]

DATE_RANGE = re.compile(r"(\d{2}/\d{2}/\d{4})\s*[–—-]\s*(\d{2}/\d{2}/\d{4}|TBD)", re.I)
STOP_CODE = re.compile(r"#\s?(\d{2,5})")
INTERSECTION = re.compile(
    r"([A-Z][A-Za-z.']*(?: [A-Z][A-Za-z.']*)*)\s+(?:&|and)\s+([A-Z][A-Za-z.']*(?: [A-Z][A-Za-z.']*)*)")


def fetch(url: str = ALERTS_URL, timeout: float = 20) -> str:
    import requests
    r = requests.get(url, timeout=timeout, headers={"User-Agent": "transfort-live-map/1.0"})
    r.raise_for_status()
    return r.text


def _iso(mdY: str | None) -> str | None:
    if not mdY or mdY.upper() == "TBD":
        return None
    return dt.datetime.strptime(mdY, "%m/%d/%Y").date().isoformat()


def _route_id(href: str, label: str) -> str | None:
    m = re.search(r"/routes/([^/]+)/?", href or "")
    slug = (m.group(1) if m else label).lower().strip()
    if slug in SLUG_TO_ROUTE:
        return SLUG_TO_ROUTE[slug]
    m = re.search(r"(\d+)$", slug)
    return m.group(1) if m else None


def _kind(title: str) -> str:
    for rx, kind in KIND_RULES:
        if rx.search(title):
            return kind
    return "info"


def _text(el) -> str:
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True)).replace(" .", ".").strip()


def parse(html: str) -> tuple[list[dict], dict[str, list[dict]]]:
    """HTML of the rider-alerts page (or just its table) ->
    (raw alert dicts, {route_id: [detour maps & documents]})."""
    soup = BeautifulSoup(html, "html.parser")
    table = soup.select_one("table.alert-list") or soup.find("table")
    if table is None:
        raise ValueError("no alerts table found — the page layout may have changed")

    alerts: list[dict] = []
    docs: dict[str, list[dict]] = {}   # maps & docs belong to a route, not one alert
    route = None
    for tr in table.select("tbody > tr"):
        th = tr.find("th")
        if th is not None:          # a new route block starts
            a = th.find("a")
            label = th.get_text(" ", strip=True)
            route = _route_id(a.get("href", "") if a else "", label)
        for box in tr.select(".alert"):
            h3 = box.find("h3")
            if box.name == "details":                    # "Rider alert maps & docs"
                for li in box.select("li"):
                    link = li.find("a")
                    rng = DATE_RANGE.search(li.get_text(" ", strip=True))
                    docs.setdefault(route, []).append({
                        "title": _text(link), "url": link.get("href"),
                        "start": _iso(rng.group(1)) if rng else None,
                        "end": _iso(rng.group(2)) if rng else None})
                continue
            dates = h3.select_one(".effective-dates")
            rng = DATE_RANGE.search(dates.get_text(" ", strip=True)) if dates else None
            if dates:
                dates.extract()
            body = box.select_one(".alert-content")
            al = {"type": _text(h3), "routes": [route] if route else [],
                  "start": _iso(rng.group(1)) if rng else None,
                  "end": _iso(rng.group(2)) if rng else None,
                  "text": re.sub(r"\s*Info:\s*ridetransfort\.com\s*$", "", _text(body)) if body else ""}
            alerts.append(al)
    return alerts, docs


def _fnv1a(s: str) -> str:
    """Same 32-bit FNV-1a over UTF-16 code units that the browser computes,
    so an alert keeps its id whether it was built here or fetched live."""
    raw = s.encode("utf-16-le")
    h = 2166136261
    for i in range(0, len(raw), 2):
        h = ((h ^ (raw[i] | raw[i + 1] << 8)) * 16777619) & 0xFFFFFFFF
    return f"{h:08x}"


def merge(alerts: list[dict]) -> list[dict]:
    """The site repeats a shared alert under each route it touches
    ("Routes 6 and HORN detour"); fold those into one alert, many routes."""
    out: dict[tuple, dict] = {}
    for al in alerts:
        key = (al["type"].lower(), al["text"].lower(), al["start"])
        if key not in out:
            out[key] = {**al, "routes": []}
        m = out[key]
        m["routes"] += [r for r in al["routes"] if r not in m["routes"]]
    for al in out.values():
        al["kind"] = _kind(al["type"])
        al["id"] = _fnv1a(f"{al['type']}|{al['text']}|{al['start']}")
    return list(out.values())


def _norm(name: str) -> str:
    name = re.sub(r"\(.*?\)", "", name.lower())
    name = name.replace(" and ", " & ")
    return re.sub(r"\s+", " ", name).strip()


def link_stops(alerts: list[dict], stops: list[dict]) -> None:
    """Attach GTFS stops named in each alert's text, with a role per clause."""
    by_code = {s["code"]: s for s in stops if s.get("code")}
    by_name: dict[str, list[dict]] = {}
    for s in stops:
        n = _norm(s["name"])
        by_name.setdefault(n, []).append(s)
        a, _, b = n.partition(" & ")
        if b:
            by_name.setdefault(f"{b} & {a}", []).append(s)

    for al in alerts:
        found = []
        for clause in re.split(r"(?<=[.;])\s+|\s+(?=Now\b)", al["text"]):
            low = clause.lower()
            role = ("closed" if "closed" in low or "closure" in low else
                    "new" if "new" in low or "servicing" in low else "affected")
            codes = STOP_CODE.findall(clause)
            for code in codes:
                s = by_code.get(code)
                found.append({"id": s["id"] if s else None, "code": code,
                              "name": s["name"] if s else None, "role": role})
            if codes:
                continue                    # a stop number beats a name match
            for a, b in INTERSECTION.findall(clause):
                for s in by_name.get(_norm(f"{a} & {b}"), []):
                    if not al["routes"] or set(s["routes"]) & set(al["routes"]):
                        found.append({"id": s["id"], "code": s["code"], "name": s["name"], "role": role})
        seen, al["stops"] = set(), []
        for f in found:
            k = f["id"] or f["code"]
            if k not in seen:
                seen.add(k)
                al["stops"].append(f)


def build(html: str, stops: list[dict], source: str = ALERTS_URL,
          fetched_at: str | None = None) -> dict:
    raw, docs = parse(html)
    alerts = merge(raw)
    link_stops(alerts, stops)
    order = {"detour": 0, "closure": 1, "info": 2, "vehicle": 3}
    alerts.sort(key=lambda a: (order[a["kind"]], -(int((a["start"] or "0").replace("-", "")))))
    return {"source": source,
            "fetched_at": fetched_at or dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "alerts": alerts, "docs": docs}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--html", help="read a saved page instead of fetching")
    ap.add_argument("--fetched-at", help="ISO timestamp for --html snapshots")
    ap.add_argument("--schedule", default="web/data/schedule.json")
    ap.add_argument("--out", default="web/data/alerts.json")
    a = ap.parse_args(argv)
    html = Path(a.html).read_text() if a.html else fetch()
    stops = json.loads(Path(a.schedule).read_text())["stops"]
    data = build(html, stops, fetched_at=a.fetched_at)
    Path(a.out).write_text(json.dumps(data, indent=1, ensure_ascii=False))
    for al in data["alerts"]:
        st = ", ".join(f"{s['role']}:{s['name'] or '#' + s['code']}" for s in al["stops"])
        print(f"  {al['kind']:<8} {'/'.join(al['routes']):<10} {al['start'] or '':<10} {al['text'][:60]}"
              + (f"  [{st}]" if st else ""))
    for r, ds in data["docs"].items():
        print(f"  map/doc  {r:<10} " + "; ".join(d["title"] for d in ds))
    print(f"{len(data['alerts'])} alerts, {sum(map(len, data['docs'].values()))} maps/docs → {a.out}")


if __name__ == "__main__":
    main()
