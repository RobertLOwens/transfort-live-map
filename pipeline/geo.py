"""GIS processing: route geometries from GTFS shapes + a vector basemap.

Everything is done in a projected CRS (UTM 13N, metres) so that simplification
tolerances and lengths are real-world distances, then reprojected to WGS84
and coordinate-rounded for the web.
"""
from __future__ import annotations

import json

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import LineString, MultiLineString, box, mapping
from pyproj import Transformer
from shapely.ops import linemerge, unary_union

from . import bundling, crossings, hubs, oneway

WGS84 = "EPSG:4326"
UTM13N = "EPSG:26913"   # metric CRS for northern Colorado


def _round_coords(geom_json: dict, nd: int = 5) -> dict:
    def rnd(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], nd), round(c[1], nd)]
        return [rnd(x) for x in c]
    geom_json["coordinates"] = rnd(geom_json["coordinates"])
    return geom_json


def _merge(geoms):
    """Dissolve overlapping lines, then stitch pieces into long polylines."""
    u = unary_union(list(geoms))
    return linemerge(u) if u.geom_type == "MultiLineString" else u


def route_geometries(t: dict[str, pd.DataFrame], order: list[str] | None = None,
                     smart_order=True, hub_list: list[dict] | None = None) -> tuple[dict, dict]:
    """One merged line set per route (all its shape variants), bundled so that
    routes sharing a street get parallel slots (see bundling.py).

    Each feature carries `o`: per part, per vertex slot offsets for the browser."""
    shapes = t["shapes"].sort_values(["shape_id", "shape_pt_sequence"])
    lines = (shapes.groupby("shape_id")[["shape_pt_lon", "shape_pt_lat"]]
             .apply(lambda d: LineString(d.to_numpy())))
    gshapes = gpd.GeoDataFrame(geometry=lines, crs=WGS84).to_crs(UTM13N)

    trips = t["trips"].dropna(subset=["shape_id"])
    shape_route = trips.drop_duplicates("shape_id").set_index("shape_id")["route_id"]
    gshapes["route_id"] = gshapes.index.map(shape_route)
    gshapes = gshapes.dropna(subset=["route_id"])

    route_lines, lengths = {}, {}
    for rid, g in gshapes.groupby("route_id"):
        # unary_union dissolves overlapping variants (shared trunk segments) into
        # one clean network; linemerge stitches pieces back into long polylines.
        merged = _merge(g.geometry).simplify(1.0)
        parts = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
        route_lines[rid] = [p for p in parts if not p.is_empty and p.length > 0]
        lengths[rid] = round(g.geometry.length.max() / 1000, 1)  # longest variant, km

    bundled = bundling.bundle(route_lines, order or sorted(route_lines), smart_order=smart_order)
    if hub_list:   # schematic transit centers: spokes instead of the bus-bay knot
        bundled = {rid: hubs.apply(parts, rid, hub_list) for rid, parts in bundled.items()}
    # one-way stretches: where a route's two directions didn't merge onto one line
    shapes_by_route = {rid: list(g.geometry) for rid, g in gshapes.groupby("route_id")}
    directed = {}
    for rid, parts in bundled.items():
        zones = [(np.array([h["x"], h["y"]]), 1.8 * h["r"]) for h in (hub_list or []) if rid in h["routes"]]
        directed[rid] = oneway.flags(parts, shapes_by_route.get(rid, []), zones)
    n_oneway = sum(float(np.sum(np.linalg.norm(np.diff(xy, axis=0), axis=1)[dr[:-1] != 0]))
                   for parts in directed.values() for xy, _, dr in parts)
    st = bundling.STATS
    print(f"  one-way: {n_oneway / 1000:.1f} km of route drawn as one-way")
    print(f"  bundling: {st['nodes']:,} corridor nodes, {st['shared_nodes']:,} shared, "
          f"{st['runs']} ordered runs, {crossings.count(bundled, near=st['shared_xy'])} "
          f"line crossings inside shared corridors")
    to_wgs = Transformer.from_crs(UTM13N, WGS84, always_xy=True)
    features = []
    for rid, parts in directed.items():
        coords, offs, dirs = [], [], []
        for xy, slot, dr in parts:
            lon, lat = to_wgs.transform(xy[:, 0], xy[:, 1])
            coords.append([[round(a, 5), round(b, 5)] for a, b in zip(lon, lat)])
            offs.append([round(float(v), 2) for v in slot])
            dirs.append([int(v) for v in dr])
        features.append({"type": "Feature", "properties": {"route": rid, "o": offs, "d": dirs},
                         "geometry": {"type": "MultiLineString", "coordinates": coords}})
    return {"type": "FeatureCollection", "features": features}, lengths


