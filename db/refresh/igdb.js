import * as db from "../index.js";
import { logWarn, logInfo, logDebug } from "./log.js";
import {
  CONFIG,
  IGDB_CLIENT_ID,
  IGDB_CLIENT_SECRET,
  CATEGORY_FETCH_CONCURRENCY,
  PAGE_FETCH_CONCURRENCY,
  capPages,
  GAME_STATIC_LISTS,
  GAME_DECADE_LISTS,
} from "./config.js";
import {
  mapWithConcurrency,
  tagFilter,
  withFilterCodes,
  storeFilterGroup,
  popularIdsFrom,
  storePopularityTiers,
} from "./util.js";

// --- IGDB (jeux vidéo) : auth Twitch (client credentials) + requêtes
// Apicalypse en POST, throttle séparé (IGDB autorise ~4 req/s) ---
let igdbToken = null;
let igdbTokenExpiresAt = 0;

async function getIgdbToken() {
  if (igdbToken && Date.now() < igdbTokenExpiresAt) return igdbToken;
  const url = `https://id.twitch.tv/oauth2/token?client_id=${IGDB_CLIENT_ID}&client_secret=${IGDB_CLIENT_SECRET}&grant_type=client_credentials`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`IGDB auth ${res.status}`);
  const data = await res.json();
  igdbToken = data.access_token;
  igdbTokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
  return igdbToken;
}

let lastIgdbCallTs = 0;
let igdbGateQueue = Promise.resolve();
const IGDB_MIN_INTERVAL_MS = 280;

function igdbGate() {
  const turn = igdbGateQueue.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastIgdbCallTs + IGDB_MIN_INTERVAL_MS - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastIgdbCallTs = Date.now();
  });
  igdbGateQueue = turn;
  return turn;
}

export async function igdbQuery(endpoint, body, attempt = 1) {
  await igdbGate();
  const token = await getIgdbToken();
  try {
    const res = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
      method: "POST",
      headers: {
        "Client-ID": IGDB_CLIENT_ID,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "text/plain",
      },
      body,
    });
    if (!res.ok) throw new Error(`IGDB ${res.status} sur ${endpoint}`);
    return await res.json();
  } catch (e) {
    const cause = e.cause
      ? ` (${e.cause.code || e.cause.message || e.cause})`
      : "";
    if (attempt < 3) {
      const delay = 500 * attempt;
      logDebug(
        `IGDB "${endpoint}" échec réseau${cause}, retry ${attempt}/2 dans ${delay}ms…`,
      );
      await new Promise((r) => setTimeout(r, delay));
      return igdbQuery(endpoint, body, attempt + 1);
    }
    e.message = `${e.message}${cause}`;
    throw e;
  }
}

async function fetchIgdbGenres() {
  try {
    return (await igdbQuery("genres", "fields id,name; limit 50;")) || [];
  } catch (e) {
    logWarn("Erreur récupération des genres IGDB:", e.message);
    return [];
  }
}

function gameGenreSources(genres) {
  return genres.map((g) => ({
    igdbWhere: `cover != null & screenshots != null & genres = (${g.id})`,
    igdbSort: "total_rating_count desc",
    pages: CONFIG.game.genrePages,
  }));
}

// même principe que fetchTmdbListPool mais pour IGDB (pagination par offset
// au lieu de page) : fusionne plusieurs sources dédupliquées par id, et trace
// séparément les tags de filtre rencontrés (voir withFilterCodes) indépendamment
// de la dédup — un jeu déjà vu via une source sans filterGroup (genre) ne
// doit pas perdre l'appartenance à une liste/décennie croisée ensuite.
async function fetchIgdbListPool(sources, fields, toRow) {
  const seen = new Map();
  const filterTagsByItemId = new Map();
  const limit = 100;
  let sourcesDone = 0;
  const startTs = Date.now();
  await mapWithConcurrency(sources, CATEGORY_FETCH_CONCURRENCY, async (src) => {
    const pageIdxs = Array.from({ length: capPages(src.pages) }, (_, i) => i);
    await mapWithConcurrency(pageIdxs, PAGE_FETCH_CONCURRENCY, async (i) => {
      const offset = i * limit;
      const body = `fields ${fields}; where ${src.igdbWhere}; sort ${src.igdbSort}; limit ${limit}; offset ${offset};`;
      try {
        const data = await igdbQuery("games", body);
        for (const g of data) {
          if (!g.cover?.image_id || !g.screenshots?.length) continue;
          if (!seen.has(g.id)) seen.set(g.id, toRow(g));
          tagFilter(filterTagsByItemId, g.id, src.filterGroup, src.filterCode);
        }
      } catch (e) {
        logWarn(`Erreur IGDB (offset ${offset}):`, e.message);
      }
    });
    sourcesDone++;
    logInfo(
      `game : source ${sourcesDone}/${sources.length} (${src.igdbWhere}) — ${seen.size} items cumulés (${((Date.now() - startTs) / 1000).toFixed(1)}s)`,
    );
  });
  return { items: [...seen.values()], filterTagsByItemId };
}

