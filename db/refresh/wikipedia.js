import * as db from "../index.js";
import { logWarn, logInfo } from "./log.js";
import {
  WIKI_ARTICLE_LANG,
  WIKI_ARTICLE_CATEGORIES,
  WIKI_ARTICLE_QUERY_LIMIT,
  WIKI_ARTICLE_DEFAULT_DEPTH,
  WIKI_ARTICLE_DECADE_BUCKETS,
  CATEGORY_FETCH_CONCURRENCY,
  PAGE_FETCH_CONCURRENCY,
} from "./config.js";
import { mapWithConcurrency, tagFilter, storeFilterGroup } from "./util.js";
import { wikidataQuery } from "./wikidata.js";
import {
  ensureFrwikiIndex,
  ensureMultistreamIndex,
  extractsFromDump,
  aliasesFromIndex,
  thumbnailsFromIndex,
  ensurePageviewIndex,
  pageviewsFromIndex,
  frwikiIndexReady,
  collectCategoryPagesFromIndex,
  qidsByPageIdFromIndex,
  imageTitlesFromIndex,
  pageIdFromTitle,
} from "./frwiki-dump.js";

// articles Wikipédia — API MediaWiki (fr.wikipedia.org/w/api.php), gratuite,
// sans clé, jamais utilisée ailleurs dans ce repo (seul Wikidata/SPARQL
// l'est, voir wikidata.js, pour les peintures). On devine l'ARTICLE (title +
// résumé anonymisé, voir server.js/redactTitle), le pool étant constitué par
// catégories Wikipédia (categories en dur dans config.json, comme les
// genres/pays/époques peintures).

// requis par la politique d'usage de l'API Wikimedia — même contact que
// wikidata.js, pas de raison d'en avoir un distinct.
const USER_AGENT = "GuessItQuiz/1.0 (personal project)";

// file d'attente sérialisée : 1 seule requête en vol à la fois PAR file,
// retry avec Retry-After sur 429 — même principe que wikidataQuery dans
// wikidata.js. `makeThrottledFetch` en crée une instance indépendante par
// hôte Wikimedia sollicité (voir plus bas) : api.php (MediaWiki) et l'API
// REST Pageviews sont 2 hôtes distincts, chacun avec sa propre limite —
// les mettre dans la MÊME file (essayé, revenu en arrière) force le crawl
// catégories/extraits/images à attendre les pageviews (et vice-versa) sans
// raison, puisqu'aucun des deux n'est proche de LA limite de l'autre hôte.
// mapWithConcurrency reste un simple pourvoyeur de la file choisie, pas un
// vrai levier de débit au sein d'une même file.
function makeThrottledFetch(minIntervalMs) {
  let queueTail = Promise.resolve();
  return async function throttledFetch(url) {
    const previous = queueTail;
    let releaseTurn;
    queueTail = new Promise((r) => (releaseTurn = r));
    await previous;

    try {
      let lastErr;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const res = await fetch(url, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(15000),
          });
          if (res.status === 429) {
            const retryAfter = Number(res.headers.get("retry-after"));
            const delay = retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt;
            lastErr = new Error("Wikimedia 429");
            if (attempt < 5) {
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }
            throw lastErr;
          }
          // 5xx : transitoire, retry. Le reste (2xx, 404, autres 4xx) est
          // renvoyé tel quel — l'appelant décide (ex. 404 = "pas de données"
          // pour pageviews, une vraie erreur ailleurs).
          if (res.status >= 500) {
            lastErr = new Error(`Wikimedia ${res.status}`);
            if (attempt < 5) {
              await new Promise((r) => setTimeout(r, 1000 * attempt));
              continue;
            }
            throw lastErr;
          }
          return res;
        } catch (e) {
          lastErr = e;
          if (attempt < 5) await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      throw lastErr;
    } finally {
      await new Promise((r) => setTimeout(r, minIntervalMs));
      releaseTurn();
    }
  };
}

const WIKIMEDIA_MIN_INTERVAL_MS = 200;
// api.php (MediaWiki) : catégories, extraits, pageprops, images.
const wikimediaFetch = makeThrottledFetch(WIKIMEDIA_MIN_INTERVAL_MS);
// API REST Pageviews : hôte distinct (wikimedia.org, pas fr.wikipedia.org),
// file indépendante pour tourner en parallèle du reste (voir fetchPageviews).
const pageviewsFetch = makeThrottledFetch(WIKIMEDIA_MIN_INTERVAL_MS);
// une seule langue sollicitée (WIKI_ARTICLE_LANG). Il y a eu ici une file
// par langue, pour un repli "en" sur les bios TMDb sans traduction FR —
// supprimé avec ce repli (voir fetchAndStorePersonDetails dans tmdb.js).

// exporté : réutilisé par wikidata.js (résumés des rôles "person", voir
// fetchExtractsByTitles plus bas) pour rester sur la même file sérialisée
// (wikimediaFetch) plutôt que d'ouvrir une 2e file non coordonnée vers le
// même hôte fr.wikipedia.org.
export async function wikipediaApi(params) {
  const url = `https://${WIKI_ARTICLE_LANG}.wikipedia.org/w/api.php?${new URLSearchParams({ format: "json", ...params })}`;
  const res = await wikimediaFetch(url);
  if (!res.ok) throw new Error(`Wikipédia ${res.status}`);
  return await res.json();
}

// pages "sans sujet unique à deviner" — pas un filtre exhaustif, juste les
// cas les plus fréquents rencontrés dans les catégories de culture générale.
function looksLikeRealArticle(title) {
  return !title.startsWith("Liste ") && !title.includes("(homonymie)");
}

