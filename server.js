import "dotenv/config";
import express from "express";
import path from "node:path";
import { readFileSync } from "node:fs";
import * as db from "./db/index.js";

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
const MAX_IMAGES_PER_ITEM = 20;
// nombre de summary cyclés pour director:summary (voir selectItemsWithBackdrops)
// — réglage indépendant de imagesPerItem, qui n'a pas de sens pour ce mode.
const MIN_SUMMARY_PER_ITEM = 1;
const MAX_SUMMARY_PER_ITEM = 5;
const IMAGE_FETCH_CONCURRENCY = 8;

// lecture de config uniquement (pas d'appel réseau) — sert seulement à ne
// pas bloquer indéfiniment la LED /api/stats.ready si les photos pays n'ont
// jamais été activées côté refresh.js (voir isDbWarmed plus bas).
const pexelsEnabled = Boolean(process.env.PEXELS_API_KEY);

// --db=<path> : fichier SQLite à ouvrir (défaut cache/data.sqlite) — doit
// pointer sur le même fichier que le refresh.js qui l'alimente. Ce process
// ne fait plus aucun appel réseau : uniquement de la lecture (et l'écriture
// légère des stats d'usage, voir /api/quiz-batch) via db/.
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
// questionType "leader" (deviner le chef d'État actuel du pays) : même
// naturalId (ccn3) que "image"/"flag"/"map" pour ce pays, donc son propre
// offset pour ne pas s'écraser si plusieurs questionTypes "country" sont
// sélectionnés ensemble (même piège que COUNTRY_ID_OFFSET_FLAG).
const COUNTRY_ID_OFFSET_LEADER = 20_000_000_000_000;
// type "statesman" (sens inverse de "leader" : pays affiché, deviner le
// chef d'État — type top-level à part, pas un questionType de "country",
// voir materializeStatesmanRows) — même naturalId (ccn3) que "country" pour
// ce pays, donc son propre offset.
const COUNTRY_ID_OFFSET_STATESMAN = 21_000_000_000_000;
const SUMMARY_ID_OFFSET = {
  movie: 4_000_000_000_000,
  tv: 5_000_000_000_000,
  game: 8_000_000_000_000,
};
// une entrée "person" peut être source wikidata (peintre, rôle "painter" —
// voir materializePersonRows) : son external_id est un QID ("Q123"), pas un
// id TMDb numérique — sans cet offset dédié, Number("Q123") vaudrait NaN, et
// même une fois le "Q" retiré, le nombre obtenu pourrait numériquement
// entrer en collision avec un vrai id TMDb d'acteur.
const PERSON_WIKIDATA_ID_OFFSET = 6_000_000_000_000;
// un réalisateur partage la même ligne `person` (et donc le même id TMDb)
// que son éventuelle entrée "acteur" (voir materializePersonRows) — sans cet
// offset dédié, le pool "director" et le pool "person" pourraient exposer le
// même id pour deux items différents (photo à deviner vs films à deviner),
// qui s'écraseraient l'un l'autre dans itemsFromSelections si les deux sont
// sélectionnés ensemble.
const DIRECTOR_ID_OFFSET = 7_000_000_000_000;
// même réalisateur, même id TMDb, mais un mode "summary" distinct du mode
// "image" ci-dessus (DIRECTOR_ID_OFFSET) : sans cet offset propre, les deux
// s'écraseraient l'un l'autre si director:image et director:summary sont
// sélectionnés ensemble (même piège que DIRECTOR_ID_OFFSET vs person).
const DIRECTOR_SUMMARY_ID_OFFSET = 9_000_000_000_000;
// wiki_article.id (voir db/wikiArticle.js) est le pageid Wikipédia — un
// nombre a priori "petit" comme les vieux id TMDb, donc lui aussi a besoin
// de son propre espace d'id disjoint (même piège que painter/director
// ci-dessus), et de 2 offsets distincts (image vs summary, même principe
// que director).
const WIKI_ARTICLE_ID_OFFSET = 10_000_000_000_000;
const WIKI_ARTICLE_SUMMARY_ID_OFFSET = 11_000_000_000_000;
// national dex number (id PokeAPI) : un espace d'id minuscule et
// entièrement dense (1..~1025) — bien plus sujet à collision avec les id
// TMDb/IGDB "bruts" (movie/tv/game, jamais offsetés eux, voir plus bas)
// qu'un simple risque théorique : garantit une collision quasi certaine
// sans cet offset dédié. 3 offsets distincts (image/summary/audio) même
// principe que director/wiki_article ci-dessus, pour qu'un même pokémon
// sélectionné sur plusieurs questionTypes à la fois ne s'écrase pas dans
// itemsFromSelections.
const POKEMON_ID_OFFSET = 12_000_000_000_000;
const POKEMON_SUMMARY_ID_OFFSET = 13_000_000_000_000;
const POKEMON_AUDIO_ID_OFFSET = 14_000_000_000_000;
// super-héros (superhero-api) : même piège d'id qu'avec Pokémon (id dense,
// petit entier, voir POKEMON_ID_OFFSET ci-dessus) — 2 offsets (image/
// summary), pas de 3e "audio" : cette API n'a aucune source sonore.
const SUPERHERO_ID_OFFSET = 15_000_000_000_000;
const SUPERHERO_SUMMARY_ID_OFFSET = 16_000_000_000_000;
// person:image garde son id "brut" (naturalId, éventuellement déjà offseté
// par PERSON_WIKIDATA_ID_OFFSET) — même piège que director/pokemon/superhero
// ci-dessus si person:summary partageait cet id : les deux s'écraseraient
// dans itemsFromSelections si sélectionnés ensemble.
const PERSON_SUMMARY_ID_OFFSET = 17_000_000_000_000;
// acteur (type "actor", quiz filmographie via affiches/résumés de ses
// films — voir materializeActorRow) : même id TMDb que son éventuelle
// entrée "person"/"director" (une seule ligne `person` par acteur, voir
// commentaire sur DIRECTOR_ID_OFFSET plus haut), donc même besoin d'un
// espace d'id disjoint, 2 offsets (image/summary) même principe que
// director.
const ACTOR_ID_OFFSET = 18_000_000_000_000;
const ACTOR_SUMMARY_ID_OFFSET = 19_000_000_000_000;
// en dessous, un summary est jugé trop court pour être une devinette
// exploitable (ex: "Documentaire.")
const MIN_SUMMARY_LEN = 30;
// au-delà, un summary devient trop long à lire/faire défiler dans le temps
// imparti — surtout les extraits Wikipédia (exintro), souvent bien plus
// longs qu'un summary TMDb/IGDB typique. Borne haute (et défaut) de
// maxSummaryLen, paramétrable côté client (voir /api/quiz-batch,
// /api/quiz-daily) — MIN_SUMMARY_TRUNC_LEN reste bien au-dessus de
// MIN_SUMMARY_LEN (30, seuil de REJET d'un summary trop court) pour ne pas
// laisser l'utilisateur tronquer un résumé jusqu'à le rendre inutilisable.
const MIN_SUMMARY_TRUNC_LEN = 100;
const MAX_SUMMARY_TRUNC_LEN = 1000;

