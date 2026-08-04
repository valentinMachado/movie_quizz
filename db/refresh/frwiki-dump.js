import Database from "better-sqlite3";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createGunzip } from "node:zlib";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import wtf from "wtf_wikipedia";
import * as db from "../index.js";
import { logDebug, logInfo, logWarn } from "./log.js";
import { mapWithConcurrency } from "./util.js";
import { FRWIKI_DUMP_ENABLED, WIKI_ARTICLE_LANG } from "./config.js";

// Dumps Wikimedia — remplace par des lectures locales les appels MediaWiki
// qui demandent de la structure (quelle page est dans quelle catégorie,
// quelles images sur une page, quel QID pour un article) ET, depuis
// l'ajout du dump multistream plus bas, le CONTENU des résumés. Seules les
// métadonnées d'image (dimensions, url réelle) restent en ligne — voir
// resolveImageInfoByTitle dans wikipedia.js.
//
// Trois familles de dumps, indépendantes, chacune avec son ensure* :
//   - les tables SQL ci-dessous (1,8 Go)   -> structure
//   - pageview_complete (~5 Go/mois)       -> notoriété réelle
//   - pages-articles-multistream (7,2 Go)  -> résumés, JAMAIS téléchargé en
//     entier (accès par offset de bloc, voir la section en fin de fichier)
//
// ATTENTION au schéma : MediaWiki a normalisé `categorylinks` et
// `imagelinks` — ils ne portent plus le titre de la cible (`cl_to`/`il_to`)
// mais un identifiant (`cl_target_id`/`il_target_id`) qui se résout via la
// table `linktarget`. D'où sa présence ici alors qu'elle n'apporte aucune
// donnée en propre. Vérifié en lisant le CREATE TABLE en tête de chaque
// dump ; à re-vérifier si un jour l'ingestion sort des lignes vides.

const DUMP_BASE = `https://dumps.wikimedia.org/${WIKI_ARTICLE_LANG}wiki/latest`;

// ORDRE SIGNIFICATIF : `page` en premier, il alimente le tableau de
// namespaces (voir buildIndex) qui sert à filtrer `categorylinks` au vol.
const DUMP_TABLES = [
  "page",
  "linktarget",
  "categorylinks",
  "page_props",
  "imagelinks",
  "redirect",
];

// tables qui ont besoin du tableau de namespaces pour filtrer à l'ingestion.
const NEEDS_NAMESPACE_FLAGS = new Set(["categorylinks", "page_props", "redirect"]);

// Conserver les archives après ingestion évite de re-télécharger plusieurs Go
// quand on met la mécanique au point, mais elles ne servent plus à rien une
// fois les tables construites : ~1,9 Go de .sql.gz, ~5 Go par mois de
// consultations et 64 Mo d'index multistream, sur une machine qui héberge
// aussi les ~5 Go de l'index lui-même. Passer à `true` seulement le temps d'un
// débogage, jamais en production.
const KEEP_DUMP_FILES = false;

const CACHE_DIR = path.join(process.cwd(), "cache");
const INDEX_PATH = path.join(CACHE_DIR, "frwiki-index.sqlite");

// namespaces MediaWiki : 0 = article, 6 = fichier, 14 = catégorie.
const NS_ARTICLE = 0;
const NS_FILE = 6;
const NS_CATEGORY = 14;

// Seules ces colonnes servent — le reste de chaque table est ignoré à
// l'ingestion pour que l'index reste petit (~4 Go plutôt que ~15 Go si on
// recopiait tout). Une entrée par dump : sa table SQLite et les index posés
// APRÈS son insertion en masse (un index maintenu pendant 60M d'INSERT coûte
// bien plus cher qu'un CREATE INDEX final sur la table déjà remplie).
const TABLE_DEFS = {
  page: {
    table: "fw_page",
    schema: `CREATE TABLE fw_page (
      page_id INTEGER PRIMARY KEY,
      namespace INTEGER NOT NULL,
      title TEXT NOT NULL,
      is_redirect INTEGER NOT NULL
    )`,
    indexes: ["CREATE INDEX fw_page_ns_title ON fw_page(namespace, title)"],
  },
  linktarget: {
    table: "fw_linktarget",
    schema: `CREATE TABLE fw_linktarget (
      lt_id INTEGER PRIMARY KEY,
      namespace INTEGER NOT NULL,
      title TEXT NOT NULL
    )`,
    indexes: ["CREATE INDEX fw_linktarget_ns_title ON fw_linktarget(namespace, title)"],
  },
  categorylinks: {
    table: "fw_catlink",
    schema: `CREATE TABLE fw_catlink (
      cl_from INTEGER NOT NULL,
      cl_target_id INTEGER NOT NULL,
      cl_type TEXT NOT NULL
    )`,
    indexes: ["CREATE INDEX fw_catlink_target ON fw_catlink(cl_target_id, cl_type)"],
  },
  // deux propriétés tirées du même dump : le QID Wikidata, et le nom de
  // fichier de l'image principale (page_image_free) dont on reconstruit
  // l'url de vignette hors ligne (voir thumbnailFromIndex). Une page peut
  // n'avoir que l'une des deux, d'où les colonnes nullables plutôt que deux
  // tables.
  page_props: {
    table: "fw_pageprop",
    schema: `CREATE TABLE fw_pageprop (
      pp_page INTEGER PRIMARY KEY,
      qid TEXT,
      image TEXT
    )`,
    // sens QID -> page : c'est lui qui remplace la résolution SPARQL des
    // titres FR (voir frenchTitlesByQid). Sans index, chaque résolution
    // balaie les 2,8 M de lignes — mesuré à 27 s pour 800 personnes.
    indexes: ["CREATE INDEX fw_pageprop_qid ON fw_pageprop(qid)"],
  },
  // rd_from = la page qui redirige, rd_title = l'article visé. Renversé à la
  // lecture (voir aliasesFromIndex) : tous les titres qui pointent vers un
  // article en sont autant de noms alternatifs, ce que l'API rendait via
  // prop=redirects.
  redirect: {
    table: "fw_redirect",
    schema: `CREATE TABLE fw_redirect (
      rd_from INTEGER NOT NULL,
      rd_title TEXT NOT NULL
    )`,
    indexes: ["CREATE INDEX fw_redirect_title ON fw_redirect(rd_title)"],
  },
  imagelinks: {
    table: "fw_imagelink",
    schema: `CREATE TABLE fw_imagelink (
      il_from INTEGER NOT NULL,
      il_target_id INTEGER NOT NULL
    )`,
    indexes: ["CREATE INDEX fw_imagelink_from ON fw_imagelink(il_from)"],
  },
};

// journal d'ingestion, table par table — c'est lui qui rend la construction
// incrémentale : ajouter un dump à DUMP_TABLES ne re-télécharge QUE celui-là
// (les 2h30 de construction complète ne se paient qu'à l'expiration du TTL,
// où tout est de toute façon à refaire). Une table n'y est inscrite qu'une
// fois son ingestion terminée, donc un process interrompu laisse une table
// incomplète mais NON inscrite : elle sera reconstruite au prochain passage
// (chaque ingestion commence par un DROP, voir ingestOne).
const META_SCHEMA = `CREATE TABLE IF NOT EXISTS fw_meta (
  dump_name TEXT PRIMARY KEY,
  ingested_at INTEGER NOT NULL,
  row_count INTEGER NOT NULL
)`;

// ---------- parseur de dumps mysqldump ----------

// séquences d'échappement produites par mysqldump dans les chaînes.
const UNESCAPE = {
  "0": "\0",
  b: "\b",
  n: "\n",
  r: "\r",
  t: "\t",
  Z: "\x1a",
  "\\": "\\",
  "'": "'",
  '"': '"',
};

// lit UN tuple `(…)` à partir de `start` (qui doit pointer sur la
// parenthèse ouvrante). Renvoie null si le tuple est coupé par la fin du
// tampon — l'appelant rappellera avec plus de données. Les chaînes sont
// découpées par tranches (indexOf) plutôt que caractère par caractère :
// sur des dumps de plusieurs Go, la concaténation char-par-char domine
// sinon tout le temps de traitement.
function readTuple(s, start) {
  const fields = [];
  let i = start + 1;
  let field = "";
  for (;;) {
    if (i >= s.length) return null;
    const c = s[i];
    if (c === "'") {
      i++;
      for (;;) {
        if (i >= s.length) return null;
        const quote = s.indexOf("'", i);
        const esc = s.indexOf("\\", i);
        if (quote === -1) return null;
        if (esc !== -1 && esc < quote) {
          if (esc + 1 >= s.length) return null;
          const n = s[esc + 1];
          field += s.slice(i, esc) + (UNESCAPE[n] ?? n);
          i = esc + 2;
          continue;
        }
        field += s.slice(i, quote);
        i = quote + 1;
        break;
      }
      continue;
    }
    if (c === ",") {
      fields.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === ")") {
      fields.push(field);
      return { fields, end: i };
    }
    // littéral non quoté (nombre, NULL) — jusqu'au prochain séparateur.
    let j = i;
    while (j < s.length && s[j] !== "," && s[j] !== ")" && s[j] !== "'") j++;
    if (j >= s.length) return null;
    field += s.slice(i, j);
    i = j;
  }
}

