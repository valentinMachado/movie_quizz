import {
  CFG,
  SUMMARY_SPEEDS,
  AUDIO_SPEEDS,
  TYPE_BASE_LABELS,
} from "./config.js";
import { state, currentSummarySpeed, currentAudioSpeed } from "./state.js";
import {
  answersEl,
  btnGenerate,
  btnGenerateDaily,
  btnGenerateDailyFloat,
  btnToggleAnswers,
  filterSearch,
  countNumber,
  countRange,
  downloadLink,
  flagSecNumber,
  flagSecRange,
  mapSecNumber,
  mapSecRange,
  leaderSecNumber,
  leaderSecRange,
  showLeaderNameCheckbox,
  statesmanSecNumber,
  statesmanSecRange,
  showCountryNameCheckbox,
  imageSecNumber,
  imageSecRange,
  imagesPerItemNumber,
  imagesPerItemRange,
  resultRow,
  revealSecNumber,
  revealSecRange,
  stage,
  summaryPerItemNumber,
  summaryPerItemRange,
  maxSummaryLenNumber,
  maxSummaryLenRange,
} from "./dom.js";
import {
  addSeenIds,
  clearSeenIds,
  currentCount,
  currentFlagSec,
  currentMapSec,
  currentLeaderSec,
  currentStatesmanSec,
  currentImageSec,
  currentImagesPerItem,
  currentRevealSec,
  currentSummaryPerItem,
  currentMaxSummaryLen,
  getSeenIds,
  saveSettings,
  updateDurationHint,
} from "./settings.js";
import { buildSelections, loadFilters, renderChips } from "./filters.js";
import {
  completePhases,
  haltPhases,
  refreshStats,
  resetPhases,
  setPhase,
  setProgress,
  setStatus,
} from "./status.js";
import { celebrate } from "./confetti.js";

// l'encodeur (renderFast) signale seulement QUAND la lecture devient sûre ;
// la façon de le montrer vit ici : le lecteur rebondit, les confettis
// marquent le coup, et le bouton play natif reste le seul contrôle.
function signalPreviewReady() {
  const video = stage.querySelector("video");
  // rien à signaler à qui a déjà lancé la lecture de son côté : ni un
  // rebond du lecteur, ni des confettis par-dessus une vidéo en cours
  if (!video || !video.paused) return;
  video.classList.add("preview-pop");
  video.addEventListener(
    "animationend",
    () => video.classList.remove("preview-pop"),
    { once: true },
  );
  celebrate();
}
import { resetStage, setStagePlaceholder } from "./render/stage.js";
import { loadImage, preloadAll } from "./preload.js";
import {
  applyGuessingVolumeAndFadeOut,
  loadCueBuffer,
  loopBufferToDuration,
} from "./audio.js";
import { buildTimeline, summaryDurationMs } from "./timeline.js";
import {
  mediabunnyLoadError,
  renderFast,
  renderRealtime,
  supportsFastEncode,
} from "./video/encode.js";

// quiz du jour : paramètres de rythme figés, volontairement indépendants
// des sliders de réglage manuel — sinon la vidéo générée dépendrait de
// réglages qu'un visiteur a pu laisser dans n'importe quel état, et
// changerait de rythme sans rapport avec le contenu du jour. Mêmes valeurs
// que les défauts HTML du mode manuel (voir index.html) pour un rendu
// cohérent avec un mode manuel qu'on n'aurait pas retouché.
const DAILY_QUIZ_PARAMS = {
  imagesPerItem: 3,
  imageSec: 5,
  revealSec: 4,
  audioSpeed: "normal",
  flagSec: 5,
  mapSec: 8,
  leaderSec: 5,
  statesmanSec: 5,
  summarySpeed: "normal",
  summaryPerItem: 2,
  maxSummaryLen: 1000,
};

