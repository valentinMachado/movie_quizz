import * as db from "../index.js";
import { PERSON_GENDERS } from "./config.js";

export async function mapWithConcurrency(items, limit, fn) {
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

// tague chaque source d'un GROUPE de filtre (liste, decennie, geographie...)
// avec la clé config.json correspondante — sert ensuite à savoir, par
// entité, quel(s) code(s) de CE groupe elle a rencontré(s) (voir
// fetchTmdbListPool/fetchIgdbListPool/storeFilterGroup). "genre" n'utilise
// PAS ce mécanisme (extrait directement des champs genre_ids/genres.id déjà
// présents sur chaque item, voir storeTmdbGenres) — seuls les groupes
// dérivés d'une source de crawl distincte (liste/decennie/geographie)
// passent par du "source-tracking".
export function withFilterCodes(sourcesObj, filterGroup) {
  return Object.entries(sourcesObj).map(([code, src]) => ({
    ...src,
    filterGroup,
    filterCode: code,
  }));
}

// alimente Map<entityId, Map<filterGroup, Set<code>>> — no-op si la source
// ne porte pas de filterGroup (décennie/genre/pays de découverte, listes
// simples sans tracking). Partagé par fetchTmdbListPool et fetchIgdbListPool.
export function tagFilter(filterTagsByItemId, entityId, filterGroup, filterCode) {
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
export function storeFilterGroup(type, filterGroup, sourcesConfig, items, filterTagsByItemId) {
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

// 2 paliers de popularité (popularity TMDb, total_rating_count IGDB...),
// ajoutés au groupe "liste" existant plutôt que dans un groupe séparé —
// seulement pour ce qui n'est PAS déjà dans la liste "Populaire" (`popularIds`,
// voir popularIdsFrom) : ce sous-ensemble est déjà "bien connu", pas besoin
// d'un palier en plus. Coupure à la médiane du reste (pas de seuil absolu,
// s'auto-ajuste à chaque crawl complet). Une entité sans valeur connue OU
// déjà "Populaire" n'a aucun de ces 2 codes. Noms volontairement distincts
// du vocabulaire "Populaire" pour ne pas prêter à confusion (progression
// Obscur → Niche → Populaire). `POPULARITY_TIER_CODES` est passé à
// replaceEntityFilterSubset pour ne remplacer QUE ces 2 codes-là dans
// "liste" — la liste éditoriale (Populaire/Tendances/...), posée par
// storeFilterGroup dans le même appel de fetchXEntities, n'est pas
// touchée. Appelée uniquement depuis les crawls complets (fetchXEntities),
// jamais depuis les refresh lists légers (même règle que genre/décennie).
const POPULARITY_TIER_CODES = ["obscur", "niche", "star"];

// `popularCode` (optionnel) : au lieu de laisser `popularIds` SANS palier, leur
// poser ce code — la liste éditoriale devient alors le palier "populaire" d'un
// vocabulaire unique obscur → niche → populaire → star. Sert au type
// "person", dont le groupe "liste" était alimenté par deux sources aux
// vocabulaires différents : un doublon d'affichage côté client ("Acteurs
// populaires" ET "Populaire"), et surtout un acteur qui ne pouvait JAMAIS
// être "populaire", ce palier n'étant calculé que sur les personnes issues
// de Wikidata. Les autres types (movie/tv/game) gardent le comportement
// d'origine sans popularCode : ils ont plusieurs listes éditoriales
// (Populaire, Tendances...), qu'il serait faux de réduire à un palier de
// notoriété unique — mais profitent quand même de "star" ci-dessous, qui ne
// dépend PAS de popularCode : c'est toujours la moitié haute en valeur de
// `popularIds` (peu importe le nom de la liste éditoriale qui les y a mis),
// posée EN PLUS de son/ses code(s) éditorial/aux existants plutôt qu'à leur
// place.
export function storePopularityTiers(
  type,
  entries,
  popularIds = new Set(),
  { popularCode = null } = {},
) {
  const known = entries
    .filter((e) => e.value != null && !popularIds.has(e.entityId))
    .map((e) => e.value)
    .sort((a, b) => a - b);
  if (known.length === 0) return;
  const mid = known[Math.floor(known.length / 2)];
  const tierFor = (v) => (v <= mid ? "obscur" : "niche");

  const popularKnown = entries
    .filter((e) => e.value != null && popularIds.has(e.entityId))
    .map((e) => e.value)
    .sort((a, b) => a - b);
  const starMid = popularKnown.length > 0 ? popularKnown[Math.floor(popularKnown.length / 2)] : null;

  const codes = [
    { code: "obscur", name: "Obscur" },
    { code: "niche", name: "Niche" },
  ];
  // n'enregistre "star" que s'il est réellement atteignable (popularIds non
  // vide avec au moins une valeur connue) — sinon (ex. pokemon, sans
  // popularIds du tout) le chip resterait affiché mais toujours à 0 résultat.
  if (starMid != null) codes.push({ code: "star", name: "Star" });
  if (popularCode) codes.push({ code: popularCode, name: "Populaire" });
  db.upsertFilters(type, "liste", codes);
  db.replaceEntityFilterSubset(
    type,
    "liste",
    popularCode ? [...POPULARITY_TIER_CODES, popularCode] : POPULARITY_TIER_CODES,
    entries.map((e) => ({
      entityId: e.entityId,
      codes: popularIds.has(e.entityId)
        ? starMid != null && e.value != null && e.value > starMid
          ? ["star"]
          : popularCode
            ? [popularCode]
            : []
        : e.value == null
          ? []
          : [tierFor(e.value)],
    })),
  );
}

// 4 quartiles directs sur la valeur, SANS source "Populaire" séparée à
// exclure (contrairement à storePopularityTiers ci-dessus, pensé pour
// movie/tv/game/person-acteurs qui ONT une vraie liste "Populaire" TMDb à
// part) — pour tout ce qui n'a que la valeur elle-même comme signal de
// notoriété (peintre/politicien/article Wikipédia via sitelinks ou
// pageviews). Recalculé à chaque crawl complet, sur le sous-ensemble
// `entries` passé (voir storeFilterGroup pour la même portée par entityId).
export function storeTertilePopularityTiers(type, entries) {
  const known = entries
    .filter((e) => e.value != null)
    .map((e) => e.value)
    .sort((a, b) => a - b);
  if (known.length === 0) return;
  const q1 = known[Math.floor(known.length / 4)];
  const q2 = known[Math.floor((known.length * 2) / 4)];
  const q3 = known[Math.floor((known.length * 3) / 4)];
  const tierFor = (v) =>
    v <= q1 ? "obscur" : v <= q2 ? "niche" : v <= q3 ? "populaire" : "star";
  db.upsertFilters(type, "liste", [
    { code: "obscur", name: "Obscur" },
    { code: "niche", name: "Niche" },
    { code: "populaire", name: "Populaire" },
    { code: "star", name: "Star" },
  ]);
  db.replaceEntityFilters(
    type,
    "liste",
    entries.map((e) => ({
      entityId: e.entityId,
      codes: e.value == null ? [] : [tierFor(e.value)],
    })),
  );
}

// entités taguées par la source "Populaire" d'un type (voir tagFilter) —
// sert à exclure ces entités du split Connu/Confidentiel (storePopularityTiers).
export function popularIdsFrom(items, filterTagsByItemId, popularCode) {
  return new Set(
    items
      .filter((item) => filterTagsByItemId.get(item.id)?.get("liste")?.has(popularCode))
      .map((item) => item.id),
  );
}

// filtre "gender" (Homme/Femme/Non-binaire, voir PERSON_GENDERS) pour
// person/actor/director/painter (toutes des lignes `person`, `gender` posé
// par TMDb OU Wikidata selon la source — voir tmdbGenderCode dans tmdb.js et
// fetchGenders dans wikidata.js) ET statesman (le chef d'État EST une ligne
// `person`, liée via country.leader_person_id — voir
// fetchAndStoreCountryLeader). Purement local (aucun appel réseau) :
// recalculé à chaque appel de syncDerivedPersonFilters (démarrage + toutes
// les heures, voir refresh.js), donc jamais besoin d'invalider un checkpoint
// pour cette raison — converge tout seul à mesure que `gender` se remplit.
// PERSON_GENDERS est {code, label} (config.json) ; upsertFilters attend
// {code, name} — même remapping que SUPERHERO_GENDERS dans superhero.js.
const GENDER_FILTER_DEFS = PERSON_GENDERS.map(({ code, label }) => ({ code, name: label }));

export function syncGenderFilters() {
  for (const [type, pool] of [
    ["person", db.getPersonPool()],
    ["actor", db.getActorPool()],
    ["director", db.getDirectorPool()],
    ["painter", db.getPainterPool()],
  ]) {
    db.upsertFilters(type, "gender", GENDER_FILTER_DEFS);
    db.replaceEntityFilters(
      type,
      "gender",
      pool.map((p) => ({ entityId: p.id, codes: p.gender ? [p.gender] : [] })),
    );
  }
  db.upsertFilters("statesman", "gender", GENDER_FILTER_DEFS);
  db.replaceEntityFilters(
    "statesman",
    "gender",
    db
      .getCountryLeaderGenders()
      .map((c) => ({ entityId: c.ccn3, codes: c.gender ? [c.gender] : [] })),
  );
}

// obscur/niche/populaire/star pour "statesman" — même mécanique que
// storeTertilePopularityTiers (peintre/politicien/wiki_article), sur la
// notoriété (sitelinks) déjà posée sur la personne du chef d'État (voir
// fetchAndStoreCountryLeader). Purement local, comme syncGenderFilters
// ci-dessus (et syncPainterPopularityTiers dans wikidata.js) : recalculé à
// chaque appel de syncDerivedPersonFilters, converge tout seul.
export function syncStatesmanPopularityTiers() {
  storeTertilePopularityTiers(
    "statesman",
    db.getCountryLeaderPopularities().map((c) => ({ entityId: c.ccn3, value: c.popularity })),
  );
}