// Parcourt un dump `.sql.gz` en flux et appelle `onRow(fields)` pour chaque
// tuple de chaque `INSERT INTO … VALUES (…),(…);`. Un seul INSERT pèse
// couramment plusieurs Mo, donc pas de découpage par ligne : on garde un
// tampon glissant entre deux chunks du flux et on ne consomme que les
// tuples complets.
// exporté uniquement pour pouvoir être vérifié isolément sur un extrait de
// dump réel (le format mysqldump est la seule partie de ce module qu'une
// erreur rendrait silencieusement fausse plutôt que bruyamment cassée).
export async function streamDumpRows(gzPath, onRow) {
  const source = createReadStream(gzPath).pipe(createGunzip());
  source.setEncoding("utf8");
  const VALUES = " VALUES ";
  let buf = "";
  let inTuples = false;
  for await (const chunk of source) {
    buf += chunk;
    let i = 0;
    for (;;) {
      if (!inTuples) {
        const idx = buf.indexOf(VALUES, i);
        if (idx === -1) {
          // garde de quoi reconnaître un " VALUES " coupé en deux chunks.
          i = Math.max(i, buf.length - VALUES.length);
          break;
        }
        i = idx + VALUES.length;
        inTuples = true;
        continue;
      }
      const c = buf[i];
      if (c === undefined) break;
      if (c === "," || c === " " || c === "\n" || c === "\r") {
        i++;
        continue;
      }
      if (c === ";") {
        inTuples = false;
        i++;
        continue;
      }
      if (c !== "(") {
        // sécurité : rien d'autre n'est attendu ici, on repart en recherche
        // plutôt que de boucler sur un octet inattendu.
        inTuples = false;
        continue;
      }
      const tuple = readTuple(buf, i);
      if (!tuple) break; // tuple incomplet, on attend le chunk suivant
      onRow(tuple.fields);
      i = tuple.end + 1;
    }
    buf = buf.slice(i);
  }
}

// ---------- téléchargement ----------

const USER_AGENT_HEADERS = { "User-Agent": "GuessItQuiz/1.0 (personal project)" };

// Une connexion qui se fige SANS se fermer bloquerait indéfiniment (vu en
// vrai) : on arme un minuteur relancé à chaque paquet reçu, et on coupe s'il
// ne se passe plus rien. N'a de sens que sur la phase de téléchargement, où
// l'absence d'octets est réellement une anomalie.
const DOWNLOAD_STALL_MS = 120_000;
const DOWNLOAD_MAX_ATTEMPTS = 8;

// Télécharge vers `destPath`, avec réutilisation d'une archive déjà complète,
// journal de progression et garde-fou anti-gel. L'écriture passe par un
// `.part` renommé à la fin : un téléchargement interrompu ne peut jamais être
// pris pour un fichier complet au passage suivant.
async function downloadFile(url, destPath, label, logStepBytes = 100 * 1024 * 1024) {
  if (existsSync(destPath)) {
    const head = await fetch(url, { method: "HEAD", headers: USER_AGENT_HEADERS });
    const remote = Number(head.headers.get("content-length")) || 0;
    const local = statSync(destPath).size;
    if (remote > 0 && local === remote) {
      logInfo(`${label} : déjà téléchargé (${Math.round(local / 1e6)} Mo), réutilisé.`);
      return;
    }
    logInfo(`${label} : incomplet sur disque, retéléchargement.`);
  }

  // REPRISE OBLIGATOIRE ici : à ~2 Mo/s, 5,3 Go tiennent 45 minutes, et une
  // connexion coupée en cours (vu en vrai : "terminated" après 1 Go) ferait
  // sinon tout recommencer indéfiniment. Le `.part` est donc CONSERVÉ entre
  // deux tentatives, et même entre deux exécutions, et on redemande la suite
  // avec un en-tête Range.
  const partPath = `${destPath}.part`;
  let total = 0;

  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    const from = existsSync(partPath) ? statSync(partPath).size : 0;
    const controller = new AbortController();
    const headers = { ...USER_AGENT_HEADERS };
    if (from > 0) headers.Range = `bytes=${from}-`;

    const res = await fetch(url, { headers, signal: controller.signal });
    // 416 = on demande des octets au-delà de la fin : le .part contient déjà
    // tout le fichier. Arrive quand l'échec précédent est survenu APRÈS le
    // transfert (au renommage, par exemple) — inutile de retélécharger 5 Go.
    if (res.status === 416 && from > 0) {
      await res.body?.cancel();
      logInfo(`${label} : archive déjà complète sur disque (${(from / 1e9).toFixed(2)} Go).`);
      total = from;
      break;
    }
    if (!res.ok || !res.body) throw new Error(`${label} : HTTP ${res.status}`);
    // 206 = le serveur honore la reprise ; 200 avec un Range demandé = il
    // l'ignore et renvoie tout, il faut alors réécrire depuis le début.
    const resuming = from > 0 && res.status === 206;
    total = resuming
      ? Number(res.headers.get("content-range")?.split("/")[1]) || 0
      : Number(res.headers.get("content-length")) || 0;
    if (from > 0 && !resuming) {
      logInfo(`${label} : reprise refusée par le serveur, reprise depuis zéro.`);
    }

    let stalled = false;
    let stallTimer;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, DOWNLOAD_STALL_MS);
    };
    armStall();

    let seen = resuming ? from : 0;
    let nextLog = Math.ceil((seen + 1) / logStepBytes) * logStepBytes;
    async function* withProgress(stream) {
      for await (const chunk of stream) {
        armStall();
        seen += chunk.length;
        if (seen >= nextLog) {
          const pct = total ? ` / ${(total / 1e9).toFixed(1)} Go` : "";
          logInfo(`${label} : ${(seen / 1e9).toFixed(2)} Go téléchargés${pct}`);
          nextLog += logStepBytes;
        }
        yield chunk;
      }
    }

    try {
      await pipeline(
        withProgress(Readable.fromWeb(res.body)),
        createWriteStream(partPath, { flags: resuming ? "a" : "w" }),
      );
      break; // transfert complet
    } catch (e) {
      const reason = stalled ? `figé plus de ${DOWNLOAD_STALL_MS / 1000}s` : e.message;
      if (attempt === DOWNLOAD_MAX_ATTEMPTS) {
        throw new Error(`${label} : abandon après ${attempt} tentatives (${reason})`);
      }
      logWarn(
        `${label} : transfert interrompu à ${(seen / 1e9).toFixed(2)} Go (${reason}) — reprise ${attempt + 1}/${DOWNLOAD_MAX_ATTEMPTS} dans 5s.`,
      );
      await new Promise((r) => setTimeout(r, 5000));
    } finally {
      clearTimeout(stallTimer);
    }
  }

  // taille inattendue = fichier tronqué : on garde le .part pour la prochaine
  // reprise plutôt que de le promouvoir en archive « complète ».
  const finalSize = statSync(partPath).size;
  if (total > 0 && finalSize !== total) {
    throw new Error(`${label} : ${finalSize} octets reçus sur ${total} attendus`);
  }
  renameSync(partPath, destPath);
}

const downloadDump = (table, destPath) =>
  downloadFile(
    `${DUMP_BASE}/${WIKI_ARTICLE_LANG}wiki-latest-${table}.sql.gz`,
    destPath,
    `Dump ${WIKI_ARTICLE_LANG}wiki : ${table}`,
  );

// ---------- construction de l'index ----------

