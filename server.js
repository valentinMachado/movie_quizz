import "dotenv/config";
import express from "express";
import path from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_KEY = process.env.TMDB_API_KEY;
const REFRESH_MS = 30 * 60 * 1000; // 30 min (vu le volume de catégories films+séries)
const MIN_COUNT = 5;
const MAX_COUNT = 100;
const MIN_IMAGES_PER_FILM = 1;
const MAX_IMAGES_PER_FILM = 6;
const IMAGE_FETCH_CONCURRENCY = 8;

if (!TMDB_KEY) {
  console.error("TMDB_API_KEY manquante dans .env");
  process.exit(1);
}

// IGDB (jeux vidéo) est optionnel : sans identifiants Twitch, le serveur
// démarre quand même, simplement sans la catégorie Jeux vidéo.
const IGDB_CLIENT_ID = process.env.IGDB_CLIENT_ID;
const IGDB_CLIENT_SECRET = process.env.IGDB_CLIENT_SECRET;
const igdbEnabled = Boolean(IGDB_CLIENT_ID && IGDB_CLIENT_SECRET);
if (!igdbEnabled) {
  console.warn(
    "IGDB_CLIENT_ID/IGDB_CLIENT_SECRET absents dans .env : catégorie Jeux vidéo désactivée.",
  );
}

// --- compteur de quiz générés, persisté sur disque (survit aux redémarrages) ---
const STATS_PATH = path.join(process.cwd(), "stats.json");

function loadStats() {
  try {
    if (existsSync(STATS_PATH)) {
      const raw = JSON.parse(readFileSync(STATS_PATH, "utf8"));
      return {
        totalGenerated: raw.totalGenerated || 0,
        categoryUsage: raw.categoryUsage || {},
      };
    }
  } catch (e) {
    console.error("Erreur lecture stats.json:", e.message);
  }
  return { totalGenerated: 0, categoryUsage: {} };
}

let stats = loadStats();

function saveStats() {
  try {
    writeFileSync(STATS_PATH, JSON.stringify(stats));
  } catch (e) {
    console.error("Erreur écriture stats.json:", e.message);
  }
}

const STATIC_LISTS = {
  popular: {
    pathAndQuery: "movie/popular",
    pages: 15,
    label: "Populaires",
    group: "liste",
    mediaType: "movie",
  },
  top_rated: {
    pathAndQuery: "movie/top_rated",
    pages: 15,
    label: "Mieux notés",
    group: "liste",
    mediaType: "movie",
  },
  now_playing: {
    pathAndQuery: "movie/now_playing",
    pages: 6,
    label: "Au cinéma",
    group: "liste",
    mediaType: "movie",
  },
  upcoming: {
    pathAndQuery: "movie/upcoming",
    pages: 6,
    label: "À venir",
    group: "liste",
    mediaType: "movie",
  },
  trending_day: {
    pathAndQuery: "trending/movie/day",
    pages: 5,
    label: "Tendances du jour",
    group: "liste",
    mediaType: "movie",
  },
  trending_week: {
    pathAndQuery: "trending/movie/week",
    pages: 6,
    label: "Tendances de la semaine",
    group: "liste",
    mediaType: "movie",
  },
};

