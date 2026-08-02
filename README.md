<img src="./public/logo.png" alt="Logo" width="300" height="300">

Guess It is a small Node.js + Express application that generates "guess it from the picture" quiz batches across movies, TV shows, actors, directors, video games, music, countries (guess from a photo or from the flag — see `questionType` below), and paintings (guess the painter). It pulls data from TMDb (movies/TV/people), IGDB (video games, optional), Apple Music/iTunes (songs), mledoze/countries (country list, capitals), flagcdn.com (flag images), Pexels (country photos, optional), and Wikidata/Wikimedia Commons (paintings), serves a static frontend from `public/`, and exposes JSON REST endpoints for quiz generation, pool statistics, and usage tracking.

## Features

- Generates quiz batches from categories, decades, genres, and geography (continents, and — for movies, TV shows, actors, music, and paintings — specific countries) across eight media types: movies, TV shows, actors, directors, video games, music, countries, and paintings
- Directors can be guessed either from the posters of the movies they directed, or from a (redacted) synopsis of several of those movies cycled one after another (`type: "director"`, `questionType: "image"`/`"synopsis"`) — separately from guessing an actor/director/painter's own photo (`type: "person"`, `role` filter)
- Movies, TV shows, and video games can also be guessed from their (redacted) synopsis, not just a poster (`questionType: "synopsis"`)
- Movies, TV shows, video games, and actors/directors/painters can be filtered by a popularity tier ("Obscur"/"Niche", layered on top of the existing "Populaire" list; painters get a full "Obscur"/"Niche"/"Populaire" split since they have no separate curated popular list to build on) — derived from each source's own popularity/rating-count signal, recomputed on every full refresh
- Music adds a curated "Classiques" list (well-known blind-test-style tracks, resolved by exact title search on every refresh rather than a pre-resolved id) alongside its per-country popularity charts
- Countries can be guessed two ways (`questionType`): from a photo (needs Pexels) or from the flag (guess the country **and** its capital, no key needed) — both can be active at once, in which case a country may appear twice in the same quiz, once per mode
- Returns one or more textless backdrop images per item (or an audio preview for music)
- **Quiz du jour** (`POST /api/quiz-daily`): a self-contained daily quiz with no client-chosen filters — mixes today's release/birthday anniversaries (movies, games, music, actors/directors/painters) with today's trending/chart lists, seeded by date so everyone gets the same quiz until midnight. See API.md for the exact selection rules.
- Persists everything — entities, images, directors, paintings, country photos — in a single SQLite database (`cache/data.sqlite`)
- Built data (entities, images, directors, paintings, country photos) is treated as near-permanent (~30 day TTL); only list membership (Populaire/Tendances) is refreshed on a short (~24h) cadence
- Uses rate-limited request queues for TMDb, IGDB, Pexels, and Wikidata to avoid API throttling
- Video games and country photos are both optional: without the relevant API credentials, the server starts normally and simply omits that category (or, for countries, falls back to flag-only guessing)

## Requirements

- Node.js 18 or later
- A TMDb API key
- Optionally, IGDB (Twitch Developer) credentials for the video game category
- Optionally, a Pexels API key for the country photo-guessing mode (landmark/landscape photos)
- No key needed for the painting category (Wikidata is free and keyless), nor for the flag-guessing mode of the country category (mledoze/countries and flagcdn.com are both free and keyless)

## Setup

1. Clone the repository or copy the files.
2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file in the project root with your TMDb API key:

```env
TMDB_API_KEY=your_tmdb_api_key_here
```

