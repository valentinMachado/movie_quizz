import "dotenv/config";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as db from "./db.js";

// ---------- logs ----------
//
// LOG_LEVEL (env, défaut "info") : error < warn < info < debug. "info" ne
// garde que les résumés (un type/warm-loop terminé, une erreur qui a fait
// perdre des données) — c'est le niveau pm2 en continu. "debug" ajoute le
// détail par item/page/source (retries réseau, échecs individuels d'un warm
// loop) : à activer ponctuellement (LOG_LEVEL=debug npm run refresh) pour
// creuser un échec précis, pas à laisser en continu.
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

function log(level, ...args) {
  if (LOG_LEVELS[level] > LOG_LEVEL) return;
  const prefix = `${new Date().toISOString()} [${level.toUpperCase()}]`;
  const out =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  out(prefix, ...args);
}
const logError = (...args) => log("error", ...args);
const logWarn = (...args) => log("warn", ...args);
const logInfo = (...args) => log("info", ...args);
const logDebug = (...args) => log("debug", ...args);

// filet de sécurité : sous pm2, une exception/rejet non rattrapé fait
// planter le process sans qu'on sache pourquoi (pm2 le redémarre en
// silence). On journalise la stack avant de sortir, pour que le log donne
// toujours la cause du dernier arrêt.
process.on("uncaughtException", (err) => {
  logError("Exception non rattrapée, arrêt du process :", err?.stack || err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logError("Rejet de promesse non géré, arrêt du process :", reason?.stack || reason);
  process.exit(1);
});

const APP_VERSION = JSON.parse(
  readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
).version;
// listes statiques/décennies/genres/pays/peintures/musique : toutes les
// données en dur (pas de logique) vivent dans config.json, pour que ce
// fichier ne garde que le code.
const CONFIG = JSON.parse(
  readFileSync(path.join(process.cwd(), "config.json"), "utf8"),
);
const TMDB_KEY = process.env.TMDB_API_KEY;

// initialisation des catégories : la vraie limite est le throttle de chaque
// API (tmdbGate/igdbGate), qui sérialise déjà les appels réels quel que soit
// le nombre d'appelants concurrents — ces constantes servent juste à ce
// qu'il y ait toujours un appel prêt à partir dès que le throttle l'autorise,
// au lieu d'attendre bêtement la fin de la page/catégorie précédente.
const CATEGORY_FETCH_CONCURRENCY = CONFIG.concurrency.categoryFetch;
const PAGE_FETCH_CONCURRENCY = CONFIG.concurrency.pageFetch;
const IMAGE_FETCH_CONCURRENCY = CONFIG.concurrency.imageFetch;

// --only=movie,painting : ne construit/rafraîchit que les catégories de ces
// médias (les autres sont ignorées avant même d'être fetchées), pour tester
// une seule fonctionnalité sans attendre tout le reste.
const ONLY_ARG = process.argv.find((a) => a.startsWith("--only="));
const ONLY_TYPES = ONLY_ARG
  ? new Set(
      ONLY_ARG.slice("--only=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;
function onlyWants(type) {
  return !ONLY_TYPES || ONLY_TYPES.has(type);
}

// --max-type-count=15 : dev/test uniquement — après chaque
// rafraîchissement, clampe le pool global (toutes catégories confondues,
// pas par catégorie) de chaque type à N entités. Sert à tester
// rapidement un type lent à chauffer (peintures, acteurs) sans attendre
// que le warm loop couvre des milliers d'entités.
const MAX_TYPE_COUNT_ARG = process.argv.find((a) =>
  a.startsWith("--max-type-count="),
);
const MAX_TYPE_COUNT = MAX_TYPE_COUNT_ARG
  ? parseInt(MAX_TYPE_COUNT_ARG.slice("--max-type-count=".length), 10)
  : null;

// --db=<path> : fichier SQLite à ouvrir (défaut cache/data.sqlite) — sert à
// pointer refresh.js et server.js sur le même fichier de test sans jamais
// toucher à l'instance réelle. --ephemeral-db reste un raccourci vers
// --db=:memory:, utile pour un smoke-test isolé de ce seul script (rien
// d'autre ne pourra jamais lire cette base en mémoire).
const DB_ARG = process.argv.find((a) => a.startsWith("--db="));
const DB_PATH = DB_ARG
  ? DB_ARG.slice("--db=".length)
  : process.argv.includes("--ephemeral-db")
    ? ":memory:"
    : path.join(process.cwd(), "cache", "data.sqlite");

if (!TMDB_KEY) {
  logError("TMDB_API_KEY manquante dans .env");
  process.exit(1);
}

// IGDB (jeux vidéo) est optionnel : sans identifiants Twitch, le script
// tourne quand même, simplement sans la catégorie Jeux vidéo.
const IGDB_CLIENT_ID = process.env.IGDB_CLIENT_ID;
const IGDB_CLIENT_SECRET = process.env.IGDB_CLIENT_SECRET;
const igdbEnabled = Boolean(IGDB_CLIENT_ID && IGDB_CLIENT_SECRET);
if (!igdbEnabled) {
  logWarn(
    "IGDB_CLIENT_ID/IGDB_CLIENT_SECRET absents dans .env : catégorie Jeux vidéo désactivée.",
  );
}

// Pexels (photos pays) est optionnel : sans clé, la catégorie Pays reste
// alimentée pour son questionType "flag", qui n'en a pas besoin — seul son
// questionType "image" (photos) restera indisponible.
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const pexelsEnabled = Boolean(PEXELS_API_KEY);
if (!pexelsEnabled) {
  logWarn(
    "PEXELS_API_KEY absente dans .env : photos pays désactivées (le mode drapeau reste alimenté sans elles).",
  );
}

db.init(DB_PATH);

// listes statiques + décennies, films/séries/acteurs (données en dur dans
// config.json, ce fichier ne garde que le code qui les consomme).
const STATIC_LISTS = CONFIG.movie.staticLists;
const DECADE_LISTS = CONFIG.movie.decadeLists;
const TV_STATIC_LISTS = CONFIG.tv.staticLists;
const TV_DECADE_LISTS = CONFIG.tv.decadeLists;
const PERSON_STATIC_LISTS = CONFIG.person.staticLists;

// pays films/acteurs : liste partagée par movieCountrySources (discover/movie
// filtré par pays d'origine, direct) et fetchPersonCountryActors (même
// discover, puis casting du film).
const COUNTRY_TARGETS = CONFIG.countryTargets;
const MOVIE_COUNTRY_PAGES = CONFIG.movie.countryPages; // ~160 films/pays (20/page), réduit en mode dev comme les autres pages
const PERSON_COUNTRY_MOVIE_PAGES = CONFIG.person.country.moviePages; // ~80 films/pays (20/page), réduit en mode dev comme les autres pages
const PERSON_COUNTRY_CAST_PER_MOVIE = CONFIG.person.country.castPerMovie; // rôles principaux seulement, pas la liste complète des crédits
const PERSON_COUNTRY_TARGET_ACTORS = CONFIG.person.country.targetActors; // arrête d'aller chercher des crédits une fois assez d'acteurs uniques trouvés

// jeux vidéo (IGDB) — structure différente de TMDb : `igdbWhere`/`igdbSort`
// au lieu de `pathAndQuery`, paginé par offset (voir fetchGameEntities)
const GAME_STATIC_LISTS = CONFIG.game.staticLists;

// décennies IGDB : construites depuis les bornes en années de config.json
// (gteYear/ltYear) via unixYear, plutôt que de stocker des timestamps unix
// illisibles dans le JSON.
const GAME_DECADE_LISTS = Object.fromEntries(
  CONFIG.game.decadeLists.map((d) => {
    const clauses = ["cover != null", "screenshots != null"];
    if (d.gteYear != null)
      clauses.push(`first_release_date >= ${unixYear(d.gteYear)}`);
    if (d.ltYear != null)
      clauses.push(`first_release_date < ${unixYear(d.ltYear)}`);
    return [
      d.code,
      {
        igdbWhere: clauses.join(" & "),
        igdbSort: "total_rating_count desc",
        pages: d.pages,
        label: d.label,
      },
    ];
  }),
);

// musique — charts Apple Music (RSS, aucune clé), complétés par l'API Lookup
// iTunes pour récupérer previewUrl (l'extrait audio, absent du flux RSS).
// Un pays = une source, fusionnée avec les autres dans le pool "music" (voir
// fetchMusicEntities).
const MUSIC_GENRE_STORE = CONFIG.music.genreStore; // un seul store pour les genres (le plus fourni), sinon ça multiplie les requêtes par pays
const MUSIC_STATIC_LISTS = CONFIG.music.staticLists;

// pays — liste depuis mledoze/countries (mirroir libre et sans clé des
// données historiques de REST Countries). Un même pays alimente deux
// `questionType` distincts : "image" (photo Pexels en devinette, nécessite
// PEXELS_API_KEY) et "flag" (le drapeau flagcdn.com sert directement d'image
// de devinette ET de réponse, gratuit sans clé).
const COUNTRY_LIST_URL =
  "https://raw.githubusercontent.com/mledoze/countries/master/countries.json";

async function loadCountryList() {
  const cacheKey = "country_list";
  const cached = db.cacheGet(cacheKey);
  if (cached) return cached;
  const res = await fetch(COUNTRY_LIST_URL);
  if (!res.ok) throw new Error(`mledoze/countries ${res.status}`);
  const data = await res.json();
  db.cacheSet(cacheKey, data);
  return data;
}

// pool plat : tous les pays (hors Antarctique), plus de découpe par
// continent — c'était le seul rôle de l'ancien découpage en catégories.
async function fetchCountryEntities() {
  const all = await loadCountryList();
  const filtered = all.filter((c) => c.region !== "Antarctic");
  const rows = [];
  for (const c of filtered) {
    const ccn3 = Number(c.ccn3);
    if (!ccn3 || !c.cca2) continue;
    const title = c.translations?.fra?.common || c.name.common;
    rows.push({
      ccn3,
      cca2: c.cca2,
      title,
      photoQuery: c.name.common,
      capital: c.capital?.[0] || null,
      region: c.region,
    });
  }
  db.upsertCountries(rows);
  db.replaceTypeItems(
    "country",
    rows.map((r) => r.ccn3),
  );
}

// peintures — Wikidata (query.wikidata.org), gratuit, sans clé, couvre
// toutes les collections (pas un seul musée). On devine le PEINTRE (title =
// nom du créateur, stocké comme `person` source=wikidata), pas le tableau.
// Images servies depuis Wikimedia Commons (upload.wikimedia.org).
//
// Chaque catégorie interroge Wikidata sur UN SEUL axe (genre OU pays OU
// époque OU popularité) : combiner plusieurs filtres dans la même requête
// s'est révélé lent/instable à l'usage (timeouts 502/504) ; requêtes à un
// seul filtre toujours rapides (< 2s).
//
// Q3305213 = peinture (instance of). P170 = créateur. P18 = image. P135 =
// mouvement artistique. P27 = pays de citoyenneté (appliqué au créateur).
// P571 = date de création. wikibase:sitelinks = nombre d'éditions Wikipédia
// ayant un article sur l'œuvre, utilisé comme substitut de popularité.
// (genres/pays/époques en dur dans config.json, voir CONFIG plus haut)
const PAINTING_GENRES = CONFIG.painting.genres;
const PAINTING_COUNTRIES = CONFIG.painting.countries;
const PAINTING_ERAS = CONFIG.painting.eras;
const PAINTING_QUERY_LIMIT = CONFIG.painting.queryLimit;

// une source de peintres par axe (popularité / genre / pays / époque) —
// fusionnées dans un seul pool en sortie, voir fetchPainterEntities.
function paintingSourceFilters() {
  const filters = [{ kind: "popular" }];
  for (const g of PAINTING_GENRES) filters.push({ kind: "genre", qid: g.qid });
  for (const c of PAINTING_COUNTRIES)
    filters.push({ kind: "country", qid: c.qid });
  for (const e of PAINTING_ERAS)
    filters.push({ kind: "era", code: e.code, gte: e.gte, lte: e.lte });
  return filters;
}

// pas de SERVICE wikibase:label ici : sur les requêtes par plage de dates, le
// combiner au label service fait timeout (observé empiriquement). Les noms
// des créateurs sont résolus après coup, en un seul appel groupé (voir
// resolveWikidataLabels).
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
    "OPTIONAL { ?creator wdt:P18 ?portrait. } " +
    `${extra} ` +
    `} LIMIT ${limit}`
  );
}

// filtre "country" spécifiquement : un simple LIMIT sur les TABLEAUX favorise
// mécaniquement les 1-2 peintres les plus prolifiques sur Commons. On
// récupère donc d'abord les créateurs DISTINCTS, puis une image par créateur
// via VALUES.
function paintingCountryCreatorsSparql(qid, limit) {
  return (
    "SELECT DISTINCT ?creator WHERE { " +
    `?creator wdt:P27 wd:${qid}. ` +
    "?item wdt:P31 wd:Q3305213; wdt:P170 ?creator; wdt:P18 ?image. " +
    `} LIMIT ${limit}`
  );
}

function paintingCreatorImagesSparql(creatorQids) {
  const values = creatorQids.map((qid) => `wd:${qid}`).join(" ");
  return (
    "SELECT ?creator (SAMPLE(?image) AS ?image) (SAMPLE(?portrait) AS ?portrait) WHERE { " +
    `VALUES ?creator { ${values} } ` +
    "?item wdt:P31 wd:Q3305213; wdt:P170 ?creator; wdt:P18 ?image. " +
    "OPTIONAL { ?creator wdt:P18 ?portrait. } " +
    "} GROUP BY ?creator"
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

async function fetchPaintingFilterBindings(filter) {
  if (filter.kind === "country") {
    const creatorsData = await wikidataQuery(
      `https://query.wikidata.org/sparql?query=${encodeURIComponent(
        paintingCountryCreatorsSparql(filter.qid, PAINTING_QUERY_LIMIT),
      )}`,
    );
    const creatorQids = (creatorsData.results?.bindings || [])
      .map((b) => b.creator?.value?.split("/").pop())
      .filter((qid) => qid && /^Q\d+$/.test(qid));
    if (!creatorQids.length) return [];
    const data = await wikidataQuery(
      `https://query.wikidata.org/sparql?query=${encodeURIComponent(
        paintingCreatorImagesSparql(creatorQids),
      )}`,
    );
    return data.results?.bindings || [];
  }
  const data = await wikidataQuery(
    `https://query.wikidata.org/sparql?query=${encodeURIComponent(
      paintingSparql(filter, PAINTING_QUERY_LIMIT),
    )}`,
  );
  return data.results?.bindings || [];
}

// les liens Special:FilePath renvoyés par Wikidata redirigent vers le vrai
// fichier sur upload.wikimedia.org — la chaîne de redirection casse le CORS
// dans un vrai navigateur. On résout donc l'URL directe via la convention de
// répertoires Wikimedia (dérivée du MD5 du nom de fichier), sans requête
// réseau — appliquée ici, à l'écriture, pour que server.js n'ait plus jamais
// besoin de transformer une URL peinture.
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

// upserte les peintres trouvés comme `person` (source wikidata) et remplace
// le pool "painter" — le tableau complet d'un peintre n'est récupéré qu'en
// tâche de fond, voir le warmLoop "Peintres (tableaux)". Chaque axe
// (popularité/genre/pays/époque) interroge Wikidata séparément (voir
// paintingSparql : combiner plusieurs filtres dans la même requête timeout),
// mais tous les résultats sont fusionnés dans un seul pool avant d'écrire en
// base — un axe qui échoue (timeout Wikidata) ne doit pas faire perdre les
// autres.
async function fetchPainterEntities() {
  const byCreator = new Map(); // creatorQid -> { image, portrait }
  // un peintre peut apparaître dans plusieurs filtres d'un même groupe (ex. à
  // la fois impressionnisme et post-impressionnisme) — réutilise le même
  // tracking multi-groupe que fetchTmdbListPool/fetchIgdbListPool (tagFilter),
  // ici alimenté directement par filter.kind plutôt que par une source de
  // crawl séparée (l'info est déjà dans le filtre Wikidata qui a matché, pas
  // d'appel réseau supplémentaire).
  const filterTagsByCreator = new Map();
  const paintingFilters = paintingSourceFilters();
  let paintingFiltersDone = 0;
  const paintingStartTs = Date.now();
  await mapWithConcurrency(
    paintingFilters,
    CATEGORY_FETCH_CONCURRENCY,
    async (filter) => {
      let bindings;
      try {
        bindings = await fetchPaintingFilterBindings(filter);
      } catch (e) {
        logWarn(`Erreur peintures (filtre ${filter.kind}):`, e.message);
        return;
      } finally {
        paintingFiltersDone++;
        // Wikidata est sérialisé à ~1 requête/800ms (voir wikidataQuery) : ce
        // crawl peut prendre plusieurs minutes en silence sans ce repère.
        logInfo(
          `painter : filtre ${paintingFiltersDone}/${paintingFilters.length} (${filter.kind}) — ${byCreator.size} peintres cumulés (${((Date.now() - paintingStartTs) / 1000).toFixed(1)}s)`,
        );
      }
      for (const b of bindings) {
        const creatorQid = b.creator?.value?.split("/").pop();
        const image = b.image?.value;
        if (!creatorQid || !/^Q\d+$/.test(creatorQid) || !image) continue;
        if (!byCreator.has(creatorQid)) {
          byCreator.set(creatorQid, {
            image,
            portrait: b.portrait?.value || null,
          });
        } else if (!byCreator.get(creatorQid).portrait && b.portrait?.value) {
          byCreator.get(creatorQid).portrait = b.portrait.value;
        }
        if (filter.kind === "genre")
          tagFilter(filterTagsByCreator, creatorQid, "genre", filter.qid);
        else if (filter.kind === "country")
          tagFilter(filterTagsByCreator, creatorQid, "geographie", filter.qid);
        else if (filter.kind === "era")
          tagFilter(filterTagsByCreator, creatorQid, "decennie", filter.code);
      }
    },
  );
  if (byCreator.size === 0) {
    db.replaceTypeItems("painter", []);
    return;
  }

  const labels = await resolveWikidataLabels([...byCreator.keys()]);
  const surrogateIds = [];
  const items = []; // { id, creatorQid, portraitThumbUrl } — forme attendue par storeFilterGroup
  for (const [creatorQid, info] of byCreator) {
    const creator = labels.get(creatorQid);
    if (!creator) continue;
    const rawPortrait = info.portrait || info.image;
    const portraitThumbUrl = rawPortrait ? commonsThumbUrl(rawPortrait) : null;
    const personId = db.upsertPerson({
      source: "wikidata",
      externalId: creatorQid,
      name: creator,
      // portrait du peintre lui-même sur l'écran réponse (pas un tableau de
      // plus) ; repli sur un tableau si aucun portrait n'est connu — URL déjà
      // convertie en thumbnail final, prête à servir telle quelle.
      portraitImageUrl: portraitThumbUrl,
    });
    surrogateIds.push(personId);
    items.push({ id: personId, creatorQid, portraitThumbUrl });
  }
  db.replaceTypeItems(
    "painter",
    items.map((i) => i.id),
  );

  // le peintre rejoint AUSSI le pool "person" (rôle "painter") — une
  // mécanique de devinette différente et complémentaire du pool "painter"
  // ci-dessus : ici on devine à partir de SA photo/portrait (comme un
  // acteur), là-bas à partir d'un de ses tableaux. Additif (voir
  // db.addTypeItems) : "person" est aussi alimenté par fetchPersonEntities
  // et le warmLoop réalisateurs, sans connaissance mutuelle.
  db.addTypeItems(
    "person",
    items.map((i) => i.id),
  );
  db.upsertFilters("person", "role", [{ code: "painter", name: "Peintre" }]);
  db.addEntityFilters(
    "person",
    "role",
    items.map((i) => ({ entityId: i.id, codes: ["painter"] })),
  );
  // person_image : seule source d'images pour la devinette "person" (voir
  // getBackdropsForItem côté server.js) — réutilise l'URL déjà résolue
  // ci-dessus, aucun appel réseau supplémentaire. Un peintre sans portrait
  // connu n'a simplement aucune image ici et sera exclu du quiz pour ce
  // rôle, comme n'importe quelle autre entité sans image.
  for (const item of items) {
    if (!item.portraitThumbUrl) continue;
    db.replacePersonImages(item.id, [
      {
        url: item.portraitThumbUrl,
        iso_639_1: null,
        vote_count: 1,
        aspect_ratio: 1,
      },
    ]);
  }

  // storeFilterGroup attend filterTagsByItemId keyed par item.id (personId),
  // pas par creatorQid (l'id Wikidata provisoire) — reprojection ici plutôt
  // que de complexifier storeFilterGroup pour ce seul appelant.
  const filterTagsByPersonId = new Map();
  for (const item of items) {
    const tags = filterTagsByCreator.get(item.creatorQid);
    if (tags) filterTagsByPersonId.set(item.id, tags);
  }
  storeFilterGroup(
    "painter",
    "genre",
    Object.fromEntries(PAINTING_GENRES.map((g) => [g.qid, { label: g.label }])),
    items,
    filterTagsByPersonId,
  );
  storeFilterGroup(
    "painter",
    "geographie",
    Object.fromEntries(
      PAINTING_COUNTRIES.map((c) => [c.qid, { label: c.label }]),
    ),
    items,
    filterTagsByPersonId,
  );
  storeFilterGroup(
    "painter",
    "decennie",
    Object.fromEntries(PAINTING_ERAS.map((e) => [e.code, { label: e.label }])),
    items,
    filterTagsByPersonId,
  );
}

// tous les tableaux d'UN peintre (appelé uniquement par le warmLoop
// peintures, en tâche de fond, jamais à la génération du quiz) — pas besoin
// du label service ici, on connaît déjà le nom du peintre.
async function fetchPainterArtworksFromWikidata(painterQid) {
  const sparql =
    "SELECT ?image WHERE { " +
    `?item wdt:P31 wd:Q3305213; wdt:P170 wd:${painterQid}; wdt:P18 ?image. ` +
    "} LIMIT 30";
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
  return images;
}

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
    const cause = e.cause
      ? ` (${e.cause.code || e.cause.message || e.cause})`
      : "";
    if (attempt < 3) {
      const delay = 500 * attempt;
      logDebug(
        `IGDB "${endpoint}" échec réseau${cause}, retry ${attempt}/2 dans ${delay}ms…`,
      );
      await new Promise((r) => setTimeout(r, delay));
      return igdbQuery(endpoint, body, attempt + 1);
    }
    e.message = `${e.message}${cause}`;
    throw e;
  }
}

// Pexels (photos pays) : palier gratuit à 200 req/heure. Le cache long (TTL
// countryPhoto) fait que ce budget n'est consommé qu'en tâche de fond.
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
        if (attempt < 3)
          await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    throw lastErr;
  } finally {
    await new Promise((r) => setTimeout(r, PEXELS_MIN_INTERVAL_MS));
    releaseTurn();
  }
}

