# Point Mapper — Trimble Connect Extension

Upload a CSV of points and see them plotted on a live street/satellite map.

## What it does

1. **Import** — drop in a CSV. Any header names work; the app auto-detects
   likely ID / X / Y / description columns, and you can override the mapping.
2. **Georeference** — your CSV holds local X/Y (survey grid) coordinates,
   which have no inherent position on a real-world map. Tie **2 or more**
   points to known lat/long (type them in, or click the target on the map)
   and the app solves a similarity transform (rotation + scale +
   translation) to place every other point automatically. It reports the
   fit quality (RMS residual in meters).
3. **View** — all points render on an OpenStreetMap / Esri satellite base
   map, with popups showing each point's ID, description, local
   coordinates, and computed lat/long. Click any row in the point list to
   jump the map to it.

This is a plain static web app (`index.html`), so it works two ways:

- **Standalone**: open `index.html` in any browser, or host it anywhere
  (GitHub Pages, S3, Netlify, etc.) and use it on its own.
- **As a Trimble Connect extension**: embedded inside Trimble Connect for
  Browser via an iframe, using Trimble's Workspace API.

## Hosting it

The file needs to be served over **HTTPS** (Trimble Connect requires this
for extensions, and browsers require it for the `trimble-connect-workspace-api`
script to run without mixed-content issues). Any static host works, e.g.:

```bash
# Quick option: GitHub Pages
git init && git add . && git commit -m "point mapper"
git remote add origin <your-repo-url>
git push -u origin main
# then enable Pages on the repo, serving from the root
```

Netlify/Vercel drag-and-drop deploys also work with zero config since this
is a single static file with no build step.

## Installing into Trimble Connect

1. Host `index.html` at a public HTTPS URL.
2. Open `manifest.json` and replace `YOUR-HOSTED-URL` with that URL
   (and add a small icon if you'd like one in the extensions list).
3. In Trimble Connect for Browser, go to your **Project Settings →
   Extensions** (or **3D Viewer → Extensions**, if you'd rather it live
   as a viewer side-panel).
4. Choose to add a custom extension and provide the URL to your
   `manifest.json`.
5. Enable it. It will now appear as a panel/tab inside the project.

No Trimble API keys or scopes are required for the core CSV/map workflow —
the extension only calls the Workspace API to announce itself as a good
citizen inside Connect (so it doesn't block Connect's own UI). If you later
want it to read files directly from the Connect project (e.g. pull a CSV
that's already stored in the project) rather than requiring a manual
upload, that would use `API.project.getProject()` / the File Explorer
APIs — ask and I can wire that in.

## Try it now

`sample-points.csv` is included — open `index.html`, drop that file in, then
tie **P1** and **P3** (opposite corners) to any two lat/long points a
reasonable distance apart on your map (e.g. near your own site), hit
**Compute georeference**, and the other five points will snap into place
relative to them.

## Notes & limitations

- The georeferencing transform assumes a **flat, locally-consistent grid**
  (fine for site/plan-scale survey data). It is not a substitute for a
  proper projected coordinate system (e.g. State Plane, UTM) if you need
  survey-grade accuracy — for that, control points should come from known
  monuments, and more of them (3+) improves the least-squares fit.
- Data stays in the browser tab; nothing is uploaded to a server. Refreshing
  the page clears the loaded CSV and control points.
- Satellite tiles are from Esri's public World Imagery service; street tiles
  from OpenStreetMap. Both are free, no API key needed, but are subject to
  their respective usage policies for heavy/production use.
