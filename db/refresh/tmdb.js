import * as db from "../index.js";
import { logWarn, logInfo, logDebug } from "./log.js";
import { fetchExtractsByTitles } from "./wikipedia.js";
import {
  CONFIG,
  TMDB_KEY,
  CATEGORY_FETCH_CONCURRENCY,
  PAGE_FETCH_CONCURRENCY,
  capPages,
  STATIC_LISTS,
  DECADE_LISTS,
  MOVIE_CAST_LIMIT,
  TV_STATIC_LISTS,
  TV_DECADE_LISTS,
  PERSON_STATIC_LISTS,
  COUNTRY_TARGETS,
  MOVIE_COUNTRY_PAGES,
  TV_COUNTRY_PAGES,
  COUNTRY_FILTERS,
  PERSON_COUNTRY_MOVIE_PAGES,
  PERSON_COUNTRY_CAST_PER_MOVIE,
  PERSON_COUNTRY_TARGET_ACTORS,
  TV_TARGET_EPISODES_PER_SHOW,
  PERSON_BIRTH_DECADES,
} from "./config.js";
import {
  mapWithConcurrency,
  tagFilter,
  withFilterCodes,
  storeFilterGroup,
  storePopularityTiers,
  storeTertilePopularityTiers,
  popularIdsFrom,
} from "./util.js";

// throttle global : reste sous ~38 requêtes / 10s, marge sous la limite
// habituelle de TMDb (40-50/10s), s'applique à TOUS les appels TMDb.
let lastTmdbCallTs = 0;
let tmdbGateQueue = Promise.resolve();
const TMDB_MIN_INTERVAL_MS = 260;

function tmdbGate() {
  const turn = tmdbGateQueue.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastTmdbCallTs + TMDB_MIN_INTERVAL_MS - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastTmdbCallTs = Date.now();
  });
  tmdbGateQueue = turn;
  return turn;
}

export async function tmdbJSON(url, attempt = 1) {
  await tmdbGate();
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDb ${res.status} sur ${url}`);
    return await res.json();
  } catch (e) {
    const cause = e.cause
      ? ` (${e.cause.code || e.cause.message || e.cause})`
      : "";
    if (attempt < 3) {
      const delay = 500 * attempt;
      logDebug(
        `TMDb échec réseau${cause}, retry ${attempt}/2 dans ${delay}ms…`,
      );
      await new Promise((r) => setTimeout(r, delay));
      return tmdbJSON(url, attempt + 1);
    }
    e.message = `${e.message}${cause}`;
    throw e;
  }
}

function urlFor(pathAndQuery, page) {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  return `https://api.themoviedb.org/3/${pathAndQuery}${sep}api_key=${TMDB_KEY}&language=fr-FR&page=${page}`;
}

// fetch générique "liste TMDb paginée", partagé par movie/tv/person : fusionne
// plusieurs sources (listes statiques + décennies + genres + pays) en un seul
// pool dédupliqué par id — une source qui échoue (réseau) est journalisée et
// ignorée plutôt que de faire perdre tout le pool. `filterTagsByItemId`
// trace, indépendamment de la dédup du pool, TOUS les groupes de filtre (voir
// withFilterCodes) où chaque item est apparu — un item peut accumuler des
// tags de PLUSIEURS groupes dans le même crawl (liste ET decennie ET
// geographie), et un item déjà vu via une source sans filterGroup doit quand
// même accumuler les tags des sources taguées rencontrées ensuite, d'où le
// tracking séparé de `seen`.
export async function fetchTmdbListPool(sources, type) {
  const seen = new Map();
  const filterTagsByItemId = new Map();
  let sourcesDone = 0;
  const startTs = Date.now();
  await mapWithConcurrency(sources, CATEGORY_FETCH_CONCURRENCY, async (src) => {
    const pages = Array.from({ length: capPages(src.pages) }, (_, i) => i + 1);
    await mapWithConcurrency(pages, PAGE_FETCH_CONCURRENCY, async (page) => {
      try {
        const data = await tmdbJSON(urlFor(src.pathAndQuery, page));
        for (const m of data.results || []) {
          const valid =
            type === "person"
              ? Boolean(m.profile_path)
              : Boolean(m.backdrop_path) && Boolean(m.poster_path);
          if (!valid) continue;
          if (!seen.has(m.id)) seen.set(m.id, m);
          tagFilter(filterTagsByItemId, m.id, src.filterGroup, src.filterCode);
        }
      } catch (e) {
        logWarn(`Erreur source TMDb "${src.pathAndQuery}":`, e.message);
      }
    });
    sourcesDone++;
    // repère visible que le crawl avance pendant les dizaines de secondes
    // qu'un type peut prendre (sinon rien entre "Types : X à récupérer" et
    // le résumé final) — un compteur par source suffit, pas besoin du détail
    // par page ici.
    logInfo(
      `${type} : source ${sourcesDone}/${sources.length} (${src.pathAndQuery}) — ${seen.size} items cumulés (${((Date.now() - startTs) / 1000).toFixed(1)}s)`,
    );
  });
  return { items: [...seen.values()], filterTagsByItemId };
}

