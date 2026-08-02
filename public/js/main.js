import { CFG } from "./config.js";
import { state } from "./state.js";
import {
  answersEl,
  btnGenerate,
  btnToggleAnswers,
  filterSearch,
  countNumber,
  countRange,
  downloadLink,
  flagSecNumber,
  flagSecRange,
  imageSecNumber,
  imageSecRange,
  imagesPerItemNumber,
  imagesPerItemRange,
  musicClipSecNumber,
  musicClipSecRange,
  resultRow,
  revealSecNumber,
  revealSecRange,
  stage,
  synopsisSecNumber,
  synopsisSecRange,
} from "./dom.js";
import {
  addSeenIds,
  clearSeenIds,
  currentCount,
  currentFlagSec,
  currentImageSec,
  currentImagesPerItem,
  currentMusicClipSec,
  currentRevealSec,
  currentSynopsisSec,
  getSeenIds,
  saveSettings,
  updateDurationHint,
} from "./settings.js";
import { buildSelections, loadFilters, renderChips } from "./filters.js";
import { refreshStats, setProgress, setStatus } from "./status.js";
import { resetStage, setStagePlaceholder } from "./render/stage.js";
import { loadImage, preloadAll } from "./preload.js";
import {
  applyGuessingVolumeAndFadeOut,
  loadCueBuffer,
  loopBufferToDuration,
} from "./audio.js";
import { buildTimeline } from "./timeline.js";
import {
  mediabunnyLoadError,
  renderFast,
  renderRealtime,
  supportsFastEncode,
} from "./video/encode.js";

async function generateQuiz() {
  btnGenerate.disabled = true;
  resultRow.classList.remove("show");
  answersEl.classList.remove("show");
  state.answersRevealed = false;
  resetStage();
  setProgress(0);

  // démarré en parallèle (pas attendu tout de suite) pour chevaucher
  // avec la récupération du lot et le préchargement des images
  const logoImgPromise = state.logoImg
    ? Promise.resolve(state.logoImg)
    : loadImage("/logo.png").catch((e) => {
        console.warn("Logo indisponible pour le splash :", e.message);
        return null;
      });

  try {
    const count = Math.min(50, Math.max(1, currentCount()));
    const imagesPerItem = Math.min(
      5,
      Math.max(1, currentImagesPerItem()),
    );
    const selections = buildSelections();
    const exclude = getSeenIds();

    setStatus(
      `Récupération d’un lot de ${count} titres (${imagesPerItem} images chacun)…`,
    );
    setStagePlaceholder("Récupération de la liste des titres…");
    const res = await fetch("/api/quiz-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections, count, imagesPerItem, exclude }),
    });
    if (!res.ok)
      throw new Error((await res.json()).error || res.statusText);
    const data = await res.json();

    if (data.recycled) {
      clearSeenIds();
      setStatus(
        "Réservoir épuisé pour ces filtres, historique réinitialisé.",
      );
    }
    if (data.excludedCount > 0) {
      setStatus(
        `${data.excludedCount} titre(s) écarté(s) faute d’image sans texte exploitable.`,
      );
    }

    setStagePlaceholder("Préchargement des images et extraits audio…");
    state.items = await preloadAll(data.items);
    addSeenIds(data.items.map((m) => m.id));
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
        if (m.type === "music") continue;
        const guessDurSec =
          m.type === "country" && m.questionType === "flag"
            ? currentFlagSec()
            : (m.type === "movie" || m.type === "tv") &&
                m.questionType === "synopsis"
              ? currentSynopsisSec()
              : m.backdropImgs.length * currentImageSec();
        m.guessAudioBuffer = applyGuessingVolumeAndFadeOut(
          loopBufferToDuration(guessingSrc, guessDurSec),
        );
      }
    } else {
      state.splashAudioBuffer = null;
    }

    state.logoImg = await logoImgPromise;

    const built = buildTimeline(
      currentImageSec() * 1000,
      currentRevealSec() * 1000,
      CFG.splashMs,
      currentMusicClipSec() * 1000,
      currentFlagSec() * 1000,
      currentSynopsisSec() * 1000,
    );
    state.timeline = built.timeline;
    state.totalDurationMs = built.total;

    const hasMusic = state.items.some((m) => m.type === "music");
    setStagePlaceholder(
      supportsFastEncode
        ? "Rendu rapide en cours (canvas invisible)…"
        : hasMusic
          ? "Rendu en cours (temps réel — attention, ce mode de repli ne supporte pas encore l'audio, la vidéo sera muette)…"
          : "Rendu en cours (temps réel, navigateur non compatible WebCodecs)…",
    );
    if (!supportsFastEncode && hasMusic) {
      setStatus(
        "Ton navigateur ne supporte pas le rendu rapide : la vidéo sera générée sans le son des extraits musicaux.",
        "err",
      );
    }
    setProgress(0);

    // renderFast() attache déjà son <video> dès le début du rendu et
    // le nourrit au fil de l'eau (voir MediaSource dans renderFast) ;
    // le repli temps réel construit son blob d'un coup, donc on
    // n'attache le <video> qu'ici, une fois qu'il existe vraiment.
    // Important : ne JAMAIS toucher stage.innerHTML dans le cas
    // rapide, sinon ça détruit le <video> en cours de lecture que
    // renderFast() vient de reprendre après le rendu.
    const { blob, ext } = supportsFastEncode
      ? await renderFast()
      : await renderRealtime();

    if (!supportsFastEncode) {
      stage.innerHTML = "";
      const video = document.createElement("video");
      video.src = URL.createObjectURL(blob);
      video.controls = true;
      stage.appendChild(video);
    }

    downloadLink.href = URL.createObjectURL(blob);
    downloadLink.download = `guess-it.${ext}`;
    resultRow.classList.add("show");
    setStatus(
      "Vidéo générée — prête à être visionnée (plein écran natif du lecteur).",
    );
    setProgress(100);
    refreshStats();
  } catch (e) {
    console.error(e);
    setStatus("Erreur : " + e.message, "err");
    setStagePlaceholder("Erreur pendant la génération.");
  } finally {
    btnGenerate.disabled = false;
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
musicClipSecRange.addEventListener("input", () => {
  musicClipSecNumber.value = musicClipSecRange.value;
  updateDurationHint();
  saveSettings();
});
musicClipSecNumber.addEventListener("input", () => {
  musicClipSecRange.value = musicClipSecNumber.value;
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
synopsisSecRange.addEventListener("input", () => {
  synopsisSecNumber.value = synopsisSecRange.value;
  updateDurationHint();
  saveSettings();
});
synopsisSecNumber.addEventListener("input", () => {
  synopsisSecRange.value = synopsisSecNumber.value;
  updateDurationHint();
  saveSettings();
});
filterSearch.addEventListener("input", () => {
  state.filterSearch = filterSearch.value;
  renderChips();
});

btnGenerate.addEventListener("click", generateQuiz);
btnToggleAnswers.addEventListener("click", () => {
  state.answersRevealed = !state.answersRevealed;
  if (state.answersRevealed) {
    answersEl.innerHTML = state.items
      .map((m, i) => `<span>${i + 1}. ${m.title}</span>`)
      .join("<br>");
    answersEl.classList.add("show");
    btnToggleAnswers.textContent = "Masquer la liste des titres";
  } else {
    answersEl.classList.remove("show");
    btnToggleAnswers.textContent = "Voir la liste des titres";
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