async function generateQuiz(daily = false) {
  btnGenerate.disabled = true;
  btnGenerateDaily.disabled = true;
  btnGenerateDailyFloat.disabled = true;
  resultRow.classList.remove("show");
  answersEl.classList.remove("show");
  state.answersRevealed = false;
  btnToggleAnswers.textContent = "Voir la liste des réponses";
  resetStage();
  setProgress(0);
  resetPhases();
  setPhase("fetch");

  // démarré en parallèle (pas attendu tout de suite) pour chevaucher
  // avec la récupération du lot et le préchargement des images
  const logoImgPromise = state.logoImg
    ? Promise.resolve(state.logoImg)
    : loadImage("/logo.png").catch((e) => {
        console.warn("Logo indisponible pour le splash :", e.message);
        return null;
      });
  try {
    const imagesPerItem = daily
      ? DAILY_QUIZ_PARAMS.imagesPerItem
      : Math.min(20, Math.max(1, currentImagesPerItem()));
    const imageSec = daily ? DAILY_QUIZ_PARAMS.imageSec : currentImageSec();
    const revealSec = daily ? DAILY_QUIZ_PARAMS.revealSec : currentRevealSec();
    const audioSpeed = daily
      ? AUDIO_SPEEDS.find((s) => s.key === DAILY_QUIZ_PARAMS.audioSpeed)
      : currentAudioSpeed();
    const flagSec = daily ? DAILY_QUIZ_PARAMS.flagSec : currentFlagSec();
    const mapSec = daily ? DAILY_QUIZ_PARAMS.mapSec : currentMapSec();
    const leaderSec = daily ? DAILY_QUIZ_PARAMS.leaderSec : currentLeaderSec();
    const statesmanSec = daily
      ? DAILY_QUIZ_PARAMS.statesmanSec
      : currentStatesmanSec();
    // quiz du jour : toujours affiché, déterministe (même raison que les
    // autres DAILY_QUIZ_PARAMS ci-dessus — indépendant de ce qu'un visiteur
    // a pu laisser coché de son côté).
    const showLeaderName = daily ? true : state.showLeaderName;
    const showCountryName = daily ? true : state.showCountryName;
    const summarySecPerWord = daily
      ? SUMMARY_SPEEDS.find((s) => s.key === DAILY_QUIZ_PARAMS.summarySpeed)
          .secPerWord
      : currentSummarySpeed().secPerWord;
    const summaryPerItem = daily
      ? DAILY_QUIZ_PARAMS.summaryPerItem
      : Math.min(5, Math.max(1, currentSummaryPerItem()));
    const maxSummaryLen = daily
      ? DAILY_QUIZ_PARAMS.maxSummaryLen
      : Math.min(1000, Math.max(100, currentMaxSummaryLen()));

    let res;
    if (daily) {
      setStatus(
        `Récupération du quiz du jour (${imagesPerItem} images chacun)…`,
      );
      setStagePlaceholder("Récupération de la liste des titres…");
      res = await fetch("/api/quiz-daily", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imagesPerItem, summaryPerItem, maxSummaryLen }),
      });
    } else {
      const count = Math.min(50, Math.max(1, currentCount()));
      const selections = buildSelections();
      const exclude = getSeenIds();
      setStatus(
        `Récupération d’un lot de ${count} titres (${imagesPerItem} images chacun)…`,
      );
      setStagePlaceholder("Récupération de la liste des titres…");
      res = await fetch("/api/quiz-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selections,
          count,
          imagesPerItem,
          summaryPerItem,
          maxSummaryLen,
          exclude,
        }),
      });
    }
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const data = await res.json();

    if (data.recycled) {
      clearSeenIds();
      setStatus("Réservoir épuisé pour ces filtres, historique réinitialisé.");
    }
    if (data.excludedCount > 0) {
      setStatus(
        `${data.excludedCount} titre(s) écarté(s) faute d’image sans texte exploitable.`,
      );
    }

    setPhase("preload");
    setStagePlaceholder("Préchargement des images et extraits audio…");
    state.items = await preloadAll(data.items, {
      audioSpeed,
      revealSec,
      showLeaderName,
      showCountryName,
    });
    if (!daily) addSeenIds(data.items.map((m) => m.id));
    const failedCount = data.items.length - state.items.length;
    if (failedCount > 0) {
      setStatus(
        `${failedCount} image(s) illisible(s) côté navigateur, exclue(s) du quiz.`,
      );
    }
    if (state.items.length === 0) {
      throw new Error(
        "Aucune image n'a pu être chargée pour ce lot, réessaie.",
      );
    }

    // pistes audio fournies (splash / devinette), toujours rejouées
    // depuis leur début — seul le rendu rapide sait encoder de
    // l'audio, inutile de les charger pour le repli temps réel
    if (supportsFastEncode) {
      setStagePlaceholder("Préparation des pistes audio…");
      const [splashSrc, guessingSrc] = await Promise.all([
        loadCueBuffer("splash"),
        loadCueBuffer("guessing"),
      ]);
      state.splashAudioBuffer = loopBufferToDuration(
        splashSrc,
        CFG.splashMs / 1000,
      );
      for (const m of state.items) {
        if (m.questionType === "audio") continue;
        const guessDurSec =
          m.type === "country" && m.questionType === "flag"
            ? flagSec
            : m.type === "country" && m.questionType === "map"
              ? mapSec
              : m.type === "country" && m.questionType === "leader"
                ? leaderSec
                : m.type === "statesman"
                  ? statesmanSec
                  : m.questionType === "summary"
                    ? // director/actor : plusieurs summary cyclés (voir
                      // preload.js, même remarque sur le test)
                      Array.isArray(m.overviews)
                      ? m.overviews.reduce(
                          (sum, ov) =>
                            sum +
                            summaryDurationMs(ov, summarySecPerWord) / 1000,
                          0,
                        )
                      : summaryDurationMs(m.overview, summarySecPerWord) / 1000
                    : m.backdropImgs.length * imageSec;
        m.guessAudioBuffer = applyGuessingVolumeAndFadeOut(
          loopBufferToDuration(guessingSrc, guessDurSec),
        );
      }
    } else {
      state.splashAudioBuffer = null;
    }

    state.logoImg = await logoImgPromise;

    const built = buildTimeline(
      imageSec * 1000,
      revealSec * 1000,
      CFG.splashMs,
      flagSec * 1000,
      mapSec * 1000,
      summarySecPerWord,
      leaderSec * 1000,
      statesmanSec * 1000,
    );
    state.timeline = built.timeline;
    state.totalDurationMs = built.total;

    const hasAudio = state.items.some((m) => m.questionType === "audio");
    setStagePlaceholder(
      supportsFastEncode
        ? "Rendu rapide en cours (canvas invisible)…"
        : hasAudio
          ? "Rendu en cours (temps réel — attention, ce mode de repli ne supporte pas encore l'audio, la vidéo sera muette)…"
          : "Rendu en cours (temps réel, navigateur non compatible WebCodecs)…",
    );
    if (!supportsFastEncode && hasAudio) {
      setStatus(
        "Ton navigateur ne supporte pas le rendu rapide : la vidéo sera générée sans le son des extraits audio.",
        "err",
      );
    }
    setPhase("render");
    setProgress(0);

    // renderFast() attache déjà son <video> dès le début du rendu et
    // le nourrit au fil de l'eau (voir MediaSource dans renderFast) ;
    // le repli temps réel construit son blob d'un coup, donc on
    // n'attache le <video> qu'ici, une fois qu'il existe vraiment.
    // Important : ne JAMAIS toucher stage.innerHTML dans le cas
    // rapide, sinon ça détruit le <video> en cours de lecture que
    // renderFast() vient de reprendre après le rendu.
    const { blob, ext } = supportsFastEncode
      ? await renderFast({ onPreviewReady: signalPreviewReady })
      : await renderRealtime();

    if (!supportsFastEncode) {
      stage.innerHTML = "";
      const video = document.createElement("video");
      video.src = URL.createObjectURL(blob);
      video.controls = true;
      stage.appendChild(video);
      // le repli temps réel ne produit son blob qu'à la toute fin : il n'y
      // a pas d'aperçu anticipé possible, la vidéo devient jouable ici
      celebrate();
    }

    downloadLink.href = URL.createObjectURL(blob);
    downloadLink.download = `guess-it.${ext}`;
    resultRow.classList.add("show");
    setStatus(
      "Vidéo générée — prête à être visionnée (plein écran natif du lecteur).",
    );
    setProgress(100);
    completePhases();
    refreshStats();
  } catch (e) {
    console.error(e);
    setStatus("Erreur : " + e.message, "err");
    setStagePlaceholder("Erreur pendant la génération.");
    haltPhases();
  } finally {
    btnGenerate.disabled = false;
    btnGenerateDaily.disabled = false;
    btnGenerateDailyFloat.disabled = false;
  }
}