// catégories par décennie, construites via /discover avec un filtre de date
const DECADE_LISTS = {
  before_1970: {
    pathAndQuery:
      "discover/movie?primary_release_date.lte=1969-12-31&sort_by=popularity.desc",
    pages: 5,
    label: "Avant 1970",
    group: "decade",
    mediaType: "movie",
  },
  decade_1970: {
    pathAndQuery:
      "discover/movie?primary_release_date.gte=1970-01-01&primary_release_date.lte=1979-12-31&sort_by=popularity.desc",
    pages: 5,
    label: "Années 1970",
    group: "decade",
    mediaType: "movie",
  },
  decade_1980: {
    pathAndQuery:
      "discover/movie?primary_release_date.gte=1980-01-01&primary_release_date.lte=1989-12-31&sort_by=popularity.desc",
    pages: 6,
    label: "Années 1980",
    group: "decade",
    mediaType: "movie",
  },
  decade_1990: {
    pathAndQuery:
      "discover/movie?primary_release_date.gte=1990-01-01&primary_release_date.lte=1999-12-31&sort_by=popularity.desc",
    pages: 6,
    label: "Années 1990",
    group: "decade",
    mediaType: "movie",
  },
  decade_2000: {
    pathAndQuery:
      "discover/movie?primary_release_date.gte=2000-01-01&primary_release_date.lte=2009-12-31&sort_by=popularity.desc",
    pages: 6,
    label: "Années 2000",
    group: "decade",
    mediaType: "movie",
  },
  decade_2010: {
    pathAndQuery:
      "discover/movie?primary_release_date.gte=2010-01-01&primary_release_date.lte=2019-12-31&sort_by=popularity.desc",
    pages: 6,
    label: "Années 2010",
    group: "decade",
    mediaType: "movie",
  },
  decade_2020: {
    pathAndQuery:
      "discover/movie?primary_release_date.gte=2020-01-01&sort_by=popularity.desc",
    pages: 6,
    label: "Années 2020",
    group: "decade",
    mediaType: "movie",
  },
};

// équivalents séries TV (endpoints /tv et /discover/tv, first_air_date au lieu de primary_release_date)
const TV_STATIC_LISTS = {
  tv_popular: {
    pathAndQuery: "tv/popular",
    pages: 10,
    label: "Populaires (Séries)",
    group: "liste",
    mediaType: "tv",
  },
  tv_top_rated: {
    pathAndQuery: "tv/top_rated",
    pages: 10,
    label: "Mieux notées (Séries)",
    group: "liste",
    mediaType: "tv",
  },
  tv_on_the_air: {
    pathAndQuery: "tv/on_the_air",
    pages: 4,
    label: "En cours de diffusion",
    group: "liste",
    mediaType: "tv",
  },
  tv_airing_today: {
    pathAndQuery: "tv/airing_today",
    pages: 4,
    label: "À l'antenne aujourd'hui",
    group: "liste",
    mediaType: "tv",
  },
  tv_trending_day: {
    pathAndQuery: "trending/tv/day",
    pages: 4,
    label: "Tendances du jour (Séries)",
    group: "liste",
    mediaType: "tv",
  },
  tv_trending_week: {
    pathAndQuery: "trending/tv/week",
    pages: 5,
    label: "Tendances de la semaine (Séries)",
    group: "liste",
    mediaType: "tv",
  },
};

const TV_DECADE_LISTS = {
  tv_before_1970: {
    pathAndQuery:
      "discover/tv?first_air_date.lte=1969-12-31&sort_by=popularity.desc",
    pages: 4,
    label: "Avant 1970 (Séries)",
    group: "decade",
    mediaType: "tv",
  },
  tv_decade_1970: {
    pathAndQuery:
      "discover/tv?first_air_date.gte=1970-01-01&first_air_date.lte=1979-12-31&sort_by=popularity.desc",
    pages: 4,
    label: "Années 1970 (Séries)",
    group: "decade",
    mediaType: "tv",
  },
  tv_decade_1980: {
    pathAndQuery:
      "discover/tv?first_air_date.gte=1980-01-01&first_air_date.lte=1989-12-31&sort_by=popularity.desc",
    pages: 5,
    label: "Années 1980 (Séries)",
    group: "decade",
    mediaType: "tv",
  },
  tv_decade_1990: {
    pathAndQuery:
      "discover/tv?first_air_date.gte=1990-01-01&first_air_date.lte=1999-12-31&sort_by=popularity.desc",
    pages: 5,
    label: "Années 1990 (Séries)",
    group: "decade",
    mediaType: "tv",
  },
  tv_decade_2000: {
    pathAndQuery:
      "discover/tv?first_air_date.gte=2000-01-01&first_air_date.lte=2009-12-31&sort_by=popularity.desc",
    pages: 5,
    label: "Années 2000 (Séries)",
    group: "decade",
    mediaType: "tv",
  },
  tv_decade_2010: {
    pathAndQuery:
      "discover/tv?first_air_date.gte=2010-01-01&first_air_date.lte=2019-12-31&sort_by=popularity.desc",
    pages: 5,
    label: "Années 2010 (Séries)",
    group: "decade",
    mediaType: "tv",
  },
  tv_decade_2020: {
    pathAndQuery:
      "discover/tv?first_air_date.gte=2020-01-01&sort_by=popularity.desc",
    pages: 5,
    label: "Années 2020 (Séries)",
    group: "decade",
    mediaType: "tv",
  },
};