function toPoolId(type, questionType, naturalId) {
  if (type === "country" && questionType === "image")
    return COUNTRY_ID_OFFSET_IMAGE + naturalId;
  if (type === "country" && questionType === "flag")
    return COUNTRY_ID_OFFSET_FLAG + naturalId;
  if (type === "country" && questionType === "leader")
    return COUNTRY_ID_OFFSET_LEADER + naturalId;
  if (type === "statesman") return COUNTRY_ID_OFFSET_STATESMAN + naturalId;
  if (type === "director" && questionType === "summary")
    return DIRECTOR_SUMMARY_ID_OFFSET + naturalId;
  if (type === "wiki_article" && questionType === "summary")
    return WIKI_ARTICLE_SUMMARY_ID_OFFSET + naturalId;
  if (type === "pokemon" && questionType === "audio")
    return POKEMON_AUDIO_ID_OFFSET + naturalId;
  if (type === "pokemon" && questionType === "summary")
    return POKEMON_SUMMARY_ID_OFFSET + naturalId;
  if (type === "pokemon") return POKEMON_ID_OFFSET + naturalId;
  if (type === "superhero" && questionType === "summary")
    return SUPERHERO_SUMMARY_ID_OFFSET + naturalId;
  if (type === "superhero") return SUPERHERO_ID_OFFSET + naturalId;
  if (type === "person" && questionType === "summary")
    return PERSON_SUMMARY_ID_OFFSET + naturalId;
  if (type === "painter") return PAINTER_ID_OFFSET + naturalId;
  if (type === "director") return DIRECTOR_ID_OFFSET + naturalId;
  if (type === "actor" && questionType === "summary")
    return ACTOR_SUMMARY_ID_OFFSET + naturalId;
  if (type === "actor") return ACTOR_ID_OFFSET + naturalId;
  if (type === "wiki_article") return WIKI_ARTICLE_ID_OFFSET + naturalId;
  if (questionType === "summary") return SUMMARY_ID_OFFSET[type] + naturalId;
  return naturalId;
}

// ---------- matérialisation : SQLite -> pool de quiz ----------
//
// chaque materialize*Row(s) prend les lignes déjà filtrées (voir
// TYPES[type].getPool) et ne garde QUE le questionType demandé — un même
// type peut être sollicité plusieurs fois (movie:image et movie:summary)
// avec des filtres différents, voir materializeSelection.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// un summary reprend rarement le titre EXACT tel qu'affiché ailleurs : il
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
  // noms propres isolés (mot commençant par une majuscule) : un titre
  // composé ("Grizzly de Californie") mentionne souvent l'un de ses
  // composants seul plus loin dans le texte ("...présent en Californie...")
  // sans jamais répéter le titre complet — les préfixes ci-dessus ne
  // couvrent que le DÉBUT du titre, pas un mot isolé en milieu/fin.
  for (const word of words) {
    // ponctuation collée par le split sur les espaces ("Wiggle!", "Steady,")
    // : à retirer avant de tester la variante, sinon elle n'a aucune chance
    // de matcher le mot tel qu'il apparaît (sans cette ponctuation) ailleurs.
    const clean = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (/^[A-ZÀ-ÖØ-Þ]/.test(clean) && clean.length >= TITLE_VARIANT_MIN_LEN) {
      variants.add(clean);
    }
  }
  // plus long d'abord : dans une alternance regex, le premier candidat qui
  // matche à une position donnée gagne — sans ce tri, un fragment court
  // ("Monster Hunter") pourrait consommer le texte avant que la variante
  // plus longue et plus précise ("Monster Hunter 4") n'ait sa chance.
  return [...variants].sort((a, b) => b.length - a.length);
}

// un summary (TMDb overview / IGDB summary) mentionne très souvent son
// propre titre en toutes lettres (ex: IGDB commence typiquement par "<Titre>
// is a ..."), ce qui rendrait la devinette triviale — on masque toute
// occurrence (insensible à la casse) du titre ou d'une de ses variantes
// probables (voir titleVariants) avant de l'exposer, sous "[titre]".
// `aliases` (wiki_article uniquement, voir materializeWikiArticleRows) :
// noms alternatifs connus du sujet (redirections Wikipédia — variantes
// d'orthographe, noms étrangers/scientifiques...) qu'un simple
// titleVariants(title) ne peut pas deviner ; masqués séparément sous
// "[alias]" (pas "[titre]", ce n'est justement pas LE titre affiché — plus
// parlant qu'un "[nom]" générique) — passe après le titre (priorité au
// titre en cas de chevauchement).
//
// `loose` (par défaut false, wiki_article uniquement — voir
// materializeWikiArticleRows/loose_redaction en base, piloté par
// "looseRedaction" par catégorie dans config.json) : par défaut, une
// variante ne matche qu'en MOT ENTIER (limites `\p{L}\p{N}` plutôt que `\b`,
// qui ignore les lettres accentuées en JS) — sans ça, une variante courte
// comme "Fort" masquerait aussi le milieu d'un mot sans rapport
// ("fortifié" -> "[titre]ifié"). `loose: true` retombe sur un simple
// sous-texte, volontairement, pour les catégories où capter un DÉRIVÉ du
// titre est plus utile que risqué (ex. Animaux : "renard" -> "renardeau"
// laisserait fuiter la réponse si on ne le masquait pas).
function redactTitle(text, title, aliases = [], loose = false) {
  if (!text || !title) return text;
  // "s?" : un pluriel simple ("Wiggle" -> "Wiggles") reste un mot entier
  // dès qu'on retombe sur une frontière ensuite — sans lui, un titre
  // singulier ne masquerait jamais sa propre forme plurielle dans le texte.
  const wrap = (pattern) =>
    loose ? pattern : `(?<![\\p{L}\\p{N}])(?:${pattern})s?(?![\\p{L}\\p{N}])`;
  const flags = loose ? "gi" : "giu";

  const titlePattern = titleVariants(title).map(escapeRegExp).join("|");
  let result = text.replace(new RegExp(wrap(titlePattern), flags), "[titre]");

  const aliasVariants = new Set();
  for (const name of aliases) {
    for (const v of titleVariants(name)) aliasVariants.add(v);
  }
  if (aliasVariants.size > 0) {
    const aliasPattern = [...aliasVariants]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|");
    result = result.replace(new RegExp(wrap(aliasPattern), flags), "[alias]");
  }
  return result;
}