// Wikidata (peintures) : endpoint public, pas de clé, mais renvoie parfois
// des 429/502/504 même sur des requêtes simples — sérialisé + retry.
let wikidataQueueTail = Promise.resolve();
const WIKIDATA_MIN_INTERVAL_MS = 800;

async function wikidataQuery(url) {
  const previous = wikidataQueueTail;
  let releaseTurn;
  wikidataQueueTail = new Promise((r) => (releaseTurn = r));
  await previous;

  try {
    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            Accept: "application/sparql-results+json",
            "User-Agent": "GuessItQuiz/1.0 (personal project)",
          },
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const delay =
            retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
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

function urlFor(pathAndQuery, page) {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  return `https://api.themoviedb.org/3/${pathAndQuery}${sep}api_key=${TMDB_KEY}&language=fr-FR&page=${page}`;
}

function capPages(pages) {
  return MAX_TYPE_COUNT ? Math.min(pages, 1) : pages;
}

// tague chaque source d'un GROUPE de filtre (liste, decennie, geographie...)
// avec la clé config.json correspondante — sert ensuite à savoir, par
// entité, quel(s) code(s) de CE groupe elle a rencontré(s) (voir
// fetchTmdbListPool/fetchIgdbListPool/storeFilterGroup). "genre" n'utilise
// PAS ce mécanisme (extrait directement des champs genre_ids/genres.id déjà
// présents sur chaque item, voir storeTmdbGenres) — seuls les groupes
// dérivés d'une source de crawl distincte (liste/decennie/geographie)
// passent par du "source-tracking".
function withFilterCodes(sourcesObj, filterGroup) {
  return Object.entries(sourcesObj).map(([code, src]) => ({
    ...src,
    filterGroup,
    filterCode: code,
  }));
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
async function fetchTmdbListPool(sources, type) {
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

// alimente Map<entityId, Map<filterGroup, Set<code>>> — no-op si la source
// ne porte pas de filterGroup (décennie/genre/pays de découverte, listes
// simples sans tracking). Partagé par fetchTmdbListPool et fetchIgdbListPool.
function tagFilter(filterTagsByItemId, entityId, filterGroup, filterCode) {
  if (!filterGroup) return;
  if (!filterTagsByItemId.has(entityId))
    filterTagsByItemId.set(entityId, new Map());
  const byGroup = filterTagsByItemId.get(entityId);
  if (!byGroup.has(filterGroup)) byGroup.set(filterGroup, new Set());
  byGroup.get(filterGroup).add(filterCode);
}

// stocke un seul groupe de filtre (upsertFilters + replaceEntityFilters) —
// appelé une fois par groupe après un crawl. `sourcesConfig` fournit les
// noms affichables (source.label) pour chaque code du groupe ; `items` est
// la liste complète du pool fraîchement fetché (une entité absente de
// filterTagsByItemId pour ce groupe est simplement écrite avec codes: []).
function storeFilterGroup(type, filterGroup, sourcesConfig, items, filterTagsByItemId) {
  db.upsertFilters(
    type,
    filterGroup,
    Object.entries(sourcesConfig).map(([code, src]) => ({
      code,
      name: src.label ?? src.name,
    })),
  );
  db.replaceEntityFilters(
    type,
    filterGroup,
    items.map((item) => ({
      entityId: item.id,
      codes: [...(filterTagsByItemId.get(item.id)?.get(filterGroup) || [])],
    })),
  );
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

// codes+noms du groupe "geographie" pour movie — dérivé de COUNTRY_TARGETS
// (même liste que movieCountrySources), attend un objet { [code]: {label} }
// comme les *StaticLists de config.json pour rester compatible avec
// storeFilterGroup.
const MOVIE_COUNTRY_FILTERS = Object.fromEntries(
  COUNTRY_TARGETS.map((t) => [t.code, { label: t.name }]),
);

async function fetchMovieEntities() {
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
  }));
  db.upsertMovies(rows);
  db.replaceTypeItems(
    "movie",
    rows.map((r) => r.id),
  );
  storeTmdbGenres("movie", genres, items);
  storeFilterGroup("movie", "liste", STATIC_LISTS, items, filterTagsByItemId);
  storeFilterGroup("movie", "decennie", DECADE_LISTS, items, filterTagsByItemId);
  storeFilterGroup("movie", "geographie", MOVIE_COUNTRY_FILTERS, items, filterTagsByItemId);
}

// pendant léger de fetchMovieEntities : ne retouche que les listes (Populaire/
// Tendances), sans redemander décennies/genres/pays — cadence bien plus
// courte (voir TTL_MS.listPool), donnée qui change réellement d'un jour à
// l'autre contrairement au reste (voir TYPES.movie.refreshLists).
async function refreshMovieLists() {
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

async function fetchTvEntities() {
  const genres = await fetchTmdbGenres("tv");
  const sources = [
    ...withFilterCodes(TV_STATIC_LISTS, "liste"),
    ...withFilterCodes(TV_DECADE_LISTS, "decennie"),
    ...tvGenreSources(genres),
  ];
  const { items, filterTagsByItemId } = await fetchTmdbListPool(sources, "tv");
  const rows = items.map((t) => ({
    id: t.id,
    title: t.name,
    posterPath: t.poster_path,
    overview: t.overview,
  }));
  db.upsertTvShows(rows);
  db.replaceTypeItems(
    "tv",
    rows.map((r) => r.id),
  );
  storeTmdbGenres("tv", genres, items);
  storeFilterGroup("tv", "liste", TV_STATIC_LISTS, items, filterTagsByItemId);
  storeFilterGroup("tv", "decennie", TV_DECADE_LISTS, items, filterTagsByItemId);
}

// pendant léger de fetchTvEntities (voir refreshMovieLists ci-dessus).
async function refreshTvLists() {
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

async function fetchIgdbGenres() {
  try {
    return (await igdbQuery("genres", "fields id,name; limit 50;")) || [];
  } catch (e) {
    logWarn("Erreur récupération des genres IGDB:", e.message);
    return [];
  }
}

function gameGenreSources(genres) {
  return genres.map((g) => ({
    igdbWhere: `cover != null & screenshots != null & genres = (${g.id})`,
    igdbSort: "total_rating_count desc",
    pages: CONFIG.game.genrePages,
  }));
}

// même principe que fetchTmdbListPool mais pour IGDB (pagination par offset
// au lieu de page) : fusionne plusieurs sources dédupliquées par id, et trace
// séparément les tags de filtre rencontrés (voir withFilterCodes/tagFilter)
// indépendamment de la dédup — un jeu déjà vu via une source sans
// filterGroup (genre) ne doit pas perdre l'appartenance à une liste/décennie
// croisée ensuite.
async function fetchIgdbListPool(sources, fields, toRow) {
  const seen = new Map();
  const filterTagsByItemId = new Map();
  const limit = 100;
  let sourcesDone = 0;
  const startTs = Date.now();
  await mapWithConcurrency(sources, CATEGORY_FETCH_CONCURRENCY, async (src) => {
    const pageIdxs = Array.from({ length: capPages(src.pages) }, (_, i) => i);
    await mapWithConcurrency(pageIdxs, PAGE_FETCH_CONCURRENCY, async (i) => {
      const offset = i * limit;
      const body = `fields ${fields}; where ${src.igdbWhere}; sort ${src.igdbSort}; limit ${limit}; offset ${offset};`;
      try {
        const data = await igdbQuery("games", body);
        for (const g of data) {
          if (!g.cover?.image_id || !g.screenshots?.length) continue;
          if (!seen.has(g.id)) seen.set(g.id, toRow(g));
          tagFilter(filterTagsByItemId, g.id, src.filterGroup, src.filterCode);
        }
      } catch (e) {
        logWarn(`Erreur IGDB (offset ${offset}):`, e.message);
      }
    });
    sourcesDone++;
    logInfo(
      `game : source ${sourcesDone}/${sources.length} (${src.igdbWhere}) — ${seen.size} items cumulés (${((Date.now() - startTs) / 1000).toFixed(1)}s)`,
    );
  });
  return { items: [...seen.values()], filterTagsByItemId };
}

// IGDB renvoie first_release_date en timestamp unix (secondes) — converti
// ici en "YYYY-MM-DD" pour rester dans le même format que movie.release_date
// et music_track.release_date (voir getGamesByReleaseMonthDay, quiz du jour).
function igdbDateToISO(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function gameRow(g) {
  return {
    id: g.id,
    title: g.name,
    coverImageId: g.cover.image_id,
    summary: g.summary || null,
    releaseDate: igdbDateToISO(g.first_release_date),
    genreIds: (g.genres || []).map((x) => x.id),
  };
}

async function fetchGameEntities() {
  const genres = await fetchIgdbGenres();
  const sources = [
    ...withFilterCodes(GAME_STATIC_LISTS, "liste"),
    ...withFilterCodes(GAME_DECADE_LISTS, "decennie"),
    ...gameGenreSources(genres),
  ];
  const { items: rows, filterTagsByItemId } = await fetchIgdbListPool(
    sources,
    "name,cover.image_id,screenshots.image_id,genres.id,summary,first_release_date",
    gameRow,
  );
  db.upsertGames(rows);
  db.replaceTypeItems(
    "game",
    rows.map((r) => r.id),
  );
  if (genres.length > 0) {
    db.upsertFilters(
      "game",
      "genre",
      genres.map((g) => ({ code: String(g.id), name: g.name })),
    );
    db.replaceEntityFilters(
      "game",
      "genre",
      rows.map((r) => ({
        entityId: r.id,
        codes: r.genreIds.map(String),
      })),
    );
  }
  storeFilterGroup("game", "liste", GAME_STATIC_LISTS, rows, filterTagsByItemId);
  storeFilterGroup("game", "decennie", GAME_DECADE_LISTS, rows, filterTagsByItemId);
}

// pendant léger de fetchGameEntities : ne retouche que les listes (Populaire/
// Tendances), sans redemander les genres ni les décennies — cadence bien
// plus courte (voir TTL_MS.listPool), donnée qui change réellement d'un jour
// à l'autre contrairement au reste (voir TYPES.game.refreshLists).
async function refreshGameLists() {
  const { items: rows, filterTagsByItemId } = await fetchIgdbListPool(
    withFilterCodes(GAME_STATIC_LISTS, "liste"),
    "name,cover.image_id,screenshots.image_id,summary,first_release_date",
    gameRow,
  );
  db.upsertGames(rows);
  storeFilterGroup("game", "liste", GAME_STATIC_LISTS, rows, filterTagsByItemId);
}

// genres musique : flux RSS classique iTunes (topsongs?genre=), qui contient
// déjà l'extrait audio et l'illustration.
async function fetchMusicGenreTracks(src) {
  const url = `https://itunes.apple.com/${src.country}/rss/topsongs/limit=100/genre=${src.genreId}/json`;
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
      previewUrl: preview.attributes.href,
      posterUrl: artwork.replace(/\d+x\d+bb/, "600x600bb"),
      releaseDate: e["im:releaseDate"]?.label,
    });
  }
  return result;
}

// musique : le flux RSS Apple donne le classement mais pas l'extrait audio —
// on complète via l'API Lookup iTunes (par lots d'IDs) pour récupérer previewUrl
async function fetchMusicChartTracks(src) {
  const chartUrl = `https://rss.applemarketingtools.com/api/v2/${src.country}/music/most-played/100/songs.json`;
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
        previewUrl: t.previewUrl,
        posterUrl: t.artworkUrl100.replace("100x100", "600x600"),
        releaseDate: t.releaseDate,
        // pas d'id de genre fiable dans l'API Lookup, juste le nom — utilisé
        // aussi comme code (voir fetchMusicEntities/storeMusicGenres).
        genre: t.primaryGenreName
          ? { code: t.primaryGenreName, name: t.primaryGenreName }
          : null,
      });
    }
  }
  return [...entries.values()];
}