// TMDb (film/série) inclut déjà `genre_ids` sur chaque item des endpoints
// liste/discover — un seul appel à /genre/{kind}/list donne les noms, pas
// besoin d'appel réseau supplémentaire par film/série pour les genres.
async function fetchTmdbGenres(kind) {
  try {
    const data = await tmdbJSON(
      `https://api.themoviedb.org/3/genre/${kind}/list?api_key=${TMDB_KEY}&language=fr-FR`,
    );
    return data.genres || [];
  } catch (e) {
    logWarn(`Erreur récupération des genres ${kind}:`, e.message);
    return [];
  }
}

// stocke les genres connus (upsertFilters groupe "genre") puis associe, pour
// chaque item TMDb (qui porte `genre_ids`), les genres reconnus dans
// `genres` — un item peut n'en avoir aucun (genre trop récent/absent de la
// liste) ou plusieurs. Extraction directe du champ embarqué, pas de
// source-tracking (voir withFilterCodes) : chaque item porte déjà ses
// genre_ids quelle que soit la source qui l'a trouvé, donc couverture
// complète contrairement à liste/decennie/geographie.
function storeTmdbGenres(type, genres, items) {
  if (genres.length === 0) return;
  db.upsertFilters(
    type,
    "genre",
    genres.map((g) => ({ code: String(g.id), name: g.name })),
  );
  const knownIds = new Set(genres.map((g) => g.id));
  db.replaceEntityFilters(
    type,
    "genre",
    items.map((item) => ({
      entityId: item.id,
      codes: (item.genre_ids || [])
        .filter((id) => knownIds.has(id))
        .map(String),
    })),
  );
}

function movieGenreSources(genres) {
  return genres.map((g) => ({
    pathAndQuery: `discover/movie?with_genres=${g.id}&sort_by=popularity.desc`,
    pages: CONFIG.movie.genrePages,
  }));
}

// tague chaque source pays avec { filterGroup: "geographie", filterCode }
// pour que fetchTmdbListPool trace quel(s) pays cible(nt) chaque film — sans
// ça, l'appartenance géographique d'un film (qui a réellement matché
// with_origin_country=XX) serait perdue après la fusion des sources.
function movieCountrySources() {
  return COUNTRY_TARGETS.map((target) => ({
    pathAndQuery: `discover/movie?with_origin_country=${target.code.toUpperCase()}&sort_by=popularity.desc`,
    pages: MOVIE_COUNTRY_PAGES,
    filterGroup: "geographie",
    filterCode: target.code,
  }));
}

export async function fetchMovieEntities() {
  const genres = await fetchTmdbGenres("movie");
  const sources = [
    ...withFilterCodes(STATIC_LISTS, "liste"),
    ...withFilterCodes(DECADE_LISTS, "decennie"),
    ...movieGenreSources(genres),
    ...movieCountrySources(),
  ];
  const { items, filterTagsByItemId } = await fetchTmdbListPool(sources, "movie");
  const rows = items.map((m) => ({
    id: m.id,
    title: m.title,
    posterPath: m.poster_path,
    overview: m.overview,
    releaseDate: m.release_date,
    popularity: m.popularity ?? null,
  }));
  db.upsertMovies(rows);
  db.replaceTypeItems(
    "movie",
    rows.map((r) => r.id),
  );
  storeTmdbGenres("movie", genres, items);
  storeFilterGroup("movie", "liste", STATIC_LISTS, items, filterTagsByItemId);
  storeFilterGroup("movie", "decennie", DECADE_LISTS, items, filterTagsByItemId);
  storeFilterGroup("movie", "geographie", COUNTRY_FILTERS, items, filterTagsByItemId);
  storePopularityTiers(
    "movie",
    items.map((m) => ({ entityId: m.id, value: m.popularity ?? null })),
    popularIdsFrom(items, filterTagsByItemId, "popular"),
  );
}

