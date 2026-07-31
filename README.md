# Movie Quizz

Movie Quizz is a small Node.js + Express application that generates "guess it from the picture" quiz batches across movies, TV shows, actors, video games, and music. It pulls data from TMDb (movies/TV/people), IGDB (video games, optional), and Apple Music/iTunes (songs), serves a static frontend from `public/`, and exposes JSON REST endpoints for quiz generation, pool statistics, and usage tracking.

## Features

- Generates quiz batches from categories, decades, and genres across five media types: movies, TV shows, actors, video games, and music
- Returns one or more textless backdrop images per item (or an audio preview for music)
- Persists usage statistics in `stats.json`
- Refreshes its data reservoir on startup and every 30 minutes
- Uses rate-limited request queues for TMDb and IGDB to avoid API throttling
- Video games are optional: without IGDB credentials, the server starts normally and simply omits that category

## Requirements

- Node.js 18 or later
- A TMDb API key
- Optionally, IGDB (Twitch Developer) credentials for the video game category

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

4. Optionally set a custom port, and/or enable the video game category with IGDB credentials (from the [Twitch Developer Console](https://dev.twitch.tv)):

```env
PORT=4000
IGDB_CLIENT_ID=your_igdb_client_id
IGDB_CLIENT_SECRET=your_igdb_client_secret
```

## Run

Start the app with:

```bash
npm start
```

Then open `http://localhost:3000` (or your custom `PORT`).

## Scripts

- `npm start` - starts the server
- `npm run pm2` - starts the app with PM2 under the name `movie_quizz`

## Configuration

- `TMDB_API_KEY` is required for TMDb API requests.
- `PORT` defaults to `3000` if not provided.
- `IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` are optional; without both, the video game category is disabled.

## API Endpoints

### `GET /api/categories`

Returns the available category keys, labels, groups, media types, and current reservoir sizes.

Response example:

```json
{
  "categories": [
    { "key": "popular", "label": "Populaires", "group": "liste", "mediaType": "movie", "available": 120 },
    { "key": "tv_popular", "label": "Populaires (Séries)", "group": "liste", "mediaType": "tv", "available": 95 },
    { "key": "person_popular", "label": "Acteurs populaires", "group": "liste", "mediaType": "person", "available": 400 },
    { "key": "game_popular", "label": "Jeux populaires", "group": "liste", "mediaType": "game", "available": 300 },
    { "key": "music_popular_fr", "label": "Populaire (France)", "group": "liste", "mediaType": "music", "available": 80 }
  ],
  "minCount": 5,
  "maxCount": 100
}
```

Media types (`mediaType`) are `movie`, `tv`, `person`, `game`, or `music`. Category `group` is `liste` (curated/trending lists), `decade`, or `genre`. Genre categories are loaded dynamically from TMDb (and IGDB, if enabled) at startup.

### `GET /api/pool-size?categories=cat1,cat2`

Returns the size of the merged pool for the requested categories.

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
    { "key": "popular", "label": "Populaires", "count": 18 },
    ...
  ]
}
```

### `GET /api/quiz-batch`

Generates a quiz batch. Query parameters:

- `categories`: comma-separated category keys (default: `popular`)
- `count`: number of items in the batch (default: `50`, min: `5`, max: `100`)
- `imagesPerFilm`: number of extra backdrops per item (default: `1`, min: `1`, max: `6`; ignored for music)
- `exclude`: comma-separated IDs to exclude from selection (pool is recycled if too few remain)

Example:

```bash
curl "http://localhost:3000/api/quiz-batch?categories=popular,top_rated&count=20&imagesPerFilm=2"
```

Response example:

```json
{
  "movies": [
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
  "imagesPerFilm": 2,
  "categories": ["popular", "top_rated"],
  "poolSize": 230,
  "totalGenerated": 43
}
```

Notes on the response:

- `movies` items use `imageUrls` (an array of backdrop/screenshot/photo URLs) for movies, TV shows, actors, and video games. Music items instead have `artist`, `track`, and `previewUrl` (an audio clip) in place of `imageUrls`.
- `excludedCount` is the number of pool candidates dropped because no usable textless image was found for them.
- `recycled` is `true` when the `exclude` list left too few candidates and the full pool was reused.

## Data Persistence

- `stats.json` stores quiz generation totals and category usage counts.
- The app creates or updates this file automatically.

## Notes

- TMDb data is queried in French (`language=fr-FR`).
- Only "textless" images (no burned-in title/text) are used; an item with no textless image available is excluded from the batch.
- For TV shows, a random season/episode is picked and its own stills are used first, falling back to the show's general backdrops only if no episode still is usable.
- The reservoir is built on startup and refreshed every 30 minutes.
- If the reservoir is not ready yet, `/api/quiz-batch` returns a `503` response.
- Movie/TV/game genre categories are loaded dynamically from their respective APIs at startup.
</content>
