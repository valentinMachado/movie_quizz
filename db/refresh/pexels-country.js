import * as db from "../index.js";
import { PEXELS_API_KEY } from "./config.js";
import { logWarn } from "./log.js";
import { wikidataQuery } from "./wikidata.js";

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

// population — absente de countries.json (vérifié en direct sur le fichier
// upstream : le schéma mledoze a "area" mais plus aucun champ "population",
// contrairement à ce que storeCountryPopulation supposait — cause du filtre
// "population" qui ne renvoyait jamais rien). Récupérée séparément via
// Wikidata (P1082, gratuit sans clé), recoupée par ISO 3166-1 alpha-2 (P297)
// sur le cca2 déjà connu de mledoze. Une seule requête groupée sans VALUES :
// P297 est une propriété assez rare pour couvrir tous les pays en un aller-
// retour (~250 résultats), pas besoin du batch/300 par qid utilisé ailleurs
// dans wikidata.js. wdt:P1082 ne renvoie que les déclarations "truthy"
// (rang préféré, ou rang normal si aucune préférée) : le premier résultat
// rencontré par pays suffit, même tolérance que fetchBirthDates/
// fetchPositionsHeld (pas de notion fiable de "la meilleure" valeur).
async function fetchCountryPopulations(cca2Codes) {
  const wanted = new Set(cca2Codes.map((c) => c.toUpperCase()));
  const sparql =
    "SELECT ?iso2 ?population WHERE { " +
    "?country wdt:P297 ?iso2; wdt:P1082 ?population. " +
    "}";
  const populations = new Map(); // cca2 -> nombre
  try {
    const data = await wikidataQuery(
      `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}`,
    );
    for (const b of data.results?.bindings || []) {
      const iso2 = b.iso2?.value;
      const population = b.population?.value;
      if (!iso2 || !population || !wanted.has(iso2)) continue;
      if (!populations.has(iso2)) populations.set(iso2, parseInt(population, 10));
    }
  } catch (e) {
    logWarn("Erreur population pays Wikidata:", e.message);
  }
  return populations;
}

// pool plat : tous les pays (hors Antarctique), plus de découpe par
// continent — c'était le seul rôle de l'ancien découpage en catégories.
export async function fetchCountryEntities() {
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
      population: c.population ?? null,
      area: c.area ?? null,
      subregion: c.subregion || null,
    });
  }
  const populations = await fetchCountryPopulations(rows.map((r) => r.cca2));
  for (const r of rows) {
    if (r.population == null) r.population = populations.get(r.cca2.toUpperCase()) ?? null;
  }
  db.upsertCountries(rows);
  db.replaceTypeItems(
    "country",
    rows.map((r) => r.ccn3),
  );
  storeCountryGeography(rows);
  storeCountryPopulation(rows);
  storeCountrySuperficie(rows);
}

// continent (region mledoze, nomenclature UN, 5 valeurs hors Antarctique) —
// renommage FR pur, aucune recomposition de liste de pays.
const CONTINENT_LABELS = {
  Africa: "Afrique",
  Americas: "Amériques",
  Asia: "Asie",
  Europe: "Europe",
  Oceania: "Océanie",
};

// subregion (mledoze, nomenclature UN M49, 24 valeurs) — renommage FR pur
// pour rester lisible dans un quiz. "Western Asia" -> "Moyen-Orient" est une
// simplification assumée : la nomenclature UN y range aussi le Caucase
// (Arménie, Géorgie, Azerbaïdjan) et Chypre. Exporté : réutilisé tel quel
// par storeWikiArticleGeography (wikipedia.js) pour regrouper ses ~190
// filtres pays en sous-régions, même vocabulaire que "country".
export const SUBREGION_LABELS = {
  "Northern Africa": "Afrique du Nord",
  "Eastern Africa": "Afrique de l'Est",
  "Middle Africa": "Afrique Centrale",
  "Southern Africa": "Afrique Australe",
  "Western Africa": "Afrique de l'Ouest",
  "North America": "Amérique du Nord",
  Caribbean: "Caraïbes",
  "Central America": "Amérique Centrale",
  "South America": "Amérique du Sud",
  "Central Asia": "Asie Centrale",
  "Eastern Asia": "Asie de l'Est",
  "South-Eastern Asia": "Asie du Sud-Est",
  "Southern Asia": "Asie du Sud",
  "Western Asia": "Moyen-Orient",
  "Central Europe": "Europe Centrale",
  "Eastern Europe": "Europe de l'Est",
  "Northern Europe": "Europe du Nord",
  "Southeast Europe": "Europe du Sud-Est",
  "Southern Europe": "Europe du Sud",
  "Western Europe": "Europe de l'Ouest",
  "Australia and New Zealand": "Australie & Nouvelle-Zélande",
  Melanesia: "Mélanésie",
  Micronesia: "Micronésie",
  Polynesia: "Polynésie",
};