// pendant léger de fetchMovieEntities : ne retouche que les listes (Populaire/
// Tendances), sans redemander décennies/genres/pays — cadence bien plus
// courte (voir TTL_MS.listPool), donnée qui change réellement d'un jour à
// l'autre contrairement au reste (voir TYPES.movie.refreshLists).
export async function refreshMovieLists() {
  const { items, filterTagsByItemId } = await fetchTmdbListPool(
    withFilterCodes(STATIC_LISTS, "liste"),
    "movie",
  );
  const rows = items.map((m) => ({
    id: m.id,
    title: m.title,
    posterPath: m.poster_path,
    overview: m.overview,
    releaseDate: m.release_date,
  }));
  db.upsertMovies(rows);
  storeFilterGroup("movie", "liste", STATIC_LISTS, items, filterTagsByItemId);
}

function tvGenreSources(genres) {
  return genres.map((g) => ({
    pathAndQuery: `discover/tv?with_genres=${g.id}&sort_by=popularity.desc`,
    pages: CONFIG.tv.genrePages,
  }));
}

// tague chaque source pays avec { filterGroup: "geographie", filterCode },
// même mécanique que movieCountrySources (voir ce commentaire) mais sur
// discover/tv?with_origin_country=XX.
function tvCountrySources() {
  return COUNTRY_TARGETS.map((target) => ({
    pathAndQuery: `discover/tv?with_origin_country=${target.code.toUpperCase()}&sort_by=popularity.desc`,
    pages: TV_COUNTRY_PAGES,
    filterGroup: "geographie",
    filterCode: target.code,
  }));
}

export async function fetchTvEntities() {
  const genres = await fetchTmdbGenres("tv");
  const sources = [
    ...withFilterCodes(TV_STATIC_LISTS, "liste"),
    ...withFilterCodes(TV_DECADE_LISTS, "decennie"),
    ...tvGenreSources(genres),
    ...tvCountrySources(),
  ];
  const { items, filterTagsByItemId } = await fetchTmdbListPool(sources, "tv");
  const rows = items.map((t) => ({
    id: t.id,
    title: t.name,
    posterPath: t.poster_path,
    overview: t.overview,
    popularity: t.popularity ?? null,
  }));
  db.upsertTvShows(rows);
  db.replaceTypeItems(
    "tv",
    rows.map((r) => r.id),
  );
  storeTmdbGenres("tv", genres, items);
  storeFilterGroup("tv", "liste", TV_STATIC_LISTS, items, filterTagsByItemId);
  storeFilterGroup("tv", "decennie", TV_DECADE_LISTS, items, filterTagsByItemId);
  storeFilterGroup("tv", "geographie", COUNTRY_FILTERS, items, filterTagsByItemId);
  storePopularityTiers(
    "tv",
    items.map((t) => ({ entityId: t.id, value: t.popularity ?? null })),
    popularIdsFrom(items, filterTagsByItemId, "tv_popular"),
  );
}

// pendant léger de fetchTvEntities (voir refreshMovieLists ci-dessus).
export async function refreshTvLists() {
  const { items, filterTagsByItemId } = await fetchTmdbListPool(
    withFilterCodes(TV_STATIC_LISTS, "liste"),
    "tv",
  );
  const rows = items.map((t) => ({
    id: t.id,
    title: t.name,
    posterPath: t.poster_path,
    overview: t.overview,
  }));
  db.upsertTvShows(rows);
  storeFilterGroup("tv", "liste", TV_STATIC_LISTS, items, filterTagsByItemId);
}