// libellé affiché d'un filtre "genre" — nom de la catégorie Wikipédia
// source, sans son éventuel suffixe désambiguïsateur ("Mammifère (nom
// vernaculaire)" -> "Mammifère").
function genreLabelFromCategory(category) {
  return category.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

// code stable dérivé du même nom (accents/casse/ponctuation neutralisés)
// — comportement générique : chaque `category` de config.json (Fleuve,
// Montagne, Bataille, Mammifère...) devient AUTOMATIQUEMENT son propre
// filtre "genre", en plus du filtre "categorie" plus large (souvent
// plusieurs `category` pour un même `code`, voir WIKI_ARTICLE_CATEGORIES)
// — pas de champ supplémentaire à maintenir à la main dans config.json.
const COMBINING_DIACRITICS_RE = /[̀-ͯ]/g;
function genreCodeFromCategory(category) {
  return genreLabelFromCategory(category)
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS_RE, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// membres directs d'UNE catégorie : pages (ns=0) ET sous-catégories
// (ns=14, cmtype=page|subcat en un seul appel) — les sous-catégories
// alimentent le parcours récursif de collectCategoryPages ci-dessous.
async function categoryMembers(fullCategoryTitle) {
  const data = await wikipediaApi({
    action: "query",
    list: "categorymembers",
    cmtitle: fullCategoryTitle,
    cmtype: "page|subcat",
    cmlimit: "500",
  });
  const members = data.query?.categorymembers || [];
  return {
    pages: members
      .filter((m) => m.ns === 0 && looksLikeRealArticle(m.title))
      .map((m) => ({ pageid: m.pageid, title: m.title })),
    subcats: members.filter((m) => m.ns === 14).map((m) => m.title),
  };
}

// garde-fou indépendant de `limit` (pages trouvées) : une catégorie
// "chapeau" (peu de pages directes, beaucoup de sous-catégories quasi
// vides) peut sinon faire visiter des centaines de sous-catégories avant
// d'atteindre `limit`, sans jamais s'arrêter.
const MAX_CATEGORY_VISITS_PER_ROOT = 60;

// la plupart des articles concrets d'une catégorie "chapeau" (ex.
// Catégorie:Animal) ne sont PAS des membres directs mais nichés dans ses
// sous-catégories (Catégorie:Mammifère, Catégorie:Reptile...) — une
// catégorie "chapeau" contient souvent directement seulement l'article
// générique éponyme (l'article "Animal" lui-même) + quelques
// sous-catégories. D'où ce parcours en largeur dans l'arbre des
// sous-catégories (borné en profondeur ET en nombre de catégories
// visitées) plutôt qu'un simple appel à ses membres directs.
async function collectCategoryPages(rootCategoryName, limit, maxDepth) {
  const rootTitle = `Catégorie:${rootCategoryName}`;
  const pages = [];
  const seenPageIds = new Set();
  const seenCats = new Set([rootTitle]);
  const queue = [{ title: rootTitle, depth: 0 }];
  let visits = 0;
  while (queue.length && pages.length < limit && visits < MAX_CATEGORY_VISITS_PER_ROOT) {
    const { title, depth } = queue.shift();
    visits++;
    let result;
    try {
      result = await categoryMembers(title);
    } catch (e) {
      logWarn(`Erreur catégorie Wikipédia "${title}":`, e.message);
      continue;
    }
    // exclut l'article générique éponyme UNIQUEMENT à la racine (ex.
    // l'article "Animal" listé dans Catégorie:Animal) : c'est une vue
    // d'ensemble, pas un sujet précis à deviner. Ne s'applique PAS aux
    // sous-catégories plus profondes : certaines arborescences (ex.
    // Catégorie:Élément chimique -> une sous-catégorie par élément, comme
    // Catégorie:Aluminium) ont justement l'article éponyme comme membre
    // direct de sa PROPRE sous-catégorie ("Aluminium" dans
    // Catégorie:Aluminium) — l'exclure là aurait laissé passer uniquement
    // des pages annexes très techniques ("Isotopes de l'aluminium",
    // "Recyclage de l'aluminium"...) au lieu de l'article recherché.
    const bareName = depth === 0 ? title.slice("Catégorie:".length) : null;
    for (const p of result.pages) {
      if (p.title === bareName || seenPageIds.has(p.pageid)) continue;
      seenPageIds.add(p.pageid);
      pages.push(p);
      if (pages.length >= limit) break;
    }
    if (depth < maxDepth) {
      for (const sub of result.subcats) {
        if (seenCats.has(sub)) continue;
        seenCats.add(sub);
        queue.push({ title: sub, depth: depth + 1 });
      }
    }
  }
  return pages;
}

// résumés + vignettes + redirections par lots de 20 (limite pratique du
// module "extracts" de l'API MediaWiki pour plusieurs pages à la fois) —
// `pageids` plutôt que `titles` : évite toute ambiguïté de résolution de
// redirection, on connaît déjà le pageid exact via categorymembers.
// `redirects` (prop combiné, même appel, sans coût réseau en plus) : les
// pages qui redirigent VERS cet article sont autant de noms alternatifs
// (variantes d'orthographe, noms étrangers/scientifiques...) — voir
// aliasesFromRedirects, servent à mieux anonymiser le titre dans le
// summary (redactTitle côté server.js) qu'un simple masquage du titre
// affiché, qui rate ces variantes.
async function fetchExtractsBatch(pageids) {
  const data = await wikipediaApi({
    action: "query",
    prop: "extracts|pageimages|redirects",
    exintro: "1",
    explaintext: "1",
    piprop: "thumbnail",
    pithumbsize: "500",
    rdlimit: "50",
    pageids: pageids.join("|"),
  });
  return Object.values(data.query?.pages || {});
}

// variante par TITRE (pas pageid) — pour un appelant qui ne connaît qu'un
// titre d'article (voir fetchPersonRoleEntities dans wikidata.js, qui résout
// le titre FR depuis un QID Wikidata plutôt que de parcourir une catégorie
// comme fetchWikiArticleEntities). `redirects: "1"` fait suivre les
// redirections côté serveur MediaWiki ; `normalized`/`redirects` en réponse
// remappent le titre final vers le titre demandé, nécessaire pour retrouver
// quel appelant a demandé quoi. Batché par 20 comme fetchExtractsBatch.
export async function fetchExtractsByTitles(titles) {
  const extracts = new Map(); // titre demandé -> extrait
  for (let i = 0; i < titles.length; i += 20) {
    const batch = titles.slice(i, i + 20);
    let data;
    try {
      data = await wikipediaApi({
        action: "query",
        prop: "extracts",
        exintro: "1",
        explaintext: "1",
        redirects: "1",
        titles: batch.join("|"),
      });
    } catch (e) {
      logWarn("Erreur extraits Wikipédia (par titre):", e.message);
      continue;
    }
    const originalTitle = new Map(batch.map((t) => [t, t]));
    for (const n of data.query?.normalized || []) originalTitle.set(n.to, n.from);
    for (const r of data.query?.redirects || [])
      originalTitle.set(r.to, originalTitle.get(r.from) ?? r.from);
    for (const page of Object.values(data.query?.pages || {})) {
      if (!page.extract) continue;
      extracts.set(originalTitle.get(page.title) ?? page.title, page.extract);
    }
  }
  return extracts;
}

export async function fetchWikiArticleEntities() {
  // index local des dumps Wikimedia (voir frwiki-dump.js) : construit ici,
  // AVANT tout le reste, pour que les warmLoups d'images le trouvent déjà
  // ouvert (frwikiIndexReady) quand le pool sera écrit. `false` = dump
  // indisponible ou désactivé (--no-frwiki-dump) : tout ce qui suit repasse
  // par l'API MediaWiki, plus lent mais fonctionnellement identique.
  const useIndex = await ensureFrwikiIndex();
  const byPage = new Map(); // pageid -> title
  const filterTagsByPage = new Map();
  const genreLabels = new Map(); // genreCode -> label, voir genreCodeFromCategory
  // pageid dont AU MOINS une catégorie source a "looseRedaction": true
  // (config.json, ex. Animaux) — voir redactTitle côté server.js.
  const loosePageIds = new Set();
  let done = 0;
  await mapWithConcurrency(WIKI_ARTICLE_CATEGORIES, CATEGORY_FETCH_CONCURRENCY, async (cat) => {
    let pages = [];
    try {
      const depth = cat.depth ?? WIKI_ARTICLE_DEFAULT_DEPTH;
      pages = useIndex
        ? collectCategoryPagesFromIndex(
            cat.category,
            WIKI_ARTICLE_QUERY_LIMIT,
            depth,
            MAX_CATEGORY_VISITS_PER_ROOT,
            looksLikeRealArticle,
          )
        : await collectCategoryPages(cat.category, WIKI_ARTICLE_QUERY_LIMIT, depth);
    } catch (e) {
      logWarn(`Erreur catégorie Wikipédia "${cat.category}":`, e.message);
    }
    // "genre" : un filtre par `category` source (Fleuve, Montagne,
    // Bataille, Mammifère...), plus fin que "categorie" (le regroupement
    // thématique, ex. plusieurs `category` sous le même code "geographie")
    // — généralisé à toute entrée de WIKI_ARTICLE_CATEGORIES, dérivé
    // automatiquement de son `category`, aucune config supplémentaire.
    const genreCode = genreCodeFromCategory(cat.category);
    genreLabels.set(genreCode, genreLabelFromCategory(cat.category));
    for (const p of pages) {
      if (!byPage.has(p.pageid)) byPage.set(p.pageid, p.title);
      tagFilter(filterTagsByPage, p.pageid, "categorie", cat.code);
      tagFilter(filterTagsByPage, p.pageid, "genre", genreCode);
      if (cat.looseRedaction) loosePageIds.add(p.pageid);
    }
    done++;
    logInfo(
      `wiki_article : catégorie ${done}/${WIKI_ARTICLE_CATEGORIES.length} (${cat.code}) — ${byPage.size} articles cumulés`,
    );
  });
  if (byPage.size === 0) {
    db.replaceTypeItems("wiki_article", []);
    return;
  }

  const pageids = [...byPage.keys()];
  const items = []; // { pageid, title, extract, thumbnailUrl }
  // Résumé + alias + vignette : les trois venaient du même appel api.php, le
  // plus cher de tout le crawl (~18 s le lot, throttling Wikimedia). Le dump
  // multistream les rend tous les trois hors ligne — voir extractsFromDump.
  const useDump = useIndex && (await ensureMultistreamIndex());
  if (useDump) {
    const extracts = await extractsFromDump(pageids, (done, total) =>
      logInfo(`wiki_article : résumés ${done}/${total} blocs`),
    );
    const aliases = aliasesFromIndex(pageids);
    const thumbnails = thumbnailsFromIndex(pageids);
    for (const pageid of pageids) {
      const extract = extracts.get(pageid);
      // sans résumé exploitable ou sans vignette, l'article ne produirait
      // aucune question (voir materializeWikiArticleRows côté server.js) :
      // pas de repli API, on l'écarte (décision utilisateur du 2026-08-04).
      if (!extract || !thumbnails.has(pageid)) continue;
      items.push({
        pageid,
        title: byPage.get(pageid),
        extract,
        thumbnailUrl: thumbnails.get(pageid),
        aliases: aliases.get(pageid) ?? [],
        looseRedaction: loosePageIds.has(pageid),
      });
    }
    logInfo(
      `wiki_article : ${items.length}/${pageids.length} articles retenus depuis le dump (résumé + vignette).`,
    );
  } else {
    const batches = [];
    for (let i = 0; i < pageids.length; i += 20) batches.push(pageids.slice(i, i + 20));
    let extractBatchesDone = 0;
    await mapWithConcurrency(batches, CATEGORY_FETCH_CONCURRENCY, async (batch) => {
      let pages;
      try {
        pages = await fetchExtractsBatch(batch);
      } catch (e) {
        logWarn("Erreur extraits Wikipédia:", e.message);
        return;
      } finally {
        extractBatchesDone++;
        // toutes ces requêtes passent par la même file sérialisée que le
        // parcours des catégories (voir wikimediaFetch) : sans repère, ce
        // passage peut sembler bloqué alors qu'il avance juste lentement.
        if (extractBatchesDone % 10 === 0 || extractBatchesDone === batches.length) {
          logInfo(`wiki_article : extraits ${extractBatchesDone}/${batches.length} lots`);
        }
      }
      for (const p of pages) {
        if (!p.extract) continue;
        items.push({
          pageid: p.pageid,
          title: p.title,
          extract: p.extract,
          thumbnailUrl: p.thumbnail?.source || null,
          aliases: (p.redirects || []).map((r) => r.title),
          looseRedaction: loosePageIds.has(p.pageid),
        });
      }
    });
  }

  db.upsertWikiArticles(items);
  // pool + filtre "categorie" ouverts dès que le texte est là — ne pas les
  // faire attendre la popularité (voir plus bas) : avec un pool de
  // plusieurs centaines/milliers d'articles (parcours récursif des
  // sous-catégories, voir collectCategoryPages), les pageviews à eux seuls
  // représentent 1 requête PAR article et peuvent prendre bien plus
  // longtemps que tout le reste — inutile de faire attendre le pool entier
  // pour ça (essayé, revenu en arrière : voir historique). La file
  // sérialisée (wikimediaFetch) empêche déjà toute rafale de 429 avec le
  // warmLoop images qui démarre dès replaceTypeItems, donc plus besoin de
  // les ordonner l'un après l'autre pour cette raison.
  db.replaceTypeItems(
    "wiki_article",
    items.map((i) => i.pageid),
  );
  storeFilterGroup(
    "wiki_article",
    "categorie",
    Object.fromEntries(WIKI_ARTICLE_CATEGORIES.map((c) => [c.code, { label: c.name }])),
    items.map((i) => ({ id: i.pageid })),
    filterTagsByPage,
  );
  storeFilterGroup(
    "wiki_article",
    "genre",
    Object.fromEntries([...genreLabels].map(([code, label]) => [code, { label }])),
    items.map((i) => ({ id: i.pageid })),
    filterTagsByPage,
  );

  // popularité (filtre "liste" Populaire/Niche/Obscur) : posée après coup,
  // le pool reste utilisable entre-temps sans ce filtre-là. La valeur BRUTE
  // est conservée en plus des tranches (voir setWikiArticlePopularities) —
  // elle était jusqu'ici calculée puis jetée.
  // dump de consultations si disponible (0 requête), sinon l'API article par
  // article. Construit ICI et pas au début du crawl : c'est le plus long des
  // deux téléchargements, et le pool est déjà ouvert à ce stade.
  const pageviews =
    useIndex && (await ensurePageviewIndex())
      ? pageviewsFromIndex(items.map((i) => i.pageid))
      : await fetchAllPageviews(items);
  const popularityEntries = items.map((i) => ({
    entityId: i.pageid,
    value: pageviews.get(i.pageid) ?? null,
  }));
  db.setWikiArticlePopularities(popularityEntries);
  storeWikiArticlePopularityTiers(popularityEntries);

  // QID résolus UNE SEULE FOIS pour tout le pool, réutilisés par décennie
  // (histoire uniquement) ET géographie (tout le pool, "quand c'est
  // possible") ci-dessous — évite de refaire la résolution deux fois.
  const qidByPageid = useIndex
    ? qidsByPageIdFromIndex(items.map((i) => i.pageid))
    : await resolveWikidataQids(items.map((i) => i.pageid));
  logInfo(`wiki_article : ${qidByPageid.size}/${items.length} QID Wikidata résolus`);
  const qids = [...new Set(qidByPageid.values())];

  // décennie : uniquement pour "histoire" (bataille/guerre), seule catégorie
  // où une date d'événement a un sens évident — les autres (montagne,
  // élément chimique, créature légendaire...) n'ont pas de "décennie"
  // naturelle et n'auront simplement jamais ce filtre (comme population/
  // superficie qui n'existent que pour "country").
  const historyPageIds = items
    .map((i) => i.pageid)
    .filter((id) =>
      filterTagsByPage.get(id)?.get("categorie")?.has(DECADE_ELIGIBLE_CATEGORY_CODE),
    );
  if (historyPageIds.length > 0) {
    const historyQids = [
      ...new Set(historyPageIds.map((id) => qidByPageid.get(id)).filter(Boolean)),
    ];
    const yearByQid = await fetchEventYears(historyQids);
    storeWikiArticleDecades(historyPageIds, qidByPageid, yearByQid);
  }

  // géographie : pays associé à l'article (P17 Wikidata), "quand c'est
  // possible" — pertinent pour un monument/fleuve/montagne/bataille, pas
  // pour une créature légendaire ou un élément chimique, mais pas besoin
  // de restreindre par catégorie : un article sans P17 connu reste
  // simplement sans code dans ce groupe (voir storeWikiArticleGeography).
  const countryByQid = await fetchArticleCountries(qids);
  storeWikiArticleGeography(
    items.map((i) => i.pageid),
    qidByPageid,
    countryByQid,
  );
}

// seule catégorie où une date d'événement a un sens (voir plus haut) — code
// du groupe "categorie" (config.json), pas le libellé.
const DECADE_ELIGIBLE_CATEGORY_CODE = "histoire";

// popularité = vraies consultations (API Pageviews Wikimedia), pas les
// sitelinks Wikidata utilisés pour les peintres (voir wikidata.js) : plus
// fidèle à l'intuition "populaire" qu'une simple couverture multilingue,
// mais pas batchable (1 requête par article, contrairement à
// wikibase:sitelinks qui accepte une clause VALUES groupée) — passe comme
// le reste par wikimediaFetch (file sérialisée partagée), PAGE_FETCH_CONCURRENCY
// ne fait ici que nourrir cette file, pas un vrai débit parallèle.
const PAGEVIEWS_BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article";
// 3 mois complets, hors mois en cours (incomplet) : lisse les pics
// ponctuels (actualité) sans remonter trop loin dans le temps.
function pageviewsRange() {
  const fmt = (d) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}00`;
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 3, 1));
  return { start: fmt(start), end: fmt(end) };
}

async function fetchPageviews(title) {
  const { start, end } = pageviewsRange();
  const article = encodeURIComponent(title.replace(/ /g, "_"));
  const url = `${PAGEVIEWS_BASE}/${WIKI_ARTICLE_LANG}.wikipedia/all-access/user/${article}/monthly/${start}/${end}`;
  try {
    const res = await pageviewsFetch(url);
    // 404 = aucune donnée sur la période (article trop récent ou vraiment
    // confidentiel) : 0 vues, pas une erreur réseau à logger.
    if (res.status === 404) return 0;
    if (!res.ok) throw new Error(`Pageviews ${res.status}`);
    const data = await res.json();
    return (data.items || []).reduce((sum, it) => sum + (it.views || 0), 0);
  } catch (e) {
    logWarn(`Erreur pageviews Wikipédia pour "${title}":`, e.message);
    return 0;
  }
}

async function fetchAllPageviews(items) {
  const views = new Map();
  let done = 0;
  await mapWithConcurrency(items, PAGE_FETCH_CONCURRENCY, async (item) => {
    views.set(item.pageid, await fetchPageviews(item.title));
    done++;
    if (done % 100 === 0 || done === items.length) {
      logInfo(`wiki_article : pageviews ${done}/${items.length}`);
    }
  });
  return views;
}

// 3 tertiles directs sur la valeur (pas de source "Populaire" séparée à
// exclure comme movie/tv/game/person, voir storePopularityTiers dans
// util.js) — même principe que storePainterPopularityTiers dans
// wikidata.js, recalculé à chaque crawl complet.
function storeWikiArticlePopularityTiers(entries) {
  const known = entries
    .filter((e) => e.value != null)
    .map((e) => e.value)
    .sort((a, b) => a - b);
  if (known.length === 0) return;
  const q1 = known[Math.floor(known.length / 3)];
  const q2 = known[Math.floor((known.length * 2) / 3)];
  const tierFor = (v) => (v <= q1 ? "obscur" : v <= q2 ? "niche" : "populaire");
  db.upsertFilters("wiki_article", "liste", [
    { code: "obscur", name: "Obscur" },
    { code: "niche", name: "Niche" },
    { code: "populaire", name: "Populaire" },
  ]);
  db.replaceEntityFilters(
    "wiki_article",
    "liste",
    entries.map((e) => ({
      entityId: e.entityId,
      codes: e.value == null ? [] : [tierFor(e.value)],
    })),
  );
}

// résout le QID Wikidata de chaque page (pageprops.wikibase_item, quasi
// toujours présent pour un article réel) — par lots de 50 (limite anonyme
// standard de l'API MediaWiki pour plusieurs pageids à la fois).
async function resolveWikidataQids(pageids) {
  const qidByPageid = new Map();
  const batches = [];
  for (let i = 0; i < pageids.length; i += 50) batches.push(pageids.slice(i, i + 50));
  await mapWithConcurrency(batches, CATEGORY_FETCH_CONCURRENCY, async (batch) => {
    let data;
    try {
      data = await wikipediaApi({
        action: "query",
        pageids: batch.join("|"),
        prop: "pageprops",
        ppprop: "wikibase_item",
      });
    } catch (e) {
      logWarn("Erreur résolution QID Wikidata (wiki_article):", e.message);
      return;
    }
    for (const page of Object.values(data.query?.pages || {})) {
      const qid = page.pageprops?.wikibase_item;
      if (qid) qidByPageid.set(page.pageid, qid);
    }
  });
  return qidByPageid;
}

// P585 (date d'un événement ponctuel, ex. une bataille) > P580 (date de
// début, ex. une guerre) > P571 (date de création) : le premier trouvé
// l'emporte (COALESCE), extrait en année seule (YEAR()) — gère nativement
// les dates avant J.-C. (année négative) sans parsing manuel.
function eventYearsSparql(qids) {
  const values = qids.map((qid) => `wd:${qid}`).join(" ");
  return (
    "SELECT ?item ?year WHERE { " +
    `VALUES ?item { ${values} } ` +
    "OPTIONAL { ?item wdt:P585 ?d1. } " +
    "OPTIONAL { ?item wdt:P580 ?d2. } " +
    "OPTIONAL { ?item wdt:P571 ?d3. } " +
    "BIND(COALESCE(?d1, ?d2, ?d3) AS ?date) " +
    "FILTER(BOUND(?date)) " +
    "BIND(YEAR(?date) AS ?year) " +
    "}"
  );
}

// batché par 300 QID (limite pratique avant timeout SPARQL sur une clause
// VALUES, même borne que fetchCreatorSitelinks dans wikidata.js) — via
// wikidataQuery, déjà sérialisé/retry côté Wikidata.
async function fetchEventYears(qids) {
  const yearByQid = new Map();
  for (let i = 0; i < qids.length; i += 300) {
    const batch = qids.slice(i, i + 300);
    try {
      const data = await wikidataQuery(
        `https://query.wikidata.org/sparql?query=${encodeURIComponent(eventYearsSparql(batch))}`,
      );
      for (const b of data.results?.bindings || []) {
        const qid = b.item?.value?.split("/").pop();
        const year = parseInt(b.year?.value, 10);
        if (qid && !Number.isNaN(year)) yearByQid.set(qid, year);
      }
    } catch (e) {
      logWarn("Erreur dates Wikidata (wiki_article):", e.message);
    }
  }
  return yearByQid;
}

