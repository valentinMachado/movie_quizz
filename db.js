import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";

// TTL par type de donnée — un défaut générique, une surcharge pour ce qui a
// une cadence de fraîcheur spécifique. Toutes les valeurs en ms.
//
// Philosophie : tout ce que refresh.js construit (entités, genres, images,
// réalisateurs, tableaux, photos pays) est traité comme quasi permanent —
// TTL ~1 mois, pour qu'un redémarrage de refresh.js dans le mois ne redéclenche
// aucun crawl coûteux (voir isRefreshFresh). Seule `listPool` (l'appartenance
// aux listes Populaire/Tendances) change réellement d'un jour à l'autre, d'où
// une cadence bien plus courte et dédiée (voir TYPES[type].refreshLists).
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_MONTH_MS = 30 * ONE_DAY_MS;
export const TTL_MS = {
  default: 6 * 60 * 60 * 1000, // 6h — api_cache générique (index saisons/épisodes TV, change réellement)
  typePool: ONE_MONTH_MS, // cadence de refreshTypes (fetch complet par type)
  listPool: ONE_DAY_MS, // cadence de refreshLists (appartenance Populaire/Tendances uniquement)
  mediaImage: ONE_MONTH_MS, // backdrops/profils/screenshots (changent quasi jamais)
  painterArtwork: ONE_MONTH_MS,
  countryPhoto: ONE_MONTH_MS,
  personBirthday: ONE_MONTH_MS, // couvre aussi place_of_birth (même appel TMDb)
  movieDirector: ONE_MONTH_MS,
  directorFilmography: ONE_MONTH_MS,
};

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS person (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  profile_image_url TEXT,
  portrait_image_url TEXT,
  birthday TEXT,
  place_of_birth TEXT,
  birthday_checked_at INTEGER,
  paintings_checked_at INTEGER,
  filmography_checked_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS movie (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  poster_path TEXT,
  overview TEXT,
  release_date TEXT,
  updated_at INTEGER NOT NULL,
  directors_checked_at INTEGER
);

CREATE TABLE IF NOT EXISTS tv_show (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  poster_path TEXT,
  overview TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  cover_image_id TEXT,
  summary TEXT,
  release_date TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS music_track (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  track TEXT NOT NULL,
  preview_url TEXT NOT NULL,
  poster_url TEXT NOT NULL,
  release_date TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS country (
  ccn3 INTEGER PRIMARY KEY,
  cca2 TEXT NOT NULL,
  title TEXT NOT NULL,
  photo_query TEXT NOT NULL,
  capital TEXT,
  region TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS painting (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  painter_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  UNIQUE(painter_id, image_url)
);

CREATE TABLE IF NOT EXISTS movie_director (
  movie_id INTEGER NOT NULL REFERENCES movie(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  PRIMARY KEY (movie_id, person_id)
);

CREATE TABLE IF NOT EXISTS country_photo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_ccn3 INTEGER NOT NULL REFERENCES country(ccn3) ON DELETE CASCADE,
  url TEXT NOT NULL,
  vote_count INTEGER,
  aspect_ratio REAL,
  fetched_at INTEGER NOT NULL,
  UNIQUE(country_ccn3, url)
);

CREATE TABLE IF NOT EXISTS movie_image (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  movie_id INTEGER NOT NULL REFERENCES movie(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  iso_639_1 TEXT,
  vote_count INTEGER,
  aspect_ratio REAL,
  fetched_at INTEGER NOT NULL,
  UNIQUE(movie_id, url)
);

CREATE TABLE IF NOT EXISTS tv_image (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tv_show_id INTEGER NOT NULL REFERENCES tv_show(id) ON DELETE CASCADE,
  season_number INTEGER,
  episode_number INTEGER,
  url TEXT NOT NULL,
  iso_639_1 TEXT,
  vote_count INTEGER,
  aspect_ratio REAL,
  fetched_at INTEGER NOT NULL,
  UNIQUE(tv_show_id, url)
);

CREATE TABLE IF NOT EXISTS person_image (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  iso_639_1 TEXT,
  vote_count INTEGER,
  aspect_ratio REAL,
  fetched_at INTEGER NOT NULL,
  UNIQUE(person_id, url)
);

CREATE TABLE IF NOT EXISTS game_image (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES game(id) ON DELETE CASCADE,
  image_id TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  UNIQUE(game_id, image_id)
);

CREATE TABLE IF NOT EXISTS type_item (
  type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  PRIMARY KEY (type, entity_id)
);

-- horodatage du dernier "refresh" réussi d'une clé dans un scope donné —
-- remplace le fingerprint (version + flags API) + TTL de l'ancien
-- reservoir.json, mais par clé plutôt que pour tout le fichier. Couvre le
-- crawl complet par type (scope='type', ex. clé "movie" ; une clé encore
-- fraîche ET écrite par la version en cours est reprise telle quelle au
-- démarrage, sinon re-fetchée, voir app_version) ET la cadence des listes
-- (scope='list', même clé "movie"/"tv"/...).
--
-- Réservé aux checkpoints PEU NOMBREUX (quelques lignes par scope, lus au
-- démarrage/à l'intervalle, jamais dans une boucle chaude) — PAS aux
-- checkpoints par entité à forte cardinalité (réalisateur par film, tableaux
-- par peintre : des milliers de lignes relues à chaque passage de warmLoop),
-- qui restent des colonnes dédiées (movie.directors_checked_at,
-- person.paintings_checked_at) pour rester lisibles gratuitement sur des
-- lignes déjà chargées en mémoire, voir movieNeedsDirectors/
-- personNeedsPaintings.
CREATE TABLE IF NOT EXISTS checkpoint (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL,
  app_version TEXT,
  PRIMARY KEY (scope, key)
);

-- filtres (film/série/jeu/musique/peintre), groupés par filter_group (genre,
-- liste, decennie, geographie) : une entité peut avoir plusieurs codes DANS
-- un groupe (ex. film Action ET Fantastique) — c'est ce qui permet de
-- construire, à la lecture, la règle "OR dans un groupe, AND entre groupes"
-- (voir getTypePool). code = identifiant externe du filtre (id TMDb pour
-- genre film/série, id IGDB pour genre jeu, code config.json pour
-- liste/decennie, QID Wikidata ou code pays pour peintre/film) — pas de FK
-- déclarée vers filter pour rester tolérant si l'ordre d'écriture varie.
CREATE TABLE IF NOT EXISTS filter (
  type TEXT NOT NULL,
  filter_group TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (type, filter_group, code)
);

CREATE TABLE IF NOT EXISTS entity_filter (
  type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  filter_group TEXT NOT NULL,
  code TEXT NOT NULL,
  PRIMARY KEY (type, entity_id, filter_group, code)
);

CREATE TABLE IF NOT EXISTS api_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stat_total (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_generated INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO stat_total (id, total_generated) VALUES (1, 0);
`;

// CREATE TABLE IF NOT EXISTS (voir SCHEMA) ne touche pas aux tables déjà
// existantes — une colonne ajoutée après coup à une table du schéma (ex.
// person.filmography_checked_at) a donc besoin d'un ALTER TABLE explicite ici
// pour rejoindre les bases déjà en place, sans jamais y toucher si elle y est
// déjà (PRAGMA table_info, pas de "ADD COLUMN IF NOT EXISTS" en SQLite).
function migrate() {
  const personCols = db.prepare("PRAGMA table_info(person)").all().map((c) => c.name);
  if (!personCols.includes("filmography_checked_at")) {
    try {
      db.exec("ALTER TABLE person ADD COLUMN filmography_checked_at INTEGER");
    } catch (e) {
      // server.js et refresh.js ouvrent chacun leur propre connexion au
      // même fichier et appellent migrate() à leur démarrage : si les deux
      // démarrent en même temps sur une base pas encore migrée, l'un des
      // deux peut arriver après que l'autre a déjà ajouté la colonne — pas
      // une vraie erreur, juste une course gagnée par l'autre process.
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
  const gameCols = db.prepare("PRAGMA table_info(game)").all().map((c) => c.name);
  if (!gameCols.includes("summary")) {
    try {
      db.exec("ALTER TABLE game ADD COLUMN summary TEXT");
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
  const movieCols = db.prepare("PRAGMA table_info(movie)").all().map((c) => c.name);
  if (!movieCols.includes("release_date")) {
    try {
      db.exec("ALTER TABLE movie ADD COLUMN release_date TEXT");
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
  const gameCols2 = db.prepare("PRAGMA table_info(game)").all().map((c) => c.name);
  if (!gameCols2.includes("release_date")) {
    try {
      db.exec("ALTER TABLE game ADD COLUMN release_date TEXT");
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
}

export function init(filePath) {
  if (filePath !== ":memory:") {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  migrate();
}

export function isFresh(checkedAt, ttlMs) {
  return checkedAt != null && Date.now() - checkedAt < ttlMs;
}

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

// ---------- person (acteurs TMDb + peintres Wikidata + réalisateurs TMDb) ----------

// upsert par (source, external_id) : crée ou met à jour nom/images, ne touche
// jamais birthday/place_of_birth/paintings (gérés séparément, TTL propre).
export function upsertPerson({
  source,
  externalId,
  name,
  profileImageUrl = null,
  portraitImageUrl = null,
}) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO person (source, external_id, name, profile_image_url, portrait_image_url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, external_id) DO UPDATE SET
       name = excluded.name,
       profile_image_url = COALESCE(excluded.profile_image_url, person.profile_image_url),
       portrait_image_url = COALESCE(excluded.portrait_image_url, person.portrait_image_url),
       updated_at = excluded.updated_at`,
  ).run(source, externalId, name, profileImageUrl, portraitImageUrl, now);
  return db
    .prepare("SELECT id FROM person WHERE source = ? AND external_id = ?")
    .get(source, externalId).id;
}

export function getPersonById(id) {
  return db.prepare("SELECT * FROM person WHERE id = ?").get(id) || null;
}

export function getPersonByExternalId(source, externalId) {
  return (
    db
      .prepare("SELECT * FROM person WHERE source = ? AND external_id = ?")
      .get(source, externalId) || null
  );
}

export function personNeedsPaintings(person) {
  return !isFresh(person.paintings_checked_at, TTL_MS.painterArtwork);
}

// vrai s'il existe au moins un peintre du pool actif dont les tableaux ne
// sont plus frais — une seule requête EXISTS, sans charger le pool en JS
// (contrairement à personNeedsPaintings, appliqué item par item pendant le
// warmLoop refresh.js, qui a de toute façon déjà le pool en mémoire).
// Utilisé par la LED /api/stats.ready (server.js/isDbWarmed).
export function anyPainterArtworkStale() {
  const cutoff = Date.now() - TTL_MS.painterArtwork;
  const row = db
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM person p
         JOIN type_item ti ON ti.entity_id = p.id AND ti.type = 'painter'
         WHERE p.paintings_checked_at IS NULL OR p.paintings_checked_at <= ?
       ) AS stale`,
    )
    .get(cutoff);
  return Boolean(row.stale);
}

export function replacePainterArtworks(painterId, imageUrls) {
  const now = Date.now();
  const tx = db.transaction((urls) => {
    db.prepare("DELETE FROM painting WHERE painter_id = ?").run(painterId);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO painting (painter_id, image_url, fetched_at) VALUES (?, ?, ?)",
    );
    for (const url of urls) insert.run(painterId, url, now);
    db.prepare("UPDATE person SET paintings_checked_at = ? WHERE id = ?").run(
      now,
      painterId,
    );
  });
  tx(imageUrls);
}

// lecture cache-only, jamais d'appel réseau — utilisé à la génération du quiz
export function getPainterArtworks(painterId) {
  return db
    .prepare("SELECT image_url FROM painting WHERE painter_id = ?")
    .all(painterId)
    .map((r) => r.image_url);
}

// ---------- movie ----------

export function upsertMovies(rows) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO movie (id, title, poster_path, overview, release_date, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, poster_path = excluded.poster_path,
       overview = excluded.overview, release_date = excluded.release_date,
       updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((items) => {
    for (const m of items)
      insert.run(m.id, m.title, m.posterPath, m.overview || "", m.releaseDate || null, now);
  });
  tx(rows);
}

export function getMovie(id) {
  return db.prepare("SELECT * FROM movie WHERE id = ?").get(id) || null;
}

export function movieNeedsDirectors(movie) {
  return !isFresh(movie.directors_checked_at, TTL_MS.movieDirector);
}

// upsert les person réalisateur(s) + jointure movie_director, marque le film
// comme vérifié — retourne les personId upsertés pour que l'appelant puisse
// les ajouter au pool "person" (voir refresh.js, warmLoop "Films
// (réalisateurs)"), sans que cette fonction ait à connaître ce concept.
export function setMovieDirectors(movieId, directors) {
  const now = Date.now();
  const tx = db.transaction((people) => {
    db.prepare("DELETE FROM movie_director WHERE movie_id = ?").run(movieId);
    const link = db.prepare(
      "INSERT OR IGNORE INTO movie_director (movie_id, person_id) VALUES (?, ?)",
    );
    const personIds = [];
    for (const d of people) {
      const personId = upsertPerson({
        source: "tmdb",
        externalId: String(d.id),
        name: d.name,
        profileImageUrl: d.profilePath
          ? `https://image.tmdb.org/t/p/w500${d.profilePath}`
          : null,
      });
      link.run(movieId, personId);
      personIds.push(personId);
    }
    db.prepare("UPDATE movie SET directors_checked_at = ? WHERE id = ?").run(
      now,
      movieId,
    );
    return personIds;
  });
  return tx(directors);
}

