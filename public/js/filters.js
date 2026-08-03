import {
  RENDER_QUALITIES,
  SUMMARY_SPEEDS,
  AUDIO_SPEEDS,
  TYPE_BASE_LABELS,
  TYPE_EMOJI,
  questionTypeInfo,
} from "./config.js";
import { state, applyRenderQuality, currentRenderQuality } from "./state.js";
import {
  chipsContentType,
  chipsQuality,
  chipsListes,
  chipsDecades,
  chipsGenres,
  chipsGeography,
  chipsRoles,
  chipsPopulation,
  chipsSuperficie,
  chipsCategories,
  chipsSummarySpeed,
  chipsAudioSpeed,
  groupAudioParams,
  groupFlagParams,
  groupSummaryParams,
  groupSummaryPerItemParams,
  groupImageParams,
  countRange,
  countNumber,
  countCapNote,
  btnGenerate,
} from "./dom.js";
import {
  applySavedSettings,
  currentCount,
  saveSettings,
  updateDurationHint,
} from "./settings.js";

export function typeActive(type) {
  return [...state.activeQuestionTypes].some((k) => k.startsWith(type + ":"));
}

// clé de filtre : brute ("movie|genre|28") ou combinée avec un
// questionType ("country|geographie|europe:flag", voir renderChips) —
// pour comparer à availableFilters, qui ne connaît que les clés brutes
export function baseFilterKey(k) {
  const idx = k.indexOf(":");
  return idx === -1 ? k : k.slice(0, idx);
}

// construit le `selections[]` attendu par POST /api/pool-size et POST
// /api/quiz-batch (server.js, source de vérité) : une entrée par combo
// "type:questionType" actif, avec les filtres choisis pour CE combo
// précis (selectedFilters porte le questionType dans sa clé, voir
// renderChips) regroupés par filter_group — { genre: ["28"], liste:
// ["populaire"], ... }. Un combo sans filtre choisi envoie
// simplement filters: {} (= tout le pool de ce type, comportement
// serveur inchangé).
export function buildSelections() {
  return [...state.activeQuestionTypes].map((combo) => {
    const [type, questionType] = combo.split(":");
    const filters = {};
    for (const selKey of state.selectedFilters) {
      const [rawKey, qt] = selKey.split(":");
      if (qt !== questionType) continue;
      const [fType, group, code] = rawKey.split("|");
      if (fType !== type) continue;
      (filters[group] ??= []).push(code);
    }
    return { type, questionType, filters };
  });
}

// chip cliquable + accessible clavier (rôle bouton, Entrée/Espace, aria-pressed)
export function makeChip(innerHTML, active, onActivate, extraClass) {
  const chip = document.createElement("span");
  chip.className =
    "chip" +
    (extraClass ? " " + extraClass : "") +
    (active ? " active" : "");
  chip.innerHTML = innerHTML;
  chip.setAttribute("role", "button");
  chip.setAttribute("tabindex", "0");
  chip.setAttribute("aria-pressed", active ? "true" : "false");
  chip.addEventListener("click", onActivate);
  chip.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate();
    }
  });
  return chip;
}

// affiche/masque les réglages qui ne s'appliquent pas aux combinaisons
// actives. tout "*:audio" (musique ET cri Pokémon), "country:flag" et tout
// "*:summary" ont chacun leur propre durée dédiée (pas images/titre ni
// temps/image) — nommés explicitement ici : cette durée dédiée est une
// spécificité de ces modes, pas quelque chose de générique à tout
// questionType (voir aussi totalDurationSec)
export function updateSettingsVisibility() {
  const hasAudio = [...state.activeQuestionTypes].some((k) =>
    k.endsWith(":audio"),
  );
  const hasFlag = state.activeQuestionTypes.has("country:flag");
  const hasSummary = [...state.activeQuestionTypes].some((k) =>
    k.endsWith(":summary"),
  );
  // "director:summary" cycle PLUSIEURS summary (voir timeline.js) : le
  // réglage "nombre de summary" n'a de sens que pour cette combinaison
  // précise, pas pour movie/tv/game:summary (toujours 1 summary, bloc
  // statique) — d'où un contrôle de visibilité dédié, distinct de hasSummary.
  const hasDirectorSummary = state.activeQuestionTypes.has("director:summary");
  const hasStandard = [...state.activeQuestionTypes].some(
    (k) => !k.endsWith(":audio") && k !== "country:flag" && !k.endsWith(":summary"),
  );
  groupAudioParams.style.display = hasAudio ? "" : "none";
  groupFlagParams.style.display = hasFlag ? "" : "none";
  groupSummaryParams.style.display = hasSummary ? "" : "none";
  groupSummaryPerItemParams.style.display = hasDirectorSummary ? "" : "none";
  groupImageParams.style.display = hasStandard ? "" : "none";
}

