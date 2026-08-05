import {
  appVersion,
  serverStatusLed,
  statsLine,
  statusEl,
  progressBar,
  progressPct,
  phasesEl,
  phaseEls,
} from "./dom.js";

export async function refreshStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();
    if (data.version) appVersion.textContent = `v${data.version}`;
    serverStatusLed.className =
      "status-led " + (data.ready ? "led-green" : "led-red");
    serverStatusLed.title = data.ready
      ? "Serveur prêt : réservoir et caches à jour"
      : "Serveur en préparation : réservoir ou caches encore en cours de chauffe";
    statsLine.textContent = `Quiz générés au total : ${data.totalGenerated}`;
    // tant que ce n'est pas prêt, on revérifie régulièrement pour que
    // la LED passe au vert toute seule sans que l'utilisateur recharge
    if (!data.ready) setTimeout(refreshStats, 20000);
  } catch {
    statsLine.textContent = "Quiz générés au total : —";
    serverStatusLed.className = "status-led led-red";
  }
}

export function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}
export function setProgress(pct) {
  progressBar.style.width = pct + "%";
  progressPct.textContent = Math.round(pct) + " %";
}

// jalons de génération. La barre de progression seule balaie 0→100 deux
// fois (préchargement puis encodage, voir preload.js/encode.js) : sans ces
// trois repères, impossible de savoir laquelle des deux passes est en
// cours. L'ordre ci-dessous est celui de generateQuiz (main.js).
const PHASE_ORDER = ["fetch", "preload", "render"];

export function resetPhases() {
  phasesEl.classList.add("show");
  for (const key of PHASE_ORDER) {
    phaseEls[key].classList.remove("active", "done");
  }
  progressPct.textContent = "";
}

export function setPhase(key) {
  const idx = PHASE_ORDER.indexOf(key);
  PHASE_ORDER.forEach((k, i) => {
    phaseEls[k].classList.toggle("done", i < idx);
    phaseEls[k].classList.toggle("active", i === idx);
  });
}

// génération interrompue : on fige le jalon en cours plutôt que de le
// laisser pulser indéfiniment, tout en gardant visible où ça s'est arrêté
export function haltPhases() {
  for (const key of PHASE_ORDER) phaseEls[key].classList.remove("active");
}

// fin de parcours : tout coché, plus rien d'"actif" qui clignote
export function completePhases() {
  for (const key of PHASE_ORDER) {
    phaseEls[key].classList.remove("active");
    phaseEls[key].classList.add("done");
  }
}
