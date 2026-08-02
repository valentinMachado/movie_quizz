export const CFG = {
  preloadConcurrency: 8,
  splashMs: 5000,
};
export const STORAGE_PREFIX = "guessit_seen_";
export const SETTINGS_KEY = "guessit_settings";

// une seule cadence, utilisée à la fois pour redessiner le canvas et
// pour encoder (voir renderFast/renderRealtime) : le coût réel est
// dans l'encodage des frames, pas dans le dessin — inutile de les
// découpler, ça n'accélère rien et ça ajoute juste de la complexité.
// Trois préréglages exposés à l'utilisateur (voir renderQualityChips)
// plutôt qu'un curseur libre : la vitesse de rendu comme la fluidité
// de la vidéo en dépendent directement, donc un choix explicite entre
// options connues est plus lisible qu'un nombre arbitraire. Résolution
// couplée au même préréglage (même ratio 16:9 que l'actuel 1280x720) :
// baisser la résolution réduit aussi le travail d'encodage par frame.
export const RENDER_QUALITIES = [
  { key: "low", label: "🐢 Faible", fps: 8, width: 854, height: 480 },
  { key: "medium", label: "⚖️ Moyen", fps: 12, width: 1280, height: 720 },
  { key: "high", label: "🚀 Élevé", fps: 24, width: 1920, height: 1080 },
];

// libellé de base par type (l'emoji "résultat"), préfixé au
// libellé/icône du questionType (l'emoji "contenu de la question",
// voir QUESTION_TYPE_DETAILS) pour former le texte de chaque chip
export const TYPE_BASE_LABELS = {
  movie: "🎬 Films",
  tv: "📺 Séries",
  // "person" (server.js/db.js) mélange acteurs, réalisateurs et
  // peintres (filtre "role" : actor/director/painter) — plus
  // seulement des acteurs, d'où le libellé générique
  person: "😊 Personnes",
  game: "🎮 Jeux vidéo",
  music: "🎵 Musique",
  country: "🌍 Pays",
  painter: "🎨 Peintres",
  director: "🎥 Réalisateurs",
};

// même emoji que TYPE_BASE_LABELS, isolé du libellé texte — sert à
// préfixer chaque chip de filtre (voir renderChips dans filters.js)
// pour indiquer à quel type il s'applique, plusieurs types pouvant
// partager un même groupe de filtres (ex. "Genres" mélange les
// genres films et séries quand les deux sont actifs)
export const TYPE_EMOJI = Object.fromEntries(
  Object.entries(TYPE_BASE_LABELS).map(([type, label]) => [
    type,
    label.split(" ")[0],
  ]),
);

// libellé/icône par questionType (l'emoji "contenu de la question") —
// purement de l'affichage, server.js n'a pas de notion de libellé
// pour ses questionTypes ("image"/"synopsis"/"flag"/"audio", voir
// TYPES côté serveur), donc c'est une constante client, pas une
// donnée chargée depuis /api/catalog.
export const QUESTION_TYPE_DETAILS = {
  image: { icon: "🖼️", label: "Photo" },
  synopsis: { icon: "📖", label: "Synopsis" },
  flag: { icon: "🚩", label: "Drapeau" },
  audio: { icon: "🎧", label: "Extrait audio" },
};

// surcharge de libellé pour certains (type, questionType) où le mot
// générique ci-dessus ne décrit pas le contenu réel : l'image de
// devinette d'un peintre est un de ses tableaux (getPainterArtworks
// côté server.js), pas une photo du peintre lui-même (réservée à
// l'écran de réponse, voir posterUrl/portrait) — même logique pour un
// réalisateur, dont l'image de devinette est une affiche de film
// (getDirectorMoviePosters)
const QUESTION_TYPE_LABEL_OVERRIDES = {
  painter: { image: "Tableau" },
  director: { image: "Filmographie", synopsis: "Filmographie" },
};

export function questionTypeInfo(type, questionType) {
  const base = QUESTION_TYPE_DETAILS[questionType] || {};
  const label = QUESTION_TYPE_LABEL_OVERRIDES[type]?.[questionType] ?? base.label;
  return { icon: base.icon, label };
}

// --- pistes audio fournies (public/), insérées aux moments clés de la
// vidéo pour les catégories non musicales : un son sur le splash, un
// sur la phase de devinette (la réponse reste silencieuse) ---
export const CUE_URLS = {
  splash: "/video_splash_screen.mp3",
  guessing: "/video_guessing.mp3",
};