// coupe au dernier mot entier avant maxLen (pas en plein milieu d'un mot) et
// marque la coupe par une ellipse — appelé après redactTitle, pas avant :
// éviter de trancher pile sur "[titre]". `maxLen` par défaut à
// MAX_SUMMARY_TRUNC_LEN (borne haute), sinon fourni par l'appelant à partir
// de maxSummaryLen (voir /api/quiz-batch, /api/quiz-daily).
function truncateOverview(text, maxLen = MAX_SUMMARY_TRUNC_LEN) {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

// movie/tv se matérialisent pareil (poster TMDb + question bonus "summary"
// si l'overview est assez longue) — seule la source SQLite et le type
// changent.
function materializeMovieLikeRows(rows, type, questionType, maxSummaryLen) {
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
    } else if (questionType === "summary") {
      const overview = truncateOverview(
        redactTitle((item.overview || "").trim(), item.title),
        maxSummaryLen,
      );
      if (overview.length >= MIN_SUMMARY_LEN) {
        result.push({
          id: toPoolId(type, "summary", item.id),
          title: item.title,
          overview,
          type,
          questionType: "summary",
          posterUrl,
          ...(item.reason ? { reason: item.reason } : {}),
          ...(item.isAnniversary ? { isAnniversary: true } : {}),
        });
      }
    }
  }
  return result;
}

