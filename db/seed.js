// Instantané de cache/data.sqlite versionné dans le dépôt (Git LFS).
//
// Le point de départ : construire la base sur la VM est intenable (des
// heures de crawl, ~5 Go de dumps Wikimedia, un tas V8 à border sur 1 Go de
// RAM). La construction reste donc entièrement locale — `npm run refresh`
// n'a pas changé — et son RÉSULTAT voyage par le dépôt : la VM ne fait plus
// que décompresser un fichier et suivre les listes Populaire/Tendances
// (db/refresh.js --lists-only).
//
//   npm run seed              # cache/data.sqlite -> dist/data.sqlite.gz (local)
//   node db/seed.js check     # exit 0 = il y a quelque chose à installer
//   node db/seed.js install   # dist/data.sqlite.gz -> cache/data.sqlite (VM)
//
// Options : --db=<path> (base source/cible), --dist=<dir>, --force.
//
// `check`/`install` sont appelés par deploy.sh ; `check` ne lit que les deux
// manifestes JSON (aucun accès SQLite), il peut donc tourner avant npm ci.

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { logError, logInfo, logWarn, logBanner } from "./refresh/log.js";

const ROOT = process.cwd();
const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const DB_PATH = path.resolve(ROOT, arg("db", path.join("cache", "data.sqlite")));
const DIST_DIR = path.resolve(ROOT, arg("dist", "dist"));
const ARCHIVE = path.join(DIST_DIR, "data.sqlite.gz");
const MANIFEST = path.join(DIST_DIR, "seed.json");
// témoin de ce qui est RÉELLEMENT installé dans cache/ (donc hors dépôt,
// cache/ étant gitignoré) : c'est lui qui permet à `check` de répondre sans
// décompresser 150 Mo pour comparer.
const INSTALLED = path.join(path.dirname(DB_PATH), "seed.json");
const FORCE = process.argv.includes("--force");

const APP_VERSION = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf8"),
).version;

const mo = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} Mo`;

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Un dépôt cloné sans `git lfs pull` laisse à la place de l'archive un
// pointeur texte de quelques centaines d'octets. Sans ce garde-fou, l'erreur
// remonterait sous la forme d'un "incorrect header check" de zlib, illisible.
// `check` répond par son code de sortie, lu tel quel par deploy.sh : 0 « il y
// a une base à installer », 1 « déjà à jour » — et 2, distinct des deux, pour
// tout ce qui n'est ni l'un ni l'autre (archive absente, pointeur LFS non
// résolu, empreinte fausse). Sans ce troisième code, un dépôt sans git-lfs
// passerait pour « déjà à jour » et le déploiement continuerait en silence.
const EXIT_PROBLEM = 2;

function assertNotLfsPointer(file) {
  const size = statSync(file).size;
  if (size > 1024) return;
  const head = readFileSync(file, "utf8").slice(0, 64);
  if (!head.startsWith("version https://git-lfs")) return;
  logError(
    `${path.relative(ROOT, file)} n'est qu'un pointeur Git LFS (${size} octets), pas l'archive.`,
  );
  logError("  git lfs install && git lfs pull   (paquet git-lfs requis)");
  process.exit(EXIT_PROBLEM);
}

// ---------- build (local) ----------

async function build() {
  if (!existsSync(DB_PATH)) {
    logError(`${path.relative(ROOT, DB_PATH)} introuvable — rien à empaqueter.`);
    process.exit(1);
  }
  mkdirSync(DIST_DIR, { recursive: true });

  const snapshot = path.join(DIST_DIR, "data.sqlite.tmp");
  rmSync(snapshot, { force: true });

  // VACUUM INTO plutôt qu'une copie de fichier : donne un instantané
  // COHÉRENT même si refresh.js tourne encore (le -wal en cours est intégré
  // au passage), et compacte la base au lieu d'emporter ses pages libres.
  logInfo(`Instantané de ${path.relative(ROOT, DB_PATH)}…`);
  const source = new Database(DB_PATH);
  source.prepare("VACUUM INTO ?").run(snapshot);
  source.close();

  // api_cache est purement interne au crawl (db/cache.js, appelé seulement
  // par db/refresh/*.js) : le serveur ne le lit jamais, et sur la VM en mode
  // --lists-only il ne servirait qu'à porter des réponses HTTP déjà
  // expirées. Autant ne pas les faire voyager.
  const snap = new Database(snapshot);
  snap.exec("DELETE FROM api_cache");
  snap.exec("VACUUM");
  const counts = Object.fromEntries(
    snap
      .prepare("SELECT type, COUNT(*) n FROM type_item GROUP BY type ORDER BY type")
      .all()
      .map((r) => [r.type, r.n]),
  );
  snap.close();

  const bytes = statSync(snapshot).size;
  const hash = await sha256(snapshot);

  logInfo(`Compression (${mo(bytes)})…`);
  const tmpArchive = `${ARCHIVE}.tmp`;
  await pipeline(
    createReadStream(snapshot),
    createGzip({ level: 9 }),
    createWriteStream(tmpArchive),
  );
  rmSync(snapshot, { force: true });
  renameSync(tmpArchive, ARCHIVE);

  const gzBytes = statSync(ARCHIVE).size;
  writeFileSync(
    MANIFEST,
    `${JSON.stringify(
      { appVersion: APP_VERSION, builtAt: new Date().toISOString(), sha256: hash, bytes, gzBytes, counts },
      null,
      2,
    )}\n`,
  );

  logBanner([
    `SEED PRÊT — ${path.relative(ROOT, ARCHIVE)} : ${mo(gzBytes)} compressés`,
    `(${mo(bytes)} une fois installés), version ${APP_VERSION}.`,
    "",
    Object.entries(counts)
      .map(([t, n]) => `${t} ${n}`)
      .join(" · "),
    "",
    "À pousser pour que la VM le voie :",
    "  git add dist && git commit -m \"seed\" && git push",
    "",
    "Puis, sur la VM : ./deploy.sh",
  ]);
}

