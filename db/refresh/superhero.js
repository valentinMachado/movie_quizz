import * as db from "../index.js";
import { logInfo } from "./log.js";
import {
  SUPERHERO_PUBLISHERS,
  SUPERHERO_ALIGNMENTS,
  SUPERHERO_GENDERS,
  SUPERHERO_RACES,
  SUPERHERO_ERAS,
  SUPERHERO_COUNTRIES,
} from "./config.js";

// superhero-api (akabab.github.io/superhero-api) — gratuite, sans clé,
// servie en statique (GitHub Pages + CDN jsdelivr pour les images). Tout le
// jeu de données (~560 personnages) tient dans un seul fichier all.json, pas
// de pagination ni de 2e requête par personnage (contrairement à PokeAPI).
const SUPERHERO_API_URL = "https://akabab.github.io/superhero-api/api/all.json";

function clean(v) {
  return v && v !== "-" ? v : null;
}

// pas de texte "bio" tout fait côté API (contrairement au flavor text
// PokeAPI ou à un extrait Wikipédia) : synthèse à partir des champs
// structurés biography/work/connections, en écartant les champs vides ("-").
function buildSummary(hero) {
  const bio = hero.biography || {};
  const work = hero.work || {};
  const conn = hero.connections || {};
  const parts = [];

  const alignmentLabel =
    bio.alignment === "good"
      ? "un super-héros"
      : bio.alignment === "bad"
        ? "un super-vilain"
        : bio.alignment === "neutral"
          ? "un personnage neutre"
          : null;
  if (alignmentLabel) {
    const publisher = clean(bio.publisher);
    parts.push(
      `Il s'agit de ${alignmentLabel}${publisher ? ` de l'univers ${publisher}` : ""}.`,
    );
  }

  const occupation = clean(work.occupation);
  if (occupation) parts.push(`Occupation : ${occupation}.`);

  const group = clean(conn.groupAffiliation);
  if (group) parts.push(`Affiliation(s) : ${group}.`);

  const relatives = clean(conn.relatives);
  if (relatives) parts.push(`Proches connus : ${relatives}.`);

  const firstApp = clean(bio.firstAppearance);
  if (firstApp) parts.push(`Première apparition : ${firstApp}.`);

  // \n plutôt qu'un espace : chaque section (occupation/affiliation/
  // proches/apparition) sur sa propre ligne façon fiche technique, au lieu
  // d'un paragraphe continu — voir wrapText (render/primitives.js), qui
  // respecte ces retours à la ligne comme des coupures forcées.
  return parts.join("\n");
}

// vrai nom + alter-egos connus : injectés dans `aliases` (colonne JSON, même
// mécanique que wiki_article.aliases) pour être masqués du summary au
// moment de servir la question (voir materializeSuperheroRows côté
// server.js) — sans ça, "Première apparition"/"Affiliation(s)"/"Proches
// connus" trahissent souvent le nom réel du personnage (ex: le vrai nom
// d'un héros cité parmi ses proches).
function buildAliases(hero) {
  const bio = hero.biography || {};
  const list = [
    ...(Array.isArray(bio.aliases) ? bio.aliases : []),
    bio.fullName,
  ];
  return [...new Set(list.filter((v) => v && v !== "-"))];
}

const FIRST_APPEARANCE_YEAR_RE = /\b(1[89]\d{2}|20\d{2})\b/;

// "old school"/"récent" : borné par gteYear/ltYear (config.json), même
// principe que painting.eras — l'année vient d'un texte libre du style
// "Hulk Vol 2 #2 (April, 2008) (as A-Bomb)", pas d'un champ structuré.
function findEraCode(firstAppearance) {
  const text = clean(firstAppearance);
  const m = text?.match(FIRST_APPEARANCE_YEAR_RE);
  if (!m) return null;
  const year = Number(m[1]);
  const era = SUPERHERO_ERAS.find(
    (e) =>
      (e.gteYear == null || year >= e.gteYear) &&
      (e.ltYear == null || year < e.ltYear),
  );
  return era ? era.code : null;
}

