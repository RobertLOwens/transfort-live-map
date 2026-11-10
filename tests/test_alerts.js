// node tests/test_alerts.js — the browser parser must agree with the Python one
const fs = require("fs"), assert = require("assert");
const A = require("../web/alerts.js");
const fx = f => fs.readFileSync(__dirname + "/fixtures/" + f, "utf8");
const stops = JSON.parse(fs.readFileSync(__dirname + "/../web/data/schedule.json", "utf8")).stops;
const py = JSON.parse(fs.readFileSync(__dirname + "/../web/data/alerts.json", "utf8"));
const { alerts, docs } = A.parseTree(fx("rideralerts_tree.txt"), fx("rideralerts_text.txt"));
const js = A.build(alerts, docs, stops, {});
const strip = a => ({ id: a.id, type: a.type, kind: a.kind, routes: a.routes, start: a.start, end: a.end, text: a.text, stops: a.stops });
assert.deepStrictEqual(js.alerts.map(strip), py.alerts.map(strip));
assert.deepStrictEqual(js.docs, py.docs);
assert.throws(() => A.parseTree("nothing here", ""), /no alerts table/);
console.log(`ok — ${js.alerts.length} alerts, ${Object.keys(js.docs).length} routes with maps; browser and Python parsers agree`);
