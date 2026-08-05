// petite explosion de confettis à la fin d'un rendu réussi — purement
// décoratif, aucun état : la couche est créée, animée en CSS puis retirée.
// Volontairement hors de #stage, que resetStage()/renderFast() vident.
const COLORS = ["#4fd1e8", "#9d5ce6", "#e8a33d", "#4c8a5c", "#ede8de"];
const PIECES = 46;

// Appelé quand le quiz devient réellement jouable — pas à la fin du rendu
// (ça ferait croire qu'il fallait l'attendre) ni au premier loadeddata (une
// fraction de seconde en tampon, bien trop tôt). Voir onPreviewReady dans
// encode.js, qui n'annonce qu'une fois la lecture garantie sans calage.
export function celebrate() {
  // même intention que la règle CSS globale prefers-reduced-motion : ici
  // il n'y a rien à ralentir, on s'abstient simplement
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const layer = document.createElement("div");
  layer.className = "confetti-layer";
  layer.setAttribute("aria-hidden", "true");

  let maxEndMs = 0;
  for (let i = 0; i < PIECES; i++) {
    const p = document.createElement("i");
    p.className = "confetti-piece";
    const delay = Math.random() * 0.35;
    const dur = 1.9 + Math.random() * 1.1;
    maxEndMs = Math.max(maxEndMs, (delay + dur) * 1000);
    p.style.setProperty("--x", Math.random() * 100 + "vw");
    p.style.setProperty("--dx", (Math.random() * 2 - 1) * 16 + "vw");
    p.style.setProperty("--rot", Math.random() * 900 - 450 + "deg");
    p.style.setProperty("--delay", delay + "s");
    p.style.setProperty("--dur", dur + "s");
    p.style.background = COLORS[i % COLORS.length];
    if (i % 3 === 0) p.style.borderRadius = "50%";
    layer.appendChild(p);
  }

  document.body.appendChild(layer);
  // +200ms de marge : la couche doit disparaître APRÈS la dernière pièce,
  // sinon on tronque l'animation la plus tardive
  setTimeout(() => layer.remove(), maxEndMs + 200);
}
