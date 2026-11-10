"""Count visible line crossings in a bundled layout (quality metric).

Renders every route's offset ribbon in metres (slot × `spacing`, the same miter
offset the browser applies) and counts points where two different routes'
ribbons intersect."""
from __future__ import annotations

import numpy as np
from shapely.geometry import LineString, MultiLineString
from shapely.strtree import STRtree


def offset_part(xy: np.ndarray, slot: np.ndarray, spacing: float) -> np.ndarray:
    out = xy.copy()
    n = len(xy)
    for i in range(n):
        o = slot[i] * spacing
        if not o:
            continue
        def nrm(a, b):
            d = b - a
            L = np.hypot(*d) or 1
            return np.array([-d[1], d[0]]) / L          # left normal, y up
        n1 = nrm(xy[i - 1], xy[i]) if i > 0 else None
        n2 = nrm(xy[i], xy[i + 1]) if i < n - 1 else None
        if n1 is not None and n2 is not None:
            m = n1 + n2
            L = np.hypot(*m)
            m = n1 if L < 1e-6 else m / L * min(2.5, 1 / max(0.2, (m / L) @ n1))
        else:
            m = n1 if n1 is not None else n2
        out[i] = xy[i] + m * o
    return out


def count(bundled: dict, spacing: float = 10.0, near=None, radius: float = 30.0) -> int:
    """near: optional (N,2) array of shared-corridor node positions; when given,
    only crossings within `radius` of one are counted (ones the layout caused)."""
    from scipy.spatial import cKDTree
    kd = cKDTree(near) if near is not None and len(near) else None
    geoms, owner = [], []
    for rid, parts in bundled.items():
        for xy, slot in parts:
            if len(xy) >= 2:
                geoms.append(LineString(offset_part(xy, slot, spacing)))
                owner.append(rid)
    tree = STRtree(geoms)
    total = 0
    for i, g in enumerate(geoms):
        for j in tree.query(g, predicate="crosses"):
            if j > i and owner[j] != owner[i]:
                inter = g.intersection(geoms[j])
                pts = [] if inter.is_empty else list(getattr(inter, "geoms", [inter]))
                for p in pts:
                    if kd is None or kd.query(np.array(p.coords[0]))[0] < radius:
                        total += 1
    return total
