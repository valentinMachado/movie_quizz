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
// Supprime d'un groupe les codes que plus aucune entité DU POOL ne porte —
// le pool, pas entity_filter seul : replaceTypeItems sort une entité du pool
// sans effacer ses entity_filter, et ces lignes orphelines gardaient sinon en
// vie un code que plus aucune question ne peut sélectionner. À n'appeler
// qu'après le replaceTypeItems de la passe ET après un remplacement COMPLET
// du groupe, par un appelant qui connaît tous les codes légitimes (sinon on
// efface un code qu'une autre phase du crawl s'apprêtait à peupler).
//
// Utile quand l'univers des codes change et pas seulement leur contenu : les
// genres musicaux sont passés de l'id iTunes au nom du genre (voir
// storeMusicGenres), et sans ce nettoyage les anciens codes numériques
// resteraient proposés dans le catalogue alors qu'ils ne peuvent plus rien
// sélectionner.
export function pruneUnusedFilters(type, filterGroup) {
  return db
    .prepare(
      `DELETE FROM filter WHERE type = ? AND filter_group = ?
         AND NOT EXISTS (
           SELECT 1 FROM entity_filter ef
           JOIN type_item ti ON ti.type = ef.type AND ti.entity_id = ef.entity_id
           WHERE ef.type = filter.type
             AND ef.filter_group = filter.filter_group
             AND ef.code = filter.code
         )`,
    )
    .run(type, filterGroup).changes;
}

// Efface un code devenu obsolète, côté entités ET catalogue. Contrairement à
// pruneUnusedFilters (qui constate qu'un code n'est plus porté), celui-ci est
// affirmatif : l'appelant SAIT que ce code n'a plus lieu d'être, typiquement
// parce qu'il a été fusionné dans un autre (voir "person_popular" fondu dans
// "populaire", storePopularityTiers/popularCode). Sans ça, les tags posés par
// les crawls précédents survivraient indéfiniment, plus jamais mis à jour.
export function removeEntityFilterCode(type, filterGroup, code) {
  const tx = db.transaction(() => {
    const n = db
      .prepare(
        "DELETE FROM entity_filter WHERE type = ? AND filter_group = ? AND code = ?",
      )
      .run(type, filterGroup, code).changes;
    db.prepare(
      "DELETE FROM filter WHERE type = ? AND filter_group = ? AND code = ?",
    ).run(type, filterGroup, code);
    return n;
  });
  return tx();
}

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

// libellés d'UN groupe pour un LOT d'entités en une seule requête — utilisé
// par materializePersonRows (server.js) pour afficher le rôle au reveal : la
// même fonction matérialise potentiellement tout un pool, interroger
// getEntityFilters entité par entité y serait du N+1 (contrairement à
// getEntityFilters, appelé pour UNE seule entité à la fois ailleurs).
export function getEntityFilterNamesBatch(type, entityIds, filterGroup) {
  const out = new Map();
  if (entityIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT ef.entity_id, f.name FROM entity_filter ef
       JOIN filter f ON f.type = ef.type AND f.filter_group = ef.filter_group AND f.code = ef.code
       WHERE ef.type = ? AND ef.filter_group = ? AND ef.entity_id IN (${entityIds.map(() => "?").join(",")})`,
    )
    .all(type, filterGroup, ...entityIds);
  for (const r of rows) {
    if (!out.has(r.entity_id)) out.set(r.entity_id, []);
    out.get(r.entity_id).push(r.name);
  }
  return out;
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
