// questionType "map" (country) : zoom continu du monde vers le pays cible,
// rendu 100% vectoriel (aucune image externe hotlinkée, aucun texte) — voir
// render/scenes.js pour l'animation/projection ; ce module ne fait que
// charger + décoder le fond de carte une fois et exposer les polygones par
// pays.
//
// Fond de carte vendored (public/data/world-110m.json) : countries-110m.json
// du paquet world-atlas@2 (résolution 110m, ~108 Ko), données Natural Earth
// (domaine public), empaquetage MIT. objects.countries.geometries[].id =
// code numérique ISO 3166-1 = country.ccn3 (server.js) : lookup direct, pas
// de table de correspondance à maintenir. Choisi après une 1ère version à
// tuiles OpenStreetMap hotlinkées, écartée : centroïde mledoze parfois en
// pleine mer (pas de notion de "forme du pays") et labels de lieux visibles
// sur la tuile (spoile la réponse, aucun contrôle possible sur du raster
// déjà composé) — un rendu vectoriel élimine les deux à la fois.

const WORLD_DATA_URL = "/data/world-110m.json";

// bornes fixes du fond de carte entier (lon/lat) : sert de point de départ
// au zoom (voir drawMapGuess) — pas besoin de les recalculer depuis les 177
// pays, le fichier vendored ne change pas au runtime.
export const WORLD_BBOX = [-180, -85.6, 180, 83.6];

let topologyPromise = null;
let countriesById = null; // Map<ccn3 string, { polygons, bbox }>

