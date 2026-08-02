# API serveur — contrat client

Documente le contrat HTTP exposé par `server.js` tel qu'il existe aujourd'hui. Le client (`public/js/filters.js`, `public/js/main.js`) est branché dessus.

`server.js` ne fait plus aucun appel réseau : il lit uniquement `cache/data.sqlite`, peuplée en tâche de fond par `refresh.js` (process séparé). Toute la logique de filtrage/génération décrite ici lit cette base ; rien n'est jamais fetché à la demande.

## `GET /api/catalog`

Tout ce dont le client a besoin pour construire son UI de sélection : par type, les `questionType` possibles (fixe, structurel) et les filtres disponibles (data-driven, reflète ce que `refresh.js` a réellement écrit en base — vide tant qu'un type n'a pas été peuplé, pas d'erreur).

```json
{
  "movie": {
    "questionTypes": ["image", "synopsis"],
    "filters": {
      "genre": [{ "code": "28", "name": "Action" }],
      "liste": [{ "code": "popular", "name": "Populaire" }],
      "decennie": [{ "code": "decade_1990", "name": "Années 1990" }],
      "geographie": [{ "code": "fr", "name": "France" }]
    }
  },
  "tv": { "questionTypes": ["image", "synopsis"], "filters": { "genre": [...], "liste": [...], "decennie": [...] } },
  "person": { "questionTypes": ["image"], "filters": { "role": [{ "code": "actor", "name": "Acteur" }, { "code": "director", "name": "Réalisateur" }, { "code": "painter", "name": "Peintre" }] } },
  "game": { "questionTypes": ["image", "synopsis"], "filters": { "genre": [...], "liste": [...], "decennie": [...] } },
  "music": { "questionTypes": ["audio"], "filters": { "genre": [...], "liste": [...], "decennie": [...] } },
  "country": { "questionTypes": ["image", "flag"], "filters": {} },
  "painter": { "questionTypes": ["image"], "filters": { "genre": [...], "decennie": [...], "geographie": [...] } },
  "director": { "questionTypes": ["image"], "filters": { "genre": [...], "decennie": [...], "geographie": [...] } }
}
```

Les groupes de filtre présents varient par type (pas de liste codée en dur côté client à maintenir) : `country` n'en a aucun aujourd'hui, `person` n'a que `role`, etc. Un groupe absent = pas de filtre possible sur cet axe pour ce type.

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
{ "totalGenerated": 1234, "version": "1.2.1", "ready": true }
```
`ready` = la base a au moins un pool non vide ET les warmLoops "bloquants" (tableaux de peintre, photos pays si Pexels configuré) sont à jour pour tout ce qui est actuellement dans le pool. `false` typiquement juste après une repopulation, tant que le chauffage progressif tourne encore.

## `POST /api/quiz-batch`

Génère un batch de questions.

```json
// requête
{
  "count": 20,
  "imagesPerItem": 3,
  "exclude": [123, 456],
  "selections": [
    { "type": "movie", "questionType": "image", "filters": { "liste": ["popular"] } },
    { "type": "movie", "questionType": "synopsis", "filters": { "decennie": ["decade_1990"] } },
    { "type": "country", "questionType": "flag" }
  ]
}
```
- `count` : clampé serveur entre 5 et 50.
- `imagesPerItem` : clampé serveur entre 1 et 5.
- `exclude` : ids à éviter (voir "ids à offset" plus bas) — si pas assez d'items restent disponibles, le serveur ignore `exclude` entièrement pour ce batch et le signale via `recycled: true` plutôt que de renvoyer moins que `count`.
- `selections` : **requis, au moins une entrée**. Chaque entrée est un bucket indépendant `{type, questionType, filters?}` — c'est ce qui permet des filtres différents pour `movie:image` et `movie:synopsis` dans la même requête. Deux entrées avec la même paire `type:questionType` (filtres différents) sont fusionnées dans un seul bucket de stratification (leurs pools s'additionnent).
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
| `movie:synopsis`, `tv:synopsis`, `game:synopsis` | `overview: string` |
| `person:image`, `game:image`, `painter:image` | `imageUrls: string[]` |
| `director:image` | `imageUrls: string[]` (affiches des films réalisés — pas une photo du réalisateur, révélée uniquement à l'écran réponse) ; `imageTitles: (string\|null)[]` (titre du film affiché en incrustation sur chaque image de devinette, même index qu'`imageUrls`) |
| `country:image` | `imageUrls: string[]` (photos du pays — **pas** le drapeau) |
| `country:flag` | pas d'`imageUrls` — `posterUrl` **est** l'image à deviner (le drapeau) ; `capital: string` |
| `music:audio` | pas d'`imageUrls` — `previewUrl: string` (extrait audio) |

Uniquement via `POST /api/quiz-daily` (jamais en `/api/quiz-batch`) : `reason?: string` (pourquoi cette entité est dans le quiz du jour, ex. `"Tendances du jour (Films)"` ou `"Sorti il y a 7 ans"`) et `isAnniversary?: true` (présent seulement si `reason` reflète un anniversaire de sortie/naissance plutôt qu'une liste "actualité" — le client affiche alors une icône dédiée sur l'écran réponse).

### Ids "à offset"

`id` est toujours un nombre, mais pas nécessairement l'id naturel de l'entité (TMDb/IGDB/ccn3/QID) — certaines formes sont décalées pour rester dans un espace disjoint et permettre au client de dédupliquer/exclure sans ambiguïté entre formes qui partagent la même entité sous-jacente (ex. un film a un id `movie:image` ET un id `movie:synopsis` différent) :
- `country:image` : `+ 1_000_000_000_000`
- `painter:image` : `+ 2_000_000_000_000`
- `country:flag` : `+ 3_000_000_000_000`
- `movie:synopsis` : `+ 4_000_000_000_000`
- `tv:synopsis` : `+ 5_000_000_000_000`
- `person:image` pour une entrée source Wikidata (peintre avec `role:"painter"`, id naturel = QID) : `+ 6_000_000_000_000`
- `director:image` : `+ 7_000_000_000_000`
- `game:synopsis` : `+ 8_000_000_000_000`
- Toutes les autres formes : id naturel tel quel.

Le client n'a jamais besoin de connaître ce détail au-delà de "les ids sont opaques et stables, à traiter comme des clés".

## `POST /api/quiz-daily`

Génère le "quiz du jour" : contrairement à `/api/quiz-batch`, pas de `selections` — le pool candidat est entièrement construit côté serveur, mélangé avec un seed dérivé de la date (mêmes items pour tout le monde jusqu'à minuit), et sa taille n'est **pas** configurable.

```json
// requête
{ "imagesPerItem": 3 }
```
- `imagesPerItem` : clampé serveur entre 1 et 5 (même borne que `/api/quiz-batch`). Pas de `count` ni de `selections` : ignorés s'ils sont envoyés.
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
  "totalGenerated": 1235
}
```
Composition du pool, en deux parts combinées puis mélangées (seed = `date`) :
- **Anniversaires** : pour movie/game (`release_date`), music (`release_date`), person (`birthday`), un item par `type:questionType` disponible pour la date du jour (mois/jour, toutes années confondues) — ex. `movie:image` ET `movie:synopsis` séparément s'ils existent tous les deux. `reason` = `"Sorti il y a N ans"` / `"Né(e) il y a N ans"`, `isAnniversary: true`.
- **Listes du jour** : un item par liste "actualité" à cadence de rafraîchissement courte (`trending_day`/`now_playing` pour movie, `tv_trending_day`/`tv_airing_today` pour tv, `game_recent`, `music_popular_fr`/`music_popular_us`), `questionType` tiré au hasard parmi ceux du type. `reason` = le libellé de la liste (ex. `"Tendances du jour (Films)"`), pas d'`isAnniversary`.

Un jour avec moins de contenu (ex. aucun anniversaire personne) donne simplement un quiz plus court — jamais de repli sur d'autres buckets pour compenser.

## Groupe de filtre `role` sur `person`

Seul groupe qui n'est pas dérivé d'une source externe (genre TMDb, décennie, etc.) — inventé pour ce projet. Codes actuels : `actor`, `director`, `painter`. **Multi-valué** : une même personne peut avoir plusieurs codes (ex. un acteur qui est aussi réalisateur) — les filtres suivent la règle OR intra-groupe habituelle (`role: ["actor","director"]` = acteur OU réalisateur, pas les deux à la fois).

Un peintre peut apparaître dans le quiz de deux façons indépendantes : `type:"painter"` (deviner à partir d'un tableau) et `type:"person", filters:{role:["painter"]}` (deviner à partir de son portrait, comme un acteur) — même personne, deux ids différents (voir offsets ci-dessus), pool d'images différent. Un réalisateur, pareil : `type:"person", filters:{role:["director"]}` (deviner à partir de sa photo) et `type:"director"` (deviner à partir des affiches des films qu'il a réalisés, voir table des formes ci-dessus) — même personne, deux ids différents.

## Pas encore fait

- Pas de bornes `count`/`imagesPerItem` exposées via `/api/catalog` — codées en dur des deux côtés (5-50 / 1-5) pour l'instant.

## Choix laissés au client (pas de contrainte serveur)

- Stratégie de suivi des ids "déjà vus" (`exclude`) : implémentée dans `public/js/settings.js` (`getSeenIds`/`addSeenIds`/`clearSeenIds`), clé `localStorage` dérivée de `state.selectedFilters`.
- UI pour construire `selections[]` à partir des chips : implémentée dans `public/js/filters.js` (`buildSelections`/`renderChips`).
