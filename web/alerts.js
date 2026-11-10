/* Transfort rider alerts — shared logic for the web app.
   The build ships a snapshot made by pipeline/alerts.py. In the Claude desktop
   app the page can also check ridetransfort.com live, by reading the alerts
   page through Claude's built-in browser (the `host:claude_browser` MCP server)
   and parsing its accessibility tree here. Same output shape as the Python. */
(function (root) {
  "use strict";

  const ALERTS_URL = "https://ridetransfort.com/rider-info-rider-alerts/";
  const SLUG_TO_ROUTE = { gold: "GOLD", horn: "HORN", "foothills-shuttle": "FHS", max: "MAX",
    flex: "FLEX", ada: "ADA", "ada-shuttle": "ADA" };
  const KIND_ORDER = { detour: 0, closure: 1, info: 2, vehicle: 3 };

  const iso = mdY => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mdY || "");
    return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
  };
  const kindOf = type => /detour/i.test(type) ? "detour" : /clos/i.test(type) ? "closure"
    : /vehicle/i.test(type) ? "vehicle" : "info";
  function routeId(href, label) {
    const m = /\/routes\/([^/]+)\/?/.exec(href || "");
    const slug = (m ? m[1] : label || "").toLowerCase().trim();
    if (SLUG_TO_ROUTE[slug]) return SLUG_TO_ROUTE[slug];
    const n = /(\d+)$/.exec(slug);
    return n ? n[1] : null;
  }
  const cleanText = t => t.replace(/\s+/g, " ").replace(/\s*Info:\s*ridetransfort\.com\s*$/i, "").trim();

  /** Parse the browser's accessibility tree of the alerts page.
   *  treeText: read_page output. pageText: get_page_text output, used to
   *  recover descriptions the tree truncates at ~100 characters. */
  function parseTree(treeText, pageText) {
    const start = treeText.search(/generic "Alert Type"/);
    if (start < 0) throw Object.assign(new Error("no alerts table on the page"), { code: "layout" });
    const lines = treeText.slice(start).split("\n");
    const pageLines = (pageText || "").split("\n").map(l => l.trim()).filter(Boolean);
    const unq = s => s.replace(/\\"/g, '"');
    const alerts = [], docs = {};
    let route = null, inDocs = false, pendingDoc = null, cur = null;
    for (const line of lines) {
      let m;
      if ((m = /^\s*link \[ref_\d+\] href="([^"]*\/routes\/[^"]*)"/.exec(line))) {
        route = routeId(m[1]); inDocs = false; cur = null; continue;
      }
      if ((m = /^\s*heading "(.*)" \[ref_\d+\]/.exec(line))) {
        const h = unq(m[1]);
        if (/^Rider alert maps/i.test(h)) { inDocs = true; cur = null; continue; }
        inDocs = false;
        const d = /^(.*?)\s*\(Effective:\s*(\d{2}\/\d{2}\/\d{4})\s*[–—-]\s*([^)]+)\)\s*$/.exec(h);
        cur = { type: d ? d[1] : h, routes: route ? [route] : [], start: d ? iso(d[2]) : null,
          end: d ? iso(d[3].trim()) : null, text: "" };
        alerts.push(cur);
        continue;
      }
      if (inDocs) {
        if ((m = /^\s*listitem "\((\S+)\s*[–—-]\s*([^)]+)\)"/.exec(line))) {
          pendingDoc = { start: iso(m[1]), end: iso(m[2].trim()) };
        } else if ((m = /^\s*link "(.*)" \[ref_\d+\] href="([^"]+)"/.exec(line)) && route) {
          (docs[route] = docs[route] || []).push({ title: unq(m[1]), url: m[2], ...(pendingDoc || { start: null, end: null }) });
          pendingDoc = null;
        }
        continue;
      }
      if (cur && !cur.text && (m = /^\s*generic "(.*)" \[ref_\d+\]/.exec(line))) {
        const t = unq(m[1]);
        if (/^\(Effective:/.test(t)) continue;
        const full = pageLines.find(p => p.startsWith(t.slice(0, 60)));
        cur.text = cleanText(full && full.length >= t.length ? full : t);
      }
    }
    return { alerts, docs };
  }

  /** One alert per message, many routes (the site repeats shared alerts). */
  function merge(raw) {
    const out = new Map();
    for (const a of raw) {
      const key = [a.type.toLowerCase(), a.text.toLowerCase(), a.start].join("|");
      if (!out.has(key)) out.set(key, { ...a, routes: [] });
      const m = out.get(key);
      for (const r of a.routes) if (!m.routes.includes(r)) m.routes.push(r);
    }
    return [...out.values()].map(a => ({ ...a, kind: kindOf(a.type), id: hash(`${a.type}|${a.text}|${a.start}`) }));
  }
  function hash(s) {      // small stable id (not cryptographic)
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  const norm = n => n.toLowerCase().replace(/\(.*?\)/g, "").replace(/ and /g, " & ").replace(/\s+/g, " ").trim();
  /** Attach GTFS stops named in each alert, by stop number or intersection. */
  function linkStops(alerts, stops) {
    const byCode = new Map(stops.filter(s => s.code).map(s => [s.code, s]));
    const byName = new Map();
    for (const s of stops) {
      const n = norm(s.name), [a, b] = n.split(" & ");
      for (const k of b ? [n, `${b} & ${a}`] : [n]) (byName.get(k) || byName.set(k, []).get(k)).push(s);
    }
    const ix = /([A-Z][A-Za-z.']*(?: [A-Z][A-Za-z.']*)*)\s+(?:&|and)\s+([A-Z][A-Za-z.']*(?: [A-Z][A-Za-z.']*)*)/g;
    for (const al of alerts) {
      const found = [];
      for (const clause of al.text.split(/(?<=[.;])\s+|\s+(?=Now\b)/)) {
        const low = clause.toLowerCase();
        const role = /closed|closure/.test(low) ? "closed" : /new|servicing/.test(low) ? "new" : "affected";
        const codes = [...clause.matchAll(/#\s?(\d{2,5})/g)].map(m => m[1]);
        for (const code of codes) {
          const s = byCode.get(code);
          found.push({ id: s ? s.id : null, code, name: s ? s.name : null, role });
        }
        if (codes.length) continue;
        for (const m of clause.matchAll(ix))
          for (const s of byName.get(norm(`${m[1]} & ${m[2]}`)) || [])
            if (!al.routes.length || s.routes.some(r => al.routes.includes(r)))
              found.push({ id: s.id, code: s.code, name: s.name, role });
      }
      const seen = new Set();
      al.stops = found.filter(f => { const k = f.id || f.code; return seen.has(k) ? false : seen.add(k); });
    }
  }

  function build(raw, docs, stops, meta) {
    const alerts = merge(raw);
    linkStops(alerts, stops);
    alerts.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (b.start || "").localeCompare(a.start || ""));
    return { source: ALERTS_URL, fetched_at: new Date().toISOString(), ...meta, alerts, docs };
  }

  /** Read ridetransfort.com through Claude's built-in browser. */
  async function fetchLive(mcp, stops) {
    const B = "host:claude_browser";
    const text = r => (r.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    const opened = text(await mcp.callTool(B, "preview_start", { url: ALERTS_URL }, { cache: false }));
    const tabId = (/tabId (\S+?)\)/.exec(opened) || [])[1];
    const args = tabId ? { tabId } : {};
    const tree = text(await mcp.callTool(B, "read_page", { ...args, filter: "all", max_chars: 120000 }, { cache: false }));
    const page = text(await mcp.callTool(B, "get_page_text", { ...args, max_chars: 60000 }, { cache: false }));
    const { alerts, docs } = parseTree(tree, page);
    return build(alerts, docs, stops, { via: "browser" });
  }

  const api = { ALERTS_URL, parseTree, merge, linkStops, build, fetchLive, kindOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TransitAlerts = api;
})(typeof window !== "undefined" ? window : globalThis);
