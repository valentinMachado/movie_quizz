import * as db from "../index.js";
import { logWarn, logInfo } from "./log.js";
import {
  MUSIC_GENRE_STORE,
  MUSIC_STATIC_LISTS,
  MUSIC_COUNTRY_FILTERS,
  MUSIC_BLINDTEST_SONGS,
  CATEGORY_FETCH_CONCURRENCY,
} from "./config.js";
import {
  mapWithConcurrency,
  tagFilter,
  storeFilterGroup,
  storePopularityTiers,
  popularIdsFrom,
} from "./util.js";

// throttle global itunes.apple.com — même principe que tmdbGate/igdbGate : une
// seule requête part toutes les ITUNES_MIN_INTERVAL_MS, quel que soit le
// nombre d'appelants concurrents. Apple ne documente pas de quota chiffré mais
// bride l'API Search autour de ~20 appels/minute ; sans gate, les 6 workers de
// CATEGORY_FETCH_CONCURRENCY partaient en rafale et se prenaient des 403 en
// continu. Le chart applemarketingtools est un autre hôte, il ne passe pas ici.
let lastItunesCallTs = 0;
let itunesGateQueue = Promise.resolve();
const ITUNES_MIN_INTERVAL_MS = 3000;

function itunesGate() {
  const turn = itunesGateQueue.then(async () => {
    const wait = Math.max(0, lastItunesCallTs + ITUNES_MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastItunesCallTs = Date.now();
  });
  itunesGateQueue = turn;
  return turn;
}

// 403/429 restants (le gate lisse la cadence moyenne, pas un pic côté Apple) :
// quelques tentatives avec backoff, en respectant Retry-After s'il est fourni.
async function itunesFetch(url, attempt = 1) {
  await itunesGate();
  const res = await fetch(url);
  if ((res.status === 403 || res.status === 429) && attempt < 4) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const delay = retryAfter > 0 ? retryAfter * 1000 : ITUNES_MIN_INTERVAL_MS * 2 ** attempt;
    await new Promise((r) => setTimeout(r, delay));
    return itunesFetch(url, attempt + 1);
  }
  return res;
}

// genres musique : flux RSS classique iTunes (topsongs?genre=), qui contient
// déjà l'extrait audio et l'illustration.
async function fetchMusicGenreTracks(src) {
  const url = `https://itunes.apple.com/${src.country}/rss/topsongs/limit=100/genre=${src.genreId}/json`;
  const res = await itunesFetch(url);
  if (!res.ok) throw new Error(`iTunes RSS ${res.status} sur ${url}`);
  const data = await res.json();
  const entries = data.feed?.entry || [];
  const result = [];
  for (const e of entries) {
    const trackId = e.id?.attributes?.["im:id"];
    const track = e["im:name"]?.label;
    const artist = e["im:artist"]?.label;
    const links = Array.isArray(e.link) ? e.link : [e.link].filter(Boolean);
    const preview = links.find((l) => l?.attributes?.rel === "enclosure");
    const images = e["im:image"] || [];
    const artwork = images[images.length - 1]?.label;
    if (!trackId || !track || !artist || !preview || !artwork) continue;
    result.push({
      id: Number(trackId),
      title: `${artist} — ${track}`,
      artist,
      track,
      previewUrl: preview.attributes.href,
      posterUrl: artwork.replace(/\d+x\d+bb/, "600x600bb"),
      releaseDate: e["im:releaseDate"]?.label,
    });
  }
  return result;
}

// forme commune "morceau" attendue partout dans le pool music (voir
// fetchMusicEntities) à partir d'un résultat brut iTunes (Lookup ou Search,
// même forme de champs) — partagé par fetchMusicChartTracks et
// fetchExactSongByTitle. Pas d'id de genre fiable dans ces API, juste le
// nom — utilisé aussi comme code (voir fetchMusicEntities/storeMusicGenres).
function mapItunesSongResult(t) {
  if (!t.previewUrl || !t.trackName || !t.artistName || !t.artworkUrl100)
    return null;
  return {
    id: t.trackId,
    title: `${t.artistName} — ${t.trackName}`,
    artist: t.artistName,
    track: t.trackName,
    previewUrl: t.previewUrl,
    posterUrl: t.artworkUrl100.replace("100x100", "600x600"),
    releaseDate: t.releaseDate,
    genre: t.primaryGenreName
      ? { code: t.primaryGenreName, name: t.primaryGenreName }
      : null,
  };
}

