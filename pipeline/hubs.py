"""Schematic transit centers.

Real geometry inside a transit center is a knot of bus bays, loops and
turnarounds. Like a metro diagram, we replace it with an abstraction: each hub
is a disc, and every route serving it arrives as a clean *spoke*.

  1. Hubs are found from the GTFS: stops named "Transit/Transfer Center"
     served by at least `min_routes` routes.
  2. Inside an approach zone (`zone` × the hub radius) each serving route's real
     path is removed.
  3. Where the route leaves the zone, a cubic Bézier joins it to the hub: it
     starts radial (pointing at the hub centre, from well inside the disc so the
     end is always hidden) and ends tangent to the real street, so the line bends
     smoothly from the street into the hub.
  4. Routes that only pass by (don't serve the hub) are left untouched.
"""
from __future__ import annotations

import re

import numpy as np
from pyproj import Transformer

HUB_NAME = re.compile(r"transit center|transfer center", re.I)


def find_hubs(stops: list[dict], min_routes: int = 3, radius_m: float = 110.0,
              overrides: dict[str, float] | None = None) -> list[dict]:
    to_utm = Transformer.from_crs("EPSG:4326", "EPSG:26913", always_xy=True)
    hubs, xy = [], {s["id"]: to_utm.transform(s["lon"], s["lat"]) for s in stops}
    for s in stops:
        if HUB_NAME.search(s["name"]) and len(s["routes"]) >= min_routes:
            x, y = xy[s["id"]]
            if any(abs(h["x"] - x) < 200 and abs(h["y"] - y) < 200 for h in hubs):
                continue                         # another feed's stop for the same center
            r = (overrides or {}).get(s["id"], radius_m)
            # every route stopping anywhere inside the hub (other agencies' bays too)
            routes = list(dict.fromkeys(rt for o in stops if (xy[o["id"]][0] - x) ** 2 + (xy[o["id"]][1] - y) ** 2 < r * r
                                        for rt in o["routes"]))
            short = HUB_NAME.sub("", s["name"]).strip()        # "Downtown Transit Center" -> "Downtown"
            hubs.append({"stop": s["id"], "name": s["name"], "short": short,
                         "lat": s["lat"], "lon": s["lon"], "x": x, "y": y,
                         "r": r, "routes": routes})
    return hubs


def _bezier(p0, p1, p2, p3, n):
    t = np.linspace(0, 1, n)[:, None]
    return ((1 - t) ** 3) * p0 + 3 * ((1 - t) ** 2) * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3


def _spoke(c, r_end, p_out, tangent_out, n=10):
    """Points from the hub rim (radial) to p_out (tangent to the street)."""
    u = p_out - c
    dist = np.linalg.norm(u)
    u = u / dist
    rim = c + u * r_end
    span = dist - r_end
    # if the street at p_out still points back toward the hub (the route doubles
    # back just outside the zone), blend in the radial direction so the curve
    # can't hook around behind the disc
    if tangent_out @ u < 0.3:
        tangent_out = tangent_out + u * (0.3 - tangent_out @ u) * 2
        tangent_out = tangent_out / (np.linalg.norm(tangent_out) or 1)
    p1 = rim + u * span * 0.45
    p2 = p_out - tangent_out * span * 0.45
    return _bezier(rim, p1, p2, p_out, n)


def apply(parts: list[tuple[np.ndarray, np.ndarray]], route: str, hubs: list[dict],
          zone: float = 1.8, rim: float = 0.05):
    """Rewrite one route's (xy, slot) parts around the hubs it serves."""
    for h in hubs:
        if route not in h["routes"]:
            continue
        c, R = np.array([h["x"], h["y"]]), h["r"]
        out, made = [], []        # spokes already drawn for this route at this hub

        def spoke(p_out, tangent):
            # a route's inbound and outbound twins leave the zone a few metres
            # apart; give them one shared spoke so they don't draw as two lines
            for sp in made:
                if np.linalg.norm(sp[-1] - p_out) < 20:
                    return sp
            sp = _spoke(c, rim * R, p_out, tangent / (np.linalg.norm(tangent) or 1))
            made.append(sp)
            return sp

        for xy, slot in parts:
            d = np.linalg.norm(xy - c, axis=1)
            keep = d >= zone * R
            if keep.all():
                out.append((xy, slot))
                continue
            edges = np.flatnonzero(np.diff(np.r_[0, keep.astype(int), 0]))
            for a, b in zip(edges[::2], edges[1::2]):          # runs outside the zone
                seg_xy, seg_s = xy[a:b], slot[a:b]
                if a > 0 and b < len(xy) and d[a:b].max() < 3.5 * R:
                    continue      # a short loop out of the hub and back: station circulation
                if a > 0:                                     # came out of the hub here
                    t = seg_xy[1] - seg_xy[0] if len(seg_xy) > 1 else seg_xy[0] - c
                    sp = spoke(seg_xy[0], t)
                    seg_xy = np.vstack([sp[:-1], seg_xy])
                    seg_s = np.r_[np.full(len(sp) - 1, seg_s[0]), seg_s]
                if b < len(xy):                               # heads into the hub here
                    t = seg_xy[-2] - seg_xy[-1] if len(seg_xy) > 1 else seg_xy[-1] - c
                    sp = spoke(seg_xy[-1], t)[::-1]
                    seg_xy = np.vstack([seg_xy, sp[1:]])
                    seg_s = np.r_[seg_s, np.full(len(sp) - 1, seg_s[-1])]
                if len(seg_xy) >= 2:
                    out.append((seg_xy, seg_s))
        parts = out
    return parts