// namespace par page_id, en Uint8Array plutôt qu'un Set de 3M d'entiers
// (~200 Mo de heap) : sert uniquement à filtrer `categorylinks`/`page_props`
// sur les pages qui nous intéressent, au vol, sans relire `page`.
function makeNamespaceFlags() {
  let arr = new Uint8Array(1 << 22);
  return {
    set(id, value) {
      if (id >= arr.length) {
        let size = arr.length;
        while (size <= id) size *= 2;
        const next = new Uint8Array(size);
        next.set(arr);
        arr = next;
      }
      arr[id] = value;
    },
    get: (id) => (id < arr.length ? arr[id] : 0),
  };
}

// 1 = article (ns 0), 2 = catégorie (ns 14) — voir makeNamespaceFlags.
const FLAG_ARTICLE = 1;
const FLAG_CATEGORY = 2;

// insertion par paquets : une transaction unique sur 15M de lignes fait
// enfler le journal, une transaction par ligne est ~100x plus lente.
function makeBatchInserter(indexDb, sql, batchSize = 50_000) {
  const stmt = indexDb.prepare(sql);
  const flush = indexDb.transaction((rows) => {
    for (const row of rows) stmt.run(row);
  });
  let pending = [];
  return {
    push(row) {
      pending.push(row);
      if (pending.length >= batchSize) {
        flush(pending);
        pending = [];
      }
    },
    done() {
      if (pending.length) flush(pending);
      pending = [];
    },
  };
}

async function ingestTable(indexDb, table, gzPath, nsFlags) {
  let kept = 0;
  let seen = 0;
  const progress = () => {
    if (seen % 5_000_000 === 0) {
      logInfo(`Dump ${WIKI_ARTICLE_LANG}wiki : ${table} — ${seen / 1e6}M lignes lues, ${kept} retenues`);
    }
  };

  if (table === "page") {
    // page_id, page_namespace, page_title, page_is_redirect
    const ins = makeBatchInserter(indexDb, "INSERT OR IGNORE INTO fw_page VALUES (?, ?, ?, ?)");
    await streamDumpRows(gzPath, (f) => {
      seen++;
      progress();
      const ns = Number(f[1]);
      if (ns !== NS_ARTICLE && ns !== NS_CATEGORY) return;
      const id = Number(f[0]);
      nsFlags.set(id, ns === NS_ARTICLE ? FLAG_ARTICLE : FLAG_CATEGORY);
      ins.push([id, ns, f[2], Number(f[3])]);
      kept++;
    });
    ins.done();
  } else if (table === "linktarget") {
    // lt_id, lt_namespace, lt_title
    const ins = makeBatchInserter(indexDb, "INSERT OR IGNORE INTO fw_linktarget VALUES (?, ?, ?)");
    await streamDumpRows(gzPath, (f) => {
      seen++;
      progress();
      const ns = Number(f[1]);
      if (ns !== NS_FILE && ns !== NS_CATEGORY) return;
      ins.push([Number(f[0]), ns, f[2]]);
      kept++;
    });
    ins.done();
  } else if (table === "categorylinks") {
    // cl_from, cl_sortkey, cl_timestamp, cl_sortkey_prefix, cl_type,
    // cl_collation_id, cl_target_id — la cible est TOUJOURS une catégorie,
    // seul l'appartenance de la SOURCE est à filtrer (on ignore les pages de
    // discussion, utilisateur, modèle… qui ne seront jamais dans un quiz).
    const ins = makeBatchInserter(indexDb, "INSERT INTO fw_catlink VALUES (?, ?, ?)");
    await streamDumpRows(gzPath, (f) => {
      seen++;
      progress();
      const from = Number(f[0]);
      if (nsFlags.get(from) === 0) return;
      const type = f[4];
      if (type !== "page" && type !== "subcat") return;
      ins.push([from, Number(f[6]), type]);
      kept++;
    });
    ins.done();
  } else if (table === "page_props") {
    // pp_page, pp_propname, pp_value, pp_sortkey — les deux propriétés
    // arrivent sur des LIGNES distinctes du dump : on fusionne par pp_page
    // via un upsert plutôt qu'en gardant tout le dump en mémoire.
    const ins = makeBatchInserter(
      indexDb,
      `INSERT INTO fw_pageprop (pp_page, qid, image) VALUES (?, ?, ?)
       ON CONFLICT(pp_page) DO UPDATE SET
         qid = COALESCE(excluded.qid, qid),
         image = COALESCE(excluded.image, image)`,
    );
    await streamDumpRows(gzPath, (f) => {
      seen++;
      progress();
      const isQid = f[1] === "wikibase_item";
      // page_image_free = image principale libre de droits, celle que l'API
      // renvoyait en `pageimages` ; `page_image` (non libre) est ignorée.
      const isImage = f[1] === "page_image_free";
      if (!isQid && !isImage) return;
      const page = Number(f[0]);
      if (nsFlags.get(page) !== FLAG_ARTICLE) return;
      ins.push([page, isQid ? f[2] : null, isImage ? f[2] : null]);
      kept++;
    });
    ins.done();
  } else if (table === "redirect") {
    // rd_from, rd_namespace, rd_title, rd_interwiki, rd_fragment — seules les
    // redirections internes vers un ARTICLE nous intéressent (une redirection
    // interwiki pointe hors du wiki, rd_interwiki non vide).
    const ins = makeBatchInserter(indexDb, "INSERT INTO fw_redirect VALUES (?, ?)");
    await streamDumpRows(gzPath, (f) => {
      seen++;
      progress();
      if (Number(f[1]) !== NS_ARTICLE) return;
      if (f[3]) return;
      const from = Number(f[0]);
      if (nsFlags.get(from) !== FLAG_ARTICLE) return;
      ins.push([from, f[2]]);
      kept++;
    });
    ins.done();
  } else if (table === "imagelinks") {
    // il_from, il_from_namespace, il_target_id
    const ins = makeBatchInserter(indexDb, "INSERT INTO fw_imagelink VALUES (?, ?)");
    await streamDumpRows(gzPath, (f) => {
      seen++;
      progress();
      if (Number(f[1]) !== NS_ARTICLE) return;
      ins.push([Number(f[0]), Number(f[2])]);
      kept++;
    });
    ins.done();
  }
  logInfo(`Dump ${WIKI_ARTICLE_LANG}wiki : ${table} ingérée — ${kept} lignes retenues sur ${seen}.`);
  return kept;
}

// Prépare l'index et renvoie la liste des dumps à (re)construire.
//
// La fraîcheur est lue dans fw_meta, PAS dans la table `checkpoint` de
// cache/data.sqlite : l'index est un fichier séparé de plusieurs Go, il doit
// survivre à une reconstruction de data.sqlite (suppression du cache, remise
// à plat du pool...) sans se refaire 2h30 de travail pour rien. Un index qui
// porte lui-même sa date est aussi le seul moyen que les deux ne puissent
// pas se désynchroniser.
function prepareIndex() {
  if (!existsSync(INDEX_PATH)) return [...DUMP_TABLES];
  const probe = new Database(INDEX_PATH);
  try {
    probe.exec(META_SCHEMA);

    // Snapshot périmé : les 5 tables issues des dumps SQL repartent ENSEMBLE
    // — leurs identifiants (lt_id surtout) appartiennent à un snapshot donné,
    // en mélanger deux produirait des jointures fausses sans lever d'erreur.
    // fw_pageview est épargnée : indexée par page_id, stable dans le temps.
    const oldest = probe
      .prepare(
        `SELECT MIN(ingested_at) AS ts FROM fw_meta WHERE dump_name IN (${DUMP_TABLES.map(() => "?").join(",")})`,
      )
      .get(...DUMP_TABLES)?.ts;
    if (oldest != null && Date.now() - oldest > db.TTL_MS.typePool) {
      const forget = probe.prepare("DELETE FROM fw_meta WHERE dump_name = ?");
      for (const dumpName of DUMP_TABLES) {
        probe.exec(`DROP TABLE IF EXISTS ${TABLE_DEFS[dumpName].table}`);
        forget.run(dumpName);
      }
      logInfo(
        `Dump ${WIKI_ARTICLE_LANG}wiki : snapshot périmé, tables SQL purgées (consultations conservées).`,
      );
      return [...DUMP_TABLES];
    }

    const done = new Set(
      probe.prepare("SELECT dump_name FROM fw_meta").all().map((r) => r.dump_name),
    );

    // Table présente mais dont les colonnes ne correspondent plus à
    // TABLE_DEFS : c'est une version d'index construite par un code
    // antérieur, qui n'a pas la donnée nouvellement attendue (ex. la colonne
    // `image` de fw_pageprop, ajoutée pour reconstruire les vignettes hors
    // ligne). Une table dérivée d'un dump se re-remplit, donc on la refait
    // au lieu de migrer — mais UNIQUEMENT celle-là, les autres restent.
    for (const dumpName of DUMP_TABLES) {
      const { table, schema } = TABLE_DEFS[dumpName];
      const actual = probe.prepare(`PRAGMA table_info(${table})`).all();
      if (actual.length === 0) continue;
      const expected = [...schema.matchAll(/^\s{6}(\w+)\s/gm)].map((m) => m[1]);
      if (expected.every((c) => actual.some((a) => a.name === c))) continue;
      probe.exec(`DROP TABLE ${table}`);
      probe.prepare("DELETE FROM fw_meta WHERE dump_name = ?").run(dumpName);
      done.delete(dumpName);
      logInfo(`Dump ${WIKI_ARTICLE_LANG}wiki : ${dumpName} obsolète (schéma élargi), à réingérer.`);
    }
    // Index construit AVANT l'introduction de fw_meta : ses tables sont bien
    // là, simplement non journalisées. On les inscrit d'après leur contenu
    // réel plutôt que de refaire plusieurs heures de travail déjà fait. Une
    // table absente ou vide reste dans la liste des manquants.
    const insert = probe.prepare("INSERT OR REPLACE INTO fw_meta VALUES (?, ?, ?)");
    for (const dumpName of DUMP_TABLES) {
      if (done.has(dumpName)) continue;
      const { table } = TABLE_DEFS[dumpName];
      const exists = probe
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (!exists) continue;
      const rows = probe.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
      if (rows === 0) continue;
      insert.run(dumpName, Date.now(), rows);
      done.add(dumpName);
      logInfo(`Dump ${WIKI_ARTICLE_LANG}wiki : ${dumpName} déjà présent (${rows} lignes), conservé.`);
    }
    return DUMP_TABLES.filter((t) => !done.has(t));
  } finally {
    probe.close();
  }
}