// Lookup iTunes accepte une liste d'ids en un seul appel — c'est ce qui rend
// le cache de résolution des blind-tests rentable (voir fetchBlindtestTracks).
const ITUNES_LOOKUP_BATCH = 150;

// musique : le flux RSS Apple donne le classement mais pas l'extrait audio —
// on complète via l'API Lookup iTunes (par lots d'IDs) pour récupérer previewUrl
async function fetchMusicChartTracks(src) {
  const chartUrl = `https://rss.applemarketingtools.com/api/v2/${src.country}/music/most-played/100/songs.json`;
  const chartRes = await fetch(chartUrl);
  if (!chartRes.ok)
    throw new Error(`Apple RSS ${chartRes.status} sur ${chartUrl}`);
  const chartData = await chartRes.json();
  const ids = (chartData.feed?.results || []).map((i) => i.id).filter(Boolean);
  if (ids.length === 0) return [];

  const entries = new Map();
  for (let i = 0; i < ids.length; i += ITUNES_LOOKUP_BATCH) {
    const batchIds = ids.slice(i, i + ITUNES_LOOKUP_BATCH).join(",");
    const lookupRes = await itunesFetch(
      `https://itunes.apple.com/lookup?id=${batchIds}&entity=song`,
    );
    if (!lookupRes.ok) continue;
    const lookupData = await lookupRes.json();
    for (const t of lookupData.results || []) {
      if (entries.has(t.trackId)) continue;
      const row = mapItunesSongResult(t);
      if (!row) continue;
      entries.set(t.trackId, row);
    }
  }
  return [...entries.values()];
}

// recherche un morceau EXACT (artiste + titre, pas un id pré-résolu, pour
// rester reproductible sans état à maintenir à la main — voir
// music.blindtestSongs) : la recherche iTunes est floue et le 1er résultat
// n'est pas toujours le morceau demandé (ex. une reprise, un live, un
// autre artiste au nom proche) — on préfère donc le résultat dont
// l'artiste ET le titre correspondent le plus fidèlement à la demande,
// repli sur le 1er résultat sinon.
function normalizeForMatch(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

async function fetchExactSongByTitle(artist, track) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${track}`)}&entity=song&limit=5`;
  const res = await itunesFetch(url);
  if (!res.ok) throw new Error(`iTunes search ${res.status} sur ${url}`);
  const data = await res.json();
  const results = data.results || [];
  const wantedArtist = normalizeForMatch(artist);
  const wantedTrack = normalizeForMatch(track);
  const match =
    results.find(
      (r) =>
        normalizeForMatch(r.artistName).includes(wantedArtist) &&
        normalizeForMatch(r.trackName).includes(wantedTrack),
    ) || results[0];
  return match ? mapItunesSongResult(match) : null;
}

// classiques "blind test" (config.json: music.blindtestSongs) — la config reste
// une liste d'artiste+titre lisible, sans id à maintenir à la main, mais la
// résolution vers l'id iTunes est mémorisée en base (music_search_resolution).
// Les crawls suivants repassent donc par Lookup, groupé par 150, au lieu d'une
// recherche par morceau : ~340 appels Search deviennent ~3 appels Lookup, et
// c'est Search qui est la voie bridée (403 en rafale). Une entrée dont le
// Lookup ne rend plus rien d'exploitable est oubliée et re-cherchée — c'est la
// seule invalidation nécessaire, la correspondance elle-même ne bouge pas.
function blindtestKey(song) {
  return `${normalizeForMatch(song.artist)}|${normalizeForMatch(song.track)}`;
}