// acteurs/actrices — même clé TMDb, endpoint /person. Pas de genres ni
// décennies pertinents pour les personnes, donc une seule liste large.
const PERSON_STATIC_LISTS = {
  person_popular: {
    pathAndQuery: "person/popular",
    pages: 20,
    label: "Acteurs populaires",
    group: "liste",
    mediaType: "person",
  },
};

// jeux vidéo (IGDB) — structure différente de TMDb : `igdbWhere`/`igdbSort`
// au lieu de `pathAndQuery`, paginé par offset (voir fetchGameCategory)
const GAME_STATIC_LISTS = {
  game_popular: {
    igdbWhere: "cover != null & screenshots != null",
    igdbSort: "total_rating_count desc",
    pages: 8,
    label: "Jeux populaires",
    group: "liste",
    mediaType: "game",
  },
  game_top_rated: {
    igdbWhere: "cover != null & screenshots != null & total_rating_count > 50",
    igdbSort: "total_rating desc",
    pages: 8,
    label: "Jeux les mieux notés",
    group: "liste",
    mediaType: "game",
  },
  game_recent: {
    igdbWhere:
      "cover != null & screenshots != null & first_release_date != null",
    igdbSort: "first_release_date desc",
    pages: 6,
    label: "Sorties récentes",
    group: "liste",
    mediaType: "game",
  },
};

const GAME_DECADE_LISTS = {
  game_before_1980: {
    igdbWhere: `cover != null & screenshots != null & first_release_date < ${unixYear(1980)}`,
    igdbSort: "total_rating_count desc",
    pages: 3,
    label: "Avant 1980 (Jeux)",
    group: "decade",
    mediaType: "game",
  },
  game_decade_1980: {
    igdbWhere: `cover != null & screenshots != null & first_release_date >= ${unixYear(1980)} & first_release_date < ${unixYear(1990)}`,
    igdbSort: "total_rating_count desc",
    pages: 4,
    label: "Années 1980 (Jeux)",
    group: "decade",
    mediaType: "game",
  },
  game_decade_1990: {
    igdbWhere: `cover != null & screenshots != null & first_release_date >= ${unixYear(1990)} & first_release_date < ${unixYear(2000)}`,
    igdbSort: "total_rating_count desc",
    pages: 5,
    label: "Années 1990 (Jeux)",
    group: "decade",
    mediaType: "game",
  },
  game_decade_2000: {
    igdbWhere: `cover != null & screenshots != null & first_release_date >= ${unixYear(2000)} & first_release_date < ${unixYear(2010)}`,
    igdbSort: "total_rating_count desc",
    pages: 5,
    label: "Années 2000 (Jeux)",
    group: "decade",
    mediaType: "game",
  },
  game_decade_2010: {
    igdbWhere: `cover != null & screenshots != null & first_release_date >= ${unixYear(2010)} & first_release_date < ${unixYear(2020)}`,
    igdbSort: "total_rating_count desc",
    pages: 5,
    label: "Années 2010 (Jeux)",
    group: "decade",
    mediaType: "game",
  },
  game_decade_2020: {
    igdbWhere: `cover != null & screenshots != null & first_release_date >= ${unixYear(2020)}`,
    igdbSort: "total_rating_count desc",
    pages: 5,
    label: "Années 2020 (Jeux)",
    group: "decade",
    mediaType: "game",
  },
};

let CATEGORIES = { ...STATIC_LISTS };
let reservoirByCategory = {};
let reservoirReady = false;

