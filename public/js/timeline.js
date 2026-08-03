import { state } from "./state.js";

// bornes de durée d'un summary — MIN évite un segment dégénéré (texte
// anonymisé d'un seul mot). MAX était à 50 (borne de l'ancien curseur fixe)
// mais coupait en pratique le temps de lecture des extraits Wikipédia, plus
// longs qu'un summary TMDb/IGDB typique : à la vitesse "Long" (0.55s/mot),
// 50s plafonnait déjà à ~90 mots — le défilement allait alors bien plus
// vite que le facteur mots/seconde choisi, donnant l'impression que la fin
// du texte était tronquée/pas lue. 120s laisse de la marge pour un long
// extrait sans qu'un item ne puisse dominer démesurément la durée totale.
export const MIN_SUMMARY_SEC = 5;
export const MAX_SUMMARY_SEC = 120;
// nombre de mots "typique" d'un summary (TMDb/IGDB/Wikipédia) — sert
// uniquement à estimer une durée totale AVANT d'avoir le vrai texte (voir
// totalDurationSec dans settings.js) ; le rendu réel utilise toujours le
// nombre de mots effectif (voir summaryDurationMs ci-dessous).
const AVG_SUMMARY_WORDS = 50;

function summaryWordCount(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean).length;
}

// durée de lecture d'un summary = nb de mots réel × facteur secondes/mot
// (préréglage Rapide/Normal/Long, voir config.js SUMMARY_SPEEDS) : un
// summary court passe plus vite qu'un long, contrairement à l'ancienne
// durée fixe.
export function summaryDurationMs(text, secPerWord) {
  const sec = Math.min(
    MAX_SUMMARY_SEC,
    Math.max(MIN_SUMMARY_SEC, summaryWordCount(text) * secPerWord),
  );
  return sec * 1000;
}

export function estimateSummarySec(secPerWord) {
  return Math.min(
    MAX_SUMMARY_SEC,
    Math.max(MIN_SUMMARY_SEC, AVG_SUMMARY_WORDS * secPerWord),
  );
}

// le timeline démarre par un écran splash, puis enchaîne les films
export function buildTimeline(
  imageMs,
  revealMs,
  splashMs,
  flagMs,
  summarySecPerWord,
) {
  const tl = [];
  let t = 0;
  if (splashMs > 0) {
    tl.push({ type: "splash", start: t, dur: splashMs });
    t += splashMs;
  }
  state.items.forEach((m, i) => {
    // "music-guess"/"music-reveal" couvrent tout questionType "audio"
    // (musique ET cri Pokémon), pas seulement m.type === "music" — noms de
    // segment conservés tels quels (détail interne, voir drawSegment).
    // durée tirée de m.audioGuessSec (voir preload.js) plutôt que d'un
    // réglage global unique : un cri est rejoué N fois à une durée réelle
    // différente pour chaque pokémon (inconnue avant chargement), alors
    // qu'un extrait musical dure toujours exactement le même réglage.
    if (m.questionType === "audio") {
      const guessMs = m.audioGuessSec * 1000;
      tl.push({
        type: "music-guess",
        itemIdx: i,
        start: t,
        dur: guessMs,
      });
      t += guessMs;
      tl.push({
        type: "music-reveal",
        itemIdx: i,
        start: t,
        dur: revealMs,
      });
      t += revealMs;
      return;
    }
    if (m.type === "country" && m.questionType === "flag") {
      tl.push({
        type: "flag-guess",
        itemIdx: i,
        start: t,
        dur: flagMs,
      });
      t += flagMs;
      tl.push({
        type: "flag-reveal",
        itemIdx: i,
        start: t,
        dur: revealMs,
      });
      t += revealMs;
      return;
    }
    if (m.questionType === "summary" && m.type === "director") {
      // plusieurs summary (films différents) cyclés comme des frames,
      // même principe que la boucle m.backdropImgs du mode "image"
      // ci-dessous (itemGuessStart/itemGuessDur pour une barre de
      // progression continue sur tout l'item, pas remise à zéro par frame)
      // — chaque frame a sa PROPRE durée (texte différent d'un film à
      // l'autre), contrairement à imageMs qui reste fixe.
      const itemGuessStart = t;
      const frameDurs = m.overviews.map((overview) =>
        summaryDurationMs(overview, summarySecPerWord),
      );
      const itemGuessDur = frameDurs.reduce((sum, d) => sum + d, 0);
      m.overviews.forEach((_, frameIdx) => {
        const dur = frameDurs[frameIdx];
        tl.push({
          type: "summary-guess",
          itemIdx: i,
          frameIdx,
          start: t,
          dur,
          itemGuessStart,
          itemGuessDur,
        });
        t += dur;
      });
      tl.push({ type: "reveal", itemIdx: i, start: t, dur: revealMs });
      t += revealMs;
      return;
    }
    if (m.questionType === "summary") {
      const dur = summaryDurationMs(m.overview, summarySecPerWord);
      tl.push({
        type: "summary-guess",
        itemIdx: i,
        start: t,
        dur,
      });
      t += dur;
      // reveal générique : identique à celui du mode "image" (poster
      // + titre), aucune branche dédiée nécessaire (voir drawReveal)
      tl.push({ type: "reveal", itemIdx: i, start: t, dur: revealMs });
      t += revealMs;
      return;
    }
    const itemGuessStart = t;
    const itemGuessDur = m.backdropImgs.length * imageMs;
    m.backdropImgs.forEach((_, imgIdx) => {
      tl.push({
        type: "guess",
        itemIdx: i,
        imgIdx,
        start: t,
        dur: imageMs,
        itemGuessStart,
        itemGuessDur,
      });
      t += imageMs;
    });
    tl.push({ type: "reveal", itemIdx: i, start: t, dur: revealMs });
    t += revealMs;
  });
  return { timeline: tl, total: t };
}

export function findSegment(elapsed) {
  for (const seg of state.timeline) {
    if (elapsed < seg.start + seg.dur) return seg;
  }
  return state.timeline[state.timeline.length - 1];
}
