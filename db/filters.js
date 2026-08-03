import { db } from "./connection.js";

// ---------- filtres (genre/liste/decennie/geographie, voir schéma) ----------

export function upsertFilters(type, filterGroup, filters) {
  const insert = db.prepare(
    `INSERT INTO filter (type, filter_group, code, name) VALUES (?, ?, ?, ?)
     ON CONFLICT(type, filter_group, code) DO UPDATE SET name = excluded.name`,
  );
  const tx = db.transaction((items) => {
    for (const f of items) insert.run(type, filterGroup, f.code, f.name);
  });
  tx(filters);
}

// entries: [{ entityId, codes }] — remplace, pour CE groupe uniquement, tous
// les codes connus de chaque entité listée (les autres groupes ne sont pas
// touchés) ; codes vide = entité sans filtre connu dans ce groupe. Réservé
// aux cas où l'appelant a une connaissance COMPLÈTE et autoritaire des codes
// de cette entité dans ce groupe pour cette passe (ex. tous les genres d'un
// film via genre_ids) — voir addEntityFilters sinon (ex. "role" sur
// "person" : chaque contributeur ne connaît qu'un rôle à la fois, un
// remplacement écraserait les rôles déjà posés par un autre contributeur).
export function replaceEntityFilters(type, filterGroup, entries) {
  const del = db.prepare(
    "DELETE FROM entity_filter WHERE type = ? AND filter_group = ? AND entity_id = ?",
  );
  const insert = db.prepare(
    "INSERT OR IGNORE INTO entity_filter (type, entity_id, filter_group, code) VALUES (?, ?, ?, ?)",
  );
  const tx = db.transaction((items) => {
    for (const { entityId, codes } of items) {
      del.run(type, filterGroup, entityId);
      for (const code of codes) insert.run(type, entityId, filterGroup, code);
    }
  });
  tx(entries);
}

// entries: [{ entityId, codes }] — comme replaceEntityFilters, mais ne
// remplace qu'un SOUS-ENSEMBLE connu de codes (`codes` du groupe), sans
// toucher aux autres codes déjà posés par un autre appelant dans le même
// groupe. Sert quand deux appelants distincts alimentent le même groupe
// avec des univers de codes disjoints (ex. "liste" : appartenance à une
// liste éditoriale ET palier de popularité, voir storePopularityTiers dans
// refresh.js) — un replaceEntityFilters classique écraserait l'un avec
// l'autre selon l'ordre d'appel.
export function replaceEntityFilterSubset(type, filterGroup, codesUniverse, entries) {
  const del = db.prepare(
    `DELETE FROM entity_filter WHERE type = ? AND filter_group = ? AND entity_id = ? AND code IN (${codesUniverse.map(() => "?").join(",")})`,
  );
  const insert = db.prepare(
    "INSERT OR IGNORE INTO entity_filter (type, entity_id, filter_group, code) VALUES (?, ?, ?, ?)",
  );
  const tx = db.transaction((items) => {
    for (const { entityId, codes } of items) {
      del.run(type, filterGroup, entityId, ...codesUniverse);
      for (const code of codes) insert.run(type, entityId, filterGroup, code);
    }
  });
  tx(entries);
}

// entries: [{ entityId, codes }] — AJOUTE ces codes sans jamais supprimer
// les codes déjà posés par un autre appelant (voir addTypeItems pour le
// même principe côté pool). Utile quand plusieurs sources indépendantes
// contribuent au même groupe pour des entités qui peuvent se recouper (ex.
// une personne acteur ET réalisateur, chaque rôle posé par une source
// différente sans connaissance de l'autre).
export function addEntityFilters(type, filterGroup, entries) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO entity_filter (type, entity_id, filter_group, code) VALUES (?, ?, ?, ?)",
  );
  const tx = db.transaction((items) => {
    for (const { entityId, codes } of items) {
      for (const code of codes) insert.run(type, entityId, filterGroup, code);
    }
  });
  tx(entries);
}

// lecture cache-only, jamais d'appel réseau — regroupé par filter_group,
// utile pour un futur affichage détaillé d'une entité.
export function getEntityFilters(type, entityId) {
  const rows = db
    .prepare(
      `SELECT f.filter_group, f.name FROM entity_filter ef
       JOIN filter f ON f.type = ef.type AND f.filter_group = ef.filter_group AND f.code = ef.code
       WHERE ef.type = ? AND ef.entity_id = ?`,
    )
    .all(type, entityId);
  const out = {};
  for (const r of rows) (out[r.filter_group] ??= []).push(r.name);
  return out;
}

// filtres disponibles pour un type, groupés — data-driven depuis la table
// `filter` (pas de liste de groupes codée en dur ici) ; sert à annoncer au
// client quels filtres proposer pour un type donné.
// libellé affiché d'un seul code (ex. quiz du jour : quel intitulé de liste
// a fait entrer une entité dans le quiz — voir server.js) — mêmes lignes que
// getFiltersForType, juste un accès direct par code plutôt que tout le groupe.
export function getFilterLabel(type, filterGroup, code) {
  const row = db
    .prepare(
      "SELECT name FROM filter WHERE type = ? AND filter_group = ? AND code = ?",
    )
    .get(type, filterGroup, code);
  return row?.name || null;
}

export function getFiltersForType(type) {
  const rows = db
    .prepare(
      "SELECT filter_group, code, name FROM filter WHERE type = ? ORDER BY filter_group, name",
    )
    .all(type);
  const out = {};
  for (const r of rows)
    (out[r.filter_group] ??= []).push({ code: r.code, name: r.name });
  return out;
}
