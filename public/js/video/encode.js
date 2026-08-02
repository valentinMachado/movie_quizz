import { canvas, state } from "../state.js";
import { stage } from "../dom.js";
import { silentBuffer } from "../audio.js";
import { formatDuration } from "../settings.js";
import { findSegment } from "../timeline.js";
import { drawSegment } from "../render/scenes.js";
import { setProgress, setStatus } from "../status.js";

// import dynamique : si le CDN jsDelivr est indisponible/lent, on ne
// casse pas toute la page — on bascule proprement sur le repli temps
// réel (qui n'a pas besoin de Mediabunny) avec un message clair.
let Mediabunny = null;
export let mediabunnyLoadError = null;
try {
  Mediabunny =
    await import("https://cdn.jsdelivr.net/npm/mediabunny/+esm");
} catch (e) {
  mediabunnyLoadError = e;
  console.error("Mediabunny indisponible (CDN down ?):", e);
}

export const supportsFastEncode =
  Mediabunny !== null &&
  typeof VideoEncoder === "function" &&
  typeof VideoFrame === "function";

// rendu rapide : Mediabunny pilote l'encodeur, la queue interne et les
// durées de frame — on lui donne juste (timestamp, durée) en secondes
// pour chaque image dessinée sur le canvas invisible.
//
// une seule cadence (renderFps, voir RENDER_QUALITIES) pour dessiner
// ET encoder : le coût réel est dans l'encodage de chaque frame, pas
// dans son dessin, donc découpler les deux (redessiner moins souvent
// que l'encodage) n'accélérait rien — seulement plus de complexité.
//
// lecture progressive pendant l'encodage : au lieu d'accumuler la
// vidéo entière en mémoire (BufferTarget) puis de l'attacher au
// <video> une fois finie, on mux en MP4 fragmenté (append-only) vers
// un MediaSource — chaque fragment produit est ajouté au SourceBuffer
// dès qu'il est prêt, donc le navigateur peut commencer la lecture
// avant la fin du rendu. Le codec exact (profil/niveau) n'est connu
// qu'à la configuration réelle de l'encodeur (onEncoderConfig) : on
// ne peut créer le SourceBuffer qu'à ce moment-là, donc les tout
// premiers fragments (ftyp/moov) sont mis en file d'attente le temps
// que le SourceBuffer existe.
export async function renderFast() {
  const encodeFrameDurationSec = 1 / state.renderFps;
  const totalEncodeFrames = Math.max(
    1,
    Math.round((state.totalDurationMs / 1000) * state.renderFps),
  );

  const mediaSource = new MediaSource();
  const mediaSourceUrl = URL.createObjectURL(mediaSource);
  let currentObjectUrl = mediaSourceUrl;
  stage.innerHTML = "";
  const video = document.createElement("video");
  video.controls = true;
  video.src = mediaSourceUrl;
  stage.appendChild(video);

  await new Promise((resolve) => {
    if (mediaSource.readyState === "open") resolve();
    else mediaSource.addEventListener("sourceopen", resolve, { once: true });
  });

  let sourceBuffer = null;
  let videoCodec = null;
  let audioCodec = null;
  let sourceBufferReady;
  const sourceBufferReadyPromise = new Promise((resolve) => {
    sourceBufferReady = resolve;
  });
  function ensureSourceBuffer() {
    if (sourceBuffer || !videoCodec || !audioCodec) return;
    sourceBuffer = mediaSource.addSourceBuffer(
      `video/mp4; codecs="${videoCodec}, ${audioCodec}"`,
    );
    sourceBufferReady();
  }

  const allChunks = [];
  // reprend `allChunks` (qui a toujours tout, contrairement au
  // SourceBuffer) dans un Blob et rebascule le lecteur dessus en
  // conservant position/lecture — même mécanisme que la bascule finale
  // ci-dessous, réutilisé comme filet de secours quand le SourceBuffer
  // live est plein (voir appendChunk). Changer `src` interrompt
  // implicitement la lecture : chaque étape (métadonnées, currentTime,
  // play()) doit attendre la précédente, sinon le navigateur ignore
  // silencieusement certains appels.
  async function reloadFromChunks() {
    const blob = new Blob(allChunks, { type: "video/mp4" });
    const wasPlaying = !video.paused;
    const savedTime = video.currentTime;
    const nextUrl = URL.createObjectURL(blob);
    await new Promise((resolve) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.src = nextUrl;
    });
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = nextUrl;
    if (savedTime > 0) {
      await new Promise((resolve) => {
        video.addEventListener("seeked", resolve, { once: true });
        video.currentTime = savedTime;
      });
    }
    if (wasPlaying) await video.play().catch(() => {});
    return blob;
  }
  // chaîne de promesses : chaque chunk n'est ajouté qu'une fois le
  // précédent terminé (appendBuffer refuse d'être rappelé tant que
  // updating === true), et write() ne se résout — donnant le feu
  // vert à Mediabunny pour le chunk suivant — qu'une fois CE chunk
  // réellement ajouté, pour respecter la contre-pression du flux.
  let appendChain = Promise.resolve();
  // une fois vrai, on a définitivement abandonné l'ajout live (voir
  // appendChunk) : plus aucun appendBuffer n'est tenté, seul
  // `allChunks` continue de grandir jusqu'à la bascule finale.
  let liveAppendBroken = false;
  async function appendChunk(chunk) {
    if (liveAppendBroken) return;
    try {
      await new Promise((resolve, reject) => {
        const onDone = () => {
          sourceBuffer.removeEventListener("error", onError);
          resolve();
        };
        const onError = (e) => {
          sourceBuffer.removeEventListener("updateend", onDone);
          reject(e);
        };
        sourceBuffer.addEventListener("updateend", onDone, {
          once: true,
        });
        sourceBuffer.addEventListener("error", onError, {
          once: true,
        });
        sourceBuffer.appendBuffer(chunk);
      });
    } catch (e) {
      // SourceBuffer plein (quota du navigateur) : évincer des données
      // déjà bufferisées risquait de couper sous la tête de lecture en
      // cours (vécu en pratique). Plus simple et plus sûr : abandonner
      // l'ajout live pour de bon et rebasculer sur un blob de tout ce
      // qui est rendu jusqu'ici — ne plante jamais, au prix d'un
      // aperçu qui arrête de grandir en direct jusqu'à la fin du rendu.
      if (liveAppendBroken) return;
      liveAppendBroken = true;
      await reloadFromChunks();
    }
  }

  const writable = new WritableStream({
    write(chunk) {
      allChunks.push(chunk);
      if (liveAppendBroken) return;
      appendChain = appendChain
        .then(() => sourceBufferReadyPromise)
        .then(() => appendChunk(chunk));
      return appendChain;
    },
    async close() {
      await appendChain;
      if (!liveAppendBroken && mediaSource.readyState === "open") {
        mediaSource.endOfStream();
      }
    },
  });

  const output = new Mediabunny.Output({
    format: new Mediabunny.Mp4OutputFormat({ fastStart: "fragmented" }),
    target: new Mediabunny.AppendOnlyStreamTarget(writable),
  });

  const videoSource = new Mediabunny.CanvasSource(canvas, {
    codec: "avc",
    bitrate: Mediabunny.QUALITY_HIGH,
    onEncoderConfig: (config) => {
      videoCodec = config.codec;
      ensureSourceBuffer();
    },
  });
  output.addVideoTrack(videoSource);

  const audioSource = new Mediabunny.AudioBufferSource({
    codec: "aac",
    bitrate: Mediabunny.QUALITY_HIGH,
    onEncoderConfig: (config) => {
      audioCodec = config.codec;
      ensureSourceBuffer();
    },
  });
  output.addAudioTrack(audioSource);

  await output.start();

  // piste audio : le buffer musical couvre déjà écoute + fondu sur la
  // réponse (voir trimAudioBufferWithFade), donc on l'ajoute une seule
  // fois et on saute le segment "music-reveal" suivant qu'il couvre déjà.
  // Idem pour la piste "devinette" : un seul buffer couvrant toute la
  // phase de devinette d'un item, on saute donc les segments "guess"
  // suivants du même item qu'il couvre déjà. Splash a sa propre piste
  // fournie ; la réponse (hors musique) reste silencieuse, comme
  // partout où aucune piste n'est disponible, pour garder l'audio
  // synchronisé.
  setStatus("Préparation de la piste audio…", "rec");
  for (let i = 0; i < state.timeline.length; i++) {
    const seg = state.timeline[i];
    if (seg.type === "splash") {
      await audioSource.add(state.splashAudioBuffer || silentBuffer(seg.dur));
    } else if (seg.type === "music-guess") {
      await audioSource.add(state.items[seg.itemIdx].audioBuffer);
      const next = state.timeline[i + 1];
      if (
        next &&
        next.type === "music-reveal" &&
        next.itemIdx === seg.itemIdx
      ) {
        i++; // déjà couvert par le buffer ajouté ci-dessus
      }
    } else if (seg.type === "guess" && seg.imgIdx === 0) {
      const m = state.items[seg.itemIdx];
      await audioSource.add(
        m.guessAudioBuffer || silentBuffer(seg.itemGuessDur),
      );
      while (
        state.timeline[i + 1] &&
        state.timeline[i + 1].type === "guess" &&
        state.timeline[i + 1].itemIdx === seg.itemIdx
      ) {
        i++; // déjà couvert par le buffer de devinette ajouté ci-dessus
      }
    } else if (seg.type === "synopsis-guess" && seg.frameIdx === 0) {
      // director : plusieurs synopsis cyclés comme des frames (voir
      // timeline.js), même traitement que "guess" ci-dessus — un seul
      // buffer ambiant couvrant tout itemGuessDur, pas un par frame
      // (sinon le fondu de fin se répète et recommence à chaque synopsis
      // au lieu de courir sur toute la devinette).
      const m = state.items[seg.itemIdx];
      await audioSource.add(
        m.guessAudioBuffer || silentBuffer(seg.itemGuessDur),
      );
      while (
        state.timeline[i + 1] &&
        state.timeline[i + 1].type === "synopsis-guess" &&
        state.timeline[i + 1].itemIdx === seg.itemIdx
      ) {
        i++; // déjà couvert par le buffer ajouté ci-dessus
      }
    } else if (
      seg.type === "flag-guess" ||
      seg.type === "synopsis-guess"
    ) {
      const m = state.items[seg.itemIdx];
      await audioSource.add(m.guessAudioBuffer || silentBuffer(seg.dur));
    } else {
      await audioSource.add(silentBuffer(seg.dur));
    }
  }
  audioSource.close();

  for (let i = 0; i < totalEncodeFrames; i++) {
    const elapsedMs = (i / state.renderFps) * 1000;
    const seg = findSegment(elapsedMs);
    drawSegment(seg, elapsedMs - seg.start);

    await videoSource.add(
      i * encodeFrameDurationSec,
      encodeFrameDurationSec,
    );

    if (i % 90 === 0) {
      setProgress((i / totalEncodeFrames) * 100);
      setStatus(
        `Rendu en cours : image ${i}/${totalEncodeFrames}…`,
        "rec",
      );
      await new Promise((r) => setTimeout(r, 0)); // laisse respirer l'UI/event loop
    }
  }
  videoSource.close();

  await output.finalize();
  setProgress(100);

  // bascule systématique sur un blob complet en fin de rendu (même
  // mécanisme que le filet de secours de appendChunk) pour garantir un
  // lecteur entièrement rembobinable, que le direct ait décroché ou non.
  const blob = await reloadFromChunks();

  return { blob, ext: "mp4" };
}