// noms joints ("Nom1, Nom2"), ou null si aucun réalisateur connu — même format
// que la réponse API historique
export function getMovieDirectorNames(movieId) {
  const rows = db
    .prepare(
      `SELECT p.name FROM movie_director md
       JOIN person p ON p.id = md.person_id
       WHERE md.movie_id = ?`,
    )
    .all(movieId);
  if (rows.length === 0) return null;
  return rows.map((r) => r.name).join(", ");
}

export function personNeedsBirthday(person) {
  return !isFresh(person.birthday_checked_at, TTL_MS.personBirthday);
}

// birthday/place_of_birth (API détail TMDb "/person/{id}") — beaucoup de
// personnes n'ont simplement pas cette date connue de TMDb (birthday peut
// rester null indéfiniment) ; birthday_checked_at avance quand même pour ne
// pas retenter cette personne avant le TTL.
export function setPersonBirthday(personId, birthday, placeOfBirth) {
  db.prepare(
    `UPDATE person SET birthday = ?, place_of_birth = ?, birthday_checked_at = ?
     WHERE id = ?`,
  ).run(birthday || null, placeOfBirth || null, Date.now(), personId);
}

export function personNeedsFilmography(person) {
  return !isFresh(person.filmography_checked_at, TTL_MS.directorFilmography);
}