// pool d'acteurs pour un pays donné : part des films populaires DE ce pays
// (discover/movie?with_origin_country=XX) plutôt que de filtrer une liste
// globale par lieu de naissance (mélangerait nationalité et lieu de naissance).
async function fetchPersonCountryActors(originCountry) {
  const movieIds = [];
  const moviePages = Array.from(
    { length: capPages(PERSON_COUNTRY_MOVIE_PAGES) },
    (_, i) => i + 1,
  );
  await mapWithConcurrency(moviePages, PAGE_FETCH_CONCURRENCY, async (page) => {
    try {
      const data = await tmdbJSON(
        `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&language=fr-FR&sort_by=popularity.desc&with_origin_country=${originCountry}&page=${page}`,
      );
      for (const m of data.results || []) movieIds.push(m.id);
    } catch (e) {
      logWarn(`Erreur discover pays "${originCountry}":`, e.message);
    }
  });

  const surrogateIds = new Set();
  await mapWithConcurrency(
    movieIds,
    PAGE_FETCH_CONCURRENCY,
    async (movieId) => {
      if (surrogateIds.size >= PERSON_COUNTRY_TARGET_ACTORS) return;
      try {
        const data = await tmdbJSON(
          `https://api.themoviedb.org/3/movie/${movieId}/credits?api_key=${TMDB_KEY}&language=fr-FR`,
        );
        for (const c of (data.cast || []).slice(
          0,
          PERSON_COUNTRY_CAST_PER_MOVIE,
        )) {
          if (!c.profile_path) continue;
          const personId = db.upsertPerson({
            source: "tmdb",
            externalId: String(c.id),
            name: c.name,
            profileImageUrl: `https://image.tmdb.org/t/p/w500${c.profile_path}`,
            popularity: c.popularity ?? null,
          });
          surrogateIds.add(personId);
        }
      } catch (e) {
        // un film sans crédits accessibles ne doit pas faire échouer tout le pool
      }
    },
  );
  return surrogateIds;
}

export async function fetchPersonEntities() {
  const { items: popular } = await fetchTmdbListPool(
    Object.values(PERSON_STATIC_LISTS),
    "person",
  );
  const popularIds = new Set(
    popular.map((p) =>
      db.upsertPerson({
        source: "tmdb",
        externalId: String(p.id),
        name: p.name,
        profileImageUrl: `https://image.tmdb.org/t/p/w500${p.profile_path}`,
        popularity: p.popularity ?? null,
      }),
    ),
  );
  const surrogateIds = new Set(popularIds);
  await mapWithConcurrency(
    COUNTRY_TARGETS,
    CATEGORY_FETCH_CONCURRENCY,
    async (target) => {
      const countryIds = await fetchPersonCountryActors(
        target.code.toUpperCase(),
      );
      for (const id of countryIds) surrogateIds.add(id);
    },
  );
  // additif (pas replaceTypeItems) : "person" est alimenté par plusieurs
  // sources indépendantes (acteurs ici, réalisateurs et peintres ailleurs,
  // voir db.addTypeItems) qui n'ont chacune connaissance que de leur propre
  // contribution.
  const ids = [...surrogateIds];
  db.addTypeItems("person", ids);
  db.upsertFilters("person", "role", [{ code: "actor", name: "Acteur" }]);
  db.addEntityFilters(
    "person",
    "role",
    ids.map((id) => ({ entityId: id, codes: ["actor"] })),
  );
  // "Populaire" (source person_popular, comme movie/tv/game) : replaceEntityFilters
  // (pas addEntityFilters) sur TOUT `ids` pour bien retirer le tag d'un
  // acteur qui ne serait plus dans person_popular à un crawl suivant.
  db.upsertFilters("person", "liste", [
    { code: "person_popular", name: "Populaire" },
  ]);
  db.replaceEntityFilters(
    "person",
    "liste",
    ids.map((id) => ({
      entityId: id,
      codes: popularIds.has(id) ? ["person_popular"] : [],
    })),
  );
  storePopularityTiers(
    "person",
    db.getPersonPopularity(ids).map((p) => ({ entityId: p.id, value: p.popularity })),
    popularIds,
  );
}

// ---------- warmLoops "images" : remplacent l'ancien fetch à la demande ----------
//
// toutes les fonctions ci-dessous renvoient/stockent un format uniforme :
// { url, iso_639_1, vote_count, aspect_ratio } — quelle que soit la source.
//
// "textless" (iso_639_1 === null, backdrop sans titre/texte incrusté) est
// une notion TMDb, décidée ICI à l'écriture — pas côté server.js à la
// lecture, qui ne doit avoir qu'à demander "les images de ce film" et
// recevoir directement des images utilisables. TV (fetchAndStoreTvImages,
// plus bas) applique déjà ce filtre à l'écriture ; movie/person l'ont
// rejoint ici pour rester cohérents entre eux.

