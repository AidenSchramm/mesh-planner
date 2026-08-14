// elevation.js — terrain elevation via Mapzen/AWS "terrarium" tiles.
// elevation_m = (R * 256 + G + B / 256) - 32768
// Tiles are prefetched for the analysis bbox at a zoom chosen to keep the
// tile count reasonable; after prefetch every elevation query is a
// synchronous pixel read from cached ImageData.

const Elevation = (() => {
  // served by our own server, which disk-caches the AWS terrarium tiles
  const TILE_URL = (z, x, y) => `/tiles/${z}/${x}/${y}.png`;
  const TILE_SIZE = 256;
  const MAX_CACHED_TILES = 400;

  const tiles = new Map(); // "z/x/y" -> ImageData | null (null = failed/water)

  function lon2tileX(lon, z) { return ((lon + 180) / 360) * Math.pow(2, z); }
  function lat2tileY(lat, z) {
    const rad = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
  }

  // Pick the highest zoom (<= maxZ) that covers the bbox in <= maxTiles tiles.
  // Area-wide analysis uses maxZ 12 (~40-60 m/px); viewsheds and single-link
  // profiles pass higher maxZ for ~10-20 m detail over their smaller extents.
  function pickZoom(bbox, maxTiles = 110, maxZ = 12) {
    for (let z = maxZ; z >= 6; z--) {
      const x0 = Math.floor(lon2tileX(bbox.minLon, z));
      const x1 = Math.floor(lon2tileX(bbox.maxLon, z));
      const y0 = Math.floor(lat2tileY(bbox.maxLat, z));
      const y1 = Math.floor(lat2tileY(bbox.minLat, z));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= maxTiles) return z;
    }
    return 6;
  }

  async function fetchTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tiles.has(key)) return tiles.get(key);
    try {
      const res = await fetch(TILE_URL(z, x, y));
      if (!res.ok) throw new Error(`tile HTTP ${res.status}`);
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement('canvas');
      cv.width = TILE_SIZE; cv.height = TILE_SIZE;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const data = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
      bmp.close();
      if (tiles.size >= MAX_CACHED_TILES) tiles.delete(tiles.keys().next().value);
      tiles.set(key, data);
      return data;
    } catch (e) {
      tiles.set(key, null);
      return null;
    }
  }

  // Prefetch all tiles covering bbox at the chosen zoom. onProgress(done, total).
  async function prefetch(bbox, zoom, onProgress) {
    const x0 = Math.floor(lon2tileX(bbox.minLon, zoom));
    const x1 = Math.floor(lon2tileX(bbox.maxLon, zoom));
    const y0 = Math.floor(lat2tileY(bbox.maxLat, zoom));
    const y1 = Math.floor(lat2tileY(bbox.minLat, zoom));
    const jobs = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) jobs.push([x, y]);
    let done = 0;
    const CONC = 8;
    for (let i = 0; i < jobs.length; i += CONC) {
      await Promise.all(jobs.slice(i, i + CONC).map(([x, y]) =>
        fetchTile(zoom, x, y).then(() => {
          done++;
          if (onProgress) onProgress(done, jobs.length);
        })
      ));
    }
  }

  // Synchronous elevation lookup from cached tiles (bilinear). Returns meters,
  // or 0 if the tile isn't cached (call prefetch for the area first).
  function elevationAt(lat, lon, zoom) {
    const fx = lon2tileX(lon, zoom);
    const fy = lat2tileY(lat, zoom);
    const tx = Math.floor(fx), ty = Math.floor(fy);
    const data = tiles.get(`${zoom}/${tx}/${ty}`);
    if (!data) return 0;
    const px = (fx - tx) * TILE_SIZE;
    const py = (fy - ty) * TILE_SIZE;
    const x0 = Math.min(Math.floor(px), TILE_SIZE - 1);
    const y0 = Math.min(Math.floor(py), TILE_SIZE - 1);
    const x1 = Math.min(x0 + 1, TILE_SIZE - 1);
    const y1 = Math.min(y0 + 1, TILE_SIZE - 1);
    const fxr = px - x0, fyr = py - y0;
    const e = (x, y) => {
      const i = (y * TILE_SIZE + x) * 4;
      return data.data[i] * 256 + data.data[i + 1] + data.data[i + 2] / 256 - 32768;
    };
    const top = e(x0, y0) * (1 - fxr) + e(x1, y0) * fxr;
    const bot = e(x0, y1) * (1 - fxr) + e(x1, y1) * fxr;
    const v = top * (1 - fyr) + bot * fyr;
    return v < -1000 ? 0 : v; // guard against decode garbage
  }

  return { pickZoom, prefetch, elevationAt };
})();