// biography.placeOfBirth est un texte libre très hétérogène (voir le
// commentaire sur SUPERHERO_COUNTRIES) : premier code dont une des
// sous-chaînes `match` apparaît dans le texte (insensible à la casse), sinon
// aucun code — même repli que race/gender pour tout ce qui ne rentre dans
// aucune case reconnue (lieu fictif non identifiable, "-").
function findGeoCode(placeOfBirth) {
  const text = clean(placeOfBirth);
  if (!text) return null;
  const lower = text.toLowerCase();
  const country = SUPERHERO_COUNTRIES.find((c) =>
    c.match.some((m) => lower.includes(m.toLowerCase())),
  );
  return country ? country.code : null;
}

// aucun vrai signal de popularité dans cette API (pas de rating_count IGDB,
// pas de pageviews Wikipédia) : proxy par richesse de la fiche — un
// personnage obscur a une fiche superhero-api à moitié vide ("-" partout),
// un personnage connu a ses champs bio/travail/relations renseignés. 7
// champs, chacun présent ou non ("-"/valeur par défaut compte comme
// absent) — mêmes champs que buildSummary/buildAliases ci-dessus, pas de
// nouveau champ inventé pour ce seul usage.
function popularityScore(hero) {
  const bio = hero.biography || {};
  const work = hero.work || {};
  const conn = hero.connections || {};
  let score = 0;
  if (clean(bio.fullName)) score++;
  if (Array.isArray(bio.aliases) && bio.aliases.some((a) => a && a !== "-")) score++;
  if (clean(bio.placeOfBirth)) score++;
  if (clean(bio.firstAppearance)) score++;
  if (clean(work.occupation)) score++;
  if (clean(conn.groupAffiliation)) score++;
  if (clean(conn.relatives)) score++;
  return score;
}

// quartiles du score ci-dessus, ajoutés au groupe "liste" déjà utilisé pour
// l'éditeur (Marvel/DC, voir fetchSuperheroEntities) — replaceEntityFilterSubset
// (pas replaceEntityFilters) est OBLIGATOIRE ici : un replace classique sur
// tout le groupe "liste" écraserait les codes marvel/dc posés juste avant
// (même piège documenté pour storePopularityTiers dans util.js, qui protège
// pokemon de la même façon). Contrairement à storeTertilePopularityTiers
// (util.js, réservé aux types où "liste" ne contient QUE ces 4 tranches),
// ce score est toujours défini (jamais null) : chaque héros reçoit
// systématiquement une tranche, pas de cas "valeur inconnue" à exclure.
const POPULARITY_TIER_CODES = ["obscur", "niche", "populaire", "star"];

function storeSuperheroPopularityTiers(rows) {
  const sorted = rows.map((r) => r.popularityScore).sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length / 4)];
  const q2 = sorted[Math.floor((sorted.length * 2) / 4)];
  const q3 = sorted[Math.floor((sorted.length * 3) / 4)];
  const tierFor = (v) =>
    v <= q1 ? "obscur" : v <= q2 ? "niche" : v <= q3 ? "populaire" : "star";

  db.upsertFilters("superhero", "liste", [
    { code: "obscur", name: "Obscur" },
    { code: "niche", name: "Niche" },
    { code: "populaire", name: "Populaire" },
    { code: "star", name: "Star" },
  ]);
  db.replaceEntityFilterSubset(
    "superhero",
    "liste",
    POPULARITY_TIER_CODES,
    rows.map((r) => ({ entityId: r.id, codes: [tierFor(r.popularityScore)] })),
  );
}

function mapHero(hero) {
  const imageUrl = hero.images?.lg || null;
  if (!imageUrl || !hero.name) return null; // aucune image exploitable, jamais un item de quiz utile

  const bio = hero.biography || {};
  const appearance = hero.appearance || {};
  const publisherEntry = Object.entries(SUPERHERO_PUBLISHERS).find(
    ([, name]) => name === bio.publisher,
  );
  const alignmentCode = SUPERHERO_ALIGNMENTS[bio.alignment] ? bio.alignment : null;
  const genderEntry = SUPERHERO_GENDERS.find((g) => g.match === appearance.gender);
  const raceEntry = SUPERHERO_RACES.find((r) => r.match === appearance.race);

  return {
    id: hero.id,
    name: hero.name,
    imageUrl,
    summary: buildSummary(hero),
    aliases: buildAliases(hero),
    publisherCode: publisherEntry ? publisherEntry[0] : null,
    alignmentCode,
    genderCode: genderEntry ? genderEntry.code : null,
    raceCode: raceEntry ? raceEntry.code : null,
    eraCode: findEraCode(bio.firstAppearance),
    geoCode: findGeoCode(bio.placeOfBirth),
    popularityScore: popularityScore(hero),
  };
}

