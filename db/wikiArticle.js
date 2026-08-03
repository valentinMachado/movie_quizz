import { db, TTL_MS, isFresh } from "./connection.js";
import { replaceImages, getImages, imagesFetchedAt } from "./images.js";

// ---------- wiki_article ----------
// id = pageid Wikipédia, voir connection.js.

export function upsertWikiArticles(rows) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO wiki_article (id, title, extract, thumbnail_url, aliases, loose_redaction, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, extract = excluded.extract,
       thumbnail_url = excluded.thumbnail_url, aliases = excluded.aliases,
       loose_redaction = excluded.loose_redaction, updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((items) => {
    for (const a of items)
      insert.run(
        a.pageid,
        a.title,
        a.extract || "",
        a.thumbnailUrl || null,
        JSON.stringify(a.aliases || []),
        a.looseRedaction ? 1 : 0,
        now,
      );
  });
  tx(rows);
}

export function getWikiArticle(id) {
  return db.prepare("SELECT * FROM wiki_article WHERE id = ?").get(id) || null;
}

export const replaceWikiArticleImages = (id, images) =>
  replaceImages("wiki_article_image", "wiki_article_id", id, images);
export const getWikiArticleImages = (id) =>
  getImages("wiki_article_image", "wiki_article_id", id);
export const wikiArticleImagesFetchedAt = (id) =>
  imagesFetchedAt("wiki_article_image", "wiki_article_id", id);

export function wikiArticleNeedsImages(article) {
  return !isFresh(wikiArticleImagesFetchedAt(article.id), TTL_MS.mediaImage);
}

// vrai s'il existe au moins un article du pool actif sans image fraîche —
// même principe qu'anyPainterArtworkStale/anyCountryPhotosStale (db/person.js,
// db/country.js). Utilisé par la LED /api/stats.ready (server.js/isDbWarmed).
export function anyWikiArticleImagesStale() {
  const cutoff = Date.now() - TTL_MS.mediaImage;
  const row = db
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM wiki_article a
         JOIN type_item ti ON ti.entity_id = a.id AND ti.type = 'wiki_article'
         WHERE NOT EXISTS (
           SELECT 1 FROM wiki_article_image ai
           WHERE ai.wiki_article_id = a.id AND ai.fetched_at > ?
         )
       ) AS stale`,
    )
    .get(cutoff);
  return Boolean(row.stale);
}
