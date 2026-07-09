# Point Mapper — Trimble Connect Extension

Upload a CSV of points (with optional elevation) and see them plotted on a
live street/satellite map, placed either by the project's own coordinate
system or by manual control points.

## What it does

1. **Import** — drop in a CSV, or pull one straight from the project via
   **Browse from Trimble Connect** (see below). Any header names work; the
   app auto-detects likely ID / X / Y / Z (elevation) / description columns,
   and you can override the mapping. Z is optional — if present, it's shown
   in the point list and in each marker's popup.
2. **Place on the map** — your CSV holds local X/Y (survey grid) coordinates,
   which have no inherent position on a real-world map. Two ways to place
   them:
   - **EPSG code (recommended)** — if this extension is installed inside a
     Trimble Connect project that has a Coordinate Reference System set
     (Project Settings → Project Details), the extension reads it
     automatically via the Workspace API (`ProjectAPI.getProject().crs`) and
     tries to pull out its EPSG code. If found, every point is transformed
     directly using that real projection (via `proj4js`, resolved live
     against [epsg.io](https://epsg.io)) — no manual work needed. If the
     project's CRS name doesn't contain a recognizable EPSG code, or you're
     running standalone, you can type one in yourself.
   - **Control points** — for sites with no known projection (an arbitrary
     local grid), tie 2+ CSV points to known lat/long (type them in, or
     click the target icon and click the map). The app solves a similarity
     transform (rotation + scale + translation) via least squares and
     reports the fit residual in meters.
3. **View** — all points render on an OpenStreetMap / Esri satellite base
   map, with popups showing each point's ID, description, local
   coordinates (including elevation, if mapped), and computed lat/long.
   Click any row in the point list to jump the map to it.

This is a plain static web app (`index.html`), so it works two ways:

- **Standalone**: open `index.html` in any browser, or host it anywhere
  (GitHub Pages, S3, Netlify, etc.) and use it on its own. CSV upload works;
  browsing Connect's file explorer and reading a project CRS obviously
  don't, since there's no Connect project to talk to.
- **As a Trimble Connect extension**: embedded inside Trimble Connect for
  Browser via an iframe, using Trimble's Workspace API.

## Browse from Trimble Connect

Instead of uploading a file from your computer, click **Browse from Trimble
Connect** (only enabled when running as an extension) to open the project's
own file explorer inside the extension and pick a CSV that's already
stored there. Under the hood this uses Trimble's documented embedded
File Explorer (`embed.initFileExplorer`) to let you pick a file, then
downloads its contents via a small serverless proxy included in this
project (`functions/api/download-file.js`) — see **Deploying with the file
browser enabled** below for why that proxy exists and how to deploy it.

One honest caveat: the exact "file selected" event fired by the embedded
explorer isn't part of Trimble's published API reference, so this listens
broadly and pattern-matches anything that looks like a chosen CSV. If a
future Connect release changes that event shape and clicking stops working,
the modal always has a **manual fallback** — paste the file's ID (visible
in its details panel in Connect) and click **Load by ID**.

## Deploying with the file browser enabled (Cloudflare Pages)

Trimble's Core API (`app.connect.trimble.com`), where file contents live,
doesn't send back CORS headers that let a third-party page fetch it
directly from the browser — you'll see a generic **"Failed to fetch"**
error if you try calling it straight from GitHub Pages or Netlify's static
hosting. The fix is a small serverless function that makes that one
request server-side (where CORS doesn't apply) and hands the result back
to the page over a same-origin call.

**[Cloudflare Pages](https://pages.cloudflare.com/)** is the easiest way to
get this without leaving GitHub — it deploys straight from your existing
GitHub repo (same workflow as GitHub Pages) and additionally runs anything
in a `functions/` folder as serverless endpoints, automatically, with zero
config.

1. Push this whole folder — including the `functions/` directory — to your
   GitHub repo, same as before.
2. Go to the [Cloudflare dashboard](https://dash.cloudflare.com/) → **Workers & Pages → Create → Pages → Connect to Git**.
3. Pick your `Control-Mapper` repo. Leave build settings blank (no build
   command, no output directory needed — this is a plain static site) and
   deploy.
4. Cloudflare gives you a URL like `https://control-mapper.pages.dev`.
   `functions/api/download-file.js` is automatically live at
   `https://control-mapper.pages.dev/api/download-file` — nothing extra to
   configure.
5. Update `manifest.json`'s `url` (and `infoUrl`) to point at your new
   `*.pages.dev` domain instead of GitHub Pages, and re-add the extension
   in **Project Settings → Extensions** with the updated manifest URL.

You can still keep GitHub Pages running for the plain "upload a CSV from my
computer" workflow if you'd rather not switch — only the **Browse from
Trimble Connect** button needs the proxy. But since Cloudflare Pages serves
the static files too, it's simplest to just point the whole extension at
it and retire the GitHub Pages version.

The proxy also handles something we noticed in your setup: Trimble Connect
projects are split across regional API hosts (yours showed
`app21.connect.trimble.com` / `app31.connect.trimble.com` in the network
log, consistent with an Australia-region project), and there's no
documented way to know which one a given project is on ahead of time. The
function tries `app`, `app21`, and `app31` in order and returns whichever
one succeeds — if your file download still fails, the error message will
tell you the last status code so we can add more regional hosts if needed.

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

## Installing into Trimble Connect — main menu, not the 3D Viewer

Trimble Connect has two separate places to install a custom extension, and
they put it in different spots:

- **Project Settings → Extensions** → the extension appears as its own
  entry in Connect's **left-hand main navigation menu**, occupying the
  middle/right panel of the project page. **This is what you want.**
- **3D Viewer → Extensions** → the extension instead lives inside the 3D
  Viewer only, as a side panel.

There's no separate manifest format for the two — it's purely about which
settings page you use to install the same `manifest.json`. So:

1. Host `index.html` at a public HTTPS URL.
2. Open `manifest.json` and replace `YOUR-HOSTED-URL` with that URL
   (and add a small icon if you'd like one in the extensions list).
3. In Trimble Connect for Browser, go to **Project Settings → Extensions**
   (not 3D Viewer → Extensions).
4. Choose to add a custom extension and provide the URL to your
   `manifest.json`.
5. Enable it. It now appears as its own item in the main left-hand menu,
   alongside Files, ToDos, etc. — not nested inside the 3D Viewer.

No Trimble API keys are required for the core CSV/map workflow. The
extension calls `ProjectAPI.getProject()` to read the project name and its
`crs` field (if a Coordinate Reference System has been set) — this is a
read-only project-metadata call. It also requests an access token via
`extension.getPermission('accesstoken')` so **Browse from Trimble Connect**
can work; Connect may show a one-time consent prompt for this. If any of
this fails (older Connect versions, missing permission, or running
standalone), the extension quietly falls back to manual EPSG entry /
control points and manual CSV upload; nothing else breaks.

## Try it now

`sample-points.csv` is included (now with a Z/elevation column) — open
`index.html`, drop that file in. If you're running standalone (not inside a
Trimble Connect project), switch to **Control points**, tie **P1** and
**P3** (opposite corners) to any two nearby real lat/long points, and hit
**Compute georeference** — the other five points snap into place relative
to them. If you're inside a Trimble Connect project with a CRS set, it
should place all seven points automatically.

## Notes & limitations

- The georeferencing transform assumes a **flat, locally-consistent grid**
  (fine for site/plan-scale survey data). It is not a substitute for a
  proper projected coordinate system (e.g. State Plane, UTM) if you need
  survey-grade accuracy — for that, control points should come from known
  monuments, and more of them (3+) improves the least-squares fit.
- Data stays in the browser tab; nothing is uploaded to a server except the
  direct request to Trimble's own Core API when using Browse from Connect.
  Refreshing the page clears the loaded CSV and control points.
- Satellite tiles are from Esri's public World Imagery service; street tiles
  from OpenStreetMap. Both are free, no API key needed, but are subject to
  their respective usage policies for heavy/production use.
- The download proxy tries three regional Core API hosts (`app`, `app21`,
  `app31` — see above) and returns whichever succeeds. If your project is
  on a region outside those three, "Load by ID" will fail with a clear
  error naming the last status code — send that over and another host can
  be added to `functions/api/download-file.js`.

