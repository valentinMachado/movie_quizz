import { RENDER_QUALITIES, STORAGE_PREFIX, SETTINGS_KEY } from "./config.js";
import { state } from "./state.js";
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
  musicClipSecRange,
  musicClipSecNumber,
  flagSecRange,
  flagSecNumber,
  synopsisSecRange,
  synopsisSecNumber,
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
export function currentMusicClipSec() {
  return Math.min(28, parseInt(musicClipSecNumber.value, 10) || 10);
}
export function currentFlagSec() {
  return parseInt(flagSecNumber.value, 10) || 5;
}
export function currentSynopsisSec() {
  return parseInt(synopsisSecNumber.value, 10) || 20;
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
  const itemSecByBucket = {
    music: currentMusicClipSec() + currentRevealSec(),
    flag: currentFlagSec() + currentRevealSec(),
    synopsis: currentSynopsisSec() + currentRevealSec(),
    standard:
      currentImagesPerItem() * currentImageSec() + currentRevealSec(),
  };
  const bucketOf = (comboKey) =>
    comboKey === "music:audio"
      ? "music"
      : comboKey === "country:flag"
        ? "flag"
        : comboKey.endsWith(":synopsis")
          ? "synopsis"
          : "standard";
  const activeBuckets = [
    ...new Set([...state.activeQuestionTypes].map(bucketOf)),
  ];
  const avgItemSec =
    activeBuckets.reduce((sum, b) => sum + itemSecByBucket[b], 0) /
    activeBuckets.length;
  return currentCount() * avgItemSec;
}
export function updateDurationHint() {
  durationHint.textContent = `Durée estimée : ${formatDuration(totalDurationSec())} · max disponible : ${state.currentMaxAvailable}`;
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
    musicClipSec: currentMusicClipSec(),
    flagSec: currentFlagSec(),
    synopsisSec: currentSynopsisSec(),
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
  if (s.musicClipSec) {
    musicClipSecNumber.value = s.musicClipSec;
    musicClipSecRange.value = s.musicClipSec;
  }
  if (s.flagSec) {
    flagSecNumber.value = s.flagSec;
    flagSecRange.value = s.flagSec;
  }
  if (s.synopsisSec) {
    synopsisSecNumber.value = s.synopsisSec;
    synopsisSecRange.value = s.synopsisSec;
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
