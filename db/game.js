import { db } from "./connection.js";
import { imagesFetchedAt } from "./images.js";

// ---------- game ----------

export function upsertGames(rows) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO game (id, title, cover_image_id, summary, release_date, popularity, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, cover_image_id = excluded.cover_image_id,
       summary = excluded.summary, release_date = excluded.release_date,
       popularity = excluded.popularity, updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((items) => {
    for (const g of items)
      insert.run(g.id, g.title, g.coverImageId, g.summary || null, g.releaseDate || null, g.popularity ?? null, now);
  });
  tx(rows);
}

export function getGame(id) {
  return db.prepare("SELECT * FROM game WHERE id = ?").get(id) || null;
}

export function replaceGameImages(gameId, imageIds) {
  const now = Date.now();
  const tx = db.transaction((ids) => {
    db.prepare("DELETE FROM game_image WHERE game_id = ?").run(gameId);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO game_image (game_id, image_id, fetched_at) VALUES (?, ?, ?)",
    );
    for (const id of ids) insert.run(gameId, id, now);
  });
  tx(imageIds);
}

export function getGameImages(gameId) {
  return db
    .prepare("SELECT image_id FROM game_image WHERE game_id = ?")
    .all(gameId)
    .map((r) => r.image_id);
}

export const gameImagesFetchedAt = (gameId) =>
  imagesFetchedAt("game_image", "game_id", gameId);