// complète la filmographie d'un réalisateur au-delà des films déjà présents
// dans le pool "movie" (curated par popularité/genre/décennie/pays, pas
// exhaustif — voir refresh.js/warmLoop "Réalisateurs (filmographie
// complète)") : movies vient de l'API "crédits d'une personne" (TMDb), qui
// ne connaît QUE ce réalisateur pour chaque film (pas d'éventuels
// co-réalisateurs, contrairement à setMovieDirectors qui part des crédits du
// FILM) — lien additif (INSERT OR IGNORE, jamais de DELETE) pour ne jamais
// écraser un movie_director déjà posé plus précisément par setMovieDirectors.
export function addDirectorFilmography(personId, movies) {
  const now = Date.now();
  const upsertMovie = db.prepare(
    `INSERT INTO movie (id, title, poster_path, overview, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, poster_path = excluded.poster_path,
       overview = excluded.overview, updated_at = excluded.updated_at`,
  );
  const link = db.prepare(
    "INSERT OR IGNORE INTO movie_director (movie_id, person_id) VALUES (?, ?)",
  );
  const tx = db.transaction((items) => {
    for (const m of items) {
      upsertMovie.run(m.id, m.title, m.posterPath, m.overview || "", now);
      link.run(m.id, personId);
    }
    db.prepare("UPDATE person SET filmography_checked_at = ? WHERE id = ?").run(
      now,
      personId,
    );
  });
  tx(movies);
}

