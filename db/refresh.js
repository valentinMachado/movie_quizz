import "dotenv/config";
import * as db from "./index.js";
import { logError, logInfo, logWarn, logDebug, logBanner } from "./refresh/log.js";
import {
  APP_VERSION,
  IGNORE_VERSION,
  MAX_TYPE_COUNT,
  CATEGORY_FETCH_CONCURRENCY,
  IMAGE_FETCH_CONCURRENCY,
  onlyWants,
  igdbEnabled,
  pexelsEnabled,
  DB_PATH,
  MOVIE_LEAD_CAST_LIMIT,
} from "./refresh/config.js";
import { mapWithConcurrency } from "./refresh/util.js";
import {
  fetchMovieEntities,
  refreshMovieLists,
  fetchTvEntities,
  refreshTvLists,
  fetchPersonEntities,
  fetchAndStoreMovieImages,
  fetchAndStorePersonImages,
  fetchAndStoreMovieCredits,
  fetchAndStorePersonDetails,
  fetchAndStoreFilmography,
  syncPersonDerivedPopularityTiers,
  syncPersonDerivedBirthFilters,
  tvShowNeedsWarming,
  fetchAndStoreTvImages,
} from "./refresh/tmdb.js";
import {
  fetchGameEntities,
  refreshGameLists,
  fetchAndStoreGameScreenshots,
} from "./refresh/igdb.js";
import {
  fetchPainterEntities,
  fetchAndStorePainterArtworks,
  fetchAllPersonRoleEntities,
  syncPainterPopularityTiers,
} from "./refresh/wikidata.js";
import {
  fetchCountryEntities,
  fetchAndStoreCountryPhotos,
} from "./refresh/pexels-country.js";
import { fetchMusicEntities, refreshMusicLists } from "./refresh/music.js";
import {
  fetchWikiArticleEntities,
  fetchAndStoreWikiArticleImagesBatch,
  fetchAndStorePersonWikiPhotosBatch,
} from "./refresh/wikipedia.js";
import { fetchPokemonEntities } from "./refresh/pokeapi.js";
import { fetchSuperheroEntities } from "./refresh/superhero.js";

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

