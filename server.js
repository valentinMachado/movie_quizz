import "dotenv/config";
import express from "express";
import path from "node:path";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { createHash } from "node:crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const APP_VERSION = JSON.parse(
  readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
).version;
const TMDB_KEY = process.env.TMDB_API_KEY;
// deux cadences de rafraîchissement distinctes (voir refreshReservoir) : les
// catégories volatiles (now_playing, trending, etc.) toutes les 6h, tout le
// reste toutes les semaines — même valeur que RESERVOIR_CACHE_TTL_MS plus
// bas, qui sert de seule source de vérité pour "une donnée stable reste
// valide combien de temps".
const VOLATILE_REFRESH_MS = 6 * 60 * 60 * 1000; // 6h
const MIN_COUNT = 5;
const MAX_COUNT = 100;
const MIN_IMAGES_PER_ITEM = 1;
const MAX_IMAGES_PER_ITEM = 5;
const IMAGE_FETCH_CONCURRENCY = 8;
// initialisation du réservoir : la vraie limite est le throttle de chaque
// API (tmdbGate/igdbGate), qui sérialise déjà les appels réels quel que soit
// le nombre d'appelants concurrents — ces deux constantes servent juste à ce
// qu'il y ait toujours un appel prêt à partir dès que le throttle l'autorise,
// au lieu d'attendre bêtement la fin de la page/catégorie précédente.
const CATEGORY_FETCH_CONCURRENCY = 6;
const PAGE_FETCH_CONCURRENCY = 4;

// mode dev (--dev) : réduit le nombre de pages récupérées par catégorie pour
// démarrer vite en local (moins de requêtes TMDb/IGDB, donc moins d'attente
// sur le throttle global)
const DEV_MODE = process.argv.includes("--dev");
const DEV_MAX_PAGES = 1;