async function musicGenreSources() {
  try {
    const genreRes = await fetch(
      "https://itunes.apple.com/WebObjects/MZStoreServices.woa/ws/genres?id=34",
    );
    if (!genreRes.ok) throw new Error(`iTunes genres ${genreRes.status}`);
    const genreData = await genreRes.json();
    const subgenres = genreData["34"]?.subgenres || {};
    return Object.values(subgenres).map((g) => ({
      genreId: g.id,
      genreName: g.name,
      country: MUSIC_GENRE_STORE,
    }));
  } catch (e) {
    logWarn("Erreur récupération des genres musique:", e.message);
    return [];
  }
}

// un seul genre par morceau en pratique (source iTunes), mais schéma générique
// (voir db.replaceEntityFilters) au cas où un morceau serait vu avec des
// genres différents d'une passe à l'autre.
function storeMusicGenres(rows) {
  const genreByCode = new Map();
  for (const t of rows) if (t.genre) genreByCode.set(t.genre.code, t.genre.name);
  if (genreByCode.size === 0) return;
  db.upsertFilters(
    "music",
    "genre",
    [...genreByCode].map(([code, name]) => ({ code, name })),
  );
  db.replaceEntityFilters(
    "music",
    "genre",
    rows.map((r) => ({ entityId: r.id, codes: r.genre ? [r.genre.code] : [] })),
  );
}