def pattern_geometries(t: dict[str, pd.DataFrame], patterns: list[dict],
                       tolerance_m: float = 5.0) -> None:
    """Attach a simplified polyline + each stop's position along it (0..1) to
    every pattern, so the browser can interpolate scheduled bus positions.

    Uses GTFS shape_dist_traveled when present, else projects stops onto the line.
    """
    shapes = t["shapes"].sort_values(["shape_id", "shape_pt_sequence"])
    by_shape = dict(tuple(shapes.groupby("shape_id")))
    trips = t["trips"].set_index("trip_id")
    st = t["stop_times"]
    st = st[st["trip_id"].isin({p["_trip"] for p in patterns})].sort_values(
        ["trip_id", "stop_sequence"])
    st_by_trip = dict(tuple(st.groupby("trip_id")))
    stops = t["stops"].set_index("stop_id")

    for p in patterns:
        trip_id = p.pop("_trip")
        shp = by_shape.get(trips.at[trip_id, "shape_id"])
        if shp is None:
            continue
        line_wgs = LineString(shp[["shape_pt_lon", "shape_pt_lat"]].to_numpy())
        line = gpd.GeoSeries([line_wgs], crs=WGS84).to_crs(UTM13N).iloc[0]
        sts = st_by_trip[trip_id]
        if "shape_dist_traveled" in sts and sts["shape_dist_traveled"].notna().all() \
                and "shape_dist_traveled" in shp and shp["shape_dist_traveled"].notna().all():
            total = float(shp["shape_dist_traveled"].iloc[-1]) or 1.0
            frac = (sts["shape_dist_traveled"].astype(float) / total).clip(0, 1).tolist()
        else:  # fall back to linear referencing of stop points
            pts = gpd.GeoSeries(gpd.points_from_xy(stops.loc[sts["stop_id"], "stop_lon"],
                                                   stops.loc[sts["stop_id"], "stop_lat"]),
                                crs=WGS84).to_crs(UTM13N)
            frac = [line.project(pt, normalized=True) for pt in pts]
        frac = list(pd.Series(frac).cummax())  # positions must be monotonic
        simple = gpd.GeoSeries([line.simplify(tolerance_m)], crs=UTM13N).to_crs(WGS84).iloc[0]
        p["g"] = [[round(x, 5), round(y, 5)] for x, y in simple.coords]
        p["f"] = [round(f, 4) for f in frac]


STREET_CLASS = {   # draw order / emphasis in the basemap
    "INTERSTATE": 4, "HIGHWAY": 4, "HIGHWAY DIVIDED": 4, "RAMP": 3,
    "ARTERIAL MAJOR": 3, "ARTERIAL": 2, "COLLECTOR": 1, "ROUNDABOUT": 1,
    "LOCAL": 0, "GUIDEWAY": 2,
}


