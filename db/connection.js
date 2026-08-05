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
  countryLeader: ONE_DAY_MS, // chef d'État actuel (change avec les élections, contrairement au reste des données pays)
  personBirthday: ONE_MONTH_MS, // couvre aussi place_of_birth (même appel TMDb)
  movieDirector: ONE_MONTH_MS,
  directorFilmography: ONE_MONTH_MS,
};

export let db;

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

-- résolution "artiste + titre exact" → trackId iTunes, mémorisée entre les
-- crawls (voir fetchBlindtestTracks) : la config music.blindtestSongs reste la
-- source de vérité en clair, mais on ne repaie plus une recherche iTunes par
-- morceau à chaque passe — l'API Search est la seule bridée agressivement
-- (403), Lookup accepte 150 ids d'un coup. Clé = artiste|titre normalisés,
-- donc éditer la config invalide d'elle-même l'entrée correspondante.
CREATE TABLE IF NOT EXISTS music_search_resolution (
  query_key TEXT PRIMARY KEY,
  track_id INTEGER NOT NULL,
  resolved_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS country (
  ccn3 INTEGER PRIMARY KEY,
  cca2 TEXT NOT NULL,
  title TEXT NOT NULL,
  photo_query TEXT NOT NULL,
  capital TEXT,
  region TEXT NOT NULL,
  updated_at INTEGER NOT NULL
  -- population/area/subregion : voir migrate() (ALTER TABLE), pas ici, comme
  -- person.filmography_checked_at ailleurs dans ce schéma.
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

CREATE TABLE IF NOT EXISTS movie_cast (
  movie_id INTEGER NOT NULL REFERENCES movie(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  cast_order INTEGER,
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

-- id = pageid Wikipédia (comme movie.id = id TMDb) : identifiant externe
-- stable réutilisé tel quel comme PK, pas d'AUTOINCREMENT séparé — évite un
-- aller-retour de lookup après l'upsert (voir upsertMovies pour le même
-- principe).
-- aliases : JSON (tableau de strings) des redirections Wikipédia vers cet
-- article (variantes d'orthographe, noms étrangers/scientifiques...) — sert
-- à mieux anonymiser le titre dans le summary (voir redactTitle côté
-- server.js), au-delà du seul titre affiché.
-- loose_redaction : 1 si au moins une des catégories source de cet article
-- a "looseRedaction": true (config.json, ex. Animaux) — autorise
-- redactTitle (server.js) à masquer une simple SOUS-CHAÎNE du titre (utile
-- pour les diminutifs, "renard" -> "renardeau") plutôt qu'une occurrence en
-- mot entier (défaut plus sûr, évite "fort" -> "[titre]ifié" dans
-- "fortifié").
CREATE TABLE IF NOT EXISTS wiki_article (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  extract TEXT,
  thumbnail_url TEXT,
  aliases TEXT,
  loose_redaction INTEGER NOT NULL DEFAULT 0,
  popularity REAL,
  event_date TEXT,
  updated_at INTEGER NOT NULL
);

-- iso_639_1 : inutilisé ici (les images Wikipédia n'ont pas de variante par
-- langue), mais requis par le helper générique replaceImages/getImages
-- (db/images.js), qui attend la même forme que movie_image/tv_image/
-- person_image/game_image — voir replaceWikiArticleImages.
CREATE TABLE IF NOT EXISTS wiki_article_image (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wiki_article_id INTEGER NOT NULL REFERENCES wiki_article(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  iso_639_1 TEXT,
  vote_count INTEGER,
  aspect_ratio REAL,
  fetched_at INTEGER NOT NULL,
  UNIQUE(wiki_article_id, url)
);

-- id = national dex number (id PokeAPI, stable) — même principe que
-- movie.id = id TMDb. sprite_url = official-artwork (repli sprite par
-- défaut si absente) ; cry_url absent pour les quelques espèces sans cri
-- connu côté PokeAPI (questionType "audio" les exclut alors, voir
-- materializePokemonRows côté server.js).
CREATE TABLE IF NOT EXISTS pokemon (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sprite_url TEXT,
  cry_url TEXT,
  summary TEXT,
  popularity REAL,
  updated_at INTEGER NOT NULL
);

-- id = id superhero-api (akabab.github.io/superhero-api), dense petit
-- entier — même principe que pokemon.id. summary est déjà une synthèse
-- textuelle construite au moment du fetch (voir buildSummary dans
-- db/refresh/superhero.js, l'API ne fournit pas de bio toute faite comme le
-- flavor text PokeAPI). aliases : JSON des noms alternatifs (vrai nom,
-- alter-ego) à masquer dans le summary, même mécanique que
-- wiki_article.aliases.
CREATE TABLE IF NOT EXISTS superhero (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT,
  summary TEXT,
  aliases TEXT,
  updated_at INTEGER NOT NULL
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

-- filtres (film/série/jeu/musique/peintre/pays), groupés par filter_group
-- (genre, liste, decennie, geographie — + population/superficie, propres au
-- type "country") : une entité peut avoir plusieurs codes DANS
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
  for (const [table, cols] of [
    ["movie", movieCols],
    ["tv_show", db.prepare("PRAGMA table_info(tv_show)").all().map((c) => c.name)],
    ["game", db.prepare("PRAGMA table_info(game)").all().map((c) => c.name)],
    ["person", personCols],
    // wiki_article : pageviews cumulées (voir setWikiArticlePopularities) —
    // même colonne que les autres pour que "valeur brute de notoriété" reste
    // un seul concept quel que soit le type et sa source.
    ["wiki_article", db.prepare("PRAGMA table_info(wiki_article)").all().map((c) => c.name)],
  ]) {
    if (!cols.includes("popularity")) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN popularity REAL`);
      } catch (e) {
        if (!/duplicate column name/i.test(e.message)) throw e;
      }
    }
  }
  const countryCols = db.prepare("PRAGMA table_info(country)").all().map((c) => c.name);
  for (const [col, type] of [
    ["population", "INTEGER"],
    ["area", "REAL"],
    ["subregion", "TEXT"],
    // chef d'État actuel (questionType "leader") — voir
    // fetchAndStoreCountryLeader dans refresh/wikipedia.js. leader_person_id
    // pointe vers une ligne person (role=politician), leader_name/
    // leader_portrait_url sont dénormalisés ici pour que getCountryPool
    // (SELECT t.* générique, voir db/typeItem.js) les expose sans jointure.
    ["leader_person_id", "INTEGER"],
    ["leader_name", "TEXT"],
    ["leader_portrait_url", "TEXT"],
    // intitulé du poste (ex. "Président de la République française",
    // "Empereur") — cible du wikilien de `titre_dirigeant` dans l'infobox,
    // voir countryLeaderFromDump (refresh/frwiki-dump.js). Affiché au
    // reveal du questionType "statesman" (server.js), pas alimenté pour
    // "leader" (même source, juste inutilisé dans ce sens-là).
    ["leader_title", "TEXT"],
    ["leader_checked_at", "INTEGER"],
  ]) {
    if (!countryCols.includes(col)) {
      try {
        db.exec(`ALTER TABLE country ADD COLUMN ${col} ${type}`);
      } catch (e) {
        if (!/duplicate column name/i.test(e.message)) throw e;
      }
    }
  }
  const wikiArticleImageCols = db
    .prepare("PRAGMA table_info(wiki_article_image)")
    .all()
    .map((c) => c.name);
  if (!wikiArticleImageCols.includes("iso_639_1")) {
    try {
      db.exec("ALTER TABLE wiki_article_image ADD COLUMN iso_639_1 TEXT");
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
  const wikiArticleCols = db
    .prepare("PRAGMA table_info(wiki_article)")
    .all()
    .map((c) => c.name);
  if (!wikiArticleCols.includes("aliases")) {
    try {
      db.exec("ALTER TABLE wiki_article ADD COLUMN aliases TEXT");
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
  if (!wikiArticleCols.includes("loose_redaction")) {
    try {
      db.exec("ALTER TABLE wiki_article ADD COLUMN loose_redaction INTEGER NOT NULL DEFAULT 0");
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
  // date d'événement (bataille/guerre), précision jour uniquement — voir
  // setWikiArticleEventDates/fetchEventDates dans refresh/wikipedia.js.
  if (!wikiArticleCols.includes("event_date")) {
    try {
      db.exec("ALTER TABLE wiki_article ADD COLUMN event_date TEXT");
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
  // résumé (extrait Wikipédia FR) + poste occupé (P39) + métier précis (P106)
  // — alimentés uniquement pour les rôles "person" via Wikidata (voir
  // fetchPersonRoleEntities dans refresh/wikidata.js), un acteur (source
  // tmdb) n'aura jamais ces colonnes renseignées. nationality (démonyme FR)
  // est la seule des 4 alimentée par LES DEUX sources (TMDb via
  // fetchAndStorePersonDetails, Wikidata via fetchPersonRoleEntities).
  const personColsForSummary = db.prepare("PRAGMA table_info(person)").all().map((c) => c.name);
  for (const col of ["summary", "position_held", "nationality", "specific_occupation"]) {
    if (!personColsForSummary.includes(col)) {
      try {
        db.exec(`ALTER TABLE person ADD COLUMN ${col} TEXT`);
      } catch (e) {
        if (!/duplicate column name/i.test(e.message)) throw e;
      }
    }
  }
  // titre d'article Wikipédia FR (voir fetchPersonRoleEntities) : réutilisé
  // par le warmLoop "Personnes Wikidata (photos)" pour aller chercher
  // d'autres photos que le seul portrait Wikidata déjà en base, sans
  // re-résoudre le titre à chaque passage. photos_checked_at : TTL dédié de
  // ce warmLoop, même principe que paintings_checked_at/birthday_checked_at.
  const personColsForPhotos = db.prepare("PRAGMA table_info(person)").all().map((c) => c.name);
  if (!personColsForPhotos.includes("wiki_title")) {
    try {
      db.exec("ALTER TABLE person ADD COLUMN wiki_title TEXT");
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
  if (!personColsForPhotos.includes("photos_checked_at")) {
    try {
      db.exec("ALTER TABLE person ADD COLUMN photos_checked_at INTEGER");
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
  // "male"/"female"/"non_binary" — TMDb (gender 1/2/3, voir fetchPersonEntities/
  // fetchAndStoreMovieCredits) ou Wikidata (P21, voir fetchPersonRoleEntities/
  // fetchAndStoreCountryLeader) selon la source. Sert à désambiguïser les
  // libellés d'occupation/poste au double genre (voir degenderLabel) ET au
  // filtre "gender" (person/actor/director/painter/statesman, voir
  // syncGenderFilters dans refresh/util.js).
  if (!personColsForPhotos.includes("gender")) {
    try {
      db.exec("ALTER TABLE person ADD COLUMN gender TEXT");
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
  // notoriété musique (voir fetchMusicEntities) : contrairement à TMDb/IGDB,
  // iTunes ne donne aucun score de popularité — seul signal disponible, le
  // RANG dans un classement (1-100, position dans le flux RSS déjà
  // récupéré), converti en valeur croissante (101 - rang) pour rester
  // comparable au sens de storePopularityTiers (plus haut = plus populaire).
  // Meilleur rang gardé quand un morceau apparaît dans plusieurs classements
  // (pays différents).
  const musicTrackCols = db.prepare("PRAGMA table_info(music_track)").all().map((c) => c.name);
  if (!musicTrackCols.includes("popularity")) {
    try {
      db.exec("ALTER TABLE music_track ADD COLUMN popularity INTEGER");
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
  // rang de billing TMDb (cast.order) du crédit — alimente le filtre "billing"
  // (Tête d'affiche/Second couteau, voir syncActorBillingFromMovieCast).
  const movieCastCols = db.prepare("PRAGMA table_info(movie_cast)").all().map((c) => c.name);
  if (!movieCastCols.includes("cast_order")) {
    try {
      db.exec("ALTER TABLE movie_cast ADD COLUMN cast_order INTEGER");
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
