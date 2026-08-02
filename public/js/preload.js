import { CFG } from "./config.js";
import { loadAndTrimAudio } from "./audio.js";
import { currentMusicClipSec, currentRevealSec } from "./settings.js";
import { setProgress, setStatus } from "./status.js";

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image illisible: " + src));
    img.src = src;
  });
}

export async function preloadAll(picked) {
  const totalTasks = picked.reduce(
    (sum, m) =>
      sum +
      (m.type === "music"
        ? 2
        : (m.type === "country" && m.questionType === "flag") ||
            ((m.type === "movie" || m.type === "tv") &&
              m.questionType === "synopsis")
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
        if (m.type === "music") {
          const [audioBuffer, posterImg] = await Promise.all([
            loadAndTrimAudio(
              m.previewUrl,
              currentMusicClipSec(),
              currentRevealSec(),
            ).then((buf) => {
              bump();
              return buf;
            }),
            loadImage(m.posterUrl).then((img) => {
              bump();
              return img;
            }),
          ]);
          results[my] = {
            title: m.title,
            type: "music",
            artist: m.artist,
            track: m.track,
            audioBuffer,
            posterImg,
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
          };
          continue;
        }
        if (
          (m.type === "movie" || m.type === "tv") &&
          m.questionType === "synopsis"
        ) {
          const posterImg = await loadImage(m.posterUrl).then((img) => {
            bump();
            return img;
          });
          results[my] = {
            title: m.title,
            type: m.type,
            questionType: "synopsis",
            overview: m.overview,
            posterImg,
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
