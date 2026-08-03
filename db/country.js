import { db, TTL_MS } from "./connection.js";

// ---------- country ----------

export function upsertCountries(rows) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO country (ccn3, cca2, title, photo_query, capital, region, population, area, subregion, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ccn3) DO UPDATE SET
       cca2 = excluded.cca2, title = excluded.title, photo_query = excluded.photo_query,
       capital = excluded.capital, region = excluded.region, population = excluded.population,
       area = excluded.area, subregion = excluded.subregion, updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((items) => {
    for (const c of items)
      insert.run(
        c.ccn3,
        c.cca2,
        c.title,
        c.photoQuery,
        c.capital || null,
        c.region,
        c.population ?? null,
        c.area ?? null,
        c.subregion || null,
        now,
      );
  });
  tx(rows);
}

export function getCountry(ccn3) {
  return db.prepare("SELECT * FROM country WHERE ccn3 = ?").get(ccn3) || null;
}

export function getAllCountries() {
  return db.prepare("SELECT * FROM country").all();
}

// dernière écriture connue pour ce pays (photos) — sert au warm loop à
// décider s'il faut re-fetcher (comparer à TTL_MS.countryPhoto via isFresh),
// sans stocker un champ dédié sur `country`
export function countryPhotosFetchedAt(ccn3) {
  const row = db
    .prepare(
      "SELECT MAX(fetched_at) AS t FROM country_photo WHERE country_ccn3 = ?",
    )
    .get(ccn3);
  return row?.t || null;
}

// vrai s'il existe au moins un pays du pool actif sans photo fraîche — une
// seule requête EXISTS, sans charger le pool en JS ni faire une requête par
// pays (contrairement à countryPhotosFetchedAt, appelé item par item pendant
// le warmLoop refresh.js, qui a de toute façon déjà le pool en mémoire).
// Utilisé par la LED /api/stats.ready (server.js/isDbWarmed).
export function anyCountryPhotosStale() {
  const cutoff = Date.now() - TTL_MS.countryPhoto;
  const row = db
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM country c
         JOIN type_item ti ON ti.entity_id = c.ccn3 AND ti.type = 'country'
         WHERE NOT EXISTS (
           SELECT 1 FROM country_photo cp
           WHERE cp.country_ccn3 = c.ccn3 AND cp.fetched_at > ?
         )
       ) AS stale`,
    )
    .get(cutoff);
  return Boolean(row.stale);
}

export function replaceCountryPhotos(ccn3, photos) {
  const now = Date.now();
  const tx = db.transaction((items) => {
    db.prepare("DELETE FROM country_photo WHERE country_ccn3 = ?").run(ccn3);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO country_photo (country_ccn3, url, vote_count, aspect_ratio, fetched_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const p of items)
      insert.run(ccn3, p.url, p.voteCount ?? 1, p.aspectRatio ?? null, now);
  });
  tx(photos);
}

// lecture cache-only, jamais d'appel réseau — utilisé à la génération du quiz
export function getCountryPhotos(ccn3) {
  return db
    .prepare(
      "SELECT url, vote_count AS voteCount, aspect_ratio AS aspectRatio FROM country_photo WHERE country_ccn3 = ?",
    )
    .all(ccn3);
}
