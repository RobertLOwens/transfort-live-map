"""Bike layer: the city's bike network, bike parking, and bus-stop amenities.

Sources
  * City of Fort Collins GIS — Bike_Facilities (on-street) and Trails (off-street)
  * OpenStreetMap (via Overpass) — amenity=bicycle_parking, and highway=bus_stop
    nodes with shelter / bench / lit / bin / bicycle_parking tags

Outputs one compact JSON for the browser:
  network   line features by facility class, dissolved per (class, name, comfort)
  parking   bike parking sites with capacity / covered / rack type where known
  stops     per GTFS stop: OSM amenities + bike parking within 100 m
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
from shapely.geometry import mapping
from shapely.ops import linemerge, unary_union

from .geo import UTM13N, WGS84, _round_coords

# draw order (low → high) and labels; the browser styles by class
CLASSES = {
    "shared":    "Shared lane (sharrows)",
    "bikeway":   "Neighborhood bikeway",
    "lane":      "Bike lane",
    "protected": "Protected / buffered bike lane",
    "trail_soft": "Unpaved trail",
    "trail":     "Paved trail",
}


def _on_street_class(r) -> str | None:
    if str(r.get("BUILTSTATU", "BUILT")).upper() != "BUILT" or str(r.get("NORIDE", "N")).upper() == "Y":
        return None
    f = str(r.get("EXISTINGFA", "")).strip()
    if f in ("PBL", "BBL"):
        return "protected"
    if f == "BL":
        return "lane"
    if f == "City BR" or str(r.get("BIKEWAY", "")).upper() == "YES":
        return "bikeway"
    if f in ("SHRR", "Sharrow"):
        return "shared"
    return None


def network(facilities_path: str, trails_path: str | None, tol_m: float = 3.0) -> dict:
    fac = gpd.read_file(facilities_path).to_crs(UTM13N)
    fac["cls"] = fac.apply(_on_street_class, axis=1)
    fac = fac.dropna(subset=["cls"])
    fac["comfort"] = np.where(fac["BIKEMAPCLA"].fillna("").str.startswith("LC"), "low", "high")
    fac["name"] = fac["BIKEWAYNAM"].fillna("").map(lambda n: f"{n} Bikeway" if n else "")
    fac.loc[fac["name"] == "", "name"] = fac["STRNAME"].fillna("").str.title()
    frames = [fac[["cls", "comfort", "name", "geometry"]]]

    if trails_path:
        tr = gpd.read_file(trails_path).to_crs(UTM13N)
        tr = tr[tr["BIKEUSE"].str.lower() == "yes"].copy()
        tr["cls"] = np.where(tr["SURFACE"].str.lower() == "hard", "trail", "trail_soft")
        tr["comfort"] = "high"
        label = tr["TRAILLABEL"].fillna(tr["BIKEWAYNAM"]).fillna("")
        tr["name"] = label.where(~label.str.startswith("NONE"), "")
        frames.append(tr[["cls", "comfort", "name", "geometry"]])

    allf = pd.concat(frames, ignore_index=True)
    feats, km = [], {}
    for (cls, comfort, name), g in allf.groupby(["cls", "comfort", "name"]):
        geom = unary_union(list(g.geometry))
        if geom.geom_type == "MultiLineString":
            geom = linemerge(geom)
        geom = geom.simplify(tol_m)
        if geom.is_empty:
            continue
        km[cls] = km.get(cls, 0) + geom.length / 1000
        geom = gpd.GeoSeries([geom], crs=UTM13N).to_crs(WGS84).iloc[0]
        feats.append({"type": "Feature", "properties": {"c": cls, "comfort": comfort, "n": name},
                      "geometry": _round_coords(mapping(geom))})
    order = list(CLASSES)
    feats.sort(key=lambda f: order.index(f["properties"]["c"]))
    return {"type": "FeatureCollection", "features": feats}, {k: round(v, 1) for k, v in km.items()}


def _osm(tsv: str) -> pd.DataFrame:
    d = pd.read_csv(tsv, sep="\t", dtype=str)
    d = d.rename(columns={"@type": "type", "@id": "id", "@lat": "lat", "@lon": "lon"})
    d["lat"], d["lon"] = d["lat"].astype(float), d["lon"].astype(float)
    return d


def parking(osm: pd.DataFrame) -> list[dict]:
    bp = osm[osm["amenity"] == "bicycle_parking"]
    out = []
    for r in bp.itertuples():
        cap = pd.to_numeric(r.capacity, errors="coerce")
        out.append({"lat": round(r.lat, 6), "lon": round(r.lon, 6),
                    "cap": None if pd.isna(cap) else int(cap),
                    "cov": None if pd.isna(r.covered) else r.covered == "yes",
                    "kind": None if pd.isna(r.bicycle_parking) else r.bicycle_parking.replace("_", " "),
                    "acc": None if pd.isna(r.access) or r.access == "yes" else r.access,
                    "osm": f"{r.type}/{r.id}"})
    return out


def stop_amenities(osm: pd.DataFrame, stops: list[dict], parks: list[dict],
                   snap_m: float = 25.0, near_m: float = 100.0) -> tuple[dict, dict]:
    """Match OSM bus stops to GTFS stops (stop number = OSM `ref`, else nearest
    within `snap_m`), and count public bike parking within `near_m`."""
    to_utm = lambda lon, lat: gpd.GeoSeries(gpd.points_from_xy(lon, lat), crs=WGS84).to_crs(UTM13N)
    bs = osm[osm["highway"] == "bus_stop"].copy()
    bxy = to_utm(bs["lon"], bs["lat"])
    btree = cKDTree(np.column_stack([bxy.x, bxy.y]))
    by_ref = {str(r).strip(): i for i, r in enumerate(bs["ref"]) if isinstance(r, str)}
    sxy = to_utm([s["lon"] for s in stops], [s["lat"] for s in stops])
    sxy = np.column_stack([sxy.x, sxy.y])
    pub = [p for p in parks if p["acc"] not in ("private", "customers")]
    pxy = to_utm([p["lon"] for p in pub], [p["lat"] for p in pub]) if pub else None
    ptree = cKDTree(np.column_stack([pxy.x, pxy.y])) if pub else None

    out, stats = {}, {"matched_ref": 0, "matched_near": 0}
    for k, s in enumerate(stops):
        i = by_ref.get(str(s.get("code", "")))
        how = "ref"
        if i is None:
            dist, j = btree.query(sxy[k])
            i, how = (j, "near") if dist <= snap_m else (None, None)
        rec = {}
        if i is not None:
            r = bs.iloc[i]
            for tag, key in (("shelter", "shelter"), ("bench", "bench"), ("lit", "lit"),
                             ("bin", "bin"), ("bicycle_parking", "bike")):
                v = r.get(tag)
                if tag == "bin" and pd.isna(v):
                    v = r.get("waste_basket")
                if isinstance(v, str) and v in ("yes", "no"):
                    rec[key] = v == "yes"
            rec["osm"] = f"node/{r['id']}"
            stats["matched_" + how] += 1
        if ptree is not None:
            near = ptree.query_ball_point(sxy[k], r=near_m)
            if near:
                caps = [pub[j]["cap"] for j in near if pub[j]["cap"]]
                rec["nearby"] = {"sites": len(near), "spaces": sum(caps) if caps else None}
        if rec:
            out[s["id"]] = rec
    return out, stats


def build(facilities: str, trails: str | None, osm_tsv: str | None, stops: list[dict]) -> dict:
    net, km = network(facilities, trails)
    data = {"classes": CLASSES, "network": net, "km": km,
            "built": dt.date.today().isoformat(), "sources": {
                "network": "City of Fort Collins GIS (Bike Facilities, Trails)",
                "osm": "© OpenStreetMap contributors (ODbL)"}}
    if osm_tsv:
        osm = _osm(osm_tsv)
        parks = parking(osm)
        amen, stats = stop_amenities(osm, stops, parks)
        data.update(parking=parks, stops=amen, osm_date=Path(osm_tsv).stem.rsplit("_", 1)[-1])
        print(f"  bike: {len(parks)} parking sites "
              f"({sum(1 for p in parks if p['cap'])} with capacity), "
              f"stop amenities for {len(amen)} stops "
              f"({stats['matched_ref']} by stop number, {stats['matched_near']} by location)")
    print("  bike network km: " + ", ".join(f"{CLASSES[k]} {v}" for k, v in km.items()))
    return data