export async function fetchAndStoreMovieImages(movie) {
  const data = await tmdbJSON(
    `https://api.themoviedb.org/3/movie/${movie.id}/images?api_key=${TMDB_KEY}`,
  );
  const backdrops = (data.backdrops || [])
    .filter((b) => b.file_path && b.iso_639_1 === null)
    .map((b) => ({
      url: `https://image.tmdb.org/t/p/w1280${b.file_path}`,
      iso_639_1: b.iso_639_1,
      vote_count: b.vote_count,
      aspect_ratio: b.aspect_ratio,
    }));
  db.replaceMovieImages(movie.id, backdrops);
}

export async function fetchAndStorePersonImages(person) {
  const data = await tmdbJSON(
    `https://api.themoviedb.org/3/person/${person.external_id}/images?api_key=${TMDB_KEY}`,
  );
  const profiles = (data.profiles || [])
    .filter((b) => b.file_path && b.iso_639_1 === null)
    .map((b) => ({
      url: `https://image.tmdb.org/t/p/w1280${b.file_path}`,
      iso_639_1: b.iso_639_1,
      vote_count: b.vote_count,
      aspect_ratio: b.aspect_ratio,
    }));
  db.replacePersonImages(person.id, profiles);
}

// séries TV : on devine à partir d'images D'ÉPISODE, jamais des visuels
// globaux de la série (pas de fallback show-level ici, contrairement à
// movie/person — voir db.getTvShowImages côté server.js). Pour varier les
// captures d'écran d'une partie à l'autre sans jamais fetcher à la demande,
// on chauffe progressivement jusqu'à TV_TARGET_EPISODES_PER_SHOW épisodes
// aléatoires par série — un de plus par passage tant que la cible n'est pas
// atteinte (pas tout d'un coup : trop coûteux sur des milliers de séries).
// Une série sans aucun épisode encore chauffé n'a donc aucune image
// utilisable et est exclue du quiz jusqu'à son premier passage ici — même
// comportement que n'importe quel autre type sans image en base.
export function tvShowNeedsWarming(show) {
  if (db.cacheGet(`tv_fully_warmed:${show.id}`)) return false;
  return db.getTvWarmedEpisodes(show.id).length < TV_TARGET_EPISODES_PER_SHOW;
}

export async function fetchAndStoreTvImages(show) {
  const fullyWarmedKey = `tv_fully_warmed:${show.id}`;
  if (db.cacheGet(fullyWarmedKey)) return;
  if (db.getTvWarmedEpisodes(show.id).length >= TV_TARGET_EPISODES_PER_SHOW)
    return;

  // index saisons/épisodes : cache générique TTL par défaut (6h, voir
  // db.TTL_MS.default), même clés que l'ancien fetch à la demande.
  const showKey = `tvshow:${show.id}`;
  let seasons = db.cacheGet(showKey);
  if (!seasons) {
    const showData = await tmdbJSON(
      `https://api.themoviedb.org/3/tv/${show.id}?api_key=${TMDB_KEY}`,
    );
    seasons = (showData.seasons || []).filter(
      (s) => s.season_number > 0 && s.episode_count > 0,
    );
    db.cacheSet(showKey, seasons);
  }

  const candidates = [];
  for (const season of seasons) {
    const seasonKey = `tvseason:${show.id}:${season.season_number}`;
    let episodeNumbers = db.cacheGet(seasonKey);
    if (!episodeNumbers) {
      const seasonData = await tmdbJSON(
        `https://api.themoviedb.org/3/tv/${show.id}/season/${season.season_number}?api_key=${TMDB_KEY}`,
      );
      episodeNumbers = (seasonData.episodes || []).map((e) => e.episode_number);
      db.cacheSet(seasonKey, episodeNumbers);
    }
    for (const ep of episodeNumbers) {
      if (
        !db.cacheGet(
          `tv_episode_checked:${show.id}:${season.season_number}:${ep}`,
        )
      ) {
        candidates.push([season.season_number, ep]);
      }
    }
  }

  if (candidates.length === 0) {
    db.cacheSet(fullyWarmedKey, true, db.TTL_MS.mediaImage);
    return;
  }

  const [seasonNumber, episodeNumber] =
    candidates[Math.floor(Math.random() * candidates.length)];
  const epData = await tmdbJSON(
    `https://api.themoviedb.org/3/tv/${show.id}/season/${seasonNumber}/episode/${episodeNumber}/images?api_key=${TMDB_KEY}`,
  );
  const stills = (epData.stills || [])
    .filter((s) => s.file_path)
    .map((s) => ({
      url: `https://image.tmdb.org/t/p/w1280${s.file_path}`,
      iso_639_1: s.iso_639_1,
      vote_count: s.vote_count,
      aspect_ratio: s.aspect_ratio,
    }));
  const textless = stills.filter((s) => s.iso_639_1 === null);
  if (textless.length > 0)
    db.addTvImages(show.id, seasonNumber, episodeNumber, textless);
  // marqué "vérifié" même si 0 still textless, pour ne pas retester le même
  // épisode à chaque passage.
  db.cacheSet(
    `tv_episode_checked:${show.id}:${seasonNumber}:${episodeNumber}`,
    true,
    db.TTL_MS.mediaImage,
  );
}