// mêmes bornes que DECADE_LISTS/TV_DECADE_LISTS/GAME_DECADE_LISTS (avant
// 1970, puis par décennie jusqu'à 2020+) — dérivées ici directement depuis
// `releaseDate` (déjà stocké par morceau via upsertMusicTracks), pas besoin
// d'un crawl dédié par décennie comme pour les autres types : couverture
// complète, contrairement au source-tracking de liste/decennie ailleurs.
const MUSIC_DECADE_BOUNDARIES = [
  { code: "before_1970", label: "Avant 1970", lt: 1970 },
  { code: "decade_1970", label: "Années 1970", gte: 1970, lt: 1980 },
  { code: "decade_1980", label: "Années 1980", gte: 1980, lt: 1990 },
  { code: "decade_1990", label: "Années 1990", gte: 1990, lt: 2000 },
  { code: "decade_2000", label: "Années 2000", gte: 2000, lt: 2010 },
  { code: "decade_2010", label: "Années 2010", gte: 2010, lt: 2020 },
  { code: "decade_2020", label: "Années 2020", gte: 2020 },
];

function musicDecadeCode(releaseDate) {
  const year = parseInt(String(releaseDate || "").slice(0, 4), 10);
  if (!Number.isFinite(year)) return null;
  const bucket = MUSIC_DECADE_BOUNDARIES.find(
    (b) => (b.gte == null || year >= b.gte) && (b.lt == null || year < b.lt),
  );
  return bucket?.code || null;
}