async function fetchBlindtestTracks() {
  const resolutions = db.getMusicSearchResolutions();
  const cached = [];
  const toSearch = [];
  for (const song of MUSIC_BLINDTEST_SONGS) {
    const key = blindtestKey(song);
    const trackId = resolutions.get(key);
    if (trackId) cached.push({ song, key, trackId });
    else toSearch.push({ song, key });
  }

  const rows = [];
  const okIds = new Set();
  for (let i = 0; i < cached.length; i += ITUNES_LOOKUP_BATCH) {
    const batch = cached.slice(i, i + ITUNES_LOOKUP_BATCH);
    try {
      const res = await itunesFetch(
        `https://itunes.apple.com/lookup?id=${batch.map((c) => c.trackId).join(",")}&entity=song`,
      );
      if (!res.ok) throw new Error(`iTunes lookup ${res.status}`);
      const data = await res.json();
      for (const t of data.results || []) {
        const row = mapItunesSongResult(t);
        if (!row) continue;
        okIds.add(row.id);
        rows.push(row);
      }
    } catch (e) {
      // échec réseau du lot entier : rien ne dit que ces ids sont morts, on
      // garde leur résolution et on retentera au prochain crawl plutôt que de
      // relancer 150 recherches (exactement ce qu'on cherche à éviter ici).
      logWarn("Erreur lookup blind-test:", e.message);
      for (const c of batch) okIds.add(c.trackId);
    }
  }

  for (const c of cached) {
    if (okIds.has(c.trackId)) continue;
    db.forgetMusicSearchResolution(c.key);
    toSearch.push({ song: c.song, key: c.key });
  }

  await mapWithConcurrency(
    toSearch,
    CATEGORY_FETCH_CONCURRENCY,
    async ({ song, key }) => {
      try {
        const t = await fetchExactSongByTitle(song.artist, song.track);
        if (!t) return;
        db.setMusicSearchResolution(key, t.id);
        rows.push(t);
      } catch (e) {
        logWarn(
          `Erreur blind-test morceau "${song.artist} - ${song.track}":`,
          e.message,
        );
      }
    },
  );

  logInfo(
    `music : ${rows.length}/${MUSIC_BLINDTEST_SONGS.length} blind-tests résolus (${cached.length} depuis le cache, ${toSearch.length} recherche(s) iTunes).`,
  );
  return rows;
}

async function musicGenreSources() {
  try {
    const genreRes = await itunesFetch(
      "https://itunes.apple.com/WebObjects/MZStoreServices.woa/ws/genres?id=34",
    );
    if (!genreRes.ok) throw new Error(`iTunes genres ${genreRes.status}`);
    const genreData = await genreRes.json();
    const subgenres = genreData["34"]?.subgenres || {};
    return Object.values(subgenres).map((g) => ({
      genreId: g.id,
      genreName: g.name,
      country: MUSIC_GENRE_STORE,
    }));
  } catch (e) {
    logWarn("Erreur récupération des genres musique:", e.message);
    return [];
  }
}

// un seul genre par morceau en pratique (source iTunes), mais schéma générique
// (voir db.replaceEntityFilters) au cas où un morceau serait vu avec des
// genres différents d'une passe à l'autre.
function storeMusicGenres(rows) {
  const genreByCode = new Map();
  for (const t of rows) if (t.genre) genreByCode.set(t.genre.code, t.genre.name);
  if (genreByCode.size === 0) return;
  db.upsertFilters(
    "music",
    "genre",
    [...genreByCode].map(([code, name]) => ({ code, name })),
  );
  db.replaceEntityFilters(
    "music",
    "genre",
    rows.map((r) => ({ entityId: r.id, codes: r.genre ? [r.genre.code] : [] })),
  );
  // `rows` couvre TOUT le pool du crawl (voir l'appelant), donc les codes
  // restés sans morceau sont bien obsolètes — typiquement les anciens ids
  // iTunes numériques, remplacés par le nom du genre.
  const pruned = db.pruneUnusedFilters("music", "genre");
  if (pruned > 0) logInfo(`music : ${pruned} genre(s) obsolète(s) retiré(s) du catalogue.`);
}

