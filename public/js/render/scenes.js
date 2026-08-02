import { TYPE_BASE_LABELS, questionTypeInfo } from "../config.js";
import { canvas, ctx, RS, state } from "../state.js";
import {
  drawContain,
  drawFramedImage,
  gameFont,
  roundedRectPath,
  wrapText,
} from "./primitives.js";
import {
  drawBadge,
  drawEqualizer,
  drawFrameBorder,
  drawGameBackdrop,
  drawGameParticles,
  drawGameProgress,
  drawGlowBurst,
  drawRevealBanner,
  drawSideThumbnails,
} from "./chrome.js";
import { drawSplash } from "./splash.js";

// libellé "type + questionType" d'un item (même format que
// splashTypeLabels), affiché en coin de l'écran de devinette pour
// rappeler de quel type est la question — utile quand plusieurs
// type/questionType sont mélangés dans le même quiz
function questionTypeLabel(m) {
  const qt = m.questionType || (m.type === "music" ? "audio" : "image");
  const baseLabel = TYPE_BASE_LABELS[m.type] || m.type;
  const info = questionTypeInfo(m.type, qt);
  return `${baseLabel} ${info.icon || ""} ${info.label || qt}`.trim();
}

// gâteau au-dessus du badge "reason" (voir drawReveal/drawMusicReveal/
// drawFlagReveal), uniquement pour les items anniversaire du quiz du jour
// (m.isAnniversary, voir server.js) — pas pour un item "tendance". Aligné à
// droite sur `rightX` (même repère que le badge, voir drawBadge align:
// "right") et posé juste au-dessus, `badgeCenterY` étant le centre vertical
// du badge (même hauteur ~44*RS que drawBadge par défaut, voir chrome.js).
function drawAnniversaryCake(rightX, badgeCenterY) {
  if (!state.cakeImg) return;
  const h = 120 * RS;
  const ir = state.cakeImg.width / state.cakeImg.height;
  const w = h * ir;
  const gap = 14 * RS;
  const badgeHalfH = 22 * RS;
  const y = badgeCenterY - badgeHalfH - gap - h;
  const x = rightX - w;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 10 * RS;
  ctx.drawImage(state.cakeImg, x, y, w, h);
  ctx.restore();
}

