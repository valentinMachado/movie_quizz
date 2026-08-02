import { ctx, RS } from "../state.js";

export function drawCover(img, x, y, w, h) {
  const ir = img.width / img.height,
    cr = w / h;
  let sw, sh, sx, sy;
  if (ir > cr) {
    sh = img.height;
    sw = sh * cr;
    sy = 0;
    sx = (img.width - sw) / 2;
  } else {
    sw = img.width;
    sh = sw / cr;
    sx = 0;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

// dessine l'image ENTIÈRE sans rien recadrer (contain-fit) — le fond
// est comblé par une version recadrée + assombrie de la même image,
// pour éviter des bandes noires nues (surtout utile pour les portraits
// d'acteurs qui se faisaient couper en haut/bas avec un simple cover-fit)
export function drawContain(img, x, y, w, h) {
  drawCover(img, x, y, w, h);
  ctx.fillStyle = "rgba(10,10,11,0.55)";
  ctx.fillRect(x, y, w, h);

  const ir = img.width / img.height,
    cr = w / h;
  let dw, dh, dx, dy;
  if (ir > cr) {
    dw = w;
    dh = w / ir;
    dx = x;
    dy = y + (h - dh) / 2;
  } else {
    dh = h;
    dw = h * ir;
    dy = y;
    dx = x + (w - dw) / 2;
  }
  ctx.drawImage(img, dx, dy, dw, dh);
}
// --- habillage "jeu" partagé par tous les écrans vidéo (hors splash,
// qui a le sien) : reprend la palette et les codes visuels de la page
// web (pilules translucides, dégradé cyan->violet, halo, confettis) ---

// taille de police mise à l'échelle de la résolution (voir RS) — garde
// le rendu de "moyen" identique tout en gardant "faible"/"élevé"
// proportionnels plutôt que d'utiliser la même taille absolue partout
export function gameFont(weight, size, family = "ui-monospace, Menlo, monospace") {
  return `${weight} ${Math.round(size * RS)}px ${family}`;
}

export function roundedRectPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// courbe d'accélération "élastique" pour l'entrée du logo au splash
export function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// découpe `text` en lignes qui tiennent chacune dans `maxWidth`, avec
// la police déjà active sur `ctx` au moment de l'appel — mot par mot,
// pas de coupure au milieu d'un mot
export function wrapText(text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// dessine un poster/pochette avec coins arrondis + ombre portée
// correcte (l'ombre est dessinée séparément, avant le clip, sinon le
// clip aux coins arrondis coupe aussi l'ombre) + liseré violet
export function drawFramedImage(img, dx, dy, dw, dh, radius = 18 * RS) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 30 * RS;
  ctx.fillStyle = "#000";
  roundedRectPath(dx, dy, dw, dh, radius);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundedRectPath(dx, dy, dw, dh, radius);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();

  ctx.save();
  roundedRectPath(dx, dy, dw, dh, radius);
  ctx.lineWidth = 3 * RS;
  ctx.strokeStyle = "rgba(157,92,230,0.6)";
  ctx.stroke();
  ctx.restore();
}
