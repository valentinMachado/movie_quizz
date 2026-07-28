# Movie Quizz

Movie Quizz is a small Express.js application that generates movie quiz batches using The Movie Database (TMDb) API. It serves a static frontend from `public/` and provides quiz data through JSON API endpoints.

## Features

- Generates quiz batches from TMDb categories, decades, and genres
- Uses backdrop and poster images with textless backdrops when available
- Keeps usage stats in `stats.json`
- Refreshes its movie reservoir every 20 minutes

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

## Run

Start the app with:

```bash
npm start
```

Then open `http://localhost:3000`.

## Configuration

- `PORT` can be set in `.env` to override the default `3000`
- `TMDB_API_KEY` is required for TMDb requests

## API Endpoints

### `GET /api/categories`

Returns available categories along with their labels, groups, and current reservoir sizes.

### `GET /api/pool-size?categories=cat1,cat2`

Returns the number of movies available in the merged pool for the requested categories.

### `GET /api/stats`

Returns total generated quizzes and the top used categories.

### `GET /api/quiz-batch`

Generates a quiz batch with optional query parameters:

- `categories`: comma-separated category keys
- `count`: number of movies in the batch (between 5 and 100)
- `imagesPerFilm`: number of extra backdrop images per movie (between 1 and 6)
- `exclude`: comma-separated movie IDs to exclude

Example:

```bash
curl "http://localhost:3000/api/quiz-batch?categories=popular,top_rated&count=20&imagesPerFilm=2"
```

## Data Persistence

- `stats.json` stores quiz generation counts and category usage.
- The app creates or updates this file automatically.

## Notes

- The app fetches TMDb genre definitions at startup.
- It uses a rate-limited request queue to stay within TMDb API limits.
- If the reservoir is not ready yet, `/api/quiz-batch` returns a `503` response until data is available.