// warmLoop "Films (crédits)" : crédits TMDb du FILM (contrairement à
// fetchAndStoreFilmography ci-dessous qui part des crédits DE LA PERSONNE) —
// upsert le(s) réalisateur(s) ET le casting (même réponse /credits, cast ET
// crew, aucun appel réseau de plus), les ajoute à leurs pools respectifs
// ("person"/"director" pour un réalisateur, "actor" seul pour le casting —
// voir plus bas pourquoi). Pas de propagation des tags genre/décennie/
// geographie DU FILM vers son réalisateur/casting (essayé, puis abandonné :
// un acteur qui tourne un film d'action des années 30 n'est pas pour autant
// né dans les années 30 — voir syncPersonDerivedBirthFilters plus bas, qui
// calcule "decennie"/"geographie" depuis les propres birthday/place_of_birth
// de la personne à la place ; "genre" n'a simplement pas d'équivalent pour
// un réalisateur/acteur et n'existe donc plus du tout pour ces deux types).
export async function fetchAndStoreMovieCredits(movie) {
  const data = await tmdbJSON(
    `https://api.themoviedb.org/3/movie/${movie.id}/credits?api_key=${TMDB_KEY}&language=fr-FR`,
  );
  const directors = (data.crew || [])
    .filter((c) => c.job === "Director")
    .map((d) => ({
      id: d.id,
      name: d.name,
      profilePath: d.profile_path,
      popularity: d.popularity,
    }));
  // top MOVIE_CAST_LIMIT par ordre de billing TMDb (déjà l'ordre du tableau
  // "cast") : au-delà, des rôles trop secondaires pour être devinables à
  // partir d'une affiche/résumé (voir échange avec l'utilisateur). `order`
  // (rang de billing natif TMDb) alimente le filtre "billing" (Tête
  // d'affiche/Second couteau, voir syncActorBillingFromMovieCast).
  const cast = (data.cast || [])
    .slice(0, MOVIE_CAST_LIMIT)
    .map((c) => ({
      id: c.id,
      name: c.name,
      profilePath: c.profile_path,
      popularity: c.popularity,
      order: c.order,
    }));

  const directorIds = db.setMovieDirectors(movie.id, directors);
  const castIds = db.setMovieCast(movie.id, cast);
  if (directorIds.length === 0 && castIds.length === 0) return;

  if (directorIds.length > 0) {
    // additif : découverte progressive film par film, ne doit pas
    // écraser ce que fetchPersonEntities/fetchPainterEntities ont
    // déjà posé sur "person" (voir db.addTypeItems).
    db.addTypeItems("person", directorIds);
    db.upsertFilters("person", "role", [
      { code: "director", name: "Réalisateur" },
    ]);
    db.addEntityFilters(
      "person",
      "role",
      directorIds.map((id) => ({ entityId: id, codes: ["director"] })),
    );
    // pool dédié au quiz "réalisateur" (deviner le nom à partir des
    // affiches de ses films, voir server.js/materializeDirectorRow)
    // — même personnes que ci-dessus mais sous un type distinct
    // (type_item "director"), sinon un même id TMDb entrerait en
    // collision entre les deux quiz s'ils étaient sélectionnés
    // ensemble (voir server.js/DIRECTOR_ID_OFFSET).
    db.addTypeItems("director", directorIds);
  }

  if (castIds.length > 0) {
    // PAS de db.addTypeItems("person", castIds) ici, contrairement au
    // réalisateur ci-dessus : le casting n'alimente que le pool "actor"
    // autonome (quiz filmographie via affiches/résumés, voir
    // server.js/materializeActorRow) — le pool "person"/role="actor" (photo/
    // bio DE l'acteur) reste alimenté séparément par fetchPersonEntities,
    // volontairement pas étendu à tout le casting croisé ici (hors scope).
    db.addTypeItems("actor", castIds);
  }
}