// throttle global : reste sous ~38 requêtes / 10s, marge sous la limite
// habituelle de TMDb (40-50/10s), s'applique à TOUS les appels TMDb
// (rafraîchissement du réservoir ET récupération des backdrops par film).
// Passe par une queue pour rester correct même avec des appels concurrents
// (mapWithConcurrency lance plusieurs fetchExtraBackdrops en parallèle).
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

async function tmdbJSON(url, attempt = 1) {
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
      console.warn(
        `TMDb échec réseau${cause}, retry ${attempt}/2 dans ${delay}ms…`,
      );
      await new Promise((r) => setTimeout(r, delay));
      return tmdbJSON(url, attempt + 1);
    }
    e.message = `${e.message}${cause}`;
    throw e;
  }
}

// --- IGDB (jeux vidéo) : auth Twitch (client credentials) + requêtes
// Apicalypse en POST, throttle séparé (IGDB autorise ~4 req/s) ---
let igdbToken = null;
let igdbTokenExpiresAt = 0;

async function getIgdbToken() {
  if (igdbToken && Date.now() < igdbTokenExpiresAt) return igdbToken;
  const url = `https://id.twitch.tv/oauth2/token?client_id=${IGDB_CLIENT_ID}&client_secret=${IGDB_CLIENT_SECRET}&grant_type=client_credentials`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`IGDB auth ${res.status}`);
  const data = await res.json();
  igdbToken = data.access_token;
  // renouvelle 5 min avant l'expiration réelle, par sécurité
  igdbTokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
  return igdbToken;
}

let lastIgdbCallTs = 0;
let igdbGateQueue = Promise.resolve();
const IGDB_MIN_INTERVAL_MS = 280;

function igdbGate() {
  const turn = igdbGateQueue.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastIgdbCallTs + IGDB_MIN_INTERVAL_MS - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastIgdbCallTs = Date.now();
  });
  igdbGateQueue = turn;
  return turn;
}

async function igdbQuery(endpoint, body, attempt = 1) {
  await igdbGate();
  const token = await getIgdbToken();
  try {
    const res = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
      method: "POST",
      headers: {
        "Client-ID": IGDB_CLIENT_ID,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "text/plain",
      },
      body,
    });
    if (!res.ok) throw new Error(`IGDB ${res.status} sur ${endpoint}`);
    return await res.json();
  } catch (e) {
    // "fetch failed" est une erreur réseau générique (reset/coupure de
    // connexion) plutôt qu'une réponse HTTP d'erreur — souvent transitoire
    // sur une rafale de requêtes. On retente avec un backoff avant d'abandonner.
    const cause = e.cause
      ? ` (${e.cause.code || e.cause.message || e.cause})`
      : "";
    if (attempt < 3) {
      const delay = 500 * attempt;
      console.warn(
        `IGDB "${endpoint}" échec réseau${cause}, retry ${attempt}/2 dans ${delay}ms…`,
      );
      await new Promise((r) => setTimeout(r, delay));
      return igdbQuery(endpoint, body, attempt + 1);
    }
    e.message = `${e.message}${cause}`;
    throw e;
  }
}

function unixYear(year) {
  return Math.floor(Date.UTC(year, 0, 1) / 1000);
}

function toEntry(m, mediaType) {
  if (mediaType === "person") {
    return {
      id: m.id,
      title: m.name,
      mediaType,
      imageUrl: `https://image.tmdb.org/t/p/w1280${m.profile_path}`,
      posterUrl: `https://image.tmdb.org/t/p/w500${m.profile_path}`,
    };
  }
  return {
    id: m.id,
    title: mediaType === "tv" ? m.name : m.title,
    mediaType,
    imageUrl: `https://image.tmdb.org/t/p/w1280${m.backdrop_path}`,
    posterUrl: `https://image.tmdb.org/t/p/w500${m.poster_path}`,
  };
}

function urlFor(pathAndQuery, page) {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  return `https://api.themoviedb.org/3/${pathAndQuery}${sep}api_key=${TMDB_KEY}&language=fr-FR&page=${page}`;
}