function storeMusicDecades(rows) {
  db.upsertFilters(
    "music",
    "decennie",
    MUSIC_DECADE_BOUNDARIES.map((b) => ({ code: b.code, name: b.label })),
  );
  db.replaceEntityFilters(
    "music",
    "decennie",
    rows.map((r) => {
      const code = musicDecadeCode(r.releaseDate);
      return { entityId: r.id, codes: code ? [code] : [] };
    }),
  );
}

async function fetchMusicEntities() {
  const sources = [
    ...withFilterCodes(MUSIC_STATIC_LISTS, "liste"),
    ...(await musicGenreSources()),
  ];
  const tracks = new Map();
  // même logique que fetchTmdbListPool : accumulé indépendamment de `tracks`
  // pour ne pas perdre l'appartenance à une liste si le morceau a déjà été vu
  // via une source genre avant sa source "liste" (chart pays).
  const filterTagsByItemId = new Map();
  await mapWithConcurrency(sources, CATEGORY_FETCH_CONCURRENCY, async (src) => {
    try {
      // flux genre iTunes : homogène, tous les morceaux du flux appartiennent
      // au genre de la source — pas besoin de le redétecter par morceau.
      const sourceGenre = src.genreId
        ? { code: src.genreId, name: src.genreName }
        : null;
      const list = src.genreId
        ? await fetchMusicGenreTracks(src)
        : await fetchMusicChartTracks(src);
      for (const t of list) {
        const genre = t.genre || sourceGenre;
        const existing = tracks.get(t.id);
        if (existing) {
          if (!existing.genre && genre) existing.genre = genre;
        } else {
          tracks.set(t.id, { ...t, genre });
        }
        tagFilter(filterTagsByItemId, t.id, src.filterGroup, src.filterCode);
      }
    } catch (e) {
      logWarn(
        `Erreur source musique (${src.genreId ? `genre ${src.genreId}` : src.country}):`,
        e.message,
      );
    }
  });
  const rows = [...tracks.values()];
  db.upsertMusicTracks(rows);
  storeMusicGenres(rows);
  storeMusicDecades(rows);
  db.replaceTypeItems(
    "music",
    rows.map((r) => r.id),
  );
  storeFilterGroup("music", "liste", MUSIC_STATIC_LISTS, rows, filterTagsByItemId);
}

