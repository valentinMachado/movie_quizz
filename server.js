import 'dotenv/config';
import express from 'express';
import path from 'node:path';

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_KEY = process.env.TMDB_API_KEY;
const REFRESH_MS = 20 * 60 * 1000; // 20 min
const MIN_COUNT = 5;
const MAX_COUNT = 100;
const MIN_IMAGES_PER_FILM = 1;
const MAX_IMAGES_PER_FILM = 6;
const IMAGE_FETCH_CONCURRENCY = 8;

if (!TMDB_KEY) {
  console.error('TMDB_API_KEY manquante dans .env');
  process.exit(1);
}

const STATIC_LISTS = {
  popular:       { pathAndQuery: 'movie/popular',       pages: 6, label: 'Populaires',            group: 'liste' },
  top_rated:     { pathAndQuery: 'movie/top_rated',     pages: 6, label: 'Mieux notés',            group: 'liste' },
  now_playing:   { pathAndQuery: 'movie/now_playing',   pages: 4, label: 'Au cinéma',              group: 'liste' },
  upcoming:      { pathAndQuery: 'movie/upcoming',      pages: 4, label: 'À venir',                group: 'liste' },
  trending_day:  { pathAndQuery: 'trending/movie/day',  pages: 3, label: 'Tendances du jour',      group: 'liste' },
  trending_week: { pathAndQuery: 'trending/movie/week', pages: 4, label: 'Tendances de la semaine', group: 'liste' }
};

let CATEGORIES = { ...STATIC_LISTS };
let reservoirByCategory = {};
let reservoirReady = false;

async function tmdbJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDb ${res.status} sur ${url}`);
  return res.json();
}

function toEntry(m) {
  return {
    id: m.id,
    title: m.title,
    imageUrl: `https://image.tmdb.org/t/p/w1280${m.backdrop_path}`,
    posterUrl: `https://image.tmdb.org/t/p/w500${m.poster_path}`
  };
}

function urlFor(pathAndQuery, page) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  return `https://api.themoviedb.org/3/${pathAndQuery}${sep}api_key=${TMDB_KEY}&language=fr-FR&page=${page}`;
}

async function buildCategoryDefs() {
  const defs = { ...STATIC_LISTS };
  try {
    const genreData = await tmdbJSON(
      `https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_KEY}&language=fr-FR`
    );
    for (const g of genreData.genres || []) {
      defs[`genre_${g.id}`] = {
        pathAndQuery: `discover/movie?with_genres=${g.id}&sort_by=popularity.desc`,
        pages: 3,
        label: g.name,
        group: 'genre'
      };
    }
  } catch (e) {
    console.error('Erreur récupération des genres:', e.message);
  }
  return defs;
}

async function fetchCategory(def) {
  const seen = new Map();
  for (let page = 1; page <= def.pages; page++) {
    const data = await tmdbJSON(urlFor(def.pathAndQuery, page));
    for (const m of data.results || []) {
      if (!m.backdrop_path || !m.poster_path || seen.has(m.id)) continue;
      seen.set(m.id, toEntry(m));
    }
  }
  return [...seen.values()];
}

async function refreshReservoir() {
  CATEGORIES = await buildCategoryDefs();
  const next = {};
  for (const [key, def] of Object.entries(CATEGORIES)) {
    try {
      next[key] = await fetchCategory(def);
    } catch (e) {
      console.error(`Erreur catégorie "${key}":`, e.message);
      next[key] = reservoirByCategory[key] || [];
    }
  }
  reservoirByCategory = next;
  reservoirReady = Object.values(reservoirByCategory).some(list => list.length > 0);
  console.log(`Réservoir rafraîchi : ${Object.keys(CATEGORIES).length} catégories.`);
}