countRange.addEventListener("input", () => {
  countNumber.value = countRange.value;
  updateDurationHint();
  saveSettings();
});
countNumber.addEventListener("input", () => {
  const max = parseInt(countNumber.max, 10) || 50;
  const min = parseInt(countNumber.min, 10) || 5;
  const v = Math.min(
    max,
    Math.max(min, parseInt(countNumber.value, 10) || min),
  );
  countRange.value = v;
  updateDurationHint();
  saveSettings();
});
imagesPerItemRange.addEventListener("input", () => {
  imagesPerItemNumber.value = imagesPerItemRange.value;
  updateDurationHint();
  saveSettings();
});
imagesPerItemNumber.addEventListener("input", () => {
  imagesPerItemRange.value = imagesPerItemNumber.value;
  updateDurationHint();
  saveSettings();
});
imageSecRange.addEventListener("input", () => {
  imageSecNumber.value = imageSecRange.value;
  updateDurationHint();
  saveSettings();
});
imageSecNumber.addEventListener("input", () => {
  imageSecRange.value = imageSecNumber.value;
  updateDurationHint();
  saveSettings();
});
revealSecRange.addEventListener("input", () => {
  revealSecNumber.value = revealSecRange.value;
  updateDurationHint();
  saveSettings();
});
revealSecNumber.addEventListener("input", () => {
  revealSecRange.value = revealSecNumber.value;
  updateDurationHint();
  saveSettings();
});
flagSecRange.addEventListener("input", () => {
  flagSecNumber.value = flagSecRange.value;
  updateDurationHint();
  saveSettings();
});
flagSecNumber.addEventListener("input", () => {
  flagSecRange.value = flagSecNumber.value;
  updateDurationHint();
  saveSettings();
});
mapSecRange.addEventListener("input", () => {
  mapSecNumber.value = mapSecRange.value;
  updateDurationHint();
  saveSettings();
});
mapSecNumber.addEventListener("input", () => {
  mapSecRange.value = mapSecNumber.value;
  updateDurationHint();
  saveSettings();
});
leaderSecRange.addEventListener("input", () => {
  leaderSecNumber.value = leaderSecRange.value;
  updateDurationHint();
  saveSettings();
});
leaderSecNumber.addEventListener("input", () => {
  leaderSecRange.value = leaderSecNumber.value;
  updateDurationHint();
  saveSettings();
});
showLeaderNameCheckbox.addEventListener("change", () => {
  state.showLeaderName = showLeaderNameCheckbox.checked;
  saveSettings();
});
statesmanSecRange.addEventListener("input", () => {
  statesmanSecNumber.value = statesmanSecRange.value;
  updateDurationHint();
  saveSettings();
});
statesmanSecNumber.addEventListener("input", () => {
  statesmanSecRange.value = statesmanSecNumber.value;
  updateDurationHint();
  saveSettings();
});
showCountryNameCheckbox.addEventListener("change", () => {
  state.showCountryName = showCountryNameCheckbox.checked;
  saveSettings();
});
summaryPerItemRange.addEventListener("input", () => {
  summaryPerItemNumber.value = summaryPerItemRange.value;
  updateDurationHint();
  saveSettings();
});
summaryPerItemNumber.addEventListener("input", () => {
  summaryPerItemRange.value = summaryPerItemNumber.value;
  updateDurationHint();
  saveSettings();
});
maxSummaryLenRange.addEventListener("input", () => {
  maxSummaryLenNumber.value = maxSummaryLenRange.value;
  saveSettings();
});
maxSummaryLenNumber.addEventListener("input", () => {
  maxSummaryLenRange.value = maxSummaryLenNumber.value;
  saveSettings();
});
filterSearch.addEventListener("input", () => {
  state.filterSearch = filterSearch.value;
  renderChips();
});