// pendant léger de fetchMusicEntities : ne retouche que les listes (Populaire
// par pays), sans redemander les genres ni la décennie — cadence bien plus
// courte (voir TTL_MS.listPool ; voir aussi refreshMovieLists pour le même
// principe). MUSIC_STATIC_LISTS n'a jamais de genreId (réservé à
// musicGenreSources), donc toujours la voie chart pays ici, jamais
// fetchMusicGenreTracks.
async function refreshMusicLists() {
  const sources = withFilterCodes(MUSIC_STATIC_LISTS, "liste");
  const tracks = new Map();
  const filterTagsByItemId = new Map();
  await mapWithConcurrency(sources, CATEGORY_FETCH_CONCURRENCY, async (src) => {
    try {
      const list = await fetchMusicChartTracks(src);
      for (const t of list) {
        if (!tracks.has(t.id)) tracks.set(t.id, t);
        tagFilter(filterTagsByItemId, t.id, src.filterGroup, src.filterCode);
      }
    } catch (e) {
      logWarn(`Erreur listes musique (${src.country}):`, e.message);
    }
  });
  const rows = [...tracks.values()];
  db.upsertMusicTracks(rows);
  storeFilterGroup("music", "liste", MUSIC_STATIC_LISTS, rows, filterTagsByItemId);
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

async function fetchPersonEntities() {
  const { items: popular } = await fetchTmdbListPool(
    Object.values(PERSON_STATIC_LISTS),
    "person",
  );
  const surrogateIds = new Set(
    popular.map((p) =>
      db.upsertPerson({
        source: "tmdb",
        externalId: String(p.id),
        name: p.name,
        profileImageUrl: `https://image.tmdb.org/t/p/w500${p.profile_path}`,
      }),
    ),
  );
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

async function fetchAndStoreMovieImages(movie) {
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

async function fetchAndStorePersonImages(person) {
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

async function fetchAndStoreGameScreenshots(game) {
  const data = await igdbQuery(
    "games",
    `fields screenshots.image_id; where id = ${game.id};`,
  );
  const imageIds = (data[0]?.screenshots || [])
    .filter((s) => s.image_id)
    .map((s) => s.image_id);
  db.replaceGameImages(game.id, imageIds);
}

// pays : Pexels n'a pas de notion de "textless"/vote par image (donc
// iso_639_1 null, vote_count à 1, comme IGDB).
async function fetchCountryPhotosFromPexels(query) {
  const seen = new Map();
  for (const suffix of ["landmark", "landscape"]) {
    const data = await pexelsJSON(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(`${query} ${suffix}`)}&per_page=15&orientation=landscape`,
    );
    for (const p of data.photos || []) {
      if (!p.src?.large || !p.width || !p.height || seen.has(p.id)) continue;
      seen.set(p.id, {
        url: p.src.large,
        voteCount: 1,
        aspectRatio: p.width / p.height,
      });
    }
  }
  return [...seen.values()];
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
const TV_TARGET_EPISODES_PER_SHOW = CONFIG.tv.targetEpisodesPerShow;

function tvShowNeedsWarming(show) {
  if (db.cacheGet(`tv_fully_warmed:${show.id}`)) return false;
  return db.getTvWarmedEpisodes(show.id).length < TV_TARGET_EPISODES_PER_SHOW;
}

async function fetchAndStoreTvImages(show) {
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

// ---------- registre central : un type = fetch entités + warmLoops d'enrichissement ----------
//
// Chaque type suit le même pattern en 2 phases : `fetchEntities` va
// chercher toutes ses entités (fusion de toutes les sources — listes/genres/
// décennies/géographie — en un seul pool), puis un ou plusieurs `warmLoops`
// complètent en tâche de fond les attributs qui ne peuvent pas être connus
// au moment du fetch en masse (images, tableaux d'un peintre, réalisateur
// d'un film, photos d'un pays — un appel réseau PAR entité, trop coûteux à
// faire pendant le fetch initial). `runBackfillLoop` (plus bas) est le
// moteur générique de cette 2e phase ; `startWarmLoops` le démarre une fois
// pour chaque warmLoop déclaré.
const TYPES = {
  movie: {
    fetchEntities: fetchMovieEntities,
    refreshLists: refreshMovieLists,
    warmLoops: [
      {
        name: "Films (réalisateurs)",
        collectTargets: () => db.getMoviePool(),
        needsRefresh: (movie) => db.movieNeedsDirectors(movie),
        fetchAndStore: async (movie) => {
          const data = await tmdbJSON(
            `https://api.themoviedb.org/3/movie/${movie.id}/credits?api_key=${TMDB_KEY}&language=fr-FR`,
          );
          const directors = (data.crew || [])
            .filter((c) => c.job === "Director")
            .map((d) => ({
              id: d.id,
              name: d.name,
              profilePath: d.profile_path,
            }));
          const personIds = db.setMovieDirectors(movie.id, directors);
          if (personIds.length > 0) {
            // additif : découverte progressive film par film, ne doit pas
            // écraser ce que fetchPersonEntities/fetchPainterEntities ont
            // déjà posé sur "person" (voir db.addTypeItems).
            db.addTypeItems("person", personIds);
            db.upsertFilters("person", "role", [
              { code: "director", name: "Réalisateur" },
            ]);
            db.addEntityFilters(
              "person",
              "role",
              personIds.map((id) => ({ entityId: id, codes: ["director"] })),
            );
            // pool dédié au quiz "réalisateur" (deviner le nom à partir des
            // affiches de ses films, voir server.js/materializeDirectorRow)
            // — même personnes que ci-dessus mais sous un type distinct
            // (type_item "director"), sinon un même id TMDb entrerait en
            // collision entre les deux quiz s'ils étaient sélectionnés
            // ensemble (voir server.js/DIRECTOR_ID_OFFSET).
            db.addTypeItems("director", personIds);
            // filtres "réalisateur" = tags déjà connus DE CE FILM (genre,
            // décennie, geographie — pas "liste", propre au film et sans
            // sens pour son réalisateur), recopiés tels quels sur son/ses
            // réalisateur(s) : additif, un réalisateur accumule ainsi au
            // fil de ses films tous les genres/décennies/pays où il a
            // travaillé (voir getEntityFilterEntries).
            const propagatedGroups = ["genre", "decennie", "geographie"];
            const movieTags = db
              .getEntityFilterEntries("movie", movie.id)
              .filter((t) => propagatedGroups.includes(t.filterGroup));
            const tagsByGroup = {};
            for (const t of movieTags) (tagsByGroup[t.filterGroup] ??= []).push(t);
            for (const [group, tags] of Object.entries(tagsByGroup)) {
              db.upsertFilters(
                "director",
                group,
                tags.map((t) => ({ code: t.code, name: t.name })),
              );
              db.addEntityFilters(
                "director",
                group,
                personIds.map((id) => ({
                  entityId: id,
                  codes: tags.map((t) => t.code),
                })),
              );
            }
          }
        },
      },
      {
        name: "Films (images)",
        collectTargets: () => db.getMoviePool(),
        needsRefresh: (movie) =>
          !db.isFresh(db.movieImagesFetchedAt(movie.id), db.TTL_MS.mediaImage),
        fetchAndStore: fetchAndStoreMovieImages,
      },
    ],
  },
  tv: {
    fetchEntities: fetchTvEntities,
    refreshLists: refreshTvLists,
    warmLoops: [
      {
        name: "Séries (images)",
        collectTargets: () => db.getTvShowPool(),
        needsRefresh: tvShowNeedsWarming,
        fetchAndStore: fetchAndStoreTvImages,
      },
    ],
  },
  person: {
    fetchEntities: fetchPersonEntities,
    warmLoops: [
      {
        name: "Acteurs (images)",
        collectTargets: () => db.getPersonPool(),
        // "person" contient aussi des réalisateurs (source tmdb, OK) et des
        // peintres (source wikidata) depuis l'ajout du rôle multi-valué —
        // fetchAndStorePersonImages appelle l'API TMDb via external_id, qui
        // n'a aucun sens pour un QID Wikidata. Les peintres gèrent déjà leur
        // photo directement dans fetchPainterEntities, donc exclus ici.
        needsRefresh: (person) =>
          person.source === "tmdb" &&
          !db.isFresh(
            db.personImagesFetchedAt(person.id),
            db.TTL_MS.mediaImage,
          ),
        fetchAndStore: fetchAndStorePersonImages,
      },
      {
        // birthday/place_of_birth (quiz du jour "anniversaire", voir
        // server.js/dailyPersonAnniversaryBucket) — même garde source=tmdb
        // que "Acteurs (images)" ci-dessus : un peintre (source wikidata) n'a
        // pas d'external_id TMDb interrogeable ici.
        name: "Acteurs (anniversaire)",
        collectTargets: () => db.getPersonPool(),
        needsRefresh: (person) =>
          person.source === "tmdb" && db.personNeedsBirthday(person),
        fetchAndStore: async (person) => {
          const data = await tmdbJSON(
            `https://api.themoviedb.org/3/person/${person.external_id}?api_key=${TMDB_KEY}&language=fr-FR`,
          );
          db.setPersonBirthday(person.id, data.birthday, data.place_of_birth);
        },
      },
      {
        // le pool "movie" est une sélection curated (popularité/genre/
        // décennie/pays), pas la filmographie complète d'un réalisateur —
        // sans ce warmLoop, la plupart des réalisateurs n'auraient qu'1
        // seul film (celui qui a atterri dans le pool curated) pour le
        // quiz "deviner le réalisateur à partir de sa filmographie" (voir
        // server.js/getDirectorMoviePosters). On complète ici via les
        // crédits DE LA PERSONNE (TMDb person/movie_credits), à l'inverse
        // de "Films (réalisateurs)" ci-dessus qui part des crédits DU FILM.
        name: "Réalisateurs (filmographie complète)",
        collectTargets: () => db.getDirectorPool(),
        needsRefresh: (person) => db.personNeedsFilmography(person),
        fetchAndStore: async (person) => {
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
        },
      },
    ],
  },
  // IGDB (jeux vidéo) est optionnel : sans identifiants Twitch, ce type
  // n'existe simplement pas (voir igdbEnabled en tête de fichier).
  ...(igdbEnabled
    ? {
        game: {
          fetchEntities: fetchGameEntities,
          refreshLists: refreshGameLists,
          warmLoops: [
            {
              name: "Jeux (screenshots)",
              collectTargets: () => db.getGamePool(),
              needsRefresh: (game) =>
                !db.isFresh(
                  db.gameImagesFetchedAt(game.id),
                  db.TTL_MS.mediaImage,
                ),
              fetchAndStore: fetchAndStoreGameScreenshots,
            },
          ],
        },
      }
    : {}),
  music: {
    fetchEntities: fetchMusicEntities,
    refreshLists: refreshMusicLists,
  },
  country: {
    fetchEntities: fetchCountryEntities,
    warmLoops: [
      {
        name: "Pays (photos)",
        // Pexels optionnel : sans clé, le mode "flag" reste jouable sans photos.
        enabled: () => pexelsEnabled,
        collectTargets: () => db.getCountryPool(),
        needsRefresh: (country) =>
          !db.isFresh(
            db.countryPhotosFetchedAt(country.ccn3),
            db.TTL_MS.countryPhoto,
          ),
        fetchAndStore: async (country) => {
          const photos = await fetchCountryPhotosFromPexels(
            country.photo_query,
          );
          db.replaceCountryPhotos(country.ccn3, photos);
        },
      },
    ],
  },
  painter: {
    fetchEntities: fetchPainterEntities,
    warmLoops: [
      {
        name: "Peintres (tableaux)",
        collectTargets: () => db.getPainterPool(),
        needsRefresh: (person) => db.personNeedsPaintings(person),
        fetchAndStore: async (person) => {
          const images = await fetchPainterArtworksFromWikidata(
            person.external_id,
          );
          db.replacePainterArtworks(
            person.id,
            images.map((url) => commonsThumbUrl(url)),
          );
        },
      },
    ],
  },
};

