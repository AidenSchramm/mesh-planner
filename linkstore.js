// linkstore.js — per-link SNR observation store.
//
// Every packet a Meshtastic MQTT gateway heard DIRECTLY off the air
// (hop_start == hop_limit, not via_mqtt) is a measured RF link between two
// known nodes. We aggregate those into per-pair, per-day rows in SQLite:
// counts plus SNR/RSSI statistics. Storage stays tiny (aggregates, 90-day
// retention) while giving the model a continuously-growing ground-truth set.
//
// Uses Node's built-in node:sqlite (v22.5+) — no npm dependencies. If the
// module is unavailable the feature degrades gracefully to "disabled".

const path = require('path');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}

const RETENTION_DAYS = 90;

let db = null;
let insertStmt = null;
let buf = [];
const counters = { received: 0, stored: 0, flushErrors: 0 };

function init(dataDir) {
  if (!DatabaseSync) {
    console.warn('[linkobs] node:sqlite unavailable — link observations disabled');
    return false;
  }
  try {
    db = new DatabaseSync(path.join(dataDir, 'linkobs.db'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS link_obs (
        a INTEGER NOT NULL,
        b INTEGER NOT NULL,
        day TEXT NOT NULL,
        n INTEGER NOT NULL DEFAULT 0,
        snr_sum REAL NOT NULL DEFAULT 0,
        snr_min REAL,
        snr_max REAL,
        rssi_sum REAL NOT NULL DEFAULT 0,
        rssi_n INTEGER NOT NULL DEFAULT 0,
        last_at INTEGER,
        PRIMARY KEY (a, b, day)
      );
    `);
    insertStmt = db.prepare(`
      INSERT INTO link_obs (a, b, day, n, snr_sum, snr_min, snr_max, rssi_sum, rssi_n, last_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(a, b, day) DO UPDATE SET
        n = n + 1,
        snr_sum = snr_sum + excluded.snr_sum,
        snr_min = MIN(snr_min, excluded.snr_min),
        snr_max = MAX(snr_max, excluded.snr_max),
        rssi_sum = rssi_sum + excluded.rssi_sum,
        rssi_n = rssi_n + excluded.rssi_n,
        last_at = MAX(last_at, excluded.last_at)
    `);
    prune();
    setInterval(flush, 5000).unref();
    setInterval(prune, 24 * 3600 * 1000).unref();
    console.log('[linkobs] SQLite store ready');
    return true;
  } catch (e) {
    console.warn('[linkobs] init failed:', e.message);
    db = null;
    return false;
  }
}

// obs: { a, b, snr, rssi, at } with a < b (node ids)
function add(obs) {
  if (!db) return;
  counters.received++;
  buf.push(obs);
  if (buf.length > 5000) flush(); // backstop against a very busy firehose
}

function flush() {
  if (!db || buf.length === 0) return;
  const batch = buf;
  buf = [];
  try {
    db.exec('BEGIN');
    for (const o of batch) {
      const day = new Date(o.at).toISOString().slice(0, 10);
      insertStmt.run(o.a, o.b, day, o.snr, o.snr, o.snr,
        o.rssi != null ? o.rssi : 0, o.rssi != null ? 1 : 0, o.at);
    }
    db.exec('COMMIT');
    counters.stored += batch.length;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    counters.flushErrors++;
    console.warn('[linkobs] flush failed:', e.message);
  }
}

function prune() {
  if (!db) return;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString().slice(0, 10);
  try {
    db.prepare('DELETE FROM link_obs WHERE day < ?').run(cutoff);
  } catch (e) { console.warn('[linkobs] prune failed:', e.message); }
}

// Aggregate observations across days for pairs where BOTH ends are in `ids`.
function query(ids) {
  if (!db || !Array.isArray(ids) || ids.length === 0) return [];
  const idList = ids.slice(0, 400).map(Number).filter(Number.isFinite);
  if (!idList.length) return [];
  flush(); // include anything buffered
  const ph = idList.map(() => '?').join(',');
  try {
    const rows = db.prepare(`
      SELECT a, b, SUM(n) AS n, SUM(snr_sum) AS ss,
             MIN(snr_min) AS mn, MAX(snr_max) AS mx, MAX(last_at) AS la
      FROM link_obs
      WHERE a IN (${ph}) AND b IN (${ph})
      GROUP BY a, b
    `).all(...idList, ...idList);
    return rows.map((r) => ({
      a: r.a, b: r.b, n: r.n,
      avgSnr: r.ss / r.n, minSnr: r.mn, maxSnr: r.mx,
      lastAt: r.la,
    }));
  } catch (e) {
    console.warn('[linkobs] query failed:', e.message);
    return [];
  }
}

function stats() {
  if (!db) return { enabled: false };
  let pairs = null;
  try { pairs = db.prepare('SELECT COUNT(DISTINCT a || \'-\' || b) AS c FROM link_obs').get().c; } catch {}
  return { enabled: true, ...counters, pending: buf.length, pairs };
}

module.exports = { init, add, flush, query, stats };
