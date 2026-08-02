import { stage } from "../dom.js";

export function resetStage() {
  stage.innerHTML = "";
  const ph = document.createElement("div");
  ph.className = "stage-placeholder";
  ph.id = "stagePlaceholder";
  ph.textContent =
    "Configure tes réglages puis clique sur « Générer le quizz »";
  stage.appendChild(ph);
}
export function setStagePlaceholder(text) {
  const ph = document.getElementById("stagePlaceholder");
  if (ph) ph.textContent = text;
}