// le bouton vit dans la barre d'action fixe en bas : l'écran de rendu
// peut très bien être hors champ au moment du clic, on l'y ramène
btnGenerate.addEventListener("click", () => {
  stage.scrollIntoView({ behavior: "smooth", block: "start" });
  generateQuiz(false);
});
function startDailyQuiz() {
  stage.scrollIntoView({ behavior: "smooth", block: "start" });
  generateQuiz(true);
}
btnGenerateDaily.addEventListener("click", startDailyQuiz);
btnGenerateDailyFloat.addEventListener("click", startDailyQuiz);

// bouton flottant : reprend le CTA principal une fois qu'il sort du
// viewport (scroll restauré au reload, ou simplement scrollé plus bas) —
// sinon le seul accès au quiz du jour reste hors écran.
new IntersectionObserver(([entry]) => {
  btnGenerateDailyFloat.classList.toggle("show", !entry.isIntersecting);
}).observe(btnGenerateDaily);
// mot ajouté à la recherche web d'une réponse, quand le titre seul est trop
// ambigu pour tomber sur la bonne fiche ("Ambre" vs "Ambre pokémon"). Vide
// pour les types dont le titre se suffit : nom de personne, titre d'article
// Wikipédia, ou morceau déjà préfixé de son artiste (voir db/refresh/music.js).
const SEARCH_HINT = {
  movie: "film",
  tv: "série",
  game: "jeu vidéo",
  country: "pays",
  painter: "peintre",
  director: "réalisateur",
  actor: "acteur",
  pokemon: "pokémon",
  superhero: "super-héros",
};

