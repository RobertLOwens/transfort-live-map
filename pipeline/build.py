"""Build the web data bundle from a GTFS feed (+ optional city GIS layers).

    python -m pipeline.build --gtfs raw/transfort_gtfs.zip \
        --streets raw/Street_Centerlines/Street_Centerlines.shp \
        --natural raw/Natural_Areas/Natural_Areas.shp --out web/data
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

from . import bike, geo, gtfs, hubs


AGENCY_LABELS = {"Colorado Department of Transportation": "Bustang · CDOT"}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gtfs", required=True, help="GTFS zip or folder")
    ap.add_argument("--streets", help="Street centerline shapefile")
    ap.add_argument("--natural", help="Natural areas polygon shapefile")
    ap.add_argument("--out", default="web/data")
    ap.add_argument("--line-order", choices=["smart", "fixed"], default="smart",
                    help="how bundled routes are ordered side by side")
    ap.add_argument("--add-feed", action="append", default=[], metavar="PREFIX=ZIP[:ROUTE,...]",
                    help="merge routes from another GTFS feed, e.g. BT-=raw/bustang_gtfs.zip:NRTH")
    ap.add_argument("--cities", help="municipal boundary shapefile, for context along regional routes")
    ap.add_argument("--bike-facilities", help="City bike facilities shapefile (on-street)")
    ap.add_argument("--trails", help="City trails shapefile (off-street)")
    ap.add_argument("--osm", help="Overpass TSV export: bicycle_parking + bus_stop nodes")
    ap.add_argument("--no-hubs", dest="hubs", action="store_false",
                    help="draw transit centers with their real geometry instead of schematic hubs")
    a = ap.parse_args(argv)

    t0 = time.time()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    tables = gtfs.read_gtfs(a.gtfs)
    print(f"read GTFS: {', '.join(f'{k}={len(v):,}' for k, v in tables.items())}")
    for spec in a.add_feed:
        prefix, rest = spec.split("=", 1)
        path, _, keep = rest.partition(":")
        before = len(tables["routes"])
        tables = gtfs.merge_feeds(tables, gtfs.read_gtfs(path), prefix, keep.split(",") if keep else None)
        print(f"  + {path}: {len(tables['routes']) - before} route(s) as {prefix}…")

    sched = gtfs.build_schedule(tables)
    hub_list = hubs.find_hubs(sched["stops"]) if a.hubs else []
    sched["hubs"] = [{k: h[k] for k in ("stop", "name", "short", "lat", "lon", "r", "routes")} for h in hub_list]
    routes_geo, lengths = geo.route_geometries(
        tables, [r["id"] for r in sched["routes"]],
        smart_order=a.line_order == "smart", hub_list=hub_list)
    print(f"  hubs: {', '.join(h['name'] for h in hub_list) or 'off'}")
    geo.pattern_geometries(tables, sched["patterns"])
    primary = sched["agency"]["name"]
    for r in sched["routes"]:
        r["km"] = lengths.get(r["id"])
        # regional = another agency's service, or a long intercity run like FLEX
        r["scope"] = "regional" if r["agency"] != primary or (r["km"] or 0) > 30 else "local"
        r["agency"] = AGENCY_LABELS.get(r["agency"], r["agency"])

    (out / "schedule.json").write_text(geo.dumps(sched))
    (out / "routes.geojson").write_text(geo.dumps(routes_geo))

    if a.streets:
        lats = [s["lat"] for s in sched["stops"]]
        lons = [s["lon"] for s in sched["stops"]]
        layers = geo.basemap(a.streets, a.natural, (min(lons), min(lats), max(lons), max(lats)))
        if a.cities:
            layers.update(geo.city_context(a.cities, routes_geo,
                                           [r["id"] for r in sched["routes"] if r["scope"] == "regional"]))
        (out / "basemap.json").write_text(geo.dumps(layers))

    if a.bike_facilities:
        (out / "bike.json").write_text(geo.dumps(bike.build(a.bike_facilities, a.trails, a.osm, sched["stops"])))

    for f in sorted(out.iterdir()):
        print(f"  {f.name:<16} {f.stat().st_size/1024:>8.0f} KB")
    print(f"{len(sched['routes'])} routes · {len(sched['stops'])} stops · "
          f"{len(sched['patterns'])} patterns · {len(sched['trips']):,} trips "
          f"· {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