function drawGuess(m, seg, withinMs) {
  const itemIdx = seg.itemIdx,
    imgIdx = seg.imgIdx;
  const hasSideStrip = m.backdropImgs.length > 1;
  const colW = hasSideStrip ? 280 * RS : 0;
  const mainW = canvas.width - colW;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#151220";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // un peu de marge autour de l'image pour qu'elle reste bien à
  // l'intérieur du liseré décoratif plutôt que de le toucher
  const pad = 22 * RS;
  const imgX = pad,
    imgY = pad,
    imgW = mainW - pad * 2,
    imgH = canvas.height - pad * 2,
    radius = 16 * RS;

  ctx.save();
  roundedRectPath(imgX, imgY, imgW, imgH, radius);
  ctx.clip();
  drawContain(m.backdropImgs[imgIdx], imgX, imgY, imgW, imgH);

  const g = ctx.createLinearGradient(
    0,
    imgY + imgH * 0.62,
    0,
    imgY + imgH,
  );
  g.addColorStop(0, "rgba(10,10,16,0)");
  g.addColorStop(1, "rgba(10,10,16,0.88)");
  ctx.fillStyle = g;
  ctx.fillRect(imgX, imgY + imgH * 0.62, imgW, imgH * 0.38);

  // titre du film affiché en surimpression (quiz "réalisateur" uniquement,
  // voir server.js/selectItemsWithBackdrops) : un poster n'écrit pas
  // toujours son titre de façon lisible, contrairement aux autres types où
  // aucune légende par image n'est nécessaire.
  const imageTitle = m.imageTitles && m.imageTitles[imgIdx];
  if (imageTitle) {
    ctx.save();
    ctx.font = gameFont(700, 26);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const lineHeight = 34 * RS;
    // la plupart des affiches de film sont en portrait (voir drawContain :
    // dw < imgW dans ce cas, poster centré) — ça laisse une bande vide en
    // haut à gauche, sous la barre de progression (drawGameProgress,
    // y≈46*RS), plutôt que de chevaucher les badges du bas.
    const lines = wrapText(imageTitle, imgW * 0.32).slice(0, 3);

    const padX = 20 * RS;
    const padY = 12 * RS;
    const boxX = imgX + 24 * RS;
    const boxY = imgY + 80 * RS;
    const maxLineW = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const boxW = maxLineW + padX * 2;
    const boxH = lines.length * lineHeight + padY * 2;

    // fond plein systématique derrière le titre : la bande blurrée de
    // drawContain ne suffit pas toujours à garantir la lisibilité (zones
    // claires ou texturées) — un bandeau opaque reste lisible quelle que
    // soit l'image dessous.
    roundedRectPath(boxX, boxY, boxW, boxH, 14 * RS);
    ctx.fillStyle = "rgba(10,8,16,0.78)";
    ctx.fill();

    ctx.fillStyle = "#ede8de";
    const textX = boxX + padX;
    const firstCenterY = boxY + padY + lineHeight / 2;
    lines.forEach((line, i) => {
      ctx.fillText(line, textX, firstCenterY + i * lineHeight);
    });
    ctx.restore();
  }
  ctx.restore();

  ctx.save();
  roundedRectPath(imgX, imgY, imgW, imgH, radius);
  ctx.lineWidth = 2.5 * RS;
  ctx.strokeStyle = "rgba(157,92,230,0.5)";
  ctx.stroke();
  ctx.restore();

  const itemElapsed = seg.start - seg.itemGuessStart + withinMs;
  drawGameProgress(itemElapsed / seg.itemGuessDur, mainW);
  if (hasSideStrip) drawSideThumbnails(m, imgIdx, mainW, colW);

  drawBadge(
    `N° ${itemIdx + 1} / ${state.items.length}`,
    50 * RS,
    canvas.height - 58 * RS,
  );
  drawBadge(questionTypeLabel(m), mainW - 50 * RS, canvas.height - 58 * RS, {
    align: "right",
  });
  drawFrameBorder();
}
function drawReveal(m, itemIdx, withinMs) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGameBackdrop();
  drawGameParticles(withinMs);

  const posterH = canvas.height - 220 * RS;
  const posterW = posterH * (2 / 3);
  const px = (canvas.width - posterW) / 2;
  const py = 90 * RS;

  drawGlowBurst(canvas.width / 2, py + posterH / 2, withinMs, 300);

  if (m.posterImg) {
    const ir = m.posterImg.width / m.posterImg.height;
    const boxRatio = posterW / posterH;
    let dw, dh;
    if (ir > boxRatio) {
      dw = posterW;
      dh = posterW / ir;
    } else {
      dh = posterH;
      dw = posterH * ir;
    }
    const dx = px + (posterW - dw) / 2;
    const dy = py + (posterH - dh) / 2;
    drawFramedImage(m.posterImg, dx, dy, dw, dh);
  }

  drawRevealBanner(canvas.width / 2, 62 * RS);

  ctx.save();
  ctx.font = gameFont(700, 34);
  ctx.fillStyle = "#ede8de";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 10 * RS;
  ctx.fillText(m.title, canvas.width / 2, canvas.height - 55 * RS);
  ctx.restore();

  if (m.type === "movie" && m.director) {
    ctx.save();
    ctx.font = gameFont(600, 22);
    ctx.fillStyle = "#c9bfe8";
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 8 * RS;
    ctx.fillText(
      `Réalisé par ${m.director}`,
      canvas.width / 2,
      canvas.height - 24 * RS,
    );
    ctx.restore();
  }

  drawBadge(
    `N° ${itemIdx + 1} / ${state.items.length}`,
    50 * RS,
    canvas.height - 58 * RS,
  );
  // "reason" (quiz du jour uniquement, voir server.js) : pourquoi cette
  // entité est dans le quiz — même coin que questionTypeLabel côté
  // devinette (drawGuess), libre ici puisque l'écran réponse ne l'affiche
  // pas.
  if (m.reason) {
    drawBadge(m.reason, canvas.width - 50 * RS, canvas.height - 58 * RS, {
      align: "right",
    });
    if (m.isAnniversary)
      drawAnniversaryCake(canvas.width - 50 * RS, canvas.height - 58 * RS);
  }
  drawFrameBorder();
}

