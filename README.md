# Guess It

Guess It is a small Node.js + Express application that generates "guess it from the picture" quiz batches across movies, TV shows, actors, video games, music, countries (guess from a photo or from the flag — see `questionType` below), and paintings (guess the painter). It pulls data from TMDb (movies/TV/people), IGDB (video games, optional), Apple Music/iTunes (songs), mledoze/countries (country list, capitals), flagcdn.com (flag images), Pexels (country photos, optional), and Wikidata/Wikimedia Commons (paintings), serves a static frontend from `public/`, and exposes JSON REST endpoints for quiz generation, pool statistics, and usage tracking.

## Features

- Generates quiz batches from categories, decades, genres, and geography (continents, and — for movies, actors, music, and paintings — specific countries) across seven media types: movies, TV shows, actors, video games, music, countries, and paintings
- Countries can be guessed two ways (`questionType`): from a photo (needs Pexels) or from the flag (guess the country **and** its capital, no key needed) — both can be active at once, in which case a country may appear twice in the same quiz, once per mode
- Returns one or more textless backdrop images per item (or an audio preview for music)
- Persists usage statistics in `stats.json`
- Refreshes its data reservoir on startup, then on two independent schedules: time-sensitive categories (now playing, trending, currently airing, etc.) every 6 hours, everything else every week
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

Start the app with:

```bash
npm start
```

Then open `http://localhost:3000` (or your custom `PORT`).

## Scripts

- `npm start` - starts the server
- `npm run pm2` - starts the app with PM2 under the name `guess_it`

## Configuration

- `TMDB_API_KEY` is required for TMDb API requests.
- `PORT` defaults to `3000` if not provided.
- `IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` are optional; without both, the video game category is disabled.
- `PEXELS_API_KEY` is optional; without it, the country category's photo-guessing mode (`questionType: "image"`) is disabled, but flag-guessing (`questionType: "flag"`) still works.
- `--only=type1,type2` (CLI flag, e.g. `node server.js --only=movie,country`): only build/refresh categories for the given media types — for testing one feature without waiting for the rest.
- `--no-write-cache` (CLI flag): read `cache/reservoir.json` and the warm caches normally, but never write to them — for running a second/test instance alongside a real one without risking overwriting its cache.

## API Endpoints

### `GET /api/categories`

Returns the available category keys, labels, groups, media types, and current reservoir sizes.

Response example:

```json
{
  "categories": [
    { "key": "popular", "label": "🎬 Populaires", "group": "liste", "mediaType": "movie", "available": 120 },
    { "key": "tv_popular", "label": "📺 Populaires", "group": "liste", "mediaType": "tv", "available": 95 },
    { "key": "person_popular", "label": "🎭 Acteurs populaires", "group": "liste", "mediaType": "person", "available": 400 },
    { "key": "person_country_us", "label": "🎭 Acteurs (États-Unis)", "group": "geography", "mediaType": "person", "available": 120 },
    { "key": "game_popular", "label": "🎮 Jeux populaires", "group": "liste", "mediaType": "game", "available": 300 },
    { "key": "music_popular_fr", "label": "🎵 Populaire (France)", "group": "geography", "mediaType": "music", "available": 80 },
    { "key": "music_genre_21", "label": "🎵 Rock", "group": "genre", "mediaType": "music", "available": 90 },
    { "key": "music_decade_1990", "label": "🎵 Années 1990", "group": "decade", "mediaType": "music", "available": 40 },
    { "key": "country_europe", "label": "🌍 Europe", "group": "geography", "mediaType": "country", "available": 101 },
    { "key": "painting_popular", "label": "🎨 Peintres populaires", "group": "liste", "mediaType": "painting", "available": 183 },
    { "key": "painting_genre_impressionism", "label": "🎨 Impressionnisme", "group": "genre", "mediaType": "painting", "available": 150 },
    { "key": "painting_country_fr", "label": "🎨 France", "group": "geography", "mediaType": "painting", "available": 150 },
    { "key": "painting_era_1850_1899", "label": "🎨 1850-1899", "group": "decade", "mediaType": "painting", "available": 150 }
  ],
  "minCount": 5,
  "maxCount": 100,
  "questionTypes": {
    "movie": ["image"],
    "tv": ["image"],
    "person": ["image"],
    "game": ["image"],
    "music": ["audio"],
    "country": ["image", "flag"],
    "painting": ["image"]
  },
  "questionTypeDetails": {
    "image": { "label": "Photo", "icon": "🖼️" },
    "flag": { "label": "Drapeau", "icon": "🚩" },
    "audio": { "label": "Extrait", "icon": "🎧" }
  }
}
```