// une seule cadence de rafraîchissement, pilotée par db.TTL_MS.typePool
// (~1 mois) — c'est aussi la durée de vie des données en base. Toujours
// filtré par fraîcheur (voir db.isRefreshFresh), que ce soit au démarrage ou
// lors d'un recheck périodique : un type déjà frais est un no-op. Nécessaire
// car TTL_MS.typePool (30j en ms) dépasse le délai max d'un setTimeout/
// setInterval JS (~24.8j, limite 32 bits) — on ne peut donc pas piloter
// l'appel lui-même à cette cadence (voir setInterval plus bas, qui reappelle
// cette fonction bien plus souvent que ça et laisse ce filtre absorber les
// appels superflus).
async function refreshTypes() {
  const startTs = Date.now();
  const types = Object.keys(TYPES).filter((t) => onlyWants(t));

  // --max-type-count=N (dev/test) : une fois la base déjà à N items
  // pour ce type, inutile de re-fetcher (au démarrage comme lors d'un
  // passage périodique) — le clamp post-fetch plus bas donnerait de toute
  // façon le même résultat, alors qu'on économise ici l'appel réseau.
  const atDevCap = (t) => MAX_TYPE_COUNT && db.countTypeItems(t) >= MAX_TYPE_COUNT;

  const toFetch = types.filter(
    (t) =>
      !atDevCap(t) &&
      !db.isRefreshFresh("type", t, db.TTL_MS.typePool, APP_VERSION),
  );
  logInfo(
    `Types : ${types.length - toFetch.length}/${types.length} déjà frais en base ou déjà au plafond --max-type-count, ${toFetch.length} à récupérer…`,
  );

  let done = 0;
  await mapWithConcurrency(toFetch, CATEGORY_FETCH_CONCURRENCY, async (type) => {
    const catStartTs = Date.now();
    try {
      await TYPES[type].fetchEntities();
      // pas de markRefreshed si le pool est resté vide (ex. toutes les
      // sources en échec réseau) : sinon le type reste bloqué "frais" tout
      // le TTL alors qu'il n'a aucune donnée.
      if (db.countTypeItems(type) > 0) {
        db.markRefreshed("type", type, APP_VERSION);
      } else {
        logWarn(`Type "${type}" : 0 item après fetch, pas marqué frais (retry au prochain passage).`);
      }
    } catch (e) {
      logError(`Erreur type "${type}":`, e.stack || e.message);
    }
    done++;
    const catElapsed = ((Date.now() - catStartTs) / 1000).toFixed(1);
    logInfo(
      `Types : ${done}/${toFetch.length} — "${type}" (${catElapsed}s, ${db.countTypeItems(type)} items)`,
    );
  });

  if (MAX_TYPE_COUNT) {
    for (const type of types) db.clampTypeGlobalPool(type, MAX_TYPE_COUNT);
  }

  const elapsedSec = ((Date.now() - startTs) / 1000).toFixed(1);
  logInfo(
    `Types rafraîchis en ${elapsedSec}s : ${types.length} types.`,
  );
}

