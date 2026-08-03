# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Guess It" — a Node/Express app that generates quiz videos (guess from a picture, a redacted summary, an audio clip, or — country only — a flag) across 12 content types (movie, tv, person, actor, director, game, music, country, painter, wiki_article, pokemon, superhero). Data comes from TMDb, IGDB, iTunes, mledoze/countries, flagcdn.com, Pexels, Wikidata/Wikimedia Commons, PokeAPI, and Wikipedia. The frontend (`public/`) renders quizzes client-side into a downloadable video (WebCodecs/mediabunny).

## Commands

```bash
npm start          # server.js — serves the API, read-only, zero network calls
npm run refresh     # db/refresh.js — the only process that hits external APIs, loops forever
```

There is no lint/test/build script. **Never run `npm run refresh` yourself** — the user runs it manually and it can take a long time; only read the `cache/*.sqlite` it produces. See CLI flags (`--only`, `--db=`, `--ephemeral-db`, `--max-media-type-count`) in README.md's Configuration section before proposing any manual verification run.

## Architecture

**Two-process split, one shared SQLite file (`cache/data.sqlite`):** `db/refresh.js` does all external API calls and writes entities/images/filters into SQLite. `server.js` only reads that file and serves JSON — it must never make a network request in the request path (quiz-batch, quiz-daily, catalog, pool-size). If a feature needs new data, add a cache-only getter to `db/` + a fetch-and-cache writer wired into a `refresh.js` warm loop; never call a fetcher from `server.js`.

**`db/` is a split module** — `db/index.js` re-exports everything from per-domain files (`connection`, `cache`, `person`, `movie`, `tv`, `game`, `music`, `pokemon`, `superhero`, `wikiArticle`, `country`, `typeItem`, `daily`, `checkpoint`, `filters`, `stats`). Import via `import * as db from "./db/index.js"` — never import a domain file directly from outside `db/`.

**`db/refresh/`** holds the per-source fetchers (`tmdb.js`, `igdb.js`, `music.js`, `pexels-country.js`, `wikidata.js`, `wikipedia.js`, `pokeapi.js`, `superhero.js`, `util.js`, `config.js`, `log.js`) called by `db/refresh.js`'s orchestration loop.

**Data freshness philosophy:** built data (entities, images, directors, paintings, country photos) is treated as ~permanent (~30 day TTL) — only *list membership* (Populaire/Tendances-style rankings) refreshes on a short (~24h) cadence, via a separate lighter path (`TYPES[type].refreshLists`). Freshness is tracked by a generic `checkpoint(scope, key)` table for type/list-level checks; a few high-cardinality per-entity checks (director filmography, painter artwork) intentionally stay as dedicated columns instead of joining `checkpoint` in a hot loop — don't "fix" that into the generic table.

**Filter system:** one generic pair of tables, `filter(type, filter_group, code, name)` / `entity_filter(type, entity_id, filter_group, code)`. Combination rule lives in `db/typeItem.js`'s pool getters, not as stored data: **OR within a `filter_group`, AND across groups**. `genre`/`liste`/`decennie`/`geographie` are the common groups but coverage is genuinely different per type and keeps changing as types get added — some types add their own extra groups on top (`actor` has `billing`, `superhero` has `gender`/`race`, `wiki_article` has `categorie`). **Don't trust a memorized per-type filter matrix (including one written here before) — grep `upsertFilters(`/`storeFilterGroup(` in that type's `db/refresh/*.js` fetcher to get the current, real list.**

**`person` pool is additive, every other type's pool is replace-per-crawl.** `person` is fed by several independent sources (actors, directors, painters, Wikidata-config-driven roles like politician) that only know their own slice, so it uses `addTypeItems`/`addEntityFilters` (`INSERT OR IGNORE`, never deletes) instead of the `replaceTypeItems`/`replaceEntityFilters` every other type uses. This means the `person` pool only grows, never shrinks — a deliberate exception to the "replace = current snapshot" rule.

