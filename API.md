# API serveur — contrat client

Documente le contrat HTTP exposé par `server.js` tel qu'il existe aujourd'hui. Le client (`public/js/filters.js`, `public/js/main.js`) est branché dessus.

`server.js` ne fait plus aucun appel réseau : il lit uniquement `cache/data.sqlite`, peuplée en tâche de fond par `refresh.js` (process séparé). Toute la logique de filtrage/génération décrite ici lit cette base ; rien n'est jamais fetché à la demande.

## `GET /api/catalog`

Tout ce dont le client a besoin pour construire son UI de sélection : par type, les `questionType` possibles (fixe, structurel) et les filtres disponibles (data-driven, reflète ce que `refresh.js` a réellement écrit en base — vide tant qu'un type n'a pas été peuplé, pas d'erreur).

```json
{
  "movie": {
    "questionTypes": ["image", "summary"],
    "filters": {
      "genre": [{ "code": "28", "name": "Action" }],
      "liste": [{ "code": "popular", "name": "Populaire" }],
      "decennie": [{ "code": "decade_1990", "name": "Années 1990" }],
      "geographie": [{ "code": "fr", "name": "France" }]
    }
  },
  "tv": { "questionTypes": ["image", "summary"], "filters": { "genre": [...], "liste": [...], "decennie": [...], "geographie": [...] } },
  "person": { "questionTypes": ["image", "summary"], "filters": { "role": [{ "code": "actor", "name": "Acteur" }, { "code": "director", "name": "Réalisateur" }, { "code": "painter", "name": "Peintre" }, { "code": "politician", "name": "Politicien" }, { "code": "athlete", "name": "Sportif" }], "liste": [...], "decennie": [...], "geographie": [...] } },
  "game": { "questionTypes": ["image", "summary"], "filters": { "genre": [...], "liste": [...], "decennie": [...] } },
  "music": { "questionTypes": ["audio"], "filters": { "genre": [...], "liste": [...], "decennie": [...], "geographie": [...] } },
  "country": { "questionTypes": ["image", "flag"], "filters": { "geographie": [...] } },
  "painter": { "questionTypes": ["image"], "filters": { "genre": [...], "decennie": [...], "geographie": [...] } },
  "director": { "questionTypes": ["image", "summary"], "filters": { "decennie": [...], "geographie": [...] } },
  "actor": { "questionTypes": ["image", "summary"], "filters": { "billing": [...], "decennie": [...], "geographie": [...] } },
  "wiki_article": { "questionTypes": ["image", "summary"], "filters": { "categorie": [...], "genre": [...], "liste": [...], "decennie": [...], "geographie": [...] } },
  "pokemon": { "questionTypes": ["image", "summary", "audio"], "filters": { "genre": [...], "liste": [...], "decennie": [...], "geographie": [...] } },
  "superhero": { "questionTypes": ["image", "summary"], "filters": { "genre": [...], "liste": [...], "gender": [...], "race": [...], "decennie": [...], "geographie": [...] } }
}
```

Les groupes de filtre présents varient par type et évoluent avec le code (pas de liste codée en dur côté client à maintenir, et ce tableau lui-même peut se périmer — se fier à la réponse réelle de cet endpoint, pas à cette doc, pour savoir ce qui est disponible aujourd'hui). Un groupe absent = pas de filtre possible sur cet axe pour ce type. Le groupe `role` sur `person` est le seul qui ne dérive pas d'une source externe standard (genre/décennie/etc.) — voir la section dédiée plus bas.

**Règle de combinaison des filtres** (identique partout où `filters` est utilisé, voir `POST /api/quiz-batch`) : OR entre les codes d'un même groupe, AND entre groupes différents. Ex. `{ "liste": ["popular", "trending_day"], "genre": ["28"] }` = (Populaire OU Tendance) ET Action.

## `POST /api/pool-size`

Taille du pool pour une sélection donnée — sert à afficher "N éléments disponibles" pour les filtres en cours **avant** de générer un batch.

```json
// requête (selections omis/vide = taille globale non filtrée, tous types confondus)
{ "selections": [{ "type": "movie", "questionType": "image", "filters": { "genre": ["28"] } }] }
```
```json
// réponse
{ "available": 42 }
```
400 si un `type`/`questionType` est invalide (voir table des `questionTypes` valides par type dans `/api/catalog`).

## `GET /api/stats`

```json
{ "totalGenerated": 1234, "version": "1.2.3", "ready": true }
```
`ready` = la base a au moins un pool non vide ET les warmLoops "bloquants" (tableaux de peintre, photos pays si Pexels configuré, images d'articles Wikipédia) sont à jour pour tout ce qui est actuellement dans le pool. `false` typiquement juste après une repopulation, tant que le chauffage progressif tourne encore.

## `POST /api/quiz-batch`

Génère un batch de questions.

```json
// requête
{
  "count": 20,
  "imagesPerItem": 3,
  "summaryPerItem": 2,
  "exclude": [123, 456],
  "selections": [
    { "type": "movie", "questionType": "image", "filters": { "liste": ["popular"] } },
    { "type": "movie", "questionType": "summary", "filters": { "decennie": ["decade_1990"] } },
    { "type": "country", "questionType": "flag" }
  ]
}
```
- `count` : clampé serveur entre 5 et 50.
- `imagesPerItem` : clampé serveur entre 1 et 20 — **borne haute**, pas une garantie : un item avec moins d'images disponibles que ça reçoit simplement moins de frames plutôt qu'une répétition (voir table des formes ci-dessous).
- `summaryPerItem` : clampé serveur entre 1 et 5, même principe que `imagesPerItem` mais pour `director:summary`/`actor:summary` uniquement (seuls type/questionType qui cyclent plusieurs summary) — sans effet sur les autres formes.
- `exclude` : ids à éviter (voir "ids à offset" plus bas) — si pas assez d'items restent disponibles, le serveur ignore `exclude` entièrement pour ce batch et le signale via `recycled: true` plutôt que de renvoyer moins que `count`.
- `selections` : **requis, au moins une entrée**. Chaque entrée est un bucket indépendant `{type, questionType, filters?}` — c'est ce qui permet des filtres différents pour `movie:image` et `movie:summary` dans la même requête. Deux entrées avec la même paire `type:questionType` (filtres différents) sont fusionnées dans un seul bucket de stratification (leurs pools s'additionnent).
- 503 si la base n'a encore aucun pool peuplé du tout (`{"error": "..."}`, message affichable tel quel).
- 400 si `selections` vide/absent, ou si une entrée référence un `type`/`questionType` invalide (`{"error": "..."}`, message affichable tel quel).

```json
// réponse
{
  "items": [ /* voir table des formes ci-dessous */ ],
  "recycled": false,
  "requested": 20,
  "delivered": 18,
  "excludedCount": 2,
  "imagesPerItem": 3,
  "summaryPerItem": 2,
  "poolSize": 57,
  "totalGenerated": 1235
}
```
`delivered` peut être `< requested` si le pool filtré est trop petit (pas d'erreur, juste moins d'items) — `excludedCount` compte les items du tirage initial qui n'avaient au final aucune image utilisable et ont été écartés.

### Forme de chaque item selon `type:questionType`

Champs communs à toutes les formes : `id`, `title`, `type`, `questionType`, `posterUrl`.

| `type:questionType` | champs additionnels |
|---|---|
| `movie:image`, `tv:image` | `imageUrls: string[]` ; `director?: string` (movie uniquement, si connu) |
| `movie:summary`, `tv:summary`, `game:summary`, `person:summary`, `wiki_article:summary`, `pokemon:summary`, `superhero:summary` | `overview: string` (tronqué à 800 caractères, titre/nom — et alias connus pour wiki_article/superhero — masqués) |
| `person:image`, `game:image`, `painter:image`, `wiki_article:image`, `pokemon:image`, `superhero:image` | `imageUrls: string[]` (`pokemon`/`superhero`/`wiki_article` : cycle sur ce qui est réellement connu — 1 seule image pour pokemon/superhero, `imagesPerItem` sans effet sur ces deux-là) ; `person:image` a aussi `positionHeld?: string` (rôle Wikidata avec un poste connu, ex. politicien) |
| `director:image`, `actor:image` | `imageUrls: string[]` (affiches des films réalisés/joués — pas une photo du réalisateur/acteur, révélée uniquement à l'écran réponse) ; `imageTitles: (string\|null)[]` (titre du film affiché en incrustation sur chaque image de devinette, même index qu'`imageUrls`) |
| `director:summary`, `actor:summary` | `overviews: string[]` (summary rédigés de plusieurs films réalisés/joués, cyclés comme des frames côté client, un par élément — nom du réalisateur/acteur masqué dans le texte, pas le titre du film) ; `movieTitles: (string\|null)[]` (titre du film source de chaque summary, même index qu'`overviews`) |
| `country:image` | `imageUrls: string[]` (photos du pays — **pas** le drapeau) |
| `country:flag` | pas d'`imageUrls` — `posterUrl` **est** l'image à deviner (le drapeau) ; `capital: string` |
| `music:audio`, `pokemon:audio` | pas d'`imageUrls` — `previewUrl: string` (extrait audio / cri) |

Uniquement via `POST /api/quiz-daily` (jamais en `/api/quiz-batch`) : `reason?: string` (pourquoi cette entité est dans le quiz du jour, ex. `"Tendances du jour (Films)"` ou `"Sorti il y a 7 ans"`) et `isAnniversary?: true` (présent seulement si `reason` reflète un anniversaire de sortie/naissance plutôt qu'une liste "actualité" — le client affiche alors une icône dédiée sur l'écran réponse).

### Ids "à offset"

`id` est toujours un nombre, mais pas nécessairement l'id naturel de l'entité (TMDb/IGDB/ccn3/QID/pageid Wikipédia/national dex PokeAPI/id superhero-api) — certaines formes sont décalées pour rester dans un espace disjoint et permettre au client de dédupliquer/exclure sans ambiguïté entre formes qui partagent la même entité sous-jacente (ex. un film a un id `movie:image` ET un id `movie:summary` différent). **Cette liste est un instantané, pas un contrat figé** — un futur type/questionType peut ajouter un offset ; se fier au code (`toPoolId` dans `server.js`) plutôt qu'à cette doc pour une valeur exacte :
- `country:image` : `+ 1_000_000_000_000`
- `painter:image` : `+ 2_000_000_000_000`
- `country:flag` : `+ 3_000_000_000_000`
- `movie:summary` : `+ 4_000_000_000_000`
- `tv:summary` : `+ 5_000_000_000_000`
- `person:image` pour une entrée source Wikidata (peintre `role:"painter"`, ou tout `personRoles` — politicien, athlète... —, id naturel = QID) : `+ 6_000_000_000_000`
- `director:image` : `+ 7_000_000_000_000`
- `game:summary` : `+ 8_000_000_000_000`
- `director:summary` : `+ 9_000_000_000_000`
- `wiki_article:image` : `+ 10_000_000_000_000` ; `wiki_article:summary` : `+ 11_000_000_000_000`
- `pokemon:image` : `+ 12_000_000_000_000` ; `pokemon:summary` : `+ 13_000_000_000_000` ; `pokemon:audio` : `+ 14_000_000_000_000`
- `superhero:image` : `+ 15_000_000_000_000` ; `superhero:summary` : `+ 16_000_000_000_000`
- `person:summary` : `+ 17_000_000_000_000`, **appliqué en plus** du `+ 6_000_000_000_000` ci-dessus si la personne est elle-même source Wikidata (donc `+ 23_000_000_000_000` au total dans ce cas) — les deux offsets sont indépendants et se cumulent, contrairement à toutes les autres formes de cette liste où un seul offset s'applique.
- `actor:image` : `+ 18_000_000_000_000` ; `actor:summary` : `+ 19_000_000_000_000`
- Toutes les autres formes : id naturel tel quel.

Le client n'a jamais besoin de connaître ce détail au-delà de "les ids sont opaques et stables, à traiter comme des clés".

## `POST /api/quiz-daily`

Génère le "quiz du jour" : contrairement à `/api/quiz-batch`, pas de `selections` — le pool candidat est entièrement construit côté serveur, mélangé avec un seed dérivé de la date (mêmes items pour tout le monde jusqu'à minuit), et sa taille n'est **pas** configurable.

```json
// requête
{ "imagesPerItem": 3, "summaryPerItem": 2 }
```
- `imagesPerItem`/`summaryPerItem` : mêmes bornes et sémantique que `/api/quiz-batch`. Pas de `count` ni de `selections` : ignorés s'ils sont envoyés. En pratique le pool "quiz du jour" ne produit aujourd'hui aucun item `director`/`actor` (les anniversaires n'en construisent pas, voir plus bas), donc `summaryPerItem` n'y a pour l'instant aucun effet observable — accepté quand même pour rester symétrique avec `/api/quiz-batch`.
- 503 si la base n'a encore aucun pool peuplé, ou si aucun contenu n'est disponible pour le jour même (`{"error": "..."}`, message affichable tel quel).

```json
// réponse
{
  "items": [ /* mêmes formes que /api/quiz-batch, plus reason/isAnniversary — voir table ci-dessus */ ],
  "date": "2026-08-02",
  "requested": 8,
  "delivered": 8,
  "excludedCount": 0,
  "imagesPerItem": 3,
  "summaryPerItem": 2,
  "totalGenerated": 1235
}
```
Composition du pool, en deux parts combinées puis mélangées (seed = `date`) :
- **Anniversaires** : pour movie/game (`release_date`), music (`release_date`), `person` — type multi-source, couvre acteurs/réalisateurs/peintres/tout `personRoles` (`birthday`) —, un item par `type:questionType` disponible pour la date du jour (mois/jour, toutes années confondues) — ex. `movie:image` ET `movie:summary` séparément s'ils existent tous les deux. Un peintre ou une personne d'un rôle Wikidata (politicien, athlète...) n'y figure que si Wikidata connaît sa date de naissance à la précision du **jour** (une précision année/mois seule est délibérément ignorée pour ne pas produire de faux anniversaire le 1er janvier). `reason` = `"Sorti il y a N ans"` / `"Né(e) il y a N ans"`, `isAnniversary: true`.
- **Listes du jour** : un item par liste "actualité" à cadence de rafraîchissement courte (`trending_day`/`now_playing` pour movie, `tv_trending_day`/`tv_airing_today` pour tv, `game_recent`, `music_popular_fr`/`music_popular_us`), `questionType` tiré au hasard parmi ceux du type. `reason` = le libellé de la liste (ex. `"Tendances du jour (Films)"`), pas d'`isAnniversary`.

Un jour avec moins de contenu (ex. aucun anniversaire personne) donne simplement un quiz plus court — jamais de repli sur d'autres buckets pour compenser.

## Groupe de filtre `role` sur `person`

Seul groupe qui n'est pas dérivé d'une source externe standard (genre TMDb, décennie, etc.) — inventé pour ce projet. Codes : `actor`, `director`, `painter`, plus un code par entrée de `config.json`'s `personRoles.roles` (aujourd'hui `politician`, `athlete` — la liste s'étend par config, sans code, voir README) : **se fier à la réponse de `GET /api/catalog` pour la liste réellement active**, pas à cette doc. **Multi-valué** : une même personne peut avoir plusieurs codes (ex. un acteur qui est aussi réalisateur) — les filtres suivent la règle OR intra-groupe habituelle (`role: ["actor","director"]` = acteur OU réalisateur, pas les deux à la fois).

Un peintre peut apparaître dans le quiz de deux façons indépendantes : `type:"painter"` (deviner à partir d'un tableau) et `type:"person", filters:{role:["painter"]}` (deviner à partir de son portrait, comme un acteur) — même personne, deux ids différents (voir offsets ci-dessus), pool d'images différent. Un réalisateur/acteur, pareil : `type:"person", filters:{role:["director"]}`/`role:["actor"]` (deviner à partir de sa photo) et `type:"director"`/`type:"actor"` (deviner à partir des affiches/résumés des films qu'il a réalisés/joués, voir table des formes ci-dessus) — même personne, deux ids différents. Un rôle Wikidata (politicien, athlète...) n'a en revanche qu'une seule façon d'apparaître : `type:"person", filters:{role:["politician"]}` (pas de pool "filmographie" équivalent).

## Pas encore fait

- Pas de bornes `count`/`imagesPerItem` exposées via `/api/catalog` — codées en dur des deux côtés (5-50 / 1-20) pour l'instant.

## Choix laissés au client (pas de contrainte serveur)

- Stratégie de suivi des ids "déjà vus" (`exclude`) : implémentée dans `public/js/settings.js` (`getSeenIds`/`addSeenIds`/`clearSeenIds`), clé `localStorage` dérivée de `state.selectedFilters`.
- UI pour construire `selections[]` à partir des chips : implémentée dans `public/js/filters.js` (`buildSelections`/`renderChips`).