// répartit les années CONNUES en tranches de taille égale en NOMBRE
// D'ARTICLES (quantiles), pas des tranches calendaires fixes — les
// batailles/guerres bien documentées se concentrent très inégalement dans
// le temps (dense XIXe-XXe, très clairsemé avant 1500) : des tranches par
// siècle laisseraient certaines quasi vides et d'autres énormes. Même
// principe que storeWikiArticlePopularityTiers (tertiles), généralisé à N
// tranches (WIKI_ARTICLE_DECADE_BUCKETS) et calculé sur les données
// réellement trouvées à CE crawl plutôt que sur des bornes figées.
function buildDecadeBuckets(years, bucketCount) {
  const sorted = [...years].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const n = Math.max(1, Math.min(bucketCount, new Set(sorted).size));
  // n-1 seuils : cutoffs[i] = 1ère année de la tranche i+1.
  const cutoffs = [];
  for (let i = 1; i < n; i++) {
    const c = sorted[Math.floor((sorted.length * i) / n)];
    if (cutoffs.length === 0 || c > cutoffs[cutoffs.length - 1]) cutoffs.push(c);
  }
  const buckets = cutoffs.map((c, i) => ({
    code: `periode_${i}`,
    label: i === 0 ? `Avant ${c}` : `${cutoffs[i - 1]}-${c - 1}`,
    lt: c,
  }));
  buckets.push({
    code: `periode_${cutoffs.length}`,
    label: cutoffs.length ? `Après ${cutoffs[cutoffs.length - 1] - 1}` : "Toutes périodes",
    lt: Infinity,
  });
  return buckets;
}

