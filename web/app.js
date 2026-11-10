/* Transfort transit map — front end.
   All GIS + schedule crunching happens in the Python pipeline; this file only
   decodes the compact JSON, does calendar math for "today", and renders. */
(async function () {
  "use strict";

  // ------------------------------------------------------------------ data
  async function load(id, url) {
    const el = document.getElementById(id);
    if (el) return JSON.parse(el.textContent);
    const r = await fetch(url);
    return r.json();
  }
  const [S, ROUTE_GEO, BASE, ALERTS0, BIKE] = await Promise.all([
    load("d-schedule", "data/schedule.json"),
    load("d-routes", "data/routes.geojson"),
    load("d-basemap", "data/basemap.json"),
    load("d-alerts", "data/alerts.json").catch(() => ({ alerts: [], docs: {} })),
    load("d-bike", "data/bike.json").catch(() => null),
  ]);
  const TZ = S.agency.tz || "America/Denver";
  const routes = S.routes, stops = S.stops, patterns = S.patterns;
  const routeById = Object.fromEntries(routes.map(r => [r.id, r]));
  const stopById = Object.fromEntries(stops.map((s, i) => [s.id, i]));

  // decode trips: [pattern, service, start, ...deltas] -> absolute minute arrays
  const trips = S.trips.map(a => {
    const t = [a[2]];
    for (let i = 3; i < a.length; i++) t.push(t[t.length - 1] + a[i]);
    return { p: a[0], svc: a[1], t };
  });
  // stop -> [[trip, position], ...]
  const stopIndex = stops.map(() => []);
  trips.forEach((tr, ti) => patterns[tr.p].s.forEach((s, pos) => stopIndex[s].push(ti, pos)));
  // pattern trip counts (to pick the "main" pattern per direction)
  const patternTrips = patterns.map(() => 0);
  trips.forEach(t => patternTrips[t.p]++);

  // pattern geometry: cumulative distances for interpolating bus positions
  patterns.forEach(p => {
    if (!p.g) return;
    const k = Math.cos(40.57 * Math.PI / 180);
    p.cum = [0];
    for (let i = 1; i < p.g.length; i++) {
      const dx = (p.g[i][0] - p.g[i - 1][0]) * k, dy = p.g[i][1] - p.g[i - 1][1];
      p.cum.push(p.cum[i - 1] + Math.hypot(dx, dy));
    }
    p.len = p.cum[p.cum.length - 1];
  });

  // ------------------------------------------------------------------ time
  const fmtParts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  // formatToParts is slow and only resolves to the second, so the result is
  // cached per wall-clock second (it was being called thousands of times a redraw).
  let nowSec = NaN, nowVal = null;
  function nowLocal() {
    const ms = Date.now(), sec = Math.floor(ms / 1000);
    if (sec !== nowSec) {
      const p = Object.fromEntries(fmtParts.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
      nowVal = { y: +p.year, m: +p.month, d: +p.day, min: +p.hour * 60 + +p.minute + +p.second / 60 };
      nowSec = sec;
    }
    return { ...nowVal };
  }
  function ymd(n, offset) {
    const dt = new Date(Date.UTC(n.y, n.m - 1, n.d + offset));
    return { key: dt.toISOString().slice(0, 10).replace(/-/g, ""), dow: (dt.getUTCDay() + 6) % 7 };
  }
  const svcCache = new Map();
  function activeServices(day) {
    if (svcCache.has(day.key)) return svcCache.get(day.key);
    const on = new Set();
    for (const [s, c] of Object.entries(S.calendar))
      if (c.days[day.dow] === "1" && c.start <= day.key && day.key <= c.end) on.add(+s);
    const ex = S.exceptions[day.key];
    if (ex) { ex.add.forEach(s => on.add(s)); ex.remove.forEach(s => on.delete(s)); }
    svcCache.set(day.key, on);
    return on;
  }
  const clockFmt = m => {
    m = ((Math.round(m) % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, "0");
    return `${(h + 11) % 12 + 1}:${mm} ${h < 12 ? "AM" : "PM"}`;
  };
  function etaText(delta) {
    if (delta < 1) return { main: "Now", now: true };
    if (delta < 60) return { main: `${Math.floor(delta)} min` };
    const h = Math.floor(delta / 60), m = Math.floor(delta % 60);
    return { main: m ? `${h} h ${m}m` : `${h} h` };
  }

  // Departures from a stop within [now, now + horizon]. Looks at yesterday's
  // service (after-midnight trips), today and tomorrow.
  function departures(stopIdx, { horizon = 180, limit = 12, route = null, dir = null } = {}) {
    const n = nowLocal(), out = [], seen = new Set(), idx = stopIndex[stopIdx];
    for (const off of [-1, 0, 1]) {
      const svcs = activeServices(ymd(n, off));
      for (let i = 0; i < idx.length; i += 2) {
        const tr = trips[idx[i]], pos = idx[i + 1], p = patterns[tr.p];
        if (!svcs.has(tr.svc)) continue;
        if (pos === p.s.length - 1) continue;                 // arriving at terminus
        if (route && p.r !== route) continue;
        if (dir !== null && p.d !== dir) continue;
        const t = tr.t[pos] + off * 1440, delta = t - n.min;
        if (delta < -0.5 || delta > horizon) continue;
        const key = p.r + "|" + p.h + "|" + t;                 // collapse duplicate service variants
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ route: p.r, head: p.h, t, delta, trip: idx[i], dir: p.d });
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out.slice(0, limit);
  }

  // Interpolated scheduled positions of every bus in service right now.
  function liveBuses(routeFilter) {
    const n = nowLocal(), res = [], seen = new Set();
    for (const off of [-1, 0]) {
      const svcs = activeServices(ymd(n, off));
      const now = n.min - off * 1440;
      trips.forEach((tr, ti) => {
        const t = tr.t;
        if (!svcs.has(tr.svc) || now < t[0] || now > t[t.length - 1]) return;
        const p = patterns[tr.p];
        if (!p.g || (routeFilter && p.r !== routeFilter)) return;
        const key = tr.p + "|" + t[0];
        if (seen.has(key)) return;
        seen.add(key);
        let i = 0;
        while (i < t.length - 2 && t[i + 1] <= now) i++;
        const span = t[i + 1] - t[i];
        const k = span > 0 ? Math.min(1, Math.max(0, (now - t[i]) / span)) : 1;
        const f = p.f[i] + (p.f[i + 1] - p.f[i]) * k;
        res.push({ key, trip: ti, off, route: p.r, head: p.h, ll: pointAt(p, f), nextStop: p.s[i + 1], seg: i });
      });
    }
    return res;
  }
  function pointAt(p, f) {
    const target = f * p.len, c = p.cum;
    let lo = 0, hi = c.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (c[mid] <= target) lo = mid; else hi = mid; }
    const seg = c[hi] - c[lo] || 1, k = (target - c[lo]) / seg;
    const a = p.g[lo], b = p.g[hi];
    return [a[1] + (b[1] - a[1]) * k, a[0] + (b[0] - a[0]) * k];
  }
  function runsToday(routeId) {
    const n = nowLocal(), svcs = activeServices(ymd(n, 0));
    return trips.some(t => svcs.has(t.svc) && patterns[t.p].r === routeId);
  }

  // Is a route in service right now? A route counts as running between its
  // first departure and last arrival of the service day (yesterday's service
  // too, for trips past midnight). Otherwise we say when it next starts.
  const tripsByRoute = {};
  trips.forEach(t => (tripsByRoute[patterns[t.p].r] = tripsByRoute[patterns[t.p].r] || []).push(t));
  function span(routeId, n, off) {        // [first, last] in minutes from today's midnight
    const svcs = activeServices(ymd(n, off));
    let a = Infinity, b = -Infinity;
    for (const t of tripsByRoute[routeId] || []) if (svcs.has(t.svc)) {
      if (t.t[0] < a) a = t.t[0];
      if (t.t[t.t.length - 1] > b) b = t.t[t.t.length - 1];
    }
    return a < Infinity ? [a + off * 1440, b + off * 1440] : null;
  }
  const statusCache = new Map();
  function routeStatus(routeId) {
    const n = nowLocal(), key = routeId + "|" + Math.floor(n.min);
    if (statusCache.has(key)) return statusCache.get(key);
    const now = n.min;
    let st = null;
    for (const off of [-1, 0]) {
      const sp = span(routeId, n, off);
      if (sp && sp[0] <= now && now <= sp[1]) { st = { running: true, until: sp[1], endingSoon: sp[1] - now <= 45 }; break; }
    }
    if (!st) {
      for (let off = 0; off <= 7 && !st; off++) {
        const sp = span(routeId, n, off);
        if (sp && sp[0] > now) st = { running: false, next: sp[0], days: off };
      }
      st = st || { running: false, next: null };
    }
    if (statusCache.size > 500) statusCache.clear();
    statusCache.set(key, st);
    return st;
  }
  function nextServiceText(st) {
    if (st.next == null) return "No scheduled service this week";
    const t = clockFmt(st.next);
    if (st.days === 0) return `Starts at ${t}`;
    if (st.days === 1) return `Resumes tomorrow at ${t}`;
    const n = nowLocal(), d = new Date(Date.UTC(n.y, n.m - 1, n.d + st.days));
    return `Resumes ${d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })} at ${t}`;
  }
  function statusPill(st) {
    return st.running
      ? `<span class="status on${st.endingSoon ? " ending" : ""}"><i></i>${st.endingSoon ? "Last trips" : "Running"}</span>`
      : `<span class="status off"><i></i>Not running</span>`;
  }
  function statusNote(r, st) {
    if (st.running) return st.endingSoon ? `Service ends at ${clockFmt(st.until)}` : `${headwayText(r)} · until ${clockFmt(st.until)}`;
    return nextServiceText(st);
  }

  // ------------------------------------------------------------- favorites
  let HUBS_READY = false;          // map overlays exist (styleRoutes runs before they do)
  const FILTER_KEY = "transfort-route-filters-v2";
  // Two independent filters, both remembered per browser:
  //   scope:        local (Transfort in town) or regional (FLEX, Bustang)
  //   running only: hide routes that aren't in service right now (default on)
  let scope = "local", runningOnly = true;
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");
    if (saved.scope === "regional") scope = "regional";
    if (saved.runningOnly === false) runningOnly = false;
  } catch (e) { /* storage blocked */ }
  const saveFilters = () => { try { localStorage.setItem(FILTER_KEY, JSON.stringify({ scope, runningOnly })); } catch (e) { /* in-memory only */ } };
  const FAV_KEY = "transfort-favorites-v1";
  let favs = { routes: [], stops: [] };
  try { favs = Object.assign(favs, JSON.parse(localStorage.getItem(FAV_KEY) || "{}")); } catch (e) { /* storage blocked */ }
  const isFav = (kind, id) => favs[kind].includes(id);
  function toggleFav(kind, id) {
    favs[kind] = isFav(kind, id) ? favs[kind].filter(x => x !== id) : [...favs[kind], id];
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch (e) { /* in-memory only */ }
    updateFavCount();
  }

  // ------------------------------------------------------------------ map
  const state = { view: "home", tab: "routes", route: null, stop: null, dir: 0, q: "", stopFilter: null };
  const map = L.map("map", { preferCanvas: true, zoomSnap: 0.5, zoomControl: false, attributionControl: true, minZoom: 8, maxZoom: 18 });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  map.attributionControl.setPrefix(false).addAttribution(
    'Schedule: <a href="https://ridetransfort.com" target="_blank" rel="noopener">Transfort GTFS</a> · Streets: City of Fort Collins GIS');
  const canvas = L.canvas({ padding: 0.5, tolerance: 6 });

  // basemap
  map.createPane("base").style.zIndex = 200;
  map.createPane("routes").style.zIndex = 400;
  map.createPane("stops").style.zIndex = 450;
  map.createPane("buses").style.zIndex = 620;
  const baseCanvas = L.canvas({ pane: "base", padding: 0.5 });
  if (BASE.natural) L.geoJSON(BASE.natural, {
    pane: "base", renderer: baseCanvas, interactive: false,
    style: { stroke: false, fillColor: "#0d1f18", fillOpacity: 1 },
  }).addTo(map);
  const STREET = { 0: ["#141922", 0.8], 1: ["#1a212c", 1.2], 2: ["#232c39", 1.8], 3: ["#2c3747", 2.4], 4: ["#344053", 3] };
  const streetLayer = L.geoJSON(BASE.streets, {
    pane: "base", renderer: baseCanvas, interactive: false,
    style: f => ({ color: STREET[f.properties.cls][0], weight: STREET[f.properties.cls][1], lineCap: "round" }),
  }).addTo(map);
  function restyleStreets() {
    const z = map.getZoom(), k = Math.max(0.6, Math.pow(1.35, z - 13));
    streetLayer.eachLayer(l => {
      const c = l.feature.properties.cls;
      l.setStyle({ weight: STREET[c][1] * k, opacity: c === 0 && z < 12.5 ? 0.5 : 1 });
    });
  }
  const labelLayer = L.layerGroup(BASE.labels.map(l =>
    L.marker([l.lat, l.lon], { interactive: false, keyboard: false, pane: "base",
      icon: L.divIcon({ className: "", html: `<div class="street-label">${l.n}</div>`, iconSize: [0, 0] }) })));

  // ------------------------------------------------------------ bike layer
  // City bike facilities + trails, OSM bike parking. Off by default; drawn under
  // the bus routes, styled by facility type (solid = separated / painted lane,
  // dashed = shared or unpaved) so it reads apart from the bus network.
  map.createPane("bike").style.zIndex = 300;
  map.createPane("labels").style.zIndex = 615;     // above route lines, just below moving buses
  map.getPane("labels").style.pointerEvents = "none";
  map.createPane("bikePark").style.zIndex = 452;
  // Thin, flat, unoutlined lines (px width at zoom 14) so the bike network reads
  // as a secondary layer under the bold, outlined bus routes.
  // Pure white: no Transfort route uses it, so color alone says "bike". Facility
  // types are told apart by weight, opacity and dash rather than by shade.
  const BIKE_STYLE = {
    trail:      { color: "#ffffff", o: 0.9,  dash: null,  w: 1.6 },
    protected:  { color: "#ffffff", o: 0.85, dash: null,  w: 1.4 },
    lane:       { color: "#ffffff", o: 0.55, dash: null,  w: 1.2 },
    bikeway:    { color: "#ffffff", o: 0.6,  dash: "5 4", w: 1.2 },
    shared:     { color: "#ffffff", o: 0.5,  dash: "1 4", w: 1.1 },
    trail_soft: { color: "#ffffff", o: 0.5,  dash: "1 4", w: 1.2 },
  };
  let bikeOn = false;
  try { bikeOn = localStorage.getItem("transfort-bike-v1") === "on"; } catch (e) { /* storage blocked */ }
  // ~520 bike segments draw on one canvas: an SVG path per segment had to be
  // re-projected and re-written into the DOM after every pan and zoom. The layer
  // sits under the route canvases, which take the pointer anyway, so it is
  // non-interactive (stops and parking above it stay SVG / markers, still clickable).
  const bikeCanvas = L.canvas({ pane: "bike", padding: 0.5 });
  bikeCanvas.on("add", () => { if (bikeCanvas._container) bikeCanvas._container.style.pointerEvents = "none"; });
  const bikeNet = BIKE ? L.geoJSON(BIKE.network, {
    pane: "bike", renderer: bikeCanvas, interactive: false,
    style: f => { const st = BIKE_STYLE[f.properties.c]; return { color: st.color, dashArray: st.dash, weight: st.w, lineCap: "round",
      opacity: st.o * (f.properties.comfort === "low" ? 0.55 : 1) }; },
  }) : null;
  let bikeKw = 1;                                  // current line-weight factor
  // Bike parking is grouped into "P" markers with a count: nearby sites share a
  // ~72 px screen cell at the current zoom (then nearby groups merge), so groups
  // split apart as you zoom in. Groups never sit on top of a map label.
  // A "P" shape can't be mistaken for a round bus stop.
  const bikeParking = L.layerGroup();
  const PARK_CELL = 72, PARK_MERGE = 44;
  let parkRaf = 0;
  function renderParking(show) {   // next frame, once hub + focus labels have settled
    cancelAnimationFrame(parkRaf);
    parkRaf = requestAnimationFrame(() => drawParking(show));
  }
  function drawParking(show) {
    bikeParking.clearLayers();
    if (!show || !BIKE || !BIKE.parking) { bikeParking.remove(); return; }
    bikeParking.addTo(map);
    const cells = new Map();
    for (const p of BIKE.parking) {
      const pt = map.latLngToLayerPoint([p.lat, p.lon]);
      const key = Math.floor(pt.x / PARK_CELL) + ":" + Math.floor(pt.y / PARK_CELL);
      const c = cells.get(key) || cells.set(key, { n: 0, x: 0, y: 0, cap: 0, capKnown: 0, cov: 0, sites: [] }).get(key);
      c.n++; c.x += pt.x; c.y += pt.y; c.sites.push(p);
      if (p.cap) { c.cap += p.cap; c.capKnown++; }
      if (p.cov) c.cov++;
    }
    // merge groups whose markers would still touch (cells split dense spots)
    let groups = [...cells.values()].map(c => ({ ...c, px: c.x / c.n, py: c.y / c.n }));
    for (let merged = true; merged;) {
      merged = false;
      outer: for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i], b = groups[j];
        if (Math.hypot(a.px - b.px, a.py - b.py) < PARK_MERGE) {
          const n = a.n + b.n;
          groups[i] = { n, x: a.x + b.x, y: a.y + b.y, px: (a.x + b.x) / n, py: (a.y + b.y) / n, cap: a.cap + b.cap,
            capKnown: a.capKnown + b.capKnown, cov: a.cov + b.cov, sites: a.sites.concat(b.sites) };
          groups.splice(j, 1); merged = true; break outer;
        }
      }
    }
    // keep groups off the labels: slide one out of a label box to its nearest edge
    const mapBox = map.getContainer().getBoundingClientRect();
    const boxes = [...map.getPane("labels").querySelectorAll(".hub-label, .focus-label")].map(e => {
      const r = e.getBoundingClientRect();
      const tl = map.containerPointToLayerPoint([r.left - mapBox.left, r.top - mapBox.top]);
      return { x0: tl.x - 18, y0: tl.y - 20, x1: tl.x + r.width + 18, y1: tl.y + r.height + 20 };
    }).filter(b => b.x1 > b.x0);
    for (const g of groups) for (const b of boxes) {
      if (g.px <= b.x0 || g.px >= b.x1 || g.py <= b.y0 || g.py >= b.y1) continue;
      const moves = [[b.x0 - g.px, 0], [b.x1 - g.px, 0], [0, b.y0 - g.py], [0, b.y1 - g.py]];
      const [dx, dy] = moves.sort((u, v) => Math.abs(u[0] + u[1]) - Math.abs(v[0] + v[1]))[0];
      g.px += dx; g.py += dy;
    }
    // half-mile vignette: fade groups toward the ring, hide (or dim) outside it
    let fc = null, fr = 0;
    if (bikeFocus != null) {
      const s0 = stops[bikeFocus];
      fc = map.latLngToLayerPoint([s0.lat, s0.lon]);
      fr = map.latLngToLayerPoint([s0.lat, s0.lon + FOCUS_M / (111320 * Math.cos(s0.lat * Math.PI / 180))]).x - fc.x;
    }
    for (const c of groups) {
      const pt = L.point(c.px, c.py);
      let op = 1;
      if (fc) {
        const d = pt.distanceTo(fc) / fr;
        op = d <= 0.62 ? 1 : d >= 1 ? (bikeOn ? 0.3 : 0) : 1 - (1 - (bikeOn ? 0.3 : 0)) * (d - 0.62) / 0.38;
        if (op <= 0.02) continue;
      }
      const ll = map.layerPointToLatLng(pt);
      const m = L.marker(ll, { pane: "bikePark", keyboard: false, opacity: op,
        icon: L.divIcon({ className: "", iconSize: [0, 0],
          html: `<div class="park-p${c.n > 1 ? " group" : ""}${c.cov ? " has-cover" : ""}">P${c.n > 1 ? `<i>${c.n}</i>` : ""}</div>` }) });
      const one = c.n === 1 ? c.sites[0] : null;
      const bits = one
        ? [one.cap ? `${one.cap} spaces` : "capacity not recorded", one.cov ? "covered" : one.cov === false ? "uncovered" : null, one.kind, one.acc ? `${one.acc} only` : null]
        : [`${c.n} sites`, c.capKnown ? `${c.cap}+ spaces at ${c.capKnown} of them` : "capacities not recorded", c.cov ? `${c.cov} covered` : null];
      m.bindTooltip(`<b>Bike parking</b><br><span class="muted">${esc(bits.filter(Boolean).join(" · "))}</span>${c.n > 1 ? '<br><span class="muted">Click to zoom in</span>' : ""}`,
        { className: "tt", direction: "top", offset: [0, -14] });
      if (c.n > 1) m.on("click", () => map.flyToBounds(L.latLngBounds(c.sites.map(p => [p.lat, p.lon])).pad(0.4), { maxZoom: 18, duration: 0.5 }));
      bikeParking.addLayer(m);
    }
  }
  // Selecting a stop opens a half-mile "vignette" of the bike network around
  // it: full strength inside, fading out at the edge. With the bike layer off
  // only the vignette shows; with it on, the rest of the city stays dimmed.
  const FOCUS_M = 804.672;                       // 0.5 mile
  let bikeFocus = null;                          // stop index or null
  const focusRing = L.circle([0, 0], { radius: FOCUS_M, pane: "bike", interactive: false,
    color: "#ffffff", weight: 1, opacity: 0.4, dashArray: "4 6", fill: false });
  const focusLabel = L.marker([0, 0], { pane: "labels", interactive: false, keyboard: false,
    icon: L.divIcon({ className: "", iconSize: [0, 0], html: '<div class="focus-label">½ mile · bike network</div>' }) });
  function maskCanvas(renderer, centre, outside) {
    const el = renderer && renderer._container;
    if (!el) return;
    if (!centre || !renderer._bounds) { el.style.maskImage = el.style.webkitMaskImage = ""; return; }
    const p = map.latLngToLayerPoint(centre), o = renderer._bounds.min;
    const edge = map.latLngToLayerPoint([centre[0], centre[1] + FOCUS_M / (111320 * Math.cos(centre[0] * Math.PI / 180))]);
    const r = Math.max(8, edge.x - p.x), x = p.x - o.x, y = p.y - o.y;
    const g = `radial-gradient(circle ${r.toFixed(1)}px at ${x.toFixed(1)}px ${y.toFixed(1)}px, #000 0, #000 ${(r * 0.62).toFixed(1)}px, rgba(0,0,0,${outside}) ${r.toFixed(1)}px)`;
    el.style.maskImage = el.style.webkitMaskImage = g;
  }
  function applyBikeMask() {
    const c = bikeFocus != null ? [stops[bikeFocus].lat, stops[bikeFocus].lon] : null;
    const outside = bikeOn ? 0.3 : 0;
    maskCanvas(bikeCanvas, c, outside);
  }
  bikeCanvas.on("update", applyBikeMask);
  function setBikeFocus(i) {
    bikeFocus = BIKE ? i : null;
    if (bikeFocus != null) {
      const ll = [stops[i].lat, stops[i].lon];
      focusRing.setLatLng(ll).addTo(map);
      focusLabel.setLatLng(ll).addTo(map);
      placeFocusLabel();
    } else { focusRing.remove(); focusLabel.remove(); }
    updateBike();
  }
  // Try points around the ring, starting at the top and working both ways, and
  // put the label at the first one with no visible bus route within ~28 px.
  function placeFocusLabel() {
    if (bikeFocus == null || !map.hasLayer(focusLabel)) return;
    const s0 = stops[bikeFocus], c = map.latLngToLayerPoint([s0.lat, s0.lon]);
    const edge = map.latLngToLayerPoint([s0.lat, s0.lon + FOCUS_M / (111320 * Math.cos(s0.lat * Math.PI / 180))]);
    const r = edge.x - c.x, pad = 60;
    const segs = [];
    for (const [id, l] of Object.entries(routeLayers)) {
      if (!(routeVisible(id) || state.route === id)) continue;
      for (const part of l.line.getLatLngs()) {
        let prev = null;
        for (const ll of part) {
          const p = map.latLngToLayerPoint(ll);
          if (prev && Math.max(Math.abs(p.x - c.x), Math.abs(prev.x - c.x)) < r + pad * 3 &&
              Math.max(Math.abs(p.y - c.y), Math.abs(prev.y - c.y)) < r + pad * 3) segs.push([prev, p]);
          prev = p;
        }
      }
    }
    const clear = P => {
      let best = Infinity;
      for (const [a, b] of segs) {
        const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, ((P.x - a.x) * dx + (P.y - a.y) * dy) / L2)) : 0;
        best = Math.min(best, Math.hypot(P.x - a.x - t * dx, P.y - a.y - t * dy));
      }
      return best;
    };
    let pick = null, pickScore = -1;
    for (let k = 0; k <= 12; k++) {
      for (const sgn of k ? [-1, 1] : [1]) {
        const th = -Math.PI / 2 + sgn * k * Math.PI / 12;
        const P = L.point(c.x + r * Math.cos(th), c.y + r * Math.sin(th));
        const sc = clear(P);
        if (sc > pickScore) { pick = P; pickScore = sc; }
        if (sc >= 28) { k = 99; break; }
      }
    }
    focusLabel.setLatLng(map.layerPointToLatLng(pick));
  }

  function updateBike() {
    const z = map.getZoom(), k = Math.max(0.7, Math.min(2.2, 1 + (z - 13) * 0.35));
    if (!bikeNet) return;
    const show = bikeOn || bikeFocus != null;
    if (show) {
      bikeNet.addTo(map);
      const kw = Math.max(0.8, Math.min(1.35, 1 + (z - 14) * 0.15));   // only gently with zoom: stays a hairline layer
      if (kw !== bikeKw) {                         // restyle only when the weight actually changes
        bikeKw = kw;
        bikeNet.eachLayer(l => { l.options.weight = BIKE_STYLE[l.feature.properties.c].w * kw; });
        bikeCanvas._redraw && bikeCanvas._redraw();
      }
      renderParking(z >= (bikeFocus != null ? 13.5 : 14));
    } else { bikeNet.remove(); renderParking(false); }
    applyBikeMask();
    const legend = document.getElementById("bike-legend");
    legend.hidden = !bikeOn;
    if (bikeOn && !legend.dataset.built) {
      const order = ["trail", "protected", "lane", "bikeway", "shared", "trail_soft"];
      legend.innerHTML = `<div class="bl-title">Bike network</div>` + order.filter(c => BIKE.km[c]).map(c => {
        const st = BIKE_STYLE[c];
        return `<div class="bl-row"><svg width="26" height="8" aria-hidden="true"><line x1="2" y1="4" x2="24" y2="4" stroke="${st.color}" stroke-opacity="${st.o}" stroke-width="${(st.w * 1.1).toFixed(1)}" stroke-linecap="round"${st.dash ? ` stroke-dasharray="${st.dash}"` : ""}/></svg>${esc(BIKE.classes[c])}<span>${Math.round(BIKE.km[c])} km</span></div>`;
      }).join("") + (BIKE.parking ? `<div class="bl-row"><span class="park-p mini" aria-hidden="true">P</span>Bike parking<span>${BIKE.parking.length}</span></div>
        <div class="bl-note">Parking (P, with a count where grouped) shows when zoomed in. Faded lines are on busier streets.</div>` : "") +
        `<div class="bl-src">City of Fort Collins GIS · © OpenStreetMap contributors</div>`;
      legend.dataset.built = "1";
    }
  }

  // route lines — subway-map bundling. The pipeline gives every vertex a slot
  // offset (in line-widths); here we push each vertex sideways along its miter
  // normal in screen pixels, so parallel ribbons stay crisp at every zoom.
  map.createPane("casing").style.zIndex = 399;
  const routeLayers = {};
  const casingCanvas = L.canvas({ pane: "casing", padding: 0.5 });
  const routeCanvas = L.canvas({ pane: "routes", padding: 0.5, tolerance: 8 });
  const lineWidth = z => Math.min(6.5, Math.max(3, 3 + (z - 12) * 0.8));

  // Screen-space line styling, redone at every zoom so corners look the same at
  // any scale: (1) drop sub-pixel jitter, (2) round every corner with a fixed
  // pixel radius, (3) push the rounded centreline sideways into its slot. Because
  // bundled routes share a centreline and a radius, their rounded corners stay
  // concentric, like the curves on a metro diagram.
  function simplify3(pts, tol) {          // Douglas–Peucker on (x, y, slot·spacing)
    const n = pts.length, keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    for (let i = 1; i < n; i++) if (pts[i].d !== pts[i - 1].d) keep[i] = keep[i - 1] = 1;   // one-way boundaries stay
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b <= a + 1) continue;
      const A = pts[a], B = pts[b], dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z, L2 = dx * dx + dy * dy + dz * dz;
      let best = -1, bd = tol;
      for (let i = a + 1; i < b; i++) {
        const P = pts[i];
        let t = L2 ? ((P.x - A.x) * dx + (P.y - A.y) * dy + (P.z - A.z) * dz) / L2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(P.x - A.x - t * dx, P.y - A.y - t * dy, P.z - A.z - t * dz);
        if (d > bd) { bd = d; best = i; }
      }
      if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function roundCorners(pts, radius) {     // quadratic fillet at each vertex
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const l1 = Math.hypot(a.x - b.x, a.y - b.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
      if (l1 < 1e-6 || l2 < 1e-6) continue;
      const u1x = (a.x - b.x) / l1, u1y = (a.y - b.y) / l1, u2x = (c.x - b.x) / l2, u2y = (c.y - b.y) / l2;
      const cos = Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y)), half = Math.acos(cos) / 2;
      const turn = Math.PI - 2 * half;
      if (turn < 0.08) { out.push(b); continue; }                   // nearly straight
      const t = Math.min(radius / Math.tan(half), l1 * 0.5, l2 * 0.5); // tangent length, never past mid-segment
      const p0 = { x: b.x + u1x * t, y: b.y + u1y * t, z: b.z, d: b.d }, p2 = { x: b.x + u2x * t, y: b.y + u2y * t, z: b.z, d: b.d };
      const k = Math.max(2, Math.ceil(turn / 0.2));
      for (let j = 0; j <= k; j++) {
        const s = j / k, w0 = (1 - s) * (1 - s), w1 = 2 * (1 - s) * s, w2 = s * s;
        out.push({ x: w0 * p0.x + w1 * b.x + w2 * p2.x, y: w0 * p0.y + w1 * b.y + w2 * p2.y, z: b.z, d: b.d });
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }
  function offsetPart(coords, offs, dirs, spacing, zoom) {
    let pts = coords.map((c, i) => { const p = map.project([c[1], c[0]], zoom); return { x: p.x, y: p.y, z: offs[i] * spacing, d: dirs ? dirs[i] : 0 }; });
    pts = roundCorners(simplify3(pts, 0.75), Math.max(10, spacing * 3.5));
    const n = pts.length, out = new Array(n), scr = new Array(n);
    const nrm = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1; return [dy / L, -dx / L]; };
    for (let i = 0; i < n; i++) {
      const o = pts[i].z;
      if (!o) { scr[i] = { x: pts[i].x, y: pts[i].y, d: pts[i].d }; out[i] = map.unproject(L.point(pts[i].x, pts[i].y), zoom); continue; }
      // left normals of the segments either side of this vertex (screen y points down)
      const n1 = i > 0 ? nrm(pts[i - 1], pts[i]) : null, n2 = i < n - 1 ? nrm(pts[i], pts[i + 1]) : null;
      let nx, ny;
      if (n1 && n2) {
        nx = n1[0] + n2[0]; ny = n1[1] + n2[1];
        const L2 = Math.hypot(nx, ny);
        if (L2 < 1e-6) { nx = n1[0]; ny = n1[1]; }
        else {
          nx /= L2; ny /= L2;
          const miter = Math.min(2.5, 1 / Math.max(0.2, nx * n1[0] + ny * n1[1]));  // keep width through corners
          nx *= miter; ny *= miter;
        }
      } else [nx, ny] = n1 || n2;
      scr[i] = { x: pts[i].x + nx * o, y: pts[i].y + ny * o, d: pts[i].d };
      out[i] = map.unproject(L.point(scr[i].x, scr[i].y), zoom);
    }
    return { ll: out, scr };
  }
  // Chevrons along one-way stretches (flagged in the pipeline: where a route's
  // two directions run on different streets, each line gets its own arrows).
  function chevrons(scr, w, zoom) {
    const out = [], gap = Math.max(64, w * 16), size = Math.max(2.2, w * 0.6);
    let run = gap * 0.5;
    for (let i = 0; i < scr.length - 1; i++) {
      const a = scr[i], b = scr[i + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (!a.d || a.d !== b.d || L < 1e-6) { run = gap * 0.5; continue; }
      const tx = (b.x - a.x) / L * a.d, ty = (b.y - a.y) / L * a.d, nx = -ty, ny = tx;
      let pos = run;
      while (pos <= L) {
        const k = pos / L, cx = a.x + (b.x - a.x) * k, cy = a.y + (b.y - a.y) * k;
        out.push([[cx - tx * size * 0.5 + nx * size, cy - ty * size * 0.5 + ny * size],
                  [cx + tx * size * 0.6, cy + ty * size * 0.6],
                  [cx - tx * size * 0.5 - nx * size, cy - ty * size * 0.5 - ny * size]]
          .map(([x, y]) => map.unproject(L_point(x, y), zoom)));
        pos += gap;
      }
      run = pos - L;
    }
    return out;
  }
  const L_point = (x, y) => L.point(x, y);
  function layoutRoutes() {
    const z = map.getZoom(), w = lineWidth(z), spacing = w + 1;   // 1px casing gap between ribbons
    for (const l of Object.values(routeLayers)) {
      const parts = l.f.geometry.coordinates.map((c, k) => offsetPart(c, l.f.properties.o[k], (l.f.properties.d || [])[k], spacing, z));
      const ll = parts.map(p => p.ll);
      l.casing.setLatLngs(ll); l.line.setLatLngs(ll);
      l.arrows.setLatLngs(z >= 12.5 ? parts.flatMap(p => chevrons(p.scr, w, z)) : []);
    }
    styleRoutes();
    if (typeof placeFocusLabel === "function") placeFocusLabel();
  }

  for (const f of ROUTE_GEO.features) {
    const r = routeById[f.properties.route];
    if (!r) continue;
    const ll = f.geometry.coordinates.map(part => part.map(c => [c[1], c[0]]));
    const casing = L.polyline(ll, { pane: "casing", renderer: casingCanvas, interactive: false,
      color: "#06080c", opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(map);
    const line = L.polyline(ll, { pane: "routes", renderer: routeCanvas,
      color: r.color, opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(map);
    line.on("click", e => { L.DomEvent.stopPropagation(e); go(`route-${r.id}`); });
    line.on("mouseover", () => { if (!state.route) hoverRoute(r.id, true); });
    line.on("mouseout", () => { if (!state.route) hoverRoute(r.id, false); });
    line.bindTooltip(`<span class="badge sm" style="--c:${r.color};--t:${r.text}">${r.short}</span> ${r.desc}`,
      { sticky: true, className: "tt", direction: "top", offset: [0, -8] });
    const arrows = L.polyline([], { pane: "routes", renderer: routeCanvas, interactive: false,
      color: "#06080c", weight: 1.7, opacity: 0.8, lineCap: "round", lineJoin: "round" }).addTo(map);
    routeLayers[r.id] = { casing, line, arrows, f };
  }
  // Visible on the map: the selected route, or (with the "running now" filter)
  // routes in service right now. The rest stay as faint ghosts for context.
  function routeVisible(id) {
    if (state.route) return state.route === id;
    const r = routeById[id];
    return (r.scope || "local") === scope && (!runningOnly || routeStatus(id).running);
  }
  function styleRoutes() {
    if (typeof updateAlertStops === "function" && HUBS_READY) { updateAlertStops(); updateHubs(); }
    const sel = state.route, w = lineWidth(map.getZoom());
    for (const [id, { casing, line, arrows }] of Object.entries(routeLayers)) {
      const on = routeVisible(id);
      const ghost = !sel && !on;
      const dimForBike = bikeOn && sel !== id ? 0.7 : 1;       // let the bike network read through
      line.setStyle({ opacity: (on ? 0.95 : ghost ? 0.08 : 0.14) * dimForBike, weight: sel === id ? w + 1.5 : w });
      casing.setStyle({ opacity: on ? 0.95 * dimForBike : 0, weight: (sel === id ? w + 1.5 : w) + 3 });
      arrows.setStyle({ opacity: on ? 0.8 * dimForBike : 0 });
      if (sel === id) { casing.bringToFront(); line.bringToFront(); arrows.bringToFront(); }
    }
  }
  function hoverRoute(id, on) {
    const l = routeLayers[id], w = lineWidth(map.getZoom());
    if (!l) return;
    l.line.setStyle({ weight: on ? w + 1.5 : w });
    if (on) { l.line.bringToFront(); l.arrows.bringToFront(); }
  }

  // stops
  // Stops and hubs use SVG: a Leaflet canvas covers its whole pane
  // and swallows clicks meant for layers underneath, while SVG only catches
  // clicks on what it actually draws. The heavy route lines stay on canvas.
  const stopCanvas = L.svg({ pane: "stops", padding: 0.5 });
  const stopMarkers = stops.map((s, i) => {
    const m = L.circleMarker([s.lat, s.lon], { renderer: stopCanvas, pane: "stops", radius: 3.5, weight: 2,
      color: "#06080c", fillColor: "#c5ccd8", fillOpacity: 1, interactive: false });
    // invisible, larger tap target that carries the events
    const hit = L.circleMarker([s.lat, s.lon], { renderer: stopCanvas, pane: "stops", radius: 11, stroke: false,
      fillColor: "#000", fillOpacity: 0, className: "stop-hit" });
    hit.bindTooltip(() => `<b>${esc(s.name)}</b><br><span class="muted">${s.routes.map(badge.bind(null, "sm")).join(" ")}</span>`,
      { className: "tt", direction: "top", offset: [0, -8] });
    hit.on("click", e => { L.DomEvent.stopPropagation(e); go(`stop-${s.id}`); });
    // hover: grow and outline, like the transit-center discs
    hit.on("mouseover", () => { if (!(state.view === "stop" && state.stop === i)) m.setStyle({ radius: (m._base || 4) + 2.5, color: "#e6ebf2", weight: 2.5 }); });
    hit.on("mouseout", () => styleStop(i, true));
    m._hit = hit;
    return m;
  });
  const stopLayer = L.layerGroup().addTo(map);
  // Stops are diffed, not rebuilt: only stops whose visibility changed are added
  // or removed, and a stop is restyled only when its look actually changes.
  // (Clearing and re-adding ~900 SVG elements on every zoom was the main hitch.)
  const stopShown = new Set();
  let stopCtx = null;                              // shared inputs of the current pass
  function stopStyle(i) {
    const { z, r, color, sel } = stopCtx;
    const base = z >= 15 ? 5 : z >= 14 ? 4 : z >= 13.5 ? 3 : 2.5;
    const st = i === sel
      ? { fillColor: "#f4b44a", color: "#06080c", radius: base + 2.5, weight: 2.5 }
      : { fillColor: r ? "#06080c" : color, color: r ? color : "#06080c", radius: base, weight: r ? 2.5 : z >= 14 ? 2 : 1.5 };
    return { base, st, key: `${st.fillColor}|${st.color}|${st.radius}|${st.weight}` };
  }
  function styleStop(i, force) {
    if (!stopCtx || !stopShown.has(i)) return;
    const m = stopMarkers[i], { base, st, key } = stopStyle(i);
    if (!force && m._key === key) return;
    m.setStyle(st); m._key = key; m._base = base;
    const hr = Math.max(9, base + 6);
    if (m._hit.getRadius() !== hr) m._hit.setRadius(hr);
  }
  function updateStops() {
    const z = map.getZoom();
    const r = state.route ? routeById[state.route] : null;
    stopCtx = { z, r, color: r ? r.color : "#c5ccd8", sel: state.view === "stop" ? state.stop : null };
    const vis = new Set(r ? [r.id] : z >= 12.5 ? routes.filter(x => routeVisible(x.id)).map(x => x.id) : []);
    stops.forEach((s, i) => {
      const on = !hiddenInHub.has(i) &&               // the hub disc stands in for these
        (i === stopCtx.sel || s.routes.some(id => vis.has(id)));
      if (!on) {
        if (stopShown.has(i)) { stopLayer.removeLayer(stopMarkers[i]); stopLayer.removeLayer(stopMarkers[i]._hit); stopShown.delete(i); }
        return;
      }
      if (!stopShown.has(i)) {
        stopShown.add(i); stopMarkers[i]._key = null;
        stopLayer.addLayer(stopMarkers[i]); stopLayer.addLayer(stopMarkers[i]._hit);
      }
      styleStop(i, false);
    });
  }
  let selRing = null, selLabel = null;
  function markStop(i) {
    if (selRing) { selRing.remove(); selRing = null; }
    if (selLabel) { selLabel.remove(); selLabel = null; }
    setBikeFocus(i);
    if (i == null || hubStop.has(i)) return;
    selRing = L.marker([stops[i].lat, stops[i].lon], { pane: "buses", interactive: false,
      icon: L.divIcon({ className: "", html: '<div class="stop-ring"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map);
    selLabel = L.marker([stops[i].lat, stops[i].lon], { pane: "labels", interactive: false, keyboard: false,
      icon: L.divIcon({ className: "", iconSize: [0, 0], html: `<div class="hub-label stop-label"><b>${esc(stops[i].name)}</b><span>Stop #${esc(stops[i].code || stops[i].id)}</span></div>` }) }).addTo(map);
  }

  // stops named in rider alerts (closed / new / affected), always on top of the network
  const alertStopLayer = L.layerGroup().addTo(map);
  function updateAlertStops() {
    alertStopLayer.clearLayers();
    for (const a of currentAlerts()) for (const st of a.stops) {
      if (!a.routes.some(routeVisible)) continue;      // follow the route filter
      const i = stopById[st.id];
      if (i == null) continue;
      const s = stops[i], glyph = { closed: "×", new: "+", affected: "!" }[st.role];
      L.marker([s.lat, s.lon], { pane: "buses", keyboard: false,
        icon: L.divIcon({ className: "", iconSize: [0, 0],
          html: `<div class="alert-pin role-${st.role}" aria-hidden="true">${glyph}</div>` }) })
        .bindTooltip(`<b>${esc(s.name)}</b> · ${ROLE_LABEL[st.role]}<br><span class="muted">${esc(a.text)}</span>`,
          { className: "tt", direction: "top", offset: [0, -10] })
        .on("click", () => go(`stop-${s.id}`))
        .addTo(alertStopLayer);
    }
  }

  // schematic transit centers: a disc where the routes' spokes meet
  map.createPane("hubs").style.zIndex = 460;
  const HUBS = (S.hubs || []).map(h => ({ ...h, i: stopById[h.stop] }));
  const hubLayer = L.layerGroup().addTo(map), hubLabels = L.layerGroup();
  // The disc follows the hub's real size up close but never grows past ~30 px,
  // so it reads as a station symbol rather than a blob.
  const hubPx = h => {
    const mpp = 40075016.686 * Math.cos(h.lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
    return Math.max(7, Math.min(30, h.r / mpp));
  };
  const hubSvg = L.svg({ pane: "hubs", padding: 0.5 });
  for (const h of HUBS) {
    const disc = L.circleMarker([h.lat, h.lon], { radius: 10, pane: "hubs", renderer: hubSvg, color: "#e6ebf2", weight: 3,
      fillColor: "#0c1017", fillOpacity: 1 });
    disc.bindTooltip(`<b>${esc(h.name)}</b><br><span class="muted">${h.routes.map(badge.bind(null, "sm")).join(" ")}</span>`,
      { className: "tt", direction: "top", offset: [0, -14] });
    disc.on("click", e => { L.DomEvent.stopPropagation(e); go(`stop-${h.stop}`); });
    hubLayer.addLayer(disc);
    h.label = L.marker([h.lat, h.lon], { pane: "labels", interactive: false, keyboard: false,
      icon: L.divIcon({ className: "", iconSize: [0, 0], html: `<div class="hub-label"><b>${esc(h.short)}</b><span>Transit Center</span></div>` }) });
    hubLabels.addLayer(h.label);
  }
  const inHub = s => HUBS.some(h => map.distance([s.lat, s.lon], [h.lat, h.lon]) < h.r);
  const hiddenInHub = new Set(stops.map((s, i) => inHub(s) ? i : -1).filter(i => i >= 0));
  const hubStop = new Set(HUBS.map(h => h.i));
  function updateHubs() {
    const z = map.getZoom(), sel = state.route, selStop = state.view === "stop" ? state.stop : null;
    z >= 14 ? hubLabels.addTo(map) : hubLabels.remove();
    HUBS.forEach((h, k) => {
      const l = hubLayer.getLayers()[k], on = h.routes.some(routeVisible), px = hubPx(h);
      l.setRadius(px);
      l.setStyle({ opacity: on ? 1 : 0.25, fillOpacity: on ? 1 : 0.4, weight: px > 20 ? 4 : 3,
        color: selStop === h.i ? "#f4b44a" : "#e6ebf2" });
      const el = h.label.getElement && h.label.getElement();
      if (el) el.firstChild.style.top = `${px + 14}px`;
    });
  }

  // buses
  let showBuses = true;
  const busLayer = L.layerGroup().addTo(map), busMarkers = new Map();
  // Buses glide: every 4 s we work out which trips are on the road; between
  // those refreshes an animation frame moves each one along its route shape by
  // the clock, so motion is continuous rather than a jump every few seconds.
  // A small chevron orbits each badge to show which way it's heading.
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let fleet = [], clockBase = { min: 0, at: 0 }, zooming = false;
  map.on("zoomstart", () => { zooming = true; });
  map.on("zoomend", () => { zooming = false; placeBuses(); });

  function fractionAt(b, now) {               // where along its pattern a trip is at `now`
    const tr = trips[b.trip], t = tr.t, p = patterns[tr.p];
    now -= b.off * 1440;
    if (now <= t[0]) return p.f[0];
    if (now >= t[t.length - 1]) return p.f[t.length - 1];
    let i = Math.min(b.seg || 0, t.length - 2);
    while (i > 0 && t[i] > now) i--;
    while (i < t.length - 2 && t[i + 1] <= now) i++;
    b.seg = i;
    const span = t[i + 1] - t[i], k = span > 0 ? (now - t[i]) / span : 1;
    return p.f[i] + (p.f[i + 1] - p.f[i]) * k;
  }
  function placeBuses() {
    if (!fleet.length || zooming) return;
    const now = clockBase.min + (performance.now() - clockBase.at) / 60000;
    for (const b of fleet) {
      const p = patterns[trips[b.trip].p], f = fractionAt(b, now);
      const ll = pointAt(p, f);
      b.m.setLatLng(ll);
      // heading: chord across ±15 m of the shape, measured on screen
      const eps = 15 / (p.len * 111320);
      const A = map.latLngToLayerPoint(pointAt(p, Math.max(0, f - eps)));
      const B = map.latLngToLayerPoint(pointAt(p, Math.min(1, f + eps)));
      if (Math.hypot(B.x - A.x, B.y - A.y) > 0.5) {
        const target = Math.atan2(B.y - A.y, B.x - A.x);
        let d = target - (b.ang ?? target);
        d = Math.atan2(Math.sin(d), Math.cos(d));          // shortest way round
        b.ang = (b.ang ?? target) + d * (reduceMotion ? 1 : 0.25);
      }
      if (b.arrow && b.ang != null) {
        // sit the chevron on an ellipse just outside the badge
        const rx = b.w / 2 + 5, ry = 9 + 5, c = Math.cos(b.ang), s = Math.sin(b.ang);
        const r = rx * ry / Math.hypot(ry * c, rx * s);
        b.arrow.style.transform = `translate(${(c * r).toFixed(1)}px, ${(s * r).toFixed(1)}px) rotate(${b.ang.toFixed(3)}rad)`;
      }
    }
  }
  let lastFrame = 0;
  function animate(ts) {
    if (ts - lastFrame > 33 && !document.hidden) { lastFrame = ts; placeBuses(); }   // ~30 fps
    requestAnimationFrame(animate);
  }
  if (!reduceMotion) requestAnimationFrame(animate);

  function updateBuses() {
    const n = nowLocal();
    clockBase = { min: n.min, at: performance.now() };
    if (!showBuses) { busLayer.clearLayers(); busMarkers.clear(); fleet = []; document.getElementById("bus-count").textContent = 0; return; }
    const live = liveBuses(state.route).filter(b => routeVisible(b.route)), keep = new Set(), next = [];
    for (const b of live) {
      keep.add(b.key);
      let rec = busMarkers.get(b.key);
      if (!rec) {
        const r = routeById[b.route];
        const m = L.marker(b.ll, { pane: "buses", keyboard: false,
          icon: L.divIcon({ className: "", iconSize: [0, 0],
            html: `<div class="bus-wrap" style="--c:${r.color};--t:${r.text}"><i class="bus-dir"></i><div class="bus">${r.short}</div></div>` }) });
        m.on("click", () => go(`route-${b.route}`));
        busLayer.addLayer(m);
        const el = m.getElement();
        rec = { m, arrow: el && el.querySelector(".bus-dir"), w: (el && el.querySelector(".bus").offsetWidth) || 30 };
        busMarkers.set(b.key, rec);
      }
      Object.assign(rec, { trip: b.trip, off: b.off, seg: rec.seg ?? b.seg });
      rec.m.bindTooltip(`${badge("sm", b.route)} to <b>${esc(b.head)}</b><br><span class="muted">Next stop: ${esc(stops[b.nextStop].name)}</span>`,
        { className: "tt", direction: "top", offset: [0, -12] });
      next.push(rec);
    }
    for (const [k, rec] of busMarkers) if (!keep.has(k)) { busLayer.removeLayer(rec.m); busMarkers.delete(k); }
    fleet = next;
    placeBuses();
    document.getElementById("bus-count").textContent = live.length;
  }

  // initial view: the Fort Collins network (excludes the long FLEX tail to Boulder)
  // regional context: town outlines + names where the street basemap ends
  const cityLayer = BASE.cities ? L.geoJSON(BASE.cities, { pane: "base", renderer: baseCanvas, interactive: false,
    style: { color: "#2a3342", weight: 1, dashArray: "3 4", fillColor: "#10151e", fillOpacity: 0.55 } }) : null;
  const cityLabels = L.layerGroup((BASE.cityLabels || []).map(c => L.marker([c.lat, c.lon], { pane: "base", interactive: false, keyboard: false,
    icon: L.divIcon({ className: "", iconSize: [0, 0], html: `<div class="city-label${c.area > 60 ? " big" : ""}">${esc(c.n)}</div>` }) })));
  function updateContext() {
    const z = map.getZoom();
    if (cityLayer) z < 12.5 ? cityLayer.addTo(map) : cityLayer.remove();
    cityLabels.eachLayer(l => {
      const c = BASE.cityLabels[cityLabels.getLayers().indexOf(l)];
      const show = z < 12 && (c.area > 60 || (z >= 9.5 && c.area > 25) || z >= 10.5);
      show ? l.addTo(map) : l.remove();
    });
  }

  const scopeBounds = sc => {
    const ids = new Set(routes.filter(r => (r.scope || "local") === sc).map(r => r.id));
    const pts = stops.filter(s => s.routes.some(r => ids.has(r)));
    return L.latLngBounds(pts.map(s => [s.lat, s.lon]));
  };
  const coreBounds = scopeBounds("local");
  map.fitBounds(scope === "regional" ? scopeBounds("regional") : coreBounds, { padding: [20, 20] });
  map.on("zoomend", () => { layoutRoutes(); restyleStreets(); updateStops(); updateHubs(); updateContext(); updateBike(); map.getZoom() >= 13 ? labelLayer.addTo(map) : labelLayer.remove(); });
  map.on("click", () => { if (state.route || state.stop != null) go(""); });
  restyleStreets(); layoutRoutes(); updateContext(); updateBike();
  if (map.getZoom() >= 13) labelLayer.addTo(map);

  // ------------------------------------------------------------------- UI
  const $ = s => document.querySelector(s);
  const body = $("#panel-body");

  function badge(size, id) {
    const r = routeById[id];
    return r ? `<span class="badge ${size}" style="--c:${r.color};--t:${r.text}">${r.short}</span>` : "";
  }
  const STAR = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z"/></svg>';
  const STAR_O = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z"/></svg>';
  const BACK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---------------------------------------------------------- rider alerts
  let ALERTS = ALERTS0;
  const live = { mcp: null, db: null, can: false, busy: false, msg: "", tone: "" };
  const ROLE_LABEL = { closed: "stop closed", new: "new stop", affected: "affected" };
  const ICON = {
    detour: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 20V9a3 3 0 0 1 3-3h9"/><path d="M14 2.5 17.5 6 14 9.5"/></svg>',
    closure: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.2"/></svg>',
    vehicle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3.5" width="14" height="14" rx="2.5"/><path d="M5 11h14M8.5 20.5v-3M15.5 20.5v-3"/></svg>',
  };
  const KIND_LABEL = { detour: "Detour", closure: "Stop closure", info: "Service info", vehicle: "Vehicle notice" };
  const serious = a => a.kind === "detour" || a.kind === "closure";
  function todayISO() {
    const n = nowLocal();
    return `${n.y}-${String(n.m).padStart(2, "0")}-${String(n.d).padStart(2, "0")}`;
  }
  function alertStatus(a) {
    const t = todayISO();
    return a.start && a.start > t ? "upcoming" : a.end && a.end < t ? "ended" : "active";
  }
  const currentAlerts = () => (ALERTS.alerts || []).filter(a => alertStatus(a) !== "ended");
  const alertsForRoute = id => currentAlerts().filter(a => a.routes.includes(id));
  const alertsForStop = id => currentAlerts().filter(a => a.stops.some(st => st.id === id));
  function fmtDay(isoDate) {
    const [y, m, d] = isoDate.split("-").map(Number), dt = new Date(Date.UTC(y, m - 1, d));
    const thisYear = y === nowLocal().y;
    return dt.toLocaleDateString("en-US", thisYear ? { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }
      : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }
  function alertWhen(a) {
    const st = alertStatus(a);
    const head = st === "upcoming" ? `Starts ${fmtDay(a.start)}` : a.start ? `Since ${fmtDay(a.start)}` : "In effect";
    return head + (a.end ? ` · until ${fmtDay(a.end)}` : "");
  }
  function alertCard(a, { routes = true } = {}) {
    const st = alertStatus(a);
    const stopsHtml = a.stops.length ? `<div class="alert-stops">${a.stops.map(x => x.id && x.id in stopById
      ? `<button class="stop-chip role-${x.role}" data-go="stop-${x.id}">${esc(x.name)} <span>${ROLE_LABEL[x.role]}</span></button>`
      : `<span class="stop-chip role-${x.role}">Stop #${esc(x.code)} <span>${ROLE_LABEL[x.role]}, not in schedule data yet</span></span>`).join("")}</div>` : "";
    return `<article class="alert k-${a.kind}${st === "upcoming" ? " upcoming" : ""}">
      <div class="alert-head"><span class="kind">${ICON[a.kind]}${KIND_LABEL[a.kind]}</span>
        ${routes ? `<span class="alert-routes">${a.routes.map(r => badge("sm", r)).join("")}</span>` : ""}
        <span class="alert-when${st === "upcoming" ? " soon" : ""}">${alertWhen(a)}</span></div>
      <p>${esc(a.text)}</p>${stopsHtml}</article>`;
  }
  function docsList(routeIds) {
    const seen = new Set(), items = [];
    for (const r of routeIds) for (const d of (ALERTS.docs || {})[r] || [])
      if (!seen.has(d.url)) { seen.add(d.url); items.push(d); }
    if (!items.length) return "";
    return `<div class="section-label">Detour maps & notices</div><ul class="docs">${items.map(d =>
      `<li><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a>${d.start ? `<span>${alertWhen({ start: d.start, end: d.end })}</span>` : ""}</li>`).join("")}</ul>`;
  }
  function fmtStamp(isoStamp) {
    if (!isoStamp) return "";
    const d = new Date(isoStamp);
    return d.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function alertsBlock() {
    const cur = currentAlerts();
    const top = cur.filter(serious), rest = cur.filter(a => !serious(a));
    const btn = live.can ? `<button class="refresh" id="alerts-refresh" ${live.busy ? "disabled" : ""}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/></svg>
      ${live.busy ? "Checking…" : "Check now"}</button>` : "";
    return `<section class="alerts-block" aria-label="Service alerts">
      <div class="block-head"><div class="section-label">Service alerts · ${cur.length}</div>${btn}</div>
      ${cur.length ? "" : `<p class="alerts-meta">No alerts posted right now.</p>`}
      ${top.map(a => alertCard(a)).join("")}
      ${rest.length ? `<details class="more"><summary>${rest.length} more notice${rest.length === 1 ? "" : "s"} (service info, vehicles)</summary>${rest.map(a => alertCard(a)).join("")}</details>` : ""}
      <p class="alerts-meta">From <a href="${esc(TransitAlerts.ALERTS_URL)}" target="_blank" rel="noopener">ridetransfort.com</a> · checked ${fmtStamp(ALERTS.fetched_at)}</p>
      ${live.msg ? `<p class="alerts-status ${live.tone}" role="status">${esc(live.msg)}</p>` : ""}
    </section>`;
  }
  function applyAlerts(d) {
    ALERTS = d;
    updateAlertStops();
    render(true);
  }
  function liveError(e) {
    switch (e && e.code) {
      case "server_not_connected": return "Live checks run through Claude's browser, so they work when this map is open in the Claude desktop app.";
      case "not_in_manifest": case "approval_required": case "cancelled": case "consent_required":
        return "Browser access to ridetransfort.com wasn't allowed, so the alerts weren't checked.";
      case "layout": return "ridetransfort.com loaded, but its alerts table wasn't where expected. The page layout may have changed.";
      case "tool_error": return "Claude's browser couldn't read the alerts page: " + (e.message || "unknown error");
      case "server_unavailable": case "upstream_error": return "Claude's browser didn't answer in time. Try again in a moment.";
      default: return "Couldn't check alerts: " + (e && e.message || "unknown error");
    }
  }
  async function refreshAlerts() {
    if (live.busy) return;
    live.busy = true; live.tone = ""; live.msg = "Opening the alerts page in Claude's browser…";
    render(true);
    try {
      const d = await TransitAlerts.fetchLive(live.mcp, stops);
      applyAlerts(d);
      live.tone = "ok";
      live.msg = `Updated · ${d.alerts.length} alert${d.alerts.length === 1 ? "" : "s"} on ridetransfort.com`;
      if (live.db) {
        try { await live.db.doc("alerts/current").set(JSON.parse(JSON.stringify(d))); live.msg += " · saved for everyone viewing this map"; }
        catch (e) { live.msg += " · couldn't save them for other viewers"; }
      }
    } catch (e) {
      live.tone = "err"; live.msg = liveError(e);
    } finally {
      live.busy = false;
      render(true);
    }
  }

  function etaCell(d) {
    const e = etaText(d.delta);
    return `<div class="when"><div class="eta${e.now ? " now" : ""}">${e.main}</div><div class="eta-sub">${clockFmt(d.t)}</div></div>`;
  }
  function headwayText(r) {
    if (r.headway) return `Every ${r.headway} min`;
    if (r.tripsWeekday) return `${r.tripsWeekday} weekday trips`;
    return "Special service";
  }

  function routeRow(r) {
    const st = routeStatus(r.id);
    return `<button class="row${st.running ? "" : " off"}" data-go="route-${r.id}" data-hover="${r.id}">
      ${badge("", r.id)}
      <div class="main"><div class="title">${esc(r.desc)}</div>
      <div class="sub">${statusPill(st)}<span class="note">${statusNote(r, st)}</span></div></div>
      ${(() => { const a = alertsForRoute(r.id).find(serious); return a ? `<span class="alert-dot k-${a.kind}" title="${KIND_LABEL[a.kind]}" aria-label="${KIND_LABEL[a.kind]}">${ICON[a.kind]}</span>` : ""; })()}
      ${isFav("routes", r.id) ? `<span style="color:var(--fav);width:16px">${STAR}</span>` : ""}
    </button>`;
  }
  function stopRow(i, withNext = true) {
    const s = stops[i];
    const next = withNext ? departures(i, { limit: 1, horizon: 24 * 60 })[0] : null;
    return `<button class="row" data-go="stop-${s.id}">
      <div class="main"><div class="title">${esc(s.name)}</div>
      <div class="sub chips">${s.routes.map(r => badge("sm", r)).join("")}<span style="margin-left:4px">#${esc(s.code || s.id)}</span></div></div>
      ${next ? `<div class="when"><div class="eta${next.delta < 1 ? " now" : ""}">${etaText(next.delta).main}</div><div class="eta-sub">${routeById[next.route].short} · ${clockFmt(next.t)}</div></div>` : ""}
    </button>`;
  }

  function viewHome() {
    const q = state.q.trim().toLowerCase();
    if (q) {
      const rs = routes.filter(r => (r.short + " " + r.desc + " " + r.long).toLowerCase().includes(q));
      const ss = stops.map((s, i) => i).filter(i => (stops[i].name + " " + stops[i].code).toLowerCase().includes(q)).slice(0, 40);
      const ps = pins.searchHtml(q);
      if (!rs.length && !ss.length && !ps) return `<div class="empty">No routes, stops or pins match “${esc(state.q)}”.<br>Try a street name like “College” or a stop number.</div>`;
      return ps + (rs.length ? `<div class="section-label">Routes</div>${rs.map(routeRow).join("")}` : "") +
        (ss.length ? `<div class="section-label">Stops</div>${ss.map(i => stopRow(i)).join("")}` : "");
    }
    if (state.tab === "pins") return pins.viewList();
    if (state.tab === "favs") {
      const fr = favs.routes.filter(id => routeById[id]), fs = favs.stops.filter(id => id in stopById);
      if (!fr.length && !fs.length) return `<div class="empty">${STAR_O.replace("<svg", '<svg width="28" height="28"')}
        <p>No favorites yet.</p><p style="font-size:13px">Open a route or a stop and tap the star. Favorites stay in this browser.</p></div>`;
      return (fs.length ? `<div class="section-label">Stops · next bus</div>${fs.map(id => stopRow(stopById[id])).join("")}` : "") +
        (fr.length ? `<div class="section-label">Routes</div>${fr.map(id => routeRow(routeById[id])).join("")}` : "");
    }
    const inScope = routes.filter(r => (r.scope || "local") === scope);
    const nLocal = routes.filter(r => (r.scope || "local") === "local").length, nRegional = routes.length - nLocal;
    const running = inScope.filter(r => routeStatus(r.id).running), idle = inScope.filter(r => !routeStatus(r.id).running);
    const shown = runningOnly ? running : inScope;
    const filterBar = `<div class="seg route-filter" role="group" aria-label="Local or regional routes">
      <button data-scope="local" aria-pressed="${scope === "local"}">Local · ${nLocal}</button>
      <button data-scope="regional" aria-pressed="${scope === "regional"}">Regional · ${nRegional}</button></div>
      <button class="toggle" data-running role="switch" aria-checked="${runningOnly}">
        <span class="switch" aria-hidden="true"></span><span class="status on"><i></i></span>Running now only
        <span class="count">${running.length} of ${inScope.length}</span></button>`;
    const label = scope === "local" ? "Fort Collins" : "Regional";
    let list;
    if (runningOnly && !running.length) {
      const soonest = idle.map(r => ({ r, st: routeStatus(r.id) })).filter(x => x.st.next != null)
        .sort((a, b) => a.st.days - b.st.days || a.st.next - b.st.next)[0];
      list = `<div class="empty">No ${scope} routes are running right now.${soonest ? `<br>${esc(nextServiceText(soonest.st))} (${esc(soonest.r.short)}).` : ""}</div>`;
    } else if (scope === "regional") {
      const byAgency = {};
      shown.forEach(r => (byAgency[r.agency] = byAgency[r.agency] || []).push(r));
      list = Object.entries(byAgency).map(([ag, rs]) => `<div class="section-label">${esc(ag)}${runningOnly ? " · in service now" : ""}</div>${rs.map(routeRow).join("")}`).join("");
    } else {
      list = `<div class="section-label">${label}${runningOnly ? " · in service now" : ` · ${shown.length} routes`}</div>${shown.map(routeRow).join("")}`;
    }
    const hiddenNote = runningOnly && idle.length
      ? `<button class="show-all" data-running>${idle.length} ${scope} route${idle.length === 1 ? " isn't" : "s aren't"} running now: ${idle.map(r => esc(r.short)).join(", ")} · Show all</button>` : "";
    return `${alertsBlock()}${filterBar}${list}${hiddenNote}
      <p class="foot">Times are from Transfort's published schedule (GTFS feed ${esc(S.feed.version || "")}, valid
      ${fmtDate(S.feed.start)} – ${fmtDate(S.feed.end)}) and, for Bustang, CDOT's feed published by RTD. Bus positions on the map are where each bus should be
      according to that schedule, not live GPS.</p>`;
  }
  function fmtDate(k) {
    if (!k) return "";
    const d = new Date(Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8)));
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }

  function routeDirections(id) {
    // main (busiest) pattern per direction
    const best = {};
    patterns.forEach((p, i) => {
      if (p.r !== id) return;
      if (!(p.d in best) || patternTrips[i] > patternTrips[best[p.d]] ||
          (patternTrips[i] === patternTrips[best[p.d]] && p.s.length > patterns[best[p.d]].s.length)) best[p.d] = i;
    });
    return Object.entries(best).sort((a, b) => a[0] - b[0]).map(([d, i]) => ({ d: +d, p: patterns[i] }));
  }

  function viewRoute() {
    const r = routeById[state.route];
    if (!r) return viewHome();
    const dirs = routeDirections(r.id);
    if (!dirs.some(x => x.d === state.dir)) state.dir = dirs[0]?.d ?? 0;
    const cur = dirs.find(x => x.d === state.dir);
    const today = runsToday(r.id);
    const buses = liveBuses(r.id).filter(b => patterns[trips[b.trip].p].d === state.dir);
    const busAt = new Map();   // stop position in main pattern -> buses heading to it
    if (cur) buses.forEach(b => {
      const pos = cur.p.s.indexOf(b.nextStop);
      if (pos >= 0) busAt.set(pos, (busAt.get(pos) || 0) + 1);
    });
    const stopsHtml = cur ? cur.p.s.map((si, pos) => {
      const s = stops[si], last = pos === cur.p.s.length - 1;
      const next = last ? null : departures(si, { limit: 1, route: r.id, dir: state.dir, horizon: 24 * 60 })[0];
      const bus = busAt.get(pos) ? `<span class="bus-here"><span class="bus" style="--c:${r.color};--t:${r.text};min-width:22px;height:16px;font-size:10px;transform:none">▼</span></span>` : "";
      return `<li class="${pos === 0 || last ? "term" : ""}">${bus}<span class="dot"></span>
        <button class="row" data-go="stop-${s.id}"><div class="main"><div class="title">${esc(s.name)}</div>
        <div class="sub">${last ? "Last stop" : s.routes.length > 1 ? "Transfer: " + s.routes.filter(x => x !== r.id).map(x => routeById[x]?.short).join(", ") : "&nbsp;"}</div></div>
        ${next ? etaCell(next) : ""}</button></li>`;
    }).join("") : "";
    return `<button class="back" data-go="">${BACK} All routes</button>
      <div class="detail-head">${badge("lg", r.id)}<div class="main"><h2>${esc(r.desc)}</h2><p>${esc(r.long)}${r.agency && r.agency !== S.agency.name ? ` · ${esc(r.agency)}` : ""}</p></div>
        <button class="star" data-fav="routes:${r.id}" aria-pressed="${isFav("routes", r.id)}" aria-label="Favorite route ${esc(r.short)}">${isFav("routes", r.id) ? STAR : STAR_O}</button></div>
      <div class="stats">
        <div class="stat"><b>${r.headway ? r.headway + "′" : "—"}</b><span>Midday freq.</span></div>
        <div class="stat"><b>${r.first != null ? clockFmt(r.first).replace(" ", "") : "—"}</b><span>First bus</span></div>
        <div class="stat"><b>${r.last != null ? clockFmt(r.last).replace(" ", "") : "—"}</b><span>Last bus</span></div>
        <div class="stat"><b>${r.nStops}</b><span>Stops</span></div>
        <div class="stat"><b>${r.km ?? "—"}</b><span>Km long</span></div>
        <div class="stat"><b id="route-bus-n">${liveBuses(r.id).length}</b><span>Buses now</span></div>
      </div>
      ${(() => { const st = routeStatus(r.id); return `<div class="notice route-state ${st.running ? "on" : "off"}">${statusPill(st)}<span>${st.running
        ? (st.endingSoon ? `Last trips now · service ends at ${clockFmt(st.until)}` : `In service until ${clockFmt(st.until)}`)
        : esc(nextServiceText(st)) + (today ? "" : " · No trips scheduled today")}</span></div>`; })()}
      ${alertsForRoute(r.id).map(a => alertCard(a, { routes: false })).join("")}
      ${docsList([r.id])}
      ${dirs.length > 1 ? `<div class="seg" role="group" aria-label="Direction">${dirs.map(x =>
        `<button data-dir="${x.d}" aria-pressed="${x.d === state.dir}">To ${esc(x.p.h)}</button>`).join("")}</div>` : ""}
      <ul class="line-list" style="--c:${r.color}">${stopsHtml}</ul>`;
  }

  function hourly(stopIdx) {
    // departures per hour today at this stop (deduped), as a single-series bar strip
    const n = nowLocal(), svcs = activeServices(ymd(n, 0)), idx = stopIndex[stopIdx];
    const counts = new Array(24).fill(0), seen = new Set();
    for (let i = 0; i < idx.length; i += 2) {
      const tr = trips[idx[i]], pos = idx[i + 1], p = patterns[tr.p];
      if (!svcs.has(tr.svc) || pos === p.s.length - 1) continue;
      const t = tr.t[pos], key = p.r + p.h + t;
      if (seen.has(key) || t >= 1440) continue;
      seen.add(key);
      counts[Math.floor(t / 60)]++;
    }
    const max = Math.max(1, ...counts), W = 336, H = 46, bw = W / 24, curH = Math.floor(n.min / 60);
    const bars = counts.map((c, h) => {
      const bh = c ? Math.max(3, (c / max) * H) : 0, x = h * bw + 1, w = bw - 2;
      const cls = h === curH ? "cur" : h < curH ? "past" : "";
      const label = `${clockFmt(h * 60).replace(":00", "")}: ${c} departure${c === 1 ? "" : "s"}`;
      return (c ? `<path class="bar ${cls}" d="M${x},${H} v${-(bh - 2)} q0,-2 2,-2 h${w - 4} q2,0 2,2 v${bh - 2} z"/>` : "") +
        `<rect class="hit" x="${h * bw}" y="0" width="${bw}" height="${H + 14}" data-tip="${label}"/>`;
    }).join("");
    const ticks = [6, 12, 18].map(h => `<text class="axis" x="${h * bw + bw / 2}" y="${H + 12}" text-anchor="middle">${clockFmt(h * 60).replace(":00", "")}</text>`).join("");
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) return "";
    return `<div class="hours"><div class="section-label" style="margin:0 0 6px">Departures by hour today · ${total} total</div>
      <svg viewBox="0 0 ${W} ${H + 14}" preserveAspectRatio="none" role="img" aria-label="Departures per hour today">
      <line x1="0" x2="${W}" y1="${H}" y2="${H}" stroke="#222b38"/>${bars}${ticks}</svg>
      <div class="hours-tip" id="hours-tip">Peak: ${counts.indexOf(max) >= 0 ? clockFmt(counts.indexOf(max) * 60) : ""} hour, ${max} departure${max === 1 ? "" : "s"}</div></div>`;
  }

  // A transit center can have bays from several agencies (Bustang stops at its
  // own DTC bay): the hub's board merges every stop inside the hub.
  function hubMembers(i) {
    const h = HUBS.find(h => h.i === i);
    if (!h) return [i];
    return stops.map((s, k) => k).filter(k => k === i || map.distance([stops[k].lat, stops[k].lon], [h.lat, h.lon]) < h.r);
  }
  function departuresMulti(idxs, opts) {
    if (idxs.length === 1) return departures(idxs[0], opts);
    const seen = new Set();
    return idxs.flatMap(k => departures(k, opts)).sort((a, b) => a.t - b.t)
      .filter(d => { const key = d.route + d.head + d.t; return seen.has(key) ? false : seen.add(key); }).slice(0, opts.limit);
  }
  // km of each bike facility type within half a mile of a stop (segments whose
  // midpoint falls inside the circle), computed on demand and cached
  const bikeNearCache = new Map();
  function bikeNearby(s) {
    if (!BIKE) return null;
    if (bikeNearCache.has(s.id)) return bikeNearCache.get(s.id);
    const kx = 111320 * Math.cos(s.lat * Math.PI / 180), ky = 110540, R2 = FOCUS_M * FOCUS_M, km = {};
    for (const f of BIKE.network.features) {
      const g = f.geometry, lines = g.type === "LineString" ? [g.coordinates] : g.coordinates;
      for (const ln of lines) for (let j = 1; j < ln.length; j++) {
        const ax = (ln[j - 1][0] - s.lon) * kx, ay = (ln[j - 1][1] - s.lat) * ky, bx = (ln[j][0] - s.lon) * kx, by = (ln[j][1] - s.lat) * ky;
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        if (mx * mx + my * my <= R2) km[f.properties.c] = (km[f.properties.c] || 0) + Math.hypot(bx - ax, by - ay) / 1000;
      }
    }
    const parks = (BIKE.parking || []).filter(p => {
      const dx = (p.lon - s.lon) * kx, dy = (p.lat - s.lat) * ky; return dx * dx + dy * dy <= R2;
    });
    const res = { km, parks: parks.length, spaces: parks.reduce((t, p) => t + (p.cap || 0), 0) };
    bikeNearCache.set(s.id, res);
    return res;
  }
  function bikeNearbyHtml(s) {
    const b = bikeNearby(s);
    if (!b) return "";
    const order = ["trail", "protected", "lane", "bikeway", "shared", "trail_soft"];
    const rows = order.filter(c => b.km[c] >= 0.05).map(c => {
      const st = BIKE_STYLE[c];
      return `<div class="bn-row"><svg width="22" height="8" aria-hidden="true"><line x1="2" y1="4" x2="20" y2="4" stroke="${st.color}" stroke-opacity="${st.o}" stroke-width="${(st.w * 1.1).toFixed(1)}" stroke-linecap="round"${st.dash ? ` stroke-dasharray="${st.dash}"` : ""}/></svg>${esc(BIKE.classes[c])}<span>${(b.km[c] * 0.621371).toFixed(1)} mi</span></div>`;
    }).join("");
    return `<div class="section-label">Biking within ½ mile</div>
      <div class="bike-near">${rows || '<div class="bn-row">No mapped bike facilities nearby.</div>'}
      ${b.parks ? `<div class="bn-row"><span class="park-p mini" aria-hidden="true">P</span>Bike parking<span>${b.parks} site${b.parks === 1 ? "" : "s"}${b.spaces ? ` · ${b.spaces}+ spaces` : ""}</span></div>` : ""}</div>`;
  }
  function stopAmenities(s) {
    const a = BIKE && BIKE.stops ? BIKE.stops[s.id] : null;
    const item = (key, label, icon) => {
      const v = a ? a[key] : undefined;
      const cls = v === true ? "yes" : v === false ? "no" : "unk";
      const state = v === true ? "" : v === false ? "No " : "";
      return `<span class="amen ${cls}" title="${v === undefined ? label + ": not recorded" : (v ? label : "No " + label.toLowerCase())}">${icon}${state}${label}${v === undefined ? '<em>?</em>' : ""}</span>`;
    };
    const I = {
      shelter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9l9-5 9 5M5 9v11M19 9v11M3 9h18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      bench: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11h16M4 15h16M6 15v4M18 15v4M6 7h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
      lit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
      bin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
      bike: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="16" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="16" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 16l4-8h5l3 8M10 8l2.5 8H6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    };
    if (!BIKE || !BIKE.stops) return "";
    const near = a && a.nearby;
    return `<div class="section-label">At this stop</div>
      <div class="amenities">${item("shelter", "Shelter", I.shelter)}${item("bench", "Bench", I.bench)}${item("lit", "Lighting", I.lit)}${item("bin", "Trash can", I.bin)}${item("bike", "Bike rack", I.bike)}</div>
      <p class="amen-note">${near ? `${near.sites} bike parking site${near.sites === 1 ? "" : "s"} within 100 m${near.spaces ? ` · ${near.spaces}+ spaces` : ""}. ` : ""}${a && a.osm
        ? `From <a href="https://www.openstreetmap.org/${esc(a.osm)}" target="_blank" rel="noopener">OpenStreetMap</a>; “?” means not recorded yet.`
        : "This stop has no details on OpenStreetMap yet."}</p>`;
  }
  function viewStop() {
    const i = state.stop, s0 = stops[i];
    if (!s0) return viewHome();
    const members = hubMembers(i);
    const s = members.length > 1 ? { ...s0, routes: [...new Set(members.flatMap(k => stops[k].routes))] } : s0;
    const filter = state.stopFilter && s.routes.includes(state.stopFilter) ? state.stopFilter : null;
    let deps = departuresMulti(members, { limit: 14, horizon: 180, route: filter });
    let later = "";
    if (!deps.length) {
      const nx = departuresMulti(members, { limit: 3, horizon: 36 * 60, route: filter });
      later = nx.length ? `No departures in the next 3 hours. Next: ${routeById[nx[0].route].short} to ${esc(nx[0].head)} at ${clockFmt(nx[0].t)}${nx[0].delta > 1440 - nowLocal().min ? " tomorrow" : ""}.` :
        "No scheduled departures in the next day and a half.";
    }
    const back = state.route ? `<button class="back" data-go="route-${state.route}">${BACK} Route ${routeById[state.route].short}</button>`
      : `<button class="back" data-go="">${BACK} All routes</button>`;
    return `${back}
      <div class="detail-head"><div class="main"><h2>${esc(s.name)}</h2><p>Stop #${esc(s.code || s.id)} · ${s.routes.length} route${s.routes.length === 1 ? "" : "s"}</p></div>
        <button class="star" data-fav="stops:${s.id}" aria-pressed="${isFav("stops", s.id)}" aria-label="Favorite stop ${esc(s.name)}">${isFav("stops", s.id) ? STAR : STAR_O}</button></div>
      ${s.routes.length > 1 ? `<div class="filter-chips" role="group" aria-label="Filter by route">
        <button class="chip all" data-sf="" aria-pressed="${!filter}">All</button>
        ${s.routes.map(r => `<button class="chip" data-sf="${r}" aria-pressed="${filter === r}">${badge("sm", r)}${esc(routeById[r].short)}</button>`).join("")}</div>` : ""}
      ${(() => {
        const own = alertsForStop(s.id), ownIds = new Set(own.map(a => a.id));
        const closed = own.some(a => a.stops.some(x => x.id === s.id && x.role === "closed"));
        const onRoutes = currentAlerts().filter(a => !ownIds.has(a.id) && serious(a) && a.routes.some(r => s.routes.includes(r)));
        return (closed ? `<div class="notice closed">${ICON.closure}<span>Transfort lists this stop as closed. Times below are the published schedule.</span></div>` : "") +
          own.map(a => alertCard(a)).join("") + onRoutes.map(a => alertCard(a)).join("");
      })()}
      ${stopAmenities(s0)}
      ${bikeNearbyHtml(s0)}
      <div class="section-label">Next 3 hours</div>
      <div class="board">${deps.length ? deps.map(d => `<button class="row" data-go="route-${d.route}" data-dirset="${d.dir}">
        ${badge("", d.route)}<div class="main"><div class="title">To ${esc(d.head)}</div><div class="sub">Scheduled</div></div>${etaCell(d)}</button>`).join("")
        : `<div class="board-empty">${later}</div>`}</div>
      ${hourly(i)}`;
  }

  function render(keepScroll) {
    const top = body.scrollTop;
    const html = state.view === "route" ? viewRoute() : state.view === "stop" ? viewStop()
      : state.view === "pin" ? pins.viewPin() : viewHome();
    body.innerHTML = html;
    if (keepScroll) body.scrollTop = top;
    document.querySelector(".tabs").hidden = state.view !== "home";
    document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", t.dataset.tab === state.tab));
  }
  function updateFavCount() {
    const n = favs.routes.length + favs.stops.length;
    $("#fav-count").textContent = n ? n : "";
  }

  // hash routing: #route-MAX, #stop-123
  function go(h) { if (location.hash.slice(1) === h) route(); else location.hash = h; }
  function route() {
    const h = location.hash.slice(1);
    let m;
    const prevRoute = state.route;
    if ((m = h.match(/^route-(.+)$/)) && routeById[m[1]]) {
      state.view = "route"; state.route = m[1]; state.stop = null;
      if (prevRoute !== m[1]) state.dir = state.pendingDir ?? 0;
      state.pendingDir = null;
      const l = routeLayers[m[1]];
      if (l) map.flyToBounds(l.line.getBounds(), { padding: [30, 30], duration: 0.6, maxZoom: 15 });
    } else if ((m = h.match(/^stop-(.+)$/)) && m[1] in stopById) {
      state.view = "stop"; state.stop = stopById[m[1]]; state.stopFilter = null;
      // keep the route context only if this stop is on it
      if (state.route && !stops[state.stop].routes.includes(state.route)) state.route = null;
      const s = stops[state.stop];
      map.flyTo([s.lat, s.lon], Math.max(map.getZoom(), 15), { duration: 0.6 });
    } else if ((m = h.match(/^pin-(.+)$/)) && pins.has(m[1])) {
      state.view = "pin"; state.route = null; state.stop = null;
      pins.open(m[1]);
    } else {
      state.view = "home"; state.route = null; state.stop = null;
    }
    if (state.view !== "pin") pins.leave();
    markStop(state.view === "stop" ? state.stop : null);
    styleRoutes(); updateStops(); updateHubs(); updateBuses();
    render(false);
    body.scrollTop = 0;
  }

  // custom pins (web/pins.js): its panel listeners go first, so a pin's
  // "back" can pick the Pins tab before the shared [data-go] handler routes
  const pins = window.TransitPins.create({ map, L, stops, esc, go, state, BACK, stopRow, render: k => render(k) });

  // events
  body.addEventListener("click", e => {
    if (e.target.closest("#alerts-refresh")) { refreshAlerts(); return; }
    const sc = e.target.closest("[data-scope]");
    if (sc) {
      if (scope !== sc.dataset.scope) {
        scope = sc.dataset.scope; saveFilters();
        map.flyToBounds(scope === "regional" ? scopeBounds("regional") : coreBounds, { padding: [24, 24], duration: 0.8 });
      }
      styleRoutes(); updateStops(); updateBuses(); render(true);
      return;
    }
    if (e.target.closest("[data-running]")) {
      runningOnly = !runningOnly; saveFilters();
      styleRoutes(); updateStops(); updateBuses(); render(true);
      return;
    }
    const fav = e.target.closest("[data-fav]");
    if (fav) { const [k, id] = fav.dataset.fav.split(":"); toggleFav(k, id); render(true); return; }
    const dir = e.target.closest("[data-dir]");
    if (dir) { state.dir = +dir.dataset.dir; render(true); updateBuses(); return; }
    const sf = e.target.closest("[data-sf]");
    if (sf) { state.stopFilter = sf.dataset.sf || null; render(true); return; }
    const g = e.target.closest("[data-go]");
    if (g) {
      if (g.dataset.dirset != null) state.pendingDir = +g.dataset.dirset;
      if (g.closest(".back") && g.dataset.go === "") state.route = null;
      go(g.dataset.go);
    }
  });
  body.addEventListener("mouseover", e => {
    const r = e.target.closest("[data-hover]");
    if (r && !state.route) hoverRoute(r.dataset.hover, true);
    const tip = e.target.closest("[data-tip]");
    if (tip) $("#hours-tip").textContent = tip.dataset.tip;
  });
  body.addEventListener("mouseout", e => {
    const r = e.target.closest("[data-hover]");
    if (r && !state.route) hoverRoute(r.dataset.hover, false);
  });
  $("#q").addEventListener("input", e => { state.q = e.target.value; if (state.view !== "home") go(""); else render(false); });
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => { state.tab = t.dataset.tab; state.q = ""; $("#q").value = ""; render(false); }));
  const bikeBtn = $("#toggle-bike");
  if (!BIKE) bikeBtn.hidden = true;
  bikeBtn.setAttribute("aria-pressed", bikeOn);
  bikeBtn.addEventListener("click", () => {
    bikeOn = !bikeOn;
    try { localStorage.setItem("transfort-bike-v1", bikeOn ? "on" : "off"); } catch (e) { /* in-memory only */ }
    bikeBtn.setAttribute("aria-pressed", bikeOn);
    updateBike(); styleRoutes();
  });
  $("#toggle-buses").addEventListener("click", e => {
    showBuses = !showBuses; e.currentTarget.setAttribute("aria-pressed", showBuses); updateBuses();
  });
  window.addEventListener("hashchange", route);

  // clock + refresh loops
  function tick() {
    const n = nowLocal();
    $("#clock").textContent = clockFmt(n.min);
  }
  setInterval(tick, 1000); tick();
  setInterval(updateBuses, 4000);
  setInterval(() => { if (state.view !== "pin") render(true); if (!state.route) { styleRoutes(); updateStops(); } }, 20000);

  updateFavCount();
  HUBS_READY = true;
  updateAlertStops();
  route();

  // Live alerts: in claude.ai a shared store holds the latest check, and the
  // owner (in the Claude desktop app) can re-read ridetransfort.com through
  // Claude's built-in browser. Without either, the built snapshot stands.
  (async () => {
    const use = window.claude && window.claude.use;
    if (!use) return;
    const [db, mcp, user] = await Promise.all(["db", "mcp", "user"].map(n => use(n).catch(() => null)));
    live.db = db; live.mcp = mcp;
    if (db) {
      db.doc("alerts/current").onSnapshot(snap => {
        const d = snap.exists ? snap.data() : null;
        if (d && Array.isArray(d.alerts) && (d.fetched_at || "") > (ALERTS.fetched_at || "")) applyAlerts(d);
      }, () => { /* keep the snapshot */ });
    }
    const owner = user ? await user.isOwner().catch(() => false) : false;
    if (mcp && owner) { live.can = true; if (state.view === "home") render(true); }
  })();
})();
