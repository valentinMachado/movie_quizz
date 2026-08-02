import {
  appVersion,
  serverStatusLed,
  statsLine,
  statusEl,
  progressBar,
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
}