async function buildCategoryDefs() {
  const defs = {
    ...STATIC_LISTS,
    ...DECADE_LISTS,
    ...TV_STATIC_LISTS,
    ...TV_DECADE_LISTS,
    ...PERSON_STATIC_LISTS,
  };
  try {
    const genreData = await tmdbJSON(
      `https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_KEY}&language=fr-FR`,
    );
    for (const g of genreData.genres || []) {
      defs[`genre_${g.id}`] = {
        pathAndQuery: `discover/movie?with_genres=${g.id}&sort_by=popularity.desc`,
        pages: 6,
        label: g.name,
        group: "genre",
        mediaType: "movie",
      };
    }
  } catch (e) {
    console.error("Erreur récupération des genres films:", e.message);
  }
  try {
    const tvGenreData = await tmdbJSON(
      `https://api.themoviedb.org/3/genre/tv/list?api_key=${TMDB_KEY}&language=fr-FR`,
    );
    for (const g of tvGenreData.genres || []) {
      defs[`tv_genre_${g.id}`] = {
        pathAndQuery: `discover/tv?with_genres=${g.id}&sort_by=popularity.desc`,
        pages: 5,
        label: `${g.name} (Séries)`,
        group: "genre",
        mediaType: "tv",
      };
    }
  } catch (e) {
    console.error("Erreur récupération des genres séries:", e.message);
  }
  if (igdbEnabled) {
    Object.assign(defs, GAME_STATIC_LISTS, GAME_DECADE_LISTS);
    try {
      const genres = await igdbQuery("genres", "fields id,name; limit 50;");
      for (const g of genres) {
        defs[`game_genre_${g.id}`] = {
          igdbWhere: `cover != null & screenshots != null & genres = (${g.id})`,
          igdbSort: "total_rating_count desc",
          pages: 4,
          label: `${g.name} (Jeux)`,
          group: "genre",
          mediaType: "game",
        };
      }
    } catch (e) {
      console.error("Erreur récupération des genres IGDB:", e.message);
    }
  }
  return defs;
}

async function fetchGameCategory(def) {
  const seen = new Map();
  const limit = 100;
  for (let i = 0; i < def.pages; i++) {
    const offset = i * limit;
    const body = `fields name,cover.image_id,screenshots.image_id; where ${def.igdbWhere}; sort ${def.igdbSort}; limit ${limit}; offset ${offset};`;
    const data = await igdbQuery("games", body);
    for (const g of data) {
      if (!g.cover?.image_id || !g.screenshots?.length || seen.has(g.id))
        continue;
      seen.set(g.id, {
        id: g.id,
        title: g.name,
        mediaType: "game",
        imageUrl: `https://images.igdb.com/igdb/image/upload/t_1080p/${g.screenshots[0].image_id}.jpg`,
        posterUrl: `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg`,
      });
    }
    if (!data || data.length < limit) break; // dernière page atteinte
  }
  return [...seen.values()];
}

async function fetchCategory(def) {
  if (def.mediaType === "game") return fetchGameCategory(def);
  const seen = new Map();
  for (let page = 1; page <= def.pages; page++) {
    const data = await tmdbJSON(urlFor(def.pathAndQuery, page));
    for (const m of data.results || []) {
      const valid =
        def.mediaType === "person"
          ? Boolean(m.profile_path)
          : Boolean(m.backdrop_path) && Boolean(m.poster_path);
      if (!valid || seen.has(m.id)) continue;
      seen.set(m.id, toEntry(m, def.mediaType));
    }
  }
  return [...seen.values()];
}

async function refreshReservoir() {
  CATEGORIES = await buildCategoryDefs();
  const next = {};
  for (const [key, def] of Object.entries(CATEGORIES)) {
    try {
      next[key] = await fetchCategory(def);
    } catch (e) {
      console.error(`Erreur catégorie "${key}":`, e.message);
      next[key] = reservoirByCategory[key] || [];
    }
  }
  reservoirByCategory = next;
  reservoirReady = Object.values(reservoirByCategory).some(
    (list) => list.length > 0,
  );
  console.log(
    `Réservoir rafraîchi : ${Object.keys(CATEGORIES).length} catégories.`,
  );
}