function decadeCodeForYear(buckets, year) {
  return buckets.find((b) => year < b.lt)?.code ?? buckets[buckets.length - 1]?.code ?? null;
}

// écrit le filtre "decennie" à partir des QID/années déjà résolus (voir
// fetchWikiArticleEntities) — un article sans QID connu ou sans date
// Wikidata exploitable reste simplement sans code dans ce groupe (filtre
// "decennie" non concerné pour lui, comme s'il n'était pas dans une
// catégorie éligible).
function storeWikiArticleDecades(pageids, qidByPageid, yearByQid) {
  const years = pageids
    .map((id) => qidByPageid.get(id))
    .filter(Boolean)
    .map((qid) => yearByQid.get(qid))
    .filter((y) => y != null);
  const buckets = buildDecadeBuckets(years, WIKI_ARTICLE_DECADE_BUCKETS);
  if (buckets.length === 0) return;

  db.upsertFilters(
    "wiki_article",
    "decennie",
    buckets.map((b) => ({ code: b.code, name: b.label })),
  );
  db.replaceEntityFilters(
    "wiki_article",
    "decennie",
    pageids.map((pageid) => {
      const qid = qidByPageid.get(pageid);
      const year = qid ? yearByQid.get(qid) : null;
      const code = year == null ? null : decadeCodeForYear(buckets, year);
      return { entityId: pageid, codes: code ? [code] : [] };
    }),
  );
}

