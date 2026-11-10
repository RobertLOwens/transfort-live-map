"""GTFS loading and schedule compaction.

Turns a raw GTFS zip into compact, browser-friendly structures:
  * routes   – metadata + derived stats (stops, trips/day, service span, headway)
  * stops    – location + routes served
  * patterns – unique ordered stop sequences per route/direction/headsign
  * trips    – [pattern, service, start_minute, *minute_deltas]
  * calendar – weekly service patterns + date exceptions
"""
from __future__ import annotations

import datetime as dt
import io
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

GTFS_DTYPES = {
    "route_id": str, "trip_id": str, "stop_id": str, "service_id": str,
    "shape_id": str, "stop_code": str, "block_id": str,
}


def read_gtfs(path: str | Path) -> dict[str, pd.DataFrame]:
    """Read every .txt table from a GTFS zip (or folder) into DataFrames."""
    path = Path(path)
    tables: dict[str, pd.DataFrame] = {}
    if path.suffix == ".zip":
        with zipfile.ZipFile(path) as zf:
            for name in zf.namelist():
                if name.endswith(".txt"):
                    with zf.open(name) as fh:
                        tables[Path(name).stem] = pd.read_csv(
                            io.TextIOWrapper(fh, "utf-8-sig"), dtype=GTFS_DTYPES)
    else:
        for f in path.glob("*.txt"):
            tables[f.stem] = pd.read_csv(f, dtype=GTFS_DTYPES, encoding="utf-8-sig")
    required = {"routes", "trips", "stop_times", "stops", "calendar"}
    missing = required - tables.keys()
    if missing:
        raise ValueError(f"GTFS feed missing tables: {sorted(missing)}")
    return tables


ID_COLS = {   # table -> columns holding ids that must stay unique across feeds
    "routes": ["route_id", "agency_id"], "trips": ["route_id", "trip_id", "service_id", "shape_id", "block_id"],
    "stop_times": ["trip_id", "stop_id"], "stops": ["stop_id", "parent_station"], "shapes": ["shape_id"],
    "calendar": ["service_id"], "calendar_dates": ["service_id"], "agency": ["agency_id"],
}


def merge_feeds(base: dict[str, pd.DataFrame], extra: dict[str, pd.DataFrame],
                prefix: str, routes: list[str] | None = None) -> dict[str, pd.DataFrame]:
    """Fold selected routes from a second GTFS feed (e.g. CDOT Bustang) into the
    base feed. Every id in the extra feed is prefixed so nothing collides, and
    only the stops, shapes and services those routes use come along."""
    ex = {k: v.copy() for k, v in extra.items() if k in ID_COLS}
    if routes:
        ex["routes"] = ex["routes"][ex["routes"]["route_id"].isin(routes)]
        missing = set(routes) - set(ex["routes"]["route_id"])
        if missing:
            raise ValueError(f"routes not in the extra feed: {sorted(missing)}")
    ex["trips"] = ex["trips"][ex["trips"]["route_id"].isin(ex["routes"]["route_id"])]
    ex["stop_times"] = ex["stop_times"][ex["stop_times"]["trip_id"].isin(ex["trips"]["trip_id"])]
    ex["stops"] = ex["stops"][ex["stops"]["stop_id"].isin(ex["stop_times"]["stop_id"])]
    if "shapes" in ex:
        ex["shapes"] = ex["shapes"][ex["shapes"]["shape_id"].isin(ex["trips"]["shape_id"])]
    svcs = set(ex["trips"]["service_id"])
    for k in ("calendar", "calendar_dates"):
        if k in ex:
            ex[k] = ex[k][ex[k]["service_id"].astype(str).isin(svcs)]
    for k, cols in ID_COLS.items():
        if k not in ex:
            continue
        for c in cols:
            if c in ex[k]:
                ex[k][c] = ex[k][c].map(lambda v: v if pd.isna(v) or v == "" else f"{prefix}{v}")
    out = dict(base)
    for k, v in ex.items():
        if k in out:
            out[k] = pd.concat([out[k].astype({c: str for c in ID_COLS.get(k, []) if c in out[k]}),
                                v.astype({c: str for c in ID_COLS.get(k, []) if c in v})], ignore_index=True)
        else:
            out[k] = v
    return out


def gtfs_time_to_minutes(series: pd.Series) -> pd.Series:
    """'25:14:00' -> 1514. GTFS times can exceed 24h for after-midnight trips."""
    parts = series.str.split(":", expand=True).astype(int)
    return parts[0] * 60 + parts[1] + (parts[2] >= 30).astype(int)