refreshReservoir();
setInterval(refreshReservoir, REFRESH_MS).unref();

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function mergedPool(categoryKeys) {
  const merged = new Map();
  for (const cat of categoryKeys) {
    for (const m of reservoirByCategory[cat] || []) merged.set(m.id, m);
  }
  return [...merged.values()];
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const my = idx++;
      results[my] = await fn(items[my], my);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

// TMDb marque chaque backdrop d'un iso_639_1 : null = version "textless"
// (sans titre/texte incrusté), une valeur (ex: "en") = version localisée avec
// texte. On n'utilise QUE les textless, jamais de repli sur une version avec
// texte — un film sans version textless disponible est écarté par l'appelant.
function pickFromPool(pool, need) {
  let ordered = pool;
  if (ordered.length > need) {
    // les mieux notées ressemblent souvent au poster officiel (key art) :
    // on saute une bonne partie du haut de liste avant de mélanger
    const tailStart = Math.floor(ordered.length * 0.45);
    const tail = ordered.slice(tailStart);
    ordered = tail.length >= need ? tail : ordered;
  }
  const shuffled = shuffle(ordered);
  const result = [];
  for (let i = 0; i < need; i++) result.push(shuffled[i % shuffled.length]);
  return result;
}

// cache générique par clé, TTL 6h — évite de re-taper l'API pour un titre
// (ou une saison/épisode) déjà consulté dans un quiz précédent
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const apiCache = new Map(); // key -> { value, expiresAt }

function cacheGet(key) {
  const c = apiCache.get(key);
  if (c && c.expiresAt > Date.now()) return c.value;
  return null;
}
function cacheSet(key, value) {
  apiCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// toutes les fonctions ci-dessous renvoient un format uniforme :
// { url, iso_639_1, vote_count, aspect_ratio } — quelle que soit la source
// (TMDb backdrops/profiles/stills ou captures IGDB), pour que
// fetchExtraBackdrops puisse les traiter de la même façon.

async function fetchRawBackdrops(movie) {
  const kind =
    movie.mediaType === "tv"
      ? "tv"
      : movie.mediaType === "person"
        ? "person"
        : "movie";
  const cacheKey = `backdrops:${kind}:${movie.id}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await tmdbJSON(
    `https://api.themoviedb.org/3/${kind}/${movie.id}/images?api_key=${TMDB_KEY}`,
  );
  const raw = kind === "person" ? data.profiles || [] : data.backdrops || [];
  const backdrops = raw
    .filter((b) => b.file_path)
    .map((b) => ({
      url: `https://image.tmdb.org/t/p/w1280${b.file_path}`,
      iso_639_1: b.iso_639_1,
      vote_count: b.vote_count,
      aspect_ratio: b.aspect_ratio,
    }));
  cacheSet(cacheKey, backdrops);
  return backdrops;
}

// IGDB n'a pas de notion de texte/langue ni de vote par image : on neutralise
// ces deux filtres (iso_639_1 null, vote_count à 1) et on fixe un ratio 16:9
// puisque les captures d'écran le sont quasi systématiquement.
async function fetchGameScreenshots(gameId) {
  const cacheKey = `gamescreens:${gameId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await igdbQuery(
    "games",
    `fields screenshots.image_id; where id = ${gameId};`,
  );
  const screenshots = (data[0]?.screenshots || [])
    .filter((s) => s.image_id)
    .map((s) => ({
      url: `https://images.igdb.com/igdb/image/upload/t_1080p/${s.image_id}.jpg`,
      iso_639_1: null,
      vote_count: 1,
      aspect_ratio: 1.78,
    }));
  cacheSet(cacheKey, screenshots);
  return screenshots;
}

// écarte les formats trop éloignés d'un vrai backdrop 16:9 — les visuels
// promo/bannières/collages ont souvent un ratio différent d'une capture du film
function isStandardRatio(b) {
  return b.aspect_ratio >= 1.7 && b.aspect_ratio <= 1.85;
}