// /api/catalog (server.js, source de vérité) renvoie
// { [type]: { questionTypes: [...], filters: { [filterGroup]: [{code, name}] } } }
// — pas de liste plate de "catégories" avec un label/available tout
// prêt : on la dérive ici, une entrée par (type, filterGroup, code).
// Pas de champ "available" par filtre (server.js ne l'expose pas, voir
// discussion) : seul le total de la sélection courante (updatePoolSize,
// via /api/pool-size) reste affiché.
// certains noms stockés en base portent un suffixe "(Films)"/"(Séries)"
// (voir config.json, source des filtres "liste") — redondant avec le
// préfixe emoji ajouté à l'affichage (voir renderChips), on le retire ici
function stripTypeSuffix(name) {
  return name.replace(/\s*\([^)]*\)\s*$/, "");
}

function filtersFromCatalog(catalog) {
  const filters = [];
  for (const [type, cfg] of Object.entries(catalog)) {
    for (const [group, options] of Object.entries(cfg.filters || {})) {
      for (const { code, name } of options) {
        filters.push({
          key: `${type}|${group}|${code}`,
          type,
          group,
          code,
          label: stripTypeSuffix(name),
        });
      }
    }
  }
  return filters;
}

export async function loadFilters() {
  const res = await fetch("/api/catalog");
  const catalog = await res.json();
  state.availableFilters = filtersFromCatalog(catalog);
  state.questionTypesByType = Object.fromEntries(
    Object.entries(catalog).map(([type, cfg]) => [type, cfg.questionTypes]),
  );
  // les filtres sont optionnels (voir renderChips/updatePoolSize) :
  // aucun sélectionné par défaut = pas de filtre = toutes les réponses
  // possibles pour le(s) type(s) actif(s)
  state.selectedFilters = new Set();
  applySavedSettings();
  renderContentTypeChips();
  renderQualityChips();
  renderSummarySpeedChips();
  renderAudioSpeedChips();
  updateSettingsVisibility();
  renderChips();
  await updatePoolSize();
}

// total de chips actifs dans la rangée "Type" — sert à garantir qu'au
// moins un chip reste actif, quel qu'il soit
export function totalActiveTypeCount() {
  return state.activeQuestionTypes.size;
}

// suite commune à tout changement de sélection dans la rangée "Type"
// (type simple ou combinaison country) : re-rendu, purge des filtres
// devenus invalides, rafraîchissement de la taille de pool, sauvegarde.
// Un selectedFilters vide après purge est un état normal ("pas de
// filtre"), pas un cas à secourir.
export async function onActiveTypesChanged() {
  renderContentTypeChips();
  updateSettingsVisibility();

  state.selectedFilters = new Set(
    [...state.selectedFilters].filter((k) => {
      // purge par COMBO précis (type:questionType), pas juste par type actif
      // ou non : sinon désactiver "pokemon:image" tout en gardant
      // "pokemon:summary" actif laissait traîner un filtre choisi pour
      // :image (invisible dans les chips, plus aucun mode ne le montre —
      // voir renderChips/modes) mais toujours dans selectedFilters, d'où
      // son apparition à tort sur l'écran splash (voir splashFilterLabels).
      const rawKey = baseFilterKey(k);
      const qt = k.slice(rawKey.length + 1);
      const f = state.availableFilters.find((c) => c.key === rawKey);
      return f && state.activeQuestionTypes.has(`${f.type}:${qt}`);
    }),
  );

  renderChips();
  await updatePoolSize();
  saveSettings();
}