// reconstruit le tableau de namespaces depuis fw_page déjà en base — évite de
// re-télécharger `page` (482 Mo) juste pour pouvoir filtrer une table
// ingérée plus tard.
function namespaceFlagsFromIndex(indexDb) {
  const flags = makeNamespaceFlags();
  for (const r of indexDb.prepare("SELECT page_id, namespace FROM fw_page").iterate()) {
    flags.set(r.page_id, r.namespace === NS_ARTICLE ? FLAG_ARTICLE : FLAG_CATEGORY);
  }
  return flags;
}

async function ingestOne(indexDb, dumpName, nsFlags) {
  const def = TABLE_DEFS[dumpName];
  const gzPath = path.join(CACHE_DIR, `${WIKI_ARTICLE_LANG}wiki-${dumpName}.sql.gz`);
  // DROP systématique : rend l'ingestion idempotente, y compris après un
  // process tué en plein milieu (la table existe alors à moitié remplie).
  indexDb.exec(`DROP TABLE IF EXISTS ${def.table}`);
  indexDb.exec(def.schema);
  logInfo(`Dump ${WIKI_ARTICLE_LANG}wiki : téléchargement de ${dumpName}…`);
  await downloadDump(dumpName, gzPath);
  try {
    logInfo(`Dump ${WIKI_ARTICLE_LANG}wiki : ingestion de ${dumpName}…`);
    const kept = await ingestTable(indexDb, dumpName, gzPath, nsFlags);
    for (const sql of def.indexes) {
      logInfo(`Dump ${WIKI_ARTICLE_LANG}wiki : index SQL de ${dumpName}…`);
      indexDb.exec(sql);
    }
    indexDb
      .prepare("INSERT OR REPLACE INTO fw_meta VALUES (?, ?, ?)")
      .run(dumpName, Date.now(), kept);
  } finally {
    // l'archive ne sert plus une fois la table construite, et elle reste
    // re-téléchargeable si l'ingestion doit être refaite (voir KEEP_DUMP_FILES).
    if (!KEEP_DUMP_FILES) rmSync(gzPath, { force: true });
  }
}

async function buildIndex(missing) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const indexDb = new Database(INDEX_PATH);
  // index reconstructible à volonté : aucune raison de payer le coût de
  // durabilité d'un WAL pendant une insertion en masse de dizaines de
  // millions de lignes (contrairement à cache/data.sqlite, lui persistant).
  indexDb.pragma("journal_mode = OFF");
  indexDb.pragma("synchronous = OFF");
  indexDb.exec(META_SCHEMA);
  try {
    // `page` reconstruit les namespaces au passage ; s'il n'est pas au
    // programme alors qu'une table filtrée l'est, on les relit depuis fw_page.
    const nsFlags =
      !missing.includes("page") && missing.some((t) => NEEDS_NAMESPACE_FLAGS.has(t))
        ? namespaceFlagsFromIndex(indexDb)
        : makeNamespaceFlags();
    for (const dumpName of DUMP_TABLES) {
      if (missing.includes(dumpName)) await ingestOne(indexDb, dumpName, nsFlags);
    }
  } finally {
    indexDb.close();
  }
}

// ---------- accès ----------

let indexDb = null;
// appel en vol, partagé : refreshTypes crawle plusieurs types EN PARALLÈLE
// (mapWithConcurrency) et plusieurs d'entre eux dépendent de l'index
// (wiki_article, painter, person) — sans ce mémo les premiers arrivés
// lanceraient chacun leur propre téléchargement de 1,8 Go.
let indexPending = null;

// Prépare l'index et renvoie true s'il est utilisable. Toute défaillance
// (réseau, disque, dump au schéma inattendu) renvoie false SANS lever :
// wikipedia.js repasse alors par les appels API, plus lents mais complets —
// même logique d'option que IGDB/Pexels, un dump indisponible ne doit pas
// priver l'appli du type wiki_article.
export function ensureFrwikiIndex() {
  if (!FRWIKI_DUMP_ENABLED) return Promise.resolve(false);
  if (indexDb) return Promise.resolve(true);
  // l'échec n'est pas mémorisé : on relibère le mémo pour qu'un type suivant
  // puisse retenter (une coupure réseau ne doit pas condamner tout le crawl).
  indexPending ??= buildAndOpenIndex().finally(() => {
    indexPending = null;
  });
  return indexPending;
}

async function buildAndOpenIndex() {
  let missing;
  try {
    missing = prepareIndex();
  } catch (e) {
    logWarn(`Index ${WIKI_ARTICLE_LANG}wiki illisible (${e.message}) — repli sur l'API MediaWiki.`);
    return false;
  }

  if (missing.length > 0) {
    try {
      logInfo(
        missing.length === DUMP_TABLES.length
          ? `Dump ${WIKI_ARTICLE_LANG}wiki : index absent ou périmé — construction complète (~1,8 Go à télécharger, compter plusieurs dizaines de minutes).`
          : `Dump ${WIKI_ARTICLE_LANG}wiki : index à compléter, ${missing.length} dump(s) manquant(s) (${missing.join(", ")}) — le reste est conservé.`,
      );
      await buildIndex(missing);
      logInfo(`Dump ${WIKI_ARTICLE_LANG}wiki : index prêt (${INDEX_PATH}).`);
    } catch (e) {
      logWarn(
        `Dump ${WIKI_ARTICLE_LANG}wiki indisponible (${e.message}) — repli sur l'API MediaWiki.`,
      );
      return false;
    }
  }

  try {
    indexDb = new Database(INDEX_PATH, { readonly: true });
    return true;
  } catch (e) {
    logWarn(`Index ${WIKI_ARTICLE_LANG}wiki illisible (${e.message}) — repli sur l'API MediaWiki.`);
    indexDb = null;
    return false;
  }
}

// ---------- pageviews (famille de dumps distincte) ----------
//
// Les consultations réelles ne sont PAS dans les dumps frwiki : elles ont
// leur propre famille, un fichier mensuel tous wikis confondus. Coût fixe
// (~6 Go/mois quelle que soit la taille du pool) là où l'API en demande une
// requête PAR ARTICLE — donc le seul chemin qui tienne quand le pool grossit.
//
// Deux économies importantes ici :
//  - le fichier est trié par code de wiki, donc dès qu'on dépasse
//    fr.wikipedia il ne reste plus rien à lire : on coupe le téléchargement
//    en cours de route (fr arrive vers 40% du fichier, le reste n'est jamais
//    rapatrié) ;
//  - rien n'est écrit sur disque, le flux HTTP est branché directement sur
//    l'entrée de bzip2 et on ne garde que les lignes fr.wikipedia.
const PAGEVIEW_BASE = "https://dumps.wikimedia.org/other/pageview_complete/monthly";
const PAGEVIEW_WIKI = `${WIKI_ARTICLE_LANG}.wikipedia`;
const PAGEVIEW_TABLE = `CREATE TABLE IF NOT EXISTS fw_pageview (
  page_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  views INTEGER NOT NULL,
  PRIMARY KEY (page_id, month)
)`;

