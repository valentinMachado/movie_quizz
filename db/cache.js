import { db, TTL_MS } from "./connection.js";

// ---------- cache générique clé/valeur (remplace apiCache Map) ----------

export function cacheGet(key) {
  const row = db
    .prepare("SELECT value, expires_at FROM api_cache WHERE key = ?")
    .get(key);
  if (!row || row.expires_at <= Date.now()) return null;
  return JSON.parse(row.value);
}

export function cacheSet(key, value, ttlMs = TTL_MS.default) {
  db.prepare(
    "INSERT INTO api_cache (key, value, expires_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
  ).run(key, JSON.stringify(value), Date.now() + ttlMs);
}
