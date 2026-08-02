# Changelog

## 1.2.2 — 2026-08-03

- Le type "réalisateur" gagne un mode synopsis (`type: "director"`, `questionType: "synopsis"`) : deviner le réalisateur à partir des résumés (rédigés) de plusieurs de ses films, cyclés comme des frames (nouveau réglage `synopsisPerItem`), avec le titre du film source affiché en légende.
- Fix : un item avec moins d'images/synopsis disponibles que demandé (`imagesPerItem`/`synopsisPerItem`) affichait la même image/le même synopsis en double pour compléter ; il obtient maintenant simplement moins de frames plutôt qu'une répétition — pour tous les types.
- Fix : le son de fond de la phase de devinette d'un item à synopsis multiples (réalisateur) se coupait et refondait à chaque changement de synopsis au lieu de courir sur toute la devinette.
- Les séries gagnent un filtre géographique par pays (`geographie`), comme les films/acteurs/musique/peintres.
- Nouveaux paliers de popularité ("Obscur"/"Niche", en plus de "Populaire" existant) pour films/séries/jeux/acteurs-réalisateurs-peintres, recalculés à chaque refresh complet à partir de la popularité/nombre d'avis propre à chaque source (peintres : palier "Populaire" inclus aussi, faute de liste "Populaire" séparée à exclure).
- La musique gagne une liste "Classiques" (blind-test) de morceaux connus recherchés par titre exact à chaque refresh, ainsi qu'un filtre géographique par pays de chart.

## 1.2.1 — 2026-08-02

- Nouveau "quiz du jour" (`POST /api/quiz-daily`) : sélection automatique sans filtre côté client, mélangeant anniversaires de sortie/naissance du jour (films, jeux vidéo, musique, acteurs/réalisateurs/peintres) et listes tendance/charts du jour (movie/tv/game/music), le tout mélangé une seule fois par un seed dérivé de la date pour que le quiz reste identique toute la journée. Chaque item porte une `reason` affichée à l'écran réponse (ex. "Tendances du jour (Films)", "Sorti il y a 7 ans"), avec une icône dédiée pour les anniversaires.
- Nouveau type de quiz "réalisateur" (`type: "director"`) : deviner le réalisateur à partir des affiches des films qu'il a réalisés (filmographie complétée en tâche de fond au-delà du pool `movie` curated).
- Les jeux vidéo peuvent aussi être devinés par synopsis (`questionType: "synopsis"`), comme les films/séries.
- `movie`/`game` gagnent une date de sortie persistée (`release_date`), et un nouveau warmLoop récupère les dates de naissance des acteurs/réalisateurs/peintres (`person.birthday`) — toutes deux utilisées par les anniversaires du quiz du jour.
- Fix : le fondu audio de fin de piste musicale (écran réponse) pouvait désynchroniser le son du reste de la vidéo sur les reveals longs ; il respecte maintenant la durée exacte du segment tout en finissant le fondu ~2s avant la fin quand la durée le permet.

## 1.2.0 — 2026-08-02

- Migration du cache disque (`cache/reservoir.json` + `cache/warm-*.json`) vers une base SQLite unique (`cache/data.sqlite`), partagée entre `refresh.js` (écriture, tâche de fond) et `server.js` (lecture seule, ne fait plus aucun appel réseau).
- Nouveau système de filtres unifié (tables `filter`/`entity_filter` : genre, liste, decennie, geographie), combiné OR au sein d'un groupe et AND entre groupes, exposé via `GET /api/catalog`.
- Nouveau contrat HTTP : `GET /api/catalog` remplace `GET /api/categories` ; `POST /api/quiz-batch` (avec `selections[]`, un jeu de filtres par `type:questionType`) remplace l'ancien `GET /api/quiz-batch?questionTypes=&categories=` à filtres globaux ; `/api/pool-size` passe de `GET` à `POST`.
- Le pool `person` devient multi-source : une même personne peut porter plusieurs rôles (`role`: acteur/réalisateur/peintre), un peintre pouvant apparaître à la fois comme portrait (`person`) et comme tableau (`painter`).
- Fraîcheur des données gérée ligne par ligne (colonnes `*_checked_at`, TTL ~30j pour les données construites, ~24h pour l'appartenance aux listes Populaire/Tendances) via la table `checkpoint`, au lieu d'un fingerprint global sur tout le fichier de cache.
- `refresh.js` et `server.js` séparés en deux process indépendants (voir `npm run refresh` / `npm start`), avec `--only=`, `--db=` et `--ephemeral-db` pour isoler les tests.
- Frontend éclaté de `public/index.html` en modules (`public/js/*.js`), rebranché sur le nouveau contrat HTTP.

Une entrée par version, ajoutée uniquement au moment de sa création (voir le
skill `release-version`) — pas de suivi commit par commit, les commits
intermédiaires entre deux versions sont informels et non individuellement
significatifs (voir `git log`).

Les versions antérieures à ce fichier (1.0.2 à 1.1.3) n'ont pas d'entrée
détaillée ici — introduit après coup, voir `git log` pour l'historique brut
si besoin.
