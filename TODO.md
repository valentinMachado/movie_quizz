# TODO — dette de dispatch par `type`

État des lieux rédigé le 2026-08-05 (version 1.3.1). Objectif : généraliser les
mécanismes qui décident « que faire de cet item » pour rendre le code
compréhensible, **sans changer ce qu'il est censé faire** — les seules
exceptions assumées sont les deux bugs listés en §1, où le comportement actuel
n'est déjà pas celui attendu.

## Diagnostic

Le projet a déjà le bon modèle — un registre déclaratif — et l'applique bien à
trois endroits : `db/refresh.js` (`TYPES` avec `fetchEntities`/`warmLoops`),
`db/typeItem.js` (`getTypePool` générique), `public/js/config.js`
(`QUESTION_TYPE_DETAILS` + overrides).

Mais **le pipeline de quiz** (matérialisation → préchargement → timeline →
rendu → encodage) ne l'utilise pas. Le même fait — « un item est un couple
(type, questionType), et ça implique telle forme » — y est ré-écrit **10 fois**
en chaînes de `if` indépendantes, chacune avec son ordre et son défaut
implicite. Rien ne force ces 10 chaînes à rester d'accord entre elles, et elles
ont déjà divergé (§1).

## 1. Bugs causés par cette dette

### (a) `country:map` n'a aucun offset d'id — **corrigé**

`toPoolId` (server.js) traitait `country:image`/`flag`/`leader` mais pas `map`.
L'appel traversait les 16 branches et retombait sur `return naturalId`, soit le
ccn3 brut (4–894) — le même espace d'id que les id TMDb/IGDB bruts de
`movie`/`tv`/`game`. Un quiz mêlant « Pays / Carte » et « Films » faisait donc
collisionner le ccn3 avec les petits ids TMDb (238 = Le Parrain, 278, 550…) :
dans `itemsFromSelections`, la `Map` est clée par id, le second item écrasait
le premier et disparaissait sans erreur.

C'est précisément le piège que documentent les commentaires de
`POKEMON_ID_OFFSET` — la chaîne ordonnée l'a laissé passer quand même.

### (b) `actor:summary` cassait le rendu client — **corrigé**

Le serveur produit bien des `overviews[]` pour `actor` (branche
`director || actor` de `selectItemsWithBackdrops`), mais les trois sites de
dispatch client ne testaient que `director` :

| Site | Effet sur `actor:summary` |
| --- | --- |
| `preload.js` | retombait sur `{ overview: m.overview }` → `undefined` |
| `timeline.js` | un seul segment de 5 s au lieu de N frames |
| `main.js` | durée de piste audio « devinette » fausse |

Puis `drawSummaryGuess` passait `undefined` à `wrapText`, qui fait
`text.split("\n")` → **TypeError**. Cassé depuis l'ajout de `actor` en 1.2.3.

`drawSummaryGuess` testait déjà `Array.isArray(m.overviews)` (duck-typing) et
aurait fonctionné : ce sont les trois sites en amont qui n'ont pas suivi. Le
correctif aligne les trois sur ce même test.

## 2. Les 10 points de dispatch

| # | Site | Forme | Coût |
| --- | --- | --- | --- |
| 1 | `server.js` `toPoolId` | 16 `if` **dont l'ordre est sémantique** (`pokemon:summary` doit précéder `pokemon`) | 16 constantes + 16 branches à tenir synchro |
| 2 | `server.js` `materialize*Rows` | 6 fonctions ~copiées-collées | ~250 lignes pour ~40 de logique réelle |
| 3 | `server.js` `getBackdropsForItem` | 9 branches sur `item.type` | oubli = 100 % des items du type droppés **sans erreur** |
| 4 | `server.js` filtre de ratio | exception `person \|\| wiki_article` en dur | liste au milieu d'une fonction |
| 5 | `server.js` `daily*AnniversaryBucket` | 5 fonctions identiques modulo (getter, colonne date, libellé) | |
| 6 | `preload.js` | 6 branches + un `totalTasks` en ternaire qui **duplique** la même table | 2 endroits par ajout |
| 7 | `timeline.js` | 7 branches ; `buildTimeline` à **8 arguments positionnels** | un 9e à chaque type à durée propre |
| 8 | `main.js` (durée piste devinette) | ternaire à 6 niveaux | ré-encode la table de `timeline.js` |
| 9 | `settings.js` `bucketOf` | ternaire à 7 niveaux | ré-encode **encore** la même table |
| 10 | `video/encode.js` | listes de `seg.type` en dur | |

**Le fait central :** les sites 6-10 encodent tous la même information — *quelle
est la forme de cette question* — mais elle n'est écrite nulle part. Chacun la
re-dérive de `(type, questionType)` à sa façon.

