import { createHash } from "node:crypto";
import * as db from "../index.js";
import { logWarn, logInfo } from "./log.js";
import {
  PAINTING_GENRES,
  PERSON_ROLE_QUERY_LIMIT,
  PERSON_ROLE_COUNTRIES,
  PERSON_ROLE_ERAS,
  PERSON_ROLES,
  CATEGORY_FETCH_CONCURRENCY,
  DEMONYMS,
} from "./config.js";
import {
  mapWithConcurrency,
  tagFilter,
  storeFilterGroup,
  storeTertilePopularityTiers,
} from "./util.js";
import { fetchExtractsByTitles } from "./wikipedia.js";
import {
  ensureFrwikiIndex,
  ensureMultistreamIndex,
  ensurePageviewIndex,
  extractsFromDump,
  frenchTitlesByQid,
  pageIdFromTitle,
  pageviewsByTitle,
} from "./frwiki-dump.js";

// Résumés par TITRE, depuis le dump multistream quand il est disponible —
// c'était le second gros consommateur d'api.php après wiki_article (un lot de
// 20 titres toutes les ~18 s pour 1 138 peintres, 1 122 politiciens…). Le dump
// est indexé par pageid, d'où la traduction titre -> pageid en local. Repli
// sur l'API si l'index n'est pas là (dump désactivé, première construction en
// échec) : ce chemin-là n'a pas de raison de perdre des personnes.
async function extractsForTitles(titles) {
  if (!(await ensureFrwikiIndex()) || !(await ensureMultistreamIndex())) {
    return await fetchExtractsByTitles(titles);
  }
  const titleByPageId = new Map();
  for (const title of titles) {
    const pageid = pageIdFromTitle(title);
    if (pageid != null) titleByPageId.set(pageid, title);
  }
  const byPageId = await extractsFromDump([...titleByPageId.keys()]);
  const out = new Map();
  for (const [pageid, extract] of byPageId) out.set(titleByPageId.get(pageid), extract);
  return out;
}

// peintures — Wikidata (query.wikidata.org), gratuit, sans clé, couvre
// toutes les collections (pas un seul musée). On devine le PEINTRE (title =
// nom du créateur, stocké comme `person` source=wikidata), pas le tableau.
// Images servies depuis Wikimedia Commons (upload.wikimedia.org).
//
// Le peintre est DÉCOUVERT exactement comme un politicien/athlète (voir
// PAINTER_ROLE/fetchPainterEntities plus bas, par-dessus
// fetchPersonRoleEntities) : popularité/pays/époque DE LA PERSONNE (P106
// direct, sitelinks, P27, P569), pas des caractéristiques d'un tableau —
// vérifié en direct sur query.wikidata.org, aucun timeout à LIMIT 100 (voir
// commentaire sur PERSON_ROLE_QUERY_LIMIT dans config.js). Seul le mouvement
// artistique (P135, "genre" du type `painter`) reste une requête dédiée
// (paintingMovementsSparql ci-dessous), directement sur la fiche du peintre.
// Les TABLEAUX eux-mêmes (Q3305213 = peinture (instance of), P170 =
// créateur) restent une étape 2 séparée, une fois le peintre déjà connu —
// voir fetchPainterArtworksFromWikidata/fetchAndStorePainterArtworks plus
// bas, inchangés.

// Wikidata (peintures) : endpoint public, pas de clé, mais renvoie parfois
// des 429/502/504 même sur des requêtes simples — sérialisé + retry.
let wikidataQueueTail = Promise.resolve();
const WIKIDATA_MIN_INTERVAL_MS = 800;