// une boîte par type devinable (Films, Séries, Personnes, ...), et à
// l'intérieur un chip par questionType propre à ce type (Photo, Résumé,
// ...) — chaque chip reste une combinaison "type:questionType"
// indépendante (toggle activeQuestionTypes), même quand un type n'a
// qu'un seul questionType possible : pas de cas particulier "chip
// simple". Types groupés plutôt qu'une rangée plate unique : plus
// lisible dès que plusieurs types ont chacun plusieurs questionTypes
// (ex. movie: Photo/Résumé, director: Filmographie), sans changer le
// modèle de données sous-jacent (toujours des combos indépendants, pas
// de produit cartésien forcé).
export function renderContentTypeChips() {
  chipsContentType.innerHTML = "";
  for (const [type, baseLabel] of Object.entries(TYPE_BASE_LABELS)) {
    const questionTypes = state.questionTypesByType[type] || [];
    if (!questionTypes.length) continue;

    const group = document.createElement("div");
    group.className = "type-group";
    const label = document.createElement("span");
    label.className = "type-group-label";
    label.textContent = baseLabel;
    const row = document.createElement("div");
    row.className = "chips";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", baseLabel);

    for (const qt of questionTypes) {
      const comboKey = `${type}:${qt}`;
      const info = questionTypeInfo(type, qt);
      const chipLabel = `${info.icon || ""} ${info.label || qt}`.trim();
      const chip = makeChip(
        chipLabel,
        state.activeQuestionTypes.has(comboKey),
        async () => {
          if (state.activeQuestionTypes.has(comboKey)) {
            if (totalActiveTypeCount() === 1) return; // garder au moins un chip actif
            state.activeQuestionTypes.delete(comboKey);
          } else {
            state.activeQuestionTypes.add(comboKey);
          }
          await onActiveTypesChanged();
        },
        "chip-type",
      );
      row.appendChild(chip);
    }

    group.appendChild(label);
    group.appendChild(row);
    chipsContentType.appendChild(group);
  }
}

// sélection exclusive (un seul actif à la fois, jamais zéro) : à la
// différence des autres groupes de chips (multi-sélection)
export function renderQualityChips() {
  applyRenderQuality(currentRenderQuality());
  chipsQuality.innerHTML = "";
  for (const q of RENDER_QUALITIES) {
    const chip = makeChip(
      `${q.label} · ${q.fps} fps · ${q.width}×${q.height}`,
      state.renderFps === q.fps,
      () => {
        if (state.renderFps === q.fps) return;
        state.renderFps = q.fps;
        renderQualityChips();
        saveSettings();
      },
      "chip-type",
    );
    chipsQuality.appendChild(chip);
  }
}

// sélection exclusive (un seul actif à la fois), même pattern que
// renderQualityChips ci-dessus — remplace l'ancien curseur "durée
// d'affichage" en secondes fixes : chaque préréglage règle juste le
// facteur secondes/mot appliqué au texte réel (voir timeline.js).
export function renderSummarySpeedChips() {
  chipsSummarySpeed.innerHTML = "";
  for (const s of SUMMARY_SPEEDS) {
    const chip = makeChip(
      s.label,
      state.summarySpeed === s.key,
      () => {
        if (state.summarySpeed === s.key) return;
        state.summarySpeed = s.key;
        renderSummarySpeedChips();
        updateDurationHint();
        saveSettings();
      },
      "chip-type",
    );
    chipsSummarySpeed.appendChild(chip);
  }
}

// même pattern que renderSummarySpeedChips ci-dessus — pilote à la fois la
// durée d'un extrait musical et le nombre de répétitions d'un cri (voir
// AUDIO_SPEEDS/preload.js), un seul préréglage pour les deux.
export function renderAudioSpeedChips() {
  chipsAudioSpeed.innerHTML = "";
  for (const s of AUDIO_SPEEDS) {
    const chip = makeChip(
      s.label,
      state.audioSpeed === s.key,
      () => {
        if (state.audioSpeed === s.key) return;
        state.audioSpeed = s.key;
        renderAudioSpeedChips();
        updateDurationHint();
        saveSettings();
      },
      "chip-type",
    );
    chipsAudioSpeed.appendChild(chip);
  }
}