// décodage delta -> coordonnées absolues (spec TopoJSON "transform") :
// chaque point d'un arc est stocké comme un delta ENTIER par rapport au
// précédent (quantification), la somme cumulée est ensuite mise à l'échelle
// (scale/translate) pour retrouver lon/lat réels. Fait une seule fois pour
// tous les arcs, réutilisé par tous les pays (un arc peut être partagé par
// deux pays voisins).
function decodeArcs(topology) {
  const { scale, translate } = topology.transform;
  return topology.arcs.map((arc) => {
    let x = 0,
      y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
}

// un index d'arc négatif (~i, complément à un) signifie "arc i inversé" —
// convention TopoJSON pour partager un même arc entre deux anneaux
// adjacents sans le dupliquer. Le 1er point de chaque arc suivant est omis
// à l'assemblage (déjà le dernier point de l'arc précédent).
function ringFromArcs(arcIndices, decodedArcs) {
  const ring = [];
  for (const idx of arcIndices) {
    const i = idx < 0 ? ~idx : idx;
    const pts = idx < 0 ? decodedArcs[i].slice().reverse() : decodedArcs[i];
    if (ring.length > 0) ring.push(...pts.slice(1));
    else ring.push(...pts);
  }
  return ring;
}

// Natural Earth laisse certains contours filer sans coupure de +179° à
// -179° dans le MÊME anneau (Russie, Fidji à cette résolution) plutôt que
// de les découper de part et d'autre de l'antiméridien — dessiné tel quel,
// le segment qui relie ces deux points traverse toute la carte en une
// ligne horizontale parasite. Un saut de longitude > 180° entre deux points
// consécutifs devient donc une coupure (nouvel anneau) — approximation
// standard (pas de vrai point d'intersection à 180° calculé), acceptable
// ici : le bord ainsi créé tombe en pleine mer, jamais dans une zone
// regardée.
function splitRingAtAntimeridian(ring) {
  const parts = [[ring[0]]];
  for (let i = 1; i < ring.length; i++) {
    if (Math.abs(ring[i][0] - ring[i - 1][0]) > 180) parts.push([]);
    parts[parts.length - 1].push(ring[i]);
  }
  return parts.filter((p) => p.length > 1);
}

// anneau extérieur (+ ses trous, jamais coupés dans ce jeu de données à
// cette résolution) -> un ou plusieurs POLYGONES distincts, un par morceau
// de contour extérieur coupé par splitRingAtAntimeridian ci-dessus — pas de
// simples anneaux d'un même polygone : mainPolygonBBox choisit "le plus
// grand morceau" en comparant l'aire du 1er anneau DE CHAQUE polygone, puis
// prend la bbox de TOUS les anneaux du polygone gagnant. Garder les deux
// côtés de la coupure comme anneaux d'un seul polygone aurait laissé cette
// bbox ré-agréger les deux côtés dans une largeur de tout le globe —
// exactement le bug d'origine (zoom cassé sur Russie/Fidji). Les trous
// restent rattachés au premier morceau, imprécision sans conséquence
// visuelle ici.
function ringsToPolygons(arcsRings, decodedArcs) {
  const [outerArcs, ...holeArcs] = arcsRings;
  const outerParts = splitRingAtAntimeridian(ringFromArcs(outerArcs, decodedArcs));
  const holes = holeArcs.map((r) => ringFromArcs(r, decodedArcs));
  return outerParts.map((ring, i) => (i === 0 ? [ring, ...holes] : [ring]));
}

// normalise Polygon/MultiPolygon vers la même forme : tableau de polygones,
// chacun un tableau d'anneaux (1er = contour extérieur, suivants = trous),
// chacun un tableau de points [lon, lat].
function geometryToPolygons(geometry, decodedArcs) {
  if (geometry.type === "Polygon") return ringsToPolygons(geometry.arcs, decodedArcs);
  if (geometry.type === "MultiPolygon")
    return geometry.arcs.flatMap((poly) => ringsToPolygons(poly, decodedArcs));
  return [];
}

function bboxOfPolygons(polygons) {
  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}

// aire approximative (formule du lacet, en degrés² — pas une vraie aire
// géodésique, mais suffisant pour COMPARER deux morceaux d'un même pays)
// de l'anneau extérieur d'un polygone (1er anneau = contour, les trous
// suivants n'y changent rien d'utile pour ce classement).
function ringArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

// bbox du plus GRAND morceau seulement (pas de tous les polygones) — un
// pays "MultiPolygon" mélange souvent le territoire principal et des
// exclaves lointaines (Guyane pour la France, Alaska+Hawaï pour les
// USA...) : sans ce filtre, la bbox englobe tout et le zoom s'arrête bien
// trop loin pour être satisfaisant. Les autres morceaux restent quand même
// DESSINÉS (voir entry.polygons, non filtré) — seul le cadrage du zoom
// ignore les exclaves.
function mainPolygonBBox(polygons) {
  let best = null,
    bestArea = -1;
  for (const polygon of polygons) {
    const a = ringArea(polygon[0]);
    if (a > bestArea) {
      bestArea = a;
      best = polygon;
    }
  }
  return bboxOfPolygons(best ? [best] : []);
}

// charge + décode UNE SEULE FOIS (promise mise en cache, réutilisée par les
// appels concurrents) : le fond de carte est partagé par tous les items
// "map" d'un même quiz — un seul fetch/décodage, pas un par item ni par
// frame (voir preload.js).
export function ensureWorldTopology() {
  if (!topologyPromise) {
    topologyPromise = fetch(WORLD_DATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`world-110m.json ${res.status}`);
        return res.json();
      })
      .then((topology) => {
        const decodedArcs = decodeArcs(topology);
        countriesById = new Map();
        for (const g of topology.objects.countries.geometries) {
          const polygons = geometryToPolygons(g, decodedArcs);
          countriesById.set(String(g.id), {
            polygons,
            // bbox du plus grand morceau (cadrage du zoom, voir
            // mainPolygonBBox) — pas bboxOfPolygons(polygons), qui inclut à
            // tort les exclaves lointaines.
            bbox: mainPolygonBBox(polygons),
          });
        }
      });
  }
  return topologyPromise;
}

// `null` si absent du jeu 110m (petits territoires non couverts à cette
// résolution) — l'appelant (preload.js) traite ça comme une image
// illisible : item exclu du quiz, pas d'erreur bloquante.
export function getCountryEntry(ccn3) {
  return countriesById?.get(String(ccn3)) ?? null;
}

// contexte "autres terres" affiché en arrière-plan pendant le zoom — le
// pays cible est exclu d'ici, dessiné à part et surligné (voir
// drawMapGuess).
export function getAllCountryPolygons(excludeCcn3) {
  const exclude = String(excludeCcn3);
  const all = [];
  for (const [id, entry] of countriesById) {
    if (id !== exclude) all.push(entry.polygons);
  }
  return all;
}