// groupe transversal (traverse plusieurs continents/subregions) codé à la
// main, cca2 en minuscules — impossible à dériver de region/subregion, qui
// suivent une logique purement continentale.
const MEDITERRANEAN_CCA2 = new Set([
  "es", "fr", "mc", "it", "mt", "si", "hr", "ba", "me", "al", "gr", "tr",
  "cy", "sy", "lb", "il", "ps", "eg", "ly", "tn", "dz", "ma",
]);

// tague chaque pays avec continent + subregion (renommés) + "mediterranean"
// s'il y a lieu — tout dans le groupe "geographie", au même niveau que le
// tag pays déjà posé sur movie/tv/painter (voir movieCountrySources) : OR
// entre ces codes à la lecture (getTypePool), donc sélectionner "Europe" ET
// "Moyen-Orient" renvoie l'union des deux, pas leur intersection.
function storeCountryGeography(rows) {
  db.upsertFilters(
    "country",
    "geographie",
    Object.entries(CONTINENT_LABELS).map(([code, name]) => ({ code, name })),
  );
  db.upsertFilters(
    "country",
    "geographie",
    Object.entries(SUBREGION_LABELS).map(([code, name]) => ({ code, name })),
  );
  db.upsertFilters("country", "geographie", [
    { code: "mediterranean", name: "Méditerranée" },
  ]);
  db.replaceEntityFilters(
    "country",
    "geographie",
    rows.map((r) => {
      const codes = [];
      if (CONTINENT_LABELS[r.region]) codes.push(r.region);
      if (r.subregion && SUBREGION_LABELS[r.subregion]) codes.push(r.subregion);
      if (MEDITERRANEAN_CCA2.has(r.cca2.toLowerCase())) codes.push("mediterranean");
      return { entityId: r.ccn3, codes };
    }),
  );
}

// mêmes bornes que MUSIC_DECADE_BOUNDARIES (voir music.js) : calculées
// directement depuis un champ déjà stocké (population), pas besoin d'un
// crawl dédié — couverture complète.
const POPULATION_BUCKETS = [
  { code: "pop_under_1m", label: "< 1 million d'habitants", lt: 1_000_000 },
  { code: "pop_1m_10m", label: "1 à 10 millions d'habitants", gte: 1_000_000, lt: 10_000_000 },
  { code: "pop_10m_50m", label: "10 à 50 millions d'habitants", gte: 10_000_000, lt: 50_000_000 },
  { code: "pop_50m_100m", label: "50 à 100 millions d'habitants", gte: 50_000_000, lt: 100_000_000 },
  { code: "pop_over_100m", label: "> 100 millions d'habitants", gte: 100_000_000 },
];

function bucketCode(buckets, value) {
  if (!Number.isFinite(value)) return null;
  const bucket = buckets.find(
    (b) => (b.gte == null || value >= b.gte) && (b.lt == null || value < b.lt),
  );
  return bucket?.code || null;
}

function storeCountryPopulation(rows) {
  db.upsertFilters(
    "country",
    "population",
    POPULATION_BUCKETS.map((b) => ({ code: b.code, name: b.label })),
  );
  db.replaceEntityFilters(
    "country",
    "population",
    rows.map((r) => {
      const code = bucketCode(POPULATION_BUCKETS, r.population);
      return { entityId: r.ccn3, codes: code ? [code] : [] };
    }),
  );
}

// superficie en km², même mécanique que storeCountryPopulation.
const AREA_BUCKETS = [
  { code: "area_under_10k", label: "< 10 000 km²", lt: 10_000 },
  { code: "area_10k_100k", label: "10 000 à 100 000 km²", gte: 10_000, lt: 100_000 },
  { code: "area_100k_1m", label: "100 000 km² à 1 million de km²", gte: 100_000, lt: 1_000_000 },
  { code: "area_over_1m", label: "> 1 million de km²", gte: 1_000_000 },
];

function storeCountrySuperficie(rows) {
  db.upsertFilters(
    "country",
    "superficie",
    AREA_BUCKETS.map((b) => ({ code: b.code, name: b.label })),
  );
  db.replaceEntityFilters(
    "country",
    "superficie",
    rows.map((r) => {
      const code = bucketCode(AREA_BUCKETS, r.area);
      return { entityId: r.ccn3, codes: code ? [code] : [] };
    }),
  );
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

// warmLoop "Pays (photos)"
export async function fetchAndStoreCountryPhotos(country) {
  const photos = await fetchCountryPhotosFromPexels(country.photo_query);
  db.replaceCountryPhotos(country.ccn3, photos);
}
