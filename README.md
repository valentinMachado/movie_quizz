# Movie Quizz

Movie Quizz is a small Node.js + Express application that generates movie and TV quiz batches using The Movie Database (TMDb) API. It serves a static frontend from `public/` and exposes JSON REST endpoints for quiz generation, pool statistics, and usage tracking.

## Features

- Generates quiz batches from TMDb categories, decades, and genres
- Supports both movies and TV shows
- Returns one or more textless backdrop images per item
- Persists usage statistics in `stats.json`
- Refreshes its TMDb reservoir on startup and every 30 minutes
- Uses a rate-limited TMDb request queue to avoid API throttling

## Requirements

- Node.js 18 or later
- A TMDb API key

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

4. Optionally set a custom port in `.env`:

```env
PORT=4000
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

## API Endpoints

### `GET /api/categories`

Returns the available category keys, labels, groups, media types, and current reservoir sizes.

Response example:

```json
{
  "categories": [
    { "key": "popular", "label": "Populaires", "group": "liste", "mediaType": "movie", "available": 120 },
    ...
  ],
  "minCount": 5,
  "maxCount": 100
}
```

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
- `imagesPerFilm`: number of extra backdrops per item (default: `1`, min: `1`, max: `6`)
- `exclude`: comma-separated movie/TV IDs to exclude from selection

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
  "imagesPerFilm": 2,
  "categories": ["popular", "top_rated"],
  "poolSize": 230,
  "totalGenerated": 43
}
```

## Data Persistence

- `stats.json` stores quiz generation totals and category usage counts.
- The app creates or updates this file automatically.

## Notes

- The TMDb backend is queried in French (`language=fr-FR`).
- The reservoir is built on startup and refreshed every 30 minutes.
- If the reservoir is not ready yet, `/api/quiz-batch` returns a `503` response.
- Categories and genres are loaded dynamically from TMDb at startup.