// --only=movie,painting : ne construit/rafraîchit que les catégories de ces
// médias (les autres sont ignorées avant même d'être fetchées), pour tester
// une seule fonctionnalité sans attendre tout le reste. Combinable avec
// --dev (ex: node server.js --dev --only=painting).
const ONLY_ARG = process.argv.find((a) => a.startsWith("--only="));
const ONLY_TYPES = ONLY_ARG
  ? new Set(
      ONLY_ARG.slice("--only=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;
function onlyWants(mediaType) {
  return !ONLY_TYPES || ONLY_TYPES.has(mediaType);
}

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

// Pexels (photos pays) est optionnel : sans clé, le serveur démarre quand
// même, simplement sans la catégorie Pays.
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const pexelsEnabled = Boolean(PEXELS_API_KEY);
if (!pexelsEnabled) {
  console.warn(
    "PEXELS_API_KEY absente dans .env : catégorie Pays désactivée.",
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

// --- cache disque : réservoir + caches de warm loop, pour ne pas repartir de
// zéro à chaque redémarrage (déploiement, crash, etc.) ---
const CACHE_DIR = path.join(process.cwd(), "cache");
const RESERVOIR_CACHE_PATH = path.join(CACHE_DIR, "reservoir.json");
const PAINTING_WARM_CACHE_PATH = path.join(CACHE_DIR, "warm-paintings.json");
const COUNTRY_WARM_CACHE_PATH = path.join(CACHE_DIR, "warm-countries.json");
const RESERVOIR_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 semaine

// écriture atomique (fichier temporaire + rename) : un kill/crash pendant
// l'écriture ne doit jamais laisser un cache à moitié écrit — ça casserait le
// prochain démarrage au lieu de juste le ralentir
function writeJsonAtomic(filePath, data) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data));
  renameSync(tmpPath, filePath);
}

const STATIC_LISTS = {
  popular: {
    pathAndQuery: "movie/popular",
    pages: 15,
    label: "Populaires (Films)",
    group: "liste",
    mediaType: "movie",
  },
  top_rated: {
    pathAndQuery: "movie/top_rated",
    pages: 15,
    label: "Mieux notés (Films)",
    group: "liste",
    mediaType: "movie",
  },
  now_playing: {
    pathAndQuery: "movie/now_playing",
    pages: 6,
    label: "Au cinéma (Films)",
    group: "liste",
    mediaType: "movie",
    volatile: true,
  },
  upcoming: {
    pathAndQuery: "movie/upcoming",
    pages: 6,
    label: "À venir (Films)",
    group: "liste",
    mediaType: "movie",
    volatile: true,
  },
  trending_day: {
    pathAndQuery: "trending/movie/day",
    pages: 5,
    label: "Tendances du jour (Films)",
    group: "liste",
    mediaType: "movie",
    volatile: true,
  },
  trending_week: {
    pathAndQuery: "trending/movie/week",
    pages: 6,
    label: "Tendances de la semaine (Films)",
    group: "liste",
    mediaType: "movie",
    volatile: true,
  },
};

// catégories par décennie, construites via /discover avec un filtre de date
const DECADE_LISTS = {
  before_1970: {
    pathAndQuery:
      "discover/movie?primary_release_date.lte=1969-12-31&sort_by=popularity.desc",
    pages: 5,
    label: "Avant 1970 (Films)",
    group: "decade",
    mediaType: "movie",
  },
  decade_1970: {
    pathAndQuery:
      "discover/movie?primary_release_date.gte=1970-01-01&primary_release_date.lte=1979-12-31&sort_by=popularity.desc",
    pages: 5,
    label: "Années 1970 (Films)",
    group: "decade",
    mediaType: "movie",
  },
  decade_1980: {
    pathAndQuery:
      "discover/movie?primary_release_date.gte=1980-01-01&primary_release_date.lte=1989-12-31&sort_by=popularity.desc",
    pages: 6,
    label: "Années 1980 (Films)",
    group: "decade",
    mediaType: "movie",
  },
  decade_1990: {
    pathAndQuery:
      "discover/movie?primary_release_date.gte=1990-01-01&primary_release_date.lte=1999-12-31&sort_by=popularity.desc",
    pages: 6,
    label: "Années 1990 (Films)",
    group: "decade",
    mediaType: "movie",
  },
  decade_2000: {
    pathAndQuery:
      "discover/movie?primary_release_date.gte=2000-01-01&primary_release_date.lte=2009-12-31&sort_by=popularity.desc",
    pages: 6,
    label: "Années 2000 (Films)",
    group: "decade",
    mediaType: "movie",
  },
  decade_2010: {
    pathAndQuery:
      "discover/movie?primary_release_date.gte=2010-01-01&primary_release_date.lte=2019-12-31&sort_by=popularity.desc",
    pages: 6,
    label: "Années 2010 (Films)",
    group: "decade",
    mediaType: "movie",
  },
  decade_2020: {
    pathAndQuery:
      "discover/movie?primary_release_date.gte=2020-01-01&sort_by=popularity.desc",
    pages: 6,
    label: "Années 2020 (Films)",
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
    volatile: true,
  },
  tv_airing_today: {
    pathAndQuery: "tv/airing_today",
    pages: 4,
    label: "À l'antenne aujourd'hui",
    group: "liste",
    mediaType: "tv",
    volatile: true,
  },
  tv_trending_day: {
    pathAndQuery: "trending/tv/day",
    pages: 4,
    label: "Tendances du jour (Séries)",
    group: "liste",
    mediaType: "tv",
    volatile: true,
  },
  tv_trending_week: {
    pathAndQuery: "trending/tv/week",
    pages: 5,
    label: "Tendances de la semaine (Séries)",
    group: "liste",
    mediaType: "tv",
    volatile: true,
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
// décennies pertinents pour les personnes : on maximise le volume de la
// seule liste disponible (beaucoup de pages) plutôt que d'inventer des axes.
const PERSON_STATIC_LISTS = {
  person_popular: {
    pathAndQuery: "person/popular",
    pages: 40,
    label: "Acteurs populaires",
    group: "liste",
    mediaType: "person",
  },
};

// pays films/acteurs : liste partagée par movie_country_* (discover/movie
// filtré par pays d'origine, direct) et person_country_* (même discover, puis
// casting du film — voir fetchPersonCountryCategory). Pour les acteurs,
// classer la liste globale "populaires" (très dominée US/anglophone) par
// lieu de naissance mélangeait nationalité et lieu de naissance (ex: Emma
// Watson née à Paris mais britannique) et sous-représentait fortement tout
// ce qui n'est pas déjà une star hollywoodienne — repartir des films DE
// chaque pays donne un pool réellement pertinent, pour les films comme pour
// les acteurs, plutôt qu'un sous-ensemble biaisé d'une liste globale.
const COUNTRY_TARGETS = [
  { code: "us", name: "États-Unis" },
  { code: "gb", name: "Royaume-Uni" },
  { code: "fr", name: "France" },
  { code: "ca", name: "Canada" },
  { code: "au", name: "Australie" },
  { code: "de", name: "Allemagne" },
  { code: "it", name: "Italie" },
  { code: "es", name: "Espagne" },
  { code: "in", name: "Inde" },
  { code: "cn", name: "Chine" },
  { code: "kr", name: "Corée du Sud" },
  { code: "jp", name: "Japon" },
  { code: "br", name: "Brésil" },
  { code: "mx", name: "Mexique" },
];
const MOVIE_COUNTRY_PAGES = 8; // ~160 films/pays (20/page), réduit en mode dev comme les autres pages
const PERSON_COUNTRY_MOVIE_PAGES = 4; // ~80 films/pays (20/page), réduit en mode dev comme les autres pages
const PERSON_COUNTRY_CAST_PER_MOVIE = 8; // rôles principaux seulement, pas la liste complète des crédits
const PERSON_COUNTRY_TARGET_ACTORS = 150; // arrête d'aller chercher des crédits une fois assez d'acteurs uniques trouvés

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
    volatile: true,
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

// musique — charts Apple Music (RSS, aucune clé), complétés par l'API Lookup
// iTunes pour récupérer previewUrl (l'extrait audio, absent du flux RSS).
// Un pays = une catégorie. Les genres sont gérés plus bas via le flux RSS
// classique iTunes (qui les supporte, contrairement au flux "most-played"
// utilisé ici). Apple n'expose que les classements courants (jamais de
// classement historique) : impossible d'interroger l'API par décennie —
// les catégories "décennie" musique sont donc reconstituées après coup, en
// redispatchant les titres déjà récupérés (listes + genres) selon leur
// releaseDate, voir MUSIC_DECADE_BOUNDS et refreshReservoir().
const MUSIC_GENRE_STORE = "us"; // un seul store pour les genres (le plus fourni), sinon ça multiplie les catégories par pays
const MUSIC_STATIC_LISTS = {
  music_popular_fr: {
    country: "fr",
    label: "Populaire (Musique, France)",
    group: "geography",
    mediaType: "music",
  },
  music_popular_us: {
    country: "us",
    label: "Populaire (Musique, USA)",
    group: "geography",
    mediaType: "music",
  },
  music_popular_gb: {
    country: "gb",
    label: "Populaire (Musique, UK)",
    group: "geography",
    mediaType: "music",
  },
  music_popular_de: {
    country: "de",
    label: "Populaire (Musique, Allemagne)",
    group: "geography",
    mediaType: "music",
  },
  music_popular_es: {
    country: "es",
    label: "Populaire (Musique, Espagne)",
    group: "geography",
    mediaType: "music",
  },
  music_popular_it: {
    country: "it",
    label: "Populaire (Musique, Italie)",
    group: "geography",
    mediaType: "music",
  },
  music_popular_jp: {
    country: "jp",
    label: "Populaire (Musique, Japon)",
    group: "geography",
    mediaType: "music",
  },
  music_popular_br: {
    country: "br",
    label: "Populaire (Musique, Brésil)",
    group: "geography",
    mediaType: "music",
  },
};

// décennies musique : aucune requête dédiée (voir commentaire plus haut) —
// juste des bornes d'années utilisées pour trier les titres déjà en réservoir
const MUSIC_DECADE_BOUNDS = [
  {
    key: "music_before_1970",
    label: "Avant 1970 (Musique)",
    minYear: -Infinity,
    maxYear: 1969,
  },
  {
    key: "music_decade_1970",
    label: "Années 1970 (Musique)",
    minYear: 1970,
    maxYear: 1979,
  },
  {
    key: "music_decade_1980",
    label: "Années 1980 (Musique)",
    minYear: 1980,
    maxYear: 1989,
  },
  {
    key: "music_decade_1990",
    label: "Années 1990 (Musique)",
    minYear: 1990,
    maxYear: 1999,
  },
  {
    key: "music_decade_2000",
    label: "Années 2000 (Musique)",
    minYear: 2000,
    maxYear: 2009,
  },
  {
    key: "music_decade_2010",
    label: "Années 2010 (Musique)",
    minYear: 2010,
    maxYear: 2019,
  },
  {
    key: "music_decade_2020",
    label: "Années 2020 (Musique)",
    minYear: 2020,
    maxYear: Infinity,
  },
];

// décennies acteurs (date de naissance) : TMDb n'a pas de /discover/person
// filtrable par date de naissance, donc même principe que les décennies
// musique — voir le post-traitement dans refreshReservoir(). Pas de suffixe
// "(Acteurs)" dans le label : contrairement à "music"/"movie", la liste de
// mots à retirer pour "person" est vide (voir MEDIA_TYPE_LABEL_WORDS, il ne
// faut jamais retirer un nom de pays comme "(États-Unis)"), donc un suffixe
// ici resterait affiché tel quel — l'emoji 🎭 suffit à indiquer le type.
const PERSON_DECADE_BOUNDS = [
  {
    key: "person_before_1940",
    label: "Avant 1940",
    minYear: -Infinity,
    maxYear: 1939,
  },
  { key: "person_decade_1940", label: "Années 1940", minYear: 1940, maxYear: 1949 },
  { key: "person_decade_1950", label: "Années 1950", minYear: 1950, maxYear: 1959 },
  { key: "person_decade_1960", label: "Années 1960", minYear: 1960, maxYear: 1969 },
  { key: "person_decade_1970", label: "Années 1970", minYear: 1970, maxYear: 1979 },
  { key: "person_decade_1980", label: "Années 1980", minYear: 1980, maxYear: 1989 },
  { key: "person_decade_1990", label: "Années 1990", minYear: 1990, maxYear: 1999 },
  {
    key: "person_decade_2000",
    label: "Années 2000",
    minYear: 2000,
    maxYear: Infinity,
  },
];
// une date de naissance ne change jamais : cache bien plus long que le
// défaut (6h) pour ne pas la re-demander à chaque rafraîchissement
// hebdomadaire du réservoir
const PERSON_BIRTHDAY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

// pays — liste depuis mledoze/countries (mirroir libre et sans clé des
// données historiques de REST Countries, elle-même dépréciée et payante
// depuis 2024 ; mêmes champs region/subregion/traductions, activement
// maintenu). Les images de "devinette" viennent d'une recherche Pexels par
// mot-clé (voir fetchCountryPhotos, nécessite PEXELS_API_KEY) ; le drapeau
// (flagcdn.com, gratuit sans clé) sert uniquement d'illustration sur l'écran
// réponse.
const COUNTRY_LIST_URL =
  "https://raw.githubusercontent.com/mledoze/countries/master/countries.json";
const COUNTRY_CONTINENTS = [
  { code: "africa", region: "Africa", label: "Afrique" },
  { code: "americas", region: "Americas", label: "Amériques" },
  { code: "asia", region: "Asia", label: "Asie" },
  { code: "europe", region: "Europe", label: "Europe" },
  { code: "oceania", region: "Oceania", label: "Océanie" },
];

async function loadCountryList() {
  const cacheKey = "country_list";
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const res = await fetch(COUNTRY_LIST_URL);
  if (!res.ok) throw new Error(`mledoze/countries ${res.status}`);
  const data = await res.json();
  cacheSet(cacheKey, data);
  return data;
}

// construit le pool "léger" (id/titre/drapeau) — les photos ne sont
// récupérées qu'à la génération du quiz (voir fetchCountryPhotos), comme les
// backdrops films/séries : coûteux de tout précharger pour ~245 pays alors
// qu'un lot n'en tire qu'une poignée.
async function fetchCountryCategory(def) {
  const all = await loadCountryList();
  const filtered = all.filter(
    (c) => c.region !== "Antarctic" && (!def.region || c.region === def.region),
  );
  const result = [];
  for (const c of filtered) {
    const numId = Number(c.ccn3);
    if (!numId || !c.cca2) continue;
    result.push({
      // décalage large : le ccn3 (code numérique ISO, 3 chiffres) collerait
      // sinon avec des ids TMDb/IGDB/iTunes réels si l'utilisateur mélange
      // pays et un autre type dans le même quiz (dédoublonnage global par id
      // dans stratifiedSelection)
      id: 1_000_000_000_000 + numId,
      title: c.translations?.fra?.common || c.name.common,
      mediaType: "country",
      photoQuery: c.name.common,
      posterUrl: `https://flagcdn.com/w320/${c.cca2.toLowerCase()}.png`,
    });
  }
  return result;
}

// peintures — Wikidata (query.wikidata.org), gratuit, sans clé, couvre
// toutes les collections (pas un seul musée). On devine le PEINTRE
// (title = nom du créateur), pas le tableau. Images servies depuis
// Wikimedia Commons (upload.wikimedia.org) — déjà utilisé ailleurs dans ce
// fichier sans souci de blocage, contrairement à d'autres CDN muséaux testés.
//
// Chaque catégorie interroge Wikidata sur UN SEUL axe (genre OU pays OU
// époque OU popularité) : combiner plusieurs filtres dans la même requête
// (ex. pays + seuil de notoriété) s'est révélé lent/instable à l'usage :
// requêtes non filtrées ou avec ORDER BY sur un calcul (sitelinks) ⇒
// timeouts (502/504) ; requêtes à un seul filtre ⇒ toujours rapides (< 2s).
// Conséquence : les catégories pays/genre/époque ne sont pas garanties
// "populaires" comme la catégorie dédiée, juste garanties d'avoir une image.
//
// Q3305213 = peinture (instance of). P170 = créateur. P18 = image. P135 =
// mouvement artistique. P27 = pays de citoyenneté (appliqué au créateur).
// P571 = date de création. wikibase:sitelinks = nombre d'éditions
// Wikipédia ayant un article sur l'œuvre, utilisé comme substitut de
// popularité (AIC exposait un vrai signal de fréquentation ; Wikidata non).
const PAINTING_GENRES = [
  { code: "impressionism", label: "Impressionnisme", qid: "Q40415" },
  { code: "romanticism", label: "Romantisme", qid: "Q37068" },
  { code: "mannerism", label: "Maniérisme", qid: "Q131808" },
  { code: "baroque", label: "Baroque", qid: "Q37853" },
  { code: "art_nouveau", label: "Art nouveau", qid: "Q34636" },
  { code: "rococo", label: "Rococo", qid: "Q122960" },
  { code: "neoclassicism", label: "Néo-classicisme", qid: "Q14378" },
  { code: "realism", label: "Réalisme", qid: "Q10857409" },
  { code: "post_impressionism", label: "Post-impressionnisme", qid: "Q166713" },
  { code: "symbolism", label: "Symbolisme", qid: "Q164800" },
  { code: "expressionism", label: "Expressionnisme", qid: "Q80113" },
  { code: "renaissance", label: "Renaissance", qid: "Q4692" },
  { code: "cubism", label: "Cubisme", qid: "Q42934" },
  { code: "fauvism", label: "Fauvisme", qid: "Q166593" },
  { code: "pointillism", label: "Pointillisme", qid: "Q200034" },
  { code: "naturalism", label: "Naturalisme", qid: "Q55995" },
];

const PAINTING_COUNTRIES = [
  { code: "fr", label: "France", qid: "Q142" },
  { code: "it", label: "Italie", qid: "Q38" },
  { code: "nl", label: "Pays-Bas", qid: "Q55" },
  { code: "es", label: "Espagne", qid: "Q29" },
  { code: "de", label: "Allemagne", qid: "Q183" },
  { code: "gb", label: "Royaume-Uni", qid: "Q145" },
  { code: "us", label: "États-Unis", qid: "Q30" },
  { code: "jp", label: "Japon", qid: "Q17" },
  { code: "cn", label: "Chine", qid: "Q148" },
  { code: "ru", label: "Russie", qid: "Q159" },
  { code: "be", label: "Belgique", qid: "Q31" },
  { code: "at", label: "Autriche", qid: "Q40" },
];

// bornes ajustées à la réalité observée (le domaine confirmé en public
// domain/CC sur Commons est très inégal dans le temps), pas du remplissage
// artificiel de catégories quasi vides.
// bornes toujours fermées des deux côtés : un intervalle ouvert (ex. "gte
// 1900" sans limite haute) s'est révélé capable de timeout sur Wikidata,
// contrairement aux plages bornées des deux côtés (systématiquement rapides
// en test).
const PAINTING_ERAS = [
  { code: "before_1500", label: "Avant 1500", gte: 0, lte: 1499 },
  { code: "1500_1699", label: "1500-1699", gte: 1500, lte: 1699 },
  { code: "1700_1799", label: "1700-1799", gte: 1700, lte: 1799 },
  { code: "1800_1849", label: "1800-1849", gte: 1800, lte: 1849 },
  { code: "1850_1899", label: "1850-1899", gte: 1850, lte: 1899 },
  { code: "1900_plus", label: "Après 1900", gte: 1900, lte: 2100 },
];

const PAINTING_QUERY_LIMIT = 200;

function paintingCategoryDefs() {
  const defs = {
    painting_popular: {
      paintingFilter: { kind: "popular" },
      label: "Peintres populaires",
      group: "liste",
      mediaType: "painting",
    },
  };
  for (const g of PAINTING_GENRES) {
    defs[`painting_genre_${g.code}`] = {
      paintingFilter: { kind: "genre", qid: g.qid },
      label: `${g.label} (Peintres)`,
      group: "genre",
      mediaType: "painting",
    };
  }
  for (const c of PAINTING_COUNTRIES) {
    defs[`painting_country_${c.code}`] = {
      paintingFilter: { kind: "country", qid: c.qid },
      label: `${c.label} (Peintres)`,
      group: "geography",
      mediaType: "painting",
    };
  }
  for (const e of PAINTING_ERAS) {
    defs[`painting_era_${e.code}`] = {
      paintingFilter: { kind: "era", gte: e.gte, lte: e.lte },
      label: `${e.label} (Peintres)`,
      group: "decade",
      mediaType: "painting",
    };
  }
  return defs;
}

// pas de SERVICE wikibase:label ici : sur les requêtes par plage de dates
// (FILTER(YEAR(...))), le combiner au label service fait timeout (observé
// empiriquement — jusqu'à 65s puis 504 — alors que la même requête sans le
// label service répond en < 1s). Les noms des créateurs sont donc résolus
// après coup, en un seul appel groupé (voir resolveWikidataLabels).
function paintingSparql(filter, limit) {
  let extra = "";
  if (filter.kind === "popular") {
    extra = "?item wikibase:sitelinks ?sl. FILTER(?sl >= 15)";
  } else if (filter.kind === "genre") {
    extra = `?item wdt:P135 wd:${filter.qid}.`;
  } else if (filter.kind === "country") {
    extra = `?creator wdt:P27 wd:${filter.qid}.`;
  } else if (filter.kind === "era") {
    extra = `?item wdt:P571 ?inception. FILTER(YEAR(?inception) >= ${filter.gte} && YEAR(?inception) <= ${filter.lte})`;
  }
  return (
    "SELECT ?item ?creator ?image ?portrait WHERE { " +
    "?item wdt:P31 wd:Q3305213; wdt:P170 ?creator; wdt:P18 ?image. " +
    // portrait du peintre lui-même (P18 sur son item, pas sur le tableau) —
    // c'est ce qu'on veut sur l'écran réponse, pas un tableau de plus. En
    // OPTIONAL : les peintres anciens n'ont pas toujours de portrait connu.
    "OPTIONAL { ?creator wdt:P18 ?portrait. } " +
    `${extra} ` +
    `} LIMIT ${limit}`
  );
}

// résout les labels (français, repli anglais) d'une liste de QID en un seul
// aller-retour groupé — l'API accepte jusqu'à 50 ids par appel.
async function resolveWikidataLabels(qids) {
  const labels = new Map();
  for (let i = 0; i < qids.length; i += 50) {
    const batch = qids.slice(i, i + 50);
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch.join("|")}&props=labels&languages=fr|en&format=json`;
    const data = await wikidataQuery(url);
    for (const [qid, ent] of Object.entries(data.entities || {})) {
      const label = ent.labels?.fr?.value || ent.labels?.en?.value;
      if (label) labels.set(qid, label);
    }
  }
  return labels;
}

// l'item du pool représente le PEINTRE, pas un tableau précis : on devine
// "qui a peint ça", et avec imagesPerItem > 1 on veut plusieurs TABLEAUX
// DIFFÉRENTS du même peintre, pas le même tableau répété. Les lignes
// renvoyées par la requête catégorie (jusqu'à PAINTING_QUERY_LIMIT tableaux)
// sont donc regroupées par créateur ; la liste complète des tableaux d'un
// peintre n'est récupérée qu'à la génération du quiz, voir fetchExtraBackdrops.
async function fetchPaintingCategory(def) {
  const data = await wikidataQuery(
    `https://query.wikidata.org/sparql?query=${encodeURIComponent(
      paintingSparql(def.paintingFilter, PAINTING_QUERY_LIMIT),
    )}`,
  );
  const byCreator = new Map(); // creatorQid -> { numId, image, portrait }
  for (const b of data.results?.bindings || []) {
    const creatorQid = b.creator?.value?.split("/").pop();
    const image = b.image?.value;
    // créateur "anonyme" : Wikidata sérialise les blank nodes en URI
    // "skolemisée" (.well-known/genid/...), pas en type "bnode" — b.creator.type
    // vaut "uri" même pour ces cas-là, donc on valide le format QID explicitement
    if (!creatorQid || !/^Q\d+$/.test(creatorQid) || !image) continue;
    if (!byCreator.has(creatorQid)) {
      byCreator.set(creatorQid, {
        numId: Number(creatorQid.slice(1)),
        image,
        portrait: b.portrait?.value || null,
      });
    } else if (!byCreator.get(creatorQid).portrait && b.portrait?.value) {
      // une ligne suivante du même créateur peut porter le portrait même si
      // la première ne l'avait pas (OPTIONAL peut varier selon la ligne)
      byCreator.get(creatorQid).portrait = b.portrait.value;
    }
  }
  if (byCreator.size === 0) return [];

  const labels = await resolveWikidataLabels([...byCreator.keys()]);
  const result = [];
  for (const [creatorQid, info] of byCreator) {
    const creator = labels.get(creatorQid);
    if (!creator) continue;
    result.push({
      // décalage large (voir fetchCountryCategory) : évite toute collision
      // avec des ids TMDb/IGDB/iTunes/pays réels si l'utilisateur mélange
      // peintures et un autre type dans le même quiz
      id: 2_000_000_000_000 + info.numId,
      title: creator,
      mediaType: "painting",
      painterQid: creatorQid,
      // portrait du peintre sur l'écran réponse (pas un tableau de plus) ;
      // repli sur un tableau si aucun portrait n'est connu pour ce peintre
      posterUrl: info.portrait || info.image,
    });
  }
  return result;
}

// tous les tableaux d'UN peintre (appelé à la génération du quiz, jamais au
// rafraîchissement du réservoir) — pas besoin du label service ici, on
// connaît déjà le nom du peintre depuis fetchPaintingCategory.
// IMPORTANT : comme pour les pays (getCachedCountryPhotos /
// fetchAndCacheCountryPhotos), la génération de quiz ne doit JAMAIS attendre
// un appel Wikidata en direct — batchSize dans selectItemsWithBackdrops
// essaie au moins 20 candidats même pour un petit lot, donc un quiz "lent"
// revenait à faire jusqu'à 20 requêtes Wikidata sérialisées d'affilée.
// getCachedPaintingsByArtist ne lit que le cache (instantané, [] si absent —
// ce peintre est alors simplement exclu du lot) ; seule
// paintingWarmLoop (tâche de fond) appelle fetchAndCachePaintingsByArtist.
function getCachedPaintingsByArtist(painterQid) {
  return cacheGet(`painter_paintings:${painterQid}`) || [];
}

async function fetchAndCachePaintingsByArtist(painterQid) {
  const cacheKey = `painter_paintings:${painterQid}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const sparql =
    "SELECT ?image WHERE { " +
    `?item wdt:P31 wd:Q3305213; wdt:P170 wd:${painterQid}; wdt:P18 ?image. ` +
    "} LIMIT 30";
  try {
    const data = await wikidataQuery(
      `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}`,
    );
    const seen = new Set();
    const images = [];
    for (const b of data.results?.bindings || []) {
      const image = b.image?.value;
      if (!image || seen.has(image)) continue;
      seen.add(image);
      images.push(image);
    }
    cacheSet(cacheKey, images);
    return images;
  } catch (e) {
    console.error(`Erreur tableaux peintre "${painterQid}":`, e.message);
    return [];
  }
}

// chauffe le cache "tableaux par peintre" en tâche de fond, comme
// countryPhotoWarmLoop — sinon un peintre non encore vu doit être requêté en
// direct pendant la génération du quiz (lent, voir les fonctions ci-dessus).
async function paintingWarmLoop() {
  for (;;) {
    let sleepMs = 60 * 60 * 1000; // repasse dans 1h par défaut
    try {
      const painterQids = new Set();
      for (const [key, def] of Object.entries(CATEGORIES)) {
        if (def.mediaType !== "painting") continue;
        for (const p of reservoirByCategory[key] || []) {
          if (p.painterQid) painterQids.add(p.painterQid);
        }
      }
      if (painterQids.size === 0) {
        // le réservoir n'a pas encore fini son premier passage (démarrage) —
        // réessaie bientôt plutôt que d'attendre 1h pour rien
        sleepMs = 10_000;
      } else {
        const toWarm = [...painterQids].filter(
          (qid) => !cacheGet(`painter_paintings:${qid}`),
        );
        paintingWarmReady = toWarm.length === 0;
        console.log(
          `Peintres : cache tableaux — ${painterQids.size - toWarm.length}/${painterQids.size} déjà chauds, ${toWarm.length} à récupérer…`,
        );
        let warmed = 0;
        for (const qid of toWarm) {
          const t0 = Date.now();
          const images = await fetchAndCachePaintingsByArtist(qid);
          warmed++;
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(
            `Peintres : ${warmed}/${toWarm.length} — ${qid} (${images.length} tableaux, ${elapsed}s)`,
          );
          // persistance incrémentale : un passage complet peut prendre de
          // longues minutes (des centaines de peintres) — sans ça, un
          // redémarrage avant la fin du tout premier passage ne retrouverait
          // aucune progression sur disque
          if (warmed % 50 === 0) {
            persistCacheSubset(PAINTING_WARM_CACHE_PATH, "painter_paintings:");
          }
        }
        paintingWarmReady = true;
        persistCacheSubset(PAINTING_WARM_CACHE_PATH, "painter_paintings:");
        console.log(
          `Peintres : passage de warm-cache terminé — ${painterQids.size} peintres en cache. Prochain passage dans 1h.`,
        );
      }
    } catch (e) {
      console.error("Erreur warm cache tableaux peintres:", e.message);
    }
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}

// les liens Special:FilePath renvoyés par Wikidata redirigent (301/302) vers
// le vrai fichier sur upload.wikimedia.org — la chaîne de redirection casse
// le CORS dans un vrai navigateur (observé : "blocked by CORS policy" alors
// que la réponse finale a bien Access-Control-Allow-Origin, curl ne
// reproduit pas ce problème car il n'applique pas CORS). On résout donc
// l'URL directe via l'API Commons avant de la donner au client. Mis en
// cache : l'URL résolue d'un fichier donné ne change pas.
// calculée, pas de requête réseau : Wikimedia range les fichiers Commons
// dans un répertoire dérivé du MD5 du nom de fichier (convention stable,
// documentée, vérifiée manuellement contre l'API pour plusieurs noms avec
// caractères spéciaux — résultat identique). Une résolution via l'API
// (prop=imageinfo) fonctionnait aussi mais ajoutait ~1 aller-retour Wikidata
// par image, ce qui faisait grimper une génération de quiz à plusieurs
// minutes (toutes les requêtes peinture partagent la même file sérialisée).
// Le service de miniatures accepte une largeur plus grande que l'original
// sans erreur (il sert juste l'image à sa taille native), donc pas besoin de
// connaître les dimensions réelles au préalable.
// formats source non affichables tels quels par un navigateur (scans TIFF de
// musées surtout, parfois PDF/XCF) : la miniature est un JPEG, mais son nom
// de fichier garde l'extension d'origine EN PLUS de ".jpg" à la fin
// (ex: "...Gallery.tiff/1280px-...Gallery.tiff.jpg") — sans ça, 400 Bad Request.
const COMMONS_WEB_SAFE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

function commonsThumbUrl(specialFilePathUrl, width = 1280) {
  const filename = decodeURIComponent(
    specialFilePathUrl.split("/").pop().split("?")[0],
  ).replace(/ /g, "_");
  const md5 = createHash("md5").update(filename).digest("hex");
  const dir = `${md5[0]}/${md5.slice(0, 2)}`;
  const encoded = encodeURIComponent(filename);
  const ext = filename.split(".").pop().toLowerCase();
  const thumbName = COMMONS_WEB_SAFE_EXT.has(ext)
    ? `${width}px-${encoded}`
    : `${width}px-${encoded}.jpg`;
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${dir}/${encoded}/${thumbName}`;
}

let CATEGORIES = { ...STATIC_LISTS };
let reservoirByCategory = {};
let reservoirReady = false;
// bascule à true/false par chaque warm loop selon qu'il reste ou non des
// éléments non chauffés à son passage courant — sert uniquement à la LED de
// statut serveur exposée par /api/stats
let paintingWarmReady = false;
let countryWarmReady = false;

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

// Pexels (photos pays) : palier gratuit à 200 req/heure. Le cache long (voir
// COUNTRY_PHOTOS_TTL_MS) fait que ce budget n'est consommé qu'en tâche de
// fond (countryPhotoWarmLoop), jamais pendant la génération d'un quiz — d'où
// un espacement volontairement large (~20s, ~180 req/h avec marge) plutôt
// qu'une simple limite de débit instantané.
let pexelsQueueTail = Promise.resolve();
const PEXELS_MIN_INTERVAL_MS = 20_000;

async function pexelsJSON(url) {
  const previous = pexelsQueueTail;
  let releaseTurn;
  pexelsQueueTail = new Promise((r) => (releaseTurn = r));
  await previous;

  try {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { Authorization: PEXELS_API_KEY },
        });
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const delay = retryAfter > 0 ? retryAfter * 1000 : 60_000 * attempt;
          lastErr = new Error(`Pexels 429 sur ${url}`);
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw lastErr;
        }
        if (!res.ok) throw new Error(`Pexels ${res.status} sur ${url}`);
        return await res.json();
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    throw lastErr;
  } finally {
    await new Promise((r) => setTimeout(r, PEXELS_MIN_INTERVAL_MS));
    releaseTurn();
  }
}

// Wikidata (peintures) : endpoint public, pas de clé, mais renvoie parfois
// des 429/502/504 même sur des requêtes simples — sérialisé + retry comme
// les autres, par politesse et par fiabilité (observé empiriquement).
let wikidataQueueTail = Promise.resolve();
const WIKIDATA_MIN_INTERVAL_MS = 800;

// `url` est l'URL complète (endpoint SPARQL déjà construit avec ?query=...,
// ou endpoint wbgetentities pour la résolution de labels) — un seul gate
// partagé pour rester poli avec les deux domaines Wikidata.
async function wikidataQuery(url) {
  const previous = wikidataQueueTail;
  let releaseTurn;
  wikidataQueueTail = new Promise((r) => (releaseTurn = r));
  await previous;

  try {
    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        // fetch() n'a pas de timeout par défaut — sans ça, une requête qui
        // reste bloquée gèle toute la file sérialisée derrière elle (observé :
        // une génération de quiz qui ne finissait jamais)
        const res = await fetch(url, {
          headers: {
            Accept: "application/sparql-results+json",
            "User-Agent": "GuessItQuiz/1.0 (personal project)",
          },
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 429) {
          // avec autant de catégories peinture (populaire + genres + pays +
          // époques, chacune faisant 2+ appels), même espacées de 500ms,
          // Wikidata finit par 429 — backoff généreux, honore Retry-After
          const retryAfter = Number(res.headers.get("retry-after"));
          const delay = retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
          lastErr = new Error("Wikidata 429");
          if (attempt < 5) {
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw lastErr;
        }
        if (!res.ok) throw new Error(`Wikidata ${res.status}`);
        return await res.json();
      } catch (e) {
        lastErr = e;
        if (attempt < 5)
          await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    throw lastErr;
  } finally {
    await new Promise((r) => setTimeout(r, WIKIDATA_MIN_INTERVAL_MS));
    releaseTurn();
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

// pas d'appel réseau (juste des clés/labels fixes) : pas besoin de les
// réduire en mode dev comme les genres/décennies TMDb/IGDB.
function countryCategoryDefs() {
  if (!pexelsEnabled) return {};
  const defs = {
    country_all: {
      region: null,
      label: "Tous les pays",
      group: "geography",
      mediaType: "country",
    },
  };
  for (const c of COUNTRY_CONTINENTS) {
    defs[`country_${c.code}`] = {
      region: c.region,
      label: `${c.label} (Pays)`,
      group: "geography",
      mediaType: "country",
    };
  }
  return defs;
}

// --only : supprime du pool final tout ce qui n'est pas demandé — filet de
// sécurité qui s'applique même aux defs "statiques" (spread sans condition
// ci-dessous) : c'est cette étape, pas les gardes onlyWants(), qui empêche
// refreshReservoir() d'aller fetcher les catégories non voulues.
function filterOnlyTypes(defs) {
  if (!ONLY_TYPES) return defs;
  for (const key of Object.keys(defs)) {
    if (!onlyWants(defs[key].mediaType)) delete defs[key];
  }
  return defs;
}

async function buildCategoryDefs() {
  // mode dev : seulement les listes "populaires" de chaque média, aucun appel
  // genres/décennies (ce sont eux qui multiplient le nombre de catégories)
  if (DEV_MODE) {
    const devDefs = {
      ...STATIC_LISTS,
      ...TV_STATIC_LISTS,
      ...PERSON_STATIC_LISTS,
      ...MUSIC_STATIC_LISTS,
      ...countryCategoryDefs(),
      painting_popular: paintingCategoryDefs().painting_popular,
    };
    if (igdbEnabled) Object.assign(devDefs, GAME_STATIC_LISTS);
    return filterOnlyTypes(devDefs);
  }

  const defs = {
    ...STATIC_LISTS,
    ...DECADE_LISTS,
    ...TV_STATIC_LISTS,
    ...TV_DECADE_LISTS,
    ...PERSON_STATIC_LISTS,
    ...countryCategoryDefs(),
    ...paintingCategoryDefs(),
  };
  if (onlyWants("movie")) {
    try {
      const genreData = await tmdbJSON(
        `https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_KEY}&language=fr-FR`,
      );
      for (const g of genreData.genres || []) {
        defs[`genre_${g.id}`] = {
          pathAndQuery: `discover/movie?with_genres=${g.id}&sort_by=popularity.desc`,
          pages: 6,
          label: `${g.name} (Films)`,
          group: "genre",
          mediaType: "movie",
        };
      }
    } catch (e) {
      console.error("Erreur récupération des genres films:", e.message);
    }
  }
  if (onlyWants("tv")) {
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
  }
  if (igdbEnabled && onlyWants("game")) {
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
  if (onlyWants("music")) {
    Object.assign(defs, MUSIC_STATIC_LISTS);
    try {
      const genreRes = await fetch(
        "https://itunes.apple.com/WebObjects/MZStoreServices.woa/ws/genres?id=34",
      );
      if (!genreRes.ok) throw new Error(`iTunes genres ${genreRes.status}`);
      const genreData = await genreRes.json();
      const subgenres = genreData["34"]?.subgenres || {};
      for (const [id, g] of Object.entries(subgenres)) {
        defs[`music_genre_${id}`] = {
          genreId: id,
          country: MUSIC_GENRE_STORE,
          label: `${g.name} (Musique)`,
          group: "genre",
          mediaType: "music",
        };
      }
    } catch (e) {
      console.error("Erreur récupération des genres musique:", e.message);
    }
  }
  for (const bucket of MUSIC_DECADE_BOUNDS) {
    defs[bucket.key] = {
      derived: true,
      label: bucket.label,
      group: "decade",
      mediaType: "music",
    };
  }
  for (const target of COUNTRY_TARGETS) {
    defs[`person_country_${target.code}`] = {
      originCountry: target.code.toUpperCase(),
      pages: PERSON_COUNTRY_MOVIE_PAGES,
      label: target.name,
      group: "geography",
      mediaType: "person",
    };
  }
  if (onlyWants("movie")) {
    for (const target of COUNTRY_TARGETS) {
      defs[`movie_country_${target.code}`] = {
        pathAndQuery: `discover/movie?with_origin_country=${target.code.toUpperCase()}&sort_by=popularity.desc`,
        pages: MOVIE_COUNTRY_PAGES,
        label: target.name,
        group: "geography",
        mediaType: "movie",
      };
    }
  }
  for (const bucket of PERSON_DECADE_BOUNDS) {
    defs[bucket.key] = {
      derived: true,
      label: bucket.label,
      group: "decade",
      mediaType: "person",
    };
  }
  return filterOnlyTypes(defs);
}

async function fetchGameCategory(def) {
  const seen = new Map();
  const limit = 100;
  // pages en concurrence, comme fetchCategory — on perd l'arrêt anticipé
  // (data.length < limit) que permettait la version séquentielle, mais
  // def.pages est déjà un plafond raisonnable et quelques requêtes IGDB à
  // vide en fin de catégorie coûtent bien moins cher que d'attendre chaque
  // page l'une après l'autre.
  const pageIdxs = Array.from({ length: def.pages }, (_, i) => i);
  await mapWithConcurrency(pageIdxs, PAGE_FETCH_CONCURRENCY, async (i) => {
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
  });
  return [...seen.values()];
}

// genres musique : flux RSS classique iTunes (topsongs?genre=), qui contient
// déjà l'extrait audio et l'illustration — pas besoin de repasser par l'API
// Lookup comme pour les listes par pays (flux "most-played" plus récent, qui
// ne les fournit pas mais ne supporte pas non plus le filtre par genre)
async function fetchMusicGenreCategory(def) {
  const url = `https://itunes.apple.com/${def.country}/rss/topsongs/limit=100/genre=${def.genreId}/json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`iTunes RSS ${res.status} sur ${url}`);
  const data = await res.json();
  const entries = data.feed?.entry || [];
  const result = [];
  for (const e of entries) {
    const trackId = e.id?.attributes?.["im:id"];
    const track = e["im:name"]?.label;
    const artist = e["im:artist"]?.label;
    const links = Array.isArray(e.link) ? e.link : [e.link].filter(Boolean);
    const preview = links.find((l) => l?.attributes?.rel === "enclosure");
    const images = e["im:image"] || [];
    const artwork = images[images.length - 1]?.label;
    if (!trackId || !track || !artist || !preview || !artwork) continue;
    result.push({
      id: Number(trackId),
      title: `${artist} — ${track}`,
      artist,
      track,
      mediaType: "music",
      previewUrl: preview.attributes.href,
      posterUrl: artwork.replace(/\d+x\d+bb/, "600x600bb"),
      releaseDate: e["im:releaseDate"]?.label,
    });
  }
  return result;
}

// musique : le flux RSS Apple donne le classement mais pas l'extrait audio —
// on complète via l'API Lookup iTunes (par lots d'IDs) pour récupérer previewUrl
async function fetchMusicCategory(def) {
  if (def.genreId) return fetchMusicGenreCategory(def);
  const chartUrl = `https://rss.applemarketingtools.com/api/v2/${def.country}/music/most-played/100/songs.json`;
  const chartRes = await fetch(chartUrl);
  if (!chartRes.ok)
    throw new Error(`Apple RSS ${chartRes.status} sur ${chartUrl}`);
  const chartData = await chartRes.json();
  const ids = (chartData.feed?.results || []).map((i) => i.id).filter(Boolean);
  if (ids.length === 0) return [];

  const entries = new Map();
  const batchSize = 150;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batchIds = ids.slice(i, i + batchSize).join(",");
    const lookupRes = await fetch(
      `https://itunes.apple.com/lookup?id=${batchIds}&entity=song`,
    );
    if (!lookupRes.ok) continue;
    const lookupData = await lookupRes.json();
    for (const t of lookupData.results || []) {
      if (
        !t.previewUrl ||
        !t.trackName ||
        !t.artistName ||
        !t.artworkUrl100 ||
        entries.has(t.trackId)
      )
        continue;
      entries.set(t.trackId, {
        id: t.trackId,
        title: `${t.artistName} — ${t.trackName}`,
        artist: t.artistName,
        track: t.trackName,
        mediaType: "music",
        previewUrl: t.previewUrl,
        // artworkUrl100 est en 100x100 par défaut ; on force une résolution plus grande
        posterUrl: t.artworkUrl100.replace("100x100", "600x600"),
        releaseDate: t.releaseDate,
      });
    }
  }
  return [...entries.values()];
}