// repli temps réel (navigateurs sans WebCodecs) : capture le canvas en direct
export function renderRealtime() {
  return new Promise((resolve, reject) => {
    const stream = canvas.captureStream(state.renderFps);
    const mimeType = MediaRecorder.isTypeSupported(
      "video/webm;codecs=vp9",
    )
      ? "video/webm;codecs=vp9"
      : "video/webm";
    const mediaRecorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    mediaRecorder.onstop = () =>
      resolve({
        blob: new Blob(chunks, { type: "video/webm" }),
        ext: "webm",
      });
    mediaRecorder.onerror = reject;
    mediaRecorder.start();

    const startTs = performance.now();
    function frame(now) {
      const elapsed = now - startTs;
      if (elapsed >= state.totalDurationMs) {
        const last = state.timeline[state.timeline.length - 1];
        drawSegment(last, last.dur);
        mediaRecorder.stop();
        return;
      }
      const seg = findSegment(elapsed);
      drawSegment(seg, elapsed - seg.start);
      setProgress((elapsed / state.totalDurationMs) * 100);
      requestAnimationFrame(frame);
    }
    setStatus(
      `Rendu en temps réel (${formatDuration(state.totalDurationMs / 1000)}) — ton navigateur ne supporte pas l'encodage rapide…`,
      "rec",
    );
    requestAnimationFrame(frame);
  });
}
