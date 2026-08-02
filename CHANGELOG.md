# Changelog

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