// pays associé à l'article (P17 "pays"), résolu en un seul aller-retour
// SPARQL jusqu'au code ISO 3166-1 alpha-2 (P297) ET au libellé français du
// pays (rdfs:label) — pas de liste de pays figée à maintenir à la main
// (contrairement à COUNTRY_TARGETS pour movie/tv/painter) : n'importe quel
// pays connu de Wikidata peut ressortir ici.
function articleCountrySparql(qids) {
  const values = qids.map((qid) => `wd:${qid}`).join(" ");
  return (
    "SELECT ?item ?isoCode ?countryLabel WHERE { " +
    `VALUES ?item { ${values} } ` +
    "?item wdt:P17 ?country. " +
    "?country wdt:P297 ?isoCode. " +
    "?country rdfs:label ?countryLabel. " +
    'FILTER(LANG(?countryLabel) = "fr") ' +
    "}"
  );
}

// batché par 300 QID (même borne que fetchEventYears/fetchCreatorSitelinks).
async function fetchArticleCountries(qids) {
  const countryByQid = new Map(); // qid -> { code, label }
  for (let i = 0; i < qids.length; i += 300) {
    const batch = qids.slice(i, i + 300);
    try {
      const data = await wikidataQuery(
        `https://query.wikidata.org/sparql?query=${encodeURIComponent(articleCountrySparql(batch))}`,
      );
      for (const b of data.results?.bindings || []) {
        const qid = b.item?.value?.split("/").pop();
        const code = b.isoCode?.value?.toLowerCase();
        const label = b.countryLabel?.value;
        if (qid && code && label) countryByQid.set(qid, { code, label });
      }
    } catch (e) {
      logWarn("Erreur géographie Wikidata (wiki_article):", e.message);
    }
  }
  return countryByQid;
}

