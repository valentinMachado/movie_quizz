import { db, TTL_MS, isFresh } from "./connection.js";
import { replaceImages, getImages, imagesFetchedAt } from "./images.js";

// ---------- person (acteurs TMDb + peintres Wikidata + réalisateurs TMDb) ----------

// upsert par (source, external_id) : crée ou met à jour nom/images, ne touche
// jamais birthday/place_of_birth/paintings (gérés séparément, TTL propre).
// summary/positionHeld/specificOccupation : résumé Wikipédia FR + poste
// occupé (P39) + métier précis (P106), connus uniquement des rôles "person"
// Wikidata (voir fetchPersonRoleEntities) — restent null pour un acteur/
// réalisateur TMDb, comme portraitImageUrl reste null pour eux. nationality
// (démonyme FR) est la seule des 4 posée par les DEUX sources (TMDb via
// setPersonBirthday, Wikidata ici).
export function upsertPerson({
  source,
  externalId,
  name,
  profileImageUrl = null,
  portraitImageUrl = null,
  popularity = null,
  summary = null,
  positionHeld = null,
  specificOccupation = null,
  nationality = null,
  wikiTitle = null,
  gender = null,
}) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO person (source, external_id, name, profile_image_url, portrait_image_url, popularity, summary, position_held, specific_occupation, nationality, wiki_title, gender, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, external_id) DO UPDATE SET
       name = excluded.name,
       profile_image_url = COALESCE(excluded.profile_image_url, person.profile_image_url),
       portrait_image_url = COALESCE(excluded.portrait_image_url, person.portrait_image_url),
       popularity = COALESCE(excluded.popularity, person.popularity),
       summary = COALESCE(excluded.summary, person.summary),
       position_held = COALESCE(excluded.position_held, person.position_held),
       specific_occupation = COALESCE(excluded.specific_occupation, person.specific_occupation),
       nationality = COALESCE(excluded.nationality, person.nationality),
       wiki_title = COALESCE(excluded.wiki_title, person.wiki_title),
       gender = COALESCE(excluded.gender, person.gender),
       updated_at = excluded.updated_at`,
  ).run(
    source,
    externalId,
    name,
    profileImageUrl,
    portraitImageUrl,
    popularity,
    summary,
    positionHeld,
    specificOccupation,
    nationality,
    wikiTitle,
    gender,
    now,
  );
  return db
    .prepare("SELECT id FROM person WHERE source = ? AND external_id = ?")
    .get(source, externalId).id;
}

// popularité déjà persistée pour un lot de person.id — utilisé par
// storePopularityTiers("person", ...) : les acteurs sont upsertés par deux
// sources indépendantes (voir fetchPersonEntities), pas de tableau en
// mémoire prêt à l'emploi à la fin du crawl.
export function getPersonPopularity(ids) {
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT id, popularity FROM person WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids);
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

// nombre d'œuvres connues par peintre, en une requête — sert à distinguer un
// vrai peintre d'une personne dont Wikidata liste « peintre » parmi les
// occupations sans lui connaître le moindre tableau (voir
// PAINTER_MIN_ARTWORKS dans typeItem.js).
export function painterArtworkCounts() {
  return new Map(
    db
      .prepare("SELECT painter_id, COUNT(*) AS n FROM painting GROUP BY painter_id")
      .all()
      .map((r) => [r.painter_id, r.n]),
  );
}

// portrait Wikidata unique (voir fetchPersonRoleEntities/fetchPainterEntities)
// : trop peu pour bien remplir un questionType "image" à plusieurs frames,
// contrairement à un acteur TMDb (plusieurs profils, voir "Personnes TMDb (images)"
// ci-dessus). Ce TTL gate le warmLoop "Personnes Wikidata (photos)" qui va
// chercher des photos supplémentaires sur l'article Wikipédia FR déjà résolu
// (person.wiki_title) plutôt que de se contenter du seul portrait.
export function personNeedsWikiPhotos(person) {
  return !isFresh(person.photos_checked_at, TTL_MS.mediaImage);
}

export function markPersonPhotosChecked(personId) {
  db.prepare("UPDATE person SET photos_checked_at = ? WHERE id = ?").run(
    Date.now(),
    personId,
  );
}

export function personNeedsBirthday(person) {
  return !isFresh(person.birthday_checked_at, TTL_MS.personBirthday);
}

// birthday/place_of_birth + biography (API détail TMDb "/person/{id}") —
// beaucoup de personnes n'ont simplement pas cette date connue de TMDb
// (birthday peut rester null indéfiniment) ; birthday_checked_at avance
// quand même pour ne pas retenter cette personne avant le TTL. biography est
// souvent vide en fr-FR (TMDb n'a pas toujours de traduction) : COALESCE
// pour ne jamais écraser un summary déjà là (ex. Wikidata pour un rôle
// "person", voir upsertPerson) par un vide. nationality (démonyme FR, dérivé
// de placeOfBirth côté appelant — voir fetchAndStorePersonDetails dans
// refresh/tmdb.js) même COALESCE, pour la même raison.
export function setPersonBirthday(personId, birthday, placeOfBirth, biography, nationality) {
  db.prepare(
    `UPDATE person SET birthday = ?, place_of_birth = ?, summary = COALESCE(?, summary), nationality = COALESCE(?, nationality), birthday_checked_at = ?
     WHERE id = ?`,
  ).run(
    birthday || null,
    placeOfBirth || null,
    biography || null,
    nationality || null,
    Date.now(),
    personId,
  );
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

// même principe qu'addDirectorFilmography ci-dessus, pour le quiz "acteur"
// (voir refresh.js/warmLoop "Acteurs (filmographie complète)") — movie_cast
// au lieu de movie_director, même lien additif (INSERT OR IGNORE) pour ne
// jamais écraser ce que setMovieCast a déjà posé plus précisément.
// filmography_checked_at est partagé avec addDirectorFilmography (même
// appel réseau /person/{id}/movie_credits, voir fetchAndStoreFilmography) :
// une personne à la fois acteur et réalisateur n'est jamais fetchée deux fois.
export function addActorFilmography(personId, movies) {
  const now = Date.now();
  const upsertMovie = db.prepare(
    `INSERT INTO movie (id, title, poster_path, overview, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, poster_path = excluded.poster_path,
       overview = excluded.overview, updated_at = excluded.updated_at`,
  );
  const link = db.prepare(
    "INSERT OR IGNORE INTO movie_cast (movie_id, person_id, cast_order) VALUES (?, ?, ?)",
  );
  const tx = db.transaction((items) => {
    for (const m of items) {
      upsertMovie.run(m.id, m.title, m.posterPath, m.overview || "", now);
      link.run(m.id, personId, m.order ?? null);
    }
    db.prepare("UPDATE person SET filmography_checked_at = ? WHERE id = ?").run(
      now,
      personId,
    );
  });
  tx(movies);
}

export const replacePersonImages = (personId, images) =>
  replaceImages("person_image", "person_id", personId, images);
export const getPersonImages = (personId) =>
  getImages("person_image", "person_id", personId);
export const personImagesFetchedAt = (personId) =>
  imagesFetchedAt("person_image", "person_id", personId);