function drawMusicGuess(m, seg, withinMs) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGameBackdrop();
  drawGameParticles(withinMs);

  drawEqualizer(canvas.width / 2, canvas.height / 2 + 20 * RS, withinMs);

  drawGameProgress(withinMs / seg.dur, canvas.width);

  drawBadge(
    `N° ${seg.itemIdx + 1} / ${state.items.length}`,
    50 * RS,
    canvas.height - 58 * RS,
  );
  drawBadge(
    questionTypeLabel(m),
    canvas.width - 50 * RS,
    canvas.height - 58 * RS,
    { align: "right" },
  );
  drawFrameBorder();
}

function drawMusicReveal(m, itemIdx, withinMs) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGameBackdrop();
  drawGameParticles(withinMs);

  // pochette carrée, contain-fit dans une boîte carrée (même logique
  // que le poster des autres types, juste un ratio 1:1 au lieu de 2:3)
  const boxSize = canvas.height - 260 * RS;
  const bx = (canvas.width - boxSize) / 2;
  const by = 80 * RS;

  drawGlowBurst(canvas.width / 2, by + boxSize / 2, withinMs, 300);

  if (m.posterImg) {
    const ir = m.posterImg.width / m.posterImg.height;
    let dw, dh;
    if (ir > 1) {
      dw = boxSize;
      dh = boxSize / ir;
    } else {
      dh = boxSize;
      dw = boxSize * ir;
    }
    const dx = bx + (boxSize - dw) / 2;
    const dy = by + (boxSize - dh) / 2;
    drawFramedImage(m.posterImg, dx, dy, dw, dh);
  }

  drawRevealBanner(canvas.width / 2, 62 * RS);

  ctx.save();
  ctx.font = gameFont(700, 32);
  ctx.fillStyle = "#ede8de";
  ctx.textAlign = "center";
  ctx.fillText(m.artist, canvas.width / 2, canvas.height - 86 * RS);

  ctx.font = gameFont(600, 24);
  ctx.fillStyle = "#e8a33d";
  ctx.fillText(m.track, canvas.width / 2, canvas.height - 55 * RS);
  ctx.restore();

  drawBadge(
    `N° ${itemIdx + 1} / ${state.items.length}`,
    50 * RS,
    canvas.height - 58 * RS,
  );
  if (m.reason) {
    drawBadge(m.reason, canvas.width - 50 * RS, canvas.height - 58 * RS, {
      align: "right",
    });
    if (m.isAnniversary)
      drawAnniversaryCake(canvas.width - 50 * RS, canvas.height - 58 * RS);
  }
  drawFrameBorder();
}

// drapeau centré, coins arrondis + halo, identique en devinette et en
// réponse (contrairement aux autres types) : c'est le principe même de
// cette catégorie, voir fetchFlagCategory côté serveur
function drawFlagBox(m, withinMs) {
  const boxW = 420 * RS,
    boxH = 300 * RS;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2 - 10 * RS;

  drawGlowBurst(cx, cy, withinMs, 300);

  if (m.posterImg) {
    const ir = m.posterImg.width / m.posterImg.height;
    let dw, dh;
    if (ir > boxW / boxH) {
      dw = boxW;
      dh = boxW / ir;
    } else {
      dh = boxH;
      dw = boxH * ir;
    }
    const dx = cx - dw / 2;
    const dy = cy - dh / 2;
    drawFramedImage(m.posterImg, dx, dy, dw, dh, 12 * RS);
  }
}

function drawFlagGuess(m, seg, withinMs) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGameBackdrop();
  drawGameParticles(withinMs);

  drawFlagBox(m, withinMs);

  drawGameProgress(withinMs / seg.dur, canvas.width);

  drawBadge(
    `N° ${seg.itemIdx + 1} / ${state.items.length}`,
    50 * RS,
    canvas.height - 58 * RS,
  );
  drawBadge(
    questionTypeLabel(m),
    canvas.width - 50 * RS,
    canvas.height - 58 * RS,
    { align: "right" },
  );
  drawFrameBorder();
}