// warmLoop "Personnes TMDb (anniversaire + bio)" : birthday/place_of_birth (quiz du
// jour "anniversaire", voir server.js/dailyPersonAnniversaryBucket) +
// biography, stockée dans person.summary pour alimenter person:summary
// (même colonne que les rôles Wikidata, voir db/person.js/setPersonBirthday).
// Priorité biography : TMDb fr-FR (déjà là, gratuit) > Wikipédia FR >
// Wikipédia EN > null — le repli Wikipédia cherche par NOM exact (pas de
// QID Wikidata connu pour un acteur TMDb), donc peut rater un homonyme ;
// sauté si un summary existe déjà (rien à gagner, voir setPersonBirthday).
export async function fetchAndStorePersonDetails(person) {
  const data = await tmdbJSON(
    `https://api.themoviedb.org/3/person/${person.external_id}?api_key=${TMDB_KEY}&language=fr-FR`,
  );
  let biography = data.biography || null;
  if (!biography && !person.summary) {
    const frExtracts = await fetchExtractsByTitles([person.name]);
    biography = frExtracts.get(person.name) || null;
  }
  if (!biography && !person.summary) {
    const enExtracts = await fetchExtractsByTitles([person.name], "en");
    biography = enExtracts.get(person.name) || null;
  }
  db.setPersonBirthday(person.id, data.birthday, data.place_of_birth, biography);
}

// warmLoops "Réalisateurs (filmographie complète)" / "Acteurs (filmographie
// complète)" : le pool "movie" est une sélection curated (popularité/genre/
// décennie/pays), pas la filmographie complète d'une personne — sans ce
// warmLoop, la plupart des réalisateurs/acteurs n'auraient que les quelques
// films déjà atterris dans le pool curated pour le quiz "deviner à partir de
// sa filmographie" (voir server.js/getDirectorMoviePosters,
// getActorMoviePosters). On complète ici via les crédits DE LA PERSONNE
// (TMDb person/movie_credits, cast ET crew en un seul appel), à l'inverse de
// fetchAndStoreMovieCredits ci-dessus qui part des crédits DU FILM — les deux
// warmLoops pointent vers cette même fonction (personNeedsFilmography/
// filmography_checked_at partagé, voir refresh.js) : une personne à la fois
// acteur et réalisateur n'est jamais fetchée deux fois.
export async function fetchAndStoreFilmography(person) {
  const data = await tmdbJSON(
    `https://api.themoviedb.org/3/person/${person.external_id}/movie_credits?api_key=${TMDB_KEY}&language=fr-FR`,
  );
  const directed = (data.crew || [])
    .filter((c) => c.job === "Director" && c.poster_path)
    .map((m) => ({
      id: m.id,
      title: m.title,
      posterPath: m.poster_path,
      overview: m.overview,
    }));
  db.addDirectorFilmography(person.id, directed);
  // même plafond top-billing que côté film (MOVIE_CAST_LIMIT, voir
  // fetchAndStoreMovieCredits) : cohérence de ce qui compte comme "assez en
  // vue pour deviner", même si ce rôle vient d'un film hors du pool curated.
  const acted = (data.cast || [])
    .filter((c) => c.poster_path && c.order != null && c.order < MOVIE_CAST_LIMIT)
    .map((m) => ({
      id: m.id,
      title: m.title,
      posterPath: m.poster_path,
      overview: m.overview,
      order: m.order,
    }));
  db.addActorFilmography(person.id, acted);
}

