// analysis.js — RF line-of-sight modeling and network optimization.
//
// Model: straight ray over terrain with 4/3-effective-earth curvature.
//   link "clear"    = full 60% first-Fresnel-zone clearance along the path
//   link "marginal" = ray clears terrain but Fresnel zone is obstructed
//   link "blocked"  = terrain intersects the ray
// This intentionally ignores foliage/buildings — it's an upper bound, which is
// the standard approach for LoRa planning (as in the Meshtastic site planner).

const Analysis = (() => {
  const R_EARTH = 6371000;
  const R_EFF = R_EARTH * 4 / 3;

  // Yield to the event loop without setTimeout: browsers throttle timers in
  // background tabs to >= 1s, which froze long analyses when the tab was
  // hidden. MessageChannel posts are not throttled.
  const nextTick = () => new Promise((res) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => res();
    ch.port2.postMessage(null);
  });

  function haversine(lat1, lon1, lat2, lon2) {
    const toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.sqrt(a));
  }

  function freqGHzForRegion(region) {
    if (!region) return 0.915;
    if (region.includes('868') || region.startsWith('EU') || region === 'RU') return 0.868;
    if (region.includes('433')) return 0.433;
    if (region.startsWith('JP') || region.startsWith('KR')) return 0.921;
    return 0.915; // US, ANZ, TW, etc.
  }

  // LOS profile check between two endpoints with antenna heights (m AGL).
  // Requires elevation tiles for the area to be prefetched at `zoom`.
  function los(aLat, aLon, aAnt, bLat, bLon, bAnt, zoom, fGHz) {
    const dist = haversine(aLat, aLon, bLat, bLon);
    if (dist < 50) return { status: 'clear', dist, worst: Infinity, worstFrac: 0.5, worstClearance: Infinity, worstR1: 1 };
    const hA = Elevation.elevationAt(aLat, aLon, zoom) + aAnt;
    const hB = Elevation.elevationAt(bLat, bLon, zoom) + bAnt;
    const n = Math.max(24, Math.min(96, Math.round(dist / 250)));
    let worst = Infinity;       // min (clearance - 0.6*fresnel)
    let worstLosClear = Infinity; // min raw clearance
    let worstFrac = 0;
    let worstClearance = Infinity, worstR1 = 1;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const lat = aLat + (bLat - aLat) * t;
      const lon = aLon + (bLon - aLon) * t;
      const terrain = Elevation.elevationAt(lat, lon, zoom);
      const d1 = dist * t, d2 = dist * (1 - t);
      const bulge = (d1 * d2) / (2 * R_EFF);
      const ray = hA + (hB - hA) * t;
      const clearance = ray - (terrain + bulge);
      const fresnel = 17.32 * Math.sqrt((d1 / 1000) * (d2 / 1000) / ((dist / 1000) * fGHz));
      const margin = clearance - 0.6 * fresnel;
      if (margin < worst) {
        worst = margin; worstFrac = t;
        worstClearance = clearance; worstR1 = Math.max(fresnel, 0.01);
      }
      if (clearance < worstLosClear) worstLosClear = clearance;
    }
    const status = worst >= 0 ? 'clear' : worstLosClear >= 0 ? 'marginal' : 'blocked';
    return { status, dist, worst, worstFrac, worstClearance, worstR1 };
  }

  // Elevation/ray/Fresnel profile for charting a single path.
  function profile(aLat, aLon, aAnt, bLat, bLon, bAnt, zoom, fGHz, nSamples = 160) {
    const dist = haversine(aLat, aLon, bLat, bLon);
    const hA = Elevation.elevationAt(aLat, aLon, zoom) + aAnt;
    const hB = Elevation.elevationAt(bLat, bLon, zoom) + bAnt;
    const pts = [];
    for (let i = 0; i <= nSamples; i++) {
      const t = i / nSamples;
      const lat = aLat + (bLat - aLat) * t;
      const lon = aLon + (bLon - aLon) * t;
      const terrain = Elevation.elevationAt(lat, lon, zoom);
      const d1 = dist * t, d2 = dist * (1 - t);
      const bulge = (d1 * d2) / (2 * R_EFF);
      // render terrain at true elevation; the ray "sags" by the curvature bulge
      const ray = hA + (hB - hA) * t - bulge;
      const r1 = i === 0 || i === nSamples ? 0 :
        17.32 * Math.sqrt((d1 / 1000) * (d2 / 1000) / ((dist / 1000) * fGHz));
      pts.push({ d: dist * t, terrain, ray, r1 });
    }
    return { dist, hA, hB, pts };
  }

  function bearing(aLat, aLon, bLat, bLon) {
    const toR = Math.PI / 180;
    const y = Math.sin((bLon - aLon) * toR) * Math.cos(bLat * toR);
    const x = Math.cos(aLat * toR) * Math.sin(bLat * toR) -
      Math.sin(aLat * toR) * Math.cos(bLat * toR) * Math.cos((bLon - aLon) * toR);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // Approximate RX sensitivity (dBm) per Meshtastic modem preset.
  const PRESET_SENS = {
    SHORT_TURBO: -117, SHORT_FAST: -121, SHORT_SLOW: -124,
    MEDIUM_FAST: -127, MEDIUM_SLOW: -130,
    LONG_FAST: -134, LONG_MODERATE: -136, LONG_SLOW: -137,
    VERY_LONG_SLOW: -140,
  };

  function sensForPreset(preset) {
    return PRESET_SENS[preset] ?? -134; // LongFast default
  }

  // Rough LoRa link budget: free-space path loss + single knife-edge
  // diffraction at the worst obstruction + calibrated environment (clutter)
  // loss. 22 dBm TX, 0 dBi net gains, preset-dependent sensitivity.
  function linkBudget(losRes, fGHz, envLoss = 0, sens = -134) {
    const TX_DBM = 22, SENS = sens;
    const fspl = 32.44 + 20 * Math.log10(Math.max(losRes.dist, 50) / 1000) + 20 * Math.log10(fGHz * 1000);
    let diff = 0;
    if (losRes.worst < 0 && losRes.worstR1 > 0) {
      // Fresnel obstructed: ITU-R single knife-edge, v = √2 · (−clearance) / r1
      const v = Math.SQRT2 * (-losRes.worstClearance) / losRes.worstR1;
      if (v > -0.78) {
        diff = Math.max(0, 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1));
      }
    }
    const rx = TX_DBM - fspl - diff - envLoss;
    const margin = rx - SENS;
    const verdict = margin >= 10 ? 'likely' : margin >= 0 ? 'marginal' : 'unlikely';
    return { fspl, diff, envLoss, rx, margin, verdict };
  }

  // Calibrate the model against reality using neighbour-info reports:
  // - agreement: of the node pairs that actually hear each other, how many
  //   does the terrain model NOT call blocked? Disagreements usually mean a
  //   node's assumed height/position is wrong.
  // - envLoss: median gap between predicted RX and SNR-derived actual RX
  //   across observed links = local clutter loss (trees/buildings) the
  //   terrain-only model can't see.
  function calibrate(nodes, opts, extObs = []) {
    const { zoom, fGHz, antenna } = opts;
    const byId = new Map(nodes.map((n, i) => [n.id, i]));
    const pairs = new Map();
    nodes.forEach((n, i) => {
      if (!n.neighbours) return;
      for (const nb of n.neighbours) {
        const j = byId.get(nb.id);
        if (j == null || j === i) continue;
        const key = `${Math.min(i, j)}-${Math.max(i, j)}`;
        if (!pairs.has(key)) pairs.set(key, { i: Math.min(i, j), j: Math.max(i, j), snrs: [] });
        if (typeof nb.snr === 'number') pairs.get(key).snrs.push(nb.snr);
      }
    });
    // merge stored per-link SNR observations (direct gateway receptions
    // harvested from MQTT envelope metadata by the server)
    for (const o of extObs) {
      if (!o || o.n < 3) continue; // demand repeated receptions before trusting a pair
      const i = byId.get(o.a), j = byId.get(o.b);
      if (i == null || j == null || i === j) continue;
      const key = `${Math.min(i, j)}-${Math.max(i, j)}`;
      if (!pairs.has(key)) pairs.set(key, { i: Math.min(i, j), j: Math.max(i, j), snrs: [] });
      const p = pairs.get(key);
      if (typeof o.avgSnr === 'number') p.snrs.push(o.avgSnr);
      p.nObs = (p.nObs || 0) + o.n;
    }

    // LoRa RX estimate from SNR: thermal noise floor at 250 kHz + ~6 dB NF
    const NOISE_FLOOR = -114;
    // Mobile nodes (position hops between server samples, or tracker roles)
    // carry stale broadcast positions — their observed links say nothing about
    // the terrain between the *reported* coordinates, so exclude them.
    const isMobile = (n) => n.mobile === true || /TRACKER/.test(n.roleName || '');
    let observed = 0, agree = 0, excludedMobile = 0;
    const disagreements = [], excesses = [];
    for (const p of pairs.values()) {
      const a = nodes[p.i], b = nodes[p.j];
      if (isMobile(a) || isMobile(b)) { excludedMobile++; continue; }
      const r = los(a.lat, a.lon, a.ant ?? antenna, b.lat, b.lon, b.ant ?? antenna, zoom, fGHz);
      if (r.dist > 100000) continue; // implausible for direct RF — bad position data
      observed++;
      if (r.status !== 'blocked') agree++;
      else disagreements.push({
        i: p.i, j: p.j, dist: r.dist,
        snr: p.snrs.length ? Math.max(...p.snrs) : null,
        nObs: p.nObs || null,
      });
      // env-loss samples only from geometrically-viable links: blocked
      // disagreements are position/height errors, not clutter. LoRa SNR
      // saturates near +10 dB, so only unsaturated reports (snr <= 5) give a
      // usable RX estimate — strong links would fake a huge excess loss.
      if (p.snrs.length && r.status !== 'blocked') {
        const pred = linkBudget(r, fGHz, 0);
        for (const snr of p.snrs) {
          if (snr <= 5) excesses.push(pred.rx - (NOISE_FLOOR + snr));
        }
      }
    }

    let envLoss = null;
    if (excesses.length >= 3) {
      excesses.sort((x, y) => x - y);
      envLoss = Math.min(30, Math.max(0, excesses[Math.floor(excesses.length / 2)]));
    }
    // strongest-signal disagreements first — they're the clearest data errors
    disagreements.sort((x, y) => (y.snr ?? -99) - (x.snr ?? -99));
    return { observed, agree, disagreements, envLoss, snrSamples: excesses.length, excludedMobile };
  }

  // Compute all plausible links between nodes (pairs within maxRange).
  async function buildLinks(nodes, opts, onProgress) {
    const { maxRange, antenna, zoom, fGHz } = opts;
    const links = [];
    const pairs = [];
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const d = haversine(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon);
        if (d <= maxRange) pairs.push([i, j, d]);
      }
    for (let k = 0; k < pairs.length; k++) {
      const [i, j] = pairs[k];
      const a = nodes[i], b = nodes[j];
      // per-node antenna height (set from local height overrides), else global
      const r = los(a.lat, a.lon, a.ant ?? antenna, b.lat, b.lon, b.ant ?? antenna, zoom, fGHz);
      if (r.status !== 'blocked') links.push({ i, j, dist: r.dist, status: r.status });
      if (k % 200 === 199) {
        if (onProgress) onProgress(k + 1, pairs.length);
        await nextTick();
      }
    }
    if (onProgress) onProgress(pairs.length, pairs.length);
    return links;
  }

  // Radial viewshed: which ground area (receiver at rxH m AGL) can this
  // transmitter reach with terrain LOS? Ray-marches outward on many azimuths
  // keeping the max terrain angle seen so far; visible runs are stroked onto a
  // canvas sized to the coverage circle, for use as an L.imageOverlay.
  async function viewshed(lat, lon, antH, rxH, opts, onProgress) {
    const { zoom, maxRange } = opts;
    const W = 440; // canvas px, spans 2*maxRange
    const half = W / 2;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = W;
    const ctx = cv.getContext('2d');
    ctx.strokeStyle = 'rgba(30, 165, 90, 0.55)';
    ctx.lineCap = 'round';
    const mLat = 111320;
    const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const h0 = Elevation.elevationAt(lat, lon, zoom) + antH;
    const nRays = 720;
    ctx.lineWidth = Math.max(2, (2 * Math.PI * half) / nRays + 0.6);
    const stepLen = maxRange / half; // ~1 canvas px per step
    for (let r = 0; r < nRays; r++) {
      const az = (2 * Math.PI * r) / nRays;
      const dx = Math.sin(az), dy = Math.cos(az);
      let maxTan = -Infinity;
      let runStart = null;
      let s = stepLen;
      const strokeRun = (from, to) => {
        ctx.beginPath();
        ctx.moveTo(half + (dx * from) / maxRange * half, half - (dy * from) / maxRange * half);
        ctx.lineTo(half + (dx * to) / maxRange * half, half - (dy * to) / maxRange * half);
        ctx.stroke();
      };
      for (; s <= maxRange; s += stepLen) {
        const terr = Elevation.elevationAt(lat + (dy * s) / mLat, lon + (dx * s) / mLon, zoom);
        const drop = (s * s) / (2 * R_EFF); // earth curvature (4/3 effective)
        const visible = (terr + rxH - drop - h0) / s >= maxTan;
        if (visible && runStart === null) runStart = s;
        if (!visible && runStart !== null) { strokeRun(runStart, s - stepLen); runStart = null; }
        const tanTerr = (terr - drop - h0) / s;
        if (tanTerr > maxTan) maxTan = tanTerr;
      }
      if (runStart !== null) strokeRun(runStart, maxRange);
      if (r % 90 === 89) {
        if (onProgress) onProgress(r + 1, nRays);
        await nextTick();
      }
    }
    const bounds = [
      [lat - maxRange / mLat, lon - maxRange / mLon],
      [lat + maxRange / mLat, lon + maxRange / mLon],
    ];
    return { url: cv.toDataURL('image/png'), bounds, canvas: cv };
  }

  // ---- graph helpers --------------------------------------------------------

  function components(n, links) {
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (const l of links) { const a = find(l.i), b = find(l.j); if (a !== b) parent[a] = b; }
    const compOf = new Array(n);
    const ids = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!ids.has(r)) ids.set(r, ids.size);
      compOf[i] = ids.get(r);
    }
    return { compOf, count: ids.size };
  }

  function articulationPoints(n, links) {
    const adj = Array.from({ length: n }, () => []);
    for (const l of links) { adj[l.i].push(l.j); adj[l.j].push(l.i); }
    const disc = new Array(n).fill(-1), low = new Array(n).fill(0);
    const isAP = new Array(n).fill(false);
    let timer = 0;
    for (let root = 0; root < n; root++) {
      if (disc[root] !== -1) continue;
      // iterative DFS to avoid recursion limits
      const stack = [[root, -1, 0]];
      const parentOf = new Array(n).fill(-1);
      let rootChildren = 0;
      while (stack.length) {
        const frame = stack[stack.length - 1];
        const [u, parent] = frame;
        if (frame[2] === 0) { disc[u] = low[u] = timer++; }
        if (frame[2] < adj[u].length) {
          const v = adj[u][frame[2]++];
          if (v === parent) continue;
          if (disc[v] !== -1) { low[u] = Math.min(low[u], disc[v]); continue; }
          parentOf[v] = u;
          if (u === root) rootChildren++;
          stack.push([v, u, 0]);
        } else {
          stack.pop();
          if (parent !== -1) {
            low[parent] = Math.min(low[parent], low[u]);
            if (low[u] >= disc[parent] && parent !== root) isAP[parent] = true;
          }
        }
      }
      if (rootChildren > 1) isAP[root] = true;
    }
    return isAP;
  }

  // Estimate real antenna heights from observed-but-model-blocked links: for
  // each implicated node, find the smallest height AGL at which >=80% of its
  // observed links become terrain-viable. Confidence grows with accumulated
  // receptions, so estimates sharpen over time as the SNR store fills.
  function estimateHeights(nodes, disagreements, opts) {
    const byNode = new Map();
    for (const d of disagreements) {
      for (const [self, other] of [[d.i, d.j], [d.j, d.i]]) {
        if (!byNode.has(self)) byNode.set(self, []);
        byNode.get(self).push({ other, nObs: d.nObs || 1 });
      }
    }
    const HEIGHTS = [5, 10, 15, 20, 30, 45, 60];
    const out = [];
    for (const [i, list] of byNode) {
      const nd = nodes[i];
      if (nd.mobile || /TRACKER/.test(nd.roleName || '')) continue;
      if (nd.altOverride != null) continue; // already corrected by a human
      // demand evidence: multiple blocked pairs, or one with many receptions
      const evidence = list.reduce((s, x) => s + Math.min(x.nObs, 20), 0);
      if (list.length < 2 && evidence < 10) continue;
      const cur = nd.ant ?? opts.antenna;
      let found = null;
      for (const h of HEIGHTS) {
        if (h <= cur) continue;
        let fixed = 0;
        for (const { other } of list) {
          const o = nodes[other];
          const r = los(nd.lat, nd.lon, h, o.lat, o.lon, o.ant ?? opts.antenna, opts.zoom, opts.fGHz);
          if (r.status !== 'blocked') fixed++;
        }
        if (fixed >= Math.ceil(list.length * 0.8)) { found = { h, fixed }; break; }
      }
      if (found) {
        const terrain = Elevation.elevationAt(nd.lat, nd.lon, opts.zoom);
        out.push({
          i, height: found.h, fixes: found.fixed, of: list.length,
          asl: Math.round(terrain + found.h), evidence,
        });
      }
    }
    out.sort((a, b) => b.evidence - a.evidence);
    return out.slice(0, 3);
  }

  // ---- placement suggestions ------------------------------------------------

  // Suggest new sites focused on expanding/improving coverage of the area the
  // mesh actually serves. Candidates are elevation local-maxima NEAR the
  // existing network (within NEAR_MESH of a node) that can join it with at
  // least one clear link; they're scored by how much currently-UNCOVERED
  // nearby area they would newly cover (true LOS coverage, not just
  // proximity), plus a large bonus for bridging disconnected clusters.
  async function suggestPlacements(nodes, links, bbox, opts, onProgress) {
    const { zoom, maxRange, antenna, fGHz } = opts;
    const { compOf, count: nComp } = components(nodes.length, links);
    const NEAR_MESH = 12000; // stay relevant: within 12 km of an existing node
    const CAND_ANT = 10;     // assume a mast/pole at a purpose-built site

    const G = 44; // grid resolution
    const latStep = (bbox.maxLat - bbox.minLat) / G;
    const lonStep = (bbox.maxLon - bbox.minLon) / G;
    const grid = [];
    for (let gy = 0; gy <= G; gy++) {
      for (let gx = 0; gx <= G; gx++) {
        const lat = bbox.minLat + gy * latStep;
        const lon = bbox.minLon + gx * lonStep;
        grid.push({ lat, lon, gx, gy, elev: Elevation.elevationAt(lat, lon, zoom) });
      }
    }
    const at = (gx, gy) => grid[gy * (G + 1) + gx];
    for (const c of grid) {
      let best = Infinity;
      for (const nd of nodes) {
        const d = haversine(c.lat, c.lon, nd.lat, nd.lon);
        if (d < best) best = d;
      }
      c.dNode = best;
    }

    // Which near-mesh cells does the existing network actually cover?
    // covered = one of the nearest in-range nodes reaches it (receiver at 2 m)
    let sample = grid.filter((c) => c.dNode < NEAR_MESH);
    if (sample.length > 220) {
      const step = sample.length / 220;
      sample = Array.from({ length: 220 }, (_, i) => sample[Math.floor(i * step)]);
    }
    const uncovered = [];
    const totalWork = sample.length + 30;
    for (let ci = 0; ci < sample.length; ci++) {
      const c = sample[ci];
      const near = nodes
        .map((nd, i) => ({ i, d: haversine(c.lat, c.lon, nd.lat, nd.lon) }))
        .filter((x) => x.d <= maxRange)
        .sort((a, b) => a.d - b.d)
        .slice(0, 4);
      let covered = false;
      for (const { i } of near) {
        const r = los(nodes[i].lat, nodes[i].lon, nodes[i].ant ?? antenna, c.lat, c.lon, 2, zoom, fGHz);
        if (r.status !== 'blocked') { covered = true; break; }
      }
      if (!covered) uncovered.push(c);
      if (ci % 40 === 39) {
        if (onProgress) onProgress(ci + 1, totalWork);
        await nextTick();
      }
    }

    // candidates: local elevation maxima near the mesh, spaced apart
    let cands = [];
    for (let gy = 1; gy < G; gy++) {
      for (let gx = 1; gx < G; gx++) {
        const c = at(gx, gy);
        if (c.dNode > NEAR_MESH) continue;
        let isMax = true;
        for (let dy = -1; dy <= 1 && isMax; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if ((dx || dy) && at(gx + dx, gy + dy).elev > c.elev) { isMax = false; break; }
        if (isMax) cands.push(c);
      }
    }
    cands.sort((a, b) => b.elev - a.elev);
    const picked = [];
    for (const c of cands) {
      if (picked.every((p) => haversine(c.lat, c.lon, p.lat, p.lon) > 2500)) picked.push(c);
      if (picked.length >= 26) break;
    }

    const results = [];
    for (let ci = 0; ci < picked.length; ci++) {
      const c = picked[ci];
      const seenComps = new Set();
      let visibleNodes = 0, clearLinks = 0;
      const near = nodes
        .map((nd, i) => ({ i, d: haversine(c.lat, c.lon, nd.lat, nd.lon) }))
        .filter((x) => x.d <= maxRange)
        .sort((a, b) => a.d - b.d)
        .slice(0, 40);
      for (const { i } of near) {
        const r = los(c.lat, c.lon, CAND_ANT, nodes[i].lat, nodes[i].lon, nodes[i].ant ?? antenna, zoom, fGHz);
        if (r.status !== 'blocked') {
          seenComps.add(compOf[i]);
          visibleNodes++;
          if (r.status === 'clear') clearLinks++;
        }
      }
      if (onProgress) onProgress(sample.length + Math.round(((ci + 1) / picked.length) * 30), totalWork);
      if (ci % 3 === 2) await nextTick();
      if (clearLinks === 0) continue; // must join the mesh with a solid link

      let newCovered = 0;
      for (const cell of uncovered) {
        const d = haversine(c.lat, c.lon, cell.lat, cell.lon);
        if (d > maxRange) continue;
        const r = los(c.lat, c.lon, CAND_ANT, cell.lat, cell.lon, 2, zoom, fGHz);
        if (r.status !== 'blocked') newCovered++;
      }
      const bridges = Math.max(0, seenComps.size - 1);
      const score = bridges * 1000 + newCovered * 8 + Math.min(visibleNodes, 8);
      if (score > 0) {
        results.push({
          lat: c.lat, lon: c.lon, elev: Math.round(c.elev),
          visibleNodes, clearLinks, bridges, componentsSeen: seenComps.size,
          newCovered,
          gapCoveredPct: uncovered.length ? Math.round((newCovered / uncovered.length) * 100) : 0,
          score,
        });
      }
    }
    results.sort((a, b) => b.score - a.score);
    // dedupe: keep sites at least 4 km apart
    const final = [];
    for (const r of results) {
      if (final.every((f) => haversine(r.lat, r.lon, f.lat, f.lon) > 4000)) final.push(r);
      if (final.length >= 5) break;
    }
    return { placements: final, nComponents: nComp, compOf, uncoveredCount: uncovered.length };
  }

  // ---- role suggestions -----------------------------------------------------

  function suggestRoles(nodes, links, compOf, opts) {
    const n = nodes.length;
    const degree = new Array(n).fill(0);
    const adj = Array.from({ length: n }, () => []);
    for (const l of links) {
      degree[l.i]++; degree[l.j]++;
      adj[l.i].push(l.j); adj[l.j].push(l.i);
    }
    const isAP = articulationPoints(n, links);
    const elev = nodes.map((nd) => Elevation.elevationAt(nd.lat, nd.lon, opts.zoom));

    const nearbyCount = nodes.map((nd, i) =>
      nodes.filter((o, j) => j !== i && haversine(nd.lat, nd.lon, o.lat, o.lon) < 3000).length);

    const isRouterRole = (r) => /ROUTER|REPEATER/.test(r || '');
    const isMuted = (r) => /MUTE|HIDDEN/.test(r || '');

    const out = { routerUp: [], muteDown: [], routerExcess: [], isolated: [], critical: [] };

    for (let i = 0; i < n; i++) {
      const nd = nodes[i];

      if (degree[i] === 0) {
        let best = null;
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const d = haversine(nd.lat, nd.lon, nodes[j].lat, nodes[j].lon);
          if (!best || d < best.d) best = { j, d };
        }
        out.isolated.push({ i, nearest: best ? { name: nodes[best.j].name, distKm: best.d / 1000 } : null });
        continue;
      }

      if (isAP[i]) out.critical.push({ i, degree: degree[i] });

      // Promote to ROUTER: articulation point, well connected, higher than most
      // of its RF neighbors, currently a plain CLIENT, reliably online, and
      // not a mobile node (role changes make no sense for something that moves).
      if (nd.roleName === 'CLIENT' && isAP[i] && degree[i] >= 3 && !nd.mobile &&
        (nd.uptime == null || nd.uptime >= 0.6)) {
        const nbrElevs = adj[i].map((j) => elev[j]).sort((a, b) => a - b);
        const p75 = nbrElevs[Math.floor(nbrElevs.length * 0.75)] ?? 0;
        if (elev[i] >= p75) {
          out.routerUp.push({ i, degree: degree[i], elev: Math.round(elev[i]) });
        }
      }

      // Demote to CLIENT_MUTE: dense cluster, redundant (not an articulation
      // point), low relative elevation — its rebroadcasts mostly add airtime.
      if (nd.roleName === 'CLIENT' && !nd.mobile && !isAP[i] && nearbyCount[i] >= 8 && degree[i] >= 4) {
        const near = nodes
          .map((o, j) => ({ j, d: haversine(nd.lat, nd.lon, o.lat, o.lon) }))
          .filter((x) => x.j !== i && x.d < 3000)
          .map((x) => elev[x.j])
          .sort((a, b) => a - b);
        const median = near[Math.floor(near.length / 2)] ?? Infinity;
        if (elev[i] <= median) {
          out.muteDown.push({ i, degree: degree[i], nearby: nearbyCount[i] });
        }
      }
    }

    // Router excess: >= 3 router-role nodes within a 5 km cluster.
    const routers = nodes.map((nd, i) => ({ nd, i })).filter((x) => isRouterRole(x.nd.roleName));
    const flaggedClusters = new Set();
    for (const r of routers) {
      const cluster = routers.filter((o) =>
        haversine(r.nd.lat, r.nd.lon, o.nd.lat, o.nd.lon) < 5000);
      if (cluster.length >= 3) {
        const key = cluster.map((c) => c.i).sort((a, b) => a - b).join(',');
        if (!flaggedClusters.has(key)) {
          flaggedClusters.add(key);
          const lowest = cluster.reduce((m, c) => (elev[c.i] < elev[m.i] ? c : m));
          out.routerExcess.push({
            members: cluster.map((c) => c.i),
            lowest: lowest.i,
            centerLat: cluster.reduce((s, c) => s + c.nd.lat, 0) / cluster.length,
            centerLon: cluster.reduce((s, c) => s + c.nd.lon, 0) / cluster.length,
          });
        }
      }
    }

    out.routerUp.sort((a, b) => b.degree - a.degree);
    out.routerUp = out.routerUp.slice(0, 3);
    out.muteDown.sort((a, b) => b.nearby - a.nearby);
    out.muteDown = out.muteDown.slice(0, 6);
    out.degree = degree;
    return out;
  }

  return { haversine, freqGHzForRegion, sensForPreset, los, profile, bearing, linkBudget, calibrate, estimateHeights, buildLinks, components, suggestPlacements, suggestRoles, viewshed };
})();