function drawFlagReveal(m, itemIdx, withinMs) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGameBackdrop();
  drawGameParticles(withinMs);

  drawFlagBox(m, withinMs);

  drawRevealBanner(canvas.width / 2, 62 * RS);

  ctx.save();
  ctx.font = gameFont(700, 32);
  ctx.fillStyle = "#ede8de";
  ctx.textAlign = "center";
  ctx.fillText(m.title, canvas.width / 2, canvas.height - 86 * RS);

  ctx.font = gameFont(600, 24);
  ctx.fillStyle = "#e8a33d";
  ctx.fillText(`Capitale : ${m.capital}`, canvas.width / 2, canvas.height - 55 * RS);
  ctx.restore();

  drawBadge(
    `N° ${itemIdx + 1} / ${state.items.length}`,
    50 * RS,
    canvas.height - 58 * RS,
  );
  if (m.reason) {
    drawBadge(m.reason, canvas.width - 50 * RS, canvas.height - 58 * RS, {
      align: "right",
    });
    if (m.isAnniversary)
      drawAnniversaryCake(canvas.width - 50 * RS, canvas.height - 58 * RS);
  }
  drawFrameBorder();
}

// écran de devinette du mode "synopsis" (movie/tv/game) : le texte du
// résumé remplace l'image, seul l'écran réponse (générique, voir
// buildTimeline) affiche poster + titre comme le mode "image"
function drawSynopsisGuess(m, seg, withinMs) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGameBackdrop();
  drawGameParticles(withinMs);
  drawGlowBurst(canvas.width / 2, canvas.height / 2, withinMs, 340);

  const boxW = canvas.width - 220 * RS;
  ctx.save();
  ctx.font = gameFont(500, 30);
  ctx.textAlign = "center";
  ctx.fillStyle = "#ede8de";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 10 * RS;
  const lineHeight = 44 * RS;
  const lines = wrapText(m.overview, boxW);
  const textH = lines.length * lineHeight;
  // zone verticale sûre, sous la barre de progression et au-dessus des
  // badges (voir drawGameProgress/drawBadge plus bas) : le texte y est
  // clippé dès qu'il ne tient plus, pour ne jamais les chevaucher
  const topMargin = 110 * RS;
  const bottomMargin = 110 * RS;
  const zoneH = canvas.height - topMargin - bottomMargin;

  let startY;
  if (textH <= zoneH) {
    // tient dans la zone visible : centré sur tout le canvas, comme
    // pour un synopsis court
    startY = (canvas.height - textH) / 2;
  } else {
    // trop long pour tenir : défilement façon téléprompteur sur toute
    // la durée de la devinette (voir seg.dur), plutôt qu'un texte
    // tronqué ou débordant
    const scrollRange = textH - zoneH;
    const p = Math.min(1, Math.max(0, withinMs / seg.dur));
    startY = topMargin - scrollRange * p;
    ctx.beginPath();
    ctx.rect(0, topMargin, canvas.width, zoneH);
    ctx.clip();
  }
  lines.forEach((line, i) => {
    ctx.fillText(line, canvas.width / 2, startY + i * lineHeight);
  });
  ctx.restore();

  drawGameProgress(withinMs / seg.dur, canvas.width);

  drawBadge(
    `N° ${seg.itemIdx + 1} / ${state.items.length}`,
    50 * RS,
    canvas.height - 58 * RS,
  );
  drawBadge(
    questionTypeLabel(m),
    canvas.width - 50 * RS,
    canvas.height - 58 * RS,
    { align: "right" },
  );
  drawFrameBorder();
}

export function drawSegment(seg, withinMs) {
  if (seg.type === "splash") {
    drawSplash(withinMs);
    return;
  }
  const m = state.items[seg.itemIdx];
  if (!m) return;
  if (seg.type === "music-guess") {
    drawMusicGuess(m, seg, withinMs);
    return;
  }
  if (seg.type === "guess") drawGuess(m, seg, withinMs);
  else if (seg.type === "music-reveal")
    drawMusicReveal(m, seg.itemIdx, withinMs);
  else if (seg.type === "flag-guess") drawFlagGuess(m, seg, withinMs);
  else if (seg.type === "flag-reveal")
    drawFlagReveal(m, seg.itemIdx, withinMs);
  else if (seg.type === "synopsis-guess")
    drawSynopsisGuess(m, seg, withinMs);
  else drawReveal(m, seg.itemIdx, withinMs);
}