// ---------- warm loops (généralisés) ----------
//
// Généralisation de la stratégie "fetch large d'abord (voir refreshTypes/
// TYPES[t].fetchEntities), complète les champs manquants ensuite" :
// chaque warm loop se réduit à ces 4 fonctions plutôt qu'à une boucle
// dupliquée pour chaque type. Chaque écriture SQLite étant déjà
// durable, il n'y a pas besoin de persistance incrémentale séparée.
async function runBackfillLoop({ name, collectTargets, needsRefresh, fetchAndStore }) {
  for (;;) {
    let sleepMs = 60 * 60 * 1000; // repasse dans 1h par défaut
    try {
      const targets = collectTargets();
      if (targets.length === 0) {
        // les types n'ont pas encore fini leur premier passage (démarrage) —
        // réessaie bientôt plutôt que d'attendre 1h pour rien
        sleepMs = 10_000;
      } else {
        const toWarm = targets.filter(needsRefresh);
        logInfo(
          `${name} : ${targets.length - toWarm.length}/${targets.length} déjà chauds, ${toWarm.length} à récupérer…`,
        );
        let warmed = 0;
        let failed = 0;
        await mapWithConcurrency(
          toWarm,
          IMAGE_FETCH_CONCURRENCY,
          async (target) => {
            try {
              await fetchAndStore(target);
            } catch (e) {
              // erreur réseau : on retentera au prochain passage — journalisé
              // en debug seulement (fréquent/transitoire), voir le compteur
              // "failed" du résumé pour repérer un taux d'échec anormal.
              failed++;
              logDebug(
                `${name} : échec sur cible ${target.id ?? target.ccn3 ?? "?"} — ${e.message}`,
              );
              return;
            }
            warmed++;
            if (warmed % 100 === 0 || warmed === toWarm.length) {
              logInfo(`${name} : ${warmed}/${toWarm.length}`);
            }
          },
        );
        logInfo(
          `${name} : passage terminé — ${targets.length} cibles, ${warmed} chauffées${failed ? `, ${failed} échecs` : ""}. Prochain contrôle dans 1h.`,
        );
      }
    } catch (e) {
      logError(`Erreur warm cache ${name}:`, e.stack || e.message);
    }
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}

// démarre chaque warmLoop déclaré par chaque type actif dans TYPES.
function startWarmLoops() {
  for (const [type, cfg] of Object.entries(TYPES)) {
    if (!cfg.warmLoops || !onlyWants(type)) continue;
    for (const warmLoop of cfg.warmLoops) {
      if (warmLoop.enabled && !warmLoop.enabled()) continue;
      runBackfillLoop(warmLoop);
    }
  }
}

// cadence courte dédiée à l'appartenance aux listes (Populaire/Tendances) —
// tout le reste (entités, genres, images, réalisateurs...) est traité comme
// permanent sur TTL_MS.typePool (voir refreshTypes) ; seule cette donnée-ci
// change réellement d'un jour à l'autre (voir TTL_MS.listPool et
// TYPES[type].refreshLists). `isStartup` : au démarrage, ne rafraîchit que les
// types dont les listes ne sont pas déjà fraîches — évite qu'un redémarrage
// de refresh.js (le workflow normal désormais) laisse les listes stagner
// jusqu'à 24h de plus avant le premier tick d'intervalle. En mode
// périodique, l'intervalle lui-même reste la seule cadence, sans condition.
async function refreshAllLists({ isStartup = false } = {}) {
  const types = Object.keys(TYPES).filter(
    (t) => onlyWants(t) && TYPES[t].refreshLists,
  );
  const toRefresh = isStartup
    ? types.filter((t) => !db.isRefreshFresh("list", t, db.TTL_MS.listPool))
    : types;
  await mapWithConcurrency(toRefresh, CATEGORY_FETCH_CONCURRENCY, async (type) => {
    try {
      await TYPES[type].refreshLists();
      db.markRefreshed("list", type);
      logInfo(`Listes : "${type}" mises à jour.`);
    } catch (e) {
      logError(`Erreur listes "${type}":`, e.stack || e.message);
    }
  });
}

db.syncDirectorPoolFromMovieDirector();
db.syncDirectorFiltersFromMovies();
refreshTypes();
refreshAllLists({ isStartup: true });
// recheck bien plus fréquent que TTL_MS.typePool (~1 mois, hors de portée
// d'un setInterval JS, voir refreshTypes) : le filtre isRefreshFresh à
// l'intérieur absorbe les appels tant qu'aucun type n'a expiré.
setInterval(() => refreshTypes(), db.TTL_MS.listPool).unref();
setInterval(() => refreshAllLists(), db.TTL_MS.listPool).unref();
startWarmLoops();
