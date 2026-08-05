import {
  RENDER_QUALITIES,
  SUMMARY_SPEEDS,
  AUDIO_SPEEDS,
  CRY_GAP_SEC,
  STORAGE_PREFIX,
  SETTINGS_KEY,
} from "./config.js";
import { state, currentSummarySpeed, currentAudioSpeed } from "./state.js";
import { estimateSummarySec } from "./timeline.js";
import { baseFilterKey } from "./filters.js";
import {
  countRange,
  countNumber,
  imagesPerItemRange,
  imagesPerItemNumber,
  imageSecRange,
  imageSecNumber,
  revealSecRange,
  revealSecNumber,
  flagSecRange,
  flagSecNumber,
  mapSecRange,
  mapSecNumber,
  leaderSecRange,
  leaderSecNumber,
  showLeaderNameCheckbox,
  statesmanSecRange,
  statesmanSecNumber,
  showCountryNameCheckbox,
  summaryPerItemRange,
  summaryPerItemNumber,
  maxSummaryLenRange,
  maxSummaryLenNumber,
  durationHint,
} from "./dom.js";

export function currentCount() {
  // `|| 5` traiterait un pool à 0 dispo (valeur "0" légitime) comme
  // absent et le remonterait à tort à 5
  const v = parseInt(countNumber.value, 10);
  return Number.isNaN(v) ? 5 : v;
}
export function currentImagesPerItem() {
  return parseInt(imagesPerItemNumber.value, 10) || 1;
}
export function currentImageSec() {
  return parseInt(imageSecNumber.value, 10) || 5;
}
export function currentRevealSec() {
  return parseInt(revealSecNumber.value, 10) || 5;
}
export function currentFlagSec() {
  return parseInt(flagSecNumber.value, 10) || 5;
}
export function currentMapSec() {
  return parseInt(mapSecNumber.value, 10) || 8;
}
export function currentLeaderSec() {
  return parseInt(leaderSecNumber.value, 10) || 5;
}
export function currentStatesmanSec() {
  return parseInt(statesmanSecNumber.value, 10) || 5;
}
export function currentSummaryPerItem() {
  return parseInt(summaryPerItemNumber.value, 10) || 1;
}
export function currentMaxSummaryLen() {
  return parseInt(maxSummaryLenNumber.value, 10) || 1000;
}