// filtre "liste" (Populaire/Niche/Obscur) pour director/actor — même
// mécanique que pour peintre/politicien (storeTertilePopularityTiers,
// 3 tertiles directs sur popularity, pas de liste "Populaire" éditoriale à
// exclure comme pour movie/tv/game/person-acteurs, voir storePopularityTiers).
// Pas de fetchEntities "crawl complet" unique pour director/actor (pool
// construit incrémentalement + sync SQL au démarrage, voir
// syncDirectorPoolFromMovieDirector) : recalculée à chaque démarrage de
// refresh.js sur le pool actuel plutôt que pendant un crawl.
export function syncPersonDerivedPopularityTiers() {
  storeTertilePopularityTiers(
    "director",
    db.getDirectorPool().map((p) => ({ entityId: p.id, value: p.popularity })),
  );
  storeTertilePopularityTiers(
    "actor",
    db.getActorPool().map((p) => ({ entityId: p.id, value: p.popularity })),
  );
}

// year extrait de person.birthday ("YYYY-MM-DD" TMDb) puis rangé dans le
// bucket dont [gte, lte] le couvre — un birthday absent ou hors de tout
// bucket laisse simplement l'entité sans code "decennie" (comme un article
// wiki sans date connue, voir decadeCodeForYear dans wikipedia.js).
function decadeCodeForBirthYear(year) {
  return (
    PERSON_BIRTH_DECADES.find((b) => year >= b.gte && year <= b.lte)?.code ??
    null
  );
}

// place_of_birth TMDb est un texte libre ("Los Angeles, California, USA",
// "Paris, France"...) — même heuristique que findGeoCode dans superhero.js :
// premier pays dont une sous-chaîne `match` apparaît dans le texte
// (insensible à la casse), testé dans l'ORDRE du tableau. "us" doit rester
// en tête (voir countryTargets dans config.json) car un nom d'état américain
// ("New Mexico", "Indiana") contient parfois le nom d'un autre pays de la
// liste ("Mexico", "India") en sous-chaîne.
function countryCodeForPlaceOfBirth(placeOfBirth) {
  if (!placeOfBirth) return null;
  const lower = placeOfBirth.toLowerCase();
  const country = COUNTRY_TARGETS.find((c) =>
    c.match?.some((m) => lower.includes(m.toLowerCase())),
  );
  return country ? country.code : null;
}

// filtres "decennie"/"geographie" pour director/actor, calculés depuis LEURS
// PROPRES birthday/place_of_birth (voir fetchAndStorePersonDetails) — pas
// propagés depuis les films qu'ils ont réalisés/joués (voir le commentaire
// sur fetchAndStoreMovieCredits). replaceEntityFilters (pas addEntityFilters)
// car birthday/place_of_birth sont la seule source de vérité pour ces deux
// groupes sur ces deux types : un birthday corrigé plus tard ne doit pas
// laisser un ancien code orphelin. Même convention que
// syncPersonDerivedPopularityTiers ci-dessus : recalculée à chaque démarrage
// de refresh.js sur le pool actuel plutôt que pendant un crawl.
export function syncPersonDerivedBirthFilters() {
  const decadeDefs = PERSON_BIRTH_DECADES.map((b) => ({
    code: b.code,
    name: b.label,
  }));
  const countryDefs = COUNTRY_TARGETS.map((c) => ({ code: c.code, name: c.name }));

  for (const [type, pool] of [
    ["director", db.getDirectorPool()],
    ["actor", db.getActorPool()],
  ]) {
    db.upsertFilters(type, "decennie", decadeDefs);
    db.replaceEntityFilters(
      type,
      "decennie",
      pool.map((p) => {
        const year = p.birthday ? Number(p.birthday.slice(0, 4)) : null;
        const code = year ? decadeCodeForBirthYear(year) : null;
        return { entityId: p.id, codes: code ? [code] : [] };
      }),
    );

    db.upsertFilters(type, "geographie", countryDefs);
    db.replaceEntityFilters(
      type,
      "geographie",
      pool.map((p) => {
        const code = countryCodeForPlaceOfBirth(p.place_of_birth);
        return { entityId: p.id, codes: code ? [code] : [] };
      }),
    );
  }
}