// pool d'acteurs pour un pays donné : part des films populaires DE ce pays
// (discover/movie?with_origin_country=XX) plutôt que de filtrer une liste
// globale par lieu de naissance — voir le commentaire sur COUNTRY_TARGETS.
async function fetchPersonCountryCategory(def) {
  const movieIds = [];
  const moviePages = Array.from({ length: def.pages }, (_, i) => i + 1);
  await mapWithConcurrency(moviePages, PAGE_FETCH_CONCURRENCY, async (page) => {
    const data = await tmdbJSON(
      `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&language=fr-FR&sort_by=popularity.desc&with_origin_country=${def.originCountry}&page=${page}`,
    );
    for (const m of data.results || []) movieIds.push(m.id);
  });

  const seen = new Map();
  await mapWithConcurrency(movieIds, PAGE_FETCH_CONCURRENCY, async (movieId) => {
    if (seen.size >= PERSON_COUNTRY_TARGET_ACTORS) return;
    try {
      const data = await tmdbJSON(
        `https://api.themoviedb.org/3/movie/${movieId}/credits?api_key=${TMDB_KEY}&language=fr-FR`,
      );
      for (const c of (data.cast || []).slice(0, PERSON_COUNTRY_CAST_PER_MOVIE)) {
        if (!c.profile_path || seen.has(c.id)) continue;
        seen.set(c.id, toEntry(c, "person"));
      }
    } catch (e) {
      // un film sans crédits accessibles ne doit pas faire échouer toute la catégorie
    }
  });
  return [...seen.values()];
}