// node:zlib ne sait pas décompresser du bzip2 (gzip/brotli/zstd seulement) et
// les implémentations JS pures tournent ~10x trop lentement pour 40 Go par
// mois — on délègue au binaire système, présent par défaut sur la plupart des
// distributions. Absent, on retombe simplement sur l'API pageviews.
const BZIP2_BIN = "bzip2";
let bzip2Checked = null;

export function bzip2Available() {
  if (bzip2Checked === null) {
    const probe = spawnSync(BZIP2_BIN, ["--help"], { stdio: "ignore" });
    bzip2Checked = !probe.error;
    if (!bzip2Checked) {
      logWarn(
        `"${BZIP2_BIN}" introuvable : les dumps de consultations ne peuvent pas être décompressés, ` +
          `repli sur l'API Pageviews (1 requête par article). Installer bzip2 supprime ces requêtes.`,
      );
    }
  }
  return bzip2Checked;
}

// 3 mois COMPLETS, hors mois en cours — mêmes bornes que pageviewsRange dans
// wikipedia.js, pour que les deux chemins (dump et API) mesurent la même
// période et restent comparables.
function pageviewMonths() {
  const now = new Date();
  const months = [];
  for (let back = 3; back >= 1; back--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    months.push(
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    );
  }
  return months;
}

async function ingestPageviewMonth(indexDb, monthKey) {
  const url = `${PAGEVIEW_BASE}/${monthKey.slice(0, 4)}/${monthKey.slice(0, 4)}-${monthKey.slice(4)}/pageviews-${monthKey}-user.bz2`;
  const bz2Path = path.join(CACHE_DIR, `pageviews-${monthKey}-user.bz2`);

  // DEUX PHASES SÉPARÉES, et c'est le point important. Le montage précédent
  // branchait le flux HTTP directement sur l'entrée de bzip2 : élégant sur le
  // papier (rien sur disque), mais il s'interbloquait systématiquement en
  // arrivant dans le bloc fr.wikipedia — à partir de là on écrit en base,
  // donc on lit la sortie de bzip2 plus lentement, bzip2 sature, cesse de
  // consommer son entrée, et l'alimentation reste suspendue à un `drain` qui
  // ne vient jamais. Reproduit deux fois au même endroit (~16 Go
  // décompressés), dont une nuit entière de blocage.
  //
  // Découpler coûte le téléchargement complet (5,3 Go) au lieu de la coupure
  // à ~40%, mais aucune vitesse de traitement ne peut plus figer le réseau.
  await downloadFile(url, bz2Path, `Pageviews ${monthKey}`, 250 * 1024 * 1024);

  const child = spawn(BZIP2_BIN, ["-dc", bz2Path], { stdio: ["ignore", "pipe", "ignore"] });
  // plusieurs lignes par article (une par méthode d'accès : desktop,
  // mobile-web, mobile-app) — d'où la somme plutôt qu'un remplacement.
  const insert = makeBatchInserter(
    indexDb,
    `INSERT INTO fw_pageview VALUES (?, ?, ?)
     ON CONFLICT(page_id, month) DO UPDATE SET views = views + excluded.views`,
  );

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    child.kill();
  };

  // Le fichier est trié par code de wiki et ~99% de ses lignes ne nous
  // concernent pas. Les découper une à une en JS coûtait 6x plus cher que la
  // décompression elle-même (mesuré : 320s de CPU node contre 56s de bzip2),
  // donc tant qu'on n'est pas entré dans le bloc fr.wikipedia on se contente
  // de chercher son début avec Buffer.indexOf, qui est un memmem natif.
  const BLOCK_START = Buffer.from(`\n${PAGEVIEW_WIKI} `);
  const LINE_PREFIX = Buffer.from(`${PAGEVIEW_WIKI} `);
  let pending = Buffer.alloc(0);
  let inBlock = false;
  let kept = 0;
  try {
    for await (const chunk of child.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      if (!inBlock) {
        const idx = pending.indexOf(BLOCK_START);
        if (idx === -1) {
          // ne garde que de quoi reconnaître un motif à cheval sur 2 chunks
          if (pending.length > BLOCK_START.length) {
            pending = pending.subarray(pending.length - BLOCK_START.length);
          }
          continue;
        }
        inBlock = true;
        pending = pending.subarray(idx + 1);
        logInfo(`Pageviews ${monthKey} : bloc ${PAGEVIEW_WIKI} atteint.`);
      }
      let start = 0;
      let nl;
      while ((nl = pending.indexOf(0x0a, start)) !== -1) {
        const line = pending.subarray(start, nl);
        start = nl + 1;
        // 1re ligne hors du bloc : le fichier étant trié, il ne reste plus
        // rien à lire — on coupe le téléchargement en cours de route.
        //
        // PISTE : `en.wikipedia` vient AVANT `fr.wikipedia` dans l'ordre
        // alphabétique, donc ce flux le traverse déjà et le jette. Le capter
        // aussi ne coûterait aucun octet de téléchargement en plus (juste de
        // la place en base) et donnerait une notoriété "mondiale" à comparer
        // à la française — écartée pour l'instant, voir échange du 2026-08-04.
        if (!line.subarray(0, LINE_PREFIX.length).equals(LINE_PREFIX)) {
          stop();
          break;
        }
        // wiki_code, titre, page_id, méthode d'accès, total du mois, détail
        // horaire. On ne convertit que jusqu'au 5e espace : le détail horaire
        // en fin de ligne est le plus long et ne sert à rien. latin1 plutôt
        // qu'utf8 — les 2 champs lus sont numériques, et ça évite le décodage
        // multi-octets du titre.
        let cut = -1;
        for (let i = 0; i < 5; i++) {
          cut = line.indexOf(0x20, cut + 1);
          if (cut === -1) break;
        }
        const head = (cut === -1 ? line : line.subarray(0, cut)).toString("latin1").split(" ");
        const pageId = Number(head[2]);
        const views = Number(head[4]);
        // page_id vaut "null" pour les pages non résolues (titres supprimés,
        // requêtes malformées) : sans lui on ne peut rien rattacher.
        if (!Number.isInteger(pageId) || pageId <= 0 || !Number.isFinite(views)) continue;
        insert.push([pageId, monthKey, views]);
        kept++;
      }
      pending = pending.subarray(start);
      if (stopped) break;
    }
  } finally {
    insert.done();
    stop();
    // même raison que pour les dumps SQL, avec un enjeu disque plus lourd :
    // ~5,3 Go par mois ingéré (voir KEEP_DUMP_FILES).
    if (!KEEP_DUMP_FILES) rmSync(bz2Path, { force: true });
  }
  // Un bloc fr.wikipedia vide signale un fichier tronqué ou un format qui a
  // changé : mieux vaut lever (le mois ne sera pas journalisé, donc retenté)
  // que d'inscrire un mois vide comme terminé.
  if (kept === 0) throw new Error(`Pageviews ${monthKey} : aucune ligne ${PAGEVIEW_WIKI} trouvée`);
  logInfo(`Pageviews ${monthKey} : ${kept} lignes ${PAGEVIEW_WIKI} retenues.`);
  return kept;
}

// Construit/complète fw_pageview pour les 3 mois courants. Renvoie false si
// le dump n'est pas exploitable (bzip2 absent, réseau) — l'appelant retombe
// alors sur l'API. Incrémental comme le reste : un mois déjà ingéré est
// conservé, seul le mois qui vient d'entrer dans la fenêtre est téléchargé.
export function ensurePageviewIndex() {
  if (!indexDb || !bzip2Available()) return Promise.resolve(false);
  // même mémo que ensureFrwikiIndex, et pour la même raison : ~5 Go par mois
  // manquant, à ne télécharger qu'une fois même si plusieurs types le
  // demandent en parallèle.
  pageviewPending ??= ingestPageviewMonths().finally(() => {
    pageviewPending = null;
  });
  return pageviewPending;
}

let pageviewPending = null;