Media types (`mediaType`) are `movie`, `tv`, `person`, `game`, `music`, `country`, or `painting`. Category `group` is `liste` (curated/trending lists), `decade`, `genre`, or `geography` (anything filtered by a specific country or continent — the country categories themselves, plus per-country actor, per-country music, and per-country painting lists); `group` also determines how the `categories` filter on `/api/quiz-batch` combines multiple selections (OR within the same group, AND across groups — see below). Genre categories are loaded dynamically from TMDb (and IGDB, if enabled) at startup; music genre and decade categories, actor-by-country and actor-by-decade categories, country/continent categories, and painting categories are all derived from already-fetched data or single-filter queries rather than a fixed curated list (see Notes). Every `label` is prefixed with an emoji matching its `mediaType` (🎬 movies, 📺 TV, 🎭 actors, 🎮 games, 🎵 music, 🌍 countries, 🎨 painters); a redundant type-name suffix like `(Films)` is stripped from the underlying text when present, but meaningful parenthetical content (a country, an era range) is kept.

`questionTypes` lists, for every `mediaType`, which `questionType` keys are valid for asking its question — most have a single one (`image`, or `audio` for `music`), `country` is the only one with more than one (`["image", "flag"]`; its two entries per country, one `questionType: "image"` and one `questionType: "flag"`, see `/api/quiz-batch`, both count toward its categories' `available`). `questionTypeDetails` gives the display `label`/`icon` of each `questionType` key, generic to whichever `mediaType` uses it — the frontend renders one chip per `mediaType:questionType` combination this way, always showing two emoji (the `mediaType`'s own emoji plus the `questionType`'s icon) without hardcoding either.

### `GET /api/pool-size?categories=cat1,cat2&questionTypes=country:image,country:flag`

Returns the size of the pool for the requested `questionTypes`/`categories` — see `/api/quiz-batch` below for how both are combined (`categories` is an optional filter, not the base selection).

Example:

```bash
curl "http://localhost:3000/api/pool-size?categories=popular,top_rated"
```

Response example:

```json
{ "available": 230 }
```

### `GET /api/stats`

Returns total quiz generation count and the top used categories.

Response example:

```json
{
  "totalGenerated": 42,
  "topCategories": [
    { "key": "popular", "label": "🎬 Populaires", "count": 18 },
    ...
  ]
}
```

### `GET /api/quiz-batch`

Generates a quiz batch. Query parameters:

- `questionTypes`: comma-separated `mediaType:questionType` keys (default: all combinations, e.g. `movie:image,country:flag`) — determines the base pool: every item of every category whose `mediaType` appears here. For a `mediaType` with more than one `questionType` (today, only `country`, whose items carry two entries each), requesting just one mode filters out the other; requesting both allows the same country to appear twice in one batch (once per mode, never the same entry twice).
- `categories`: comma-separated category keys, **optional filter** (default: none, i.e. no filtering — the full base pool from `questionTypes` is used). Categories are grouped by their `group` field (`liste`/`decade`/`genre`/`geography`, see `/api/categories`); selected categories in the *same* group are OR'd together (union), then each group with at least one selection is AND'd with the others (intersection) — e.g. `genre_28,genre_12,decade_1980` means "(Action OR Adventure) AND 1980s". Categories whose `mediaType` isn't part of the active `questionTypes` simply match nothing.
- `count`: number of items in the batch (default: `50`, min: `5`, max: `100`)
- `imagesPerItem`: number of extra backdrops per item (default: `1`, min: `1`, max: `5`; ignored for music and for `country` items with `questionType: "flag"`)
- `exclude`: comma-separated IDs to exclude from selection (pool is recycled if too few remain)

Example:

```bash
curl "http://localhost:3000/api/quiz-batch?categories=popular,top_rated&count=20&imagesPerItem=2"
```

Response example:

```json
{
  "items": [
    {
      "id": 123,
      "title": "Example Movie",
      "posterUrl": "https://image.tmdb.org/t/p/w500/...",
      "mediaType": "movie",
      "imageUrls": ["https://image.tmdb.org/t/p/w1280/..."]
    }
  ],
  "recycled": false,
  "requested": 20,
  "delivered": 20,
  "excludedCount": 1,
  "imagesPerItem": 2,
  "categories": ["popular", "top_rated"],
  "poolSize": 230,
  "totalGenerated": 43
}
```

Notes on the response:

- `items` use `imageUrls` (an array of backdrop/screenshot/photo URLs) for movies, TV shows, actors, video games, and `country` items with `questionType: "flag"` — these instead have `capital` and a single `posterUrl` (the flag), no `imageUrls`. Music items instead have `artist`, `track`, and `previewUrl` (an audio clip) in place of `imageUrls`.
- `country` items carry a `questionType` field (`"image"` or `"flag"`) alongside `mediaType: "country"`; other media types don't set it.
- `excludedCount` is the number of pool candidates dropped because no usable textless image was found for them.
- `recycled` is `true` when the `exclude` list left too few candidates and the full pool was reused.

## Data Persistence

- `stats.json` stores quiz generation totals and category usage counts.
- The app creates or updates this file automatically.

## Notes

- TMDb data is queried in French (`language=fr-FR`).
- Only "textless" images (no burned-in title/text) are used; an item with no textless image available is excluded from the batch.
- For TV shows, a random season/episode is picked and its own stills are used first, falling back to the show's general backdrops only if no episode still is usable.
- The reservoir is built on startup, then kept fresh on two independent schedules that each only touch their own subset of categories: categories marked `volatile` (now playing, upcoming, trending, currently airing, recent releases) refresh every 6 hours, everything else every week. On the very first startup only (never on either periodic refresh), the non-volatile subset is read from an on-disk cache in `cache/reservoir.json` if one exists, matches the current app version/`--only`/enabled API keys, and is less than a week old (the same interval as the weekly refresh) — this makes a restart (deploy, crash) come back up in seconds instead of rebuilding everything from the APIs; volatile categories are always fetched live at startup regardless. The painter (`cache/warm-paintings.json`) and country-photo (`cache/warm-countries.json`) warm-loop caches are persisted the same way, incrementally as each warm pass progresses, so a restart resumes instead of starting that warm-up over.
- If the reservoir is not ready yet, `/api/quiz-batch` returns a `503` response.
- Movie/TV/game genre categories are loaded dynamically from their respective APIs at startup.
- Music genre and decade categories: genres come from a separate iTunes RSS feed (which supports genre filtering, unlike the country-chart feed used for the "liste" categories); decades have no dedicated feed at all — Apple only exposes current charts, so tracks already in the reservoir are grouped after the fact by their release year.
- Movie (`movie_country_*`) and actor (`person_country_*`) "country" categories (~14 countries each, sharing the same country list) are both built from each country's own popular movies (`discover/movie?with_origin_country=XX`), rather than by filtering a single global "popular" list — TMDb has no nationality filter, and the global popular list skews heavily US/English-language, so filtering/classifying it by birthplace previously left non-US categories nearly empty. `movie_country_*` uses those movies directly; `person_country_*` additionally pulls each movie's top-billed cast (see Notes below on the actor pipeline). This can occasionally surface a foreign actor or a co-production credited to a country they're not really "from," which is an accepted trade-off.
- Actor "decade" categories (`person_decade_*`, by birth decade): TMDb has no `/discover/person` filterable by birth date, so every actor already pulled into `person_popular`/`person_country_*` needs an extra `/person/{id}` call for their `birthday`. That lookup runs in its own background warm loop (like the painter and country-photo ones), not inline in the reservoir refresh — with ~2800 actors it used to take ~15 minutes and blocked the whole reservoir from becoming ready behind it. The reservoir refresh itself now only sorts actors into decades from whatever is already cached (instant, no network calls), and the warm loop re-sorts them into the live categories as it makes progress, so these categories fill in gradually after startup rather than jumping from empty to complete once a week. Birthdays are cached for ~30 days (they never change, so this is close to a one-time cost per actor). An actor with no usable birth date is simply excluded from these categories.
- Country categories (`country_*`) cover both guessing modes (`questionType`): the country list comes from [mledoze/countries](https://github.com/mledoze/countries) (a free, keyless, actively-maintained mirror of the data the original REST Countries API used to serve before it moved behind a paid plan), and each country in the pool has up to two entries, one per mode. `questionType: "image"` needs `PEXELS_API_KEY`: guessing photos come from a Pexels keyword search (`"<country> landmark"` / `"<country> landscape"`), and the flag (from [flagcdn.com](https://flagcdn.com), free/keyless) is only used as the answer-reveal image. `questionType: "flag"` needs no API key at all: the flag itself serves as both the guessing image and (alongside the country/capital text) the reveal image — there's no separate photo search or per-item `imageUrls`, so guess duration is a dedicated `flagSec` setting, independent of `imageSec`/`imagesPerItem`, the same way music has its own clip-length setting. A country with no `capital` data in mledoze simply has no `"flag"` entry (excluded from that mode only, still available for `"image"`).
- Country photos are fetched and cached (7 days) by a dedicated background loop, paced to stay under Pexels' free-tier rate limit (200 requests/hour) — **not** by quiz generation itself, which only ever reads whatever is already cached. This means a country not yet reached by that background loop is simply excluded from quizzes (via `excludedCount`) rather than making the request slow; expect the full `questionType: "image"` pool to become available gradually after startup rather than immediately. Without `PEXELS_API_KEY`, `country_*` categories still exist and work for `questionType: "flag"`; the `"image"` entries just never resolve to a usable photo and are excluded the same way.
- Painting categories (`painting_*`) guess the **painter**, not the artwork title — `title` in the API response is the creator's name. Data comes from [Wikidata](https://www.wikidata.org) (free, keyless SPARQL queries), images from Wikimedia Commons. Unlike a museum-specific API, this isn't limited to one collection, but each category is a single-filter query (genre OR country OR era OR a notability threshold) rather than a curated "best of" list — outside of `painting_popular`, a category isn't guaranteed to only contain famous works, just paintings matching that one filter with a usable image.
- A painting item represents the **painter**, not one specific artwork: with `imagesPerItem > 1`, each frame shows a *different* painting by that same painter (fetched live from Wikidata per quiz, cached for 6h) rather than repeating the same picture.
- Painting images are loaded directly by the browser from Wikimedia Commons, like every other media type's images — the server never proxies them. If a specific image fails to load client-side (network hiccup, browser privacy settings blocking third-party resources, etc.), that item is silently dropped from the quiz instead of aborting the whole batch.
</content>