// écrit le filtre "geographie" — "quand c'est possible" : pertinent pour un
// monument/fleuve/montagne/bataille, sans objet pour une créature
// légendaire ou un élément chimique, mais pas besoin de restreindre par
// catégorie en amont, un article sans P17 connu reste simplement sans code
// dans ce groupe (même principe que "decennie" ci-dessus).
function storeWikiArticleGeography(pageids, qidByPageid, countryByQid) {
  const countryDefs = new Map(); // code -> label
  for (const { code, label } of countryByQid.values()) countryDefs.set(code, label);
  if (countryDefs.size === 0) return;
  db.upsertFilters(
    "wiki_article",
    "geographie",
    [...countryDefs].map(([code, name]) => ({ code, name })),
  );
  db.replaceEntityFilters(
    "wiki_article",
    "geographie",
    pageids.map((pageid) => {
      const qid = qidByPageid.get(pageid);
      const country = qid ? countryByQid.get(qid) : null;
      return { entityId: pageid, codes: country ? [country.code] : [] };
    }),
  );
}

// icônes/logos/diagrammes de template (infobox, bandeaux) : quasi jamais des
// svg/gif sur Wikipédia contrairement aux vraies photos ; le reste est filtré
// par nom (heuristique, pas exhaustif) puis par largeur minimale (voir
// resolveImageInfoByTitle) pour éliminer ce que le nom seul ne capte pas.
const ICON_EXT_RE = /\.(svg|gif)$/i;
const ICON_NAME_RE =
  /icon|logo|symbol|flag_of|coat[_ ]of[_ ]arms|disambig|commons-logo|nuvola|crystal|gnome|blank|pd-icon|question[_ ]mark|folder|padlock|ambox|emblem/i;
