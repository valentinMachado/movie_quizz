import "dotenv/config";
import express from "express";
import path from "node:path";
import { readFileSync } from "node:fs";
import * as db from "./db.js";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const APP_VERSION = JSON.parse(
  readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
).version;
const MIN_COUNT = 5;
// plafonné à 50 (pas 100) : la lecture progressive pendant le rendu (voir
// renderFast côté client) n'évince rien du SourceBuffer, donc une vidéo
// trop longue peut dépasser le quota mémoire du navigateur — 50 titres
// reste dans une plage sûre sans avoir besoin d'éviction.
const MAX_COUNT = 50;
const MIN_IMAGES_PER_ITEM = 1;
const MAX_IMAGES_PER_ITEM = 5;
const IMAGE_FETCH_CONCURRENCY = 8;

// lecture de config uniquement (pas d'appel réseau) — sert seulement à ne
// pas bloquer indéfiniment la LED /api/stats.ready si les photos pays n'ont
// jamais été activées côté refresh.js (voir isDbWarmed plus bas).
const pexelsEnabled = Boolean(process.env.PEXELS_API_KEY);

// --db=<path> : fichier SQLite à ouvrir (défaut cache/data.sqlite) — doit
// pointer sur le même fichier que le refresh.js qui l'alimente. Ce process
// ne fait plus aucun appel réseau : uniquement de la lecture (et l'écriture
// légère des stats d'usage, voir /api/quiz-batch) via db.js.
const DB_ARG = process.argv.find((a) => a.startsWith("--db="));
const DB_PATH = DB_ARG
  ? DB_ARG.slice("--db=".length)
  : process.argv.includes("--ephemeral-db")
    ? ":memory:"
    : path.join(process.cwd(), "cache", "data.sqlite");

db.init(DB_PATH);

// id "à offset" exposés au client (contrat inchangé) : centralisés ici.
// `naturalId` est l'id réel de l'entité (ccn3, id TMDb, numéro extrait du
// QID Wikidata).
const COUNTRY_ID_OFFSET_IMAGE = 1_000_000_000_000;
const PAINTER_ID_OFFSET = 2_000_000_000_000;
const COUNTRY_ID_OFFSET_FLAG = 3_000_000_000_000;
const SYNOPSIS_ID_OFFSET = {
  movie: 4_000_000_000_000,
  tv: 5_000_000_000_000,
  game: 8_000_000_000_000,
};
// une entrée "person" peut être source wikidata (peintre, rôle "painter" —
// voir materializePersonRow) : son external_id est un QID ("Q123"), pas un
// id TMDb numérique — sans cet offset dédié, Number("Q123") vaudrait NaN, et
// même une fois le "Q" retiré, le nombre obtenu pourrait numériquement
// entrer en collision avec un vrai id TMDb d'acteur.
const PERSON_WIKIDATA_ID_OFFSET = 6_000_000_000_000;
// un réalisateur partage la même ligne `person` (et donc le même id TMDb)
// que son éventuelle entrée "acteur" (voir materializePersonRow) — sans cet
// offset dédié, le pool "director" et le pool "person" pourraient exposer le
// même id pour deux items différents (photo à deviner vs films à deviner),
// qui s'écraseraient l'un l'autre dans itemsFromSelections si les deux sont
// sélectionnés ensemble.
const DIRECTOR_ID_OFFSET = 7_000_000_000_000;
// en dessous, un synopsis est jugé trop court pour être une devinette
// exploitable (ex: "Documentaire.")
const MIN_SYNOPSIS_LEN = 30;

function toPoolId(type, questionType, naturalId) {
  if (type === "country" && questionType === "image")
    return COUNTRY_ID_OFFSET_IMAGE + naturalId;
  if (type === "country" && questionType === "flag")
    return COUNTRY_ID_OFFSET_FLAG + naturalId;
  if (type === "painter") return PAINTER_ID_OFFSET + naturalId;
  if (type === "director") return DIRECTOR_ID_OFFSET + naturalId;
  if (questionType === "synopsis") return SYNOPSIS_ID_OFFSET[type] + naturalId;
  return naturalId;
}

