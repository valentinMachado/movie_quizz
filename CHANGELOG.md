# Changelog

## 1.3.0 — 2026-08-04

- Les données Wikipédia viennent maintenant de dumps Wikimedia ingérés en local (`cache/frwiki-index.sqlite`) plutôt que de l'API MediaWiki : découverte des articles par catégorie, résumés, alias de redirection, vignettes et identifiants Wikidata. Wikipédia répondait en 0,33 s mais imposait `429 Too Many Requests` avec `Retry-After: 51 s` — le pool d'articles se construit désormais en **426 s au lieu de 4 091 s**, et les seuls appels réseau qui subsistent pour ce type vont à Wikidata (dates d'événement), introuvables dans les dumps. **Nouvelle dépendance : le binaire `bzip2` doit être installé sur la machine qui fait tourner `refresh.js`** (voir la section Deployment du README) ; sans lui tout continue de fonctionner via l'API, simplement beaucoup plus lentement.
- La notoriété des personnes et des articles se mesure désormais en **consultations réelles de Wikipédia en français** (dumps `pageview_complete`, 3 mois glissants) plutôt qu'en nombre de langues ayant un article. Le classement précédent enterrait des peintres connus en France mais peu traduits (Yan Pei-Ming, Raymond-Émile Waydelich) et remontait des inconnus ici à forte couverture internationale. Une personne sans article en français vaut 0 : pour un quiz francophone, personne ne la devinera.
- Le pool des articles Wikipédia passe de 112 à ~3 500 entrées réellement jouables. Il annonçait auparavant 5 006 articles dont un quart était écarté silencieusement au moment de générer la question, faute de vignette — `pool-size` reflète maintenant ce qui est réellement disponible.
- Le type "peintre" exige au moins 3 œuvres connues. La requête Wikidata retenait toute personne listant "peintre" parmi ses occupations, ce qui faisait entrer Freddie Mercury, Serge Gainsbourg ou George W. Bush — 820 des 1 154 entrées n'avaient aucun tableau, et depuis le passage aux consultations réelles ils occupaient le haut du classement.
- Le filtre "Acteurs populaires" du type "personne" disparaît au profit de "Populaire" : ses membres avaient tous le rôle acteur, il disait donc exactement "populaire ET acteur", et aucun acteur ne pouvait porter "Populaire" par ailleurs. Les paliers Obscur/Niche/Populaire forment maintenant un vocabulaire unique pour tout le type.
- Fix : les genres musicaux apparaissaient en double au catalogue (l'ancien identifiant iTunes et le nom du genre), et des genres que plus aucun morceau ne portait y restaient proposés.
- Fix : la profondeur d'exploration des catégories d'animaux (reptiles, poissons, insectes, amphibiens) était trop faible pour en sortir des articles.
- `refresh.js` affiche une bannière verte quand tous les pools sont complets — le moment où le serveur peut être lancé, jusqu'ici noyé dans les logs des warmLoops.

## 1.2.3 — 2026-08-03

- 4 nouveaux types de quiz : "acteur" (deviner à partir des affiches/résumés des films où il a joué, comme "réalisateur"), articles Wikipédia (`type: "wiki_article"`, catégories configurables — histoire, sciences, géographie, monuments, mythologie, animaux), Pokémon (image/résumé/cri, PokeAPI) et super-héros (image/résumé, superhero-api).
- Le type "personne" gagne un mode résumé (`questionType: "summary"`) et un champ "poste occupé" affiché au reveal quand connu (ex. pour un politicien) ; les rôles au-delà d'acteur/réalisateur/peintre sont maintenant pilotés par config (`config.json`'s `personRoles.roles`, sans code) — un rôle "sportif" rejoint "politicien".
- Renommage de `questionType: "synopsis"` en `"summary"` (mêmes types : film/série/jeu/réalisateur, plus acteur/personne/article/Pokémon/super-héros ci-dessus) ; les résumés sont maintenant tronqués à une longueur lisible et masquent aussi les alias connus du sujet (articles Wikipédia, super-héros), pas seulement son titre/nom.
- `imagesPerItem` passe de 5 à 20 maximum.
- Un peintre ou une personne d'un rôle Wikidata (politicien, sportif...) peut maintenant apparaître dans le "quiz du jour" comme anniversaire de naissance, au même titre qu'un acteur/réalisateur — condition sur une date de naissance connue de Wikidata à la précision du jour, pour ne jamais générer de faux anniversaire.
- Le type "acteur" gagne un filtre "tête d'affiche"/"second couteau" basé sur sa place moyenne au casting ; ses filtres décennie/géographie (comme ceux de "réalisateur") viennent maintenant de sa date/lieu de naissance plutôt que d'un mécanisme dérivé des films.

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
