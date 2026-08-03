import { db } from "./connection.js";

// ---------- images multiples (movie/tv/person/game) : helpers génériques ----------
//
// tv_image a des colonnes supplémentaires (season/episode) : pas de
// replaceImages générique pour ce cas-là, voir db/tv.js (addTvImages).

export function replaceImages(table, fkColumn, entityId, images) {
  const now = Date.now();
  const tx = db.transaction((items) => {
    db.prepare(`DELETE FROM ${table} WHERE ${fkColumn} = ?`).run(entityId);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${table} (${fkColumn}, url, iso_639_1, vote_count, aspect_ratio, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const b of items)
      insert.run(
        entityId,
        b.url,
        b.iso_639_1 ?? null,
        b.vote_count ?? null,
        b.aspect_ratio ?? null,
        now,
      );
  });
  tx(images);
}

export function getImages(table, fkColumn, entityId) {
  return db
    .prepare(
      `SELECT url, iso_639_1, vote_count, aspect_ratio FROM ${table} WHERE ${fkColumn} = ?`,
    )
    .all(entityId);
}

export function imagesFetchedAt(table, fkColumn, entityId) {
  const row = db
    .prepare(`SELECT MAX(fetched_at) AS t FROM ${table} WHERE ${fkColumn} = ?`)
    .get(entityId);
  return row?.t || null;
}
