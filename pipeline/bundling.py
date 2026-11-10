"""Subway-map style line bundling.

Where several routes share a street, draw them side by side instead of on top
of each other, the way a metro diagram does. Output: for every route, a
polyline plus a per-vertex *slot offset* (how many line-widths to shift
sideways). The browser turns slots into pixels at the current zoom, so the
ribbons stay the same width at every scale.

The approach builds a shared corridor network first, then orders lines on it.

  1. Corridor nodes. Densify every route every `step` m and snap each sample to
     an existing node within `radius` m that runs parallel (|cos θ| > `parallel`),
     otherwise create a node. Routes on the same street — even on opposite curbs —
     end up on *the same* node chain, and a route's own outbound/inbound pair
     (one shape per side of the road) collapses onto one centreline. Node
     positions are the mean of everything snapped to them.
  2. Runs. Along each route, a run is a stretch of nodes with an identical set
     of routes. Ordering is decided once per run, so lines never shuffle inside it.
  3. Ordering. Each run is laid out in the frame of its reference route. Every
     member gets a *peel-off score*: walk along its own path beyond both ends
     of the run and measure how far left/right it strays from the corridor,
     nearer departures weighing more. Members are sorted by that score, so the
     route that turns left next rides on the left and never has to cross the
     others to get out. Routes that stay together tie and keep a global order,
     which keeps them consistent from run to run.
  4. Smooth slots along each route (lines ease apart where they diverge) and
     simplify with a 3-D Douglas-Peucker on (x, y, slot).
"""
from __future__ import annotations

from collections import defaultdict

import numpy as np
from scipy.ndimage import uniform_filter1d
from scipy.spatial import cKDTree
from shapely.geometry import LineString

STATS: dict = {}


def _densify(line: LineString, step: float) -> np.ndarray:
    d = np.arange(0, line.length, step)
    d = np.append(d, line.length) if line.length - d[-1] > 1e-6 else d   # no duplicate end point
    return np.array([line.interpolate(x).coords[0] for x in d])


def _directions(xy: np.ndarray) -> np.ndarray:
    if len(xy) < 2:
        return np.tile([1.0, 0.0], (len(xy), 1))
    g = np.gradient(xy, axis=0)
    n = np.linalg.norm(g, axis=1, keepdims=True)
    n[n == 0] = 1
    return g / n


def _cross(d: np.ndarray, v: np.ndarray) -> float:
    """> 0 when v points to the left of direction d (y axis up)."""
    return float(d[0] * v[1] - d[1] * v[0])


def _rdp_mask(pts: np.ndarray, tol: float) -> np.ndarray:
    """Iterative Douglas-Peucker on N-D points; returns a keep mask."""
    keep = np.zeros(len(pts), bool)
    keep[[0, -1]] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        seg = pts[b] - pts[a]
        L = np.dot(seg, seg)
        rel = pts[a + 1:b] - pts[a]
        if L == 0:
            d = np.linalg.norm(rel, axis=1)
        else:
            t = np.clip(rel @ seg / L, 0, 1)
            d = np.linalg.norm(rel - np.outer(t, seg), axis=1)
        i = int(np.argmax(d))
        if d[i] > tol:
            m = a + 1 + i
            keep[m] = True
            stack += [(a, m), (m, b)]
    return keep


