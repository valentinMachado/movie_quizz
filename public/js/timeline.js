import { state } from "./state.js";

// le timeline démarre par un écran splash, puis enchaîne les films
export function buildTimeline(
  imageMs,
  revealMs,
  splashMs,
  musicClipMs,
  flagMs,
  synopsisMs,
) {
  const tl = [];
  let t = 0;
  if (splashMs > 0) {
    tl.push({ type: "splash", start: t, dur: splashMs });
    t += splashMs;
  }
  state.items.forEach((m, i) => {
    if (m.type === "music") {
      tl.push({
        type: "music-guess",
        itemIdx: i,
        start: t,
        dur: musicClipMs,
      });
      t += musicClipMs;
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
    if (m.questionType === "synopsis" && m.type === "director") {
      // plusieurs synopsis (films différents) cyclés comme des frames,
      // même principe que la boucle m.backdropImgs du mode "image"
      // ci-dessous (itemGuessStart/itemGuessDur pour une barre de
      // progression continue sur tout l'item, pas remise à zéro par frame).
      const itemGuessStart = t;
      const itemGuessDur = m.overviews.length * synopsisMs;
      m.overviews.forEach((_, frameIdx) => {
        tl.push({
          type: "synopsis-guess",
          itemIdx: i,
          frameIdx,
          start: t,
          dur: synopsisMs,
          itemGuessStart,
          itemGuessDur,
        });
        t += synopsisMs;
      });
      tl.push({ type: "reveal", itemIdx: i, start: t, dur: revealMs });
      t += revealMs;
      return;
    }
    if (m.questionType === "synopsis") {
      tl.push({
        type: "synopsis-guess",
        itemIdx: i,
        start: t,
        dur: synopsisMs,
      });
      t += synopsisMs;
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
