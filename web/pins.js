/* Custom pins: places a rider drops on the map (home, work, a favourite café…),
   each with a category and free-form notes, plus the nearest stops to it.

   Storage: pins live in this browser (localStorage) by default. Published in
   claude.ai, the page also gets a private per-person store (the `db`
   capability, under data/users/<id>/), so pins follow the viewer's Claude
   account across devices; pins made in this browser before that are moved
   into it once. Nobody else, the page's owner included, can read them. */
(function (root) {
  "use strict";

  const CATS = [
    { id: "home",     label: "Home",          color: "#7cc4ff", path: "M4 11.5 12 4.5l8 7V20h-5.5v-5.5h-5V20H4z" },
    { id: "work",     label: "Work",          color: "#b39bff", path: "M4 8.5h16V19H4zM9 8.5V5.5h6v3M4 13h16" },
    { id: "school",   label: "School",        color: "#ffd166", path: "M2.5 9.5 12 5l9.5 4.5L12 14zM6.5 11.5V16c3 2.2 8 2.2 11 0v-4.5" },
    { id: "food",     label: "Food & drink",  color: "#ff8a5b", path: "M7 3.5v17M4.5 3.5V8a2.5 2.5 0 0 0 5 0V3.5M17 20.5V3.5c-2.2 1.6-3 4.5-3 8h3" },
    { id: "shop",     label: "Shopping",      color: "#f78fb3", path: "M5.5 8.5h13l-1 11.5h-11zM9 8.5V7a3 3 0 0 1 6 0v1.5" },
    { id: "outdoors", label: "Park & trail",  color: "#6fd39b", path: "M12 3.5l5.5 8h-3.5l4.5 6h-13l4.5-6H6.5zM12 17.5v3" },
    { id: "health",   label: "Health",        color: "#ff6b81", path: "M12 5.5v13M5.5 12h13" },
    { id: "other",    label: "Other",         color: "#c5ccd8", path: "M6.5 20.5V4h11l-2.5 4 2.5 4h-11" },
  ];
  const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
  const LS_KEY = "transfort-pins-v1", SHOW_KEY = "transfort-pins-show-v1";
  const NAME_MAX = 80, NOTES_MAX = 2000;
  const WALK_M_PER_MIN = 80;                       // ≈ 3 mph

  const icon = (c, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${c.path}"/></svg>`;
  const catOf = id => CAT[id] || CAT.other;
  const metres = (a, b) => {                       // haversine
    const R = 6371008, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const distText = m => m < 160 ? `${Math.round(m * 3.28084 / 10) * 10} ft` : `${(m / 1609.344).toFixed(m < 1609 ? 2 : 1)} mi`;
  const walkText = m => `${Math.max(1, Math.round(m / WALK_M_PER_MIN))} min walk`;
  const newId = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clean = p => ({                            // the stored shape, nothing else
    name: String(p.name || "").slice(0, NAME_MAX), cat: CAT[p.cat] ? p.cat : "other",
    lat: +(+p.lat).toFixed(6), lon: +(+p.lon).toFixed(6), notes: String(p.notes || "").slice(0, NOTES_MAX),
    created: p.created || new Date().toISOString(), updated: new Date().toISOString(),
  });
  const valid = p => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon);

  function create(ctx) {
    const { map, L, stops, esc, go, state, BACK } = ctx;
    const $ = s => document.querySelector(s);

    // ------------------------------------------------------------ store
    let pins = [];
    const readLocal = () => {
      try { const v = JSON.parse(localStorage.getItem(LS_KEY) || "[]"); return Array.isArray(v) ? v.filter(valid) : []; }
      catch (e) { return []; }
    };
    const writeLocal = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(pins)); } catch (e) { /* in-memory only */ } };
    pins = readLocal();
    let showPins = true;
    try { showPins = localStorage.getItem(SHOW_KEY) !== "off"; } catch (e) { /* default on */ }

    // cloud: null until the viewer's private collection answers
    const cloud = { col: null, status: "local", note: "" };   // status: local | connecting | cloud | error
    async function connectCloud() {
      const use = root.claude && root.claude.use;
      if (!use) return;
      const [db, user] = await Promise.all([use("db"), use("user")].map(p => p.catch(() => null)));
      if (!db || !user) return;
      const uid = await user.id().catch(() => null);
      if (!uid) return;                             // signed out: stay in this browser
      let col;
      try { col = db.doc(`data/users/${uid}/transit`).collection("pins"); } catch (e) { return; }
      cloud.status = "connecting"; changed(false);
      let first = true;
      const timer = setTimeout(() => { if (cloud.status === "connecting") { cloud.note = "Your saved pins can't be reached yet — showing the ones in this browser."; changed(false); } }, 10000);
      col.onSnapshot(async snap => {
        if (first && !snap.metadata.fromCache) {
          first = false; clearTimeout(timer);
          cloud.col = col; cloud.status = "cloud"; cloud.note = "";
          const local = readLocal();
          if (snap.empty && local.length) {         // move this browser's pins into the account once
            for (const p of local) { try { await col.doc(p.id).set(clean(p)); } catch (e) { cloud.note = "Some pins from this browser couldn't be moved to your account."; } }
            if (!cloud.note) { try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ } }
            return;                                  // the writes come back as the next snapshot
          }
        }
        if (cloud.status !== "cloud" && snap.metadata.fromCache && snap.empty) return;  // don't blank local pins on an empty cache
        pins = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(valid);
        changed(false);
      }, err => {
        clearTimeout(timer);
        cloud.col = null; cloud.status = "error";
        cloud.note = "Couldn't reach your saved pins" + (err && err.code ? ` (${err.code})` : "") + ". Pins are kept in this browser for now.";
        pins = readLocal(); changed(false);
      });
    }

    async function persist(p) {
      const body = clean(p);
      if (cloud.col) { await cloud.col.doc(p.id).set(body); }
      const i = pins.findIndex(x => x.id === p.id);
      const rec = { id: p.id, ...body };
      if (i >= 0) pins[i] = rec; else pins.push(rec);
      if (!cloud.col) writeLocal();
      return rec;
    }
    async function remove(id) {
      if (cloud.col) await cloud.col.doc(id).delete();
      pins = pins.filter(p => p.id !== id);
      if (!cloud.col) writeLocal();
    }

    // ------------------------------------------------------------ map layer
    map.createPane("pins").style.zIndex = 470;    // above stops + hubs, below labels and buses
    const layer = L.layerGroup().addTo(map);
    let openId = null, draft = null, confirmDelete = false, saving = false, error = "";
    let placing = false;

    function markerHtml(p, cls) {
      const c = catOf(p.cat);
      return `<div class="upin${cls}" style="--c:${c.color}"><span>${icon(c, 15)}</span></div>`;
    }
    function drawPins() {
      layer.clearLayers();
      const list = pins.filter(p => p.id !== openId);
      if (draft) list.push(draft);
      for (const p of list) {
        const isOpen = draft && p === draft;
        if (!showPins && !isOpen) continue;
        const m = L.marker([p.lat, p.lon], {
          pane: "pins", draggable: !!isOpen, keyboard: !isOpen, autoPan: true,
          icon: L.divIcon({ className: "upin-wrap", iconSize: [30, 30], iconAnchor: [15, 37],
            html: markerHtml(p, isOpen ? " open" + (draft.isNew ? " new" : "") : "") }),
          title: p.name || catOf(p.cat).label, riseOnHover: true, zIndexOffset: isOpen ? 1000 : 0,
        });
        if (isOpen) {
          m.on("drag", e => { const ll = e.target.getLatLng(); draft.lat = ll.lat; draft.lon = ll.lng; });
          m.on("dragend", () => { draft.moved = true; ctx.render(true); });
        } else {
          m.bindTooltip(`<b>${esc(p.name || catOf(p.cat).label)}</b><br><span class="muted">${esc(catOf(p.cat).label)}${p.notes ? " · " + esc(p.notes.slice(0, 60)) + (p.notes.length > 60 ? "…" : "") : ""}</span>`,
            { className: "tt", direction: "top", offset: [0, -34] });
          m.on("click", e => { L.DomEvent.stopPropagation(e); go(`pin-${p.id}`); });
        }
        layer.addLayer(m);
      }
    }

    function changed(rerenderPanel = true) {
      drawPins();
      const n = pins.length;
      const el = $("#pin-count");
      if (el) el.textContent = n ? n : "";
      if (state.view === "pin") {
        // a pin that vanished elsewhere (deleted on another device) closes its editor
        if (openId && !draft.isNew && !pins.some(p => p.id === openId)) { go(""); return; }
        if (rerenderPanel) ctx.render(true);
      } else if (state.view === "home" && (state.tab === "pins" || state.q)) ctx.render(true);
    }

    // ------------------------------------------------------------ placing
    const hint = $("#pin-hint"), addBtn = $("#add-pin");
    function setPlacing(on) {
      placing = on;
      map.getContainer().classList.toggle("placing", on);
      if (addBtn) addBtn.setAttribute("aria-pressed", on);
      if (hint) hint.hidden = !on;
      if (state.view === "home" && state.tab === "pins") ctx.render(true);   // keep the panel's button in step
    }
    function dropAt(latlng) {
      setPlacing(false);
      draft = { id: newId(), name: "", cat: "other", notes: "", lat: latlng.lat, lon: latlng.lng, isNew: true };
      openId = draft.id;
      go("pin-new");
    }
    map.on("click", e => { if (placing) dropAt(e.latlng); });
    map.on("contextmenu", e => dropAt(e.latlng));  // right-click, or long-press on touch
    if (addBtn) addBtn.addEventListener("click", () => setPlacing(!placing));
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && placing) { setPlacing(false); e.preventDefault(); }
    });

    // ------------------------------------------------------------ router hooks
    function has(id) { return id === "new" ? !!(draft && draft.isNew) : pins.some(p => p.id === id); }
    function open(id) {
      setPlacing(false);
      confirmDelete = false; error = "";
      if (id === "new") { if (!draft) return false; }
      else {
        const p = pins.find(x => x.id === id);
        if (!p) return false;
        if (!(draft && draft.id === id)) draft = { ...p, isNew: false };
        openId = id;
        const z = Math.max(map.getZoom(), 16);
        map.flyTo([p.lat, p.lon], z, { duration: 0.6 });
      }
      drawPins();
      return true;
    }
    function leave() {                              // navigating away: unsaved changes are dropped
      if (!draft) return;
      draft = null; openId = null; confirmDelete = false; error = "";
      drawPins();
    }

    // ------------------------------------------------------------ panel views
    function nearestStops(p, n = 3, within = 1200) {
      return stops.map((s, i) => ({ i, m: metres(p, s) })).filter(x => x.m <= within)
        .sort((a, b) => a.m - b.m).slice(0, n);
    }
    function nearestLine(p) {
      const [s] = nearestStops(p, 1, 1600);
      return s ? `${walkText(s.m)} to ${stops[s.i].name}` : "No stop within a mile";
    }
    function pinRow(p) {
      const c = catOf(p.cat);
      return `<button class="row pin-row" data-go="pin-${esc(p.id)}">
        <span class="pin-dot" style="--c:${c.color}">${icon(c, 15)}</span>
        <div class="main"><div class="title">${esc(p.name || c.label)}</div>
        <div class="sub">${esc(c.label)} · ${esc(nearestLine(p))}</div>
        ${p.notes ? `<div class="sub pin-note">${esc(p.notes.split("\n")[0])}</div>` : ""}</div></button>`;
    }
    function storageNote() {
      const where = cloud.status === "cloud" ? "Saved to your Claude account · private to you"
        : cloud.status === "connecting" ? "Loading your saved pins…"
        : "Saved in this browser";
      return `<div class="pin-store">${esc(where)}</div>${cloud.note ? `<div class="notice">${esc(cloud.note)}</div>` : ""}`;
    }

    let filterCat = "all";
    function viewList() {
      const addBar = `<div class="pin-toolbar">
        <button class="pin-add" data-pin-add aria-pressed="${placing}">${PIN_PLUS} ${placing ? "Click the map…" : "Add a pin"}</button>
        <button class="toggle pin-show" data-pin-show role="switch" aria-checked="${showPins}"><span class="switch" aria-hidden="true"></span>On map</button></div>`;
      if (!pins.length) {
        return addBar + `<div class="empty">${PIN_PLUS.replace('width="16" height="16"', 'width="28" height="28"')}
          <p>No pins yet.</p><p style="font-size:13px">Tap <b>Add a pin</b>, then click the map — or right-click (long-press on a phone) anywhere.
          Give it a category and notes, and see the closest stops.</p></div>` + storageNote();
      }
      const counts = {};
      for (const p of pins) counts[p.cat] = (counts[p.cat] || 0) + 1;
      if (filterCat !== "all" && !counts[filterCat]) filterCat = "all";
      const chips = `<div class="pin-chips" role="group" aria-label="Filter pins by category">
        <button data-pin-filter="all" aria-pressed="${filterCat === "all"}">All <i>${pins.length}</i></button>
        ${CATS.filter(c => counts[c.id]).map(c => `<button data-pin-filter="${c.id}" aria-pressed="${filterCat === c.id}" style="--c:${c.color}">${icon(c, 13)}${esc(c.label)} <i>${counts[c.id]}</i></button>`).join("")}</div>`;
      const shown = pins.filter(p => filterCat === "all" || p.cat === filterCat)
        .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
      return addBar + chips + `<div class="section-label">${filterCat === "all" ? "Your pins" : esc(CAT[filterCat].label)} · recently edited first</div>`
        + shown.map(pinRow).join("") + storageNote();
    }

    function viewPin() {
      const p = draft;
      if (!p) return "";
      const c = catOf(p.cat);
      const near = nearestStops(p);
      const title = p.isNew ? "New pin" : (p.name || c.label);
      return `<button class="back" data-go="" data-pin-back>${BACK} ${p.isNew ? "Cancel" : "All pins"}</button>
        <div class="detail-head"><span class="pin-dot lg" style="--c:${c.color}">${icon(c, 22)}</span>
          <div class="main"><h2>${esc(title)}</h2>
          <p>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} · drag the pin on the map to move it${p.moved && !p.isNew ? " (moved — save to keep)" : ""}</p></div></div>
        <form class="pin-form" data-pin-form novalidate>
          <label class="fld"><span>Name</span>
            <input name="name" maxlength="${NAME_MAX}" autocomplete="off" placeholder="e.g. Mom's place, Old Town office" value="${esc(p.name)}"></label>
          <div class="fld"><span id="cat-lbl">Category</span>
            <div class="cat-grid" role="radiogroup" aria-labelledby="cat-lbl">
            ${CATS.map(k => `<button type="button" role="radio" data-pin-cat="${k.id}" aria-checked="${k.id === p.cat}" style="--c:${k.color}">${icon(k, 15)}<span>${esc(k.label)}</span></button>`).join("")}
            </div></div>
          <label class="fld"><span>Notes <em data-pin-left>${NOTES_MAX - p.notes.length} left</em></span>
            <textarea name="notes" maxlength="${NOTES_MAX}" rows="4" placeholder="Gate code, which stop to use, hours, anything you want to remember">${esc(p.notes)}</textarea></label>
          ${error ? `<div class="notice pin-err" role="alert">${esc(error)}</div>` : ""}
          <div class="pin-actions">
            <button type="submit" class="btn primary" ${saving ? "disabled" : ""}>${saving ? "Saving…" : p.isNew ? "Save pin" : "Save changes"}</button>
            ${p.isNew ? "" : confirmDelete
              ? `<span class="pin-confirm">Delete this pin? <button type="button" class="btn danger" data-pin-delete="yes">Delete</button><button type="button" class="btn" data-pin-delete="no">Keep</button></span>`
              : `<button type="button" class="btn ghost" data-pin-delete>Delete</button>`}
          </div>
        </form>
        <div class="section-label">Nearest stops</div>
        ${near.length ? near.map(x => `<div class="pin-walk">${distText(x.m)} · ${walkText(x.m)}</div>${ctx.stopRow(x.i)}`).join("")
          : `<div class="empty" style="padding:14px">No Transfort stop within ¾ mile of this pin.</div>`}`;
    }

    function searchHtml(q) {
      const hits = pins.filter(p => (p.name + " " + p.notes + " " + catOf(p.cat).label).toLowerCase().includes(q));
      return hits.length ? `<div class="section-label">Your pins</div>${hits.slice(0, 20).map(pinRow).join("")}` : "";
    }

    // ------------------------------------------------------------ panel events
    const body = $("#panel-body");
    body.addEventListener("input", e => {
      const f = e.target.closest("[data-pin-form]");
      if (!f || !draft) return;
      if (e.target.name === "name") draft.name = e.target.value.slice(0, NAME_MAX);
      if (e.target.name === "notes") {
        draft.notes = e.target.value.slice(0, NOTES_MAX);
        const left = f.querySelector("[data-pin-left]");
        if (left) left.textContent = `${NOTES_MAX - draft.notes.length} left`;
      }
    });
    body.addEventListener("submit", async e => {
      const f = e.target.closest("[data-pin-form]");
      if (!f || !draft) return;
      e.preventDefault();
      if (saving) return;
      saving = true; error = ""; ctx.render(true);
      const wasNew = draft.isNew;
      try {
        const rec = await persist({ ...draft, name: draft.name.trim() });
        saving = false; draft = null; openId = null;
        changed(false);
        // a new pin stays open (now saved) so its stops are right there; an edit goes back to the list
        if (wasNew) { location.hash = `pin-${rec.id}`; } else { state.tab = "pins"; go(""); }
      } catch (err) {
        saving = false;
        error = "Couldn't save this pin" + (err && err.code ? ` (${err.code})` : "") + ". Your changes are still here — try again.";
        ctx.render(true);
      }
    });
    body.addEventListener("click", async e => {
      const cat = e.target.closest("[data-pin-cat]");
      if (cat && draft) { draft.cat = cat.dataset.pinCat; drawPins(); ctx.render(true); return; }
      const del = e.target.closest("[data-pin-delete]");
      if (del && draft) {
        const v = del.dataset.pinDelete;
        if (!v) { confirmDelete = true; ctx.render(true); return; }
        if (v === "no") { confirmDelete = false; ctx.render(true); return; }
        try { const id = draft.id; await remove(id); draft = null; openId = null; state.tab = "pins"; changed(false); go(""); }
        catch (err) { confirmDelete = false; error = "Couldn't delete this pin" + (err && err.code ? ` (${err.code})` : "") + "."; ctx.render(true); }
        return;
      }
      if (e.target.closest("[data-pin-back]")) state.tab = "pins";
      if (e.target.closest("[data-pin-add]")) { setPlacing(!placing); return; }
      if (e.target.closest("[data-pin-show]")) {
        showPins = !showPins;
        try { localStorage.setItem(SHOW_KEY, showPins ? "on" : "off"); } catch (err) { /* in-memory only */ }
        drawPins(); ctx.render(true); return;
      }
      const fc = e.target.closest("[data-pin-filter]");
      if (fc) { filterCat = fc.dataset.pinFilter; ctx.render(true); }
    });

    drawPins();
    setTimeout(() => changed(false), 0);
    connectCloud();
    return {
      has, open, leave, viewList, viewPin, searchHtml,
      get editing() { return !!draft; },
      get count() { return pins.length; },
      refreshCount: () => changed(false),
    };
  }

  const PIN_PLUS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><path d="M12 7v6M9 10h6"/></svg>';
  root.TransitPins = { create, CATS, PIN_PLUS };
})(typeof window !== "undefined" ? window : globalThis);