export async function wikidataQuery(url) {
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

// les liens Special:FilePath renvoyés par Wikidata redirigent vers le vrai
// fichier sur upload.wikimedia.org — la chaîne de redirection casse le CORS
// dans un vrai navigateur. On résout donc l'URL directe via la convention de
// répertoires Wikimedia (dérivée du MD5 du nom de fichier), sans requête
// réseau — appliquée ici, à l'écriture, pour que server.js n'ait plus jamais
// besoin de transformer une URL peinture.
const COMMONS_WEB_SAFE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

export function commonsThumbUrl(specialFilePathUrl, width = 1280) {
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

// peintre = un rôle "person" Wikidata comme un autre (voir
// fetchPersonRoleEntities plus bas) — volontairement PAS dans
// config.json's personRoles.roles (donc pas bouclé par
// fetchAllPersonRoleEntities) : le peintre garde son propre point d'entrée
// TYPES.painter.fetchEntities (refresh.js), avec sa propre cadence de
// fraîcheur et son propre pool `type_item`, distincts de "person". Seuil de
// popularité identique à politicien/athlète, vérifié en direct sur
// query.wikidata.org (aucun timeout à LIMIT 100, voir commentaire sur
// PERSON_ROLE_QUERY_LIMIT dans config.js).
const PAINTER_ROLE = {
  code: "painter",
  label: "Peintre",
  occupationQid: "Q1028181",
  popularSitelinksMin: 20,
};

// mouvement artistique (P135) directement sur la fiche du PEINTRE (pas du
// tableau, contrairement à l'ancienne découverte par tableau) — multi-valué,
// on garde tous les mouvements connus qui matchent un QID de PAINTING_GENRES
// (les autres, hors de cette liste, sont ignorés comme n'importe quel code
// hors config, voir ex. SUPERHERO_RACES). Même schéma batch/300 que
// fetchPositionsHeld ci-dessous.
function paintingMovementsSparql(qids) {
  const values = qids.map((qid) => `wd:${qid}`).join(" ");
  return (
    "SELECT ?item ?movement WHERE { " +
    `VALUES ?item { ${values} } ` +
    "?item wdt:P135 ?movement. " +
    "}"
  );
}

async function fetchPaintingMovements(qids) {
  const knownQids = new Set(PAINTING_GENRES.map((g) => g.qid));
  const codeByQid = new Map(PAINTING_GENRES.map((g) => [g.qid, g.code]));
  const movements = new Map(); // qid peintre -> Set<code de mouvement>
  for (let i = 0; i < qids.length; i += 300) {
    const batch = qids.slice(i, i + 300);
    try {
      const data = await wikidataQuery(
        `https://query.wikidata.org/sparql?query=${encodeURIComponent(paintingMovementsSparql(batch))}`,
      );
      for (const b of data.results?.bindings || []) {
        const qid = b.item?.value?.split("/").pop();
        const movementQid = b.movement?.value?.split("/").pop();
        if (!qid || !movementQid || !knownQids.has(movementQid)) continue;
        if (!movements.has(qid)) movements.set(qid, new Set());
        movements.get(qid).add(codeByQid.get(movementQid));
      }
    } catch (e) {
      logWarn("Erreur mouvements artistiques Wikidata:", e.message);
    }
  }
  return movements;
}

// découverte du peintre déléguée à fetchPersonRoleEntities (même mécanisme
// que politicien/athlète : popularité/pays/époque DE LA PERSONNE, pas d'un
// tableau) — cette fonction ne fait plus qu'ajouter ce qui est propre au
// type `painter` : son propre pool `type_item`, le mouvement artistique
// (genre), et la réplication des tags geographie/decennie/popularité déjà
// calculés génériquement. Le tableau complet d'un peintre reste récupéré en
// tâche de fond, voir le warmLoop "Peintres (tableaux)" (inchangé).
export async function fetchPainterEntities() {
  const result = await fetchPersonRoleEntities(PAINTER_ROLE);
  if (!result) {
    db.replaceTypeItems("painter", []);
    return;
  }
  const { items, filterTagsByItem, notoriety } = result;
  db.replaceTypeItems(
    "painter",
    items.map((i) => i.id),
  );

  const movements = await fetchPaintingMovements(items.map((i) => i.qid));
  // storeFilterGroup attend filterTagsByItemId keyed par item.id (personId),
  // pas par qid — reprojection ici plutôt que de complexifier storeFilterGroup
  // pour ce seul appelant (voir même reprojection dans fetchPersonRoleEntities).
  const filterTagsByPersonId = new Map();
  for (const item of items) {
    const tags = new Map(filterTagsByItem.get(item.qid) ?? []);
    const genre = movements.get(item.qid);
    if (genre) tags.set("genre", genre);
    filterTagsByPersonId.set(item.id, tags);
  }
  storeFilterGroup(
    "painter",
    "geographie",
    Object.fromEntries(PERSON_ROLE_COUNTRIES.map((c) => [c.code, { label: c.label }])),
    items,
    filterTagsByPersonId,
  );
  storeFilterGroup(
    "painter",
    "decennie",
    Object.fromEntries(PERSON_ROLE_ERAS.map((e) => [e.code, { label: e.label }])),
    items,
    filterTagsByPersonId,
  );
  storeFilterGroup(
    "painter",
    "genre",
    Object.fromEntries(PAINTING_GENRES.map((g) => [g.code, { label: g.label }])),
    items,
    filterTagsByPersonId,
  );
  // même mécanique tertile que pour "person" dans fetchPersonRoleEntities
  // (notoriété du PEINTRE, déjà calculée là-bas) — un peintre est une
  // personne comme une autre, pas de logique de popularité à part.
  // Recalculé ensuite sur les seuls peintres ayant des œuvres, voir
  // syncPainterPopularityTiers : ici les tableaux ne sont pas encore récupérés.
  storeTertilePopularityTiers(
    "painter",
    items.map((i) => ({ entityId: i.id, value: notoriety.get(i.qid) ?? null })),
  );
}

// Tertiles recalculés sur les SEULS vrais peintres. Sans ce filtre, Freddie
// Mercury, Serge Gainsbourg ou George W. Bush — très consultés, et sans le
// moindre tableau connu de Wikidata — écrasent les peintres réels : mesuré 135
// "populaire" pour seulement 35 "obscur" sur les 263 peintres ayant au moins 3
// œuvres. Une personne sous le seuil reçoit `null`, donc AUCUN palier : elle
// est de toute façon écartée du quiz (voir PAINTER_MIN_ARTWORKS).
//
// Ici et pas dans fetchPainterEntities parce que les œuvres arrivent APRÈS le
// crawl, via le warmLoop "Peintres (tableaux)" : au moment où le pool se
// construit, on ne sait pas encore qui a des tableaux. Purement local, aucun
// appel réseau — appelé au démarrage puis toutes les heures par
// syncDerivedPersonFilters, ce qui le fait converger à mesure que le warmLoop
// remplit la table `painting`.
export function syncPainterPopularityTiers() {
  const counts = db.painterArtworkCounts();
  storeTertilePopularityTiers(
    "painter",
    db.getPainterPool().map((p) => ({
      entityId: p.id,
      value:
        (counts.get(p.id) ?? 0) >= db.PAINTER_MIN_ARTWORKS ? p.popularity : null,
    })),
  );
}

// notoriété d'un peintre = nombre de Wikipédias qui ont un article sur lui
// (wikibase:sitelinks) — contrairement au nombre de tableaux connus (essayé
// d'abord, abandonné : plafonné par le LIMIT 30 de
// fetchPainterArtworksFromWikidata, incapable de distinguer Van Gogh d'un
// peintre juste "bien documenté"), sitelinks n'a pas de plafond artificiel
// et distingue finement (vérifié manuellement : Van Gogh 263, un peintre
// mineur mais réel ~10-40, une simple attribution d'école ~0-2). Disponible
// dès la découverte du peintre (fetchPainterEntities), pas besoin d'un
// warmLoop séparé.
function wikidataSitelinksSparql(qids) {
  const values = qids.map((qid) => `wd:${qid}`).join(" ");
  return (
    "SELECT ?item ?sitelinks WHERE { " +
    `VALUES ?item { ${values} } ` +
    "?item wikibase:sitelinks ?sitelinks. " +
    "}"
  );
}

// batché par lots de 300 (limite pratique avant timeout SPARQL sur une
// clause VALUES) — via wikidataQuery, déjà sérialisé/retry (voir plus haut).
// Générique sur n'importe quel QID (peintre, politicien...), pas seulement
// des créateurs de peintures — voir fetchPersonRoleEntities.
export async function fetchWikidataSitelinks(qids) {
  const sitelinks = new Map();
  for (let i = 0; i < qids.length; i += 300) {
    const batch = qids.slice(i, i + 300);
    try {
      const data = await wikidataQuery(
        `https://query.wikidata.org/sparql?query=${encodeURIComponent(wikidataSitelinksSparql(batch))}`,
      );
      for (const b of data.results.bindings) {
        sitelinks.set(
          b.item.value.split("/").pop(),
          parseInt(b.sitelinks.value, 10),
        );
      }
    } catch (e) {
      logWarn("Erreur sitelinks Wikidata:", e.message);
    }
  }
  return sitelinks;
}

// date de naissance (P569) précise au JOUR uniquement — un P569 précis
// seulement à l'année ou au mois (courant pour une personnalité ancienne)
// est ici volontairement écarté plutôt que de remonter un "1er janvier"
// fantôme : wikibase:timePrecision suit l'échelle Wikidata standard (11 =
// jour, 10 = mois, 9 = année, ...), on ne garde que >= 11. Sans ce filtre,
// plusieurs personnes de précision "année" se retrouveraient toutes avec un
// faux anniversaire le 1er janvier dans le quiz du jour.
function wikidataBirthDatesSparql(qids) {
  const values = qids.map((qid) => `wd:${qid}`).join(" ");
  return (
    "SELECT ?item ?birth WHERE { " +
    `VALUES ?item { ${values} } ` +
    "?item p:P569/psv:P569 ?birthNode. " +
    "?birthNode wikibase:timeValue ?birth; wikibase:timePrecision ?precision. " +
    "FILTER(?precision >= 11) " +
    "}"
  );
}

// générique sur n'importe quel QID de personne (peintre, rôle Wikidata...) —
// même principe de batch/lot que fetchWikidataSitelinks/fetchPositionsHeld
// ci-dessus/ci-dessous. Une personne avec plusieurs valeurs P569 (rare, mais
// arrive sur des fiches mal nettoyées) garde la première rencontrée, comme
// fetchPositionsHeld pour P39 — pas de notion fiable de "la bonne" valeur.
async function fetchBirthDates(qids) {
  const dates = new Map(); // qid -> date ISO ("YYYY-MM-DDTHH:MM:SSZ")
  for (let i = 0; i < qids.length; i += 300) {
    const batch = qids.slice(i, i + 300);
    try {
      const data = await wikidataQuery(
        `https://query.wikidata.org/sparql?query=${encodeURIComponent(wikidataBirthDatesSparql(batch))}`,
      );
      for (const b of data.results?.bindings || []) {
        const qid = b.item?.value?.split("/").pop();
        const birth = b.birth?.value;
        if (qid && birth && !dates.has(qid)) dates.set(qid, birth);
      }
    } catch (e) {
      logWarn("Erreur dates de naissance Wikidata:", e.message);
    }
  }
  return dates;
}

// sexe/genre (P21) — deux usages : désambiguïser les libellés d'occupation/
// poste ci-dessous (specificOccupation/positionHeld, voir degenderLabel),
// ET alimenter le filtre "gender" (person/painter/statesman, voir
// syncGenderFilters dans util.js). Seuls Q6581097 (masculin) et Q6581072
// (féminin) sont reconnus précisément ; toute autre valeur EXPLICITE (non-
// binaire, intersexe...) devient "non_binary" — un P21 absent reste `null`
// (jamais confondu avec un P21 non-binaire explicite).
function wikidataGendersSparql(qids) {
  const values = qids.map((qid) => `wd:${qid}`).join(" ");
  return (
    "SELECT ?item ?gender WHERE { " +
    `VALUES ?item { ${values} } ` +
    "?item wdt:P21 ?gender. " +
    "}"
  );
}

export async function fetchGenders(qids) {
  const genders = new Map(); // qid -> "male" | "female" | "non_binary"
  for (let i = 0; i < qids.length; i += 300) {
    const batch = qids.slice(i, i + 300);
    try {
      const data = await wikidataQuery(
        `https://query.wikidata.org/sparql?query=${encodeURIComponent(wikidataGendersSparql(batch))}`,
      );
      for (const b of data.results?.bindings || []) {
        const qid = b.item?.value?.split("/").pop();
        const genderQid = b.gender?.value?.split("/").pop();
        if (!qid || !genderQid || genders.has(qid)) continue;
        if (genderQid === "Q6581097") genders.set(qid, "male");
        else if (genderQid === "Q6581072") genders.set(qid, "female");
        else genders.set(qid, "non_binary");
      }
    } catch (e) {
      logWarn("Erreur genre Wikidata:", e.message);
    }
  }
  return genders;
}

// "acteur ou actrice" -> "actrice"/"acteur" selon `gender` — coupe sur le
// PREMIER " ou " seulement (un libellé sans double genre, ex. "romancier",
// n'en contient jamais et ressort inchangé). `gender` absent/non reconnu :
// garde la forme masculine (1re moitié), déjà la forme utilisée telle
// quelle avant ce correctif — jamais une régression, seulement une
// amélioration quand le genre est connu.
function degenderLabel(label, gender) {
  if (!label) return label;
  const i = label.indexOf(" ou ");
  if (i === -1) return label;
  return gender === "female" ? label.slice(i + 4) : label.slice(0, i);
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

// warmLoop "Peintres (tableaux)"
export async function fetchAndStorePainterArtworks(person) {
  const images = await fetchPainterArtworksFromWikidata(person.external_id);
  db.replacePainterArtworks(
    person.id,
    images.map((url) => commonsThumbUrl(url)),
  );
}

// ---------- rôles "person" génériques via Wikidata (politicien, et tout
// futur rôle similaire) ----------
//
// Contrairement au peintre (fetchPainterEntities ci-dessus), un rôle ici n'a
// PAS de second pool dédié (pas d'équivalent "deviner un tableau") : l'entité
// EST directement la personne (P18 = sa photo), pas une œuvre qu'elle a
// créée. Un rôle se réduit donc à { code, label, occupationQid,
// popularSitelinksMin } dans config.json (CONFIG.personRoles.roles) —
// ajouter un rôle (scientifique, écrivain...) ne demande aucun code
// supplémentaire, voir fetchAllPersonRoleEntities.
//
// pays/époques sont volontairement PARTAGÉS entre tous les rôles (voir
// PERSON_ROLE_COUNTRIES/PERSON_ROLE_ERAS dans config.js) : P27 (citoyenneté)
// et P569 (date de naissance) sont des axes génériques à n'importe quelle
// personne, pas spécifiques à un métier.
function personRoleSourceFilters(role) {
  const filters = [{ kind: "popular" }];
  for (const c of PERSON_ROLE_COUNTRIES)
    filters.push({ kind: "country", code: c.code, qid: c.qid });
  for (const e of PERSON_ROLE_ERAS)
    filters.push({ kind: "era", code: e.code, gte: e.gte, lte: e.lte });
  return filters;
}

// pas de GROUP BY/SAMPLE ici (essayé d'abord, abandonné : timeout Wikidata
// même à LIMIT 5, vérifié manuellement sur les 3 axes — l'agrégation force
// apparemment l'endpoint à évaluer bien plus que la fenêtre LIMIT avant de
// grouper). Requête plate comme paintingSparql : un item avec plusieurs
// photos (P18 multi-valué) peut donc apparaître plusieurs fois dans les
// bindings, mais byItem (Map) dédoublonne déjà par qid côté appelant — la
// seule conséquence est un léger biais vers les personnes déjà bien
// illustrées sur Commons, accepté comme pour painting.
function personRoleSparql(role, filter, limit) {
  let extra = "";
  if (filter.kind === "popular") {
    extra = `?item wikibase:sitelinks ?sl. FILTER(?sl >= ${role.popularSitelinksMin})`;
  } else if (filter.kind === "country") {
    extra = `?item wdt:P27 wd:${filter.qid}.`;
  } else if (filter.kind === "era") {
    // date de naissance (P569) comme ancre temporelle : quasi toujours
    // connue sur Wikidata pour une personnalité publique, contrairement à
    // une éventuelle "période d'activité" bien moins systématiquement
    // renseignée.
    extra = `?item wdt:P569 ?birth. FILTER(YEAR(?birth) >= ${filter.gte} && YEAR(?birth) <= ${filter.lte})`;
  }
  return (
    "SELECT ?item ?image WHERE { " +
    `?item wdt:P106 wd:${role.occupationQid}; wdt:P18 ?image. ${extra} ` +
    `} LIMIT ${limit}`
  );
}

// titre d'article Wikipédia FR par QID, via schema:about/schema:isPartOf
// (SPARQL, reste sur query.wikidata.org comme le reste du fichier) plutôt
// que l'API wbgetentities&props=sitelinks (REST www.wikidata.org, un hôte —
// et donc une politique de débit — distinct). Sert de base au résumé (voir
// fetchExtractsByTitles dans wikipedia.js) : sans article FR connu, pas de
// résumé pour cette personne, comme un peintre sans portrait connu reste
// simplement sans image.
function frenchWikipediaTitlesSparql(qids) {
  const values = qids.map((qid) => `wd:${qid}`).join(" ");
  return (
    "SELECT ?item ?article WHERE { " +
    `VALUES ?item { ${values} } ` +
    "?article schema:about ?item; schema:isPartOf <https://fr.wikipedia.org/>. " +
    "}"
  );
}

// L'index local porte le même lien QID <-> article français que ce SPARQL
// (page_props), simplement rangé dans l'autre sens : quand il est là, on ne
// sort pas du disque. Vérifié sur 800 personnes en base, 800 titres
// identiques. Le SPARQL reste le chemin quand l'index est absent.
async function resolveFrenchWikipediaTitles(qids) {
  if (await ensureFrwikiIndex()) {
    const byQid = frenchTitlesByQid(qids);
    return new Map([...byQid].map(([qid, { title }]) => [qid, title]));
  }
  return await resolveFrenchWikipediaTitlesSparql(qids);
}

async function resolveFrenchWikipediaTitlesSparql(qids) {
  const titles = new Map(); // qid -> titre
  for (let i = 0; i < qids.length; i += 300) {
    const batch = qids.slice(i, i + 300);
    try {
      const data = await wikidataQuery(
        `https://query.wikidata.org/sparql?query=${encodeURIComponent(frenchWikipediaTitlesSparql(batch))}`,
      );
      for (const b of data.results?.bindings || []) {
        const qid = b.item?.value?.split("/").pop();
        const articleUrl = b.article?.value;
        if (!qid || !articleUrl) continue;
        titles.set(qid, decodeURIComponent(articleUrl.split("/wiki/").pop()).replace(/_/g, " "));
      }
    } catch (e) {
      logWarn("Erreur titres Wikipédia FR (Wikidata):", e.message);
    }
  }
  return titles;
}

// poste occupé (P39) — une personne en a souvent plusieurs (mandats
// successifs) sans ordre de notoriété fiable côté Wikidata ; on garde le
// PREMIER rencontré plutôt que de tenter de deviner "le" poste le plus
// notable (garde simple, affiché seulement "si présent" au reveal — voir
// materializePersonRow côté server.js).
function positionHeldSparql(qids) {
  const values = qids.map((qid) => `wd:${qid}`).join(" ");
  return (
    "SELECT ?item ?positionLabel WHERE { " +
    `VALUES ?item { ${values} } ` +
    "?item wdt:P39 ?position. " +
    "?position rdfs:label ?positionLabel. " +
    'FILTER(LANG(?positionLabel) = "fr") ' +
    "}"
  );
}

async function fetchPositionsHeld(qids) {
  const positions = new Map(); // qid -> premier libellé rencontré
  for (let i = 0; i < qids.length; i += 300) {
    const batch = qids.slice(i, i + 300);
    try {
      const data = await wikidataQuery(
        `https://query.wikidata.org/sparql?query=${encodeURIComponent(positionHeldSparql(batch))}`,
      );
      for (const b of data.results?.bindings || []) {
        const qid = b.item?.value?.split("/").pop();
        const label = b.positionLabel?.value;
        if (qid && label && !positions.has(qid)) positions.set(qid, label);
      }
    } catch (e) {
      logWarn("Erreur poste occupé Wikidata:", e.message);
    }
  }
  return positions;
}

// métier précis (P106) — une personne a souvent PLUSIEURS occupations, dont
// celle utilisée pour la découvrir (role.occupationQid, ex. Q2066131
// "athlète" pour le rôle "athlete") : on ignore cette dernière et on garde le
// premier libellé restant, plus précis (ex. "joueur de tennis"), affiché "si
// présent" au reveal — voir materializePersonRows côté server.js. Même
// schéma batch/300 que positionHeldSparql ci-dessus.
function specificOccupationsSparql(qids) {
  const values = qids.map((qid) => `wd:${qid}`).join(" ");
  return (
    "SELECT ?item ?occupation ?occupationLabel WHERE { " +
    `VALUES ?item { ${values} } ` +
    "?item wdt:P106 ?occupation. " +
    "?occupation rdfs:label ?occupationLabel. " +
    'FILTER(LANG(?occupationLabel) = "fr") ' +
    "}"
  );
}

async function fetchSpecificOccupations(qids, excludeQid) {
  const occupations = new Map(); // qid -> premier libellé "spécifique" rencontré
  for (let i = 0; i < qids.length; i += 300) {
    const batch = qids.slice(i, i + 300);
    try {
      const data = await wikidataQuery(
        `https://query.wikidata.org/sparql?query=${encodeURIComponent(specificOccupationsSparql(batch))}`,
      );
      for (const b of data.results?.bindings || []) {
        const qid = b.item?.value?.split("/").pop();
        const occupationQid = b.occupation?.value?.split("/").pop();
        const label = b.occupationLabel?.value;
        if (!qid || !occupationQid || !label || occupationQid === excludeQid)
          continue;
        if (!occupations.has(qid)) occupations.set(qid, label);
      }
    } catch (e) {
      logWarn("Erreur métier précis Wikidata:", e.message);
    }
  }
  return occupations;
}

// peuple le pool "person" (additif, voir db.addTypeItems) avec un rôle donné
// — même principe multi-source que fetchPersonEntities (acteurs)/le warmLoop
// réalisateurs/fetchPainterEntities : chacun ne connaît que sa propre
// contribution, jamais de replaceTypeItems ici.
export async function fetchPersonRoleEntities(role) {
  const byItem = new Map(); // qid -> image url (première trouvée)
  const filterTagsByItem = new Map();
  const filters = personRoleSourceFilters(role);
  let done = 0;
  const startTs = Date.now();
  await mapWithConcurrency(filters, CATEGORY_FETCH_CONCURRENCY, async (filter) => {
    let bindings;
    try {
      const data = await wikidataQuery(
        `https://query.wikidata.org/sparql?query=${encodeURIComponent(
          personRoleSparql(role, filter, PERSON_ROLE_QUERY_LIMIT),
        )}`,
      );
      bindings = data.results?.bindings || [];
    } catch (e) {
      logWarn(`Erreur ${role.code} (filtre ${filter.kind}):`, e.message);
      return;
    } finally {
      done++;
      // Wikidata sérialisé à ~1 requête/800ms (voir wikidataQuery) : ce
      // crawl peut prendre plusieurs minutes en silence sans ce repère.
      logInfo(
        `${role.code} : filtre ${done}/${filters.length} (${filter.kind}) — ${byItem.size} personnes cumulées (${((Date.now() - startTs) / 1000).toFixed(1)}s)`,
      );
    }
    for (const b of bindings) {
      const qid = b.item?.value?.split("/").pop();
      const image = b.image?.value;
      if (!qid || !/^Q\d+$/.test(qid) || !image) continue;
      if (!byItem.has(qid)) byItem.set(qid, image);
      if (filter.kind === "country")
        tagFilter(filterTagsByItem, qid, "geographie", filter.code);
      else if (filter.kind === "era")
        tagFilter(filterTagsByItem, qid, "decennie", filter.code);
    }
  });
  if (byItem.size === 0) return null;

  const qids = [...byItem.keys()];
  const labels = await resolveWikidataLabels(qids);
  const sitelinks = await fetchWikidataSitelinks(qids);
  // résumé (extrait Wikipédia FR, pour une future questionType "résumé" —
  // non matérialisée ici, voir materializePersonRow côté server.js) + poste
  // occupé (P39) + métier précis (P106, hors classe générique du rôle) :
  // toujours calculés pour TOUT rôle person-Wikidata, pas seulement
  // "politicien" — un rôle futur (scientifique...) en profite gratuitement,
  // sans code supplémentaire. Les deux sont affichés "si présents" au reveal
  // — voir materializePersonRows côté server.js.
  const frTitles = await resolveFrenchWikipediaTitles(qids);
  const extractsByTitle = await extractsForTitles([...new Set(frTitles.values())]);

  // NOTORIÉTÉ — consultations de l'article FRANÇAIS quand l'index local des
  // dumps est disponible, sitelinks (nombre de langues ayant un article) en
  // repli. Les sitelinks restent indispensables à la DÉCOUVERTE (c'est
  // popularSitelinksMin qui borne la requête SPARQL plus haut), mais ils
  // mesurent une notoriété encyclopédique mondiale : ils enterraient des
  // peintres connus en France et faute traduits (Yan Pei-Ming #996, Raymond-
  // Émile Waydelich #1098) tout en propulsant des inconnus ici à forte
  // couverture (un humoriste brésilien #145, un politicien kazakh #271).
  //
  // Une personne sans article français vaut 0, pas "inconnu" : pour un quiz
  // francophone, aucun article en français signifie que personne ne la
  // devinera (décision explicite de l'utilisateur, 2026-08-04).
  // ensureFrwikiIndex et pas frwikiIndexReady : on est dans un fetchEntities,
  // et refreshTypes lance les types en parallèle — attendre que wiki_article
  // ait ouvert l'index reviendrait à tirer à pile ou face entre pageviews et
  // repli sitelinks selon qui démarre en premier. L'appel est mutualisé, il ne
  // provoque pas un second téléchargement.
  const usePageviews =
    (await ensureFrwikiIndex()) && (await ensurePageviewIndex());
  const viewsByTitle = usePageviews
    ? pageviewsByTitle([...new Set(frTitles.values())])
    : null;
  const notorietyOf = (qid) => {
    if (!usePageviews) return sitelinks.get(qid) ?? null;
    const title = frTitles.get(qid);
    return title ? (viewsByTitle.get(title) ?? 0) : 0;
  };
  const positions = await fetchPositionsHeld(qids);
  const specificOccupations = await fetchSpecificOccupations(qids, role.occupationQid);
  const genders = await fetchGenders(qids);
  // P569, jour connu uniquement (voir fetchBirthDates) — homogénéise le pool
  // "person" en donnant à tout rôle Wikidata (politicien, athlète, peintre,
  // un futur rôle...) une chance d'apparaître dans le quiz du jour comme un
  // acteur/réalisateur TMDb.
  const birthDates = await fetchBirthDates(qids);
  const items = []; // { id, qid } — forme attendue par storeFilterGroup
  for (const [qid, image] of byItem) {
    const name = labels.get(qid);
    if (!name) continue;
    const portraitThumbUrl = commonsThumbUrl(image);
    const frTitle = frTitles.get(qid);
    // nationalité affichée au reveal (voir materializePersonRows côté
    // server.js) : premier code "geographie" déjà résolu ci-dessus (P27),
    // converti en démonyme FR — aucune requête de plus.
    const geoCode = [...(filterTagsByItem.get(qid)?.get("geographie") ?? [])][0];
    const personId = db.upsertPerson({
      source: "wikidata",
      externalId: qid,
      name,
      portraitImageUrl: portraitThumbUrl,
      popularity: notorietyOf(qid),
      summary: frTitle ? (extractsByTitle.get(frTitle) ?? null) : null,
      positionHeld: degenderLabel(positions.get(qid), genders.get(qid)) ?? null,
      specificOccupation:
        degenderLabel(specificOccupations.get(qid), genders.get(qid)) ?? null,
      nationality: DEMONYMS[geoCode] ?? null,
      wikiTitle: frTitle || null,
      gender: genders.get(qid) ?? null,
    });
    // placeOfBirth non résolu ici (P27 = citoyenneté, pas P19 = lieu de
    // naissance) — null, biography aussi null : jamais écrasés grâce au
    // COALESCE de setPersonBirthday sur `summary`.
    db.setPersonBirthday(personId, birthDates.get(qid) ?? null, null, null);
    items.push({ id: personId, qid, portraitThumbUrl });
    db.replacePersonImages(personId, [
      {
        url: portraitThumbUrl,
        iso_639_1: null,
        vote_count: 1,
        aspect_ratio: 1,
      },
    ]);
  }
  if (items.length === 0) return null;

  db.addTypeItems(
    "person",
    items.map((i) => i.id),
  );
  db.upsertFilters("person", "role", [{ code: role.code, name: role.label }]);
  db.addEntityFilters(
    "person",
    "role",
    items.map((i) => ({ entityId: i.id, codes: [role.code] })),
  );

  // storeFilterGroup attend filterTagsByItemId keyed par item.id (personId),
  // pas par qid — reprojection ici plutôt que de complexifier storeFilterGroup
  // pour ce seul appelant (voir même reprojection dans fetchPainterEntities).
  const filterTagsByPersonId = new Map();
  for (const item of items) {
    const tags = filterTagsByItem.get(item.qid);
    if (tags) filterTagsByPersonId.set(item.id, tags);
  }
  storeFilterGroup(
    "person",
    "geographie",
    Object.fromEntries(PERSON_ROLE_COUNTRIES.map((c) => [c.code, { label: c.label }])),
    items,
    filterTagsByPersonId,
  );
  storeFilterGroup(
    "person",
    "decennie",
    Object.fromEntries(PERSON_ROLE_ERAS.map((e) => [e.code, { label: e.label }])),
    items,
    filterTagsByPersonId,
  );
  // pas de source "person_popular" pour un rôle Wikidata (contrairement aux
  // acteurs, voir fetchPersonEntities) : tertiles directs sur la notoriété,
  // même mécanique que storeTertilePopularityTiers("painter", ...)
  // ci-dessus — seuls les items DE CE RÔLE sont touchés (voir storeFilterGroup
  // plus haut pour la même portée par entityId), les tags "liste" d'un
  // acteur/painter/autre rôle restent intacts.
  storeTertilePopularityTiers(
    "person",
    items.map((i) => ({ entityId: i.id, value: notorietyOf(i.qid) })),
  );

  // `notoriety` réutilisé par fetchPainterEntities (ci-dessus) pour ne pas
  // recalculer ce qui vient de l'être — fetchAllPersonRoleEntities ci-dessous
  // ignore cette valeur de retour, aucun impact pour politicien/athlète.
  return {
    items,
    filterTagsByItem,
    notoriety: new Map(items.map((i) => [i.qid, notorietyOf(i.qid)])),
  };
}

// appelé depuis refresh.js dans le cadre du fetchEntities du type "person" —
// itère CONFIG.personRoles.roles, pas de type_item dédié par rôle (voir plus
// haut) donc PAS une entrée TYPES séparée : un rôle sans pool propre ne
// pourrait jamais être marqué "frais" (db.countTypeItems resterait à 0).
export async function fetchAllPersonRoleEntities() {
  for (const role of PERSON_ROLES) {
    await fetchPersonRoleEntities(role);
  }
}