export function formatDuration(totalSec) {
  const m = Math.floor(totalSec / 60),
    s = Math.round(totalSec % 60);
  return `${m} min ${s.toString().padStart(2, "0")}`;
}
export function totalDurationSec() {
  // musique et drapeaux ont chacun leur propre durée dédiée (pas
  // images/titre ni temps/image) : leur durée par item diffère de
  // celle des autres médias. server.js (/api/catalog) n'expose pas de
  // compteur par filtre : impossible de pondérer par la composition
  // réelle du pool, on moyenne donc simplement les buckets des combos
  // "type:questionType" actuellement actifs (approximation suffisante
  // pour un simple indicateur de durée)
  // "director:summary" cycle plusieurs summary (voir timeline.js), les
  // autres *:summary un seul bloc statique — même logique que "standard"
  // ci-dessous qui multiplie déjà par imagesPerItem.
  const hasDirectorSummary = state.activeQuestionTypes.has("director:summary");
  // durée réelle inconnue avant d'avoir le texte (voir timeline.js) : on
  // estime avec une longueur de summary "typique" (estimateSummarySec),
  // juste pour cet indicateur — le rendu réel s'ajuste au texte effectif.
  // musique et cri partagent le même préréglage (voir AUDIO_SPEEDS) mais
  // pas la même durée réelle : un extrait musical dure exactement
  // musicSec, un cri est rejoué cryCount fois (durée réelle dépendante du
  // cri, inconnue avant chargement, voir timeline.js) — CRY_AVG_SEC est une
  // approximation pour ce seul indicateur, le rendu réel s'ajuste au cri
  // effectif.
  const CRY_AVG_SEC = 1;
  const audioSpeed = currentAudioSpeed();
  const itemSecByBucket = {
    music: audioSpeed.musicSec + currentRevealSec(),
    cry: audioSpeed.cryCount * (CRY_AVG_SEC + CRY_GAP_SEC) + currentRevealSec(),
    flag: currentFlagSec() + currentRevealSec(),
    map: currentMapSec() + currentRevealSec(),
    leader: currentLeaderSec() + currentRevealSec(),
    statesman: currentStatesmanSec() + currentRevealSec(),
    summary:
      (hasDirectorSummary ? currentSummaryPerItem() : 1) *
        estimateSummarySec(currentSummarySpeed().secPerWord) +
      currentRevealSec(),
    standard:
      currentImagesPerItem() * currentImageSec() + currentRevealSec(),
  };
  const bucketOf = (comboKey) =>
    comboKey === "music:audio"
      ? "music"
      : comboKey.endsWith(":audio")
        ? "cry"
        : comboKey === "country:flag"
          ? "flag"
          : comboKey === "country:map"
            ? "map"
            : comboKey === "country:leader"
              ? "leader"
              : comboKey === "statesman:statesman"
                ? "statesman"
                : comboKey.endsWith(":summary")
                  ? "summary"
                  : "standard";
  const activeBuckets = [
    ...new Set([...state.activeQuestionTypes].map(bucketOf)),
  ];
  // aucun mode coché est un état valide (voir renderContentTypeChips) :
  // sans ce garde-fou la moyenne ci-dessous divise par 0 et l'indicateur
  // affiche "NaN min NaN"
  if (activeBuckets.length === 0) return 0;
  const avgItemSec =
    activeBuckets.reduce((sum, b) => sum + itemSecByBucket[b], 0) /
    activeBuckets.length;
  return currentCount() * avgItemSec;
}
export function updateDurationHint() {
  // le "max disponible" a sa propre place dans la barre d'action
  // (#poolCount, voir updatePoolSize) — pas de doublon ici
  durationHint.textContent = state.activeQuestionTypes.size
    ? `Durée estimée : ${formatDuration(totalDurationSec())}`
    : "Aucun type sélectionné";
}

export function storageKey() {
  const cats = [...state.selectedFilters].sort().join("+") || "none";
  return STORAGE_PREFIX + cats;
}
export function getSeenIds() {
  try {
    return JSON.parse(localStorage.getItem(storageKey()) || "[]");
  } catch {
    return [];
  }
}
export function addSeenIds(ids) {
  const current = new Set(getSeenIds());
  ids.forEach((id) => current.add(id));
  localStorage.setItem(storageKey(), JSON.stringify([...current]));
}
export function clearSeenIds() {
  localStorage.removeItem(storageKey());
}

