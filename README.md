# Mesh Planner

A local web app that combines live Meshtastic node data with terrain elevation to
analyze a mesh network in any area and suggest improvements — in the spirit of
[site.meshtastic.org](https://site.meshtastic.org/) (terrain/coverage) merged with
[meshtastic.liamcottle.net](https://meshtastic.liamcottle.net) (live node map).

## Run

```
node server.js
```

Then open http://localhost:8620. Requires Node 18+ (no npm dependencies).

Type a city, ZIP code, address, or raw `lat, lon` coordinates and hit **Go**, or pan the
map and click **Analyze current map view**.

## What it does

1. **Geocodes** your query (OSM Nominatim) and builds an analysis bounding box.
2. **Fetches mesh nodes** in the area. The local server merges and caches two public
   sources: meshtastic.liamcottle.net (rich records: roles, neighbours, channel
   utilization) and meshmap.net (official MQTT broker aggregate, fills regional gaps).
3. **Loads terrain** (Mapzen/AWS terrarium elevation tiles, decoded in-browser).
4. **Models every possible RF link** between node pairs in range: straight ray over
   terrain with 4/3-effective-earth curvature and 60% first-Fresnel-zone clearance at
   the region's LoRa frequency (868/915 MHz auto-detected from node records).
   - green = clear LOS + Fresnel, dashed orange = marginal, blocked pairs are dropped
   - dotted blue lines are *reported* RF neighbour links (ground truth from
     neighbour-info packets), for comparison against the model
5. **Finds inefficiencies and suggests fixes:**
   - **New node sites** — elevation local-maxima candidates scored by how many
     disconnected clusters they'd bridge and how much uncovered area they'd serve
     (numbered yellow markers on the map)
   - **CLIENT → ROUTER** — elevated cut-point nodes whose loss would split the mesh
   - **CLIENT → CLIENT_MUTE** — low-sitting nodes in dense clusters whose rebroadcasts
     burn airtime without extending coverage
   - **Router excess** — ≥3 router-role nodes within 5 km (rebroadcast multiplication)
   - **Isolated nodes** — no viable link to anything, with the likely reason
   - **Airtime congestion** — flags areas averaging >25% channel utilization

## Planning tools

- **Plan a node** — click the map to drop a hypothetical node (cyan pin, draggable,
  selectable mast height). Shows live which real nodes it would reach, whether it
  bridges disconnected clusters, and its coverage viewshed — before you buy hardware.
- **Measure LOS** — click any two points for a terrain/Fresnel/link-budget check
  with the full profile chart. Points are draggable to refine.
- **Simulate offline** — the power icon in a node popup takes it offline in
  simulation: links vanish, and a banner reports how the mesh fragments.
- **Combined coverage** — with viewsheds active, the Viewsheds card reports what %
  of the analysis area is covered.
- **Permalinks** — the URL hash encodes center+radius (e.g. `/#43.53,-96.69,30`),
  so any analysis view is shareable. Suggested sites export as GPX waypoints.

## Live data & accuracy

- The server subscribes to the public Meshtastic MQTT broker's **map-report topics**
  (zero-dependency MQTT client + protobuf decoder in `mqtt-live.js`) and blends
  near-real-time positions/roles into the aggregate databases.
- **Node uptime** is sampled every refresh cycle (`data/reliability.json`); after
  ~1 h of samples, popups show an Uptime tile and unreliable nodes are excluded
  from ROUTER-role suggestions.
- Link budgets use **preset-aware sensitivity** (auto-detected majority modem
  preset) and terrain up to **z14 (~10 m)** for single-link profiles and z13 for
  viewsheds; area-wide passes stay at z12 for speed.

## Point-to-point link inspector

Clicking a node lists every potential link to nodes in range in the right-hand
"Point-to-point links" panel, sorted best-first. Each entry shows distance and
estimated link margin; selecting one renders the terrain elevation profile with the
curved RF ray, the first Fresnel zone envelope, and a stats card (distance, estimated
received power, margin vs LongFast sensitivity, LOS state, Fresnel clearance,
knife-edge diffraction loss) — same idea as the official Site Planner's
point-to-point tool.

## Model calibration from observed links

Neighbour-info reports (nodes actually hearing each other, with SNR) are used as RF
ground truth two ways:

- **Agreement scorecard** — the snapshot shows how many observed links the terrain
  model correctly predicts ("Obs. links match"). Pairs that hear each other but the
  model calls blocked surface as CALIBRATE suggestion cards: they almost always mean
  a node's broadcast height/position is wrong — open it and fix it with Adjust.
- **Environment loss** — for geometrically-viable observed links with unsaturated
  SNR (≤5 dB; LoRa SNR caps near +10 so strong links can't be used), the median gap
  between predicted and SNR-derived received power is fitted as local clutter loss
  (trees/buildings the terrain model can't see) and applied to all link-budget
  margins and verdicts. Needs ≥3 usable samples; shown in the snapshot when active.

## Correcting node data

Nodes often broadcast wrong or truncated positions and garbage GPS altitudes. Click a
node → **Adjust…** to open the correction panel: enter the true height ASL (meters or
feet), and drag the orange pin (or type coordinates) to fix the position — the
coordinates box updates live while dragging. **Save & re-analyze** stores the
correction on the server (shared by every visitor, with full edit history — the
panel shows recent history and clicking an entry restores those values) and reruns
the analysis; corrected height feeds directly into LOS and viewshed math as the
node's effective antenna height above terrain. Adjusted nodes show an orange
"adjusted" badge; **Clear** reverts to the broadcast data. Corrections live in
`data/overrides.json` + `data/history.jsonl` (legacy localStorage corrections are
migrated automatically on first load).

## Caveats

- The node dataset only contains nodes whose position reaches a public MQTT broker.
  Regions running private MQTT (many local mesh groups) appear sparse — an empty map
  does not mean an empty mesh.
- The LOS model ignores buildings and foliage; it's an optimistic upper bound, the
  same approach as the official site planner. Verify link suggestions in the field.
- Elevation tiles are ~30–60 m resolution at analysis zoom; small terrain features
  and rooftops are invisible to it.
- Dense metros are capped at the 350 most recently positioned nodes per analysis.

## Hosting

See [DEPLOY.md](DEPLOY.md) for a step-by-step Vultr VPS deployment (systemd +
Caddy HTTPS). The server is deliberately polite to upstreams: one cached node-DB
fetch per 5 min max, geocoding proxied through a rate-limited (1 req/s) cache,
and terrain tiles disk-cached locally. API responses are gzipped.

## Files

- `server.js` — static files + node-data proxy (5-min cache, bbox filtering) +
  corrections store with history + geocode cache + terrain tile cache
- `public/js/elevation.js` — terrarium tile prefetch/decode, bilinear elevation queries
- `public/js/analysis.js` — LOS/Fresnel modeling, link graph, articulation points,
  placement scoring, role suggestions
- `public/js/app.js` — map UI, geocoding, orchestration, rendering
