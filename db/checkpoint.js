import { db, isFresh } from "./connection.js";

// scope: 'type' (crawl complet) | 'list' (cadence des listes) — voir le
// schéma de `checkpoint`. appVersion optionnel : seul scope='type' l'utilise
// aujourd'hui (fingerprint version d'appli), les autres passent null.
export function markRefreshed(scope, key, appVersion = null) {
  db.prepare(
    `INSERT INTO checkpoint (scope, key, refreshed_at, app_version) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET refreshed_at = excluded.refreshed_at, app_version = excluded.app_version`,
  ).run(scope, key, Date.now(), appVersion);
}

// appVersion optionnel : si fourni, exige aussi une correspondance exacte
// (voir markRefreshed) — sinon seule la fraîcheur temporelle compte.
export function isRefreshFresh(scope, key, ttlMs, appVersion = null) {
  const row = db
    .prepare(
      "SELECT refreshed_at, app_version FROM checkpoint WHERE scope = ? AND key = ?",
    )
    .get(scope, key);
  if (!row) return false;
  if (appVersion != null && row.app_version !== appVersion) return false;
  return isFresh(row.refreshed_at, ttlMs);
}
