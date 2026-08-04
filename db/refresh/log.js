// ---------- logs ----------
//
// LOG_LEVEL (env, défaut "info") : error < warn < info < debug. "info" ne
// garde que les résumés (un type/warm-loop terminé, une erreur qui a fait
// perdre des données) — c'est le niveau pm2 en continu. "debug" ajoute le
// détail par item/page/source (retries réseau, échecs individuels d'un warm
// loop) : à activer ponctuellement (LOG_LEVEL=debug npm run refresh) pour
// creuser un échec précis, pas à laisser en continu.
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

function log(level, ...args) {
  if (LOG_LEVELS[level] > LOG_LEVEL) return;
  const prefix = `${new Date().toISOString()} [${level.toUpperCase()}]`;
  const out =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  out(prefix, ...args);
}
// Bannière verte, volontairement voyante : marque un jalon qu'on doit pouvoir
// repérer d'un coup d'œil dans un log qui a défilé pendant des heures (voir
// la fin de refreshTypes). Couleur seulement sur un vrai terminal — redirigé
// vers un fichier ou dans pm2, les séquences ANSI ne feraient que polluer.
const GREEN = process.stdout.isTTY ? "\x1b[1;32m" : "";
const RESET = process.stdout.isTTY ? "\x1b[0m" : "";
export function logBanner(lines) {
  const rule = "=".repeat(74);
  log(
    "info",
    `\n${GREEN}${rule}\n${lines.map((l) => (l ? `  ${l}` : "")).join("\n")}\n${rule}${RESET}`,
  );
}

export const logError = (...args) => log("error", ...args);
export const logWarn = (...args) => log("warn", ...args);
export const logInfo = (...args) => log("info", ...args);
export const logDebug = (...args) => log("debug", ...args);