class _Grid:
    """Tiny spatial hash for nodes created on the fly."""

    def __init__(self, cell: float):
        self.cell, self.cells = cell, defaultdict(list)

    def add(self, i: int, p):
        self.cells[(int(p[0] // self.cell), int(p[1] // self.cell))].append(i)

    def near(self, p):
        cx, cy = int(p[0] // self.cell), int(p[1] // self.cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                yield from self.cells.get((cx + dx, cy + dy), ())


def bundle(route_lines: dict[str, list[LineString]], order: list[str], *,
           step: float = 8.0, radius: float = 30.0, twin_radius: float = 48.0, parallel: float = 0.8,
           smooth_m: float = 56.0, slot_m: float = 12.0, tol: float = 2.5,
           look_m: tuple = (24.0, 48.0, 96.0, 192.0, 384.0, 768.0),
           smart_order=True):
    """route_lines: route_id -> list of LineStrings (UTM, metres).
    Returns route_id -> list of (xy ndarray, slot ndarray) parts."""
    rank = {r: i for i, r in enumerate(order)}
    rids = [r for r in order if r in route_lines]

    # ------------------------------------------------------------ 1. nodes
    node_sum, node_cnt, node_dir = [], [], []
    node_routes: list[set[int]] = []
    node_seed: list[np.ndarray] = []
    grid = _Grid(max(radius, twin_radius))
    local = int(np.ceil(3 * radius / step))       # don't snap onto our own recent nodes
    paths: list[tuple[int, list[int]]] = []       # (route index, node ids)

    for ri, r in enumerate(rids):
        born: dict[int, int] = {}                 # node -> sample counter when this route made it
        counter = 0
        for ln in route_lines[r]:
            xy = _densify(ln, step)          # short pieces still give their 2 ends
            dirs = _directions(xy)
            path: list[int] = []
            for p, d in zip(xy, dirs):
                counter += 1
                # Prefer collapsing onto our own other-direction line (a wider
                # reach, so divided roads merge too), else join another route.
                best, bd, best_own, bo = -1, radius * radius, -1, twin_radius * twin_radius
                for n in grid.near(p):
                    v = node_seed[n] - p
                    if abs(node_dir[n] @ d) < parallel or abs(v @ node_dir[n]) > 0.75 * step:
                        continue                  # only snap sideways, never along the street
                    dd = _cross(node_dir[n], v) ** 2
                    if ri in node_routes[n]:
                        if counter - born.get(n, -10**9) > local and dd < bo:
                            best_own, bo = n, dd
                    elif dd < bd:
                        best, bd = n, dd
                if best_own >= 0:
                    best = best_own
                if best < 0:
                    best = len(node_sum)
                    node_sum.append(p.copy()); node_cnt.append(1); node_seed.append(p.copy())
                    node_dir.append(d.copy())
                    node_routes.append({ri})
                    grid.add(best, p)
                    born[best] = counter
                else:
                    node_sum[best] += p
                    node_cnt[best] += 1
                    node_routes[best].add(ri)
                if not path or path[-1] != best:
                    path.append(best)
            # split the path where snapping jumped (no shared corridor between)
            pos = np.array([node_sum[n] / node_cnt[n] for n in path])
            gaps = np.flatnonzero(np.linalg.norm(np.diff(pos, axis=0), axis=1) > 150) + 1
            for chunk in np.split(np.array(path), gaps):
                if len(chunk) >= 2:
                    paths.append((ri, list(chunk)))

    pos = np.array([s / c for s, c in zip(node_sum, node_cnt)])
    ndir = np.array(node_dir)
    # per-route index of each node (first visit) and per-path direction
    where: list[dict[int, tuple[int, int]]] = [dict() for _ in rids]
    pdirs = []
    for k, (ri, path) in enumerate(paths):
        pdirs.append(_directions(pos[path]))
        for i, n in enumerate(path):
            where[ri].setdefault(n, (k, i))

    # Membership by proximity, not exact hits: a route sampled out of phase with
    # a chain skips every other node, which would make runs flicker on/off.
    members: list[set[int]] = [set() for _ in pos]
    kd = cKDTree(pos)
    # relax node positions toward their parallel neighbours (twice): evens out
    # curb-to-curb jitter where a route's two directions were folded together
    near = [[n] + [m for m in kd.query_ball_point(pos[n], r=2 * step)
                   if m != n and abs(ndir[m] @ ndir[n]) >= parallel]
            for n in range(len(pos))]
    for _ in range(2):
        pos = np.array([pos[nb].mean(axis=0) for nb in near])
    for ri, path in paths:
        for n in path:
            members[n].add(ri)
            for m in kd.query_ball_point(pos[n], r=1.6 * step):
                if abs(ndir[m] @ ndir[n]) >= parallel:
                    members[m].add(ri)
                    where[ri].setdefault(m, where[ri][n])   # stand-in: nearest own node

    def dir_at(ri, n):
        k, i = where[ri][n]
        return pdirs[k][i]

    # ------------------------------------------------------ 2–3. runs + order
    look = [(max(1, int(round(d / step))), d) for d in look_m]

    def peel(ri, n_anchor, d_ref, sx, ahead):
        """Score how far route ri strays left (+) / right (−) of the corridor
        beyond node n_anchor, walking along its own path."""
        k, i = where[ri][n_anchor]
        path, c, t = paths[k][1], pos[n_anchor], 0.0
        sgn = sx if ahead else -sx
        for kk, dist in look:
            j = i + sgn * kk
            if 0 <= j < len(path):
                lat = _cross(d_ref, pos[path[j]] - c)
                if abs(lat) > radius:
                    t += np.clip(lat, -80, 80) / dist
        return t

    ref_slot: dict[tuple[int, int], float] = {}   # (path k, index) -> slot in own frame

    def path_sets(path):
        """Members per node along a path, with brief blips (< ~40 m) filtered out
        so a run isn't chopped up by a partner that wanders in and out."""
        cand = set().union(*(members[n] for n in path))
        win = max(3, int(round(40 / step)) | 1)
        pres = {x: uniform_filter1d(np.array([x in members[n] for n in path], float),
                                    size=win, mode="nearest") > 0.5 for x in cand}
        return [frozenset(x for x in cand if pres[x][t] and path[t] in where[x])
                for t in range(len(path))]

    # Orderings are decided only along each corridor's *reference* route (the
    # highest-ranked member) and then looked up by everyone else, so all members
    # of a bundle agree on the order and the frame it is expressed in.
    sets_by_path = [path_sets(path) for _, path in paths]
    run_at: dict[tuple[int, int], dict[int, float]] = {}   # (ref path k, idx) -> slots
    n_runs = 0
    for k, (ri, path) in enumerate(paths):
        sets = sets_by_path[k]
        prev: dict[int, float] = {}          # previous run's slots (this path's frame)
        i = 0
        while i < len(path):
            j = i
            while j + 1 < len(path) and sets[j + 1] == sets[i]:
                j += 1
            M = sets[i]
            if len(M) > 1 and min(M, key=lambda x: rank[rids[x]]) == ri:
                a, b = path[i], path[j]
                d_a, d_b = pdirs[k][i], pdirs[k][j]
                score = {}
                for x in M:
                    if not smart_order:
                        score[x] = 0.0
                        continue
                    sx = 1 if dir_at(x, b) @ d_b >= 0 else -1
                    score[x] = (peel(x, b, d_b, sx, ahead=True) +
                                peel(x, a, d_a, sx, ahead=False))
                ordered = sorted(M, key=lambda x: (round(score[x], 4), -rank[rids[x]]))
                if smart_order:
                    # continuity: partners already side by side keep their order;
                    # newcomers slot in by peel-off score
                    kept = sorted((x for x in M if x in prev), key=lambda x: prev[x])
                    if len(kept) >= 2:
                        for x in (x for x in ordered if x not in prev):
                            kept.insert(sum(1 for y in kept if (score[y], -rank[rids[y]]) <
                                            (score[x], -rank[rids[x]])), x)
                        ordered = kept
                slots = {x: s - (len(M) - 1) / 2 for s, x in enumerate(ordered)}
                for t in range(i, j + 1):
                    run_at[(k, t)] = slots
                prev = slots
                n_runs += 1
            elif len(M) <= 1:
                prev = {}
            i = j + 1

    for k, (ri, path) in enumerate(paths):
        for t, n in enumerate(path):
            M = sets_by_path[k][t]
            if len(M) < 2:
                continue
            ref = min(M, key=lambda x: rank[rids[x]])
            kr, ir = where[ref][n]
            slots = run_at.get((kr, ir))
            if not slots or ri not in slots:
                continue
            same = pdirs[k][t] @ pdirs[kr][ir] >= 0
            ref_slot[(k, t)] = slots[ri] * (1 if same else -1)

    shared = pos[[len(m) > 1 for m in members]]
    STATS.clear()
    STATS.update(nodes=len(pos), shared_nodes=len(shared), runs=n_runs, shared_xy=shared)

    # ------------------------------------------------- 4. smooth + simplify
    out: dict[str, list] = defaultdict(list)
    win = max(1, int(round(smooth_m / step)))
    for k, (ri, path) in enumerate(paths):
        xy = pos[path]
        s = np.array([ref_slot.get((k, t), 0.0) for t in range(len(path))])
        s = uniform_filter1d(s, size=win, mode="nearest")
        p = uniform_filter1d(xy, size=5, axis=0, mode="nearest")   # irons out curb-to-curb jitter
        p[[0, -1]] = xy[[0, -1]]
        keep = _rdp_mask(np.column_stack([p, s * slot_m]), tol)
        out[rids[ri]].append((p[keep], s[keep]))
    return dict(out)
