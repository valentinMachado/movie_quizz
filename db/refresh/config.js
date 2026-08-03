import path from "node:path";
import { readFileSync } from "node:fs";
import { logWarn, logError } from "./log.js";

export const APP_VERSION = JSON.parse(
  readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
).version;
// listes statiques/décennies/genres/pays/peintures/musique : toutes les
// données en dur (pas de logique) vivent dans config.json, pour que ce
// fichier ne garde que le code.
export const CONFIG = JSON.parse(
  readFileSync(path.join(process.cwd(), "config.json"), "utf8"),
);
export const TMDB_KEY = process.env.TMDB_API_KEY;

// initialisation des catégories : la vraie limite est le throttle de chaque
// API (tmdbGate/igdbGate), qui sérialise déjà les appels réels quel que soit
// le nombre d'appelants concurrents — ces constantes servent juste à ce
// qu'il y ait toujours un appel prêt à partir dès que le throttle l'autorise,
// au lieu d'attendre bêtement la fin de la page/catégorie précédente.
export const CATEGORY_FETCH_CONCURRENCY = CONFIG.concurrency.categoryFetch;
export const PAGE_FETCH_CONCURRENCY = CONFIG.concurrency.pageFetch;
export const IMAGE_FETCH_CONCURRENCY = CONFIG.concurrency.imageFetch;

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
export function onlyWants(type) {
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
export const MAX_TYPE_COUNT = MAX_TYPE_COUNT_ARG
  ? parseInt(MAX_TYPE_COUNT_ARG.slice("--max-type-count=".length), 10)
  : null;

// --db=<path> : fichier SQLite à ouvrir (défaut cache/data.sqlite) — sert à
// pointer refresh.js et server.js sur le même fichier de test sans jamais
// toucher à l'instance réelle. --ephemeral-db reste un raccourci vers
// --db=:memory:, utile pour un smoke-test isolé de ce seul script (rien
// d'autre ne pourra jamais lire cette base en mémoire).
const DB_ARG = process.argv.find((a) => a.startsWith("--db="));
export const DB_PATH = DB_ARG
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
export const IGDB_CLIENT_ID = process.env.IGDB_CLIENT_ID;
export const IGDB_CLIENT_SECRET = process.env.IGDB_CLIENT_SECRET;
export const igdbEnabled = Boolean(IGDB_CLIENT_ID && IGDB_CLIENT_SECRET);
if (!igdbEnabled) {
  logWarn(
    "IGDB_CLIENT_ID/IGDB_CLIENT_SECRET absents dans .env : catégorie Jeux vidéo désactivée.",
  );
}

// Pexels (photos pays) est optionnel : sans clé, la catégorie Pays reste
// alimentée pour son questionType "flag", qui n'en a pas besoin — seul son
// questionType "image" (photos) restera indisponible.
export const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
export const pexelsEnabled = Boolean(PEXELS_API_KEY);
if (!pexelsEnabled) {
  logWarn(
    "PEXELS_API_KEY absente dans .env : photos pays désactivées (le mode drapeau reste alimenté sans elles).",
  );
}

// listes statiques + décennies, films/séries/acteurs (données en dur dans
// config.json, ce fichier ne garde que le code qui les consomme).
export const STATIC_LISTS = CONFIG.movie.staticLists;
export const DECADE_LISTS = CONFIG.movie.decadeLists;
// nombre d'acteurs (ordre de billing TMDb) liés par film dans movie_cast —
// voir fetchAndStoreMovieCredits/fetchAndStoreFilmography, même plafond des
// deux côtés (casting d'UN film vs filmographie complète d'UN acteur) pour
// rester cohérent sur ce qui compte comme "assez en vue pour deviner".
export const MOVIE_CAST_LIMIT = CONFIG.movie.castLimit;
// rang de billing (cast.order TMDb) en-dessous duquel un crédit compte comme
// "tête d'affiche" plutôt que "second couteau" — voir
// syncActorBillingFromMovieCast (db/movie.js) et fetchAndStoreMovieCredits/
// fetchAndStoreFilmography (ce fichier).
export const MOVIE_LEAD_CAST_LIMIT = CONFIG.movie.leadCastLimit;
export const TV_STATIC_LISTS = CONFIG.tv.staticLists;
export const TV_DECADE_LISTS = CONFIG.tv.decadeLists;
export const PERSON_STATIC_LISTS = CONFIG.person.staticLists;

// pays films/acteurs : liste partagée par movieCountrySources (discover/movie
// filtré par pays d'origine, direct) et fetchPersonCountryActors (même
// discover, puis casting du film).
export const COUNTRY_TARGETS = CONFIG.countryTargets;
export const MOVIE_COUNTRY_PAGES = CONFIG.movie.countryPages; // ~160 films/pays (20/page), réduit en mode dev comme les autres pages
export const TV_COUNTRY_PAGES = CONFIG.tv.countryPages;

// codes+noms du groupe "geographie", partagé movie/tv (même COUNTRY_TARGETS,
// storeFilterGroup reçoit le type séparément), attend un objet
// { [code]: {label} } comme les *StaticLists de config.json.
export const COUNTRY_FILTERS = Object.fromEntries(
  COUNTRY_TARGETS.map((t) => [t.code, { label: t.name }]),
);
export const PERSON_COUNTRY_MOVIE_PAGES = CONFIG.person.country.moviePages; // ~80 films/pays (20/page), réduit en mode dev comme les autres pages
export const PERSON_COUNTRY_CAST_PER_MOVIE = CONFIG.person.country.castPerMovie; // rôles principaux seulement, pas la liste complète des crédits
export const PERSON_COUNTRY_TARGET_ACTORS = CONFIG.person.country.targetActors; // arrête d'aller chercher des crédits une fois assez d'acteurs uniques trouvés

// tranches "decennie" pour director/actor (année de NAISSANCE, voir
// syncPersonDerivedBirthFilters dans tmdb.js) — distinctes de DECADE_LISTS
// ci-dessus (année de SORTIE d'un film) : un acteur qui tourne un film des
// années 1930 n'est pas pour autant né dans les années 1930.
export const PERSON_BIRTH_DECADES = CONFIG.personBirthDecades;

// jeux vidéo (IGDB) — structure différente de TMDb : `igdbWhere`/`igdbSort`
// au lieu de `pathAndQuery`, paginé par offset (voir fetchGameEntities)
export const GAME_STATIC_LISTS = CONFIG.game.staticLists;

function unixYear(year) {
  return Math.floor(Date.UTC(year, 0, 1) / 1000);
}

// décennies IGDB : construites depuis les bornes en années de config.json
// (gteYear/ltYear) via unixYear, plutôt que de stocker des timestamps unix
// illisibles dans le JSON.
export const GAME_DECADE_LISTS = Object.fromEntries(
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
export const MUSIC_GENRE_STORE = CONFIG.music.genreStore; // un seul store pour les genres (le plus fourni), sinon ça multiplie les requêtes par pays
export const MUSIC_STATIC_LISTS = CONFIG.music.staticLists;

// les 8 charts pays de MUSIC_STATIC_LISTS ne sont plus des filtres "liste"
// distincts (voir fetchMusicEntities) : le pays de chaque chart devient un
// filtre "geographie", avec les mêmes noms que movie/tv (COUNTRY_TARGETS).
export const MUSIC_COUNTRY_FILTERS = Object.fromEntries(
  Object.values(MUSIC_STATIC_LISTS).map((src) => [
    src.country,
    { label: COUNTRY_TARGETS.find((t) => t.code === src.country)?.name ?? src.country },
  ]),
);

// classiques "blind test" (Queen - Bohemian Rhapsody, ABBA - Dancing
// Queen, etc.) : une liste de titres EXACTS { artist, track }, pas d'id
// iTunes pré-résolu — reproductible d'un déploiement à l'autre (voir
// fetchExactSongByTitle) sans état à maintenir à la main. Titres précis
// plutôt qu'une simple liste d'artistes : évite de piocher un morceau
// obscur d'un artiste connu (une recherche par nom seul n'est pas classée
// par notoriété DU MORCEAU).
export const MUSIC_BLINDTEST_SONGS = CONFIG.music.blindtestSongs;

// peintures — voir wikidata.js pour le détail des requêtes SPARQL
// (genres/pays/époques en dur dans config.json)
export const PAINTING_GENRES = CONFIG.painting.genres;
export const PAINTING_COUNTRIES = CONFIG.painting.countries;
export const PAINTING_ERAS = CONFIG.painting.eras;
export const PAINTING_QUERY_LIMIT = CONFIG.painting.queryLimit;

// rôles "person" alimentés depuis Wikidata (politicien, et tout futur rôle
// similaire — scientifique, écrivain...) : pays/époques PARTAGÉS par tous les
// rôles (P27/P569 sont des axes génériques, pas spécifiques à un métier), pour
// qu'ajouter un rôle tienne dans une seule entrée de `roles` (voir
// fetchPersonRoleEntities dans wikidata.js).
// plus bas que PAINTING_QUERY_LIMIT (200) : un métier générique (ex.
// politicien, P106) couvre un ensemble Wikidata bien plus large qu'"instance
// of peinture" — vérifié en direct sur query.wikidata.org, LIMIT 200 combiné
// au FILTER sitelinks flirte avec le timeout de 15s de wikidataQuery.
export const PERSON_ROLE_QUERY_LIMIT = CONFIG.personRoles.queryLimit;
export const PERSON_ROLE_COUNTRIES = CONFIG.personRoles.countries;
export const PERSON_ROLE_ERAS = CONFIG.personRoles.eras;
export const PERSON_ROLES = CONFIG.personRoles.roles;

// séries TV : nombre d'épisodes aléatoires chauffés par série (voir
// tvShowNeedsWarming/fetchAndStoreTvImages dans tmdb.js)
export const TV_TARGET_EPISODES_PER_SHOW = CONFIG.tv.targetEpisodesPerShow;

// articles Wikipédia — voir wikipedia.js pour le détail des requêtes
// MediaWiki (catégories en dur dans config.json)
export const WIKI_ARTICLE_LANG = CONFIG.wikiArticle.lang;
export const WIKI_ARTICLE_CATEGORIES = CONFIG.wikiArticle.categories;
export const WIKI_ARTICLE_QUERY_LIMIT = CONFIG.wikiArticle.queryLimit;
// défaut de profondeur de parcours des sous-catégories (voir
// collectCategoryPages dans wikipedia.js) — surchargeable par entrée de
// `categories` via son propre champ "depth" (ex. les catégories "(nom
// vernaculaire)" d'Animaux, des listes plates sans sous-catégories, fixées
// à 0 : inutile d'y risquer une dérive si `queryLimit` change un jour).
export const WIKI_ARTICLE_DEFAULT_DEPTH = CONFIG.wikiArticle.defaultDepth;
// nombre de tranches du filtre "decennie" (histoire uniquement) — tranches
// calculées par quantile sur les années réellement trouvées à chaque crawl
// (voir buildDecadeBuckets dans wikipedia.js), pas des bornes calendaires
// figées : garde des tranches de taille comparable même si les années
// disponibles sont très inégalement réparties dans le temps.
export const WIKI_ARTICLE_DECADE_BUCKETS = CONFIG.wikiArticle.decadeBuckets;

// Pokémon — PokeAPI (pokeapi.co), gratuite, sans clé. Traductions FR des
// codes bruts (type élémentaire/génération/habitat) + listes statiques
// (starters/pseudo-légendaires/fossiles, aucun équivalent côté API) en dur
// dans config.json, voir fetchPokemonEntities dans pokeapi.js.
export const POKEMON_FETCH_CONCURRENCY = CONFIG.pokemon.fetchConcurrency;
export const POKEMON_TYPES = CONFIG.pokemon.types;
export const POKEMON_GENERATIONS = CONFIG.pokemon.generations;
export const POKEMON_HABITATS = CONFIG.pokemon.habitats;
export const POKEMON_STARTER_IDS = new Set(CONFIG.pokemon.starterIds);
export const POKEMON_PSEUDO_LEGENDARY_IDS = new Set(
  CONFIG.pokemon.pseudoLegendaryIds,
);
export const POKEMON_FOSSIL_IDS = new Set(CONFIG.pokemon.fossilIds);

// super-héros — superhero-api (akabab.github.io/superhero-api), gratuite,
// sans clé, un seul fetch "all.json" contient déjà tout (portrait/bio) : pas
// de 2e requête par entité comme PokeAPI. "publishers" ne couvre QUE
// Marvel/DC (le champ brut de l'API a ~67 valeurs distinctes, dont beaucoup
// sont en fait des noms d'alter-ego, pas de vrais éditeurs — trop bruité
// pour un filtre lisible) ; un héros hors de ces deux reste dans le pool,
// simplement sans code "liste" (même logique que l'habitat pokemon absent).
export const SUPERHERO_PUBLISHERS = CONFIG.superhero.publishers;
export const SUPERHERO_ALIGNMENTS = CONFIG.superhero.alignments;
// gender/race : valeurs brutes API en anglais ("Male", "Human / Radiation"),
// distinctes du code/libellé FR affiché — d'où la forme tableau {code,
// label, match} (comme painting.genres) plutôt qu'un simple objet
// code->libellé (suffisant pour alignments, où le code EST déjà la valeur
// brute). "race" ne couvre que les valeurs les plus fréquentes (61 valeurs
// distinctes au total, très longue traîne) : un héros hors de cette liste
// reste dans le pool, simplement sans code "race" (même logique que
// l'habitat pokemon absent, ou que publisher hors Marvel/DC).
export const SUPERHERO_GENDERS = CONFIG.superhero.genders;
export const SUPERHERO_RACES = CONFIG.superhero.races;
// "decennie" (old school/récent) : année extraite du texte libre
// biography.firstAppearance (voir extractYear dans superhero.js), bornée par
// gteYear/ltYear comme painting.eras. "geographie" : biography.placeOfBirth
// est un texte libre très hétérogène (ville réelle, planète fictive, blague
// de contributeur...) — `match` liste les sous-chaînes anglaises reconnues
// pour CE code, testées dans l'ORDRE du tableau (le premier qui matche
// gagne, voir findGeoCode) : "us" doit rester avant les autres pays car un
// nom d'état ("New Mexico", "Indiana") contient parfois le nom d'un autre
// pays de la liste ("Mexico", "India") en sous-chaîne. Liste volontairement
// limitée aux pays qui ont RÉELLEMENT au moins un match dans ce snapshot
// (vérifié en direct) — Italie/Espagne/Inde/Corée du Sud/Mexique ont été
// retirés faute d'un seul personnage né là-bas selon l'API : un filtre qui
// renvoie toujours 0 résultat n'apporte rien, mieux vaut ne pas l'exposer.
export const SUPERHERO_ERAS = CONFIG.superhero.eras;
export const SUPERHERO_COUNTRIES = CONFIG.superhero.countries;

export function capPages(pages) {
  return MAX_TYPE_COUNT ? Math.min(pages, 1) : pages;
}