def basemap(streets_path: str, natural_path: str | None, network_bounds,
            pad_m: float = 2500) -> dict:
    """Clip city street centerlines (+ natural areas) to the transit network
    extent, dissolve by class, simplify and return compact GeoJSON layers."""
    streets = gpd.read_file(streets_path).to_crs(UTM13N)
    streets = streets[streets["STREETTYPE"].isin(STREET_CLASS)]  # drops alleys
    streets["cls"] = streets["STREETTYPE"].map(STREET_CLASS)

    minx, miny, maxx, maxy = gpd.GeoSeries([box(*network_bounds)], crs=WGS84) \
        .to_crs(UTM13N).total_bounds
    clip = box(minx - pad_m, miny - pad_m, maxx + pad_m, maxy + pad_m)
    streets = streets.clip(clip)

    layers = {}
    feats = []
    for cls, g in streets.groupby("cls"):
        tol = 6.0 if cls == 0 else 4.0
        merged = _merge(g.geometry).simplify(tol)
        geom = gpd.GeoSeries([merged], crs=UTM13N).to_crs(WGS84).iloc[0]
        feats.append({"type": "Feature", "properties": {"cls": int(cls)},
                      "geometry": _round_coords(mapping(geom))})
    layers["streets"] = {"type": "FeatureCollection", "features": feats}

    # major-street labels: one label point per named arterial (longest piece)
    major = streets[streets["cls"] >= 2].copy()
    major["name"] = (major["FENAME"].fillna("").str.title() + " " +
                     major["FTYPE"].fillna("").str.title()).str.strip()
    labels = []
    for name, g in major.groupby("name"):
        if name.isdigit():           # bare highway numbers in FENAME
            name = "I-25" if name == "25" else ""
        if not name:
            continue
        total = g.geometry.length.sum()
        if total < 2500:
            continue
        line = _merge(g.geometry)
        parts = list(line.geoms) if hasattr(line, "geoms") else [line]
        longest = max(parts, key=lambda p: p.length)
        pt = gpd.GeoSeries([longest.interpolate(0.5, normalized=True)], crs=UTM13N) \
            .to_crs(WGS84).iloc[0]
        labels.append({"n": name, "lat": round(pt.y, 5), "lon": round(pt.x, 5),
                       "len": round(total)})
    layers["labels"] = sorted(labels, key=lambda d: -d["len"])[:40]

    if natural_path:
        nat = gpd.read_file(natural_path).to_crs(UTM13N).clip(clip)
        nat = nat[nat.geometry.area > 20000]
        nat["geometry"] = nat.geometry.simplify(10)
        nat = nat.to_crs(WGS84)
        layers["natural"] = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"name": str(r.NA_NAME).title()},
             "geometry": _round_coords(mapping(r.geometry))}
            for r in nat.itertuples() if r.geometry is not None and not r.geometry.is_empty]}
    return layers


def city_context(cities_path: str, routes_geo: dict, route_ids: list[str],
                 buffer_m: float = 3000, tol_m: float = 60) -> dict:
    """Municipal boundaries along the regional routes (e.g. Bustang to Denver),
    for context where the street basemap doesn't reach: faint outlines plus one
    label per town at a point guaranteed inside it."""
    from shapely.geometry import shape
    lines = [shape(f["geometry"]) for f in routes_geo["features"] if f["properties"]["route"] in route_ids]
    if not lines:
        return {}
    corridor = gpd.GeoSeries(lines, crs=WGS84).to_crs(UTM13N).union_all().buffer(buffer_m)
    cities = gpd.read_file(cities_path).to_crs(UTM13N)
    cities = cities[cities.intersects(corridor)].copy()
    name_col = "NAME10" if "NAME10" in cities else cities.columns[0]
    cities["geometry"] = cities.geometry.simplify(tol_m)
    cities = cities[cities.geometry.area > 2e6]                       # skip slivers & tiny towns
    labels = []
    for r in cities.itertuples():
        pt = gpd.GeoSeries([r.geometry.representative_point()], crs=UTM13N).to_crs(WGS84).iloc[0]
        labels.append({"n": getattr(r, name_col), "lat": round(pt.y, 4), "lon": round(pt.x, 4),
                       "area": round(r.geometry.area / 1e6, 1)})
    out = cities.to_crs(WGS84)
    return {"cities": {"type": "FeatureCollection", "features": [
                {"type": "Feature", "properties": {"name": getattr(r, name_col)},
                 "geometry": _round_coords(mapping(r.geometry), 4)} for r in out.itertuples()]},
            "cityLabels": sorted(labels, key=lambda d: -d["area"])}


def dumps(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
