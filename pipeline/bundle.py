"""Assemble the web app.

  web/index.html          – dev page (fetches data/*.json; serve with `python -m http.server -d web`)
  dist/transfort-map.html – single self-contained page with data inlined (what gets published)
"""
from __future__ import annotations

import argparse
from pathlib import Path

LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"
FONTS = ("https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700"
         "&family=Barlow+Condensed:wght@600;700&family=JetBrains+Mono:wght@500;600&display=swap")
TITLE = "Transfort Live Map"


def head_bits() -> str:
    return (f'<title>{TITLE}</title>\n'
            '<meta name="claude:viewport-fit-sides" content="cover">\n'
            '<meta name="description" content="Fort Collins Transfort routes, stops and scheduled departures.">\n'
            '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
            '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
            f'<link rel="stylesheet" href="{FONTS}">\n')


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--web", default="web")
    ap.add_argument("--out", default="dist/transfort-map.html")
    a = ap.parse_args(argv)
    web = Path(a.web)
    body = (web / "body.html").read_text()

    dev = ("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
           "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
           + head_bits() +
           '<link rel="stylesheet" href="vendor/leaflet.css">\n<link rel="stylesheet" href="styles.css">\n'
           "</head>\n<body>\n" + body +
           '<script src="vendor/leaflet.js"></script>\n<script src="alerts.js"></script>\n'
           '<script src="pins.js"></script>\n<script src="app.js"></script>\n</body>\n</html>\n')
    (web / "index.html").write_text(dev)

    data = ""
    for el_id, fname in [("d-schedule", "schedule.json"), ("d-routes", "routes.geojson"),
                         ("d-basemap", "basemap.json"), ("d-alerts", "alerts.json"),
                         ("d-bike", "bike.json")]:
        txt = (web / "data" / fname).read_text().replace("</", "<\\/")
        data += f'<script type="application/json" id="{el_id}">{txt}</script>\n'
    css = (web / "vendor" / "leaflet.css").read_text() + "\n" + (web / "styles.css").read_text()
    page = (head_bits() + f"<style>\n{css}\n</style>\n" + body + data +
            f'<script src="{LEAFLET_JS}"></script>\n<script>\n{(web / "alerts.js").read_text()}\n</script>\n'
            f'<script>\n{(web / "pins.js").read_text()}\n</script>\n'
            f'<script>\n{(web / "app.js").read_text()}\n</script>\n')
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page)
    print(f"wrote {web/'index.html'} and {out} ({out.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