// ---------- tv_show ----------

export function upsertTvShows(rows) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO tv_show (id, title, poster_path, overview, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, poster_path = excluded.poster_path,
       overview = excluded.overview, updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((items) => {
    for (const t of items)
      insert.run(t.id, t.title, t.posterPath, t.overview || "", now);
  });
  tx(rows);
}

export function getTvShow(id) {
  return db.prepare("SELECT * FROM tv_show WHERE id = ?").get(id) || null;
}

// ---------- game ----------

export function upsertGames(rows) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO game (id, title, cover_image_id, summary, release_date, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, cover_image_id = excluded.cover_image_id,
       summary = excluded.summary, release_date = excluded.release_date,
       updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((items) => {
    for (const g of items)
      insert.run(g.id, g.title, g.coverImageId, g.summary || null, g.releaseDate || null, now);
  });
  tx(rows);
}

export function getGame(id) {
  return db.prepare("SELECT * FROM game WHERE id = ?").get(id) || null;
}

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

// ---------- country ----------

export function upsertCountries(rows) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO country (ccn3, cca2, title, photo_query, capital, region, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ccn3) DO UPDATE SET
       cca2 = excluded.cca2, title = excluded.title, photo_query = excluded.photo_query,
       capital = excluded.capital, region = excluded.region, updated_at = excluded.updated_at`,
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

// ---------- images multiples (movie/tv/person/game) ----------

function replaceImages(table, fkColumn, entityId, images) {
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

function getImages(table, fkColumn, entityId) {
  return db
    .prepare(
      `SELECT url, iso_639_1, vote_count, aspect_ratio FROM ${table} WHERE ${fkColumn} = ?`,
    )
    .all(entityId);
}

function imagesFetchedAt(table, fkColumn, entityId) {
  const row = db
    .prepare(`SELECT MAX(fetched_at) AS t FROM ${table} WHERE ${fkColumn} = ?`)
    .get(entityId);
  return row?.t || null;
}

export const replaceMovieImages = (movieId, images) =>
  replaceImages("movie_image", "movie_id", movieId, images);
export const getMovieImages = (movieId) =>
  getImages("movie_image", "movie_id", movieId);
export const movieImagesFetchedAt = (movieId) =>
  imagesFetchedAt("movie_image", "movie_id", movieId);

export const replacePersonImages = (personId, images) =>
  replaceImages("person_image", "person_id", personId, images);
export const getPersonImages = (personId) =>
  getImages("person_image", "person_id", personId);
export const personImagesFetchedAt = (personId) =>
  imagesFetchedAt("person_image", "person_id", personId);

// tv_image a des colonnes supplémentaires (season/episode) : pas de replaceImages générique ici
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

export function gameImagesFetchedAt(gameId) {
  return imagesFetchedAt("game_image", "game_id", gameId);
}

// ---------- type_item ----------

// remplace intégralement le pool d'un type — remplace ce qu'était
// `reservoirByCategory[key] = [...items]` avant la migration vers cette DB.
// Réservé aux types mono-source (un seul crawl a une connaissance complète
// et autoritaire du pool, ex. fetchMovieEntities) — voir addTypeItems pour
// les types alimentés par plusieurs sources indépendantes (ex. "person").
export function replaceTypeItems(type, entityIds) {
  const tx = db.transaction((ids) => {
    db.prepare("DELETE FROM type_item WHERE type = ?").run(type);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO type_item (type, entity_id) VALUES (?, ?)",
    );
    for (const id of ids) insert.run(type, id);
  });
  tx(entityIds);
}

// ajoute au pool d'un type sans jamais rien supprimer — pour les types
// alimentés par plusieurs sources indépendantes qui n'ont chacune connaissance
// que de leur propre contribution (ex. "person" : acteurs + réalisateurs +
// peintres, aucune des trois ne sachant ce que les autres ont déjà écrit).
// Contrepartie assumée : un pool additif ne rétrécit jamais (voir
// replaceTypeItems pour le cas mono-source qui, lui, se resynchronise
// intégralement à chaque crawl).
export function addTypeItems(type, entityIds) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO type_item (type, entity_id) VALUES (?, ?)",
  );
  const tx = db.transaction((ids) => {
    for (const id of ids) insert.run(type, id);
  });
  tx(entityIds);
}

export function countTypeItems(type) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM type_item WHERE type = ?")
    .get(type).n;
}

// ces jointures servent à matérialiser côté serveur ce que peuplait l'ancien
// `reservoirByCategory[key]` — même table (`person`) pour les types
// 'person' et 'painter', d'où le paramètre idColumn séparé du type.
//
// selections: { [filterGroup]: string[] } optionnel — OR entre les codes
// d'un même groupe, AND entre groupes différents (ex. films [Populaire OU
// Tendance] ET [Action]). Le JOIN sur entity_filter + GROUP BY/HAVING est ce
// qui impose l'AND inter-groupes : une entité doit avoir au moins une ligne
// matchée par groupe demandé pour ressortir. Sans selections (ou tous les
// groupes vides), comportement inchangé : tout le pool actif (type_item).
function getTypePool(table, idColumn, type, selections = {}) {
  const groups = Object.keys(selections).filter((g) => selections[g]?.length);
  if (groups.length === 0) {
    return db
      .prepare(
        `SELECT t.* FROM ${table} t
         JOIN type_item ti ON ti.entity_id = t.${idColumn} AND ti.type = ?`,
      )
      .all(type);
  }
  const clauses = groups.map(
    (g) =>
      `(ef.filter_group = ? AND ef.code IN (${selections[g].map(() => "?").join(",")}))`,
  );
  const params = [type, type];
  for (const g of groups) params.push(g, ...selections[g]);
  params.push(groups.length);
  return db
    .prepare(
      `SELECT t.* FROM ${table} t
       JOIN type_item ti ON ti.entity_id = t.${idColumn} AND ti.type = ?
       JOIN entity_filter ef ON ef.entity_id = t.${idColumn} AND ef.type = ?
       WHERE ${clauses.join(" OR ")}
       GROUP BY t.${idColumn}
       HAVING COUNT(DISTINCT ef.filter_group) = ?`,
    )
    .all(...params);
}

export const getMoviePool = (selections) =>
  getTypePool("movie", "id", "movie", selections);
export const getTvShowPool = (selections) =>
  getTypePool("tv_show", "id", "tv", selections);
export const getGamePool = (selections) =>
  getTypePool("game", "id", "game", selections);
export const getMusicTrackPool = (selections) =>
  getTypePool("music_track", "id", "music", selections);
export const getCountryPool = (selections) =>
  getTypePool("country", "ccn3", "country", selections);
export const getPersonPool = (selections) =>
  getTypePool("person", "id", "person", selections);
export const getPainterPool = (selections) =>
  getTypePool("person", "id", "painter", selections);
export const getDirectorPool = (selections) =>
  getTypePool("person", "id", "director", selections);

// ---------- quiz du jour : anniversaires (mois/jour, toutes années confondues) ----------
//
// release_date (movie/music_track) et birthday (person) sont tous stockés au
// format ISO "YYYY-MM-DD..." (voir musicDecadeCode dans refresh.js, qui
// s'appuie déjà sur ce même format par simple découpage de chaîne plutôt que
// via une fonction date SQLite) — substr(...,6,2)/substr(...,9,2) donne donc
// mois/jour de façon uniforme sur les trois tables, sans dépendre du fuseau
// ni d'un parsing de date. Restreint à type_item (pool actif), comme
// getTypePool, pour ne jamais faire remonter une entité désactivée entre-temps.
export function getMoviesByReleaseMonthDay(month, day) {
  return db
    .prepare(
      `SELECT t.* FROM movie t
       JOIN type_item ti ON ti.entity_id = t.id AND ti.type = 'movie'
       WHERE t.release_date IS NOT NULL
         AND substr(t.release_date, 6, 2) = ?
         AND substr(t.release_date, 9, 2) = ?`,
    )
    .all(month, day);
}

export function getGamesByReleaseMonthDay(month, day) {
  return db
    .prepare(
      `SELECT t.* FROM game t
       JOIN type_item ti ON ti.entity_id = t.id AND ti.type = 'game'
       WHERE t.release_date IS NOT NULL
         AND substr(t.release_date, 6, 2) = ?
         AND substr(t.release_date, 9, 2) = ?`,
    )
    .all(month, day);
}

export function getMusicTracksByReleaseMonthDay(month, day) {
  return db
    .prepare(
      `SELECT t.* FROM music_track t
       JOIN type_item ti ON ti.entity_id = t.id AND ti.type = 'music'
       WHERE t.release_date IS NOT NULL
         AND substr(t.release_date, 6, 2) = ?
         AND substr(t.release_date, 9, 2) = ?`,
    )
    .all(month, day);
}

// une même personne peut être à la fois dans le pool "person" (acteur/
// peintre) et "director" (réalisateur) — le type d'appel (voir server.js)
// choisit lequel interroger, comme getPersonPool/getDirectorPool le font déjà.
export function getPersonsByBirthMonthDay(type, month, day) {
  return db
    .prepare(
      `SELECT t.* FROM person t
       JOIN type_item ti ON ti.entity_id = t.id AND ti.type = ?
       WHERE t.birthday IS NOT NULL
         AND substr(t.birthday, 6, 2) = ?
         AND substr(t.birthday, 9, 2) = ?`,
    )
    .all(type, month, day);
}

// synchronise type_item "director" avec le contenu actuel de movie_director
// — backfill pur SQL (aucun appel réseau), à lancer au démarrage de
// refresh.js. Sans ça, les réalisateurs déjà connus d'AVANT l'introduction
// du quiz "réalisateur" (movie_director déjà peuplé, movie.directors_checked_at
// déjà frais donc le warmLoop concerné ne repasse pas dessus avant son
// prochain TTL, ~1 mois) resteraient invisibles du pool "director" jusqu'à
// cette échéance — voir addTypeItems("director", ...) dans le warmLoop, qui
// ne couvre que la découverte incrémentale à partir de maintenant.
export function syncDirectorPoolFromMovieDirector() {
  const ids = db
    .prepare("SELECT DISTINCT person_id FROM movie_director")
    .all()
    .map((r) => r.person_id);
  addTypeItems("director", ids);
}

// même principe que syncDirectorPoolFromMovieDirector, pour les filtres :
// recopie sur "director" les tags genre/décennie/geographie déjà connus des
// films de movie_director (backfill pur SQL, aucun appel réseau) — sans ça,
// les réalisateurs déjà backfillés par syncDirectorPoolFromMovieDirector
// resteraient sans aucun filtre jusqu'à ce que movie.directors_checked_at
// expire (~1 mois) et fasse repasser le warmLoop incrémental (voir
// refresh.js) sur leurs films.
export function syncDirectorFiltersFromMovies() {
  const rows = db
    .prepare(
      `SELECT md.person_id AS personId, ef.filter_group AS filterGroup, ef.code, f.name
       FROM movie_director md
       JOIN entity_filter ef ON ef.type = 'movie' AND ef.entity_id = md.movie_id
       JOIN filter f ON f.type = 'movie' AND f.filter_group = ef.filter_group AND f.code = ef.code
       WHERE ef.filter_group IN ('genre', 'decennie', 'geographie')`,
    )
    .all();

  const defsByGroup = {};
  const codesByGroupPerson = {};
  for (const r of rows) {
    (defsByGroup[r.filterGroup] ??= new Map()).set(r.code, r.name);
    const perPerson = (codesByGroupPerson[r.filterGroup] ??= new Map());
    if (!perPerson.has(r.personId)) perPerson.set(r.personId, new Set());
    perPerson.get(r.personId).add(r.code);
  }

  for (const [group, defs] of Object.entries(defsByGroup)) {
    upsertFilters(
      "director",
      group,
      [...defs].map(([code, name]) => ({ code, name })),
    );
    addEntityFilters(
      "director",
      group,
      [...codesByGroupPerson[group]].map(([entityId, codes]) => ({
        entityId,
        codes: [...codes],
      })),
    );
  }
}

// affiches des films réalisés par cette personne (+ titre, affiché en
// surimpression côté client — un poster n'écrit pas toujours son titre de
// façon lisible) — sert d'images de devinette au quiz "réalisateur" (deviner
// le nom à partir d'une liste de films, pas de sa propre photo). Lecture
// cache-only, alimentée par le warmLoop réalisateurs de refresh.js
// (movie_director + movie.poster_path).
export function getDirectorMoviePosters(personId) {
  return db
    .prepare(
      `SELECT m.title AS title, m.poster_path AS posterPath FROM movie_director md
       JOIN movie m ON m.id = md.movie_id
       WHERE md.person_id = ? AND m.poster_path IS NOT NULL`,
    )
    .all(personId);
}

// dev/test uniquement (--max-type-count) : réduit le pool global d'un
// type à N entités distinctes au total — pour que les warm loops
// (tableaux/réalisateurs/photos pays) n'aient qu'une poignée de cibles à
// chauffer pendant un test manuel, au lieu de milliers.
export function clampTypeGlobalPool(type, maxCount) {
  const all = db
    .prepare("SELECT DISTINCT entity_id FROM type_item WHERE type = ?")
    .all(type)
    .map((r) => r.entity_id);
  if (all.length <= maxCount) return;
  const keep = new Set(all.slice(0, maxCount));
  const del = db.prepare(
    "DELETE FROM type_item WHERE type = ? AND entity_id = ?",
  );
  const tx = db.transaction(() => {
    for (const entityId of all) {
      if (!keep.has(entityId)) del.run(type, entityId);
    }
  });
  tx();
}

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

// ---------- filtres (genre/liste/decennie/geographie, voir schéma) ----------

export function upsertFilters(type, filterGroup, filters) {
  const insert = db.prepare(
    `INSERT INTO filter (type, filter_group, code, name) VALUES (?, ?, ?, ?)
     ON CONFLICT(type, filter_group, code) DO UPDATE SET name = excluded.name`,
  );
  const tx = db.transaction((items) => {
    for (const f of items) insert.run(type, filterGroup, f.code, f.name);
  });
  tx(filters);
}

// entries: [{ entityId, codes }] — remplace, pour CE groupe uniquement, tous
// les codes connus de chaque entité listée (les autres groupes ne sont pas
// touchés) ; codes vide = entité sans filtre connu dans ce groupe. Réservé
// aux cas où l'appelant a une connaissance COMPLÈTE et autoritaire des codes
// de cette entité dans ce groupe pour cette passe (ex. tous les genres d'un
// film via genre_ids) — voir addEntityFilters sinon (ex. "role" sur
// "person" : chaque contributeur ne connaît qu'un rôle à la fois, un
// remplacement écraserait les rôles déjà posés par un autre contributeur).
export function replaceEntityFilters(type, filterGroup, entries) {
  const del = db.prepare(
    "DELETE FROM entity_filter WHERE type = ? AND filter_group = ? AND entity_id = ?",
  );
  const insert = db.prepare(
    "INSERT OR IGNORE INTO entity_filter (type, entity_id, filter_group, code) VALUES (?, ?, ?, ?)",
  );
  const tx = db.transaction((items) => {
    for (const { entityId, codes } of items) {
      del.run(type, filterGroup, entityId);
      for (const code of codes) insert.run(type, entityId, filterGroup, code);
    }
  });
  tx(entries);
}

// entries: [{ entityId, codes }] — AJOUTE ces codes sans jamais supprimer
// les codes déjà posés par un autre appelant (voir addTypeItems pour le
// même principe côté pool). Utile quand plusieurs sources indépendantes
// contribuent au même groupe pour des entités qui peuvent se recouper (ex.
// une personne acteur ET réalisateur, chaque rôle posé par une source
// différente sans connaissance de l'autre).
export function addEntityFilters(type, filterGroup, entries) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO entity_filter (type, entity_id, filter_group, code) VALUES (?, ?, ?, ?)",
  );
  const tx = db.transaction((items) => {
    for (const { entityId, codes } of items) {
      for (const code of codes) insert.run(type, entityId, filterGroup, code);
    }
  });
  tx(entries);
}

// comme getEntityFilters, mais garde le code (pas seulement le nom affiché)
// — sert à recopier tel quel un tag connu d'une entité vers une autre (ex.
// propager le genre/décennie/geographie d'un film vers son/ses réalisateur(s),
// voir refresh.js/warmLoop "Films (réalisateurs)"), où le code est
// nécessaire pour appeler addEntityFilters sur le type cible.
export function getEntityFilterEntries(type, entityId) {
  return db
    .prepare(
      `SELECT ef.filter_group AS filterGroup, ef.code, f.name FROM entity_filter ef
       JOIN filter f ON f.type = ef.type AND f.filter_group = ef.filter_group AND f.code = ef.code
       WHERE ef.type = ? AND ef.entity_id = ?`,
    )
    .all(type, entityId);
}

// lecture cache-only, jamais d'appel réseau — regroupé par filter_group,
// utile pour un futur affichage détaillé d'une entité.
export function getEntityFilters(type, entityId) {
  const rows = db
    .prepare(
      `SELECT f.filter_group, f.name FROM entity_filter ef
       JOIN filter f ON f.type = ef.type AND f.filter_group = ef.filter_group AND f.code = ef.code
       WHERE ef.type = ? AND ef.entity_id = ?`,
    )
    .all(type, entityId);
  const out = {};
  for (const r of rows) (out[r.filter_group] ??= []).push(r.name);
  return out;
}

// filtres disponibles pour un type, groupés — data-driven depuis la table
// `filter` (pas de liste de groupes codée en dur ici) ; sert à annoncer au
// client quels filtres proposer pour un type donné.
// libellé affiché d'un seul code (ex. quiz du jour : quel intitulé de liste
// a fait entrer une entité dans le quiz — voir server.js) — mêmes lignes que
// getFiltersForType, juste un accès direct par code plutôt que tout le groupe.
export function getFilterLabel(type, filterGroup, code) {
  const row = db
    .prepare(
      "SELECT name FROM filter WHERE type = ? AND filter_group = ? AND code = ?",
    )
    .get(type, filterGroup, code);
  return row?.name || null;
}

export function getFiltersForType(type) {
  const rows = db
    .prepare(
      "SELECT filter_group, code, name FROM filter WHERE type = ? ORDER BY filter_group, name",
    )
    .all(type);
  const out = {};
  for (const r of rows)
    (out[r.filter_group] ??= []).push({ code: r.code, name: r.name });
  return out;
}

// ---------- stats ----------

export function getStats() {
  const total = db
    .prepare("SELECT total_generated FROM stat_total WHERE id = 1")
    .get().total_generated;
  return { totalGenerated: total };
}

export function recordQuizGenerated() {
  return db
    .prepare(
      "UPDATE stat_total SET total_generated = total_generated + 1 WHERE id = 1 RETURNING total_generated",
    )
    .get().total_generated;
}