// pour les séries : pioche une saison et un épisode au hasard, renvoie ses
// stills textless (ou null si rien d'exploitable — l'appelant retombe alors
// sur les visuels globaux de la série, en dernier recours seulement)
async function fetchEpisodeTextlessStills(movie) {
  try {
    const showKey = `tvshow:${movie.id}`;
    let seasons = cacheGet(showKey);
    if (!seasons) {
      const showData = await tmdbJSON(
        `https://api.themoviedb.org/3/tv/${movie.id}?api_key=${TMDB_KEY}`,
      );
      seasons = (showData.seasons || []).filter(
        (s) => s.season_number > 0 && s.episode_count > 0,
      );
      cacheSet(showKey, seasons);
    }
    if (seasons.length === 0) return null;
    const season = seasons[Math.floor(Math.random() * seasons.length)];

    const seasonKey = `tvseason:${movie.id}:${season.season_number}`;
    let episodeNumbers = cacheGet(seasonKey);
    if (!episodeNumbers) {
      const seasonData = await tmdbJSON(
        `https://api.themoviedb.org/3/tv/${movie.id}/season/${season.season_number}?api_key=${TMDB_KEY}`,
      );
      episodeNumbers = (seasonData.episodes || []).map((e) => e.episode_number);
      cacheSet(seasonKey, episodeNumbers);
    }
    if (episodeNumbers.length === 0) return null;
    const episodeNumber =
      episodeNumbers[Math.floor(Math.random() * episodeNumbers.length)];

    const episodeKey = `tvepisode:${movie.id}:${season.season_number}:${episodeNumber}`;
    let stills = cacheGet(episodeKey);
    if (!stills) {
      const epData = await tmdbJSON(
        `https://api.themoviedb.org/3/tv/${movie.id}/season/${season.season_number}/episode/${episodeNumber}/images?api_key=${TMDB_KEY}`,
      );
      stills = (epData.stills || [])
        .filter((s) => s.file_path)
        .map((s) => ({
          url: `https://image.tmdb.org/t/p/w1280${s.file_path}`,
          iso_639_1: s.iso_639_1,
          vote_count: s.vote_count,
          aspect_ratio: s.aspect_ratio,
        }));
      cacheSet(episodeKey, stills);
    }
    const textless = stills.filter((s) => s.iso_639_1 === null);
    return textless.length > 0 ? textless : null;
  } catch (e) {
    return null;
  }
}

async function fetchExtraBackdrops(movie, need) {
  try {
    let backdrops;
    if (movie.mediaType === "tv") {
      // toujours des captures d'épisode pour les séries ; repli sur les
      // visuels globaux de la série uniquement si aucun épisode n'a de still exploitable
      backdrops = await fetchEpisodeTextlessStills(movie);
      if (!backdrops) backdrops = await fetchRawBackdrops(movie);
    } else if (movie.mediaType === "game") {
      backdrops = await fetchGameScreenshots(movie.id);
    } else {
      backdrops = await fetchRawBackdrops(movie);
    }

    const textless = backdrops.filter(
      (b) => b.iso_639_1 === null || b.iso_639_1 === undefined,
    );
    if (textless.length === 0) return [];

    // 1) ratio standard en priorité (moins de bannières/collages promo) —
    // ne s'applique pas aux photos de profil (portrait par nature, pas 16:9)
    const ratioPool =
      movie.mediaType === "person"
        ? textless
        : textless.filter(isStandardRatio).length > 0
          ? textless.filter(isStandardRatio)
          : textless;

    // 2) images ayant reçu des votes communautaires en priorité (le contenu
    // promo bulk-uploadé par les studios n'est en général jamais voté)
    const voted = ratioPool.filter((b) => b.vote_count > 0);
    const finalPool =
      voted.length >= Math.min(need, ratioPool.length) ? voted : ratioPool;

    return pickFromPool(finalPool, need).map((b) => b.url);
  } catch (e) {
    return [];
  }
}

