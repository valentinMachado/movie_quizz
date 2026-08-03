import * as db from "../index.js";
import { logWarn } from "./log.js";
import {
  MUSIC_GENRE_STORE,
  MUSIC_STATIC_LISTS,
  MUSIC_COUNTRY_FILTERS,
  MUSIC_BLINDTEST_SONGS,
  CATEGORY_FETCH_CONCURRENCY,
} from "./config.js";
import { mapWithConcurrency, tagFilter, storeFilterGroup } from "./util.js";

// genres musique : flux RSS classique iTunes (topsongs?genre=), qui contient
// déjà l'extrait audio et l'illustration.
async function fetchMusicGenreTracks(src) {
  const url = `https://itunes.apple.com/${src.country}/rss/topsongs/limit=100/genre=${src.genreId}/json`;
  const res = await fetch(url);
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
  const batchSize = 150;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batchIds = ids.slice(i, i + batchSize).join(",");
    const lookupRes = await fetch(
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

// l'API Search iTunes échoue par intermittence (403/429) sur environ 15-20%
// des appels, sans rapport avec la requête précise ni la cadence observée
// (vérifié manuellement : une requête qui échoue repasse souvent au retry
// suivant) — quelques tentatives avec backoff suffisent, pas la peine de
// sérialiser toute la boucle comme wikidataQuery.
async function fetchWithRetry(url, attempt = 1) {
  const res = await fetch(url);
  if ((res.status === 403 || res.status === 429) && attempt < 4) {
    await new Promise((r) => setTimeout(r, attempt * 1500));
    return fetchWithRetry(url, attempt + 1);
  }
  return res;
}

async function fetchExactSongByTitle(artist, track) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${track}`)}&entity=song&limit=5`;
  const res = await fetchWithRetry(url);
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

async function musicGenreSources() {
  try {
    const genreRes = await fetch(
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
  await mapWithConcurrency(sources, CATEGORY_FETCH_CONCURRENCY, async (src) => {
    try {
      // flux genre iTunes : homogène, tous les morceaux du flux appartiennent
      // au genre de la source — pas besoin de le redétecter par morceau.
      const sourceGenre = src.genreId
        ? { code: src.genreId, name: src.genreName }
        : null;
      const list = src.genreId
        ? await fetchMusicGenreTracks(src)
        : await fetchMusicChartTracks(src);
      for (const t of list) {
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
      }
    } catch (e) {
      logWarn(
        `Erreur source musique (${src.genreId ? `genre ${src.genreId}` : src.country}):`,
        e.message,
      );
    }
  });

  // classiques "blind test" (config.json: music.blindtestSongs) —
  // recherchés par titre EXACT à chaque crawl (pas d'id pré-résolu à
  // maintenir), pour garantir leur présence même quand ils ne sont plus
  // dans le chart courant d'aucun pays. Tag "liste"/"blindtest" dédié, pas
  // de geographie (pas issus d'un chart pays).
  await mapWithConcurrency(
    MUSIC_BLINDTEST_SONGS,
    CATEGORY_FETCH_CONCURRENCY,
    async (song) => {
      try {
        const t = await fetchExactSongByTitle(song.artist, song.track);
        if (!t) return;
        const existing = tracks.get(t.id);
        if (existing) {
          if (!existing.genre && t.genre) existing.genre = t.genre;
        } else {
          tracks.set(t.id, t);
        }
        tagFilter(filterTagsByItemId, t.id, "liste", "blindtest");
      } catch (e) {
        logWarn(
          `Erreur blind-test morceau "${song.artist} - ${song.track}":`,
          e.message,
        );
      }
    },
  );

  const rows = [...tracks.values()];
  db.upsertMusicTracks(rows);
  storeMusicGenres(rows);
  storeMusicDecades(rows);
  db.replaceTypeItems(
    "music",
    rows.map((r) => r.id),
  );
  storeFilterGroup(
    "music",
    "liste",
    { popular: { label: "Populaire" }, blindtest: { label: "Classiques" } },
    rows,
    filterTagsByItemId,
  );
  storeFilterGroup("music", "geographie", MUSIC_COUNTRY_FILTERS, rows, filterTagsByItemId);
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