async function ingestPageviewMonths() {
  const write = new Database(INDEX_PATH);
  write.pragma("journal_mode = OFF");
  write.pragma("synchronous = OFF");
  write.exec(META_SCHEMA);
  write.exec(PAGEVIEW_TABLE);
  try {
    const done = new Set(
      write.prepare("SELECT dump_name FROM fw_meta").all().map((r) => r.dump_name),
    );
    for (const monthKey of pageviewMonths()) {
      const name = `pageviews-${monthKey}`;
      if (done.has(name)) continue;
      // re-ingestion d'un mois : on repart de zéro POUR CE MOIS uniquement,
      // les totaux étant cumulés ligne à ligne (voir ON CONFLICT ci-dessus).
      write.prepare("DELETE FROM fw_pageview WHERE month = ?").run(monthKey);
      logInfo(`Pageviews : ingestion du mois ${monthKey}…`);
      const kept = await ingestPageviewMonth(write, monthKey);
      write.prepare("INSERT OR REPLACE INTO fw_meta VALUES (?, ?, ?)").run(name, Date.now(), kept);
    }
    // purge des mois sortis de la fenêtre glissante
    const keep = pageviewMonths();
    write
      .prepare(`DELETE FROM fw_pageview WHERE month NOT IN (${keep.map(() => "?").join(",")})`)
      .run(...keep);
    write
      .prepare("DELETE FROM fw_meta WHERE dump_name LIKE 'pageviews-%' AND dump_name NOT IN (" + keep.map(() => "?").join(",") + ")")
      .run(...keep.map((m) => `pageviews-${m}`));
    return true;
  } catch (e) {
    logWarn(`Dump pageviews indisponible (${e.message}) — repli sur l'API Pageviews.`);
    return false;
  } finally {
    write.close();
  }
}

// consultations cumulées sur les 3 mois, par pageid — équivalent local de
// fetchAllPageviews (wikipedia.js). Un article absent du dump n'a simplement
// pas été consulté sur la période : 0, pas null (même convention que le 404
// de l'API Pageviews).
export function pageviewsFromIndex(pageids) {
  const stmt = indexDb.prepare("SELECT SUM(views) total FROM fw_pageview WHERE page_id = ?");
  const views = new Map();
  for (const pageid of pageids) views.set(pageid, stmt.get(pageid)?.total ?? 0);
  return views;
}

// état synchrone de l'index, pour les appelants qui ne peuvent PAS déclencher
// sa construction eux-mêmes : les warmLoops tournent en tâche de fond et un
// `await ensureFrwikiIndex()` depuis l'un d'eux lancerait un téléchargement
// de 1,8 Go hors du crawl. Ils se contentent donc de constater si l'index est
// déjà ouvert (il l'est toujours avant qu'ils aient des cibles : c'est
// fetchWikiArticleEntities qui l'ouvre, avant d'écrire le pool).
export function frwikiIndexReady() {
  return indexDb !== null;
}

// les titres sont stockés avec des underscores (convention MediaWiki en
// base) alors que tout le reste du code manipule des titres affichables.
const toDbTitle = (title) => title.replace(/ /g, "_");
const toDisplayTitle = (title) => title.replace(/_/g, " ");

function categoryLtId(categoryName) {
  const row = indexDb
    .prepare("SELECT lt_id FROM fw_linktarget WHERE namespace = ? AND title = ?")
    .get(NS_CATEGORY, toDbTitle(categoryName));
  return row?.lt_id ?? null;
}

// équivalent local de categoryMembers (wikipedia.js) : membres directs d'UNE
// catégorie, pages (ns 0) et sous-catégories (ns 14).
//
// ORDRE : l'API rend les membres triés par sortkey ; on ne stocke pas le
// sortkey (colonne volumineuse, inutile par ailleurs), donc on trie par
// page_id croissant. Ce n'est pas le même ordre, mais il est déterministe et
// pas arbitraire : un page_id bas = un article créé tôt, en pratique
// davantage un sujet établi qu'une ébauche récente — ce qu'on veut quand on
// ne garde que les `limit` premiers.
function categoryMembersFromIndex(categoryName) {
  const ltId = categoryLtId(categoryName);
  if (ltId == null) return { pages: [], subcats: [] };
  const rows = indexDb
    .prepare(
      `SELECT p.page_id, p.title, p.namespace, p.is_redirect
       FROM fw_catlink c
       JOIN fw_page p ON p.page_id = c.cl_from
       WHERE c.cl_target_id = ?
       ORDER BY p.page_id`,
    )
    .all(ltId);
  return {
    // is_redirect exclu : une redirection n'est pas un sujet à deviner (elle
    // n'a ni résumé ni image propres). L'API categorymembers les renvoyait,
    // faute de pouvoir les distinguer sans un appel de plus.
    pages: rows
      .filter((r) => r.namespace === NS_ARTICLE && !r.is_redirect)
      .map((r) => ({ pageid: r.page_id, title: toDisplayTitle(r.title) })),
    subcats: rows
      .filter((r) => r.namespace === NS_CATEGORY)
      .map((r) => toDisplayTitle(r.title)),
  };
}

// même parcours en largeur que collectCategoryPages (wikipedia.js), mêmes
// bornes (`limit`, `maxDepth`, `maxVisits`) et mêmes exclusions — seule la
// source des membres change. Gardé synchrone : plus aucun appel réseau ici.
export function collectCategoryPagesFromIndex(rootCategoryName, limit, maxDepth, maxVisits, keepPage) {
  const pages = [];
  const seenPageIds = new Set();
  const seenCats = new Set([rootCategoryName]);
  const queue = [{ name: rootCategoryName, depth: 0 }];
  let visits = 0;
  while (queue.length && pages.length < limit && visits < maxVisits) {
    const { name, depth } = queue.shift();
    visits++;
    const result = categoryMembersFromIndex(name);
    // exclut l'article générique éponyme UNIQUEMENT à la racine — voir le
    // commentaire détaillé dans collectCategoryPages (wikipedia.js).
    const bareName = depth === 0 ? rootCategoryName : null;
    for (const p of result.pages) {
      if (p.title === bareName || seenPageIds.has(p.pageid) || !keepPage(p.title)) continue;
      seenPageIds.add(p.pageid);
      pages.push(p);
      if (pages.length >= limit) break;
    }
    if (depth < maxDepth) {
      for (const sub of result.subcats) {
        if (seenCats.has(sub)) continue;
        seenCats.add(sub);
        queue.push({ name: sub, depth: depth + 1 });
      }
    }
  }
  return pages;
}

// équivalent local de resolveWikidataQids (wikipedia.js).
export function qidsByPageIdFromIndex(pageids) {
  const qidByPageid = new Map();
  const stmt = indexDb.prepare("SELECT qid FROM fw_pageprop WHERE pp_page = ?");
  for (const pageid of pageids) {
    const row = stmt.get(pageid);
    if (row?.qid) qidByPageid.set(pageid, row.qid);
  }
  return qidByPageid;
}

// équivalent local d'articleImageTitles (wikipedia.js) : les fichiers
// référencés par un article. Renvoie des titres préfixés "Fichier:" et
// espacés, comme les rendait l'API — le filtrage icônes/extensions en aval
// est ainsi inchangé.
//
// ORDER BY title reproduit l'ordre de l'API (`prop=images` trie par titre de
// fichier, pas par position dans l'article) : ce n'est pas cosmétique, seuls
// les MAX_IMAGE_CANDIDATES premiers sont soumis à imageinfo, donc un autre
// ordre changerait les images retenues. Sans ce tri on aurait l'ordre de la
// clé primaire du dump (par il_target_id), sans rapport avec l'existant.
export function imageTitlesFromIndex(pageid) {
  return indexDb
    .prepare(
      `SELECT lt.title FROM fw_imagelink il
       JOIN fw_linktarget lt ON lt.lt_id = il.il_target_id
       WHERE il.il_from = ? AND lt.namespace = ?
       ORDER BY lt.title`,
    )
    .all(pageid, NS_FILE)
    .map((r) => `Fichier:${toDisplayTitle(r.title)}`);
}

// consultations cumulées par TITRE d'article — pour les entités identifiées
// par leur article français plutôt que par un pageid (les personnes Wikidata,
// qui ne connaissent que person.wiki_title).
//
// Un titre sans article correspondant renvoie 0, pas null : c'est un choix
// assumé côté quiz francophone — une personne sans article en français n'est,
// par construction, connue de personne ici, et mérite le fond du classement
// (voir échange du 2026-08-04). Ne pas confondre avec l'absence de mesure.
export function pageviewsByTitle(titles) {
  const pageStmt = indexDb.prepare(
    "SELECT page_id FROM fw_page WHERE namespace = ? AND title = ? AND is_redirect = 0",
  );
  const viewStmt = indexDb.prepare("SELECT SUM(views) AS total FROM fw_pageview WHERE page_id = ?");
  const views = new Map();
  for (const title of titles) {
    const page = pageStmt.get(NS_ARTICLE, toDbTitle(title));
    views.set(title, page ? (viewStmt.get(page.page_id)?.total ?? 0) : 0);
  }
  return views;
}