4. Optionally set a custom port, and/or enable the video game category with IGDB credentials (from the [Twitch Developer Console](https://dev.twitch.tv)), and/or enable the country category with a Pexels API key (from [pexels.com/api](https://www.pexels.com/api/), instant, no review needed):

```env
PORT=4000
IGDB_CLIENT_ID=your_igdb_client_id
IGDB_CLIENT_SECRET=your_igdb_client_secret
PEXELS_API_KEY=your_pexels_api_key
```

## Run

The app is split into two independent processes that share the same
`cache/data.sqlite` file: `refresh.js` does all the API calls (TMDb, IGDB,
Pexels, Wikidata, iTunes, mledoze) and writes entities/images into SQLite;
`server.js` only reads that file and serves the JSON API — it never makes a
network request itself. Run both:

```bash
npm run refresh   # fetches & keeps the data reservoir warm, runs forever
npm start          # serves the API from cache/data.sqlite
```

Then open `http://localhost:3000` (or your custom `PORT`). `server.js` can
be started before `refresh.js` has produced any data — `/api/quiz-batch`
just returns 503 until at least one category has something in it.

## Scripts

- `npm start` - starts the API server (`server.js`, read-only)
- `npm run refresh` - starts the data ingestion script (`refresh.js`), loops forever
- `npm run pm2` - starts the API server with PM2 under the name `guess_it`
- `npm run pm2:refresh` - starts the ingestion script with PM2 under the name `guess_it_refresh`

## Configuration

- `TMDB_API_KEY` is required by `refresh.js` for TMDb API requests.
- `PORT` defaults to `3000` if not provided (`server.js` only).
- `IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` are optional; without both, the video game category is disabled.
- `PEXELS_API_KEY` is optional; without it, the country category's photo-guessing mode (`questionType: "image"`) is disabled, but flag-guessing (`questionType: "flag"`) still works.
- `--only=type1,type2` (CLI flag on `refresh.js`, e.g. `node refresh.js --only=movie,country`): only build/refresh categories for the given media types — for testing one feature without waiting for the rest.
- `--max-media-type-count=N` (CLI flag on `refresh.js`, dev/test only): clamps each media type's pool to N entities total after each refresh pass, and caps pagination during fetch — for fast iteration.
- `--db=<path>` (CLI flag, both scripts, default `cache/data.sqlite`): which SQLite file to open. Point both `refresh.js` and `server.js` at the same alternate path (e.g. `cache/test.sqlite`) to test end-to-end without touching the real database. `--ephemeral-db` is a shorthand for `--db=:memory:`, useful for a syntax/smoke-test of a single script in isolation (nothing else can read that in-memory copy).

## API Endpoints

The full HTTP contract (`GET /api/catalog`, `POST /api/pool-size`, `GET /api/stats`, `POST /api/quiz-batch`, `POST /api/quiz-daily`) is documented in [API.md](API.md), including the exact request/response shapes, the filter combination rules (OR within a filter group, AND across groups), and the "offset" id scheme used to keep forms of the same entity (e.g. `movie:image` vs `movie:synopsis`) distinguishable. `public/js/filters.js` and `public/js/main.js` are the reference client implementation of that contract.

## Data Persistence

Everything — entities, images, directors, paintings, country photos, the genre/liste/decennie/geographie filters, and usage stats — lives in `cache/data.sqlite`, created and migrated automatically on first run. There is no separate stats file.

## Notes

- TMDb data is queried in French (`language=fr-FR`).
- Only "textless" images (no burned-in title/text) are used; an item with no textless image available is excluded from the batch.
- For TV shows, a random season/episode is picked and its own stills are used first, falling back to the show's general backdrops only if no episode still is usable.
- If no pool has been populated yet by `refresh.js`, `/api/quiz-batch` returns a `503` response; `/api/stats`'s `ready` flag reflects the same condition plus whether the "blocking" background warm loops (painter artwork, country photos) are caught up with what's currently in the pool.
- Movie/TV/game genre filters are loaded dynamically from their respective APIs.
- Music genre and decade filters: genres come from a separate iTunes RSS feed (which supports genre filtering, unlike the country-chart feed used for the "liste" filters); decades have no dedicated feed at all — Apple only exposes current charts, so tracks already fetched are grouped after the fact by their release year.
- Movie and actor "country" filters (~14 countries each, sharing the same country list) are both built from each country's own popular movies (`discover/movie?with_origin_country=XX`), rather than by filtering a single global "popular" list — TMDb has no nationality filter, and the global popular list skews heavily US/English-language, so filtering/classifying it by birthplace previously left non-US filters nearly empty. Actors additionally come from each such movie's top-billed cast. This can occasionally surface a foreign actor or a co-production credited to a country they're not really "from," which is an accepted trade-off.
- Actor/director/painter birthdays (used by "quiz du jour", see below): TMDb has no `/discover/person` filterable by birth date, so every person needs an extra `/person/{id}` call for their `birthday`. That lookup runs in its own background warm loop (like the painter and country-photo ones), not inline in the main refresh pass — with thousands of people this can take a while and would otherwise block the whole pool from becoming ready behind it. Birthdays are cached for ~30 days (they never change, so this is close to a one-time cost per person). A person with no usable birth date simply never surfaces in the "quiz du jour" anniversary pool.
- Country filters cover both guessing modes (`questionType: "image"`/`"flag"`): the country list comes from [mledoze/countries](https://github.com/mledoze/countries) (a free, keyless, actively-maintained mirror of the data the original REST Countries API used to serve before it moved behind a paid plan). `"image"` needs `PEXELS_API_KEY`: guessing photos come from a Pexels keyword search (`"<country> landmark"` / `"<country> landscape"`), and the flag (from [flagcdn.com](https://flagcdn.com), free/keyless) is only used as the answer-reveal image. `"flag"` needs no API key at all: the flag itself serves as both the guessing image and (alongside the country/capital text) the reveal image — guess duration is a dedicated `flagSec` setting, independent of `imageSec`/`imagesPerItem`, the same way music has its own clip-length setting. A country with no `capital` data in mledoze simply has no `"flag"` entry (excluded from that mode only, still available for `"image"`).
- Country photos are fetched and cached by a dedicated background loop, paced to stay under Pexels' free-tier rate limit (200 requests/hour) — **not** by quiz generation itself, which only ever reads whatever is already cached. This means a country not yet reached by that background loop is simply excluded from quizzes (via `excludedCount`) rather than making the request slow. Without `PEXELS_API_KEY`, country filters still exist and work for `"flag"`; the `"image"` entries just never resolve to a usable photo and are excluded the same way.
- Painter filters guess the **painter**, not the artwork title. Data comes from [Wikidata](https://www.wikidata.org) (free, keyless SPARQL queries), images from Wikimedia Commons. Unlike a museum-specific API, this isn't limited to one collection, but each filter is a single-condition query (genre OR country OR era OR a notability threshold) rather than a curated "best of" list — outside of the "popular" filter, a result isn't guaranteed to only contain famous works, just paintings matching that one filter with a usable image. A painter can also appear in the `person` pool (guess from their portrait, `role: "painter"`) — same person, two independent ids and image pools, see API.md.
- With `imagesPerItem > 1` (or, for `director:synopsis`, `synopsisPerItem > 1`), each frame of an item shows a _different_ image/synopsis rather than repeating the same one — if an item has fewer available than requested, it simply gets fewer frames instead of a repeat.
- Painting images are loaded directly by the browser from Wikimedia Commons, like every other type's images — the server never proxies them. If a specific image fails to load client-side (network hiccup, browser privacy settings blocking third-party resources, etc.), that item is silently dropped from the quiz instead of aborting the whole batch.
- Director filters guess the **director**, either from posters of the movies they directed (`questionType: "image"`) or from a redacted synopsis of several of those movies cycled as frames (`questionType: "synopsis"`, movie title shown as a caption, director's own name masked in the text) — both distinct from guessing their own photo (`type: "person"`, `role: "director"`). A director's filmography is completed beyond the curated `movie` pool via their own TMDb credits, in a dedicated background warm loop, so guessing isn't limited to the handful of their films that happen to already be in the popularity/genre/decade/country pool.
- Popularity tiers (`liste` filter codes `obscur`/`niche`, plus `populaire` for painters) are recomputed from scratch on every full refresh, split at the median (movie/tv/game/person) or tertiles (painter) of each source's own popularity/rating-count signal, excluding whatever is already tagged by that type's curated "Populaire" list.