// ---------- matérialisation : SQLite -> pool de quiz ----------
//
// chaque materialize*Row(s) prend les lignes déjà filtrées (voir
// TYPES[type].getPool) et ne garde QUE le questionType demandé — un même
// type peut être sollicité plusieurs fois (movie:image et movie:synopsis)
// avec des filtres différents, voir materializeSelection.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// un synopsis reprend rarement le titre EXACT tel qu'affiché ailleurs : il
// coupe souvent au sous-titre ("Titre: Sous-titre" -> "Titre" tout court, ex.
// IGDB sur "Grand Theft Auto: London 1969" qui reparle juste de "Grand Theft
// Auto") ou tronque un numéro de suite ("Monster Hunter 4 Ultimate" ->
// "Monster Hunter 4"/"Monster Hunter"). MIN_LEN écarte les fragments trop
// génériques pour valoir la peine d'être masqués (chiffres seuls, "II"...).
const TITLE_VARIANT_MIN_LEN = 4;
function titleVariants(title) {
  const variants = new Set([title]);
  for (const part of title.split(/[:\-–—]/)) {
    const trimmed = part.trim();
    if (trimmed.length >= TITLE_VARIANT_MIN_LEN) variants.add(trimmed);
  }
  const words = title.split(/\s+/);
  for (let n = words.length - 1; n >= 2; n--) {
    const prefix = words.slice(0, n).join(" ").trim();
    if (prefix.length >= TITLE_VARIANT_MIN_LEN) variants.add(prefix);
  }
  // plus long d'abord : dans une alternance regex, le premier candidat qui
  // matche à une position donnée gagne — sans ce tri, un fragment court
  // ("Monster Hunter") pourrait consommer le texte avant que la variante
  // plus longue et plus précise ("Monster Hunter 4") n'ait sa chance.
  return [...variants].sort((a, b) => b.length - a.length);
}

// un synopsis (TMDb overview / IGDB summary) mentionne très souvent son
// propre titre en toutes lettres (ex: IGDB commence typiquement par "<Titre>
// is a ..."), ce qui rendrait la devinette triviale — on masque toute
// occurrence (insensible à la casse) du titre ou d'une de ses variantes
// probables (voir titleVariants) avant de l'exposer.
function redactTitle(text, title) {
  if (!text || !title) return text;
  const pattern = titleVariants(title).map(escapeRegExp).join("|");
  return text.replace(new RegExp(pattern, "gi"), "[titre]");
}

// movie/tv se matérialisent pareil (poster TMDb + question bonus "synopsis"
// si l'overview est assez longue) — seule la source SQLite et le type
// changent.
function materializeMovieLikeRows(rows, type, questionType) {
  const result = [];
  for (const item of rows) {
    const posterUrl = `https://image.tmdb.org/t/p/w500${item.poster_path}`;
    if (questionType === "image") {
      result.push({
        id: item.id,
        title: item.title,
        type,
        questionType: "image",
        posterUrl,
        // "reason" (quiz du jour uniquement, voir dailyQuiz*) : pourquoi cette
        // entité est entrée dans le quiz — absent en dehors de ce mode.
        // "isAnniversary" distingue les buckets anniversaire (movie/music/
        // person) du bucket trending — seul ce cas affiche le gâteau côté
        // client (voir drawReveal).
        ...(item.reason ? { reason: item.reason } : {}),
        ...(item.isAnniversary ? { isAnniversary: true } : {}),
      });
    } else if (questionType === "synopsis") {
      const overview = redactTitle(
        (item.overview || "").trim(),
        item.title,
      );
      if (overview.length >= MIN_SYNOPSIS_LEN) {
        result.push({
          id: toPoolId(type, "synopsis", item.id),
          title: item.title,
          overview,
          type,
          questionType: "synopsis",
          posterUrl,
          ...(item.reason ? { reason: item.reason } : {}),
          ...(item.isAnniversary ? { isAnniversary: true } : {}),
        });
      }
    }
  }
  return result;
}

function materializeGameRows(rows, questionType) {
  const result = [];
  for (const g of rows) {
    const posterUrl = `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover_image_id}.jpg`;
    if (questionType === "image") {
      result.push({
        id: g.id,
        title: g.title,
        type: "game",
        questionType: "image",
        posterUrl,
        ...(g.reason ? { reason: g.reason } : {}),
        ...(g.isAnniversary ? { isAnniversary: true } : {}),
      });
    } else if (questionType === "synopsis") {
      const summary = redactTitle((g.summary || "").trim(), g.title);
      if (summary.length >= MIN_SYNOPSIS_LEN) {
        result.push({
          id: toPoolId("game", "synopsis", g.id),
          title: g.title,
          overview: summary,
          type: "game",
          questionType: "synopsis",
          posterUrl,
          ...(g.reason ? { reason: g.reason } : {}),
          ...(g.isAnniversary ? { isAnniversary: true } : {}),
        });
      }
    }
  }
  return result;
}

function materializeMusicTrackRow(t) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    track: t.track,
    type: "music",
    questionType: "audio",
    previewUrl: t.preview_url,
    posterUrl: t.poster_url,
    ...(t.reason ? { reason: t.reason } : {}),
    ...(t.isAnniversary ? { isAnniversary: true } : {}),
  };
}