async function fetchCategory(def) {
  if (def.mediaType === "game") return fetchGameCategory(def);
  if (def.mediaType === "music") return fetchMusicCategory(def);
  if (def.mediaType === "country") return fetchCountryCategory(def);
  if (def.mediaType === "painting") return fetchPaintingCategory(def);
  if (def.originCountry) return fetchPersonCountryCategory(def);
  const seen = new Map();
  const pages = Array.from({ length: def.pages }, (_, i) => i + 1);
  // pages en concurrence (voir CATEGORY_FETCH_CONCURRENCY plus haut) : l'ordre
  // n'a pas d'importance, on ne fait que fusionner dans `seen` par id
  await mapWithConcurrency(pages, PAGE_FETCH_CONCURRENCY, async (page) => {
    const data = await tmdbJSON(urlFor(def.pathAndQuery, page));
    for (const m of data.results || []) {
      const valid =
        def.mediaType === "person"
          ? Boolean(m.profile_path)
          : Boolean(m.backdrop_path) && Boolean(m.poster_path);
      if (!valid || seen.has(m.id)) continue;
      seen.set(m.id, toEntry(m, def.mediaType));
    }
  });
  return [...seen.values()];
}

// empreinte de ce qui a produit un cache disque donné : version de l'appli
// + flags/config qui changent la FORME du réservoir (--only, clés API
// activées). Si l'un de ces éléments diffère de maintenant, le cache est
// ignoré entièrement plutôt que rechargé partiellement — un cache "--only=painting"
// ne doit jamais se faire passer pour un réservoir complet, silencieusement.
function reservoirCacheFingerprint() {
  return JSON.stringify({
    version: APP_VERSION,
    only: ONLY_TYPES ? [...ONLY_TYPES].sort() : null,
    igdbEnabled,
    pexelsEnabled,
  });
}