function answerSearchUrl(item) {
  const q = [item.title, SEARCH_HINT[item.type]].filter(Boolean).join(" ");
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

// construit en DOM plutôt qu'en innerHTML : les titres viennent de sources
// externes (TMDb/Wikipédia/…), textContent évite d'avoir à les échapper
function buildAnswerRow(item, index) {
  const row = document.createElement("a");
  row.className = "answer-row";
  row.href = answerSearchUrl(item);
  row.target = "_blank";
  row.rel = "noopener noreferrer";
  row.title = `Chercher « ${item.title} » sur le web`;

  const num = document.createElement("span");
  num.className = "answer-num";
  num.textContent = `${index + 1}.`;

  // state.items sort de preloadAll, pas de /api/quiz-batch : il n'y a pas
  // d'URL dedans, mais posterImg — l'image déjà décodée qui a servi à
  // l'écran de réponse. On la clone (plutôt que de recréer une <img> depuis
  // son .src) pour garder son crossOrigin et donc taper la même entrée de
  // cache, sans requête supplémentaire.
  const thumb = item.posterImg.cloneNode();
  thumb.className = "answer-thumb";
  thumb.alt = "";

  const title = document.createElement("span");
  title.className = "answer-title";
  title.textContent = item.title;

  // ce qu'on devinait, dans les mots de l'étape "Quoi deviner" (en-tête du
  // groupe de chips) : la forme de la question (photo/résumé/…) se lit déjà
  // sur la vignette, c'est le type qui manquait.
  const mode = document.createElement("span");
  mode.className = "answer-mode";
  mode.textContent = TYPE_BASE_LABELS[item.type] || item.type;

  const go = document.createElement("span");
  go.className = "answer-go";
  go.textContent = "↗";

  row.append(num, thumb, title, mode, go);
  return row;
}

btnToggleAnswers.addEventListener("click", () => {
  state.answersRevealed = !state.answersRevealed;
  if (state.answersRevealed) {
    answersEl.replaceChildren(...state.items.map(buildAnswerRow));
    answersEl.classList.add("show");
    btnToggleAnswers.textContent = "Masquer la liste des réponses";
  } else {
    answersEl.classList.remove("show");
    btnToggleAnswers.textContent = "Voir la liste des réponses";
  }
});

updateDurationHint();
refreshStats();
loadFilters()
  .then(() =>
    setStatus(
      supportsFastEncode
        ? "Prêt — choisis tes réglages puis clique sur « Générer le quizz »."
        : mediabunnyLoadError
          ? "Prêt (rendu temps réel — la dépendance de rendu rapide n'a pas pu être chargée, réessaie plus tard)."
          : "Prêt (rendu temps réel, WebCodecs non supporté par ce navigateur).",
    ),
  )
  .catch((e) => setStatus("Erreur filtres : " + e.message, "err"));
