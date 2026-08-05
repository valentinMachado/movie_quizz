// point d'entrée unique du module db — re-exporte tout ce que db.js exposait
// avant son éclatement en fichiers par domaine (voir connection/cache/
// person/movie/tv/game/music/country/typeItem/filters/checkpoint/daily/
// stats.js) : `import * as db from "./db/index.js"` reste identique partout
// (server.js, refresh.js), seul le chemin d'import a changé.

export { init, isFresh, TTL_MS } from "./connection.js";
export { cacheGet, cacheSet } from "./cache.js";

export {
  upsertPerson,
  getPersonPopularity,
  getPersonById,
  getPersonByExternalId,
  personNeedsPaintings,
  personNeedsWikiPhotos,
  markPersonPhotosChecked,
  anyPainterArtworkStale,
  replacePainterArtworks,
  getPainterArtworks,
  painterArtworkCounts,
  personNeedsBirthday,
  setPersonBirthday,
  personNeedsFilmography,
  addDirectorFilmography,
  addActorFilmography,
  replacePersonImages,
  getPersonImages,
  personImagesFetchedAt,
} from "./person.js";

export {
  upsertMovies,
  getMovie,
  movieNeedsDirectors,
  setMovieDirectors,
  setMovieCast,
  getMovieDirectorNames,
  replaceMovieImages,
  getMovieImages,
  movieImagesFetchedAt,
  syncDirectorPoolFromMovieDirector,
  syncActorPoolFromMovieCast,
  syncActorBillingFromMovieCast,
  getDirectorMoviePosters,
  getDirectorMovieSummaries,
  getActorMoviePosters,
  getActorMovieSummaries,
} from "./movie.js";

export {
  upsertTvShows,
  getTvShow,
  addTvImages,
  getTvShowImages,
  getTvWarmedEpisodes,
} from "./tv.js";

export {
  upsertGames,
  getGame,
  replaceGameImages,
  getGameImages,
  gameImagesFetchedAt,
} from "./game.js";

export {
  upsertMusicTracks,
  getMusicTrack,
  getMusicSearchResolutions,
  setMusicSearchResolution,
  forgetMusicSearchResolution,
} from "./music.js";

export { upsertPokemons, getPokemon } from "./pokemon.js";

export { upsertSuperheroes, getSuperhero } from "./superhero.js";

export {
  upsertWikiArticles,
  setWikiArticlePopularities,
  setWikiArticleEventDates,
  getWikiArticle,
  replaceWikiArticleImages,
  getWikiArticleImages,
  wikiArticleImagesFetchedAt,
  wikiArticleNeedsImages,
  anyWikiArticleImagesStale,
} from "./wikiArticle.js";

export {
  upsertCountries,
  getCountry,
  getAllCountries,
  countryPhotosFetchedAt,
  anyCountryPhotosStale,
  replaceCountryPhotos,
  getCountryPhotos,
  countryLeaderCheckedAt,
  setCountryLeader,
  getCountryLeaderGenders,
  getCountryLeaderPopularities,
} from "./country.js";

export {
  replaceTypeItems,
  addTypeItems,
  countTypeItems,
  getMoviePool,
  getTvShowPool,
  getGamePool,
  getMusicTrackPool,
  getCountryPool,
  getPersonPool,
  getPainterPool,
  PAINTER_MIN_ARTWORKS,
  getDirectorPool,
  getActorPool,
  getWikiArticlePool,
  getPokemonPool,
  getSuperheroPool,
  clampTypeGlobalPool,
} from "./typeItem.js";

export {
  getMoviesByReleaseMonthDay,
  getGamesByReleaseMonthDay,
  getMusicTracksByReleaseMonthDay,
  getPersonsByBirthMonthDay,
  getWikiArticlesByEventMonthDay,
} from "./daily.js";

export { markRefreshed, isRefreshFresh } from "./checkpoint.js";

export {
  upsertFilters,
  replaceEntityFilters,
  replaceEntityFilterSubset,
  addEntityFilters,
  pruneUnusedFilters,
  removeEntityFilterCode,
  getEntityFilters,
  getEntityFilterNamesBatch,
  getFilterLabel,
  getFiltersForType,
} from "./filters.js";

export { getStats, recordQuizGenerated } from "./stats.js";