// pageid d'un article à partir de son titre — pour les appelants qui ne
// connaissent que le titre (voir fetchAndStorePersonWikiPhotosBatch, qui part de
// person.wiki_title). Renvoie null si l'article est absent du dump (créé
// depuis, ou titre devenu une redirection).
export function pageIdFromTitle(title) {
  const row = indexDb
    .prepare("SELECT page_id FROM fw_page WHERE namespace = ? AND title = ? AND is_redirect = 0")
    .get(NS_ARTICLE, toDbTitle(title));
  return row?.page_id ?? null;
}

// ---------- résumés, alias, vignettes (dump multistream, 3e famille) ----------
//
// Dernier appel à api.php à disparaître, et de très loin le plus cher : mesuré
// à 429 + `Retry-After: 51 s`, soit ~18 s par lot de 50 titres et plus d'une
// heure pour un pool de 5 000 articles. Le serveur répondait en 0,33 s — tout
// le temps passé était de l'attente imposée, pas du calcul.
//
// Cet appel ramenait TROIS choses, toutes indispensables (voir
// materializeWikiArticleRows dans server.js, qui écarte purement et simplement
// un article sans vignette) :
//   - l'extrait   -> wikitext du dump multistream, rendu par wtf_wikipedia
//   - les alias   -> table `redirect` (voir aliasesFromIndex)
//   - la vignette -> page_props.page_image_free + url reconstruite
//
// Le dump multistream pèse 7,2 Go mais on ne le télécharge JAMAIS en entier :
// son index donne l'offset d'octet du bloc bzip2 (100 articles) contenant
// chaque page, et chaque bloc se décompresse indépendamment des autres. On ne
// récupère par Range que les blocs utiles — mesuré à ~200 Ko par article visé,
// soit ~2 Go pour tout le pool, et zéro octet d'archive laissé sur le disque.
//
// Contrepartie assumée (décision utilisateur, 2026-08-04) : PAS de repli sur
// l'API. Un article dont le wikitext ne donne pas d'intro exploitable est
// écarté du pool — on a largement assez d'articles, et la vitesse prime sur
// ces quelques cas.

const MULTISTREAM_URL = `${DUMP_BASE}/${WIKI_ARTICLE_LANG}wiki-latest-pages-articles-multistream.xml.bz2`;
const MULTISTREAM_INDEX_URL = `${DUMP_BASE}/${WIKI_ARTICLE_LANG}wiki-latest-pages-articles-multistream-index.txt.bz2`;
const MULTISTREAM_INDEX_PATH = path.join(
  CACHE_DIR,
  `${WIKI_ARTICLE_LANG}wiki-multistream-index.txt.bz2`,
);