def title_case(s: str) -> str:
    small = {"&", "of", "and"}
    keep_upper = {"CSU", "VTH", "MAX", "ADA", "FHS", "US", "II"}
    words = []
    for w in str(s).split():
        if w.upper() in keep_upper:
            words.append(w.upper())
        elif w.lower() in small:
            words.append(w.lower())
        else:
            words.append("-".join(part.capitalize() for part in w.split("-")))   # Broomfield-Thornton
    return " ".join(words)


def representative_tuesday(calendar: dict) -> str:
    start = max(dt.date.today(), min(dt.datetime.strptime(c["start"], "%Y%m%d").date()
                                     for c in calendar.values()))
    start += dt.timedelta(days=(1 - start.weekday()) % 7)
    return start.strftime("%Y%m%d")


def active_services(calendar: dict, exceptions: dict, ymd: str) -> set[int]:
    """Service indices running on a date (YYYYMMDD) — same logic the web app uses."""
    wd = dt.datetime.strptime(ymd, "%Y%m%d").weekday()
    on = {s for s, c in calendar.items()
          if c["days"][wd] == "1" and c["start"] <= ymd <= c["end"]}
    ex = exceptions.get(ymd, {})
    return (on | set(ex.get("add", []))) - set(ex.get("remove", []))


def build_schedule(t: dict[str, pd.DataFrame]) -> dict:
    routes, trips, st, stops = t["routes"], t["trips"], t["stop_times"], t["stops"]

    st = st.copy()
    st["arr"] = gtfs_time_to_minutes(st["arrival_time"].fillna(st["departure_time"]))
    st["dep"] = gtfs_time_to_minutes(st["departure_time"].fillna(st["arrival_time"]))
    st = st.sort_values(["trip_id", "stop_sequence"])

    # ---- stops: index them so the browser references ints, not strings
    stops = stops[stops.get("location_type", 0).fillna(0).astype(int) == 0].copy()
    stops = stops.sort_values("stop_name").reset_index(drop=True)
    stop_idx = {sid: i for i, sid in enumerate(stops["stop_id"])}

    # ---- patterns: one per unique (route, direction, headsign, stop sequence)
    seq = (st.groupby("trip_id")["stop_id"].apply(tuple).rename("seq"))
    tt = trips.set_index("trip_id").join(seq, how="inner")
    tt["trip_headsign"] = tt["trip_headsign"].fillna("").map(title_case)
    tt["direction_id"] = tt.get("direction_id", 0).fillna(0).astype(int)
    key_cols = ["route_id", "direction_id", "trip_headsign", "seq"]
    pattern_keys = tt[key_cols].drop_duplicates().reset_index(drop=True)
    pattern_keys["pid"] = pattern_keys.index
    tt = tt.reset_index().merge(pattern_keys, on=key_cols, how="left")

    # representative trip per pattern (used by geo.py to cut the pattern's shape)
    rep_trip = tt.groupby("pid")["trip_id"].first()
    patterns = [
        {"r": r.route_id, "d": int(r.direction_id), "h": r.trip_headsign,
         "s": [stop_idx[s] for s in r.seq], "_trip": rep_trip[r.pid]}
        for r in pattern_keys.itertuples()
    ]

    # ---- services: index service_ids
    service_ids = sorted(set(trips["service_id"]), key=lambda x: (len(x), x))
    svc_idx = {s: i for i, s in enumerate(service_ids)}

    # ---- trips: delta-encoded departure minutes (very compact JSON)
    times = st.groupby("trip_id")["dep"].apply(lambda s: s.to_numpy())
    tt = tt.set_index("trip_id").join(times.rename("times"), how="inner")
    tt["start"] = tt["times"].map(lambda a: int(a[0]))
    tt = tt.sort_values(["pid", "start"])
    trip_rows = []
    for r in tt.itertuples():
        a = r.times
        trip_rows.append([int(r.pid), svc_idx[r.service_id], int(a[0]),
                          *np.diff(a).astype(int).tolist()])

    # ---- calendar
    cal = t["calendar"]
    days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    calendar = {}
    for r in cal.itertuples():
        calendar[svc_idx.get(str(r.service_id), -1)] = {
            "days": "".join(str(int(getattr(r, d))) for d in days),
            "start": str(r.start_date), "end": str(r.end_date)}
    calendar.pop(-1, None)
    exceptions: dict[str, dict[str, list[int]]] = {}
    if "calendar_dates" in t:
        for r in t["calendar_dates"].itertuples():
            if str(r.service_id) not in svc_idx:
                continue
            bucket = exceptions.setdefault(str(r.date), {"add": [], "remove": []})
            bucket["add" if int(r.exception_type) == 1 else "remove"].append(
                svc_idx[str(r.service_id)])

    # ---- route stats for a representative weekday: the first Tuesday on/after
    # max(today, feed start), resolved through calendar + calendar_dates.
    weekday_svcs = active_services(calendar, exceptions, representative_tuesday(calendar))
    tt["svc"] = tt["service_id"].map(svc_idx)
    wk = tt[tt["svc"].isin(weekday_svcs)]
    route_stats = {}
    for rid, g in wk.groupby("route_id"):
        starts = np.sort(g["start"].to_numpy())
        ends = g["times"].map(lambda a: int(a[-1])).to_numpy()
        # midday headway: departures of the busiest pattern between 10:00 and 14:00
        busiest = g["pid"].value_counts().idxmax()
        mid = np.unique(g.loc[(g["pid"] == busiest) & g["start"].between(600, 840), "start"])
        headway = int(np.median(np.diff(mid))) if len(mid) > 2 else None
        route_stats[rid] = {"tripsWeekday": int(len(g)), "first": int(starts.min()),
                            "last": int(ends.max()), "headway": headway}

    # ---- agencies (a merged feed can carry several)
    ag = t.get("agency")
    agency_names = ({str(a.agency_id): a.agency_name for a in ag.itertuples()}
                    if ag is not None and "agency_id" in ag else {})
    primary_agency = ag.iloc[0].agency_name if ag is not None and len(ag) else ""

    # ---- routes: friendly names built from the most common headsigns per direction
    route_out = []
    stops_by_route: dict[str, set[int]] = {}
    for p in patterns:
        stops_by_route.setdefault(p["r"], set()).update(p["s"])
    for r in routes.itertuples():
        g = tt[tt["route_id"] == r.route_id]
        if g.empty:
            continue
        ends = (g.groupby("direction_id")["trip_headsign"]
                .agg(lambda s: s.value_counts().idxmax()).tolist())
        ends = list(dict.fromkeys(ends))
        long_name = title_case(r.route_long_name)
        desc = " ↔ ".join(ends) if ends else long_name
        route_out.append({
            "id": r.route_id, "short": str(r.route_short_name),
            "agency": agency_names.get(str(getattr(r, "agency_id", "")), primary_agency),
            "long": long_name, "desc": desc,
            "color": "#" + str(r.route_color or "888888").lower(),
            "text": "#" + str(r.route_text_color or "000000").lower(),
            "nStops": len(stops_by_route.get(r.route_id, ())),
            **route_stats.get(r.route_id, {}),
        })

    def route_sort(rt):
        s = rt["short"]
        return (0, int(s), "") if s.isdigit() else (1, 0, s)
    route_out.sort(key=route_sort)

    # stop -> routes served
    stop_routes: dict[int, set[str]] = {}
    for p in patterns:
        for s in p["s"]:
            stop_routes.setdefault(s, set()).add(p["r"])
    order = {rt["id"]: i for i, rt in enumerate(route_out)}
    stop_out = [
        {"id": r.stop_id, "code": "" if pd.isna(r.stop_code) else str(r.stop_code),
         "name": title_case(r.stop_name), "lat": round(float(r.stop_lat), 6),
         "lon": round(float(r.stop_lon), 6),
         "routes": sorted(stop_routes.get(i, ()), key=lambda x: order.get(x, 99))}
        for i, r in enumerate(stops.itertuples())
    ]

    feed = t.get("feed_info")
    feed_meta = {}
    if feed is not None and len(feed):
        f = feed.iloc[0]
        feed_meta = {"start": str(f.get("feed_start_date", "")),
                     "end": str(f.get("feed_end_date", "")),
                     "version": str(f.get("feed_version", ""))}
    agency = t["agency"].iloc[0] if "agency" in t else None

    return {
        "agency": {"name": agency.agency_name if agency is not None else "",
                   "tz": agency.agency_timezone if agency is not None else "America/Denver",
                   "url": agency.agency_url if agency is not None else ""},
        "feed": feed_meta,
        "routes": route_out, "stops": stop_out, "patterns": patterns,
        "trips": trip_rows, "calendar": calendar, "exceptions": exceptions,
    }
