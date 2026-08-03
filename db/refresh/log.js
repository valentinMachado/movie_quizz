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
export const logError = (...args) => log("error", ...args);
export const logWarn = (...args) => log("warn", ...args);
export const logInfo = (...args) => log("info", ...args);
export const logDebug = (...args) => log("debug", ...args);