function loadReservoirCache() {
  try {
    if (!existsSync(RESERVOIR_CACHE_PATH)) {
      console.log(
        "Réservoir : aucun cache disque trouvé (premier démarrage sur cette machine, ou cache/ vidé).",
      );
      return null;
    }
    const raw = JSON.parse(readFileSync(RESERVOIR_CACHE_PATH, "utf8"));
    if (raw.fingerprint !== reservoirCacheFingerprint()) {
      console.log(
        "Réservoir : cache disque ignoré (version ou configuration différente depuis son écriture).",
      );
      return null;
    }
    const ageMs = Date.now() - raw.writtenAt;
    if (ageMs > RESERVOIR_CACHE_TTL_MS) {
      console.log(
        `Réservoir : cache disque ignoré (âgé de ${(ageMs / 86400000).toFixed(1)}j, max ${(RESERVOIR_CACHE_TTL_MS / 86400000).toFixed(0)}j).`,
      );
      return null;
    }
    return raw;
  } catch (e) {
    console.error("Erreur lecture cache réservoir:", e.message);
    return null;
  }
}

function saveReservoirCache(categories) {
  try {
    writeJsonAtomic(RESERVOIR_CACHE_PATH, {
      fingerprint: reservoirCacheFingerprint(),
      writtenAt: Date.now(),
      categories,
    });
  } catch (e) {
    console.error("Erreur écriture cache réservoir:", e.message);
  }
}

