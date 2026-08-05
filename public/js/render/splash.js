import { TYPE_BASE_LABELS, TYPE_EMOJI, questionTypeInfo } from "../config.js";
import { canvas, ctx, RS, state } from "../state.js";
import { baseFilterKey } from "../filters.js";
import { GAME_PARTICLES, drawGameParticle } from "./chrome.js";
import { easeOutBack, gameFont, roundedRectPath } from "./primitives.js";

function contentTypeLabel() {
  const types = new Set(state.items.map((m) => m.type));
  if (types.size === 1) {
    const labels = {
      movie: "FILMS",
      tv: "SÉRIES",
      person: "PERSONNES",
      game: "JEUX",
      country: "PAYS",
      painter: "PEINTRES",
      director: "RÉALISATEURS",
      flag: "DRAPEAUX",
      wiki_article: "WIKIPÉDIA",
      pokemon: "POKÉMON",
      superhero: "SUPER-HÉROS",
    };
    return labels[[...types][0]] || "TITRES";
  }
  return "TITRES";
}

// splash animé : logo qui "rebondit" à l'entrée puis flotte doucement,
// halo pulsant façon jeu, confettis en fond, sous-titre qui apparaît
// une fois le logo posé — repli en texte simple si le logo n'a pas pu
// charger
export function drawSplash(elapsedMs) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

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

  for (const p of GAME_PARTICLES) drawGameParticle(p, elapsedMs);

  const centerX = canvas.width / 2;
  const centerY = canvas.height * 0.42;

  const glowPulse = 0.75 + 0.25 * Math.sin(elapsedMs / 700);
  const glowR = 230 * RS * glowPulse;
  const glow = ctx.createRadialGradient(
    centerX,
    centerY,
    0,
    centerX,
    centerY,
    glowR,
  );
  glow.addColorStop(0, "rgba(79,209,232,0.35)");
  glow.addColorStop(0.55, "rgba(157,92,230,0.18)");
  glow.addColorStop(1, "rgba(157,92,230,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(centerX, centerY, glowR, 0, Math.PI * 2);
  ctx.fill();

  if (state.logoImg) {
    const enterT = Math.min(1, elapsedMs / 700);
    const eased = easeOutBack(enterT);
    const baseSize = 300 * RS;
    const scale = 0.3 + 0.7 * eased;
    const idleT = Math.max(0, elapsedMs - 700);
    const bobY = enterT >= 1 ? Math.sin(idleT / 450) * 7 * RS : 0;
    const rot =
      enterT < 1 ? (1 - enterT) * -0.16 : Math.sin(idleT / 750) * 0.025;
    const alpha = Math.min(1, elapsedMs / 220);

    const ir = state.logoImg.width / state.logoImg.height;
    const h = baseSize * scale;
    const w = h * ir;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(centerX, centerY + bobY);
    ctx.rotate(rot);
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 28 * RS;
    ctx.shadowOffsetY = 10 * RS;
    ctx.drawImage(state.logoImg, -w / 2, -h / 2, w, h);
    ctx.restore();
  } else {
    ctx.font = gameFont(800, 64);
    ctx.fillStyle = "#ede8de";
    ctx.textAlign = "center";
    ctx.fillText("GUESS IT", centerX, centerY);
  }

  const subT = Math.max(0, Math.min(1, (elapsedMs - 900) / 400));
  if (subT > 0) {
    ctx.save();
    ctx.globalAlpha = subT;
    const slideY = (1 - subT) * 16 * RS;
    ctx.font = gameFont(700, 30);
    ctx.fillStyle = "#ede8de";
    ctx.textAlign = "center";
    ctx.fillText(
      `${state.items.length} ${contentTypeLabel()} À DEVINER`,
      centerX,
      canvas.height * 0.74 + slideY,
    );
    ctx.restore();
  }

  drawSplashInfoChips(elapsedMs);
}