// IGDB renvoie first_release_date en timestamp unix (secondes) — converti
// ici en "YYYY-MM-DD" pour rester dans le même format que movie.release_date
// et music_track.release_date (voir getGamesByReleaseMonthDay, quiz du jour).
function igdbDateToISO(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function gameRow(g) {
  return {
    id: g.id,
    title: g.name,
    coverImageId: g.cover.image_id,
    summary: g.summary || null,
    releaseDate: igdbDateToISO(g.first_release_date),
    genreIds: (g.genres || []).map((x) => x.id),
    // pas de champ "popularity" direct côté IGDB — total_rating_count
    // (nombre d'avis connus) sert de proxy de notoriété, voir
    // storePopularityTiers.
    popularity: g.total_rating_count ?? null,
  };
}

export async function fetchGameEntities() {
  const genres = await fetchIgdbGenres();
  const sources = [
    ...withFilterCodes(GAME_STATIC_LISTS, "liste"),
    ...withFilterCodes(GAME_DECADE_LISTS, "decennie"),
    ...gameGenreSources(genres),
  ];
  const { items: rows, filterTagsByItemId } = await fetchIgdbListPool(
    sources,
    "name,cover.image_id,screenshots.image_id,genres.id,summary,first_release_date,total_rating_count",
    gameRow,
  );
  db.upsertGames(rows);
  db.replaceTypeItems(
    "game",
    rows.map((r) => r.id),
  );
  if (genres.length > 0) {
    db.upsertFilters(
      "game",
      "genre",
      genres.map((g) => ({ code: String(g.id), name: g.name })),
    );
    db.replaceEntityFilters(
      "game",
      "genre",
      rows.map((r) => ({
        entityId: r.id,
        codes: r.genreIds.map(String),
      })),
    );
  }
  storeFilterGroup("game", "liste", GAME_STATIC_LISTS, rows, filterTagsByItemId);
  storeFilterGroup("game", "decennie", GAME_DECADE_LISTS, rows, filterTagsByItemId);
  storePopularityTiers(
    "game",
    rows.map((r) => ({ entityId: r.id, value: r.popularity ?? null })),
    popularIdsFrom(rows, filterTagsByItemId, "game_popular"),
  );
}

// pendant léger de fetchGameEntities : ne retouche que les listes (Populaire/
// Tendances), sans redemander les genres ni les décennies — cadence bien
// plus courte (voir TTL_MS.listPool), donnée qui change réellement d'un jour
// à l'autre contrairement au reste (voir TYPES.game.refreshLists).
export async function refreshGameLists() {
  const { items: rows, filterTagsByItemId } = await fetchIgdbListPool(
    withFilterCodes(GAME_STATIC_LISTS, "liste"),
    "name,cover.image_id,screenshots.image_id,summary,first_release_date",
    gameRow,
  );
  db.upsertGames(rows);
  storeFilterGroup("game", "liste", GAME_STATIC_LISTS, rows, filterTagsByItemId);
}

export async function fetchAndStoreGameScreenshots(game) {
  const data = await igdbQuery(
    "games",
    `fields screenshots.image_id; where id = ${game.id};`,
  );
  const imageIds = (data[0]?.screenshots || [])
    .filter((s) => s.image_id)
    .map((s) => s.image_id);
  db.replaceGameImages(game.id, imageIds);
}