// mêmes bornes que DECADE_LISTS/TV_DECADE_LISTS/GAME_DECADE_LISTS (avant
// 1970, puis par décennie jusqu'à 2020+) — dérivées ici directement depuis
// `releaseDate` (déjà stocké par morceau via upsertMusicTracks), pas besoin
// d'un crawl dédié par décennie comme pour les autres types : couverture
// complète, contrairement au source-tracking de liste/decennie ailleurs.
const MUSIC_DECADE_BOUNDARIES = [
  { code: "before_1970", label: "Avant 1970", lt: 1970 },
  { code: "decade_1970", label: "Années 1970", gte: 1970, lt: 1980 },
  { code: "decade_1980", label: "Années 1980", gte: 1980, lt: 1990 },
  { code: "decade_1990", label: "Années 1990", gte: 1990, lt: 2000 },
  { code: "decade_2000", label: "Années 2000", gte: 2000, lt: 2010 },
  { code: "decade_2010", label: "Années 2010", gte: 2010, lt: 2020 },
  { code: "decade_2020", label: "Années 2020", gte: 2020 },
];

function musicDecadeCode(releaseDate) {
  const year = parseInt(String(releaseDate || "").slice(0, 4), 10);
  if (!Number.isFinite(year)) return null;
  const bucket = MUSIC_DECADE_BOUNDARIES.find(
    (b) => (b.gte == null || year >= b.gte) && (b.lt == null || year < b.lt),
  );
  return bucket?.code || null;
}

function storeMusicDecades(rows) {
  db.upsertFilters(
    "music",
    "decennie",
    MUSIC_DECADE_BOUNDARIES.map((b) => ({ code: b.code, name: b.label })),
  );
  db.replaceEntityFilters(
    "music",
    "decennie",
    rows.map((r) => {
      const code = musicDecadeCode(r.releaseDate);
      return { entityId: r.id, codes: code ? [code] : [] };
    }),
  );
}