**Adding a new person "role"** (e.g. scientist, writer): just one entry in `config.json`'s `personRoles.roles` (`{code, label, occupationQid, popularSitelinksMin}`), zero new code — `wikidata.js`'s `fetchAllPersonRoleEntities()` loops the config. Check the SPARQL `queryLimit` against a live query.wikidata.org test if the role's occupation class is broad (politician already needed a lower limit than painter to avoid a 15s timeout).

**Adding a new content type:** register it in `server.js`'s `TYPES` map (`questionTypes`, `getPool`, `materialize`). If it has a `questionType: "image"`, it *also* needs a branch in `getBackdropsForItem` (server.js, separate hardcoded if/else by `item.type`) — missing that silently drops 100% of that type's image items with no error, only a pool-size-vs-quiz-batch mismatch. If it has `questionType: "audio"`, the client pipeline (audio.js/preload.js/timeline.js) picks it up automatically as long as the materialized row has a `previewUrl` — decide only whether it's a long-clip (`loadAndTrimAudio`) or short-loop (`loadAndLoopAudio`) source in `preload.js`, and be aware mono sources (PokeAPI cries) must go through `toStereo()` — the video encoder requires a constant channel count across the whole track.

**ID scheme:** every type/questionType combo that needs a numerically-disjoint id space gets its own offset constant (`*_OFFSET`, in the 1e12+ range) so `itemsFromSelections`'s id-keyed Map never collides raw TMDb/IGDB/PokeAPI ids across types.

**Schema changes to `cache/data.sqlite`** (persistent, never delete this file/dir): additive column → `ALTER TABLE ... ADD COLUMN` inside the existing `migrate()` pattern in `db/connection.js`. Rename/drop/type-change → SQL-only rebuild in one transaction (`CREATE new` → `INSERT SELECT` → `DROP` → `RENAME`), never a JS/JSON dump-and-reload. Propose the rebuild pattern proactively when a change needs it.

**Frontend (`public/js/`):** `filters.js`/`main.js` are the reference client implementation of the HTTP contract (build `selections[]`, call `/api/catalog` + `/api/pool-size` + `/api/quiz-batch`). `render/` + `video/encode.js` handle client-side video composition (canvas rendering + WebCodecs/mediabunny encoding) — this only runs in the browser, never touch it expecting Node semantics.

## Reference docs

- `API.md` — full HTTP contract (request/response shapes, filter combination rules, id-offset scheme).
- `README.md` — setup, env vars, CLI flags, and a long "Notes" section with source-specific quirks (per-country movie/actor sourcing, birthday backfill, country photo rate-limiting, painter vs person+role=painter distinction, director synopsis vs person+role=director, etc.).
- `.md` docs (README.md/API.md/CHANGELOG.md) are only hand-edited by the `release-version` skill at release time, as one squashed commit — so **for anything less than a full version behind, they only reflect the state as of the last release commit** (check `CHANGELOG.md`'s top entry vs. `git log` — any commit since is undocumented). Fine to read for the stable *rationale* behind old, released behavior; **don't trust them for a type/endpoint/field that might have been added or changed since** — verify against the actual code (`server.js`'s `TYPES`, the relevant `db/refresh/*.js`) instead of assuming the doc is current.

## Testing changes

No automated test suite. To verify a change without touching real data: point both `server.js` and `db/refresh.js` at an isolated `--db=cache/test.sqlite` (or `--ephemeral-db`), and/or hand-build a scratch db via `db.upsertMovies`/`replaceTypeItems`/`upsertFilters`/`replaceEntityFilters`/etc. rather than running a live `refresh.js` crawl. Running the server / curling it / `node --check` against such an isolated scratch db is fine to do without asking first — it's cheap and touches nothing real. Ask first only when verification would touch the real `cache/data.sqlite`, run a live `refresh.js` crawl, or otherwise do something the user would rather run themselves.