db.init(DB_PATH);

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
// pour chaque warmLoop déclaré. Le détail de chaque fetch/warmLoop vit dans
// db/refresh/{tmdb,igdb,wikidata,pexels-country,music}.js, groupés par
// source de données plutôt que par type.
const TYPES = {
  movie: {
    fetchEntities: fetchMovieEntities,
    refreshLists: refreshMovieLists,
    warmLoops: [
      {
        // couvre réalisateurs ET casting (movie_director + movie_cast, même
        // réponse TMDb) — voir fetchAndStoreMovieCredits.
        name: "Films (crédits)",
        collectTargets: () => db.getMoviePool(),
        needsRefresh: (movie) => db.movieNeedsDirectors(movie),
        fetchAndStore: fetchAndStoreMovieCredits,
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
    // acteurs (TMDb) puis rôles Wikidata (politicien, futurs rôles — voir
    // fetchAllPersonRoleEntities) : les deux écrivent dans le même pool
    // "person" (additif), regroupés sous un seul fetchEntities pour que
    // db.countTypeItems("person")/isRefreshFresh("type","person",...)
    // couvrent bien les deux — un rôle Wikidata n'a pas de type_item propre
    // (voir commentaire sur fetchAllPersonRoleEntities), il ne peut donc pas
    // être sa propre entrée TYPES.
    fetchEntities: async () => {
      await fetchPersonEntities();
      await fetchAllPersonRoleEntities();
    },
    warmLoops: [
      {
        // "Personnes TMDb" (pas "Acteurs") : "person" contient aussi des
        // réalisateurs (source tmdb, OK — un réalisateur partage la même
        // ligne person qu'une éventuelle entrée acteur, voir
        // fetchAndStoreMovieCredits) et des peintres (source wikidata)
        // depuis l'ajout du rôle multi-valué — fetchAndStorePersonImages
        // appelle l'API TMDb via external_id, qui n'a aucun sens pour un QID
        // Wikidata. Les peintres gèrent déjà leur photo directement dans
        // fetchPainterEntities, donc exclus ici.
        name: "Personnes TMDb (images)",
        collectTargets: () => db.getPersonPool(),
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
        // server.js/dailyPersonAnniversaryBucket) + biography/summary (TMDb,
        // sans repli si absent — voir fetchAndStorePersonDetails)
        // — même garde source=tmdb que "Personnes TMDb (images)" ci-dessus,
        // acteurs ET réalisateurs (même remarque) : un peintre (source
        // wikidata) n'a pas d'external_id TMDb interrogeable ici.
        name: "Personnes TMDb (anniversaire + bio)",
        collectTargets: () => db.getPersonPool(),
        needsRefresh: (person) =>
          person.source === "tmdb" && db.personNeedsBirthday(person),
        fetchAndStore: fetchAndStorePersonDetails,
      },
      {
        name: "Réalisateurs (filmographie complète)",
        collectTargets: () => db.getDirectorPool(),
        needsRefresh: (person) => db.personNeedsFilmography(person),
        fetchAndStore: fetchAndStoreFilmography,
      },
      {
        // même fonction que ci-dessus (cast ET crew en un seul appel) — une
        // personne à la fois acteur et réalisateur, déjà traitée par le
        // warmLoop précédent, ressort "fraîche" ici (personNeedsFilmography
        // partagé) et n'est donc jamais refetchée deux fois.
        name: "Acteurs (filmographie complète)",
        collectTargets: () => db.getActorPool(),
        needsRefresh: (person) => db.personNeedsFilmography(person),
        fetchAndStore: fetchAndStoreFilmography,
      },
      {
        // rôles Wikidata (politicien, sportif, peintre — voir
        // fetchPersonRoleEntities, dont fetchPainterEntities délègue
        // désormais la découverte) n'ont qu'un seul portrait en base —
        // complète avec d'autres photos de leur article Wikipédia FR
        // (person.wiki_title, résolu à ce moment-là).
        name: "Personnes Wikidata (photos)",
        collectTargets: () => db.getPersonPool(),
        needsRefresh: (person) =>
          person.source === "wikidata" &&
          !!person.wiki_title &&
          db.personNeedsWikiPhotos(person),
        fetchAndStoreBatch: fetchAndStorePersonWikiPhotosBatch,
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
        fetchAndStore: fetchAndStoreCountryPhotos,
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
        fetchAndStore: fetchAndStorePainterArtworks,
      },
    ],
  },
  wiki_article: {
    fetchEntities: fetchWikiArticleEntities,
    warmLoops: [
      {
        name: "Articles Wikipédia (images)",
        collectTargets: () => db.getWikiArticlePool(),
        needsRefresh: (article) => db.wikiArticleNeedsImages(article),
        fetchAndStoreBatch: fetchAndStoreWikiArticleImagesBatch,
      },
    ],
  },
  // pas de warmLoop : sprite/cri/résumé sont déjà tous connus au moment du
  // fetch (2 requêtes PokeAPI par espèce, voir fetchPokemonEntities), rien
  // à compléter en tâche de fond (même cas que "music").
  pokemon: {
    fetchEntities: fetchPokemonEntities,
  },
  // pas de warmLoop non plus : portrait/summary déjà connus au fetch, un
  // seul appel réseau pour TOUT le pool (all.json), voir
  // fetchSuperheroEntities.
  superhero: {
    fetchEntities: fetchSuperheroEntities,
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
      !db.isRefreshFresh(
        "type",
        t,
        db.TTL_MS.typePool,
        IGNORE_VERSION ? null : APP_VERSION,
      ),
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

  // Jalon le plus attendu d'un run (les crawls de types durent des heures et
  // les warmLoops loguent en parallèle tout du long) : bannière plutôt que
  // logInfo, pour être repérable sans relire le log. Formulation prudente sur
  // ce qui est réellement fini — voir startWarmLoops/syncDerivedPersonFilters,
  // les pools actor/director continuent bel et bien de grossir après ça.
  const elapsedSec = ((Date.now() - startTs) / 1000).toFixed(1);
  logBanner([
    `POOLS COMPLETS en ${elapsedSec}s — ${types.length} types, toutes les entités`,
    "récupérées aux sources sont en base.",
    "",
    types.map((t) => `${t} ${db.countTypeItems(t)}`).join(" · "),
    "",
    "Continuent en tâche de fond : warmLoops (images, crédits, anniversaires,",
    "photos) et listes Populaire/Tendances. Ils enrichissent l'existant ; seuls",
    "actor et director grossissent encore, alimentés par les crédits de films.",
    "Le serveur peut être lancé.",
  ]);
}

// ---------- warm loops (généralisés) ----------
//
// Généralisation de la stratégie "fetch large d'abord (voir refreshTypes/
// TYPES[t].fetchEntities), complète les champs manquants ensuite" :
// chaque warm loop se réduit à ces 4 fonctions plutôt qu'à une boucle
// dupliquée pour chaque type. Chaque écriture SQLite étant déjà
// durable, il n'y a pas besoin de persistance incrémentale séparée.
// `fetchAndStore` traite UNE cible (le cas général : un appel réseau par
// entité). `fetchAndStoreBatch` + `batchSize` traitent un PAQUET de cibles
// d'un coup, pour les sources qui savent répondre pour plusieurs entités à
// la fois — voir "Articles Wikipédia (images)", où grouper les titres divise
// le nombre de requêtes par ~20. Les deux formes passent par le même moteur,
// le cas unitaire n'étant qu'un lot de 1.
async function runBackfillLoop({
  name,
  collectTargets,
  needsRefresh,
  fetchAndStore,
  fetchAndStoreBatch,
  batchSize = 20,
}) {
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
        const size = fetchAndStoreBatch ? batchSize : 1;
        const runBatch = fetchAndStoreBatch ?? ((batch) => fetchAndStore(batch[0]));
        const batches = [];
        for (let i = 0; i < toWarm.length; i += size) batches.push(toWarm.slice(i, i + size));
        await mapWithConcurrency(
          batches,
          IMAGE_FETCH_CONCURRENCY,
          async (batch) => {
            try {
              await runBatch(batch);
            } catch (e) {
              // erreur réseau : on retentera au prochain passage — journalisé
              // en debug seulement (fréquent/transitoire), voir le compteur
              // "failed" du résumé pour repérer un taux d'échec anormal.
              failed += batch.length;
              logDebug(
                `${name} : échec sur cible ${batch[0].id ?? batch[0].ccn3 ?? "?"} — ${e.message}`,
              );
              return;
            }
            warmed += batch.length;
            if (warmed % 100 < size || warmed === toWarm.length) {
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

// pool + filtres dérivés de director/actor (billing, popularité, decennie/
// geographie) : recalculés depuis des données déjà en cache (movie_director/
// movie_cast/person.birthday), aucun appel réseau — contrairement à
// refreshTypes/refreshAllLists plus bas, pas besoin de TTL ici pour ménager
// un coût réseau. Mais les warmLoops ("Films (crédits)", "Acteurs
// (filmographie complète)", "Personnes TMDb (anniversaire + bio)")
// continuent d'alimenter movie_cast/birthday EN CONTINU pendant que ce
// process tourne, donc un simple appel au démarrage suffirait à corrompre la
// cohérence : sans le setInterval plus bas, billing/popularité/decennie/
// geographie resteraient figés sur l'état du tout premier démarrage jusqu'à
// un redémarrage manuel du process (voir échange avec l'utilisateur).
function syncDerivedPersonFilters() {
  db.syncDirectorPoolFromMovieDirector();
  db.syncActorPoolFromMovieCast();
  db.syncActorBillingFromMovieCast(MOVIE_LEAD_CAST_LIMIT);
  syncPersonDerivedPopularityTiers();
  syncPersonDerivedBirthFilters();
  syncPainterPopularityTiers();
}

syncDerivedPersonFilters();
refreshTypes();
refreshAllLists({ isStartup: true });
// recheck bien plus fréquent que TTL_MS.typePool (~1 mois, hors de portée
// d'un setInterval JS, voir refreshTypes) : le filtre isRefreshFresh à
// l'intérieur absorbe les appels tant qu'aucun type n'a expiré.
setInterval(() => refreshTypes(), db.TTL_MS.listPool).unref();
setInterval(() => refreshAllLists(), db.TTL_MS.listPool).unref();
// même cadence par défaut que le sleep entre deux passages d'un warmLoop
// (voir runBackfillLoop) : syncDerivedPersonFilters ne fait aucun appel
// réseau (contrairement à refreshTypes/refreshAllLists ci-dessus, dont la
// cadence ménage un vrai coût TMDb) — un run complet ne coûte qu'un
// aller-retour SQL local, pas la peine de chercher plus fin qu'un intervalle
// fixe (voir échange avec l'utilisateur sur une éventuelle cadence adaptative).
setInterval(syncDerivedPersonFilters, 60 * 60 * 1000).unref();
startWarmLoops();