// deux cadences indépendantes tournent en parallèle (voir les setInterval en
// bas de fichier) : `includeVolatile` seul toutes les 6h (now_playing,
// trending, etc.), `includeStable` seul toutes les semaines (tout le reste —
// c'est aussi la cadence de rafraîchissement naturelle du cache disque,
// même valeur que RESERVOIR_CACHE_TTL_MS). Chaque passage ne touche QUE les
// catégories de son tiers, fusionnées dans le réservoir existant, pour ne
// jamais écraser l'autre tiers avec du vide. `useDiskCache` n'est vrai qu'au
// tout premier démarrage.
async function refreshReservoir({
  useDiskCache = false,
  includeVolatile = true,
  includeStable = true,
} = {}) {
  const startTs = Date.now();
  CATEGORIES = await buildCategoryDefs();
  if (DEV_MODE) {
    for (const def of Object.values(CATEGORIES)) {
      if (def.pages) def.pages = Math.min(def.pages, DEV_MAX_PAGES);
    }
  }
  const fetchable = Object.entries(CATEGORIES).filter(([, def]) => {
    if (def.derived) return false;
    return def.volatile ? includeVolatile : includeStable;
  });

  const next = {};
  // en mode dev, le réservoir est déjà volontairement réduit (--dev) : ne
  // jamais lire/écrire le cache disque, sinon un futur démarrage en prod
  // complet risquerait de reprendre un cache réduit par erreur
  let diskCache = null;
  if (!useDiskCache) {
    console.log(
      "Réservoir : cache disque non consulté (rafraîchissement périodique, toujours en direct).",
    );
  } else if (DEV_MODE) {
    console.log("Réservoir : cache disque non consulté (mode dev).");
  } else {
    diskCache = loadReservoirCache();
  }
  const toFetch = [];
  if (diskCache) {
    for (const entry of fetchable) {
      const [key, def] = entry;
      if (!def.volatile && diskCache.categories[key]) {
        next[key] = diskCache.categories[key];
      } else {
        toFetch.push(entry);
      }
    }
    const cacheAgeH = (
      (Date.now() - diskCache.writtenAt) /
      3_600_000
    ).toFixed(1);
    console.log(
      `Réservoir : cache disque valide (écrit il y a ${cacheAgeH}h) — ${fetchable.length - toFetch.length}/${fetchable.length} catégories reprises telles quelles, ${toFetch.length} à récupérer (volatiles ou absentes du cache).`,
    );
  } else {
    toFetch.push(...fetchable);
  }

  console.log(
    `Réservoir : démarrage du rafraîchissement (${toFetch.length} catégories à récupérer)…`,
  );
  let done = 0;
  // catégories en concurrence (voir CATEGORY_FETCH_CONCURRENCY plus haut) —
  // chaque catégorie fetch elle-même ses pages en concurrence (voir
  // fetchCategory/fetchGameCategory), les deux niveaux se contentent de
  // garder les files tmdbGate/igdbGate pleines, elles restent la vraie
  // limite de débit quel que soit le nombre d'appelants.
  await mapWithConcurrency(toFetch, CATEGORY_FETCH_CONCURRENCY, async ([key, def]) => {
    console.log(`Réservoir : → "${key}"…`);
    const catStartTs = Date.now();
    try {
      next[key] = await fetchCategory(def);
    } catch (e) {
      console.error(`Erreur catégorie "${key}":`, e.message);
      next[key] = reservoirByCategory[key] || [];
    }
    done++;
    const pct = Math.round((done / toFetch.length) * 100);
    const catElapsed = ((Date.now() - catStartTs) / 1000).toFixed(1);
    console.log(
      `Réservoir : ${done}/${toFetch.length} (${pct}%) — "${key}" terminée en ${catElapsed}s (${next[key].length} items)`,
    );
  });

  // décennies musique : pas de requête dédiée (Apple n'expose que le
  // classement courant) — on redispatche les titres déjà récupérés (listes +
  // genres, dédupliqués) selon leur releaseDate plutôt que d'aller en chercher
  // de nouveaux. Absentes en mode dev (buildCategoryDefs ne les crée pas).
  // Uniquement sur un passage qui inclut le tiers stable : la musique n'a
  // aucune catégorie volatile, donc `next` serait vide côté musique sur un
  // passage volatile-only, et écraserait les décennies avec du vide.
  if (includeStable) {
    const musicDecadeKeys = Object.entries(CATEGORIES)
      .filter(([, def]) => def.derived && def.mediaType === "music")
      .map(([key]) => key);
    const musicByDecade = new Map(musicDecadeKeys.map((k) => [k, new Map()]));
    for (const [key, def] of Object.entries(CATEGORIES)) {
      if (def.mediaType !== "music" || def.derived) continue;
      for (const track of next[key] || []) {
        const year = track.releaseDate
          ? new Date(track.releaseDate).getFullYear()
          : NaN;
        if (Number.isNaN(year)) continue;
        const bucket = MUSIC_DECADE_BOUNDS.find(
          (b) => year >= b.minYear && year <= b.maxYear,
        );
        if (bucket && musicByDecade.has(bucket.key)) {
          musicByDecade.get(bucket.key).set(track.id, track);
        }
      }
    }
    for (const [key, tracks] of musicByDecade) next[key] = [...tracks.values()];

    // décennies acteurs : TMDb ne permet pas de filtrer /discover/person par
    // date de naissance — on repart des acteurs déjà récupérés (populaires +
    // par pays, dédupliqués) et on appelle /person/{id} pour sa date de
    // naissance (cache ~1 mois, voir PERSON_BIRTHDAY_TTL_MS : une date de
    // naissance ne change jamais, donc la quasi-totalité des acteurs déjà
    // vus n'est pas re-demandée aux rafraîchissements suivants). Un acteur
    // sans date de naissance exploitable exclut juste l'acteur de ces
    // catégories — il reste disponible partout ailleurs.
    const personDecadeKeys = PERSON_DECADE_BOUNDS.map((b) => b.key).filter(
      (k) => CATEGORIES[k],
    );
    if (personDecadeKeys.length > 0) {
      const persons = new Map();
      for (const [key, def] of Object.entries(CATEGORIES)) {
        if (def.mediaType !== "person" || def.derived) continue;
        for (const p of next[key] || []) persons.set(p.id, p);
      }
      console.log(
        `Réservoir : décennies acteurs — ${persons.size} acteurs à vérifier (cache ~1 mois, donc rapide après le premier passage)…`,
      );
      const personByDecade = new Map(personDecadeKeys.map((k) => [k, new Map()]));
      let personDone = 0;
      await mapWithConcurrency(
        [...persons.values()],
        IMAGE_FETCH_CONCURRENCY,
        async (p) => {
          const cacheKey = `person_birthday:${p.id}`;
          let birthday = cacheGet(cacheKey);
          if (birthday === null) {
            try {
              const data = await tmdbJSON(
                `https://api.themoviedb.org/3/person/${p.id}?api_key=${TMDB_KEY}`,
              );
              birthday = data.birthday || "";
              cacheSet(cacheKey, birthday, PERSON_BIRTHDAY_TTL_MS);
            } catch (e) {
              birthday = null;
            }
          }
          personDone++;
          if (personDone % 100 === 0 || personDone === persons.size) {
            console.log(
              `Réservoir : décennies acteurs ${personDone}/${persons.size}`,
            );
          }
          if (!birthday) return;
          const year = new Date(birthday).getFullYear();
          if (Number.isNaN(year)) return;
          const bucket = PERSON_DECADE_BOUNDS.find(
            (b) => year >= b.minYear && year <= b.maxYear,
          );
          if (bucket) personByDecade.get(bucket.key).set(p.id, p);
        },
      );
      for (const [key, people] of personByDecade) next[key] = [...people.values()];
    }
  }

  const wasReady = reservoirReady;
  reservoirByCategory = { ...reservoirByCategory, ...next };
  reservoirReady = Object.values(reservoirByCategory).some(
    (list) => list.length > 0,
  );
  const elapsedSec = ((Date.now() - startTs) / 1000).toFixed(1);
  console.log(
    `Réservoir rafraîchi en ${elapsedSec}s : ${Object.keys(CATEGORIES).length} catégories.${
      DEV_MODE
        ? ` (mode dev : listes "populaires" uniquement, ${DEV_MAX_PAGES} page/catégorie max)`
        : ""
    }`,
  );
  if (!wasReady && reservoirReady) {
    console.log(
      "Serveur opérationnel — /api/quiz-batch peut désormais répondre.",
    );
  }
  // uniquement sur un passage qui inclut le tiers stable (sinon on écrirait
  // un cache disque qui ne reflète que les catégories volatiles) ; jamais en
  // mode dev (voir plus haut) — un réservoir réduit ne doit jamais pouvoir
  // être repris par un futur démarrage en prod complet.
  if (includeStable && !DEV_MODE) saveReservoirCache(reservoirByCategory);
}

refreshReservoir({ useDiskCache: true }); // démarrage : tout, stable depuis le cache disque si valide
setInterval(
  () => refreshReservoir({ includeStable: false }),
  VOLATILE_REFRESH_MS,
).unref();
setInterval(
  () => refreshReservoir({ includeVolatile: false }),
  RESERVOIR_CACHE_TTL_MS,
).unref();

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