export async function fetchMusicEntities() {
  const sources = [
    ...Object.values(MUSIC_STATIC_LISTS),
    ...(await musicGenreSources()),
  ];
  const tracks = new Map();
  // même logique que fetchTmdbListPool : accumulé indépendamment de `tracks`
  // pour ne pas perdre l'appartenance à une liste si le morceau a déjà été vu
  // via une source genre avant sa source "liste" (chart pays).
  const filterTagsByItemId = new Map();
  // notoriété (voir storeMusicPopularityTiers plus bas) : contrairement à
  // TMDb/IGDB, iTunes ne donne aucun score — seul signal disponible, le RANG
  // dans le flux (chart pays OU genre, les deux sont des Top 100 ordonnés).
  // Un morceau peut apparaître dans plusieurs flux (pays différents, ou
  // chart pays ET genre) : on garde le MEILLEUR rang rencontré, tous flux
  // confondus.
  const bestRank = new Map(); // id -> rang (1 = meilleur)
  await mapWithConcurrency(sources, CATEGORY_FETCH_CONCURRENCY, async (src) => {
    try {
      // flux genre iTunes : homogène, tous les morceaux du flux appartiennent
      // au genre de la source — pas besoin de le redétecter par morceau.
      // code = NOM du genre, pas son id iTunes : les morceaux issus des
      // charts pays n'ont que `primaryGenreName` (voir mapItunesSongResult),
      // donc les deux chemins doivent converger sur le nom sous peine de
      // créer deux codes distincts au même libellé — c'est-à-dire un genre
      // affiché en double côté client (constaté : 15 doublons).
      const sourceGenre = src.genreId
        ? { code: src.genreName, name: src.genreName }
        : null;
      const list = src.genreId
        ? await fetchMusicGenreTracks(src)
        : await fetchMusicChartTracks(src);
      list.forEach((t, i) => {
        const rank = i + 1;
        if (!bestRank.has(t.id) || rank < bestRank.get(t.id)) bestRank.set(t.id, rank);
        const genre = t.genre || sourceGenre;
        const existing = tracks.get(t.id);
        if (existing) {
          if (!existing.genre && genre) existing.genre = genre;
        } else {
          tracks.set(t.id, { ...t, genre });
        }
        // sources genre (musicGenreSources) : pas de tag liste/geographie,
        // leur genre est géré séparément ci-dessus via `t.genre`.
        if (!src.genreId) {
          tagFilter(filterTagsByItemId, t.id, "liste", "popular");
          tagFilter(filterTagsByItemId, t.id, "geographie", src.country);
        }
      });
    } catch (e) {
      logWarn(
        `Erreur source musique (${src.genreId ? `genre ${src.genreId}` : src.country}):`,
        e.message,
      );
    }
  });

  // classiques "blind test" (config.json: music.blindtestSongs) — garantit
  // leur présence même quand ils ne sont plus dans le chart courant d'aucun
  // pays. Tag "liste"/"blindtest" dédié, pas de geographie (pas issus d'un
  // chart pays).
  for (const t of await fetchBlindtestTracks()) {
    const existing = tracks.get(t.id);
    if (existing) {
      if (!existing.genre && t.genre) existing.genre = t.genre;
    } else {
      tracks.set(t.id, t);
    }
    tagFilter(filterTagsByItemId, t.id, "liste", "blindtest");
  }

  // 101 - rang : reste croissant (plus haut = plus populaire), comme
  // popularity TMDb/IGDB, pour rester directement utilisable par
  // storePopularityTiers. Absent de tout flux (ex. blind-test jamais
  // recharté) -> `null`, comme un film sans popularity connue.
  const rows = [...tracks.values()].map((t) => ({
    ...t,
    popularity: bestRank.has(t.id) ? 101 - bestRank.get(t.id) : null,
  }));
  db.upsertMusicTracks(rows);
  // avant storeMusicGenres : son pruneUnusedFilters se fie au pool pour
  // décider qu'un code n'est plus porté par personne (voir db.pruneUnusedFilters).
  db.replaceTypeItems(
    "music",
    rows.map((r) => r.id),
  );
  storeMusicGenres(rows);
  storeMusicDecades(rows);
  storeFilterGroup(
    "music",
    "liste",
    { popular: { label: "Populaire" }, blindtest: { label: "Classiques" } },
    rows,
    filterTagsByItemId,
  );
  storeFilterGroup("music", "geographie", MUSIC_COUNTRY_FILTERS, rows, filterTagsByItemId);
  storePopularityTiers(
    "music",
    rows.map((r) => ({ entityId: r.id, value: r.popularity })),
    popularIdsFrom(rows, filterTagsByItemId, "popular"),
  );
}

// pendant léger de fetchMusicEntities : ne retouche que les listes (Populaire
// par pays) et la géographie qui en dérive, sans redemander les genres ni la
// décennie — cadence bien plus courte (voir TTL_MS.listPool ; voir aussi
// refreshMovieLists pour le même principe). MUSIC_STATIC_LISTS n'a jamais de
// genreId (réservé à musicGenreSources), donc toujours la voie chart pays
// ici, jamais fetchMusicGenreTracks.
export async function refreshMusicLists() {
  const sources = Object.values(MUSIC_STATIC_LISTS);
  const tracks = new Map();
  const filterTagsByItemId = new Map();
  await mapWithConcurrency(sources, CATEGORY_FETCH_CONCURRENCY, async (src) => {
    try {
      const list = await fetchMusicChartTracks(src);
      for (const t of list) {
        if (!tracks.has(t.id)) tracks.set(t.id, t);
        tagFilter(filterTagsByItemId, t.id, "liste", "popular");
        tagFilter(filterTagsByItemId, t.id, "geographie", src.country);
      }
    } catch (e) {
      logWarn(`Erreur listes musique (${src.country}):`, e.message);
    }
  });
  const rows = [...tracks.values()];
  db.upsertMusicTracks(rows);
  storeFilterGroup("music", "liste", { popular: { label: "Populaire" } }, rows, filterTagsByItemId);
  storeFilterGroup("music", "geographie", MUSIC_COUNTRY_FILTERS, rows, filterTagsByItemId);
}