Il n'y a pourtant que **6 formes** pour ~24 combos :

| Forme | Combos |
| --- | --- |
| `image-cycle` | movie/tv/game/person/painter/director/actor/wiki_article/country `:image`, pokemon, superhero |
| `text-single` | movie/tv/game/person/wiki_article/pokemon/superhero `:summary` |
| `text-cycle` | director:summary, actor:summary ← *la forme oubliée du bug (b)* |
| `audio` | music, pokemon:audio |
| `still-1img` | country:flag (+ variante carte) |
| `still-2img` | country:leader, statesman |

Autrement dit, `questionType` mélange deux choses orthogonales : **ce qu'on
montre** (sémantique — libellés, filtres, catalogue) et **comment ça se joue**
(mécanique — préchargement, durées, rendu). D'où la re-dérivation permanente.

## 3. Chantiers

- [x] **B — offsets d'id en table** *(petit, désamorce le bug (a))*
      `toPoolId` devient un lookup `ID_OFFSET["country:map"]`. Les commentaires
      des 16 constantes (qui expliquent le *pourquoi*) migrent sur les entrées
      de la table. Un contrôle au démarrage vérifie que chaque combo déclaré
      dans `TYPES` a bien une entrée — c'est ce qui rend un prochain
      `country:map` impossible.

- [x] **D — `getBackdropsForItem` dans `TYPES`** *(risque faible)*
      Chaque entrée de `TYPES` déclare `backdrops(item)` et `ratioFree`. La
      contrainte décrite en prose dans CLAUDE.md (« si `questionType: image`,
      ne pas oublier la branche dans `getBackdropsForItem` ») devient
      structurelle : pas de `backdrops` déclaré = pas de mode image possible.

- [ ] **A — `shape` porté par l'item** *(gros gain, risque faible)*
      Le serveur ajoute un champ `shape` à chaque item matérialisé, dérivé une
      seule fois depuis `TYPES`. Le client remplace ses 5 chaînes (sites 6-10)
      par une table `SHAPES[shape] = { preload, durationOf, segments, draw }`.
      **Purement additif** sur le contrat HTTP : aucun champ existant ne bouge.
      `text-cycle` devenant une entrée explicite, le bug (b) ne peut plus se
      reproduire par omission.

- [ ] **C — `materializeEntityRows` générique** *(−200 lignes, risque moyen)*
      Une fonction + 6 specs
      `{ titleField, summaryField, posterUrl(row), aliasesField?, looseField?, extra(row) }`.
      Idem pour les 5 `daily*AnniversaryBucket` → un générique + une table de 5
      entrées. Risque moyen : il faut être méticuleux sur les différences
      **réelles** (aliases, `loose_redaction`, `personId`/`wikiArticleId`,
      propagation de `reason`) — c'est là qu'un « nettoyage » peut changer le
      comportement sans le vouloir.

- [ ] **E — curseurs de durée par type** *(mécanique, sans risque)*
      `flagSec`/`mapSec`/`leaderSec`/`statesmanSec` sont dupliqués sur 5
      fichiers (index.html, dom.js, settings.js ×3, main.js ×4, timeline.js).
      À faire **après A**, sinon on refactorise deux fois.

## 4. Vérifications faites sur B et D

- `node --check` sur les 4 fichiers modifiés.
- Chargement de `server.js` sur une base isolée (`--db=…/scratchpad/check.sqlite`,
  jamais `cache/data.sqlite`) : les deux garde-fous de démarrage passent.
- **Diff exhaustif ancienne chaîne `if` ↔ nouvelle table**, sur les 26 combos
  `type:questionType` déclarés : **une seule différence, `country:map`** — le
  bug (a). Tout le reste produit des ids identiques au bit près. Les 21 offsets
  non nuls sont deux à deux distincts.

Pas vérifié (à faire tourner de ton côté) : un quiz réel de bout en bout, en
particulier un lot mêlant **Pays / Carte** (ids changés) et un **acteur en mode
Résumé** (le chemin du bug (b)). Aucun `npm run refresh` n'est nécessaire : ces
changements ne touchent ni le schéma, ni les types, ni les filtres — uniquement
la façon dont `server.js` lit ce qui est déjà en base.

## 5. Ce qu'on ne touche pas

- **`db/refresh.js`, `db/typeItem.js`, `db/filters.js`** — déjà génériques, ce
  sont les modèles à imiter.
- **Les commentaires longs.** Ils expliquent les *pourquoi* (pièges d'ids,
  ratios, TTL) et sont la vraie doc du projet. Un refactor doit les
  **déplacer**, jamais les résumer.
- **`render/scenes.js`** au-delà de `drawSegment`. Les fonctions de dessin sont
  légitimement spécifiques ; seul le routeur mérite une table.
