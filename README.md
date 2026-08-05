<img src="./public/logo.png" alt="Logo" width="300" height="300">

Guess It is a small Node.js + Express application that generates "guess it from a picture, a redacted summary, an audio clip, a flag, or a zooming map" quiz batches across 13 content types: movies, TV shows, people (actors/directors/painters, plus any Wikidata-driven role added via config — e.g. politicians, athletes, writers, scientists, singers, astronauts — guessed from their own photo/summary), actors and directors (guessed instead from posters/summaries of their filmography), video games, music, countries (guess from a photo, the flag, a zooming-in map, or the current head of state's portrait — see `questionType` below), heads of state (`type: "statesman"`, the inverse of country's own `leader` mode: guess the head of state from the country's flag), paintings (guess the painter), Wikipedia articles (history, science, geography, monuments, architecture, mythology, animals, music, gastronomy, games...), Pokémon, and superheroes. It pulls data from TMDb (movies/TV/people), IGDB (video games, optional), Apple Music/iTunes (songs), mledoze/countries (country list, capitals), flagcdn.com (flag images), a vendored world topology (the map-guessing mode), Pexels (country photos, optional), Wikidata/Wikimedia Commons (paintings, person roles, country populations/genders), Wikipedia (articles, country leaders, and as a biography fallback for people), PokeAPI (Pokémon), and superhero-api (superheroes), serves a static frontend from `public/`, and exposes JSON REST endpoints for quiz generation, pool statistics, and usage tracking.

## Features

- Generates quiz batches from categories, decades, genres, and geography (continents, and — for most types — specific countries) across 13 content types: movie, tv, person, actor, director, game, music, country, statesman, painter, wiki_article, pokemon, superhero
- Directors/actors can be guessed either from the posters of the movies they directed/starred in, or from a (redacted) summary of several of those movies cycled one after another (`type: "director"`/`"actor"`, `questionType: "image"`/`"summary"`) — separately from guessing an actor/director/painter/other-role person's own photo (`type: "person"`, `role` filter)
- Movies, TV shows, video games, people, Wikipedia articles, Pokémon, and superheroes can also be guessed from a (redacted) summary, not just a poster (`questionType: "summary"`) — summaries are truncated to a client-configurable length (`maxSummaryLen`, 100–1000 characters, see API.md) and have the subject's title/name (and known aliases, for wiki_article/superhero) masked, matching whole words only by default
- Movies, TV shows, video games, music, actors, directors, painters, painter/person-role people, statesmen, Wikipedia articles, and superheroes can be filtered by a popularity tier ("Obscur"/"Niche"/"Star", layered on top of the existing "Populaire" list where one exists — "Star" is the top half, by value, of whatever is already tagged "Populaire"; types with no separate curated popular list — painters, wiki articles, superheroes, Wikidata person roles, statesmen — get a full "Obscur"/"Niche"/"Populaire"/"Star" quartile split instead) — derived from each source's own popularity/rating-count signal, recomputed on every full refresh. Pokémon is the one exception: no curated "Populaire" list to build "Star" from, so it keeps just "Obscur"/"Niche"
- Music adds a curated "Classiques" list (well-known blind-test-style tracks, resolved by exact title search on every refresh rather than a pre-resolved id) alongside its per-country popularity charts
- Countries can be guessed four ways (`questionType`): from a photo (needs Pexels), from the flag (guess the country **and** its capital, no key needed), from a zooming-in silhouette on a vectorized world map (`"map"`, no key needed, 100% client-rendered), or from its current head of state's portrait+name (`"leader"`, no key needed, sourced from the same local Wikipedia dump as `wiki_article`) — several can be active at once, in which case a country may appear more than once in the same quiz, once per mode
- **Heads of state** (`type: "statesman"`): the inverse pairing of `country`'s `leader` mode — guess the head of state (a person) from the country's flag and name, reveal shows their portrait and title. Reuses `country`'s own pool/filters rather than having any of its own
- **Wikipedia articles** (`type: "wiki_article"`): guess the subject (not just a person — battles, chemical elements, rivers, monuments, castles/bridges/skyscrapers/lighthouses, mythological creatures, animals, musical instruments, foods, board games...) from a photo or a redacted extract, sourced from configurable Wikipedia categories (`config.json`'s `wikiArticle.categories`) rather than a fixed curated list. A "histoire" (battle/war) article with a day-precision Wikidata event date can also surface in the daily quiz as an anniversary ("Survenu il y a N ans"), same mechanism as movie/game/person anniversaries
- **Pokémon** (`type: "pokemon"`): guess from official artwork, a redacted Pokédex entry, or its cry (`questionType: "image"`/`"summary"`/`"audio"`), filterable by elemental type, generation, habitat, and legendary/mythical/starter/pseudo-legendary/fossil status
- **Superheroes** (`type: "superhero"`): guess from a portrait or a redacted bio synthesized from structured fields (occupation, affiliations...), filterable by publisher, alignment, gender, race, era, and country/origin
- **Person roles are config-driven**: beyond actors/directors/painters, `config.json`'s `personRoles.roles` (e.g. politicians, athletes, writers, scientists, singers, astronauts) adds a whole new guessable Wikidata-sourced category of people — image + summary + an optional "position held" field — with zero new code
- `person`/`actor`/`director`/`painter`/`statesman` share a `gender` filter (Homme/Femme/Non-binaire), sourced from TMDb or Wikidata depending on where the person comes from (distinct from `superhero`'s own binary `gender` vocabulary) — also used to correctly gender the role label shown on the reveal screen (e.g. "Actrice" vs "Acteur")
- Returns one or more textless backdrop images per item (or an audio preview for music/Pokémon cries)
- **Quiz du jour** (`POST /api/quiz-daily`): a self-contained daily quiz with no client-chosen filters — mixes today's release/birthday anniversaries (movies, games, music, people) with today's trending/chart lists, seeded by date so everyone gets the same quiz until midnight. See API.md for the exact selection rules.
- Persists everything — entities, images, directors, paintings, country photos, Wikipedia article images — in a single SQLite database (`cache/data.sqlite`)
- Built data (entities, images, directors, paintings, country photos) is treated as near-permanent (~30 day TTL); only list membership (Populaire/Tendances) is refreshed on a short (~24h) cadence
- Uses rate-limited request queues for TMDb, IGDB, Pexels, Wikidata, and the Wikipedia/Wikimedia APIs to avoid API throttling
- Video games and country photos are both optional: without the relevant API credentials, the server starts normally and simply omits that category (or, for countries, falls back to flag/map/leader guessing); PokeAPI, superhero-api, and Wikidata/Wikipedia need no key at all

## Requirements

- Node.js 18 or later
- A `bzip2` binary on `PATH` — **required by `refresh.js`, not by `server.js`**. Node has no bzip2 support and the pure-JS implementations are far too slow for multi-gigabyte dumps, so the external binary is spawned. Without it, `refresh.js` still runs but falls back to the (heavily rate-limited) Wikipedia API for article summaries and popularity. See [Deployment](#deployment).
- A TMDb API key
- Optionally, IGDB (Twitch Developer) credentials for the video game category
- Optionally, a Pexels API key for the country photo-guessing mode (landmark/landscape photos)
- No key needed for the painting category or the Wikidata-driven person roles (Wikidata is free and keyless), the Wikipedia article category (Wikipedia's own API, also free and keyless), Pokémon (PokeAPI), superheroes (superhero-api), the statesman category, nor for the flag/map/leader-guessing modes of the country category (mledoze/countries and flagcdn.com are both free and keyless; the map is a vendored static file, no tile server; the head-of-state data comes from the same local Wikipedia dump as the article category)

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

## Deployment

Only `refresh.js` has requirements beyond Node — `server.js` needs nothing but
the `cache/` directory it reads from. A machine that only serves the API can
therefore skip everything in this section.

**`bzip2` binary.** Wikimedia publishes its dumps as `.bz2`, a format Node
cannot read natively. Install it before the first refresh:

```bash
apt install bzip2          # Debian/Ubuntu
dnf install bzip2          # Fedora/RHEL
brew install bzip2         # macOS
choco install bzip2        # Windows (or Git Bash, which ships with it)
```

`refresh.js` probes for it at startup and logs a warning if it is missing,
then falls back to the Wikipedia API — functionally equivalent but far slower
(measured: 4091 s versus 426 s to build the `wiki_article` pool, Wikimedia
answering `429 Too Many Requests` with `Retry-After: 51` under load). Country
leader data (`questionType: "leader"`, type `statesman`) has no such
fallback: without the local dump, those two modes simply stay empty until it
gets installed.

**Disk.** `cache/` holds everything and must never be deleted:

| file | steady-state size | rebuilt |
| --- | --- | --- |
| `data.sqlite` | ~100 MB | never — this is the app's data |
| `frwiki-index.sqlite` | ~5 GB | every ~30 days, ~2 h 30 |

Downloaded archives are deleted as soon as they are ingested, so steady state
is ~5 GB. Budget a further ~6 GB of headroom for the largest archive held
transiently during a rebuild (`KEEP_DUMP_FILES` in `db/refresh/frwiki-dump.js`
keeps them instead, for debugging — never enable it in production).

The index is rebuilt table by table, so adding or changing one dump only
re-downloads that one. It is also independent of `data.sqlite`: wiping the
app's data does not cost another 2 h 30 of dump ingestion.

**Network.** A first full refresh downloads ~1.9 GB of SQL dumps plus ~5 GB
per month of pageview data, then ~2 GB of targeted range requests against the
7.2 GB article dump (never downloaded whole — see `db/refresh/frwiki-dump.js`).
Steady state is roughly one month's pageview archive per month.

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

The full HTTP contract (`GET /api/catalog`, `POST /api/pool-size`, `GET /api/stats`, `POST /api/quiz-batch`, `POST /api/quiz-daily`) is documented in [API.md](API.md), including the exact request/response shapes, the filter combination rules (OR within a filter group, AND across groups), and the "offset" id scheme used to keep forms of the same entity (e.g. `movie:image` vs `movie:summary`) distinguishable. `public/js/filters.js` and `public/js/main.js` are the reference client implementation of that contract.

## Data Persistence

Everything — entities, images, directors, paintings, country photos, Wikipedia article images, the filter tables (genre/liste/decennie/geographie plus a few type-specific groups — `role` for person, `gender` for person/actor/director/painter/statesman, `billing` for actor, `categorie` for wiki_article, `gender`/`race` for superhero), and usage stats — lives in `cache/data.sqlite`, created and migrated automatically on first run. There is no separate stats file.

`cache/` also holds the local Wikimedia dump index (`frwiki-index.sqlite` and its companions), which `refresh.js` builds and reads but `server.js` never touches. It carries its own freshness journal, so the two are independent: deleting `data.sqlite` does not invalidate the index, and vice versa. See [Deployment](#deployment) for sizes and rebuild costs.

## Notes

- TMDb data is queried in French (`language=fr-FR`).
- Only "textless" images (no burned-in title/text) are used; an item with no textless image available is excluded from the batch.
- For TV shows, a random season/episode is picked and its own stills are used first, falling back to the show's general backdrops only if no episode still is usable.
- If no pool has been populated yet by `refresh.js`, `/api/quiz-batch` returns a `503` response; `/api/stats`'s `ready` flag reflects the same condition plus whether the "blocking" background warm loops (painter artwork, country photos) are caught up with what's currently in the pool.
- Movie/TV/game genre filters are loaded dynamically from their respective APIs.
- Music genre and decade filters: genres come from a separate iTunes RSS feed (which supports genre filtering, unlike the country-chart feed used for the "liste" filters); decades have no dedicated feed at all — Apple only exposes current charts, so tracks already fetched are grouped after the fact by their release year.
- Movie "country" filters (~14 countries, shared list with the actor-discovery mechanism below) are built from each country's own popular movies (`discover/movie?with_origin_country=XX`), rather than by filtering a single global "popular" list — TMDb has no nationality filter, and the global popular list skews heavily US/English-language, so filtering/classifying it by birthplace previously left non-US filters nearly empty. This can occasionally surface a co-production credited to a country it's not really "from," which is an accepted trade-off.
- The `person` pool discovers actor entities the same way — each country-specific popular-movie crawl above also contributes its top-billed cast (`role: "actor"` tag) — but that's entity *discovery*, not a `geographie` filter on `person` itself (there isn't one). The **`actor`/`director`** types' own `decennie`/`geographie` filters are unrelated: computed from each person's own TMDb `birthday`/`place_of_birth`, recomputed at every `refresh.js` startup from the current pool. `actor` additionally gets a `billing` filter (`tete_affiche`/`second_couteau`), a single mutually-exclusive code per actor based on their average `cast_order` across every film in `movie_cast` (`config.json`'s `movie.leadCastLimit`, currently 3) — a per-film "was this a lead role" flag was tried and rejected (with `movie.castLimit` = 10 stored per film, nearly every actor has at least one film outside the lead range, so it matched ~80% of the pool including genuine leads).
- Person birthdays (used by "quiz du jour", see below) are sourced differently depending on where the person comes from, but every source ends up in the same `person.birthday` column, so the anniversary pool treats them uniformly. TMDb-sourced people (actors/directors) need an extra `/person/{id}` call for their `birthday`, run in its own background warm loop (like the painter and country-photo ones), not inline in the main refresh pass — with thousands of people this can take a while and would otherwise block the whole pool from becoming ready behind it; birthdays are cached for ~30 days (they never change). Wikidata-sourced people (painters, and any `personRoles` role like politician/athlete) get theirs from P569, resolved inline during their own crawl (not a separate warm loop) — but only when Wikidata records it at **day** precision (`wikibase:timePrecision >= 11`): a birth date known only to the year or month is deliberately discarded rather than stored as a fake "January 1st", which would otherwise pile up unrelated people on the same false anniversary. Either way, a person with no usable day-precision birth date simply never surfaces in the "quiz du jour" anniversary pool.
- Country filters cover all four guessing modes (`questionType: "image"`/`"flag"`/`"map"`/`"leader"`): the country list comes from [mledoze/countries](https://github.com/mledoze/countries) (a free, keyless, actively-maintained mirror of the data the original REST Countries API used to serve before it moved behind a paid plan; `population` was dropped from that upstream schema at some point and is now fetched separately from Wikidata, P1082). `"image"` needs `PEXELS_API_KEY`: guessing photos come from a Pexels keyword search (`"<country> landmark"` / `"<country> landscape"`), and the flag (from [flagcdn.com](https://flagcdn.com), free/keyless) is only used as the answer-reveal image. `"flag"` needs no API key at all: the flag itself serves as both the guessing image and (alongside the country/capital text) the reveal image — guess duration is a dedicated `flagSec` setting, independent of `imageSec`/`imagesPerItem`, the same way music has its own clip-length setting. `"map"` also needs no key: a zoom from the whole world down to the target country's silhouette, rendered client-side from a vendored, static topology (`public/data/world-110m.json`) — its reveal reuses the same flag+capital screen as `"flag"`, hence the same `capital` requirement; a handful of small/dependent territories present in mledoze aren't in that topology and are excluded from `"map"` only. `"leader"` needs no key either: guess the country from its current head of state's portrait+name, parsed out of that country's own Wikipedia infobox in the same local dump `wiki_article` uses (see Deployment) — the discovered head of state also becomes an ordinary `person` row tagged `role: "politician"`. The inverse pairing — guess the head of state from the country's flag+name — is the separate top-level type `statesman`, which reuses `country`'s own pool/filters rather than having any of its own (`GET /api/catalog` maps its filters from `type: "country"` under the hood, see API.md). A country with no `capital` has no `"flag"`/`"map"` entry; one whose head of state couldn't be resolved has no `"leader"`/`"statesman"` entry — each excluded from that mode only, still available for the others.
- Country photos are fetched and cached by a dedicated background loop, paced to stay under Pexels' free-tier rate limit (200 requests/hour) — **not** by quiz generation itself, which only ever reads whatever is already cached. This means a country not yet reached by that background loop is simply excluded from quizzes (via `excludedCount`) rather than making the request slow. Without `PEXELS_API_KEY`, country filters still exist and work for `"flag"`; the `"image"` entries just never resolve to a usable photo and are excluded the same way.
- Painter filters guess the **painter**, not the artwork title. Data comes from [Wikidata](https://www.wikidata.org) (free, keyless SPARQL queries), images from Wikimedia Commons. Unlike a museum-specific API, this isn't limited to one collection, but each filter is a single-condition query (genre OR country OR era OR a notability threshold) rather than a curated "best of" list — outside of the "popular" filter, a result isn't guaranteed to only contain famous works, just paintings matching that one filter with a usable image. A painter can also appear in the `person` pool (guess from their portrait, `role: "painter"`) — same person, two independent ids and image pools, see API.md.
- With `imagesPerItem > 1` (or, for `director:summary`/`actor:summary`, `summaryPerItem > 1`), each frame of an item shows a _different_ image/summary rather than repeating the same one — if an item has fewer available than requested, it simply gets fewer frames instead of a repeat.
- Painting images are loaded directly by the browser from Wikimedia Commons, like every other type's images — the server never proxies them. If a specific image fails to load client-side (network hiccup, browser privacy settings blocking third-party resources, etc.), that item is silently dropped from the quiz instead of aborting the whole batch.
- Director/actor filters guess the **director**/**actor**, either from posters of the movies they directed/starred in (`questionType: "image"`) or from a redacted summary of several of those movies cycled as frames (`questionType: "summary"`, movie title shown as a caption, director/actor's own name masked in the text) — both distinct from guessing their own photo (`type: "person"`, `role: "director"`/`"actor"`). A director's filmography is completed beyond the curated `movie` pool via their own TMDb credits, in a dedicated background warm loop, so guessing isn't limited to the handful of their films that happen to already be in the popularity/genre/decade/country pool; an actor's filmography comes from the same `movie_cast` table used for the `billing` filter above.
- `person:summary` reads a `person.summary` column filled by whichever source got there first: a Wikidata-role person (politician, athlete...) gets a French Wikipedia extract of their own article; a TMDb-sourced actor/director gets TMDb's own `biography` field, falling back to a French then English Wikipedia extract if TMDb has none. A Wikidata-role person can also carry a `positionHeld` field (Wikidata P39, e.g. an office held — first value wins, no "most notable" heuristic), shown on the reveal screen when present, same optional-field convention as `capital` on `country:flag`. A painter (`role: "painter"`) never has a summary — Wikidata rarely documents painters' biographies as thoroughly as politicians/athletes.
- Wikipedia article filters cover the `wiki_article` type end to end: the pool is built from configurable Wikipedia categories (`config.json`'s `wikiArticle.categories`, e.g. "Bataille", "Élément chimique", "Fleuve", "Monument", "Château", "Créature légendaire", "Instrument de musique", "Fromage", "Jeu de société", several animal categories), grouped into a `categorie` filter (Histoire/Sciences/Géographie/Monuments/Architecture/Mythologie/Animaux/Musique/Gastronomie/Jeux) plus the usual `genre`/`decennie`/`geographie` where resolvable from the article's own Wikidata item — `geographie` groups by the same ~24-code subregion vocabulary as `country`, not by the ~190 individual countries seen on the raw pool, which would otherwise flood the filter UI with one checkbox per country. A "histoire" article's event date (P585/P580/P571) feeds the "quiz du jour" anniversary pool the same way movie/game/person release/birth dates do, with the same day-precision-only discipline. Redaction masks the article's title and any known aliases (Wikipedia redirects — alternate spellings, foreign/scientific names) under `[titre]`/`[alias]`; animal categories opt into "loose" redaction (substring match instead of whole-word) since a common-name derivative (e.g. "renard" → "renardeau") would otherwise leak the answer.
- Pokémon filters (`type: "pokemon"`) come straight from PokeAPI: `genre` = elemental type (full coverage), `decennie` = generation (full coverage), `geographie` = habitat (partial — PokeAPI/Bulbapedia stopped tracking habitat past a certain generation), `liste` = legendary/mythical (from the API) plus starter/pseudo-legendary/fossil (hardcoded national-dex-number lists in `config.json`, no API equivalent for those) and an `obscur`/`niche`/`populaire` tier from `base_experience`. The Pokédex flavor text (French, falling back to English) is redacted the same way as any other summary. Cries are short mono clips, converted to stereo client-side before video encoding (every other audio source in the app is stereo, and the encoder requires a constant channel count throughout the track).
- Superhero filters (`type: "superhero"`, sourced from the free superhero-api dataset, ~560 comic-book characters) cover publisher (Marvel/DC), alignment (hero/villain/neutral, reused as the `genre` group), gender, race, era (pre/post-1990 first appearance), and country/origin (including an "extraterrestrial" bucket matched on planet/galaxy/dimension keywords) — plus an `obscur`/`niche`/`populaire` tier from a composite score (how many biography/work/connection fields are filled in). There's no ready-made bio text in the source data, so a French summary is synthesized from structured fields (alignment, occupation, affiliations...); known aliases (real name, alter ego) are redacted the same way as `wiki_article`.
- Popularity tiers (`liste` filter codes `obscur`/`niche`/`star`, plus `populaire` for types with no separate curated popular list — painter, wiki_article, superhero, statesman, Wikidata person roles) are recomputed from scratch on every full refresh, split at the median (movie/tv/game/music/person/actor) or quartiles (painter/wiki_article/superhero/statesman/person-role, computed **within each Wikidata role's own population** so politicians and athletes are compared only to their own kind) of each source's own popularity/rating-count signal, excluding whatever is already tagged by that type's curated "Populaire" list where one exists. `star` is the newest tier: for the median-split types it's the top half, by value, of whatever's already tagged `populaire`/that type's curated list; for the quartile-split types it's simply the top quartile. Pokémon is the one type with neither a curated "Populaire" list nor a quartile split, so it never gets a `star` tier. `person` is the exception among the median-split types: TMDb's curated popular list *is* its `populaire` tier rather than a separate code, because the two signals feeding that pool are not comparable (TMDb popularity has a median of 0.96 and a maximum of 71; Wikipedia pageviews, used for Wikidata roles, a median of 87 and a maximum of 425 853) — a single split over both would have made every actor `obscur` and every Wikidata person `populaire`.
- The `painter` pool is built from anyone Wikidata lists "painter" among the occupations of, which pulls in people who did paint but have no catalogued work (Freddie Mercury, Serge Gainsbourg, George W. Bush — 820 of 1154 entries had zero artwork). Quiz generation therefore requires at least `PAINTER_MIN_ARTWORKS` (3) known works, and the popularity tiers are recomputed over that subset only — as a read-time filter, since artworks are fetched by a background warm loop *after* the pool is built, and filtering at insertion would permanently strand painters not yet visited.
- Adding a new Wikidata-sourced person role (e.g. chef, architect) needs zero new code: one entry in `config.json`'s `personRoles.roles` (`code`, `label`, `occupationQid`, `popularSitelinksMin`) is enough — `refresh.js` picks it up automatically. Worth a live SPARQL sanity check against `query.wikidata.org` first if the role's occupation class is broad (a wide class combined with the popularity filter can approach the query timeout — `politician` already needed a lower `queryLimit` than `painter` for this reason).