// pilules façon chips de l'écran de config, réparties sur une ou
// plusieurs lignes centrées ; au-delà de maxChips, le reste est
// condensé en une pilule "+N". Retourne le bas (Y) de la dernière
// ligne dessinée, pour pouvoir empiler une rangée suivante dessous.
function drawChipRow(
  labels,
  startY,
  elapsedMs,
  appearDelayMs,
  fillColor,
  strokeColor,
  maxChips,
  fontSize = 20,
  h = 36 * RS,
) {
  if (labels.length === 0) return startY;

  const appearT = Math.max(
    0,
    Math.min(1, (elapsedMs - appearDelayMs) / 500),
  );
  if (appearT <= 0) return startY;

  const shown = labels.slice(0, maxChips);
  const extra = labels.length - shown.length;

  const font = gameFont(700, fontSize);
  const paddingX = 16 * RS,
    gapX = 10 * RS,
    gapY = 10 * RS;
  ctx.font = font;
  const chips = shown.map((text) => ({
    text,
    w: ctx.measureText(text).width + paddingX * 2,
    extra: false,
  }));
  if (extra > 0) {
    const text = `+${extra}`;
    chips.push({
      text,
      w: ctx.measureText(text).width + paddingX * 2,
      extra: true,
    });
  }

  // répartit les pilules sur des lignes qui ne dépassent pas la
  // largeur dispo, centrées horizontalement
  const maxRowWidth = canvas.width - 160 * RS;
  const rows = [];
  let row = [],
    rowW = 0;
  for (const chip of chips) {
    const addW = chip.w + (row.length ? gapX : 0);
    if (row.length && rowW + addW > maxRowWidth) {
      rows.push(row);
      row = [];
      rowW = 0;
    }
    row.push(chip);
    rowW += chip.w + (row.length > 1 ? gapX : 0);
  }
  if (row.length) rows.push(row);

  const rowStartY = startY + (1 - appearT) * 12 * RS;
  ctx.save();
  ctx.globalAlpha = appearT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  rows.forEach((r, ri) => {
    const rowWidth = r.reduce(
      (s, c, i) => s + c.w + (i > 0 ? gapX : 0),
      0,
    );
    let x = canvas.width / 2 - rowWidth / 2;
    const y = rowStartY + ri * (h + gapY);
    for (const chip of r) {
      roundedRectPath(x, y - h / 2, chip.w, h, h / 2);
      ctx.fillStyle = chip.extra ? "rgba(157,92,230,0.2)" : fillColor;
      ctx.fill();
      ctx.lineWidth = 1.5 * RS;
      ctx.strokeStyle = chip.extra
        ? "rgba(157,92,230,0.6)"
        : strokeColor;
      ctx.stroke();
      ctx.font = font;
      ctx.fillStyle = "#ede8de";
      ctx.fillText(chip.text, x + chip.w / 2, y + 1 * RS);
      x += chip.w + gapX;
    }
  });
  ctx.restore();

  return rowStartY + rows.length * (h + gapY) - gapY;
}

// libellés des combinaisons "type:questionType" actives, mêmes
// libellés que la rangée "Type" de l'écran de config (voir
// renderContentTypeChips) — rappelle sur le splash ce qui a été
// choisi pour générer ce quiz
// dérivé de state.items (le quiz réellement généré), pas de
// state.activeQuestionTypes (les cases cochées côté UI manuelle) : pour le
// quiz du jour, ces cases n'ont jamais été touchées et gardent leur dernière
// valeur (voire leur défaut) sans rapport avec le contenu réel du quiz —
// afficher state.items évite cet écart, y compris pour le quiz manuel si un
// filtre vide fait retomber sur un autre bucket que celui coché.
function splashTypeLabels() {
  const combos = new Set(
    state.items.map(
      (m) => `${m.type}:${m.questionType || (m.type === "music" ? "audio" : "image")}`,
    ),
  );
  return [...combos].map((combo) => {
    const [type, qt] = combo.split(":");
    const baseLabel = TYPE_BASE_LABELS[type] || type;
    const info = questionTypeInfo(type, qt);
    return `${baseLabel} ${info.icon || ""} ${info.label || qt}`.trim();
  });
}

// libellés des filtres utilisés — un par filtre de base même si
// plusieurs questionType y sont sélectionnés (le filtre affiché est
// le même quel que soit le mode, voir baseFilterKey) ; vide si aucun
// filtre (= toutes les réponses possibles, rien à afficher)
function splashFilterLabels() {
  const bases = new Set([...state.selectedFilters].map(baseFilterKey));
  return state.availableFilters
    .filter((f) => bases.has(f.key))
    .map((f) => `${TYPE_EMOJI[f.type] || ""} ${f.label}`.trim());
}

// deux rangées de pilules en bas du splash : les types de question
// actifs (toujours au moins un), puis en dessous les filtres de
// catégorie s'il y en a — la rangée des filtres démarre juste sous
// celle des types, quelle que soit sa hauteur (1 ou 2 lignes)
function drawSplashInfoChips(elapsedMs) {
  const typeBottom = drawChipRow(
    splashTypeLabels(),
    canvas.height * 0.79,
    elapsedMs,
    1000,
    "rgba(232,163,61,0.16)",
    "rgba(232,163,61,0.6)",
    6,
    17,
    30 * RS,
  );
  drawChipRow(
    splashFilterLabels(),
    Math.max(typeBottom + 14 * RS, canvas.height * 0.87),
    elapsedMs,
    1250,
    "rgba(79,209,232,0.14)",
    "rgba(79,209,232,0.55)",
    8,
  );
}