refreshReservoir();
setInterval(refreshReservoir, REFRESH_MS).unref();

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function mergedPool(categoryKeys) {
  const merged = new Map();
  for (const cat of categoryKeys) {
    for (const m of reservoirByCategory[cat] || []) merged.set(m.id, m);
  }
  return [...merged.values()];
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const my = idx++;
      results[my] = await fn(items[my], my);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// TMDb trie les backdrops par vote_average décroissant : les premiers sont
// souvent très proches du poster officiel (key art). On privilégie donc la
// queue de la liste (moins "iconique", plus "scène du film") avant de mélanger.
function pickVariedBackdrops(backdrops, need) {
  if (backdrops.length <= need) return shuffle(backdrops);
  const tailStart = Math.floor(backdrops.length * 0.3); // on saute le premier tiers
  const tail = backdrops.slice(tailStart);
  const pool = tail.length >= need ? tail : backdrops;
  return shuffle(pool).slice(0, need);
}

// récupère jusqu'à `need` backdrops différents pour un film donné
// (seulement appelé pour les films effectivement tirés dans un quiz, pas sur tout le réservoir)
async function fetchExtraBackdrops(movie, need) {
  if (need <= 1) return [movie.imageUrl];
  try {
    const data = await tmdbJSON(`https://api.themoviedb.org/3/movie/${movie.id}/images?api_key=${TMDB_KEY}`);
    const backdrops = (data.backdrops || []).filter(b => b.file_path);
    const urls = pickVariedBackdrops(backdrops, need).map(b => `https://image.tmdb.org/t/p/w1280${b.file_path}`);
    while (urls.length < need) urls.push(movie.imageUrl);
    return urls;
  } catch (e) {
    return Array(need).fill(movie.imageUrl);
  }
}

app.get('/api/categories', (req, res) => {
  const list = Object.entries(CATEGORIES).map(([key, def]) => ({
    key,
    label: def.label,
    group: def.group,
    available: (reservoirByCategory[key] || []).length
  }));
  res.json({ categories: list, minCount: MIN_COUNT, maxCount: MAX_COUNT });
});

app.get('/api/pool-size', (req, res) => {
  const requestedCategories = (req.query.categories || '')
    .split(',').map(s => s.trim()).filter(c => CATEGORIES[c]);
  res.json({ available: mergedPool(requestedCategories).length });
});

app.get('/api/quiz-batch', async (req, res) => {
  if (!reservoirReady) {
    return res.status(503).json({ error: 'Réservoir en cours de préparation, réessaie dans un instant.' });
  }

  const requestedCategories = (req.query.categories || 'popular')
    .split(',').map(s => s.trim()).filter(c => CATEGORIES[c]);
  if (requestedCategories.length === 0) requestedCategories.push('popular');

  const imagesPerFilm = Math.min(
    MAX_IMAGES_PER_FILM,
    Math.max(MIN_IMAGES_PER_FILM, parseInt(req.query.imagesPerFilm, 10) || 1)
  );

  const all = mergedPool(requestedCategories);
  const count = Math.min(MAX_COUNT, Math.max(MIN_COUNT, parseInt(req.query.count, 10) || 50), all.length || MIN_COUNT);

  const excludeIds = new Set((req.query.exclude || '').split(',').filter(Boolean).map(Number));

  let candidates = all.filter(m => !excludeIds.has(m.id));
  let recycled = false;
  if (candidates.length < count) {
    candidates = all;
    recycled = true;
  }

  const picked = shuffle(candidates).slice(0, count);

  const withImages = await mapWithConcurrency(picked, IMAGE_FETCH_CONCURRENCY, async (m) => ({
    id: m.id,
    title: m.title,
    posterUrl: m.posterUrl,
    imageUrls: await fetchExtraBackdrops(m, imagesPerFilm)
  }));

  res.json({
    movies: withImages,
    recycled,
    requested: count,
    delivered: withImages.length,
    imagesPerFilm,
    categories: requestedCategories,
    poolSize: all.length
  });
});

app.use(express.static(path.join(process.cwd(), 'public')));

app.listen(PORT, () => console.log(`Ciné Quiz sur http://localhost:${PORT}`));
