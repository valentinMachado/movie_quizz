import { db, TTL_MS, isFresh } from "./connection.js";
import { replaceImages, getImages, imagesFetchedAt } from "./images.js";
import { upsertPerson } from "./person.js";
import { addTypeItems } from "./typeItem.js";
import { upsertFilters, replaceEntityFilters } from "./filters.js";

// ---------- movie ----------

export function upsertMovies(rows) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO movie (id, title, poster_path, overview, release_date, popularity, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, poster_path = excluded.poster_path,
       overview = excluded.overview, release_date = excluded.release_date,
       popularity = excluded.popularity, updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((items) => {
    for (const m of items)
      insert.run(m.id, m.title, m.posterPath, m.overview || "", m.releaseDate || null, m.popularity ?? null, now);
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
        popularity: d.popularity ?? null,
        gender: d.gender ?? null,
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

// casting (top MOVIE_CAST_LIMIT par ordre de billing TMDb, déjà tronqué par
// l'appelant) + jointure movie_cast — même appel réseau que setMovieDirectors
// (réponse /movie/{id}/credits, cast ET crew), pas de colonne checked_at
// propre : la fraîcheur reste gérée par movie.directors_checked_at, mis à
// jour par setMovieDirectors juste à côté dans fetchAndStoreMovieCredits.
export function setMovieCast(movieId, cast) {
  const tx = db.transaction((people) => {
    db.prepare("DELETE FROM movie_cast WHERE movie_id = ?").run(movieId);
    const link = db.prepare(
      "INSERT OR IGNORE INTO movie_cast (movie_id, person_id, cast_order) VALUES (?, ?, ?)",
    );
    const personIds = [];
    for (const c of people) {
      const personId = upsertPerson({
        source: "tmdb",
        externalId: String(c.id),
        name: c.name,
        profileImageUrl: c.profilePath
          ? `https://image.tmdb.org/t/p/w500${c.profilePath}`
          : null,
        popularity: c.popularity ?? null,
        gender: c.gender ?? null,
      });
      link.run(movieId, personId, c.order ?? null);
      personIds.push(personId);
    }
    return personIds;
  });
  return tx(cast);
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

export const replaceMovieImages = (movieId, images) =>
  replaceImages("movie_image", "movie_id", movieId, images);
export const getMovieImages = (movieId) =>
  getImages("movie_image", "movie_id", movieId);
export const movieImagesFetchedAt = (movieId) =>
  imagesFetchedAt("movie_image", "movie_id", movieId);

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

// même principe que syncDirectorPoolFromMovieDirector, pour le pool "actor"
// (movie_cast) — même raison d'être (backfill pur SQL au démarrage).
export function syncActorPoolFromMovieCast() {
  const ids = db
    .prepare("SELECT DISTINCT person_id FROM movie_cast")
    .all()
    .map((r) => r.person_id);
  addTypeItems("actor", ids);
}

// filtre "billing" (Tête d'affiche / Second couteau), propre à "actor" (pas
// d'équivalent "director" : un film a peu de réalisateurs, pas de notion de
// rang) — vit au niveau du CRÉDIT (movie_cast.cast_order), pas du film
// lui-même ni de la personne (contrairement à "decennie"/"geographie", voir
// syncPersonDerivedBirthFilters dans refresh/tmdb.js, calculées depuis
// birthday/place_of_birth). PAS additif par crédit (essayé, puis abandonné :
// avec MOVIE_CAST_LIMIT=10 par film, quasi tout acteur a au moins un film où
// il n'est pas dans le top `leadCastLimit`, donc "second_couteau" finissait
// par matcher ~80% du pool, y compris des acteurs par ailleurs tête
// d'affiche — voir échange avec l'utilisateur). Un seul code par acteur à la
// place, basé sur sa moyenne de cast_order toutes filmographies confondues :
// classification mutuellement exclusive (replaceEntityFilters), plus
// discriminante qu'un simple "a déjà été/n'a jamais été". `leadCastLimit`
// passé en paramètre (pas importé depuis refresh/config.js) pour ne pas
// faire dépendre ce module core de la couche refresh — voir l'appelant dans
// refresh.js.
export function syncActorBillingFromMovieCast(leadCastLimit) {
  const rows = db
    .prepare(
      "SELECT person_id AS personId, cast_order AS castOrder FROM movie_cast WHERE cast_order IS NOT NULL",
    )
    .all();

  const statsByPerson = new Map(); // personId -> { sum, count }
  for (const r of rows) {
    const stats = statsByPerson.get(r.personId) ?? { sum: 0, count: 0 };
    stats.sum += r.castOrder;
    stats.count += 1;
    statsByPerson.set(r.personId, stats);
  }

  upsertFilters("actor", "billing", [
    { code: "tete_affiche", name: "Tête d'affiche" },
    { code: "second_couteau", name: "Second couteau" },
  ]);
  replaceEntityFilters(
    "actor",
    "billing",
    [...statsByPerson].map(([entityId, { sum, count }]) => ({
      entityId,
      codes: [sum / count < leadCastLimit ? "tete_affiche" : "second_couteau"],
    })),
  );
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

// même principe que getDirectorMoviePosters ci-dessus mais pour le mode
// "deviner le réalisateur via le summary" (questionType "summary") :
// overview déjà présent sur movie, y compris pour les films ajoutés
// uniquement via la filmographie complétée (voir addDirectorFilmography).
export function getDirectorMovieSummaries(personId) {
  return db
    .prepare(
      `SELECT m.title AS title, m.overview AS overview FROM movie_director md
       JOIN movie m ON m.id = md.movie_id
       WHERE md.person_id = ? AND m.overview IS NOT NULL AND m.overview != ''`,
    )
    .all(personId);
}

// même principe que getDirectorMoviePosters, pour le quiz "acteur" (deviner
// le nom à partir des affiches des films où il a joué, pas de sa propre
// photo) — movie_cast au lieu de movie_director.
export function getActorMoviePosters(personId) {
  return db
    .prepare(
      `SELECT m.title AS title, m.poster_path AS posterPath FROM movie_cast mc
       JOIN movie m ON m.id = mc.movie_id
       WHERE mc.person_id = ? AND m.poster_path IS NOT NULL`,
    )
    .all(personId);
}

// même principe que getDirectorMovieSummaries, pour questionType "summary"
// du quiz "acteur".
export function getActorMovieSummaries(personId) {
  return db
    .prepare(
      `SELECT m.title AS title, m.overview AS overview FROM movie_cast mc
       JOIN movie m ON m.id = mc.movie_id
       WHERE mc.person_id = ? AND m.overview IS NOT NULL AND m.overview != ''`,
    )
    .all(personId);
}