function materializeCountryRows(rows, questionType) {
  const result = [];
  for (const c of rows) {
    const flagUrl = `https://flagcdn.com/w320/${c.cca2.toLowerCase()}.png`;
    if (questionType === "image") {
      result.push({
        id: toPoolId("country", "image", c.ccn3),
        title: c.title,
        type: "country",
        questionType: "image",
        photoQuery: c.photo_query,
        posterUrl: flagUrl,
        countryCcn3: c.ccn3,
      });
    } else if (questionType === "flag" && c.capital) {
      result.push({
        id: toPoolId("country", "flag", c.ccn3),
        title: c.title,
        capital: c.capital,
        type: "country",
        questionType: "flag",
        posterUrl: flagUrl,
      });
    }
  }
  return result;
}

function materializePersonRow(p) {
  // acteur/réalisateur (source tmdb) : external_id est déjà l'id TMDb
  // numérique, utilisé tel quel. Peintre (source wikidata, rôle "painter") :
  // external_id est un QID ("Q123") — on retire le "Q" et on offset pour
  // rester dans un espace d'id disjoint des vrais id TMDb.
  const naturalId =
    p.source === "wikidata"
      ? PERSON_WIKIDATA_ID_OFFSET + Number(p.external_id.slice(1))
      : Number(p.external_id);
  return {
    id: naturalId,
    title: p.name,
    type: "person",
    questionType: "image",
    // profile_image_url (acteurs TMDb) ; repli sur portrait_image_url
    // (peintres wikidata, qui n'ont pas de profile_image_url).
    posterUrl: p.profile_image_url || p.portrait_image_url,
    personId: p.id,
    ...(p.reason ? { reason: p.reason } : {}),
    ...(p.isAnniversary ? { isAnniversary: true } : {}),
  };
}

function materializePainterRow(p) {
  return {
    id: toPoolId("painter", "image", Number(p.external_id.slice(1))),
    title: p.name,
    type: "painter",
    questionType: "image",
    // déjà une URL de thumbnail finale (convertie par refresh.js à l'écriture)
    posterUrl: p.portrait_image_url,
    personId: p.id,
  };
}

function materializeDirectorRow(p) {
  // source toujours "tmdb" (crédits de réalisation, voir refresh.js) :
  // external_id est déjà l'id TMDb numérique, pas de préfixe à retirer
  // (contrairement aux peintres, source wikidata).
  return {
    id: toPoolId("director", "image", Number(p.external_id)),
    title: p.name,
    type: "director",
    questionType: "image",
    // photo du réalisateur, révélée à l'écran de réponse — les images de
    // devinette sont les affiches de ses films (voir getBackdropsForItem),
    // pas cette photo.
    posterUrl: p.profile_image_url,
    personId: p.id,
  };
}

// un type = quels questionTypes il peut produire (info structurelle fixe,
// pas dérivée des données — voir /api/catalog), comment lire son pool filtré
// (db.getXPool(filters), voir db.js) et comment matérialiser ce pool en
// items de quiz pour UN questionType donné. Toute la logique d'ingestion
// (fetch entités, warmLoops, filtres) vit dans refresh.js — ce process ne
// fait plus que lire. `game` reste toujours présent : si IGDB n'est pas
// configuré côté refresh.js, le pool est simplement vide.
const TYPES = {
  movie: {
    questionTypes: ["image", "synopsis"],
    getPool: db.getMoviePool,
    materialize: (rows, questionType) =>
      materializeMovieLikeRows(rows, "movie", questionType),
  },
  tv: {
    questionTypes: ["image", "synopsis"],
    getPool: db.getTvShowPool,
    materialize: (rows, questionType) =>
      materializeMovieLikeRows(rows, "tv", questionType),
  },
  person: {
    questionTypes: ["image"],
    getPool: db.getPersonPool,
    materialize: (rows) => rows.map(materializePersonRow),
  },
  game: {
    questionTypes: ["image", "synopsis"],
    getPool: db.getGamePool,
    materialize: (rows, questionType) => materializeGameRows(rows, questionType),
  },
  music: {
    questionTypes: ["audio"],
    getPool: db.getMusicTrackPool,
    materialize: (rows) => rows.map(materializeMusicTrackRow),
  },
  country: {
    questionTypes: ["image", "flag"],
    getPool: db.getCountryPool,
    materialize: (rows, questionType) =>
      materializeCountryRows(rows, questionType),
  },
  painter: {
    questionTypes: ["image"],
    getPool: db.getPainterPool,
    materialize: (rows) => rows.map(materializePainterRow),
  },
  director: {
    questionTypes: ["image"],
    getPool: db.getDirectorPool,
    materialize: (rows) => rows.map(materializeDirectorRow),
  },
};

