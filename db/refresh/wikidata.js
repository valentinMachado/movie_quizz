import { createHash } from "node:crypto";
import * as db from "../index.js";
import { logWarn, logInfo } from "./log.js";
import {
  PAINTING_GENRES,
  PAINTING_COUNTRIES,
  PAINTING_ERAS,
  PAINTING_QUERY_LIMIT,
  PERSON_ROLE_QUERY_LIMIT,
  PERSON_ROLE_COUNTRIES,
  PERSON_ROLE_ERAS,
  PERSON_ROLES,
  CATEGORY_FETCH_CONCURRENCY,
} from "./config.js";
import {
  mapWithConcurrency,
  tagFilter,
  storeFilterGroup,
  storeTertilePopularityTiers,
} from "./util.js";
import { fetchExtractsByTitles } from "./wikipedia.js";

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
// (genres/pays/époques en dur dans config.json)

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

// upserte les peintres trouvés comme `person` (source wikidata) et remplace
// le pool "painter" — le tableau complet d'un peintre n'est récupéré qu'en
// tâche de fond, voir le warmLoop "Peintres (tableaux)". Chaque axe
// (popularité/genre/pays/époque) interroge Wikidata séparément (voir
// paintingSparql : combiner plusieurs filtres dans la même requête timeout),
// mais tous les résultats sont fusionnés dans un seul pool avant d'écrire en
// base — un axe qui échoue (timeout Wikidata) ne doit pas faire perdre les
// autres.
export async function fetchPainterEntities() {
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
  const sitelinks = await fetchWikidataSitelinks([...byCreator.keys()]);
  // P569, jour connu uniquement (voir fetchBirthDates) — homogénéise le pool
  // "person" : un peintre peut désormais apparaître dans le quiz du jour au
  // même titre qu'un acteur/réalisateur TMDb, au lieu d'en être exclu de
  // fait faute de date exploitable (voir getPersonsByBirthMonthDay).
  const birthDates = await fetchBirthDates([...byCreator.keys()]);
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
      popularity: sitelinks.get(creatorQid) ?? null,
    });
    // placeOfBirth/biography non connus par cette voie (P19/résumé non
    // résolus ici pour un peintre) — null, jamais écrasés grâce au COALESCE
    // de setPersonBirthday sur `summary`.
    db.setPersonBirthday(personId, birthDates.get(creatorQid) ?? null, null, null);
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
  storeTertilePopularityTiers(
    "painter",
    items.map((i) => ({
      entityId: i.id,
      value: sitelinks.get(i.creatorQid) ?? null,
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
async function fetchWikidataSitelinks(qids) {
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

async function resolveFrenchWikipediaTitles(qids) {
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
  if (byItem.size === 0) return;

  const qids = [...byItem.keys()];
  const labels = await resolveWikidataLabels(qids);
  const sitelinks = await fetchWikidataSitelinks(qids);
  // résumé (extrait Wikipédia FR, pour une future questionType "résumé" —
  // non matérialisée ici, voir materializePersonRow côté server.js) + poste
  // occupé (P39, affiché "si présent" au reveal) : toujours calculés pour
  // TOUT rôle person-Wikidata, pas seulement "politicien" — un rôle futur
  // (scientifique...) en profite gratuitement, sans code supplémentaire.
  const frTitles = await resolveFrenchWikipediaTitles(qids);
  const extractsByTitle = await fetchExtractsByTitles([...new Set(frTitles.values())]);
  const positions = await fetchPositionsHeld(qids);
  // P569, jour connu uniquement (voir fetchBirthDates) — même traitement que
  // fetchPainterEntities : homogénéise le pool "person" en donnant à tout
  // rôle Wikidata (politicien, athlète, un futur rôle...) une chance
  // d'apparaître dans le quiz du jour comme un acteur/réalisateur TMDb.
  const birthDates = await fetchBirthDates(qids);
  const items = []; // { id, qid } — forme attendue par storeFilterGroup
  for (const [qid, image] of byItem) {
    const name = labels.get(qid);
    if (!name) continue;
    const portraitThumbUrl = commonsThumbUrl(image);
    const frTitle = frTitles.get(qid);
    const personId = db.upsertPerson({
      source: "wikidata",
      externalId: qid,
      name,
      portraitImageUrl: portraitThumbUrl,
      popularity: sitelinks.get(qid) ?? null,
      summary: frTitle ? (extractsByTitle.get(frTitle) ?? null) : null,
      positionHeld: positions.get(qid) ?? null,
      wikiTitle: frTitle || null,
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
  if (items.length === 0) return;

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
  // acteurs, voir fetchPersonEntities) : tertiles directs sur sitelinks,
  // même mécanique que storeTertilePopularityTiers("painter", ...)
  // ci-dessus — seuls les items DE CE RÔLE sont touchés (voir storeFilterGroup
  // plus haut pour la même portée par entityId), les tags "liste" d'un
  // acteur/painter/autre rôle restent intacts.
  storeTertilePopularityTiers(
    "person",
    items.map((i) => ({ entityId: i.id, value: sitelinks.get(i.qid) ?? null })),
  );
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