// répartit `count` aussi équitablement que possible entre les catégories
// sélectionnées (ex: acteurs + jeux + films populaires -> ~1/3 de chaque),
// au lieu de piocher dans le pool fusionné où les grosses catégories
// écraseraient statistiquement les petites. Comble les manques (catégorie
// trop petite) en piochant ailleurs pour quand même atteindre `count`.
function stratifiedSelection(categoryKeys, count, excludeIds) {
  const n = categoryKeys.length;
  if (n === 0) return [];

  const perCategoryPools = categoryKeys.map((key) =>
    shuffle(
      (reservoirByCategory[key] || []).filter((m) => !excludeIds.has(m.id)),
    ),
  );

  const baseShare = Math.floor(count / n);
  const remainder = count - baseShare * n;
  // le reste (division non entière) est distribué à des catégories tirées
  // au hasard plutôt que toujours aux premières de la liste
  const remainderIdx = new Set(
    shuffle([...Array(n).keys()]).slice(0, remainder),
  );
  const shares = perCategoryPools.map(
    (_, i) => baseShare + (remainderIdx.has(i) ? 1 : 0),
  );

  const primary = [];
  const pickedIds = new Set();
  const poolIdx = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    let taken = 0;
    while (taken < shares[i] && poolIdx[i] < perCategoryPools[i].length) {
      const item = perCategoryPools[i][poolIdx[i]++];
      if (pickedIds.has(item.id)) continue; // déjà pris via une autre catégorie (chevauchement)
      pickedIds.add(item.id);
      primary.push(item);
      taken++;
    }
  }

  // comble le manque si une catégorie était trop petite pour sa part
  if (primary.length < count) {
    const shortfall = shuffle(
      perCategoryPools
        .flatMap((pool, i) => pool.slice(poolIdx[i]))
        .filter((m) => !pickedIds.has(m.id)),
    );
    for (const item of shortfall) {
      if (primary.length >= count) break;
      pickedIds.add(item.id);
      primary.push(item);
    }
  }

  // réserve : tout ce qui reste, mélangé — permet à l'appelant de remplacer
  // les titres dont la récupération d'images échoue, sans sous-livrer
  const reserve = shuffle(
    perCategoryPools
      .flatMap((pool) => pool)
      .filter((m) => !pickedIds.has(m.id)),
  );

  return shuffle(primary).concat(reserve);
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
// la géographie ne change pas d'un rafraîchissement à l'autre : cache
// beaucoup plus long que le TTL générique pour ne pas re-consommer le budget
// Pexels (200 req/h) inutilement.
const COUNTRY_PHOTOS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const apiCache = new Map(); // key -> { value, expiresAt }

function cacheGet(key) {
  const c = apiCache.get(key);
  if (c && c.expiresAt > Date.now()) return c.value;
  return null;
}
function cacheSet(key, value, ttlMs = CACHE_TTL_MS) {
  apiCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// persiste sur disque le sous-ensemble d'apiCache dont la clé commence par
// `keyPrefix` (ex: toutes les entrées "painter_paintings:") — sert à ne pas
// reperdre tout le travail d'un warm loop à chaque redémarrage. Une seule
// entrée expirée n'invalide pas les autres : chacune garde son propre
// expiresAt, vérifié à nouveau au rechargement.
function persistCacheSubset(filePath, keyPrefix) {
  const entries = {};
  for (const [key, entry] of apiCache.entries()) {
    if (key.startsWith(keyPrefix) && entry.expiresAt > Date.now()) {
      entries[key] = entry;
    }
  }
  try {
    writeJsonAtomic(filePath, { writtenAt: Date.now(), entries });
  } catch (e) {
    console.error(`Erreur écriture cache ${filePath}:`, e.message);
  }
}

function loadCacheSubset(filePath) {
  const name = path.basename(filePath);
  try {
    if (!existsSync(filePath)) {
      console.log(`Cache disque : aucun fichier ${name} trouvé, on repart de zéro.`);
      return;
    }
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    let loaded = 0;
    let expired = 0;
    for (const [key, entry] of Object.entries(raw.entries || {})) {
      if (entry.expiresAt > Date.now()) {
        apiCache.set(key, entry);
        loaded++;
      } else {
        expired++;
      }
    }
    console.log(
      `Cache disque : ${loaded} entrées rechargées depuis ${name}${expired > 0 ? ` (${expired} expirées ignorées)` : ""}.`,
    );
  } catch (e) {
    console.error(`Erreur lecture cache ${filePath}:`, e.message);
  }
}

// toutes les fonctions ci-dessous renvoient un format uniforme :
// { url, iso_639_1, vote_count, aspect_ratio } — quelle que soit la source
// (TMDb backdrops/profiles/stills ou captures IGDB), pour que
// fetchExtraBackdrops puisse les traiter de la même façon.

async function fetchRawBackdrops(item) {
  const kind =
    item.mediaType === "tv"
      ? "tv"
      : item.mediaType === "person"
        ? "person"
        : "movie";
  const cacheKey = `backdrops:${kind}:${item.id}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await tmdbJSON(
    `https://api.themoviedb.org/3/${kind}/${item.id}/images?api_key=${TMDB_KEY}`,
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

// pays : Pexels n'a pas de notion de "textless"/vote par image (donc
// iso_639_1 null, vote_count à 1, comme IGDB). Deux recherches par pays
// ("<pays> landmark" + "<pays> landscape") pour un pool varié.
//
// IMPORTANT : à ~20s/requête via pexelsGate (voir plus haut), un pays non
// encore en cache prend ~40s à récupérer — bien trop lent pour la génération
// d'un quiz (`fetchExtraBackdrops` y perdrait des minutes). L'appel réseau
// réel (fetchAndCacheCountryPhotos) n'est donc fait QUE par
// countryPhotoWarmLoop, en tâche de fond ; `getCachedCountryPhotos` (utilisé
// par fetchExtraBackdrops) ne lit que le cache et renvoie [] instantanément
// si le pays n'est pas encore chaud — ce pays est alors simplement exclu du
// lot (comme n'importe quel item sans image exploitable), en attendant que
// la boucle de fond l'ait couvert.
function getCachedCountryPhotos(name) {
  return cacheGet(`country_photos:${name}`) || [];
}

async function fetchAndCacheCountryPhotos(name) {
  const cacheKey = `country_photos:${name}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const seen = new Map();
    for (const suffix of ["landmark", "landscape"]) {
      const data = await pexelsJSON(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(`${name} ${suffix}`)}&per_page=15&orientation=landscape`,
      );
      for (const p of data.photos || []) {
        if (!p.src?.large || !p.width || !p.height || seen.has(p.id)) continue;
        seen.set(p.id, {
          url: p.src.large,
          iso_639_1: null,
          vote_count: 1,
          aspect_ratio: p.width / p.height,
        });
      }
    }
    const photos = [...seen.values()];
    cacheSet(cacheKey, photos, COUNTRY_PHOTOS_TTL_MS);
    return photos;
  } catch (e) {
    console.error(`Erreur photos Pexels "${name}":`, e.message);
    return [];
  }
}

// chauffe le cache photos pays en tâche de fond, indépendamment du cycle de
// refreshReservoir (30 min) : à ~40s/pays, un passage complet sur ~245 pays
// prend plusieurs heures, donc on ne veut pas bloquer/allonger le
// rafraîchissement du réservoir pour ça. C'est la SEULE fonction qui appelle
// fetchAndCacheCountryPhotos (donc la seule à consommer le budget Pexels) —
// la génération de quiz ne fait jamais d'appel réseau Pexels, voir
// getCachedCountryPhotos.
async function countryPhotoWarmLoop() {
  for (;;) {
    try {
      const all = await loadCountryList();
      const candidates = all.filter((c) => c.region !== "Antarctic");
      const toWarm = candidates.filter(
        (c) => !cacheGet(`country_photos:${c.name.common}`),
      );
      countryWarmReady = toWarm.length === 0;
      const etaMin = Math.round(
        (toWarm.length * 2 * PEXELS_MIN_INTERVAL_MS) / 60_000,
      );
      console.log(
        `Pays : cache photos — ${candidates.length - toWarm.length}/${candidates.length} déjà chauds, ${toWarm.length} à récupérer (~${etaMin} min estimées à ~2 requêtes/pays)…`,
      );
      let warmed = 0;
      for (const c of toWarm) {
        const t0 = Date.now();
        const photos = await fetchAndCacheCountryPhotos(c.name.common);
        warmed++;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `Pays : ${warmed}/${toWarm.length} — ${c.name.common} (${photos.length} photos, ${elapsed}s)`,
        );
        // persistance incrémentale : un passage complet peut prendre des
        // heures (limite Pexels) — sans ça, un redémarrage avant la fin du
        // tout premier passage ne retrouverait aucune progression sur disque
        if (warmed % 20 === 0) {
          persistCacheSubset(COUNTRY_WARM_CACHE_PATH, "country_photos:");
        }
      }
      countryWarmReady = true;
      persistCacheSubset(COUNTRY_WARM_CACHE_PATH, "country_photos:");
      console.log(
        `Pays : passage de warm-cache terminé — ${candidates.length} pays en cache. Prochain passage dans 1h.`,
      );
    } catch (e) {
      console.error("Erreur warm cache photos pays:", e.message);
    }
    await new Promise((r) => setTimeout(r, 60 * 60 * 1000)); // repasse dans 1h
  }
}

// écarte les formats trop éloignés d'un vrai backdrop 16:9 — les visuels
// promo/bannières/collages ont souvent un ratio différent d'une capture du film
function isStandardRatio(b) {
  return b.aspect_ratio >= 1.7 && b.aspect_ratio <= 1.85;
}