function hasAnyPool() {
  return Object.keys(TYPES).some((t) => db.countTypeItems(t) > 0);
}

// LED de statut /api/stats.ready : c'est ça qu'on annonce au client — "la
// base est chauffée" (nom aligné sur le vocabulaire warmLoop/chauffage de
// refresh.js), pas "les warmLoops sont ready" (détail d'implémentation).
// Ne couvre que les warmLoops "bloquants" (peintures, photos pays) sont-ils
// à jour pour tout ce qui est actuellement dans le pool ? Le pool
// "director" se remplit progressivement au fil du même warmLoop
// réalisateurs (jamais bloquant côté refresh.js) — un pool encore vide se
// traduit juste par un /api/pool-size à 0 pour ce type, déjà géré
// normalement côté client (comme n'importe quelle combinaison de filtres
// sans résultat), donc pas besoin de le vérifier ici non plus.
function isDbWarmed() {
  if (db.anyPainterArtworkStale()) return false;
  if (pexelsEnabled && db.anyCountryPhotosStale()) return false;
  return true;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// une entrée `selections[]` (voir /api/quiz-batch) = un bucket indépendant
// type+questionType+filtres — valide que le type/questionType existe (sinon
// lève, voir l'appelant pour la conversion en 400), puis lit et matérialise
// son pool filtré. Deux entrées peuvent cibler le même type avec des filtres
// différents (ex. movie:image en "Populaire" et movie:synopsis en
// "Années 1990"), c'est tout l'intérêt de ce découpage par entrée plutôt que
// par type brut.
function materializeSelection({ type, questionType, filters }) {
  const cfg = TYPES[type];
  if (!cfg) throw new Error(`type inconnu: "${type}"`);
  if (!cfg.questionTypes.includes(questionType))
    throw new Error(`questionType "${questionType}" invalide pour "${type}"`);
  return cfg.materialize(cfg.getPool(filters), questionType);
}

// assemble le pool candidat depuis les sélections du client — dédupliqué par
// id (une même entité peut ressortir de plusieurs sélections, ex. filtres
// qui se recoupent) ; matérialisée depuis SQLite à chaque appel (pas de pool
// en mémoire — la DB est la seule source de vérité, tenue à jour par
// refresh.js en parallèle).
function itemsFromSelections(selections) {
  const merged = new Map();
  for (const selection of selections) {
    for (const item of materializeSelection(selection)) merged.set(item.id, item);
  }
  return [...merged.values()];
}

// toutes les combinaisons type:questionType possibles, sans filtre — sert à
// /api/pool-size pour donner une taille de pool globale (comportement
// identique à l'ancien allItems() inconditionnel).
function allTypeQuestionSelections() {
  return Object.entries(TYPES).flatMap(([type, cfg]) =>
    cfg.questionTypes.map((questionType) => ({ type, questionType })),
  );
}

// répartit `count` aussi équitablement que possible entre les buckets
// sélectionnés (un bucket = une clé `type:questionType` distincte parmi les
// `selections[]` demandées — ex. "movie:image" et "movie:synopsis" sont deux
// buckets même si même type), comble les manques en piochant ailleurs pour
// quand même atteindre `count`. `shuffleFn` (défaut : `shuffle` non-seedé)
// permet au quiz du jour de passer un mélange seedé par la date (voir
// /api/quiz-daily) sans dupliquer cette répartition par bucket.
function stratifiedSelection(pool, selectionKeys, count, excludeIds, shuffleFn = shuffle) {
  const n = selectionKeys.length;
  if (n === 0) return [];

  const available = pool.filter((m) => !excludeIds.has(m.id));
  const perBucketPools = selectionKeys.map((key) =>
    shuffleFn(available.filter((m) => `${m.type}:${m.questionType}` === key)),
  );

  const baseShare = Math.floor(count / n);
  const remainder = count - baseShare * n;
  const remainderIdx = new Set(
    shuffleFn([...Array(n).keys()]).slice(0, remainder),
  );
  const shares = perBucketPools.map(
    (_, i) => baseShare + (remainderIdx.has(i) ? 1 : 0),
  );

  const primary = [];
  const pickedIds = new Set();
  const poolIdx = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    let taken = 0;
    while (taken < shares[i] && poolIdx[i] < perBucketPools[i].length) {
      const item = perBucketPools[i][poolIdx[i]++];
      if (pickedIds.has(item.id)) continue;
      pickedIds.add(item.id);
      primary.push(item);
      taken++;
    }
  }

  if (primary.length < count) {
    const shortfall = shuffleFn(
      perBucketPools
        .flatMap((pool, i) => pool.slice(poolIdx[i]))
        .filter((m) => !pickedIds.has(m.id)),
    );
    for (const item of shortfall) {
      if (primary.length >= count) break;
      pickedIds.add(item.id);
      primary.push(item);
    }
  }

  const reserve = shuffleFn(
    perBucketPools.flatMap((pool) => pool).filter((m) => !pickedIds.has(m.id)),
  );

  return shuffleFn(primary).concat(reserve);
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

// favorise les images pas encore vues récemment (queue du pool, mélangée)
// plutôt qu'un tirage uniforme sur tout l'historique — variété d'une partie
// à l'autre sans avoir besoin de suivre ce qui a déjà été montré.
function pickFromPool(pool, need) {
  let ordered = pool;
  if (ordered.length > need) {
    const tailStart = Math.floor(ordered.length * 0.45);
    const tail = ordered.slice(tailStart);
    ordered = tail.length >= need ? tail : ordered;
  }
  const shuffled = shuffle(ordered);
  const result = [];
  for (let i = 0; i < need; i++) result.push(shuffled[i % shuffled.length]);
  return result;
}

// écran réponse film : nom du/des réalisateur(s), lus via movie_director —
// chauffé en tâche de fond par refresh.js, jamais en direct ici.
function getCachedMovieDirector(movieId) {
  return db.getMovieDirectorNames(movieId);
}

// toutes les branches ci-dessous ne font QUE de la lecture SQLite (chauffée
// par refresh.js) — plus aucun appel réseau ici, et plus aucun filtrage
// "textless" : refresh.js ne stocke déjà que des images utilisables (voir
// fetchAndStoreMovieImages/fetchAndStorePersonImages/fetchAndStoreTvImages),
// ce fichier n'a qu'à les lire. Un item sans image en base est exclu du
// quiz (voir appelant), exactement comme pour peintures/pays avant cette
// réorganisation.
function getBackdropsForItem(item, need) {
  let backdrops;
  if (item.type === "movie") {
    backdrops = db.getMovieImages(item.id);
  } else if (item.type === "person") {
    backdrops = db.getPersonImages(item.personId);
  } else if (item.type === "tv") {
    backdrops = db.getTvShowImages(item.id);
  } else if (item.type === "game") {
    // IGDB n'a pas de notion de vote par image : on fixe un ratio 16:9.
    backdrops = db.getGameImages(item.id).map((imageId) => ({
      url: `https://images.igdb.com/igdb/image/upload/t_1080p/${imageId}.jpg`,
      vote_count: 1,
      aspect_ratio: 1.78,
    }));
  } else if (item.type === "country") {
    // Pexels n'a pas de notion de vote par image (comme IGDB).
    backdrops = db.getCountryPhotos(item.countryCcn3).map((p) => ({
      url: p.url,
      vote_count: p.voteCount,
      aspect_ratio: p.aspectRatio,
    }));
  } else if (item.type === "painter") {
    // plusieurs tableaux DIFFÉRENTS du même peintre, URLs déjà finales (pas
    // le portrait — l'utiliser comme image de devinette montrerait son
    // visage pendant la phase de jeu).
    backdrops = db.getPainterArtworks(item.personId).map((url) => ({
      url,
      vote_count: 1,
      aspect_ratio: 1,
    }));
  } else if (item.type === "director") {
    // affiches des films réalisés (pas son portrait — même logique que
    // "painter" ci-dessus) ; aspect_ratio d'affiche (~2:3), volontairement
    // hors de la plage "standard" 16:9 pour ne jamais être écarté par le
    // filtre isStandardRatio plus bas. `title` (extra, ignoré des autres
    // types) survit jusqu'au client via selectItemsWithBackdrops : un
    // poster n'affiche pas toujours son titre de façon lisible.
    backdrops = db.getDirectorMoviePosters(item.personId).map((m) => ({
      url: `https://image.tmdb.org/t/p/w500${m.posterPath}`,
      title: m.title,
      vote_count: 1,
      aspect_ratio: 2 / 3,
    }));
  } else {
    backdrops = [];
  }

  if (backdrops.length === 0) return [];

  const isStandardRatio = (b) =>
    b.aspect_ratio >= 1.7 && b.aspect_ratio <= 1.85;
  const standardRatio = backdrops.filter(isStandardRatio);
  const ratioPool =
    item.type === "person" || standardRatio.length === 0
      ? backdrops
      : standardRatio;

  const voted = ratioPool.filter((b) => b.vote_count > 0);
  const finalPool =
    voted.length >= Math.min(need, ratioPool.length) ? voted : ratioPool;

  // objets bruts (pas juste l'url) : "director" y accroche aussi `title`,
  // voir l'appelant (selectItemsWithBackdrops).
  return pickFromPool(finalPool, need);
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
    // seul questionType "image" a besoin de backdrops — pour les autres
    // (synopsis/flag/audio), `m` EST déjà la forme finale attendue par le
    // client : elle vient telle quelle de materializeMovieLikeRows/
    // materializeCountryRows/materializeMusicTrackRow (voir TYPES), pas
    // besoin de la reconstruire ici.
    const withImages = await mapWithConcurrency(
      batch,
      IMAGE_FETCH_CONCURRENCY,
      async (m) => {
        if (m.questionType !== "image") return m;
        const backdrops = getBackdropsForItem(m, imagesPerItem);
        if (backdrops.length === 0) return null;
        const director =
          m.type === "movie" ? getCachedMovieDirector(m.id) : null;
        // allowlist explicite : `m` porte aussi des champs internes utilisés
        // pour interroger getBackdropsForItem (personId, countryCcn3,
        // photoQuery) qui ne doivent pas fuiter dans la réponse au client.
        return {
          id: m.id,
          title: m.title,
          posterUrl: m.posterUrl,
          type: m.type,
          questionType: m.questionType,
          imageUrls: backdrops.map((b) => b.url),
          // titre du film affiché en surimpression pendant la devinette
          // (voir drawGuess côté client) : un poster n'écrit pas toujours
          // son titre de façon lisible, contrairement aux autres types où
          // aucune légende par image n'est nécessaire.
          ...(m.type === "director"
            ? { imageTitles: backdrops.map((b) => b.title || null) }
            : {}),
          ...(director ? { director } : {}),
          ...(m.reason ? { reason: m.reason } : {}),
          ...(m.isAnniversary ? { isAnniversary: true } : {}),
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

// tout ce dont le client a besoin pour construire sa sélection : par type,
// les questionTypes possibles (info structurelle fixe, voir TYPES) et les
// filtres disponibles (data-driven, voir db.getFiltersForType — reflète
// exactement ce que refresh.js a écrit en base, pas de liste codée en dur).
app.get("/api/catalog", (req, res) => {
  const catalog = {};
  for (const [type, cfg] of Object.entries(TYPES)) {
    catalog[type] = {
      questionTypes: cfg.questionTypes,
      filters: db.getFiltersForType(type),
    };
  }
  res.json(catalog);
});

// taille du pool pour une sélection donnée (mêmes `selections[]` que
// /api/quiz-batch) — sert au client à afficher "N éléments disponibles"
// pour les filtres en cours AVANT de générer un batch. `selections`
// omis/vide = taille globale non filtrée (comportement historique).
app.post("/api/pool-size", (req, res) => {
  const body = req.body || {};
  const selections =
    Array.isArray(body.selections) && body.selections.length > 0
      ? body.selections
      : allTypeQuestionSelections();
  try {
    res.json({ available: itemsFromSelections(selections).length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- quiz du jour ----------
//
// contrairement à /api/quiz-batch (filtres choisis par le client), ce mode
// n'a pas de sélection : le pool candidat est construit ici, mélangé avec un
// seed dérivé de la date du jour (mêmes items pour tout le monde jusqu'à
// minuit, sans état à stocker côté serveur), puis passé tel quel dans le
// pipeline existant (selectItemsWithBackdrops) — chaque candidat porte un
// `reason` (voir materializeMovieLikeRows/materializeMusicTrackRow/
// materializePersonRow, seul mode qui le peuple) qui explique au client
// pourquoi il est dans le quiz du jour (voir drawReveal côté scenes.js).
// nombre d'années écoulées depuis `year` — exact sans ajustement mois/jour
// (l'appelant a déjà filtré sur le mois/jour du jour même, voir
// getMoviesByReleaseMonthDay/getPersonsByBirthMonthDay), donc "aujourd'hui"
// EST l'anniversaire exact.
function yearsAgo(year) {
  const n = new Date().getFullYear() - parseInt(year, 10);
  return n === 1 ? "il y a 1 an" : `il y a ${n} ans`;
}

// codes du groupe "liste" retenus comme "actualité" — seuls ceux-là sont
// rafraîchis à cadence courte (~24h, voir refreshMovieLists/refreshTvLists
// dans refresh.js), contrairement au reste du groupe "liste" qui ne bouge
// quasiment jamais. Un item déjà vu sur un code antérieur garde son premier
// libellé (ordre = priorité d'affichage).
const DAILY_TRENDING_CODES = {
  movie: ["trending_day", "now_playing"],
  tv: ["tv_trending_day", "tv_airing_today"],
  game: ["game_recent"],
  // pas de liste nommée "tendance" pour la musique (charts Apple Music par
  // pays, voir config.json) mais même mécanique : rafraîchies à cadence
  // courte par refreshMusicLists (voir refresh.js), donc tout aussi
  // "actualité" qu'un trending_day TMDb. Seulement 2 des 8 pays (pas les 8) :
  // sinon la musique dominerait le quiz du jour face aux 2 codes movie/tv.
  music: ["music_popular_fr", "music_popular_us"],
};

// une entrée par liste "actualité" (pas par type:questionType comme les
// anniversaires, voir dailyAnniversaryPicks) : 1 item pioché par liste, avec
// un questionType tiré au hasard parmi ceux du type — contrairement à un
// anniversaire, une liste n'a pas besoin de représenter tous ses
// questionTypes, un seul suffit à représenter "Tendances du jour (Films)"
// pour la journée. `rng` est réutilisé (fermeture partagée avec le reste du
// quiz du jour) pour que ce tirage reste stable toute la journée.
function dailyListPicks(rng) {
  const picked = [];
  for (const [type, codes] of Object.entries(DAILY_TRENDING_CODES)) {
    const cfg = TYPES[type];
    for (const code of codes) {
      const label = db.getFilterLabel(type, "liste", code) || code;
      const rows = cfg.getPool({ liste: [code] });
      if (rows.length === 0) continue;
      for (const row of rows) row.reason = label;
      // certains questionTypes peuvent ne rien donner (ex. "synopsis" si
      // aucun overview assez long dans ce tirage) — on essaie les
      // questionTypes dans un ordre aléatoire jusqu'à en trouver un qui
      // matérialise au moins un item, plutôt que de se limiter au premier.
      let item = null;
      for (const questionType of seededShuffle(cfg.questionTypes, rng)) {
        const materialized = cfg.materialize(rows, questionType);
        if (materialized.length > 0) {
          item = seededShuffle(materialized, rng)[0];
          break;
        }
      }
      if (item) picked.push(item);
    }
  }
  return picked;
}

function dailyMovieAnniversaryBucket(month, day) {
  const rows = db.getMoviesByReleaseMonthDay(month, day);
  for (const row of rows) {
    const year = String(row.release_date).slice(0, 4);
    row.reason = `Sorti ${yearsAgo(year)}`;
    row.isAnniversary = true;
  }
  const result = [];
  for (const questionType of TYPES.movie.questionTypes) {
    result.push(...materializeMovieLikeRows(rows, "movie", questionType));
  }
  return result;
}

function dailyGameAnniversaryBucket(month, day) {
  const rows = db.getGamesByReleaseMonthDay(month, day);
  for (const row of rows) {
    const year = String(row.release_date).slice(0, 4);
    row.reason = `Sorti ${yearsAgo(year)}`;
    row.isAnniversary = true;
  }
  const result = [];
  for (const questionType of TYPES.game.questionTypes) {
    result.push(...materializeGameRows(rows, questionType));
  }
  return result;
}

function dailyMusicAnniversaryBucket(month, day) {
  const rows = db.getMusicTracksByReleaseMonthDay(month, day);
  for (const row of rows) {
    const year = String(row.release_date).slice(0, 4);
    row.reason = `Sorti ${yearsAgo(year)}`;
    row.isAnniversary = true;
  }
  return rows.map(materializeMusicTrackRow);
}

function dailyPersonAnniversaryBucket(month, day) {
  // type "person" (voir TYPES) couvre déjà acteurs/réalisateurs/peintres
  // (rôle multi-valué, voir refresh.js fetchPainterEntities) — pas besoin
  // d'interroger séparément les pools "director"/"painter" en plus.
  const rows = db.getPersonsByBirthMonthDay("person", month, day);
  for (const row of rows) {
    const year = String(row.birthday).slice(0, 4);
    row.reason = `Né(e) ${yearsAgo(year)}`;
    row.isAnniversary = true;
  }
  return rows.map(materializePersonRow);
}

// 1 item par bucket type:questionType parmi les 4 sources anniversaire —
// contrairement à dailyListPicks (1 par liste, questionType au hasard), un
// anniversaire veut représenter CHAQUE questionType qu'il peut produire (ex.
// movie:image ET movie:synopsis séparément, si les deux ont un item ce
// jour-là), pas un seul tiré au hasard parmi eux.
function dailyAnniversaryPicks(month, day, rng) {
  const pool = [
    ...dailyMovieAnniversaryBucket(month, day),
    ...dailyGameAnniversaryBucket(month, day),
    ...dailyMusicAnniversaryBucket(month, day),
    ...dailyPersonAnniversaryBucket(month, day),
  ];
  const byBucket = new Map();
  for (const m of pool) {
    const key = `${m.type}:${m.questionType}`;
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(m);
  }
  const picked = [];
  for (const items of byBucket.values()) {
    picked.push(seededShuffle(items, rng)[0]);
  }
  return picked;
}

// PRNG déterministe (mulberry32-like) : même dateKey => même séquence, pour
// que le quiz du jour soit identique pour tout le monde tant qu'on reste le
// même jour, sans avoir besoin de stocker le tirage côté serveur.
function seededRng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

app.post("/api/quiz-daily", async (req, res) => {
  if (!hasAnyPool()) {
    return res.status(503).json({
      error: "Contenu en cours de préparation, réessaie dans un instant.",
    });
  }

  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dateKey = `${now.getFullYear()}-${month}-${day}`;

  // taille figée par construction, pas un total configurable réparti ensuite :
  // 1 item par bucket type:questionType d'anniversaire (movie:image ET
  // movie:synopsis séparément si les deux existent, voir
  // dailyAnniversaryPicks) + 1 item par liste "actualité" du jour, tous
  // questionTypes confondus (voir dailyListPicks) — un jour avec moins de
  // contenu (pas d'anniversaire personne, une liste vide) donne simplement un
  // quiz plus court, plutôt que de repiocher ailleurs pour compenser. Mélange
  // seedé par la date (voir seededRng) pour que le choix reste stable toute
  // la journée.
  const rng = seededRng(dateKey);
  const picked = [
    ...dailyAnniversaryPicks(month, day, rng),
    ...dailyListPicks(rng),
  ];

  if (picked.length === 0) {
    return res.status(503).json({
      error: "Aucun contenu disponible pour le quiz du jour.",
    });
  }

  const body = req.body || {};
  const imagesPerItem = Math.min(
    MAX_IMAGES_PER_ITEM,
    Math.max(MIN_IMAGES_PER_ITEM, parseInt(body.imagesPerItem, 10) || 1),
  );
  const count = picked.length;

  const { items: withImages, excludedCount } = await selectItemsWithBackdrops(
    seededShuffle(picked, rng),
    count,
    imagesPerItem,
  );

  res.json({
    items: withImages,
    date: dateKey,
    requested: count,
    delivered: withImages.length,
    excludedCount,
    imagesPerItem,
    totalGenerated: db.recordQuizGenerated(),
  });
});

app.get("/api/stats", (req, res) => {
  res.json({
    totalGenerated: db.getStats().totalGenerated,
    version: APP_VERSION,
    ready: hasAnyPool() && isDbWarmed(),
  });
});

app.post("/api/quiz-batch", async (req, res) => {
  if (!hasAnyPool()) {
    return res.status(503).json({
      error: "Contenu en cours de préparation, réessaie dans un instant.",
    });
  }

  const body = req.body || {};
  const selections = Array.isArray(body.selections) ? body.selections : [];
  if (selections.length === 0) {
    return res
      .status(400)
      .json({ error: "selections requis (au moins une entrée)." });
  }

  let all;
  try {
    all = itemsFromSelections(selections);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const imagesPerItem = Math.min(
    MAX_IMAGES_PER_ITEM,
    Math.max(MIN_IMAGES_PER_ITEM, parseInt(body.imagesPerItem, 10) || 1),
  );

  const count = Math.min(
    MAX_COUNT,
    Math.max(MIN_COUNT, parseInt(body.count, 10) || 50),
    all.length || MIN_COUNT,
  );

  const excludeIds = new Set(
    Array.isArray(body.exclude) ? body.exclude.map(Number) : [],
  );

  const availableAfterExclude = all.filter((m) => !excludeIds.has(m.id));
  let effectiveExclude = excludeIds;
  let recycled = false;
  if (availableAfterExclude.length < count) {
    effectiveExclude = new Set();
    recycled = true;
  }

  // une même clé type:questionType peut apparaître dans plusieurs entrées de
  // `selections` (filtres différents) — dédupliquée ici en un seul bucket de
  // stratification (voir stratifiedSelection), leurs pools respectifs ayant
  // déjà été fusionnés dans `all` par itemsFromSelections.
  const selectionKeys = [
    ...new Set(selections.map((s) => `${s.type}:${s.questionType}`)),
  ];

  const picked = stratifiedSelection(
    all,
    selectionKeys,
    count,
    effectiveExclude,
  );
  const { items: withImages, excludedCount } = await selectItemsWithBackdrops(
    picked,
    count,
    imagesPerItem,
  );

  res.json({
    items: withImages,
    recycled,
    requested: count,
    delivered: withImages.length,
    excludedCount,
    imagesPerItem,
    poolSize: all.length,
    totalGenerated: db.recordQuizGenerated(),
  });
});

app.use(express.static(path.join(process.cwd(), "public")));

app.listen(PORT, () => console.log(`Guess It sur http://localhost:${PORT}`));
