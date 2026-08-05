import { db } from "./connection.js";

// ---------- music_track ----------

export function upsertMusicTracks(rows) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO music_track (id, title, artist, track, preview_url, poster_url, release_date, popularity, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, artist = excluded.artist, track = excluded.track,
       preview_url = excluded.preview_url, poster_url = excluded.poster_url,
       release_date = excluded.release_date,
       popularity = COALESCE(excluded.popularity, music_track.popularity),
       updated_at = excluded.updated_at`,
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
        m.popularity ?? null,
        now,
      );
  });
  tx(rows);
}

export function getMusicTrack(id) {
  return db.prepare("SELECT * FROM music_track WHERE id = ?").get(id) || null;
}

// ---------- music_search_resolution ----------

// pas de TTL : la correspondance artiste+titre → trackId ne bouge pas. La
// seule invalidation utile est un id devenu introuvable côté iTunes, et elle
// se constate au Lookup (voir fetchBlindtestTracks → forgetMusicSearchResolution).
export function getMusicSearchResolutions() {
  const rows = db.prepare("SELECT query_key, track_id FROM music_search_resolution").all();
  return new Map(rows.map((r) => [r.query_key, r.track_id]));
}

export function setMusicSearchResolution(queryKey, trackId) {
  db.prepare(
    `INSERT INTO music_search_resolution (query_key, track_id, resolved_at)
     VALUES (?, ?, ?)
     ON CONFLICT(query_key) DO UPDATE SET
       track_id = excluded.track_id, resolved_at = excluded.resolved_at`,
  ).run(queryKey, trackId, Date.now());
}

export function forgetMusicSearchResolution(queryKey) {
  db.prepare("DELETE FROM music_search_resolution WHERE query_key = ?").run(queryKey);
}
