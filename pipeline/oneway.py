"""Which stretches of a route are travelled one way only?

Bundling folds a route's outbound and inbound paths onto one centreline where
they share a street, so a drawn line usually means "buses both ways". Where the
two directions split (one-way couplets, loops, a terminal circuit) the drawn
line is travelled in one direction only, and the map should say which.

For every route the original GTFS shapes still carry real travel direction.
We resample each drawn part every `step` m, look up the route's own shape
samples within `radius` m that run parallel, and compare their headings with
the drawn line's local direction:

    both directions, about equally near   → 0   two-way (twins merged here)
    one direction, or the other far off   → ±1  one-way, along / against the
                                                polyline (a lane drawn on its own)

A mode filter and a minimum run length keep intersections and short turning
movements from flickering, and hub spokes are always left two-way.
"""
from __future__ import annotations

import numpy as np
from scipy.ndimage import median_filter
from scipy.spatial import cKDTree
from shapely.geometry import LineString

from .bundling import _rdp_mask


def _resample(xy: np.ndarray, step: float):
    seg = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    cum = np.r_[0, np.cumsum(seg)]
    d = np.unique(np.r_[np.arange(0, cum[-1], step), cum])     # keep original vertices too
    x = np.interp(d, cum, xy[:, 0])
    y = np.interp(d, cum, xy[:, 1])
    return np.column_stack([x, y]), d, cum


def _tangents(pts: np.ndarray) -> np.ndarray:
    g = np.gradient(pts, axis=0) if len(pts) > 1 else np.array([[1.0, 0.0]])
    n = np.linalg.norm(g, axis=1, keepdims=True)
    n[n == 0] = 1
    return g / n


def flags(parts: list[tuple[np.ndarray, np.ndarray]], shapes: list[LineString],
          hub_zones: list[tuple[np.ndarray, float]] = (), *, step: float = 15.0,
          radius: float = 32.0, parallel: float = 0.7, min_run_m: float = 150.0,
          tol: float = 2.5, slot_m: float = 12.0):
    """parts: [(xy, slot)] for one route (UTM). shapes: that route's GTFS shapes
    (UTM, directional). Returns [(xy, slot, dir)] with dir ∈ {-1, 0, 1} per vertex."""
    samples, heads = [], []
    for ln in shapes:
        if ln.length < step:
            continue
        p, _, _ = _resample(np.asarray(ln.coords), step / 2)
        samples.append(p)
        heads.append(_tangents(p))
    if not samples:
        return [(xy, s, np.zeros(len(xy), int)) for xy, s in parts]
    S, H = np.vstack(samples), np.vstack(heads)
    tree = cKDTree(S)

    out = []
    for xy, slot in parts:
        if len(xy) < 2:
            out.append((xy, slot, np.zeros(len(xy), int)))
            continue
        pts, d, cum = _resample(xy, step)
        if len(pts) < 2:                   # degenerate (zero-length) piece: nothing to draw
            continue
        sl = np.interp(d, cum, slot)
        tan = _tangents(pts)
        dirn = np.zeros(len(pts), int)
        for i, nb in enumerate(tree.query_ball_point(pts, r=radius)):
            if not nb:
                continue
            nb = np.asarray(nb)
            dots = H[nb] @ tan[i]
            dist = np.linalg.norm(S[nb] - pts[i], axis=1)
            fw, bw = dist[dots > parallel], dist[dots < -parallel]
            if len(fw) and len(bw):
                da, db = fw.min(), bw.min()
                # a merged line sits midway between its two lanes (da ≈ db); a lane
                # drawn on its own sits on one direction with the other farther off
                if abs(da - db) < 0.5 * max(da, db) + 4:
                    continue
                dirn[i] = 1 if da < db else -1
            elif len(fw) or len(bw):
                dirn[i] = 1 if len(fw) else -1
        # smooth, then drop one-way runs too short to be a real one-way street
        dirn = median_filter(dirn, size=5, mode="nearest")
        edges = np.flatnonzero(np.diff(np.r_[0, dirn != 0, 0].astype(int)))
        for a, b in zip(edges[::2], edges[1::2]):
            if d[b - 1] - d[a] < min_run_m:
                dirn[a:b] = 0
        for c, R in hub_zones:                       # spokes into a hub: no arrows
            dirn[np.linalg.norm(pts - c, axis=1) < R] = 0
        # simplify again, keeping every point where the direction flag changes
        keep = _rdp_mask(np.column_stack([pts, sl * slot_m]), tol)
        keep[np.flatnonzero(np.diff(dirn)) + 1] = True
        keep[np.flatnonzero(np.diff(dirn))] = True
        out.append((pts[keep], sl[keep], dirn[keep]))
    return out
