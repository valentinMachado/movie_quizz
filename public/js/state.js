import { RENDER_QUALITIES, SUMMARY_SPEEDS, AUDIO_SPEEDS } from "./config.js";

// canvas de rendu, jamais attaché au DOM : sert uniquement de source aux
// frames encodées — dimensionné selon la qualité sélectionnée (voir
// applyRenderQuality, appelé au chargement et à chaque changement)
export const canvas = document.createElement("canvas");
export const ctx = canvas.getContext("2d", { desynchronized: true });

// échelle de rendu = ratio entre la résolution active et celle de
// "moyen" (1280x720, base historique) : tous les repères en pixels
// (polices, marges, rayons...) du dessin sont exprimés en fraction de
// cette base, donc "moyen" reste rendu à l'identique (RS = 1) et
// "faible"/"élevé" mettent juste l'échelle à jour proportionnellement.
// Seul applyRenderQuality (ci-dessous, même module) la réassigne : les
// autres modules ne font que la lire, ce qui permet un simple export
// `let` (liaison vive ES module) plutôt que de la loger dans `state`.
export let RS = 1;

// état de la session en cours, regroupé dans un objet unique car
// réassigné depuis de nombreux modules (chips de filtres, réglages,
// génération du quiz...) — un export `let` par variable ne pourrait
// être réassigné que par ce module, alors que les propriétés d'un
// objet exporté restent mutables depuis n'importe quel importeur.
// Chaque type a au moins un questionType (voir questionTypesByType,
// dérivé de /api/catalog), même sans choix possible (ex: "movie" n'a
// que "image") : la rangée "Type" est donc entièrement composée de
// combinaisons "type:questionType" indépendantes, jamais de simples
// type nus — chaque chip montre ainsi systématiquement les deux emoji
// (contenu de la question + résultat). Un chip indépendant par
// combinaison plutôt qu'une rangée "Mode" partagée : une rangée
// partagée forcerait le produit cartésien entre tous les type à
// plusieurs modes actifs à la fois, sans pouvoir composer une
// combinaison précise (voir historique)
export const state = {
  activeQuestionTypes: new Set(["movie:image"]),
  questionTypesByType: {}, // ex: { country: ["image", "flag"] }
  availableFilters: [], // [{ key, type, group, code, label }], voir loadFilters
  selectedFilters: new Set(),
  filterSearch: "",
  currentMaxAvailable: 50,
  items: [],
  timeline: [],
  totalDurationMs: 0,
  answersRevealed: false,
  splashAudioBuffer: null,
  logoImg: null, // logo préchargé une fois, dessiné de façon synchrone par drawSplash
  renderFps: 12,
  summarySpeed: "normal",
  audioSpeed: "normal",
};

export function currentRenderQuality() {
  return (
    RENDER_QUALITIES.find((q) => q.fps === state.renderFps) ||
    RENDER_QUALITIES[1]
  );
}

export function currentSummarySpeed() {
  return (
    SUMMARY_SPEEDS.find((s) => s.key === state.summarySpeed) ||
    SUMMARY_SPEEDS[1]
  );
}

export function currentAudioSpeed() {
  return (
    AUDIO_SPEEDS.find((s) => s.key === state.audioSpeed) || AUDIO_SPEEDS[1]
  );
}

// dimensionne le canvas de rendu selon la qualité sélectionnée — appelé
// au chargement et à chaque changement (voir renderQualityChips)
export function applyRenderQuality(q) {
  canvas.width = q.width;
  canvas.height = q.height;
  RS = q.width / 1280;
}
