import { db } from "./connection.js";

// ---------- quiz du jour : anniversaires (mois/jour, toutes années confondues) ----------
//
// release_date (movie/music_track) et birthday (person) sont tous stockés au
// format ISO "YYYY-MM-DD..." (voir musicDecadeCode dans refresh.js, qui
// s'appuie déjà sur ce même format par simple découpage de chaîne plutôt que
// via une fonction date SQLite) — substr(...,6,2)/substr(...,9,2) donne donc
// mois/jour de façon uniforme sur les trois tables, sans dépendre du fuseau
// ni d'un parsing de date. Restreint à type_item (pool actif), comme
// getTypePool, pour ne jamais faire remonter une entité désactivée entre-temps.
export function getMoviesByReleaseMonthDay(month, day) {
  return db
    .prepare(
      `SELECT t.* FROM movie t
       JOIN type_item ti ON ti.entity_id = t.id AND ti.type = 'movie'
       WHERE t.release_date IS NOT NULL
         AND substr(t.release_date, 6, 2) = ?
         AND substr(t.release_date, 9, 2) = ?`,
    )
    .all(month, day);
}

export function getGamesByReleaseMonthDay(month, day) {
  return db
    .prepare(
      `SELECT t.* FROM game t
       JOIN type_item ti ON ti.entity_id = t.id AND ti.type = 'game'
       WHERE t.release_date IS NOT NULL
         AND substr(t.release_date, 6, 2) = ?
         AND substr(t.release_date, 9, 2) = ?`,
    )
    .all(month, day);
}

export function getMusicTracksByReleaseMonthDay(month, day) {
  return db
    .prepare(
      `SELECT t.* FROM music_track t
       JOIN type_item ti ON ti.entity_id = t.id AND ti.type = 'music'
       WHERE t.release_date IS NOT NULL
         AND substr(t.release_date, 6, 2) = ?
         AND substr(t.release_date, 9, 2) = ?`,
    )
    .all(month, day);
}

// une même personne peut être à la fois dans le pool "person" (acteur/
// peintre) et "director" (réalisateur) — le type d'appel (voir server.js)
// choisit lequel interroger, comme getPersonPool/getDirectorPool le font déjà.
// JOIN sur entity_filter(filter_group='role') : une personne à plusieurs
// rôles (ex. acteur ET réalisateur) ressort une fois par rôle, avec son code
// de rôle attaché (`role`) — voulu, pour que dailyPersonAnniversaryBucket
// (voir server.js) puisse retenir 1 anniversaire par rôle plutôt qu'un seul
// toutes personnes confondues.
// wiki_article (catégorie "histoire" uniquement — voir
// fetchEventDates/storeWikiArticleEventDates dans refresh/wikipedia.js) : pas
// de rôle contrairement à getPersonsByBirthMonthDay, un article n'a qu'une
// seule date d'événement possible.
export function getWikiArticlesByEventMonthDay(month, day) {
  return db
    .prepare(
      `SELECT t.* FROM wiki_article t
       JOIN type_item ti ON ti.entity_id = t.id AND ti.type = 'wiki_article'
       WHERE t.event_date IS NOT NULL
         AND substr(t.event_date, 6, 2) = ?
         AND substr(t.event_date, 9, 2) = ?`,
    )
    .all(month, day);
}

export function getPersonsByBirthMonthDay(type, month, day) {
  return db
    .prepare(
      `SELECT t.*, ef.code AS role FROM person t
       JOIN type_item ti ON ti.entity_id = t.id AND ti.type = ?
       JOIN entity_filter ef ON ef.type = ti.type AND ef.entity_id = t.id AND ef.filter_group = 'role'
       WHERE t.birthday IS NOT NULL
         AND substr(t.birthday, 6, 2) = ?
         AND substr(t.birthday, 9, 2) = ?`,
    )
    .all(type, month, day);
}