export async function fetchSuperheroEntities() {
  const res = await fetch(SUPERHERO_API_URL, {
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`superhero-api ${res.status}`);
  const heroes = await res.json();

  const rows = heroes.map(mapHero).filter(Boolean);
  if (rows.length === 0) return;

  db.upsertSuperheroes(rows);
  db.replaceTypeItems(
    "superhero",
    rows.map((r) => r.id),
  );

  db.upsertFilters(
    "superhero",
    "liste",
    Object.entries(SUPERHERO_PUBLISHERS).map(([code, name]) => ({ code, name })),
  );
  db.replaceEntityFilters(
    "superhero",
    "liste",
    rows.map((r) => ({
      entityId: r.id,
      codes: r.publisherCode ? [r.publisherCode] : [],
    })),
  );

  db.upsertFilters(
    "superhero",
    "genre",
    Object.entries(SUPERHERO_ALIGNMENTS).map(([code, name]) => ({ code, name })),
  );
  db.replaceEntityFilters(
    "superhero",
    "genre",
    rows.map((r) => ({
      entityId: r.id,
      codes: r.alignmentCode ? [r.alignmentCode] : [],
    })),
  );

  // "gender"/"race" : groupes dédiés (pas "genre", déjà pris par l'alignement
  // ci-dessus) — un groupe = un axe filtrable indépendamment en AND avec les
  // autres (voir getTypePool), réutiliser "genre" pour un 2e axe aurait
  // silencieusement transformé l'AND voulu (Homme ET Bon) en OR au sein d'un
  // même groupe. Sans bucket dédié côté client (filters.js), ces 2 groupes
  // retombent simplement dans la section "Listes" (fallback générique), même
  // sort que "liste" ci-dessus — pas un bug, juste pas de sous-en-tête.
  db.upsertFilters(
    "superhero",
    "gender",
    SUPERHERO_GENDERS.map(({ code, label }) => ({ code, name: label })),
  );
  db.replaceEntityFilters(
    "superhero",
    "gender",
    rows.map((r) => ({
      entityId: r.id,
      codes: r.genderCode ? [r.genderCode] : [],
    })),
  );

  db.upsertFilters(
    "superhero",
    "race",
    SUPERHERO_RACES.map(({ code, label }) => ({ code, name: label })),
  );
  db.replaceEntityFilters(
    "superhero",
    "race",
    rows.map((r) => ({
      entityId: r.id,
      codes: r.raceCode ? [r.raceCode] : [],
    })),
  );

  // "decennie"/"geographie" : groupes standards déjà pourvus d'un bucket
  // dédié côté client (voir filters.js), contrairement à gender/race
  // ci-dessus.
  db.upsertFilters(
    "superhero",
    "decennie",
    SUPERHERO_ERAS.map(({ code, label }) => ({ code, name: label })),
  );
  db.replaceEntityFilters(
    "superhero",
    "decennie",
    rows.map((r) => ({
      entityId: r.id,
      codes: r.eraCode ? [r.eraCode] : [],
    })),
  );

  db.upsertFilters(
    "superhero",
    "geographie",
    SUPERHERO_COUNTRIES.map(({ code, label }) => ({ code, name: label })),
  );
  db.replaceEntityFilters(
    "superhero",
    "geographie",
    rows.map((r) => ({
      entityId: r.id,
      codes: r.geoCode ? [r.geoCode] : [],
    })),
  );

  storeSuperheroPopularityTiers(rows);

  logInfo(`superhero : ${rows.length} personnages chargés.`);
}
