import { db } from "./connection.js";

// ---------- tv_show ----------

export function upsertTvShows(rows) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO tv_show (id, title, poster_path, overview, popularity, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, poster_path = excluded.poster_path,
       overview = excluded.overview, popularity = excluded.popularity,
       updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((items) => {
    for (const t of items)
      insert.run(t.id, t.title, t.posterPath, t.overview || "", t.popularity ?? null, now);
  });
  tx(rows);
}

export function getTvShow(id) {
  return db.prepare("SELECT * FROM tv_show WHERE id = ?").get(id) || null;
}

// tv_image a des colonnes supplémentaires (season/episode) : pas de
// replaceImages générique ici (voir db/images.js)
export function addTvImages(tvShowId, seasonNumber, episodeNumber, images) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO tv_image
       (tv_show_id, season_number, episode_number, url, iso_639_1, vote_count, aspect_ratio, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((items) => {
    for (const b of items)
      insert.run(
        tvShowId,
        seasonNumber,
        episodeNumber,
        b.url,
        b.iso_639_1 ?? null,
        b.vote_count ?? null,
        b.aspect_ratio ?? null,
        now,
      );
  });
  tx(images);
}

// toutes les images connues d'une série — tous les épisodes déjà chauffés
// confondus (voir refresh.js/fetchAndStoreTvImages ; on devine à partir
// d'images D'ÉPISODE, jamais de visuels globaux de la série). Lecture
// cache-only, jamais d'appel réseau, utilisée à la génération du quiz : la
// variété d'un épisode à l'autre vient du pool combiné (voir pickFromPool
// côté server.js), pas d'un choix explicite d'épisode ici.
export function getTvShowImages(tvShowId) {
  return db
    .prepare(
      `SELECT url, iso_639_1, vote_count, aspect_ratio FROM tv_image WHERE tv_show_id = ?`,
    )
    .all(tvShowId);
}

// épisodes déjà chauffés avec au moins un still — sert uniquement au warm
// loop tv (combien reste-t-il à chauffer, voir tvShowNeedsWarming), pas à la
// génération du quiz (voir getTvShowImages).
export function getTvWarmedEpisodes(tvShowId) {
  return db
    .prepare(
      `SELECT DISTINCT season_number AS season, episode_number AS episode
       FROM tv_image
       WHERE tv_show_id = ?`,
    )
    .all(tvShowId);
}