// pour les séries : pioche une saison et un épisode au hasard, renvoie ses
// stills textless (ou null si rien d'exploitable — l'appelant retombe alors
// sur les visuels globaux de la série, en dernier recours seulement)
async function fetchEpisodeTextlessStills(item) {
  try {
    const showKey = `tvshow:${item.id}`;
    let seasons = cacheGet(showKey);
    if (!seasons) {
      const showData = await tmdbJSON(
        `https://api.themoviedb.org/3/tv/${item.id}?api_key=${TMDB_KEY}`,
      );
      seasons = (showData.seasons || []).filter(
        (s) => s.season_number > 0 && s.episode_count > 0,
      );
      cacheSet(showKey, seasons);
    }
    if (seasons.length === 0) return null;
    const season = seasons[Math.floor(Math.random() * seasons.length)];

    const seasonKey = `tvseason:${item.id}:${season.season_number}`;
    let episodeNumbers = cacheGet(seasonKey);
    if (!episodeNumbers) {
      const seasonData = await tmdbJSON(
        `https://api.themoviedb.org/3/tv/${item.id}/season/${season.season_number}?api_key=${TMDB_KEY}`,
      );
      episodeNumbers = (seasonData.episodes || []).map((e) => e.episode_number);
      cacheSet(seasonKey, episodeNumbers);
    }
    if (episodeNumbers.length === 0) return null;
    const episodeNumber =
      episodeNumbers[Math.floor(Math.random() * episodeNumbers.length)];

    const episodeKey = `tvepisode:${item.id}:${season.season_number}:${episodeNumber}`;
    let stills = cacheGet(episodeKey);
    if (!stills) {
      const epData = await tmdbJSON(
        `https://api.themoviedb.org/3/tv/${item.id}/season/${season.season_number}/episode/${episodeNumber}/images?api_key=${TMDB_KEY}`,
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

async function fetchExtraBackdrops(item, need) {
  try {
    let backdrops;
    if (item.mediaType === "tv") {
      // toujours des captures d'épisode pour les séries ; repli sur les
      // visuels globaux de la série uniquement si aucun épisode n'a de still exploitable
      backdrops = await fetchEpisodeTextlessStills(item);
      if (!backdrops) backdrops = await fetchRawBackdrops(item);
    } else if (item.mediaType === "game") {
      backdrops = await fetchGameScreenshots(item.id);
    } else if (item.mediaType === "country") {
      backdrops = getCachedCountryPhotos(item.photoQuery);
    } else if (item.mediaType === "painting") {
      // plusieurs tableaux DIFFÉRENTS du même peintre (pas le même tableau
      // répété) — lecture cache uniquement, voir getCachedPaintingsByArtist
      // pas de repli sur item.posterUrl ici : c'est désormais le PORTRAIT du
      // peintre (voir plus haut), pas un tableau — l'utiliser comme image de
      // devinette montrerait son visage pendant la phase de jeu (indice
      // énorme) et donnerait la même image en devinette qu'en réponse. Si le
      // warm-cache n'a pas encore couvert ce peintre, l'item est simplement
      // exclu (comme n'importe quel item sans image exploitable) plutôt que
      // dégradé.
      const images = getCachedPaintingsByArtist(item.painterQid);
      backdrops = images.map((url) => ({
        url: `${url.replace(/^http:/, "https:")}?width=1280`,
        iso_639_1: null,
        vote_count: 1,
        aspect_ratio: 1,
      }));
    } else {
      backdrops = await fetchRawBackdrops(item);
    }

    const textless = backdrops.filter(
      (b) => b.iso_639_1 === null || b.iso_639_1 === undefined,
    );
    if (textless.length === 0) return [];

    // 1) ratio standard en priorité (moins de bannières/collages promo) —
    // ne s'applique pas aux photos de profil (portrait par nature, pas 16:9)
    const ratioPool =
      item.mediaType === "person"
        ? textless
        : textless.filter(isStandardRatio).length > 0
          ? textless.filter(isStandardRatio)
          : textless;

    // 2) images ayant reçu des votes communautaires en priorité (le contenu
    // promo bulk-uploadé par les studios n'est en général jamais voté)
    const voted = ratioPool.filter((b) => b.vote_count > 0);
    const finalPool =
      voted.length >= Math.min(need, ratioPool.length) ? voted : ratioPool;

    const picked = pickFromPool(finalPool, need).map((b) => b.url);
    return item.mediaType === "painting"
      ? picked.map((u) => commonsThumbUrl(u))
      : picked;
  } catch (e) {
    return [];
  }
}

async function selectItemsWithBackdrops(
  candidatesShuffled,
  count,
  imagesPerItem,
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
        if (m.mediaType === "music") {
          // pas d'image à récupérer : l'extrait audio est déjà connu depuis le réservoir
          return {
            id: m.id,
            title: m.title,
            artist: m.artist,
            track: m.track,
            mediaType: "music",
            previewUrl: m.previewUrl,
            posterUrl: m.posterUrl,
          };
        }
        const imageUrls = await fetchExtraBackdrops(m, imagesPerItem);
        if (imageUrls.length === 0) return null;
        // écran réponse : même souci CORS que les images de devinette, voir
        // commonsThumbUrl (les autres médias ont déjà un posterUrl direct)
        const posterUrl =
          m.mediaType === "painting"
            ? commonsThumbUrl(m.posterUrl)
            : m.posterUrl;
        return {
          id: m.id,
          title: m.title,
          posterUrl,
          mediaType: m.mediaType,
          imageUrls,
        };
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
  return { items: result, excludedCount };
}

// emoji affiché en préfixe de chaque label de catégorie, à la place du
// suffixe "(Type)" redondant qu'on retire du texte (ex: "Action (Films)" ->
// "🎬 Action") — mêmes emoji que les puces de type de contenu côté client
const MEDIA_TYPE_EMOJI = {
  movie: "🎬",
  tv: "📺",
  person: "🎭",
  game: "🎮",
  music: "🎵",
  country: "🌍",
  painting: "🎨",
};
// mots (tels qu'utilisés dans les labels) désignant le type lui-même, à
// retirer du texte puisque l'emoji le porte déjà désormais — volontairement
// vide pour "person" : "(États-Unis)" etc. n'est pas le type mais un pays,
// donc ne doit jamais être retiré
const MEDIA_TYPE_LABEL_WORDS = {
  movie: ["Films"],
  tv: ["Séries"],
  person: [],
  game: ["Jeux"],
  music: ["Musique"],
  country: ["Pays"],
  painting: ["Peintres"],
};

function formatCategoryLabel(label, mediaType) {
  let text = label;
  for (const word of MEDIA_TYPE_LABEL_WORDS[mediaType] || []) {
    // suffixe redondant pur : "Populaires (Films)" -> "Populaires"
    const exact = new RegExp(`\\s*\\(${word}\\)$`);
    if (exact.test(text)) {
      text = text.replace(exact, "");
      break;
    }
    // suffixe composé : "Populaire (Musique, France)" -> "Populaire (France)"
    const compound = new RegExp(`\\(${word}, `);
    if (compound.test(text)) {
      text = text.replace(compound, "(");
      break;
    }
  }
  const emoji = MEDIA_TYPE_EMOJI[mediaType];
  return emoji ? `${emoji} ${text}` : text;
}

app.get("/api/categories", (req, res) => {
  const list = Object.entries(CATEGORIES).map(([key, def]) => ({
    key,
    label: formatCategoryLabel(def.label, def.mediaType),
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
      label: CATEGORIES[key]
        ? formatCategoryLabel(CATEGORIES[key].label, CATEGORIES[key].mediaType)
        : key,
      count,
    }));
  // prêt = réservoir construit ET, pour les fonctionnalités actives qui
  // dépendent d'un warm loop (peintres, photos de pays), leur cache à jour —
  // ignoré si la fonctionnalité correspondante n'est pas active/activée
  const paintingReady = !onlyWants("painting") || paintingWarmReady;
  const countryReady =
    !(pexelsEnabled && onlyWants("country")) || countryWarmReady;
  res.json({
    totalGenerated: stats.totalGenerated,
    topCategories,
    version: APP_VERSION,
    ready: reservoirReady && paintingReady && countryReady,
  });
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

  const imagesPerItem = Math.min(
    MAX_IMAGES_PER_ITEM,
    Math.max(MIN_IMAGES_PER_ITEM, parseInt(req.query.imagesPerItem, 10) || 1),
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

  // si l'historique exclu ne laisse plus assez de films au total (toutes
  // catégories confondues), on l'ignore et on recycle tout plutôt que de
  // livrer un quiz incomplet
  const availableAfterExclude = all.filter((m) => !excludeIds.has(m.id));
  let effectiveExclude = excludeIds;
  let recycled = false;
  if (availableAfterExclude.length < count) {
    effectiveExclude = new Set();
    recycled = true;
  }

  const picked = stratifiedSelection(
    requestedCategories,
    count,
    effectiveExclude,
  );
  const { items: withImages, excludedCount } = await selectItemsWithBackdrops(
    picked,
    count,
    imagesPerItem,
  );

  // un appel qui produit un lot compte comme un quiz généré, persisté sur disque
  stats.totalGenerated++;
  for (const cat of requestedCategories) {
    stats.categoryUsage[cat] = (stats.categoryUsage[cat] || 0) + 1;
  }
  saveStats();

  res.json({
    items: withImages,
    recycled,
    requested: count,
    delivered: withImages.length,
    excludedCount,
    imagesPerItem,
    categories: requestedCategories,
    poolSize: all.length,
    totalGenerated: stats.totalGenerated,
  });
});

app.use(express.static(path.join(process.cwd(), "public")));

app.listen(PORT, () => console.log(`Guess It sur http://localhost:${PORT}`));

// démarré ici (fin de fichier, tout est défini) plutôt qu'à côté de
// refreshReservoir() : countryPhotoWarmLoop/paintingWarmLoop touchent
// apiCache/cacheGet en synchrone avant leur premier await, contrairement à
// refreshReservoir qui await dès sa première ligne — les appeler plus haut
// levait "Cannot access 'apiCache' before initialization".
// on recharge le cache disque de chaque warm loop AVANT de le démarrer, pour
// qu'il retrouve directement l'état "à jour" au lieu de tout re-chauffer.
if (pexelsEnabled && onlyWants("country")) {
  loadCacheSubset(COUNTRY_WARM_CACHE_PATH);
  countryPhotoWarmLoop();
}
if (onlyWants("painting")) {
  loadCacheSubset(PAINTING_WARM_CACHE_PATH);
  paintingWarmLoop();
}
