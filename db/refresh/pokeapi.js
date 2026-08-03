import * as db from "../index.js";
import { logWarn, logInfo } from "./log.js";
import {
  POKEMON_FETCH_CONCURRENCY,
  POKEMON_TYPES,
  POKEMON_GENERATIONS,
  POKEMON_HABITATS,
  POKEMON_STARTER_IDS,
  POKEMON_PSEUDO_LEGENDARY_IDS,
  POKEMON_FOSSIL_IDS,
} from "./config.js";
import { mapWithConcurrency, storePopularityTiers } from "./util.js";

// PokeAPI (pokeapi.co) — gratuite, sans clé, servie derrière un CDN
// (Fastly), tolère bien la concurrence. Un pokémon = 2 requêtes
// (pokemon-species pour le texte/génération/habitat/légendaire, pokemon
// pour le sprite/types/cri/base_experience) — pas de throttle dédié
// (contrairement à Wikidata/IGDB), juste un léger retry réseau.
const POKEAPI_BASE = "https://pokeapi.co/api/v2";

async function pokeapiGet(pathname, attempt = 1) {
  try {
    const res = await fetch(`${POKEAPI_BASE}${pathname}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`PokeAPI ${res.status} sur ${pathname}`);
    return await res.json();
  } catch (e) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 400 * attempt));
      return pokeapiGet(pathname, attempt + 1);
    }
    throw e;
  }
}

function idFromUrl(url) {
  return Number(url.split("/").filter(Boolean).pop());
}

// texte Pokédex le plus utilisable pour cette espèce : FR si connu, repli EN
// (quelques espèces récentes n'ont pas encore de traduction FR sur
// PokeAPI) — le dernier jeu listé plutôt que le premier (texte souvent plus
// consensuel/récent). \n/\f de mise en page Pokédex aplatis en espaces.
function pickFlavorText(entries) {
  const fr = entries.filter((e) => e.language.name === "fr");
  const pool = fr.length
    ? fr
    : entries.filter((e) => e.language.name === "en");
  if (!pool.length) return null;
  return pool[pool.length - 1].flavor_text
    .replace(/[\n\f\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function frenchName(names, fallback) {
  return names.find((n) => n.language.name === "fr")?.name || fallback;
}

async function fetchPokemonRow(id) {
  const [species, pokemon] = await Promise.all([
    pokeapiGet(`/pokemon-species/${id}/`),
    pokeapiGet(`/pokemon/${id}/`),
  ]);
  const spriteUrl =
    pokemon.sprites?.other?.["official-artwork"]?.front_default ||
    pokemon.sprites?.front_default ||
    null;
  if (!spriteUrl) return null; // aucune image exploitable, jamais un item de quiz utile

  const listeCodes = [];
  if (species.is_legendary) listeCodes.push("legendary");
  if (species.is_mythical) listeCodes.push("mythical");
  if (POKEMON_STARTER_IDS.has(id)) listeCodes.push("starter");
  if (POKEMON_PSEUDO_LEGENDARY_IDS.has(id))
    listeCodes.push("pseudo_legendary");
  if (POKEMON_FOSSIL_IDS.has(id)) listeCodes.push("fossil");

  return {
    id,
    name: frenchName(species.names || [], pokemon.name),
    spriteUrl,
    cryUrl: pokemon.cries?.latest || pokemon.cries?.legacy || null,
    summary: pickFlavorText(species.flavor_text_entries || []),
    popularity: pokemon.base_experience ?? null,
    typeCodes: (pokemon.types || []).map((t) => t.type.name),
    generationCode: species.generation?.name || null,
    habitatCode: species.habitat?.name || null,
    listeCodes,
  };
}

export async function fetchPokemonEntities() {
  const list = await pokeapiGet("/pokemon-species?limit=2000");
  const ids = list.results.map((r) => idFromUrl(r.url));

  const rows = [];
  let done = 0;
  const startTs = Date.now();
  await mapWithConcurrency(ids, POKEMON_FETCH_CONCURRENCY, async (id) => {
    try {
      const row = await fetchPokemonRow(id);
      if (row) rows.push(row);
    } catch (e) {
      logWarn(`Erreur pokemon #${id}:`, e.message);
    } finally {
      done++;
      if (done % 100 === 0 || done === ids.length) {
        logInfo(
          `pokemon : ${done}/${ids.length} (${rows.length} valides, ${((Date.now() - startTs) / 1000).toFixed(1)}s)`,
        );
      }
    }
  });
  if (rows.length === 0) return;

  db.upsertPokemons(rows);
  db.replaceTypeItems(
    "pokemon",
    rows.map((r) => r.id),
  );

  db.upsertFilters(
    "pokemon",
    "genre",
    Object.entries(POKEMON_TYPES).map(([code, name]) => ({ code, name })),
  );
  db.replaceEntityFilters(
    "pokemon",
    "genre",
    rows.map((r) => ({ entityId: r.id, codes: r.typeCodes })),
  );

  db.upsertFilters(
    "pokemon",
    "decennie",
    Object.entries(POKEMON_GENERATIONS).map(([code, name]) => ({
      code,
      name,
    })),
  );
  db.replaceEntityFilters(
    "pokemon",
    "decennie",
    rows.map((r) => ({
      entityId: r.id,
      codes: r.generationCode ? [r.generationCode] : [],
    })),
  );

  // habitat : nul pour une bonne partie des espèces (donnée abandonnée par
  // Bulbapedia/PokeAPI au-delà d'une certaine génération) — une entité sans
  // code ici n'apparaît simplement dans aucun filtre "Géographie", comme un
  // pays sans capitale connue reste exclu du mode "flag" (voir
  // materializeCountryRows côté server.js).
  db.upsertFilters(
    "pokemon",
    "geographie",
    Object.entries(POKEMON_HABITATS).map(([code, name]) => ({ code, name })),
  );
  db.replaceEntityFilters(
    "pokemon",
    "geographie",
    rows.map((r) => ({
      entityId: r.id,
      codes: r.habitatCode ? [r.habitatCode] : [],
    })),
  );

  db.upsertFilters("pokemon", "liste", [
    { code: "legendary", name: "Légendaire" },
    { code: "mythical", name: "Mythique" },
    { code: "starter", name: "Starter" },
    { code: "pseudo_legendary", name: "Pseudo-légendaire" },
    { code: "fossil", name: "Fossile" },
  ]);
  db.replaceEntityFilters(
    "pokemon",
    "liste",
    rows.map((r) => ({ entityId: r.id, codes: r.listeCodes })),
  );
  // palier de notoriété (base_experience), additif au groupe "liste"
  // ci-dessus (storePopularityTiers ne touche QUE ses 2 codes dédiés
  // "obscur"/"niche", jamais les codes éditoriaux légendaire/starter/...
  // posés juste avant, voir son commentaire dans util.js) — pas de liste
  // "Populaire" dédiée à exclure ici (contrairement à movie/game/acteurs).
  storePopularityTiers(
    "pokemon",
    rows.map((r) => ({ entityId: r.id, value: r.popularity })),
  );
}