// ---------- check / install (VM) ----------

function pending() {
  for (const file of [ARCHIVE, MANIFEST]) {
    if (existsSync(file)) continue;
    logError(`${path.relative(ROOT, file)} absent — la base n'a jamais été empaquetée.`);
    logError("  En local : npm run seed, puis git add dist && git commit && git push.");
    process.exit(EXIT_PROBLEM);
  }
  assertNotLfsPointer(ARCHIVE);
  const wanted = readJson(MANIFEST);
  if (!wanted?.sha256) {
    logError(`${path.relative(ROOT, MANIFEST)} illisible ou sans empreinte.`);
    process.exit(EXIT_PROBLEM);
  }
  if (FORCE) return wanted;
  const installed = readJson(INSTALLED);
  if (installed?.sha256 === wanted.sha256 && existsSync(DB_PATH)) return null;
  return wanted;
}

function check() {
  const wanted = pending();
  if (!wanted) {
    logInfo("Base déjà à jour (rien à installer).");
    process.exit(1);
  }
  logInfo(
    `Base à installer : version ${wanted.appVersion}, construite le ${wanted.builtAt} (${mo(wanted.gzBytes)}).`,
  );
  process.exit(0);
}

async function install() {
  const wanted = pending();
  if (!wanted) {
    logInfo("Base déjà à jour, installation ignorée (--force pour forcer).");
    return;
  }

  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.tmp`;
  rmSync(tmp, { force: true });

  logInfo(`Décompression vers ${path.relative(ROOT, tmp)} (${mo(wanted.bytes)} attendus)…`);
  // en flux, pas en mémoire : la VM a 1 Go de RAM, l'archive fait ~150 Mo
  // une fois détendue.
  await pipeline(createReadStream(ARCHIVE), createGunzip(), createWriteStream(tmp));

  const hash = await sha256(tmp);
  if (hash !== wanted.sha256) {
    rmSync(tmp, { force: true });
    logError(`Empreinte incorrecte (attendu ${wanted.sha256.slice(0, 12)}…, obtenu ${hash.slice(0, 12)}…).`);
    logError("Archive tronquée ou corrompue — refaire un `git lfs pull`.");
    process.exit(EXIT_PROBLEM);
  }

  // La seule donnée que la VM possède et que l'instantané ne connaît pas :
  // le compteur de quiz générés (stat_total, écrit par server.js). Tout le
  // reste de la base est reconstruit localement, `daily` est calculé à la
  // volée. Sans ce report, chaque déploiement remettrait le compteur à la
  // valeur qu'il avait sur ma machine.
  if (existsSync(DB_PATH)) {
    try {
      const old = new Database(DB_PATH, { readonly: true });
      const kept = old.prepare("SELECT total_generated FROM stat_total WHERE id = 1").get();
      old.close();
      if (kept?.total_generated) {
        const fresh = new Database(tmp);
        fresh
          .prepare("UPDATE stat_total SET total_generated = MAX(total_generated, ?) WHERE id = 1")
          .run(kept.total_generated);
        fresh.close();
        logInfo(`Compteur de quiz générés conservé (${kept.total_generated}).`);
      }
    } catch (e) {
      logWarn(`Compteur de quiz non repris (${e.message}) — sans gravité.`);
    }
  }

  // -wal/-shm de l'ANCIENNE base : laissés en place, SQLite les rejouerait
  // sur le nouveau fichier, dont ils ne décrivent rien. Ils partent donc
  // avec elle. Ça suppose qu'aucun process ne tient la base ouverte —
  // deploy.sh arrête server.js et refresh.js avant d'appeler `install`.
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB_PATH}${suffix}`, { force: true });
  renameSync(tmp, DB_PATH);
  writeFileSync(INSTALLED, `${JSON.stringify(wanted, null, 2)}\n`);

  logInfo(
    `Base installée : ${path.relative(ROOT, DB_PATH)} (${mo(wanted.bytes)}, version ${wanted.appVersion}).`,
  );
}

// ---------- entrée ----------

const command = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "build";
const commands = { build, check, install };
if (!commands[command]) {
  logError(`Commande inconnue : ${command} (build | check | install).`);
  process.exit(1);
}
await commands[command]();