export function renderChips() {
  const groups = {
    liste: chipsListes,
    decennie: chipsDecades,
    genre: chipsGenres,
    geographie: chipsGeography,
    role: chipsRoles,
    population: chipsPopulation,
    superficie: chipsSuperficie,
    categorie: chipsCategories,
  };
  for (const container of Object.values(groups)) {
    container.innerHTML = "";
  }

  const needle = state.filterSearch.trim().toLowerCase();
  const visible = state.availableFilters.filter(
    (f) =>
      typeActive(f.type) &&
      (!needle || f.label.toLowerCase().includes(needle)),
  );

  for (const f of visible) {
    const container = groups[f.group] || chipsListes;
    // un chip par questionType ACTIF (rangée "Type de question", voir
    // activeQuestionTypes) pour ce type, pas par questionType
    // simplement disponible : si seul "tv:summary" est coché en haut,
    // les filtres séries n'affichent que leur chip summary, pas un
    // chip photo qu'aucun filtre "Type de question" ne couvre. Quand
    // plusieurs modes du même type sont actifs à la fois (ex. Pays en
    // drapeau ET en photo), un chip par mode reste nécessaire pour
    // pouvoir cibler ex. l'Europe en drapeau et l'Asie en photo dans
    // le même filtre — `visible` garantit déjà via typeActive() qu'au
    // moins un mode est actif, `modes` n'est donc jamais vide ici
    const modes = (state.questionTypesByType[f.type] || []).filter((qt) =>
      state.activeQuestionTypes.has(`${f.type}:${qt}`),
    );
    // préfixe emoji de type (🎬/📺/...) systématique sur tout chip de
    // filtre, pas seulement en cas d'ambiguïté : plusieurs types
    // peuvent partager un même groupe/libellé (ex. genre "Action" pour
    // films ET séries) sans que ce soit visuellement distinguable sinon
    const typeEmoji = TYPE_EMOJI[f.type] || "";
    const keysAndLabels = modes.map((qt) => [
      `${f.key}:${qt}`,
      `${typeEmoji} ${f.label} ${questionTypeInfo(f.type, qt).icon || ""}`.trim(),
    ]);

    for (const [selKey, label] of keysAndLabels) {
      const chip = makeChip(
        label,
        state.selectedFilters.has(selKey),
        async () => {
          // filtre : aucun filtre sélectionné est un état valide ("pas
          // de filtre"), pas besoin d'en garder au moins un
          if (state.selectedFilters.has(selKey)) {
            state.selectedFilters.delete(selKey);
          } else {
            state.selectedFilters.add(selKey);
          }
          renderChips();
          await updatePoolSize();
          saveSettings();
        },
      );
      container.appendChild(chip);
    }
  }

  // masque entièrement une section (label compris) dès qu'elle n'a
  // aucune puce à montrer — que ce soit parce que ce groupe n'existe
  // pas pour le(s) type(s) actif(s) (ex: "Géographie" pour les films)
  // ou parce que la recherche n'y trouve rien
  for (const container of Object.values(groups)) {
    container.closest(".chip-group").style.display = container.children
      .length
      ? ""
      : "none";
  }

  if (needle && visible.length === 0) {
    const empty = document.createElement("span");
    empty.className = "settings-label";
    empty.style.minWidth = "auto";
    empty.textContent = "aucun résultat";
    chipsListes.appendChild(empty);
    chipsListes.closest(".chip-group").style.display = "";
  }
}

export async function updatePoolSize() {
  try {
    const res = await fetch("/api/pool-size", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: buildSelections() }),
    });
    const data = await res.json();
    state.currentMaxAvailable = data.available;
  } catch {
    state.currentMaxAvailable = 50;
  }
  const clampedMax = Math.min(50, state.currentMaxAvailable);
  // en dessous de 5 titres dispo, le plancher habituel (min="5") n'a
  // plus de sens : on aligne min sur max pour figer le curseur sur la
  // seule valeur possible plutôt que de mentir sur la dispo réelle
  const clampedMin = Math.min(5, clampedMax);
  countRange.min = clampedMin;
  countNumber.min = clampedMin;
  countRange.max = clampedMax;
  countNumber.max = clampedMax;
  if (currentCount() > clampedMax) {
    countNumber.value = clampedMax;
    countRange.value = clampedMax;
  } else if (currentCount() < clampedMin) {
    countNumber.value = clampedMin;
    countRange.value = clampedMin;
  }
  btnGenerate.disabled = clampedMax === 0;
  if (clampedMax === 0) {
    countCapNote.textContent =
      "Aucun contenu disponible pour cette sélection";
    countCapNote.style.display = "inline";
  } else if (clampedMax < 50) {
    countCapNote.textContent = `Limité à ${clampedMax} (pool des filtres choisis)`;
    countCapNote.style.display = "inline";
  } else {
    countCapNote.style.display = "none";
  }
  updateDurationHint();
}
