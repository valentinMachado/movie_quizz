import { canvas, ctx, RS } from "../state.js";
import { drawCover, gameFont, roundedRectPath } from "./primitives.js";

// --- habillage "jeu" partagé par tous les écrans vidéo (hors splash,
// qui a le sien) : reprend la palette et les codes visuels de la page
// web (pilules translucides, dégradé cyan->violet, halo, confettis) ---

// fond dégradé sombre + confettis, pour les écrans où l'arrière-plan
// est visible (réponse, musique) — le splash a sa propre variante animée
export function drawGameBackdrop() {
  const bg = ctx.createRadialGradient(
    canvas.width / 2,
    canvas.height * 0.4,
    60 * RS,
    canvas.width / 2,
    canvas.height * 0.4,
    canvas.width * 0.75,
  );
  bg.addColorStop(0, "#201c30");
  bg.addColorStop(1, "#0a0a10");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

export function drawGameParticles(elapsedMs) {
  for (const p of GAME_PARTICLES) drawGameParticle(p, elapsedMs);
}

// halo lumineux pulsant (cyan -> violet), pour mettre en valeur un
// élément central (poster, pochette…) comme sur le splash
export function drawGlowBurst(cx, cy, elapsedMs, baseR = 260) {
  const pulse = 0.8 + 0.2 * Math.sin(elapsedMs / 900);
  const r = baseR * RS * pulse;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  glow.addColorStop(0, "rgba(79,209,232,0.3)");
  glow.addColorStop(0.55, "rgba(157,92,230,0.16)");
  glow.addColorStop(1, "rgba(157,92,230,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

// pilule translucide façon UI web (chip / badge de version) — sert de
// compteur "N° x/y" ou toute étiquette courte
export function drawBadge(text, x, y, opts = {}) {
  const {
    align = "left",
    font = gameFont(700, 24),
    fg = "#ede8de",
    border = "rgba(157,92,230,0.6)",
    bg = "rgba(18,16,28,0.72)",
    paddingX = 20 * RS,
    paddingY = 11 * RS,
  } = opts;
  ctx.save();
  ctx.font = font;
  const textW = ctx.measureText(text).width;
  const w = textW + paddingX * 2;
  const h = paddingY * 2 + 22 * RS;
  const bx =
    align === "right" ? x - w : align === "center" ? x - w / 2 : x;
  const by = y - h / 2;
  roundedRectPath(bx, by, w, h, h / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 2 * RS;
  ctx.strokeStyle = border;
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, bx + w / 2, by + h / 2 + 1 * RS);
  ctx.restore();
}

// bannière "RÉPONSE" façon jeu télévisé (pilule dégradée + halo)
export function drawRevealBanner(centerX, y) {
  ctx.save();
  ctx.font = gameFont(800, 26);
  const text = "RÉPONSE";
  const textW = ctx.measureText(text).width;
  const w = textW + 74 * RS;
  const h = 48 * RS;
  roundedRectPath(centerX - w / 2, y - h / 2, w, h, h / 2);
  const grad = ctx.createLinearGradient(
    centerX - w / 2,
    0,
    centerX + w / 2,
    0,
  );
  grad.addColorStop(0, "#4fd1e8");
  grad.addColorStop(1, "#9d5ce6");
  ctx.fillStyle = grad;
  ctx.shadowColor = "rgba(157,92,230,0.5)";
  ctx.shadowBlur = 20 * RS;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#0a0a10";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, centerX, y + 2 * RS);
  ctx.restore();
}

// liseré décoratif en dégradé, dessiné en dernier sur chaque écran non-
// splash pour rappeler la bordure lumineuse du panneau sur la page web
export function drawFrameBorder() {
  ctx.save();
  const inset = 10 * RS;
  roundedRectPath(
    inset,
    inset,
    canvas.width - inset * 2,
    canvas.height - inset * 2,
    24 * RS,
  );
  const grad = ctx.createLinearGradient(
    0,
    0,
    canvas.width,
    canvas.height,
  );
  grad.addColorStop(0, "rgba(79,209,232,0.4)");
  grad.addColorStop(0.5, "rgba(157,92,230,0.4)");
  grad.addColorStop(1, "rgba(232,163,61,0.4)");
  ctx.lineWidth = 4 * RS;
  ctx.strokeStyle = grad;
  ctx.stroke();
  ctx.restore();
}

// barre de progression façon jauge de jeu : piste sombre, remplissage
// en dégradé cyan -> violet avec un léger halo, extrémités arrondies
export function drawGameProgress(frac, width, y = 46 * RS, h = 14 * RS) {
  const w = width || canvas.width;
  const pad = 24 * RS;
  const barW = w - pad * 2;
  ctx.save();
  roundedRectPath(pad, y, barW, h, h / 2);
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fill();
  const fillW = Math.max(h, barW * Math.min(1, Math.max(0, frac)));
  roundedRectPath(pad, y, fillW, h, h / 2);
  const grad = ctx.createLinearGradient(pad, 0, pad + fillW, 0);
  grad.addColorStop(0, "#4fd1e8");
  grad.addColorStop(1, "#9d5ce6");
  ctx.fillStyle = grad;
  ctx.shadowColor = "rgba(79,209,232,0.55)";
  ctx.shadowBlur = 12 * RS;
  ctx.fill();
  ctx.restore();
}

export function drawSideThumbnails(m, upToIdx, colX, colW) {
  // miniatures 3x plus grandes, centrées dans leur propre colonne,
  // coins arrondis + liseré qui alterne cyan/violet façon petites cartes
  const thumbW = 240 * RS,
    thumbH = 135 * RS,
    gap = 14 * RS,
    startY = 50 * RS,
    r = 14 * RS,
    m4 = 4 * RS,
    m8 = 8 * RS;
  const x = colX + (colW - thumbW) / 2;
  // au-delà de ce que la colonne peut afficher, on montre les plus
  // récentes plutôt que de rester bloqué sur les toutes premières
  const maxVisible = Math.max(
    0,
    Math.floor((canvas.height - 40 * RS - startY) / (thumbH + gap)),
  );
  const start = Math.max(0, upToIdx - maxVisible);
  for (let j = start; j < upToIdx; j++) {
    const y = startY + (j - start) * (thumbH + gap);
    ctx.save();
    ctx.globalAlpha = 0.9;
    roundedRectPath(x - m4, y - m4, thumbW + m8, thumbH + m8, r + m4);
    ctx.fillStyle = "#111113";
    ctx.fill();
    ctx.save();
    roundedRectPath(x, y, thumbW, thumbH, r);
    ctx.clip();
    drawCover(m.backdropImgs[j], x, y, thumbW, thumbH);
    ctx.restore();
    roundedRectPath(x, y, thumbW, thumbH, r);
    ctx.lineWidth = 2.5 * RS;
    ctx.strokeStyle = j % 2 === 0 ? "#4fd1e8" : "#9d5ce6";
    ctx.stroke();
    ctx.restore();
  }
}

// confettis décoratifs (splash ET écrans réponse/musique) : positions/
// couleurs/phases fixées une seule fois au chargement (pas à chaque
// frame) pour une animation stable, qui reprend les formes/couleurs du
// logo (triangles, losanges, ronds cyan/violet/ambre)
export const GAME_PARTICLES = Array.from({ length: 18 }, (_, i) => ({
  xFrac: Math.random(),
  yFrac: Math.random(),
  size: 5 + Math.random() * 12,
  color: ["#4fd1e8", "#9d5ce6", "#e8a33d"][i % 3],
  phase: Math.random() * Math.PI * 2,
  driftPx: 14 + Math.random() * 18,
  driftMs: 1800 + Math.random() * 1600,
  rot: Math.random() * Math.PI * 2,
  rotSpeed: (Math.random() - 0.5) * 0.0015,
  shape: i % 3 === 0 ? "triangle" : i % 3 === 1 ? "circle" : "diamond",
}));

export function drawGameParticle(p, elapsedMs) {
  const x = p.xFrac * canvas.width;
  const y =
    p.yFrac * canvas.height +
    Math.sin(elapsedMs / p.driftMs + p.phase) * p.driftPx * RS;
  const rot = p.rot + elapsedMs * p.rotSpeed;
  const alpha = 0.18 + 0.12 * Math.sin(elapsedMs / 900 + p.phase);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.fillStyle = p.color;
  const s = p.size * RS;
  if (p.shape === "triangle") {
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.87, s * 0.5);
    ctx.lineTo(-s * 0.87, s * 0.5);
    ctx.closePath();
    ctx.fill();
  } else if (p.shape === "diamond") {
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s, 0);
    ctx.lineTo(0, s);
    ctx.lineTo(-s, 0);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// petit visualiseur "égaliseur" pour l'écran musique, purement
// décoratif (basé sur des sinusoïdes déphasées par barre, pas une
// vraie analyse audio) mais donne un vrai feeling "jeu musical"
export function drawEqualizer(centerX, centerY, elapsedMs, barCount = 9) {
  const barW = 20 * RS,
    gap = 12 * RS,
    maxH = 130 * RS;
  const totalW = barCount * barW + (barCount - 1) * gap;
  const startX = centerX - totalW / 2;
  const colors = ["#4fd1e8", "#9d5ce6", "#e8a33d"];
  for (let i = 0; i < barCount; i++) {
    const freq = 240 + i * 53;
    const phase = i * 1.7;
    const t = (Math.sin(elapsedMs / freq + phase) + 1) / 2;
    const h = 16 * RS + t * maxH;
    const x = startX + i * (barW + gap);
    const y = centerY - h / 2;
    roundedRectPath(x, y, barW, h, barW / 2);
    ctx.fillStyle = colors[i % colors.length];
    ctx.fill();
  }
}