function materializeGameRows(rows, questionType, maxSummaryLen) {
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
    } else if (questionType === "summary") {
      const summary = truncateOverview(
        redactTitle((g.summary || "").trim(), g.title),
        maxSummaryLen,
      );
      if (summary.length >= MIN_SUMMARY_LEN) {
        result.push({
          id: toPoolId("game", "summary", g.id),
          title: g.title,
          overview: summary,
          type: "game",
          questionType: "summary",
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
    } else if (questionType === "map" && c.capital) {
      result.push({
        id: toPoolId("country", "map", c.ccn3),
        title: c.title,
        capital: c.capital,
        type: "country",
        questionType: "map",
        posterUrl: flagUrl, // écran réponse, identique à "flag"
        // pays absent du fond de carte vectoriel côté client (petits
        // territoires non couverts à la résolution 110m) : exclu là-bas,
        // même principe qu'une image introuvable — voir preload.js.
        countryCcn3: c.ccn3,
      });
    } else if (questionType === "leader" && c.leader_name && c.leader_portrait_url) {
      // indice = portrait + nom du chef d'État, réponse à deviner = le PAYS
      // — voir fetchAndStoreCountryLeader (refresh/wikipedia.js) pour
      // comment leader_name/leader_portrait_url sont alimentés. Comme
      // flag/map : un seul portrait fixe (pas de cycle d'images), traité
      // par sa propre scène côté client (drawLeaderGuess/drawLeaderReveal),
      // pas par le pipeline générique imageUrls/backdrops. Écran réponse
      // "classique pays" : le drapeau (flagUrl), pas le portrait — celui-ci
      // ne réapparaît qu'en devinette.
      result.push({
        id: toPoolId("country", "leader", c.ccn3),
        title: c.title,
        leaderName: c.leader_name,
        type: "country",
        questionType: "leader",
        posterUrl: c.leader_portrait_url,
        flagUrl,
      });
    }
  }
  return result;
}

// type top-level à part entière (pas un questionType de "country") : on y
// DEVINE un chef d'État (une personne), pas un pays — même principe que
// "director"/"actor" qui sont leurs propres types bien qu'ils tirent leurs
// lignes de la table `person`. Ici la source est `country` (1:1 avec son
// chef d'État actuel, voir fetchAndStoreCountryLeader), pas de pool dédié :
// TYPES.statesman réutilise getCountryPool tel quel (mêmes filtres
// géographie/région que "country").
function materializeStatesmanRows(rows) {
  const result = [];
  for (const c of rows) {
    if (!c.leader_name || !c.leader_portrait_url) continue;
    const flagUrl = `https://flagcdn.com/w320/${c.cca2.toLowerCase()}.png`;
    // indice = drapeau + nom du pays (nom réglable côté client), réponse à
    // deviner = le chef d'État. Reveal : portrait + intitulé du poste
    // (leader_title, absent pour certains pays — voir countryLeaderFromDump
    // — affiché seulement si présent, pas de repli).
    result.push({
      id: toPoolId("statesman", "statesman", c.ccn3),
      title: c.leader_name,
      leaderTitle: c.leader_title,
      countryName: c.title,
      type: "statesman",
      questionType: "statesman",
      posterUrl: flagUrl,
      leaderPortraitUrl: c.leader_portrait_url,
    });
  }
  return result;
}

// person:summary lit person.summary, rempli soit par Wikidata (résumé
// Wikipédia FR d'un rôle "person" — politicien/athlete, voir
// fetchPersonRoleEntities), soit par TMDb (biography, voir
// fetchAndStorePersonDetails) pour un acteur/réalisateur —
// un peintre (source wikidata, rôle "painter") n'a jamais de summary, comme
// un acteur dont TMDb n'a pas de biographie : filtré comme n'importe quel
// summary trop court (MIN_SUMMARY_LEN).
// le nom du groupe "role" (table `filter`) est une catégorie générique
// partagée par tout le monde (sert aussi de libellé de case à cocher côté
// filtres) et reste donc toujours à la forme masculine — seul l'affichage
// PAR PERSONNE au reveal (roleLabel, voir personSubtitle) doit s'accorder
// au genre de cette personne (p.gender, TMDb ou Wikidata). Formes invariantes
// en français (Peintre, Scientifique, Astronaute...) n'ont pas besoin
// d'entrée ici et retombent sur le nom masculin tel quel.
const FEMALE_ROLE_LABELS = {
  Acteur: "Actrice",
  Réalisateur: "Réalisatrice",
  Politicien: "Politicienne",
  Sportif: "Sportive",
  Écrivain: "Écrivaine",
  Chanteur: "Chanteuse",
};

function genderRoleLabel(name, gender) {
  return gender === "female" ? (FEMALE_ROLE_LABELS[name] ?? name) : name;
}

function materializePersonRows(rows, questionType, maxSummaryLen) {
  // libellés du groupe "role" (Acteur/Réalisateur/Peintre/Politicien/...),
  // affichés au reveal (voir drawReveal/personSubtitle côté client) — batch
  // sur tout `rows` plutôt qu'un getEntityFilters par ligne (N+1) ; nommé
  // `roleLabel` pour ne pas entrer en collision avec `p.role` (le CODE de
  // rôle unique posé par getPersonsByBirthMonthDay pour le bucketing du quiz
  // du jour, voir dailyAnniversaryPicks).
  const roleNames = db.getEntityFilterNamesBatch(
    "person",
    rows.map((p) => p.id),
    "role",
  );
  const result = [];
  for (const p of rows) {
    // acteur/réalisateur (source tmdb) : external_id est déjà l'id TMDb
    // numérique, utilisé tel quel. Peintre (source wikidata, rôle "painter") :
    // external_id est un QID ("Q123") — on retire le "Q" et on offset pour
    // rester dans un espace d'id disjoint des vrais id TMDb.
    const naturalId =
      p.source === "wikidata"
        ? PERSON_WIKIDATA_ID_OFFSET + Number(p.external_id.slice(1))
        : Number(p.external_id);
    // poste occupé (P39, ex. rôle "politicien") / métier précis (P106, hors
    // classe générique du rôle, ex. "joueur de tennis" pour un "athlète") /
    // nationalité (démonyme FR, TMDb comme Wikidata) / libellés de rôle
    // joints (ex. "Acteur, Réalisateur") — affichés "si présents" au reveal,
    // voir drawReveal/personSubtitle côté client. positionHeld/
    // specificOccupation restent toujours absents pour un acteur/réalisateur
    // (source tmdb), qui n'ont jamais ces deux colonnes.
    const revealFields = {
      ...(p.position_held ? { positionHeld: p.position_held } : {}),
      ...(p.specific_occupation
        ? { specificOccupation: p.specific_occupation }
        : {}),
      ...(p.nationality ? { nationality: p.nationality } : {}),
      ...(roleNames.get(p.id)?.length
        ? {
            roleLabel: roleNames
              .get(p.id)
              .map((name) => genderRoleLabel(name, p.gender))
              .join(", "),
          }
        : {}),
    };
    if (questionType === "image") {
      result.push({
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
        ...revealFields,
        // code du groupe "role" (acteur/réalisateur/peintre/politicien/...) —
        // présent seulement quand la row vient de getPersonsByBirthMonthDay
        // (getPersonPool ne le sélectionne pas ailleurs), sert de clé de
        // bucket à dailyAnniversaryPicks pour retenir 1 anniversaire par rôle.
        ...(p.role ? { role: p.role } : {}),
      });
    } else if (questionType === "summary") {
      const overview = truncateOverview(
        redactTitle((p.summary || "").trim(), p.name),
        maxSummaryLen,
      );
      if (overview.length >= MIN_SUMMARY_LEN) {
        result.push({
          id: toPoolId("person", "summary", naturalId),
          title: p.name,
          overview,
          type: "person",
          questionType: "summary",
          posterUrl: p.profile_image_url || p.portrait_image_url,
          personId: p.id,
          ...(p.reason ? { reason: p.reason } : {}),
          ...(p.isAnniversary ? { isAnniversary: true } : {}),
          ...revealFields,
          ...(p.role ? { role: p.role } : {}),
        });
      }
    }
  }
  return result;
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

// article Wikipédia : même mécanique summary que movie/game (redactTitle +
// MIN_SUMMARY_LEN), plus un questionType "image" (backdrops = images de
// l'article, voir getBackdropsForItem) — les deux modes exigent une vignette
// (thumbnail_url), seule image disponible pour l'écran de réponse.
// `wikiArticleId` (id brut, pas offseté) ne sert qu'au mode "image" (lookup
// dans getBackdropsForItem, même principe que `personId` pour painter/
// director) : absent du mode "summary", qui n'appelle jamais
// getBackdropsForItem et dont l'objet traverse selectItemsWithBackdrops tel
// quel (pas de ré-emballage "allowlist" comme pour le mode "image", voir
// selectItemsWithBackdrops) — le garder aurait fuité un champ interne dans
// la réponse client.
function materializeWikiArticleRows(rows, questionType, maxSummaryLen) {
  const result = [];
  for (const item of rows) {
    if (!item.thumbnail_url) continue;
    if (questionType === "image") {
      result.push({
        id: toPoolId("wiki_article", "image", item.id),
        title: item.title,
        type: "wiki_article",
        questionType: "image",
        posterUrl: item.thumbnail_url,
        wikiArticleId: item.id,
        ...(item.reason ? { reason: item.reason } : {}),
        ...(item.isAnniversary ? { isAnniversary: true } : {}),
      });
    } else if (questionType === "summary") {
      let aliases;
      try {
        aliases = JSON.parse(item.aliases || "[]");
      } catch {
        aliases = [];
      }
      const overview = truncateOverview(
        redactTitle(
          (item.extract || "").trim(),
          item.title,
          aliases,
          !!item.loose_redaction,
        ),
        maxSummaryLen,
      );
      if (overview.length >= MIN_SUMMARY_LEN) {
        result.push({
          id: toPoolId("wiki_article", "summary", item.id),
          title: item.title,
          overview,
          type: "wiki_article",
          questionType: "summary",
          posterUrl: item.thumbnail_url,
          ...(item.reason ? { reason: item.reason } : {}),
          ...(item.isAnniversary ? { isAnniversary: true } : {}),
        });
      }
    }
  }
  return result;
}

// pokémon (PokeAPI, voir db/refresh/pokeapi.js) : 3 questionTypes, tous
// tirés du même sprite/résumé/cri déjà connus au moment du fetch (pas de
// warmLoop) — "audio" (cri) exige cry_url, absent pour quelques espèces
// sans cri connu côté PokeAPI, comme "flag" exige c.capital pour un pays.
function materializePokemonRows(rows, questionType, maxSummaryLen) {
  const result = [];
  for (const p of rows) {
    if (questionType === "image") {
      result.push({
        id: toPoolId("pokemon", "image", p.id),
        title: p.name,
        type: "pokemon",
        questionType: "image",
        posterUrl: p.sprite_url,
      });
    } else if (questionType === "summary") {
      const overview = truncateOverview(
        redactTitle((p.summary || "").trim(), p.name),
        maxSummaryLen,
      );
      if (overview.length >= MIN_SUMMARY_LEN) {
        result.push({
          id: toPoolId("pokemon", "summary", p.id),
          title: p.name,
          overview,
          type: "pokemon",
          questionType: "summary",
          posterUrl: p.sprite_url,
        });
      }
    } else if (questionType === "audio" && p.cry_url) {
      result.push({
        id: toPoolId("pokemon", "audio", p.id),
        title: p.name,
        type: "pokemon",
        questionType: "audio",
        previewUrl: p.cry_url,
        posterUrl: p.sprite_url,
      });
    }
  }
  return result;
}

// super-héros (superhero-api, voir db/refresh/superhero.js) : 2
// questionTypes, portrait + bio de synthèse déjà construits au moment du
// fetch (pas de warmLoop, même cas que "pokemon"/"music" ci-dessus) —
// aliases (vrai nom, alter-ego) masqués du summary comme pour wiki_article,
// pas de mode "audio" (aucune source sonore dans cette API).
function materializeSuperheroRows(rows, questionType, maxSummaryLen) {
  const result = [];
  for (const h of rows) {
    if (questionType === "image") {
      result.push({
        id: toPoolId("superhero", "image", h.id),
        title: h.name,
        type: "superhero",
        questionType: "image",
        posterUrl: h.image_url,
      });
    } else if (questionType === "summary") {
      let aliases;
      try {
        aliases = JSON.parse(h.aliases || "[]");
      } catch {
        aliases = [];
      }
      const overview = truncateOverview(
        redactTitle((h.summary || "").trim(), h.name, aliases),
        maxSummaryLen,
      );
      if (overview.length >= MIN_SUMMARY_LEN) {
        result.push({
          id: toPoolId("superhero", "summary", h.id),
          title: h.name,
          overview,
          type: "superhero",
          questionType: "summary",
          posterUrl: h.image_url,
        });
      }
    }
  }
  return result;
}

function materializeDirectorRow(p, questionType) {
  // source toujours "tmdb" (crédits de réalisation, voir refresh.js) :
  // external_id est déjà l'id TMDb numérique, pas de préfixe à retirer
  // (contrairement aux peintres, source wikidata).
  return {
    id: toPoolId("director", questionType, Number(p.external_id)),
    title: p.name,
    type: "director",
    questionType,
    // photo du réalisateur, révélée à l'écran de réponse — les images/
    // summary de devinette viennent de ses films (voir
    // selectItemsWithBackdrops), pas cette photo.
    posterUrl: p.profile_image_url,
    personId: p.id,
  };
}

// mirror exact de materializeDirectorRow ci-dessus, pour le quiz "acteur"
// (deviner le nom à partir des affiches/résumés des films où il a joué —
// voir movie_cast/getActorMoviePosters) : source toujours "tmdb" (casting,
// voir fetchAndStoreMovieCredits/fetchAndStoreFilmography), pas de peintre
// possible ici contrairement à "person".
function materializeActorRow(p, questionType) {
  return {
    id: toPoolId("actor", questionType, Number(p.external_id)),
    title: p.name,
    type: "actor",
    questionType,
    // photo de l'acteur, révélée à l'écran de réponse — les images/summary
    // de devinette viennent de ses films (voir selectItemsWithBackdrops),
    // pas cette photo.
    posterUrl: p.profile_image_url,
    personId: p.id,
  };
}

// un type = quels questionTypes il peut produire (info structurelle fixe,
// pas dérivée des données — voir /api/catalog), comment lire son pool filtré
// (db.getXPool(filters), voir db/typeItem.js) et comment matérialiser ce pool en
// items de quiz pour UN questionType donné. Toute la logique d'ingestion
// (fetch entités, warmLoops, filtres) vit dans db/refresh.js — ce process ne
// fait plus que lire. `game` reste toujours présent : si IGDB n'est pas
// configuré côté refresh.js, le pool est simplement vide.
const TYPES = {
  movie: {
    questionTypes: ["image", "summary"],
    getPool: db.getMoviePool,
    materialize: (rows, questionType, maxSummaryLen) =>
      materializeMovieLikeRows(rows, "movie", questionType, maxSummaryLen),
  },
  tv: {
    questionTypes: ["image", "summary"],
    getPool: db.getTvShowPool,
    materialize: (rows, questionType, maxSummaryLen) =>
      materializeMovieLikeRows(rows, "tv", questionType, maxSummaryLen),
  },
  person: {
    questionTypes: ["image", "summary"],
    getPool: db.getPersonPool,
    materialize: (rows, questionType, maxSummaryLen) =>
      materializePersonRows(rows, questionType, maxSummaryLen),
  },
  game: {
    questionTypes: ["image", "summary"],
    getPool: db.getGamePool,
    materialize: (rows, questionType, maxSummaryLen) =>
      materializeGameRows(rows, questionType, maxSummaryLen),
  },
  music: {
    questionTypes: ["audio"],
    getPool: db.getMusicTrackPool,
    materialize: (rows) => rows.map(materializeMusicTrackRow),
  },
  country: {
    questionTypes: ["image", "flag", "map", "leader"],
    getPool: db.getCountryPool,
    materialize: (rows, questionType) =>
      materializeCountryRows(rows, questionType),
  },
  // sens inverse de country:leader — on y devine un CHEF D'ÉTAT (une
  // personne), pas un pays, d'où un type à part plutôt qu'un questionType
  // de "country" (voir materializeStatesmanRows). Réutilise getCountryPool
  // tel quel : pas de pool propre, une ligne country EST son chef d'État
  // actuel (1:1, voir fetchAndStoreCountryLeader).
  statesman: {
    questionTypes: ["statesman"],
    getPool: db.getCountryPool,
    materialize: (rows) => materializeStatesmanRows(rows),
  },
  painter: {
    questionTypes: ["image"],
    // seuil d'œuvres appliqué ICI et pas dans le pool lui-même : le warmLoop
    // qui récupère les tableaux a besoin de voir tous les peintres, y compris
    // ceux qui n'en ont pas encore (voir PAINTER_MIN_ARTWORKS).
    getPool: (selections) =>
      db.getPainterPool(selections, db.PAINTER_MIN_ARTWORKS),
    materialize: (rows) => rows.map(materializePainterRow),
  },
  director: {
    questionTypes: ["image", "summary"],
    getPool: db.getDirectorPool,
    materialize: (rows, questionType) =>
      rows.map((p) => materializeDirectorRow(p, questionType)),
  },
  actor: {
    questionTypes: ["image", "summary"],
    getPool: db.getActorPool,
    materialize: (rows, questionType) =>
      rows.map((p) => materializeActorRow(p, questionType)),
  },
  wiki_article: {
    questionTypes: ["image", "summary"],
    getPool: db.getWikiArticlePool,
    materialize: (rows, questionType, maxSummaryLen) =>
      materializeWikiArticleRows(rows, questionType, maxSummaryLen),
  },
  pokemon: {
    questionTypes: ["image", "summary", "audio"],
    getPool: db.getPokemonPool,
    materialize: (rows, questionType, maxSummaryLen) =>
      materializePokemonRows(rows, questionType, maxSummaryLen),
  },
  superhero: {
    questionTypes: ["image", "summary"],
    getPool: db.getSuperheroPool,
    materialize: (rows, questionType, maxSummaryLen) =>
      materializeSuperheroRows(rows, questionType, maxSummaryLen),
  },
};

function hasAnyPool() {
  return Object.keys(TYPES).some((t) => db.countTypeItems(t) > 0);
}

// LED de statut /api/stats.ready : c'est ça qu'on annonce au client — "la
// base est chauffée" (nom aligné sur le vocabulaire warmLoop/chauffage de
// refresh.js), pas "les warmLoops sont ready" (détail d'implémentation).
// Ne couvre que les warmLoops "bloquants" (peintures, photos pays, images
// d'articles Wikipédia) sont-ils à jour pour tout ce qui est actuellement
// dans le pool ? Le pool "director" se remplit progressivement au fil du
// même warmLoop réalisateurs (jamais bloquant côté refresh.js) — un pool
// encore vide se traduit juste par un /api/pool-size à 0 pour ce type, déjà
// géré normalement côté client (comme n'importe quelle combinaison de
// filtres sans résultat), donc pas besoin de le vérifier ici non plus.
function isDbWarmed() {
  if (db.anyPainterArtworkStale()) return false;
  if (pexelsEnabled && db.anyCountryPhotosStale()) return false;
  if (db.anyWikiArticleImagesStale()) return false;
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
// différents (ex. movie:image en "Populaire" et movie:summary en
// "Années 1990"), c'est tout l'intérêt de ce découpage par entrée plutôt que
// par type brut.
function materializeSelection({ type, questionType, filters }, maxSummaryLen) {
  const cfg = TYPES[type];
  if (!cfg) throw new Error(`type inconnu: "${type}"`);
  if (!cfg.questionTypes.includes(questionType))
    throw new Error(`questionType "${questionType}" invalide pour "${type}"`);
  return cfg.materialize(cfg.getPool(filters), questionType, maxSummaryLen);
}

// assemble le pool candidat depuis les sélections du client — dédupliqué par
// id (une même entité peut ressortir de plusieurs sélections, ex. filtres
// qui se recoupent) ; matérialisée depuis SQLite à chaque appel (pas de pool
// en mémoire — la DB est la seule source de vérité, tenue à jour par
// refresh.js en parallèle).
function itemsFromSelections(selections, maxSummaryLen) {
  const merged = new Map();
  for (const selection of selections) {
    for (const item of materializeSelection(selection, maxSummaryLen))
      merged.set(item.id, item);
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
// `selections[]` demandées — ex. "movie:image" et "movie:summary" sont deux
// buckets même si même type), comble les manques en piochant ailleurs pour
// quand même atteindre `count`. `shuffleFn` (défaut : `shuffle` non-seedé)
// permet au quiz du jour de passer un mélange seedé par la date (voir
// /api/quiz-daily) sans dupliquer cette répartition par bucket.
function stratifiedSelection(
  pool,
  selectionKeys,
  count,
  excludeIds,
  shuffleFn = shuffle,
) {
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
  } else if (item.type === "director" || item.type === "actor") {
    // affiches des films réalisés/joués (pas son portrait — même logique que
    // "painter" ci-dessus) ; aspect_ratio d'affiche (~2:3), volontairement
    // hors de la plage "standard" 16:9 pour ne jamais être écarté par le
    // filtre isStandardRatio plus bas. `title` (extra, ignoré des autres
    // types) survit jusqu'au client via selectItemsWithBackdrops : un
    // poster n'affiche pas toujours son titre de façon lisible.
    const posters =
      item.type === "director"
        ? db.getDirectorMoviePosters(item.personId)
        : db.getActorMoviePosters(item.personId);
    backdrops = posters.map((m) => ({
      url: `https://image.tmdb.org/t/p/w500${m.posterPath}`,
      title: m.title,
      vote_count: 1,
      aspect_ratio: 2 / 3,
    }));
  } else if (item.type === "pokemon") {
    // un seul sprite officiel connu par espèce (pas de table multi-images
    // comme movie/tv/game, voir db/pokemon.js) — une seule "backdrop", le
    // mode image ne cycle donc jamais plusieurs plans pour ce type,
    // contrairement à movie/tv/game (imagesPerItem n'a pas d'effet ici).
    backdrops = item.posterUrl
      ? [{ url: item.posterUrl, vote_count: 1, aspect_ratio: 1 }]
      : [];
  } else if (item.type === "superhero") {
    // un seul portrait connu par personnage (pas de table multi-images comme
    // movie/tv/game) — même cas que "pokemon" ci-dessus. Ratio 3:4 réel des
    // images superhero-api (480x640), hors de la plage "standard" 16:9 : la
    // bascule ratioPool plus bas (standardRatio.length === 0) retombe donc
    // automatiquement sur ce portrait sans qu'il faille lister "superhero"
    // dans l'exception explicite juste en dessous.
    backdrops = item.posterUrl
      ? [{ url: item.posterUrl, vote_count: 1, aspect_ratio: 3 / 4 }]
      : [];
  } else if (item.type === "wiki_article") {
    // images embarquées dans l'article, chauffées en tâche de fond (voir
    // fetchAndStoreWikiArticleImagesBatch) — ratios très variables (portrait,
    // carte, objet...), voir isStandardRatio ci-dessous.
    backdrops = db.getWikiArticleImages(item.wikiArticleId).map((img) => ({
      url: img.url,
      vote_count: img.vote_count,
      aspect_ratio: img.aspect_ratio,
    }));
  } else {
    backdrops = [];
  }

  if (backdrops.length === 0) return [];

  const isStandardRatio = (b) =>
    b.aspect_ratio >= 1.7 && b.aspect_ratio <= 1.85;
  const standardRatio = backdrops.filter(isStandardRatio);
  // "person"/"wiki_article" : photos à ratio libre (portraits, cartes,
  // objets...), contrairement aux backdrops de film (quasi tous 16:9) — un
  // filtre "ratio standard" écarterait à tort la plupart d'entre elles.
  const ratioPool =
    item.type === "person" ||
    item.type === "wiki_article" ||
    standardRatio.length === 0
      ? backdrops
      : standardRatio;

  const voted = ratioPool.filter((b) => b.vote_count > 0);
  const finalPool =
    voted.length >= Math.min(need, ratioPool.length) ? voted : ratioPool;

  // objets bruts (pas juste l'url) : "director" y accroche aussi `title`,
  // voir l'appelant (selectItemsWithBackdrops). Pas de répétition quand le
  // pool est plus petit que `need` (même principe que director:summary
  // ci-dessous) : le nombre de frames s'adapte à ce qui existe vraiment
  // pour cet item plutôt que de remontrer une image déjà vue.
  return pickFromPool(finalPool, Math.min(need, finalPool.length));
}

async function selectItemsWithBackdrops(
  candidatesShuffled,
  count,
  imagesPerItem,
  summaryPerItem,
  maxSummaryLen,
) {
  const result = [];
  let excludedCount = 0;
  let idx = 0;
  const batchSize = Math.max(count, 20);
  while (result.length < count && idx < candidatesShuffled.length) {
    const batch = candidatesShuffled.slice(idx, idx + batchSize);
    idx += batchSize;
    // seul questionType "image" a besoin de backdrops (et director:summary
    // de summary de films, cas à part ci-dessous) — pour les autres
    // (movie/tv/game:summary, flag, audio), `m` EST déjà la forme finale
    // attendue par le client : elle vient telle quelle de
    // materializeMovieLikeRows/materializeCountryRows/materializeMusicTrackRow
    // (voir TYPES), pas besoin de la reconstruire ici.
    const withImages = await mapWithConcurrency(
      batch,
      IMAGE_FETCH_CONCURRENCY,
      async (m) => {
        if (
          (m.type === "director" || m.type === "actor") &&
          m.questionType === "summary"
        ) {
          // summary de plusieurs films réalisés/joués, cyclés comme frames
          // côté client (comme les affiches du mode "image") — on masque le
          // nom DU RÉALISATEUR/DE L'ACTEUR (pas un titre de film,
          // contrairement à materializeMovieLikeRows/materializeGameRows)
          // puisque c'est lui la réponse à deviner ici.
          const summaries = (
            m.type === "director"
              ? db.getDirectorMovieSummaries(m.personId)
              : db.getActorMovieSummaries(m.personId)
          )
            .map((s) => ({
              title: s.title,
              overview: truncateOverview(
                redactTitle((s.overview || "").trim(), m.title),
                maxSummaryLen,
              ),
            }))
            .filter((s) => s.overview.length >= MIN_SUMMARY_LEN);
          if (summaries.length === 0) return null;
          // pas de répétition ici (contrairement aux affiches, voir
          // getBackdropsForItem) : revoir deux fois le MÊME paragraphe est
          // bien plus visible/gênant qu'une affiche répétée — on plafonne
          // plutôt le nombre de frames à ce que ce réalisateur a vraiment.
          const picked = pickFromPool(
            summaries,
            Math.min(summaryPerItem, summaries.length),
          );
          return {
            id: m.id,
            title: m.title,
            posterUrl: m.posterUrl,
            type: m.type,
            questionType: m.questionType,
            overviews: picked.map((s) => s.overview),
            movieTitles: picked.map((s) => s.title),
            ...(m.reason ? { reason: m.reason } : {}),
            ...(m.isAnniversary ? { isAnniversary: true } : {}),
          };
        }
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
          ...(m.type === "director" || m.type === "actor"
            ? { imageTitles: backdrops.map((b) => b.title || null) }
            : {}),
          ...(director ? { director } : {}),
          // reveal "person" (voir materializePersonRows/personSubtitle côté
          // client) : `undefined` sur tout autre type, donc no-op ailleurs.
          ...(m.positionHeld ? { positionHeld: m.positionHeld } : {}),
          ...(m.specificOccupation
            ? { specificOccupation: m.specificOccupation }
            : {}),
          ...(m.nationality ? { nationality: m.nationality } : {}),
          ...(m.roleLabel ? { roleLabel: m.roleLabel } : {}),
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
      // "statesman" réutilise getCountryPool tel quel (voir TYPES ci-dessus),
      // donc ses filtres exploitables sont ceux stockés sous type="country",
      // pas sous "statesman" (qui n'a jamais aucune ligne dans `filter`).
      filters: db.getFiltersForType(type === "statesman" ? "country" : type),
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
// materializePersonRows, seul mode qui le peuple) qui explique au client
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
function dailyListPicks(rng, maxSummaryLen) {
  const picked = [];
  for (const [type, codes] of Object.entries(DAILY_TRENDING_CODES)) {
    const cfg = TYPES[type];
    for (const code of codes) {
      const label = db.getFilterLabel(type, "liste", code) || code;
      const rows = cfg.getPool({ liste: [code] });
      if (rows.length === 0) continue;
      for (const row of rows) row.reason = label;
      // certains questionTypes peuvent ne rien donner (ex. "summary" si
      // aucun overview assez long dans ce tirage) — on essaie les
      // questionTypes dans un ordre aléatoire jusqu'à en trouver un qui
      // matérialise au moins un item, plutôt que de se limiter au premier.
      let item = null;
      for (const questionType of seededShuffle(cfg.questionTypes, rng)) {
        const materialized = cfg.materialize(rows, questionType, maxSummaryLen);
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

function dailyMovieAnniversaryBucket(month, day, maxSummaryLen) {
  const rows = db.getMoviesByReleaseMonthDay(month, day);
  for (const row of rows) {
    const year = String(row.release_date).slice(0, 4);
    row.reason = `Sorti ${yearsAgo(year)}`;
    row.isAnniversary = true;
  }
  const result = [];
  for (const questionType of TYPES.movie.questionTypes) {
    result.push(
      ...materializeMovieLikeRows(rows, "movie", questionType, maxSummaryLen),
    );
  }
  return result;
}

function dailyGameAnniversaryBucket(month, day, maxSummaryLen) {
  const rows = db.getGamesByReleaseMonthDay(month, day);
  for (const row of rows) {
    const year = String(row.release_date).slice(0, 4);
    row.reason = `Sorti ${yearsAgo(year)}`;
    row.isAnniversary = true;
  }
  const result = [];
  for (const questionType of TYPES.game.questionTypes) {
    result.push(...materializeGameRows(rows, questionType, maxSummaryLen));
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

function dailyPersonAnniversaryBucket(month, day, maxSummaryLen) {
  // type "person" (voir TYPES) couvre déjà acteurs/réalisateurs/peintres
  // (rôle multi-valué, voir refresh.js fetchPainterEntities) — pas besoin
  // d'interroger séparément les pools "director"/"painter" en plus. Chaque
  // row porte son code de rôle (`role`, voir getPersonsByBirthMonthDay), une
  // personne multi-rôle ressortant une fois par rôle — propagé par
  // materializePersonRows jusque dans le bucket key de dailyAnniversaryPicks,
  // pour 1 anniversaire retenu PAR RÔLE plutôt qu'un seul toutes personnes
  // confondues.
  const rows = db.getPersonsByBirthMonthDay("person", month, day);
  for (const row of rows) {
    const year = String(row.birthday).slice(0, 4);
    row.reason = `Né(e) ${yearsAgo(year)}`;
    row.isAnniversary = true;
  }
  const result = [];
  for (const questionType of TYPES.person.questionTypes) {
    result.push(...materializePersonRows(rows, questionType, maxSummaryLen));
  }
  return result;
}

// article Wikipédia "histoire" (bataille/guerre) avec une date d'événement
// connue au jour près — voir fetchEventDates/storeWikiArticleEventDates dans
// refresh/wikipedia.js. Pas de rôle (contrairement à person), un seul bucket
// par questionType suffit.
function dailyWikiArticleAnniversaryBucket(month, day, maxSummaryLen) {
  const rows = db.getWikiArticlesByEventMonthDay(month, day);
  for (const row of rows) {
    const year = String(row.event_date).slice(0, 4);
    row.reason = `Survenu ${yearsAgo(year)}`;
    row.isAnniversary = true;
  }
  const result = [];
  for (const questionType of TYPES.wiki_article.questionTypes) {
    result.push(
      ...materializeWikiArticleRows(rows, questionType, maxSummaryLen),
    );
  }
  return result;
}

// 1 item par bucket type:questionType (type:questionType:role pour "person",
// voir plus bas) parmi les 5 sources anniversaire — contrairement à
// dailyListPicks (1 par liste, questionType au hasard), un anniversaire veut
// représenter CHAQUE questionType qu'il peut produire (ex. movie:image ET
// movie:summary séparément, si les deux ont un item ce jour-là), pas un seul
// tiré au hasard parmi eux.
function dailyAnniversaryPicks(month, day, rng, maxSummaryLen) {
  const pool = [
    ...dailyMovieAnniversaryBucket(month, day, maxSummaryLen),
    ...dailyGameAnniversaryBucket(month, day, maxSummaryLen),
    ...dailyMusicAnniversaryBucket(month, day),
    ...dailyPersonAnniversaryBucket(month, day, maxSummaryLen),
    ...dailyWikiArticleAnniversaryBucket(month, day, maxSummaryLen),
  ];
  const byBucket = new Map();
  for (const m of pool) {
    // "person" ajoute le rôle (acteur/réalisateur/peintre/...) à la clé — un
    // acteur et un peintre nés le même jour doivent chacun avoir leur chance,
    // pas rivaliser dans le même bucket "person:image" (voir
    // dailyPersonAnniversaryBucket). Les 4 autres sources n'ont pas de rôle,
    // `m.role` y est toujours undefined donc la clé reste inchangée pour elles.
    const key = m.role
      ? `${m.type}:${m.questionType}:${m.role}`
      : `${m.type}:${m.questionType}`;
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(m);
  }
  // un même film/jeu peut avoir à la fois du contenu movie:image ET
  // movie:summary ce jour-là (voir commentaire ci-dessus) — mais s'il n'y a
  // QU'UN SEUL film en anniversaire, les deux buckets retomberaient sinon
  // sur ce même film, affiché deux fois dans le quiz (une par
  // questionType). On exclut donc, bucket après bucket, les entités déjà
  // retenues ailleurs ; si plus aucun candidat inédit n'existe pour un
  // bucket, on le laisse simplement vide (même logique que "moins de
  // contenu = quiz plus court" plutôt que de dupliquer une entité).
  const usedEntities = new Set();
  const picked = [];
  for (const items of byBucket.values()) {
    const pick = seededShuffle(items, rng).find(
      (m) => !usedEntities.has(`${m.type}:${m.title}`),
    );
    if (!pick) continue;
    usedEntities.add(`${pick.type}:${pick.title}`);
    picked.push(pick);
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

  // lu avant de construire `picked` : dailyAnniversaryPicks/dailyListPicks
  // matérialisent déjà les summary (troncature), donc ont besoin de
  // maxSummaryLen dès cet appel.
  const body = req.body || {};
  const imagesPerItem = Math.min(
    MAX_IMAGES_PER_ITEM,
    Math.max(MIN_IMAGES_PER_ITEM, parseInt(body.imagesPerItem, 10) || 1),
  );
  const summaryPerItem = Math.min(
    MAX_SUMMARY_PER_ITEM,
    Math.max(MIN_SUMMARY_PER_ITEM, parseInt(body.summaryPerItem, 10) || 1),
  );
  const maxSummaryLen = Math.min(
    MAX_SUMMARY_TRUNC_LEN,
    Math.max(
      MIN_SUMMARY_TRUNC_LEN,
      parseInt(body.maxSummaryLen, 10) || MAX_SUMMARY_TRUNC_LEN,
    ),
  );

  // taille figée par construction, pas un total configurable réparti ensuite :
  // 1 item par bucket type:questionType d'anniversaire (movie:image ET
  // movie:summary séparément si les deux existent, voir
  // dailyAnniversaryPicks) + 1 item par liste "actualité" du jour, tous
  // questionTypes confondus (voir dailyListPicks) — un jour avec moins de
  // contenu (pas d'anniversaire personne, une liste vide) donne simplement un
  // quiz plus court, plutôt que de repiocher ailleurs pour compenser. Mélange
  // seedé par la date (voir seededRng) pour que le choix reste stable toute
  // la journée.
  const rng = seededRng(dateKey);
  const picked = [
    ...dailyAnniversaryPicks(month, day, rng, maxSummaryLen),
    ...dailyListPicks(rng, maxSummaryLen),
  ];

  if (picked.length === 0) {
    return res.status(503).json({
      error: "Aucun contenu disponible pour le quiz du jour.",
    });
  }

  const count = picked.length;

  const { items: withImages, excludedCount } = await selectItemsWithBackdrops(
    seededShuffle(picked, rng),
    count,
    imagesPerItem,
    summaryPerItem,
    maxSummaryLen,
  );

  res.json({
    items: withImages,
    date: dateKey,
    requested: count,
    delivered: withImages.length,
    excludedCount,
    imagesPerItem,
    summaryPerItem,
    maxSummaryLen,
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

  const imagesPerItem = Math.min(
    MAX_IMAGES_PER_ITEM,
    Math.max(MIN_IMAGES_PER_ITEM, parseInt(body.imagesPerItem, 10) || 1),
  );
  const summaryPerItem = Math.min(
    MAX_SUMMARY_PER_ITEM,
    Math.max(MIN_SUMMARY_PER_ITEM, parseInt(body.summaryPerItem, 10) || 1),
  );
  const maxSummaryLen = Math.min(
    MAX_SUMMARY_TRUNC_LEN,
    Math.max(
      MIN_SUMMARY_TRUNC_LEN,
      parseInt(body.maxSummaryLen, 10) || MAX_SUMMARY_TRUNC_LEN,
    ),
  );

  let all;
  try {
    all = itemsFromSelections(selections, maxSummaryLen);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

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
    summaryPerItem,
    maxSummaryLen,
  );

  res.json({
    items: withImages,
    recycled,
    requested: count,
    delivered: withImages.length,
    excludedCount,
    imagesPerItem,
    summaryPerItem,
    maxSummaryLen,
    poolSize: all.length,
    totalGenerated: db.recordQuizGenerated(),
  });
});

app.use(express.static(path.join(process.cwd(), "public")));

app.listen(PORT, () => console.log(`Guess It sur http://localhost:${PORT}`));