// fw_stream : dans quel bloc se trouve chaque page. fw_block : où s'arrête
// chaque bloc — l'index ne donne que des débuts, la fin d'un bloc est le début
// du suivant, il faut donc les avoir tous vus pour la connaître.
const STREAM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS fw_stream (
    page_id INTEGER PRIMARY KEY,
    block INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fw_block (
    block INTEGER PRIMARY KEY,
    end_offset INTEGER
  );`;

// dumps.wikimedia.org n'est pas api.php : ~300 requêtes de validation n'ont
// déclenché aucun throttling. On reste malgré tout modeste, c'est gratuit.
const BLOCK_CONCURRENCY = 4;
// en deçà, l'intro ne fait pas une question jouable — l'article est écarté.
const MIN_EXTRACT_LEN = 120;
const THUMB_WIDTH = 500;

const fromDbTitle = (title) => title.replace(/_/g, " ");

// wtf_wikipedia laisse tomber les modèles qu'il ne connaît pas, ce qui donnait
// "né le à Italica" : les modèles de date étaient la 1re cause d'écart avec le
// rendu de l'API. On s'en tient à ce jeu minimal et sûr — un réglage plus fin,
// tenté modèle par modèle, a produit des doublons ("littéralement
// « littéralement « ... » »") parce que le wikitext porte déjà le libellé.
const MONTHS_FR = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

// {{date|27|5|1942-}} (jour, mois en CHIFFRE, année) et {{date-|24 janvier 76}}
// (tout en un seul paramètre) coexistent. Ne garder que le 1er paramètre
// donnait "se déroule du 27 au 11", vu sur l'article le plus consulté du pool.
// Le "-" final de l'année est une convention MediaWiki (ne pas lier), pas un
// signe.
function dateTemplate(tmpl, _list, parse) {
  const o = parse(tmpl, ["jour", "mois", "annee"]);
  const parts = [o.jour, o.mois, o.annee].filter(Boolean).map(String);
  if (parts[1] && /^\d{1,2}$/.test(parts[1])) {
    parts[1] = MONTHS_FR[Number(parts[1]) - 1] ?? parts[1];
  }
  if (parts[2]) parts[2] = parts[2].replace(/-$/, "");
  return parts.join(" ");
}

wtf.extend((_models, templates) => {
  for (const name of ["date", "date-", "date de naissance", "date de décès"]) {
    templates[name] = dateTemplate;
  }
  for (const name of ["nobr", "latin", "lang-fr"]) {
    templates[name] = 0;
  }
  // {{langue|la|Caius Iulius Caesar}} : le 1er paramètre est le CODE de
  // langue, pas le texte — le rendre donnait "en latin: la à sa naissance".
  templates["langue"] = 1;
  // {{1re|brigade}} -> "1re brigade" : le NOM du modèle porte l'ordinal, son
  // paramètre le substantif. Non rendu, il laissait "Pendant seize jours, la ,
  // future ...".
  const ordinals = ["1er", "1re", "2d", "2de"];
  for (let n = 2; n <= 30; n++) ordinals.push(`${n}e`);
  for (const ord of ordinals) {
    templates[ord] = (tmpl, _list, parse) => {
      const o = parse(tmpl, ["nom"]);
      return [ord, o.nom].filter(Boolean).join(" ");
    };
  }
});

// artefacts laissés par un modèle non rendu : parenthèse vidée de son contenu,
// ponctuation orpheline.
function tidyExtract(text) {
  return (
    text
      // ponctuation orpheline : une référence ou un modèle non rendu laisse sa
      // virgule ("Le Rhin (en français,,,,)", "depuis 2020),, dont 39 %").
      .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
      .replace(/,\s*\./g, ".")
      .replace(/([,;:])\s*\)/g, ")")
      .replace(/\(\s*[,;:]?\s*\)/g, "")
      .replace(/\(\s*(?:en|du|de|le|la)\s*\)/gi, "")
      .replace(/\s+([,;:.!?])/g, "$1")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

const XML_ENTITIES = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
function decodeXml(s) {
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+);/g, (_m, e) =>
    e[0] === "#" ? String.fromCodePoint(Number(e.slice(1))) : XML_ENTITIES[e],
  );
}

// Construit fw_stream/fw_block depuis l'index multistream (63 Mo). Journalisé
// dans fw_meta comme les autres dumps : payé une seule fois par snapshot.
let multistreamPending = null;
export function ensureMultistreamIndex() {
  if (!indexDb || !bzip2Available()) return Promise.resolve(false);
  multistreamPending ??= buildMultistreamIndex().finally(() => {
    multistreamPending = null;
  });
  return multistreamPending;
}

async function buildMultistreamIndex() {
  const write = new Database(INDEX_PATH);
  write.pragma("journal_mode = OFF");
  write.pragma("synchronous = OFF");
  write.exec(META_SCHEMA);
  write.exec(STREAM_SCHEMA);
  try {
    if (write.prepare("SELECT 1 FROM fw_meta WHERE dump_name = 'multistream-index'").get()) {
      return true;
    }

    await downloadFile(
      MULTISTREAM_INDEX_URL,
      MULTISTREAM_INDEX_PATH,
      `Index multistream ${WIKI_ARTICLE_LANG}wiki`,
      20 * 1024 * 1024,
    );

    logInfo("Index multistream : lecture…");
    write.exec("DELETE FROM fw_stream; DELETE FROM fw_block");
    const insStream = makeBatchInserter(write, "INSERT OR IGNORE INTO fw_stream VALUES (?, ?)");
    const blocks = new Set();
    let kept = 0;
    const bz = spawn(BZIP2_BIN, ["-dc", MULTISTREAM_INDEX_PATH], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let carry = "";
    for await (const chunk of bz.stdout) {
      const lines = (carry + chunk.toString("utf8")).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        // offset:page_id:titre — le titre peut contenir des ':', pas les deux
        // premiers champs, d'où la découpe par index plutôt qu'un split.
        const a = line.indexOf(":");
        if (a === -1) continue;
        const b = line.indexOf(":", a + 1);
        if (b === -1) continue;
        const block = Number(line.slice(0, a));
        blocks.add(block);
        insStream.push([Number(line.slice(a + 1, b)), block]);
        kept++;
      }
    }
    insStream.done();

    const sorted = [...blocks].sort((x, y) => x - y);
    const insBlock = makeBatchInserter(write, "INSERT OR REPLACE INTO fw_block VALUES (?, ?)");
    // dernier bloc : fin inconnue, on lira jusqu'au bout du fichier.
    for (let i = 0; i < sorted.length; i++) {
      insBlock.push([sorted[i], i + 1 < sorted.length ? sorted[i + 1] : null]);
    }
    insBlock.done();

    write
      .prepare("INSERT OR REPLACE INTO fw_meta VALUES (?, ?, ?)")
      .run("multistream-index", Date.now(), kept);
    logInfo(`Index multistream : ${kept} pages réparties sur ${sorted.length} blocs.`);
    if (!KEEP_DUMP_FILES) rmSync(MULTISTREAM_INDEX_PATH, { force: true });
    return true;
  } catch (e) {
    logWarn(`Index multistream indisponible (${e.message}) — résumés du dump désactivés.`);
    return false;
  } finally {
    write.close();
  }
}

// un bloc bzip2 du dump, décompressé en mémoire (~200 Ko compressés).
async function fetchBlock(start, end) {
  const range = end == null ? `bytes=${start}-` : `bytes=${start}-${end - 1}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(MULTISTREAM_URL, {
        headers: { ...USER_AGENT_HEADERS, Range: range },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status !== 206 && res.status !== 200) throw new Error(`Range ${res.status}`);
      const compressed = Buffer.from(await res.arrayBuffer());
      return await new Promise((resolve, reject) => {
        const p = spawn(BZIP2_BIN, ["-dc"], { stdio: ["pipe", "pipe", "ignore"] });
        const out = [];
        p.stdout.on("data", (c) => out.push(c));
        p.on("error", reject);
        p.on("close", () => resolve(Buffer.concat(out).toString("utf8")));
        p.stdin.on("error", reject);
        p.stdin.end(compressed);
      });
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

// wikitext des pages d'un bloc, indexé par pageid. Le premier <id> d'un <page>
// est celui de la page, le second celui de la révision — d'où l'arrêt à la
// première occurrence.
function wikitextByPage(xml) {
  const out = new Map();
  const re = /<page>([\s\S]*?)<\/page>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[1];
    if (body.includes("<redirect ")) continue;
    const id = Number(body.match(/<id>(\d+)<\/id>/)?.[1]);
    const text = body.match(/<text[^>]*>([\s\S]*?)<\/text>/)?.[1];
    if (id && text) out.set(id, decodeXml(text));
  }
  return out;
}

// Résumés d'un lot d'articles, par pageid. Un article absent du dump, sans
// intro, ou dont l'intro reste polluée par du wikitext non rendu est
// simplement absent de la Map renvoyée (pas de repli API, voir en-tête).
export async function extractsFromDump(pageIds, onProgress) {
  const extracts = new Map();
  if (pageIds.length === 0) return extracts;

  const blockOf = indexDb.prepare("SELECT block FROM fw_stream WHERE page_id = ?");
  const endOf = indexDb.prepare("SELECT end_offset FROM fw_block WHERE block = ?");
  const byBlock = new Map();
  for (const pageid of pageIds) {
    const block = blockOf.get(pageid)?.block;
    if (block == null) continue;
    if (!byBlock.has(block)) byBlock.set(block, []);
    byBlock.get(block).push(pageid);
  }

  const blocks = [...byBlock.entries()];
  let done = 0;
  await mapWithConcurrency(blocks, BLOCK_CONCURRENCY, async ([block, ids]) => {
    try {
      const xml = await fetchBlock(block, endOf.get(block)?.end_offset ?? null);
      const pages = wikitextByPage(xml);
      for (const pageid of ids) {
        const wikitext = pages.get(pageid);
        if (!wikitext) continue;
        const intro = tidyExtract(wtf(wikitext).sections()[0]?.text() ?? "");
        if (intro.length < MIN_EXTRACT_LEN) continue;
        if (/\{\{|\[\[/.test(intro)) continue;
        extracts.set(pageid, intro);
      }
    } catch (e) {
      logDebug(`Bloc multistream ${block} illisible: ${e.message}`);
    } finally {
      done++;
      if (onProgress && (done % 50 === 0 || done === blocks.length)) {
        onProgress(done, blocks.length);
      }
    }
  });
  return extracts;
}

// Noms alternatifs d'un article : tous les titres qui redirigent vers lui.
// Remplace `prop=redirects` de l'API, même usage — mieux anonymiser le titre
// dans le résumé (voir redactTitle côté server.js).
export function aliasesFromIndex(pageIds) {
  const titleOf = indexDb.prepare("SELECT title FROM fw_page WHERE page_id = ?");
  const stmt = indexDb.prepare(
    `SELECT p.title FROM fw_redirect r
     JOIN fw_page p ON p.page_id = r.rd_from
     WHERE r.rd_title = ? LIMIT 50`,
  );
  const out = new Map();
  for (const pageid of pageIds) {
    const title = titleOf.get(pageid)?.title;
    if (!title) continue;
    out.set(
      pageid,
      stmt.all(title).map((r) => fromDbTitle(r.title)),
    );
  }
  return out;
}

// Url de vignette reconstruite hors ligne : Wikimedia range les fichiers sous
// <1er car. du md5>/<2 premiers car.>/<nom>, convention stable et publique.
// Vérifiée contre les vignettes déjà en base (4 reconstructions sur 4 exactes,
// et 3180 des 3189 connues sont sur Commons). page_image_free ne remonte que
// des fichiers LIBRES, donc hébergés sur Commons — les rares fichiers locaux
// qui donneraient une url fausse ne passent pas par cette propriété.
export function thumbnailsFromIndex(pageIds) {
  const stmt = indexDb.prepare("SELECT image FROM fw_pageprop WHERE pp_page = ?");
  const out = new Map();
  for (const pageid of pageIds) {
    const image = stmt.get(pageid)?.image;
    if (!image) continue;
    const file = image.replace(/ /g, "_");
    const dir = createHash("md5").update(file).digest("hex");
    const name = encodeURIComponent(file);
    out.set(
      pageid,
      `https://upload.wikimedia.org/wikipedia/commons/thumb/${dir[0]}/${dir.slice(0, 2)}/${name}/${THUMB_WIDTH}px-${name}`,
    );
  }
  return out;
}

// Article français d'une entité Wikidata, par QID — remplace une requête
// SPARQL par lots de 300 vers query.wikidata.org (voir
// resolveFrenchWikipediaTitles dans wikidata.js). C'est exactement le même
// lien que Wikidata publie, mais rangé dans l'autre sens : page_props porte
// le QID de chaque article français, il suffit de l'indexer par QID.
//
// Vérifié sur 800 personnes déjà en base : 800 résolues, 800 titres
// identiques à ceux du SPARQL. Un QID absent = pas d'article français (ou
// article créé depuis le snapshot), traité comme tel par l'appelant.
//
// Renvoie le pageid EN PLUS du titre : c'est la clé dont ont besoin
// extractsFromDump et thumbnailsFromIndex, et l'obtenir ici évite un
// aller-retour par le titre, qui est la seule partie renommable de la chaîne.
export function frenchTitlesByQid(qids) {
  const stmt = indexDb.prepare(
    `SELECT pp.pp_page, p.title FROM fw_pageprop pp
     JOIN fw_page p ON p.page_id = pp.pp_page
     WHERE pp.qid = ? AND p.namespace = ? AND p.is_redirect = 0`,
  );
  const out = new Map();
  for (const qid of qids) {
    const row = stmt.get(qid, NS_ARTICLE);
    if (row) out.set(qid, { pageId: row.pp_page, title: fromDbTitle(row.title) });
  }
  return out;
}
