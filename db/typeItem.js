import { db } from "./connection.js";

// ---------- type_item ----------

// remplace intégralement le pool d'un type — remplace ce qu'était
// `reservoirByCategory[key] = [...items]` avant la migration vers cette DB.
// Réservé aux types mono-source (un seul crawl a une connaissance complète
// et autoritaire du pool, ex. fetchMovieEntities) — voir addTypeItems pour
// les types alimentés par plusieurs sources indépendantes (ex. "person").
export function replaceTypeItems(type, entityIds) {
  const tx = db.transaction((ids) => {
    db.prepare("DELETE FROM type_item WHERE type = ?").run(type);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO type_item (type, entity_id) VALUES (?, ?)",
    );
    for (const id of ids) insert.run(type, id);
  });
  tx(entityIds);
}

// ajoute au pool d'un type sans jamais rien supprimer — pour les types
// alimentés par plusieurs sources indépendantes qui n'ont chacune connaissance
// que de leur propre contribution (ex. "person" : acteurs + réalisateurs +
// peintres, aucune des trois ne sachant ce que les autres ont déjà écrit).
// Contrepartie assumée : un pool additif ne rétrécit jamais (voir
// replaceTypeItems pour le cas mono-source qui, lui, se resynchronise
// intégralement à chaque crawl).
export function addTypeItems(type, entityIds) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO type_item (type, entity_id) VALUES (?, ?)",
  );
  const tx = db.transaction((ids) => {
    for (const id of ids) insert.run(type, id);
  });
  tx(entityIds);
}

export function countTypeItems(type) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM type_item WHERE type = ?")
    .get(type).n;
}

// ces jointures servent à matérialiser côté serveur ce que peuplait l'ancien
// `reservoirByCategory[key]` — même table (`person`) pour les types
// 'person' et 'painter', d'où le paramètre idColumn séparé du type.
//
// selections: { [filterGroup]: string[] } optionnel — OR entre les codes
// d'un même groupe, AND entre groupes différents (ex. films [Populaire OU
// Tendance] ET [Action]). Le JOIN sur entity_filter + GROUP BY/HAVING est ce
// qui impose l'AND inter-groupes : une entité doit avoir au moins une ligne
// matchée par groupe demandé pour ressortir. Sans selections (ou tous les
// groupes vides), comportement inchangé : tout le pool actif (type_item).
function getTypePool(table, idColumn, type, selections = {}) {
  const groups = Object.keys(selections).filter((g) => selections[g]?.length);
  if (groups.length === 0) {
    return db
      .prepare(
        `SELECT t.* FROM ${table} t
         JOIN type_item ti ON ti.entity_id = t.${idColumn} AND ti.type = ?`,
      )
      .all(type);
  }
  const clauses = groups.map(
    (g) =>
      `(ef.filter_group = ? AND ef.code IN (${selections[g].map(() => "?").join(",")}))`,
  );
  const params = [type, type];
  for (const g of groups) params.push(g, ...selections[g]);
  params.push(groups.length);
  return db
    .prepare(
      `SELECT t.* FROM ${table} t
       JOIN type_item ti ON ti.entity_id = t.${idColumn} AND ti.type = ?
       JOIN entity_filter ef ON ef.entity_id = t.${idColumn} AND ef.type = ?
       WHERE ${clauses.join(" OR ")}
       GROUP BY t.${idColumn}
       HAVING COUNT(DISTINCT ef.filter_group) = ?`,
    )
    .all(...params);
}

export const getMoviePool = (selections) =>
  getTypePool("movie", "id", "movie", selections);
export const getTvShowPool = (selections) =>
  getTypePool("tv_show", "id", "tv", selections);
export const getGamePool = (selections) =>
  getTypePool("game", "id", "game", selections);
export const getMusicTrackPool = (selections) =>
  getTypePool("music_track", "id", "music", selections);
export const getCountryPool = (selections) =>
  getTypePool("country", "ccn3", "country", selections);
export const getPersonPool = (selections) =>
  getTypePool("person", "id", "person", selections);
// Un "peintre" sans œuvre n'en est pas un pour le quiz. La requête Wikidata
// qui construit ce pool retient toute personne dont les occupations incluent
// « peintre » — d'où Freddie Mercury, Serge Gainsbourg ou George W. Bush, qui
// ont réellement peint mais dont Wikidata ne connaît aucun tableau. Mesuré :
// 820 des 1 154 du pool sans AUCUNE œuvre, et depuis que la notoriété se
// mesure en consultations réelles, ce sont eux qui trustent le palier
// "populaire". Seuil arbitré avec l'utilisateur : au moins 3 œuvres.
export const PAINTER_MIN_ARTWORKS = 3;

// `minArtworks` est un filtre de LECTURE, pas une condition d'entrée au pool :
// les œuvres sont récupérées par un warmLoop APRÈS la construction du pool.
// Filtrer à l'entrée priverait définitivement de leurs tableaux les peintres
// pas encore visités — le warmLoop "Peintres (tableaux)" appelle ce même
// getter, sans seuil, justement pour les voir tous.
export const getPainterPool = (selections, minArtworks = 0) => {
  const rows = getTypePool("person", "id", "painter", selections);
  if (minArtworks <= 0) return rows;
  const counts = new Map(
    db
      .prepare("SELECT painter_id, COUNT(*) AS n FROM painting GROUP BY painter_id")
      .all()
      .map((r) => [r.painter_id, r.n]),
  );
  return rows.filter((r) => (counts.get(r.id) ?? 0) >= minArtworks);
};
export const getDirectorPool = (selections) =>
  getTypePool("person", "id", "director", selections);
export const getActorPool = (selections) =>
  getTypePool("person", "id", "actor", selections);
export const getWikiArticlePool = (selections) =>
  getTypePool("wiki_article", "id", "wiki_article", selections);
export const getPokemonPool = (selections) =>
  getTypePool("pokemon", "id", "pokemon", selections);
export const getSuperheroPool = (selections) =>
  getTypePool("superhero", "id", "superhero", selections);

// dev/test uniquement (--max-type-count) : réduit le pool global d'un
// type à N entités distinctes au total — pour que les warm loops
// (tableaux/réalisateurs/photos pays) n'aient qu'une poignée de cibles à
// chauffer pendant un test manuel, au lieu de milliers.
export function clampTypeGlobalPool(type, maxCount) {
  const all = db
    .prepare("SELECT DISTINCT entity_id FROM type_item WHERE type = ?")
    .all(type)
    .map((r) => r.entity_id);
  if (all.length <= maxCount) return;
  const keep = new Set(all.slice(0, maxCount));
  const del = db.prepare(
    "DELETE FROM type_item WHERE type = ? AND entity_id = ?",
  );
  const tx = db.transaction(() => {
    for (const entityId of all) {
      if (!keep.has(entityId)) del.run(type, entityId);
    }
  });
  tx();
}
