import { CFG, CRY_GAP_SEC } from "./config.js";
import { loadAndTrimAudio, loadAndLoopAudio } from "./audio.js";
import { setProgress, setStatus } from "./status.js";

// durée du fondu AUDIBLE (rampSec, voir trimAudioBufferWithFade) — distincte
// de la durée totale du buffer (toujours clipSec+revealSec exactement, pour
// rester synchro avec le timeline vidéo, voir encode.js). Si le reveal est
// assez long, le fondu se termine 2s avant sa fin pour laisser un peu de
// silence avant que la question suivante ne démarre son propre son ; sinon
// (reveal trop court pour un fondu de 2s + 2s de silence) il occupe tout le
// reveal disponible plutôt que d'être coupé plus court encore.
const MIN_MUSIC_FADE_SEC = 2;
function musicFadeSec(revealSec) {
  return Math.max(MIN_MUSIC_FADE_SEC, revealSec - MIN_MUSIC_FADE_SEC);
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image illisible: " + src));
    img.src = src;
  });
}

export async function preloadAll(picked, { audioSpeed, revealSec }) {
  const totalTasks = picked.reduce(
    (sum, m) =>
      sum +
      (m.questionType === "audio"
        ? 2
        : (m.type === "country" && m.questionType === "flag") ||
            m.questionType === "summary"
          ? 1
          : m.imageUrls.length + 1),
    0,
  );
  const results = new Array(picked.length);
  let done = 0;

  function bump() {
    done++;
    setStatus(`Préchargement ${done}/${totalTasks}…`);
    setProgress((done / totalTasks) * 100);
  }

  let idx = 0;
  async function worker() {
    while (idx < picked.length) {
      const my = idx++;
      const m = picked[my];
      try {
        if (m.questionType === "audio") {
          // musique (extrait ~30s) : fenêtre aléatoire de audioSpeed.musicSec
          // secondes, le buffer déborde volontairement sur revealSec pour
          // continuer à jouer (en fondu) sur l'écran de réponse (voir
          // loadAndTrimAudio). Tout autre type audio (ex. cri Pokémon,
          // 1-2s) : rejoué audioSpeed.cryCount fois, espacé, et s'arrête
          // net à la fin de la devinette — rien ne continue sur la réponse
          // (voir loadAndLoopAudio) — durée réelle inconnue avant décodage,
          // renvoyée par la fonction elle-même (`guessSec`), contrairement
          // à la musique où elle est fixée d'avance (`audioSpeed.musicSec`).
          const loadAudio =
            m.type === "music"
              ? loadAndTrimAudio(
                  m.previewUrl,
                  audioSpeed.musicSec,
                  revealSec,
                  musicFadeSec(revealSec),
                ).then((buffer) => ({ buffer, guessSec: audioSpeed.musicSec }))
              : loadAndLoopAudio(m.previewUrl, audioSpeed.cryCount, CRY_GAP_SEC);
          const [{ buffer: audioBuffer, guessSec: audioGuessSec }, posterImg] =
            await Promise.all([
              loadAudio.then((r) => {
                bump();
                return r;
              }),
              loadImage(m.posterUrl).then((img) => {
                bump();
                return img;
              }),
            ]);
          results[my] = {
            title: m.title,
            type: m.type,
            questionType: "audio",
            // artist/track : uniquement pour la musique (voir
            // drawMusicReveal, qui retombe sur m.title sinon)
            ...(m.type === "music"
              ? { artist: m.artist, track: m.track }
              : {}),
            audioBuffer,
            audioGuessSec,
            posterImg,
            reason: m.reason,
            isAnniversary: m.isAnniversary,
          };
          continue;
        }
        if (m.type === "country" && m.questionType === "flag") {
          const posterImg = await loadImage(m.posterUrl).then((img) => {
            bump();
            return img;
          });
          results[my] = {
            title: m.title,
            type: "country",
            questionType: "flag",
            capital: m.capital,
            posterImg,
            reason: m.reason,
            isAnniversary: m.isAnniversary,
          };
          continue;
        }
        if (m.questionType === "summary") {
          const posterImg = await loadImage(m.posterUrl).then((img) => {
            bump();
            return img;
          });
          results[my] = {
            title: m.title,
            type: m.type,
            questionType: "summary",
            posterImg,
            reason: m.reason,
            isAnniversary: m.isAnniversary,
            // director : plusieurs summary (voir timeline.js/seg.frameIdx),
            // pas un seul m.overview comme movie/tv/game.
            ...(m.type === "director"
              ? { overviews: m.overviews, movieTitles: m.movieTitles }
              : { overview: m.overview }),
          };
          continue;
        }
        const [backdropImgs, posterImg] = await Promise.all([
          Promise.all(
            m.imageUrls.map((url) =>
              loadImage(url).then((img) => {
                bump();
                return img;
              }),
            ),
          ),
          loadImage(m.posterUrl).then((img) => {
            bump();
            return img;
          }),
        ]);
        results[my] = {
          title: m.title,
          type: m.type,
          backdropImgs,
          posterImg,
          director: m.director,
          imageTitles: m.imageTitles,
          reason: m.reason,
          isAnniversary: m.isAnniversary,
        };
      } catch (e) {
        // une image qui ne charge pas (ex: pare-feu Cloudflare sur les
        // peintures selon le Referer du navigateur) ne doit pas faire
        // planter tout le quiz — on exclut juste cet item, comme le
        // fait déjà le serveur quand une image est introuvable
        console.warn(
          `Image illisible pour "${m.title}", exclu du quiz :`,
          e.message,
        );
        results[my] = null;
      }
    }
  }

  await Promise.all(
    Array.from({ length: CFG.preloadConcurrency }, worker),
  );
  return results.filter(Boolean);
}