const MIN_IMAGE_WIDTH = 400;
const MAX_IMAGES_PER_ARTICLE = 10;

async function articleImageTitles(pageid) {
  const data = await wikipediaApi({
    action: "query",
    pageids: String(pageid),
    prop: "images",
    imlimit: "50",
  });
  const page = Object.values(data.query?.pages || {})[0];
  return (page?.images || [])
    .map((i) => i.title)
    .filter((title) => !ICON_EXT_RE.test(title) && !ICON_NAME_RE.test(title));
}

// url + dimensions de N fichiers, par lots de 50 (limite anonyme de l'API
// MediaWiki pour `titles`). Renvoie une Map TITRE DEMANDÉ -> imageinfo :
// c'est ce qui permet de grouper dans une même requête les fichiers de
// PLUSIEURS articles et de savoir ensuite lesquels reviennent à qui (voir
// fetchAndStoreWikiArticleImagesBatch). `normalized` remappe le titre
// renvoyé vers celui demandé, comme dans fetchExtractsByTitles.
//
// Cet appel reste en ligne même quand l'index local est disponible : les
// dimensions vivent dans la table `image` de commonswiki (18 Go de dump à
// elles seules), hors de proportion pour ce qu'on en tire. Il donne aussi
// l'url réelle, ce qui évite de parier sur la reconstruction MD5 pour des
// fichiers hébergés localement plutôt que sur Commons.
async function resolveImageInfoByTitle(fileTitles) {
  const infoByTitle = new Map();
  for (let i = 0; i < fileTitles.length; i += 50) {
    const batch = fileTitles.slice(i, i + 50);
    let data;
    try {
      data = await wikipediaApi({
        action: "query",
        titles: batch.join("|"),
        prop: "imageinfo",
        iiprop: "url|size",
      });
    } catch (e) {
      logWarn("Erreur imageinfo Wikipédia:", e.message);
      continue;
    }
    const originalTitle = new Map(batch.map((t) => [t, t]));
    for (const n of data.query?.normalized || []) originalTitle.set(n.to, n.from);
    for (const p of Object.values(data.query?.pages || {})) {
      const info = p.imageinfo?.[0];
      if (!info?.url || info.width < MIN_IMAGE_WIDTH) continue;
      infoByTitle.set(originalTitle.get(p.title) ?? p.title, info);
    }
  }
  return infoByTitle;
}

// plafond de CANDIDATS soumis à l'API par entité — il faut de la marge
// au-dessus de MAX_IMAGES_PER_ARTICLE : le filtre de largeur
// (MIN_IMAGE_WIDTH) n'est connu qu'après la réponse, donc une partie des
// candidats sera écartée.
const MAX_IMAGE_CANDIDATES = 20;

