import { db } from "./connection.js";

// ---------- music_track ----------

export function upsertMusicTracks(rows) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO music_track (id, title, artist, track, preview_url, poster_url, release_date, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, artist = excluded.artist, track = excluded.track,
       preview_url = excluded.preview_url, poster_url = excluded.poster_url,
       release_date = excluded.release_date, updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((items) => {
    for (const m of items)
      insert.run(
        m.id,
        m.title,
        m.artist,
        m.track,
        m.previewUrl,
        m.posterUrl,
        m.releaseDate || null,
        now,
      );
  });
  tx(rows);
}

export function getMusicTrack(id) {
  return db.prepare("SELECT * FROM music_track WHERE id = ?").get(id) || null;
}