async function selectMoviesWithBackdrops(
  candidatesShuffled,
  count,
  imagesPerFilm,
) {
  const result = [];
  let excludedCount = 0;
  let idx = 0;
  const batchSize = Math.max(count, 20);
  while (result.length < count && idx < candidatesShuffled.length) {
    const batch = candidatesShuffled.slice(idx, idx + batchSize);
    idx += batchSize;
    const withImages = await mapWithConcurrency(
      batch,
      IMAGE_FETCH_CONCURRENCY,
      async (m) => {
        const imageUrls = await fetchExtraBackdrops(m, imagesPerFilm);
        return imageUrls.length > 0
          ? {
              id: m.id,
              title: m.title,
              posterUrl: m.posterUrl,
              mediaType: m.mediaType,
              imageUrls,
            }
          : null;
      },
    );
    for (const item of withImages) {
      if (!item) {
        excludedCount++;
        continue;
      }
      if (result.length < count) result.push(item);
    }
  }
  return { movies: result, excludedCount };
}

app.get("/api/categories", (req, res) => {
  const list = Object.entries(CATEGORIES).map(([key, def]) => ({
    key,
    label: def.label,
    group: def.group,
    mediaType: def.mediaType,
    available: (reservoirByCategory[key] || []).length,
  }));
  res.json({ categories: list, minCount: MIN_COUNT, maxCount: MAX_COUNT });
});

app.get("/api/pool-size", (req, res) => {
  const requestedCategories = (req.query.categories || "")
    .split(",")
    .map((s) => s.trim())
    .filter((c) => CATEGORIES[c]);
  res.json({ available: mergedPool(requestedCategories).length });
});

app.get("/api/stats", (req, res) => {
  const topCategories = Object.entries(stats.categoryUsage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => ({
      key,
      label: CATEGORIES[key]?.label || key,
      count,
    }));
  res.json({ totalGenerated: stats.totalGenerated, topCategories });
});

app.get("/api/quiz-batch", async (req, res) => {
  if (!reservoirReady) {
    return res
      .status(503)
      .json({
        error: "Réservoir en cours de préparation, réessaie dans un instant.",
      });
  }

  const requestedCategories = (req.query.categories || "popular")
    .split(",")
    .map((s) => s.trim())
    .filter((c) => CATEGORIES[c]);
  if (requestedCategories.length === 0) requestedCategories.push("popular");

  const imagesPerFilm = Math.min(
    MAX_IMAGES_PER_FILM,
    Math.max(MIN_IMAGES_PER_FILM, parseInt(req.query.imagesPerFilm, 10) || 1),
  );

  const all = mergedPool(requestedCategories);
  const count = Math.min(
    MAX_COUNT,
    Math.max(MIN_COUNT, parseInt(req.query.count, 10) || 50),
    all.length || MIN_COUNT,
  );

  const excludeIds = new Set(
    (req.query.exclude || "").split(",").filter(Boolean).map(Number),
  );

  let candidates = all.filter((m) => !excludeIds.has(m.id));
  let recycled = false;
  if (candidates.length < count) {
    candidates = all;
    recycled = true;
  }

  const picked = shuffle(candidates);
  const { movies: withImages, excludedCount } = await selectMoviesWithBackdrops(
    picked,
    count,
    imagesPerFilm,
  );

  // un appel qui produit un lot compte comme un quiz généré, persisté sur disque
  stats.totalGenerated++;
  for (const cat of requestedCategories) {
    stats.categoryUsage[cat] = (stats.categoryUsage[cat] || 0) + 1;
  }
  saveStats();

  res.json({
    movies: withImages,
    recycled,
    requested: count,
    delivered: withImages.length,
    excludedCount,
    imagesPerFilm,
    categories: requestedCategories,
    poolSize: all.length,
    totalGenerated: stats.totalGenerated,
  });
});

app.use(express.static(path.join(process.cwd(), "public")));

app.listen(PORT, () => console.log(`Movie Quiz sur http://localhost:${PORT}`));
