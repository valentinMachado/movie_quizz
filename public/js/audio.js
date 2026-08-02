import { CUE_URLS } from "./config.js";

// --- audio (musique) ---
let audioCtx = null;
export function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 44100,
    });
  }
  return audioCtx;
}

// découpe un passage aléatoire de `clipSec` dans le buffer décodé (l'extrait
// iTunes fait ~30s, on n'en garde qu'une fenêtre pour ne pas dépasser la
// durée réglée par l'utilisateur)
// découpe un passage aléatoire : `clipSec` d'écoute + `fadeSec` de fondu
// supplémentaire qui continuera de jouer (en s'atténuant) pendant l'écran
// réponse, plutôt qu'une coupure nette. `fadeSec` fixe la durée TOTALE du
// buffer (clipSec + fadeSec) — encode.js s'appuie sur cette durée exacte
// pour couvrir à la fois le segment "music-guess" et "music-reveal" sans
// ajouter de piste séparée pour ce dernier (voir son commentaire "couvre
// déjà écoute + fondu") : la raccourcir désynchroniserait tout le reste de
// la piste audio après ce point. `rampSec` (<= fadeSec, défaut = fadeSec)
// ne fait que déplacer où le volume atteint réellement 0 À L'INTÉRIEUR de
// ce fadeSec — le reste jusqu'à la fin du buffer reste du silence, sans
// changer la durée totale.
export function trimAudioBufferWithFade(
  ctx,
  buffer,
  clipSec,
  fadeSec,
  rampSec = fadeSec,
) {
  const sr = buffer.sampleRate;
  const totalFrames = buffer.length;
  const targetFrames = Math.round((clipSec + fadeSec) * sr);
  const clipFrames = Math.min(totalFrames, targetFrames);
  const fadeFrames = Math.min(clipFrames, Math.round(fadeSec * sr));
  const fadeStart = clipFrames - fadeFrames;
  const rampFrames = Math.min(fadeFrames, Math.round(rampSec * sr));
  const maxStart = Math.max(0, totalFrames - clipFrames);
  const startFrame = Math.floor(Math.random() * (maxStart + 1));

  // toujours créé à la durée cible exacte : si l'extrait source est plus
  // court que demandé, le reste est complété de silence (déjà à 0 par
  // défaut) plutôt que de raccourcir la piste et désynchroniser la vidéo
  const trimmed = ctx.createBuffer(
    buffer.numberOfChannels,
    targetFrames,
    sr,
  );
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const srcData = buffer
      .getChannelData(ch)
      .subarray(startFrame, startFrame + clipFrames);
    const dst = trimmed.getChannelData(ch);
    dst.set(srcData);
    for (let f = 0; f < fadeFrames; f++) {
      dst[fadeStart + f] *= f < rampFrames ? 1 - f / rampFrames : 0;
    }
  }
  return trimmed;
}

export async function loadAndTrimAudio(url, clipSec, fadeSec, rampSec) {
  const ctx = getAudioCtx();
  const res = await fetch(url);
  if (!res.ok) throw new Error("Extrait audio illisible: " + url);
  const arrayBuffer = await res.arrayBuffer();
  const decoded = await ctx.decodeAudioData(arrayBuffer);
  return trimAudioBufferWithFade(ctx, decoded, clipSec, fadeSec, rampSec);
}

// silence de la durée voulue, même format que les extraits musicaux —
// sert à combler la piste audio pendant les segments non musicaux
export function silentBuffer(durMs) {
  const ctx = getAudioCtx();
  const frames = Math.max(1, Math.round((durMs / 1000) * ctx.sampleRate));
  return ctx.createBuffer(2, frames, ctx.sampleRate);
}

const cueBufferCache = new Map();
// chargée/décodée une seule fois par clé puis mise en cache ; renvoie
// null si le fichier est absent (le segment restera alors silencieux
// plutôt que de faire échouer toute la génération)
export function loadCueBuffer(key) {
  if (!cueBufferCache.has(key)) {
    cueBufferCache.set(
      key,
      (async () => {
        try {
          const res = await fetch(CUE_URLS[key]);
          if (!res.ok) return null;
          const arrayBuffer = await res.arrayBuffer();
          return await getAudioCtx().decodeAudioData(arrayBuffer);
        } catch (e) {
          console.warn(`Piste audio "${key}" indisponible :`, e.message);
          return null;
        }
      })(),
    );
  }
  return cueBufferCache.get(key);
}

// construit un buffer de exactement `durSec`, en rejouant `source`
// depuis son tout début (jamais un point aléatoire) et en la bouclant
// si elle est plus courte que la durée demandée ; léger fondu à chaque
// raccord de boucle pour éviter un clic
export function loopBufferToDuration(source, durSec, fadeSec = 0.03) {
  if (!source) return null;
  const sr = source.sampleRate;
  const targetFrames = Math.max(1, Math.round(durSec * sr));
  const srcFrames = source.length;
  const fadeFrames = Math.min(
    Math.floor(srcFrames / 2),
    Math.round(fadeSec * sr),
  );
  const out = getAudioCtx().createBuffer(
    source.numberOfChannels,
    targetFrames,
    sr,
  );
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const src = source.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < targetFrames; i++) dst[i] = src[i % srcFrames];
    if (srcFrames < targetFrames) {
      for (
        let loopEnd = srcFrames;
        loopEnd < targetFrames;
        loopEnd += srcFrames
      ) {
        for (
          let f = 0;
          f < fadeFrames &&
          loopEnd - f - 1 >= 0 &&
          loopEnd + f < targetFrames;
          f++
        ) {
          const g = f / fadeFrames;
          dst[loopEnd - 1 - f] *= g;
          dst[loopEnd + f] *= g;
        }
      }
    }
  }
  return out;
}

// baisse le volume de la piste "devinette" (pour ne pas couvrir la
// réflexion) et ajoute un fondu de sortie sur les 2 dernières secondes
// plutôt qu'une coupure nette avant la réponse
export function applyGuessingVolumeAndFadeOut(
  buffer,
  volume = 0.2,
  fadeOutSec = 2,
) {
  if (!buffer) return null;
  const sr = buffer.sampleRate;
  const totalFrames = buffer.length;
  const fadeFrames = Math.min(totalFrames, Math.round(fadeOutSec * sr));
  const fadeStart = totalFrames - fadeFrames;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < totalFrames; i++) {
      let g = volume;
      if (i >= fadeStart) g *= 1 - (i - fadeStart) / fadeFrames;
      d[i] *= g;
    }
  }
  return buffer;
}