export function saveSettings() {
  const s = {
    count: currentCount(),
    imagesPerItem: currentImagesPerItem(),
    imageSec: currentImageSec(),
    revealSec: currentRevealSec(),
    flagSec: currentFlagSec(),
    mapSec: currentMapSec(),
    leaderSec: currentLeaderSec(),
    showLeaderName: state.showLeaderName,
    statesmanSec: currentStatesmanSec(),
    showCountryName: state.showCountryName,
    summarySpeed: state.summarySpeed,
    audioSpeed: state.audioSpeed,
    summaryPerItem: currentSummaryPerItem(),
    maxSummaryLen: currentMaxSummaryLen(),
    renderFps: state.renderFps,
    questionTypes: [...state.activeQuestionTypes],
    filters: [...state.selectedFilters],
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}
export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
  } catch {
    return null;
  }
}
export function applySavedSettings() {
  const s = loadSettings();
  if (!s) return;
  if (s.count) {
    countNumber.value = s.count;
    countRange.value = s.count;
  }
  if (s.imagesPerItem) {
    imagesPerItemNumber.value = s.imagesPerItem;
    imagesPerItemRange.value = s.imagesPerItem;
  }
  if (s.imageSec) {
    imageSecNumber.value = s.imageSec;
    imageSecRange.value = s.imageSec;
  }
  if (s.revealSec) {
    revealSecNumber.value = s.revealSec;
    revealSecRange.value = s.revealSec;
  }
  if (AUDIO_SPEEDS.some((a) => a.key === s.audioSpeed)) {
    state.audioSpeed = s.audioSpeed;
  }
  if (s.flagSec) {
    flagSecNumber.value = s.flagSec;
    flagSecRange.value = s.flagSec;
  }
  if (s.mapSec) {
    mapSecNumber.value = s.mapSec;
    mapSecRange.value = s.mapSec;
  }
  if (s.leaderSec) {
    leaderSecNumber.value = s.leaderSec;
    leaderSecRange.value = s.leaderSec;
  }
  if (typeof s.showLeaderName === "boolean") {
    state.showLeaderName = s.showLeaderName;
    showLeaderNameCheckbox.checked = s.showLeaderName;
  }
  if (s.statesmanSec) {
    statesmanSecNumber.value = s.statesmanSec;
    statesmanSecRange.value = s.statesmanSec;
  }
  if (typeof s.showCountryName === "boolean") {
    state.showCountryName = s.showCountryName;
    showCountryNameCheckbox.checked = s.showCountryName;
  }
  if (SUMMARY_SPEEDS.some((sp) => sp.key === s.summarySpeed)) {
    state.summarySpeed = s.summarySpeed;
  }
  if (s.summaryPerItem) {
    summaryPerItemNumber.value = s.summaryPerItem;
    summaryPerItemRange.value = s.summaryPerItem;
  }
  if (s.maxSummaryLen) {
    maxSummaryLenNumber.value = s.maxSummaryLen;
    maxSummaryLenRange.value = s.maxSummaryLen;
  }
  if (RENDER_QUALITIES.some((q) => q.fps === s.renderFps)) {
    state.renderFps = s.renderFps;
  }
  // migration : plusieurs générations de format de sauvegarde se sont
  // succédé le temps de généraliser ce système à tous les types —
  // on les couvre pour ne pas faire disparaître silencieusement les
  // réglages des utilisateurs existants.
  let restoredQuestionTypes = false;
  if (Array.isArray(s.questionTypes)) {
    // format actuel : clés "type:questionType" ; format intermédiaire
    // (avant généralisation à tous les types) : clés nues
    // ("image"/"flag"), toujours pour "country" à l'époque
    const valid = s.questionTypes
      .map((t) =>
        typeof t === "string" && !t.includes(":") ? `country:${t}` : t,
      )
      .filter((t) => {
        const [mt, qt] = t.split(":");
        return (state.questionTypesByType[mt] || []).includes(qt);
      });
    if (valid.length) {
      state.activeQuestionTypes = new Set(valid);
      restoredQuestionTypes = true;
    }
  }
  // format historique (avant l'introduction de questionTypes) :
  // simples types dans contentTypes, plus "country"/"flag" à part
  if (!restoredQuestionTypes && Array.isArray(s.contentTypes)) {
    const legacy = new Set();
    for (const t of s.contentTypes) {
      if (t === "country") legacy.add("country:image");
      else if (t === "flag") legacy.add("country:flag");
      else if (state.questionTypesByType[t]) {
        for (const qt of state.questionTypesByType[t])
          legacy.add(`${t}:${qt}`);
      }
    }
    if (legacy.size) state.activeQuestionTypes = legacy;
  }
  if (Array.isArray(s.filters) && s.filters.length) {
    const valid = s.filters.filter((c) =>
      state.availableFilters.some((af) => af.key === baseFilterKey(c)),
    );
    if (valid.length) state.selectedFilters = new Set(valid);
  }
}