// candidats images d'une entité : depuis l'index local si disponible (0
// requête), sinon via l'API comme avant. Le filtrage icônes est le même dans
// les deux cas et, avec l'index, il s'applique AVANT tout appel réseau —
// c'est lui qui fait chuter le volume soumis à resolveImageInfoByTitle.
async function imageCandidateTitles(fetchFromApi, pageid) {
  const titles = pageid != null && frwikiIndexReady()
    ? imageTitlesFromIndex(pageid)
    : await fetchFromApi();
  return titles
    .filter((t) => !ICON_EXT_RE.test(t) && !ICON_NAME_RE.test(t))
    .slice(0, MAX_IMAGE_CANDIDATES);
}

function imageRowsFrom(infos) {
  return infos.map((info) => ({
    url: info.url,
    vote_count: 1,
    aspect_ratio: info.width / info.height,
  }));
}

// warmLoop "Articles Wikipédia (images)" — par PAQUETS d'articles (voir
// fetchAndStoreBatch/batchSize dans refresh.js), plus 1 par 1 comme les
// autres warmLoops : c'était le plus gros consommateur de requêtes de tout
// le projet (2 par article, ~11 400 pour un pool de 5 700), et donc la vraie
// cause du throttling à 15s côté Wikimedia. Découvrir les fichiers via
// l'index local supprime la 1re requête, grouper les titres de tout le lot
// dans des appels imageinfo de 50 divise la 2e — au total ~85% de trafic en
// moins vers api.php, à données identiques.
export async function fetchAndStoreWikiArticleImagesBatch(articles) {
  const titlesByArticle = new Map();
  const allTitles = new Set(); // dédoublonne les fichiers partagés par plusieurs articles
  for (const article of articles) {
    const titles = await imageCandidateTitles(
      () => articleImageTitles(article.id),
      article.id,
    );
    titlesByArticle.set(article.id, titles);
    for (const t of titles) allTitles.add(t);
  }
  const infoByTitle = await resolveImageInfoByTitle([...allTitles]);
  for (const article of articles) {
    const infos = (titlesByArticle.get(article.id) || [])
      .map((t) => infoByTitle.get(t))
      .filter(Boolean)
      .slice(0, MAX_IMAGES_PER_ARTICLE);
    db.replaceWikiArticleImages(article.id, imageRowsFrom(infos));
  }
}

// même requête qu'articleImageTitles, mais par TITRE plutôt que par pageid —
// fetchPersonRoleEntities (wikidata.js) ne résout qu'un titre d'article FR
// par QID (voir resolveFrenchWikipediaTitles), jamais de pageid.
// `redirects: "1"` : person.wiki_title peut être un ancien titre si l'article
// a été renommé depuis la dernière résolution.
async function articleImageTitlesByTitle(title) {
  const data = await wikipediaApi({
    action: "query",
    titles: title,
    redirects: "1",
    prop: "images",
    imlimit: "50",
  });
  const page = Object.values(data.query?.pages || {})[0];
  return (page?.images || [])
    .map((i) => i.title)
    .filter((t) => !ICON_EXT_RE.test(t) && !ICON_NAME_RE.test(t));
}

// warmLoop "Personnes Wikidata (photos)" — un politicien/sportif (voir
// fetchPersonRoleEntities) n'a en base qu'un seul portrait Wikidata, bien
// moins qu'un acteur TMDb (plusieurs profils, voir fetchAndStorePersonImages)
// pour remplir un questionType "image" à plusieurs frames. On va chercher
// d'autres photos sur son article Wikipédia FR déjà résolu (person.wiki_title),
// même mécanique que fetchAndStoreWikiArticleImagesBatch ci-dessus.
//
// batché comme fetchAndStoreWikiArticleImagesBatch ci-dessus, et pour la
// même raison : ce warmLoop-ci tape la MÊME file sérialisée vers
// fr.wikipedia.org que les articles, à 2 requêtes par personne. L'index
// local résout person.wiki_title en pageid (pageIdFromTitle), ce qui évite
// aussi la résolution de redirection que faisait articleImageTitlesByTitle.
export async function fetchAndStorePersonWikiPhotosBatch(persons) {
  const titlesByPerson = new Map();
  const allTitles = new Set();
  for (const person of persons) {
    const pageid = frwikiIndexReady() ? pageIdFromTitle(person.wiki_title) : null;
    const titles = await imageCandidateTitles(
      () => articleImageTitlesByTitle(person.wiki_title),
      pageid,
    );
    titlesByPerson.set(person.id, titles);
    for (const t of titles) allTitles.add(t);
  }
  const infoByTitle = await resolveImageInfoByTitle([...allTitles]);
  for (const person of persons) {
    const infos = (titlesByPerson.get(person.id) || [])
      .map((t) => infoByTitle.get(t))
      .filter(Boolean)
      .slice(0, MAX_IMAGES_PER_ARTICLE);
    const images = imageRowsFrom(infos);
    // le portrait déjà en base est réinjecté en tête : replacePersonImages
    // fait un DELETE+INSERT, l'omettre le ferait disparaître si cet appel ne
    // trouve rien de plus.
    if (person.portrait_image_url) {
      images.unshift({
        url: person.portrait_image_url,
        vote_count: 1,
        aspect_ratio: 1,
      });
    }
    db.replacePersonImages(person.id, images);
    db.markPersonPhotosChecked(person.id);
  }
}
