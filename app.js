"use strict";

const $ = (id) => document.getElementById(id);
const recBtn = $("recBtn"), recLabel = $("recLabel"), timerEl = $("timer"), levelCanvas = $("level");
const fileInput = $("fileInput"), geoCheck = $("geoCheck"), exoticsCheck = $("exoticsCheck");
const playerCard = $("playerCard"), player = $("player"), analyzeBtn = $("analyzeBtn");
const statusEl = $("status"), resultsEl = $("results"), resultList = $("resultList");

const MAX_REC_SECONDS = 120;
let currentBlob = null, currentName = "aufnahme.webm";
let recorder = null, stream = null, audioCtx = null, rafId = null, timerId = null, startedAt = 0;

// ---------- Aufnahme ----------
recBtn.addEventListener("click", () => (recorder ? stopRecording() : startRecording()));

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return showError("Aufnehmen wird hier nicht unterstützt. Die Seite muss über HTTPS (oder localhost) geöffnet werden.");
  }
  try {
    // Rauschunterdrückung & Co. abschalten – die filtern sonst Vogelstimmen heraus
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    return showError("Kein Zugriff aufs Mikrofon: " + e.message);
  }
  const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"]
    .find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const type = recorder.mimeType || "audio/webm";
    const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
    setAudio(new Blob(chunks, { type }), `aufnahme.${ext}`);
    cleanupRecording();
    analyze(); // direkt nach der Aufnahme bestimmen
  };
  recorder.start(1000);
  startedAt = Date.now();
  recBtn.classList.add("recording");
  recLabel.textContent = "Aufnahme beenden";
  timerEl.hidden = levelCanvas.hidden = false;
  timerId = setInterval(tick, 250);
  tick();
  drawLevel();
  hide(resultsEl); hide(statusEl);
}

function tick() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  if (s >= MAX_REC_SECONDS) stopRecording();
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

function cleanupRecording() {
  clearInterval(timerId);
  cancelAnimationFrame(rafId);
  stream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  recorder = stream = audioCtx = null;
  recBtn.classList.remove("recording");
  recLabel.textContent = "Neue Aufnahme starten";
  timerEl.hidden = levelCanvas.hidden = true;
}

function drawLevel() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const ctx = levelCanvas.getContext("2d");
  const { width: w, height: h } = levelCanvas;
  // Frequenzspektrum bis ~12 kHz anzeigen (da singen die meisten Vögel)
  const maxBin = Math.floor((12000 / (audioCtx.sampleRate / 2)) * data.length);
  const draw = () => {
    analyser.getByteFrequencyData(data);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#2f5d3a";
    const bars = 100, bw = w / bars;
    for (let i = 0; i < bars; i++) {
      // Frequenzen gleichmäßig über die Breite verteilen, leise Anteile etwas anheben
      const v = Math.min(1, Math.pow(data[Math.floor((i / bars) * maxBin)] / 255, 0.7) * 1.2);
      ctx.fillRect(i * bw, h - v * h, bw - 1, v * h);
    }
    rafId = requestAnimationFrame(draw);
  };
  draw();
}

// ---------- Datei-Upload ----------
fileInput.addEventListener("change", () => {
  const f = fileInput.files[0];
  if (!f) return;
  setAudio(f, f.name);
  fileInput.value = "";
  analyze();
});

function setAudio(blob, name) {
  currentBlob = blob;
  currentName = name;
  if (player.src) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(blob);
  playerCard.hidden = false;
}

// ---------- Analyse ----------
analyzeBtn.addEventListener("click", analyze);

async function analyze() {
  if (!currentBlob) return;
  analyzeBtn.disabled = true;
  hide(resultsEl);
  try {
    let lat = null, lon = null;
    if (geoCheck.checked) {
      showStatus("Standort wird ermittelt …");
      const pos = await getPosition();
      if (pos) { lat = pos.coords.latitude; lon = pos.coords.longitude; }
    }
    await ensureModel();
    showStatus("Vogelstimme wird analysiert …");
    const data = await BirdNET.analyze(currentBlob, {
      lat, lon, exotics: exoticsCheck.checked,
      onProgress: (p) => showStatus(`Vogelstimme wird analysiert … ${Math.round(p * 100)} %`),
    });
    renderResults(data);
  } catch (e) {
    console.error(e);
    showError(e.message || String(e));
  } finally {
    analyzeBtn.disabled = false;
  }
}

// Modell beim Öffnen der Seite schon im Hintergrund laden (ca. 26 MB, danach im Browser-Cache)
let modelReady = false;
const modelPromise = BirdNET.load((p) => {
  if (!modelReady && !statusEl.classList.contains("error") && statusBusy) {
    showStatus(`Erkennungsmodell wird geladen … ${Math.round(p * 100)} %`);
  }
}).then(() => { modelReady = true; }, () => {});
let statusBusy = false;

async function ensureModel() {
  if (modelReady) return;
  statusBusy = true;
  showStatus("Erkennungsmodell wird geladen … (nur beim ersten Mal, ca. 26 MB)");
  await modelPromise;
  if (!modelReady) await BirdNET.load(); // erneut versuchen, wirft ggf. den Fehler
  statusBusy = false;
}

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
      timeout: 8000, maximumAge: 10 * 60 * 1000,
    });
  });
}

function renderResults(data) {
  hide(statusEl);
  resultList.innerHTML = "";
  $("filterInfo").textContent = data.filter === "regional"
    ? `Abgeglichen mit ${data.species_count} Arten, die an deinem Standort zu dieser Jahreszeit vorkommen.`
    : `Abgeglichen mit ${data.species_count} europäischen Vogelarten.`;

  const strong = data.results;
  if (!strong.length) {
    resultList.innerHTML = `<li class="hint">Leider keinen Vogel sicher erkannt. Versuche es mit einer längeren
      oder klareren Aufnahme (näher am Vogel, weniger Wind und Verkehr).</li>`;
  }
  strong.slice(0, 5).forEach((r, i) => resultList.appendChild(resultItem(r, i === 0)));

  $("noiseInfo").textContent = data.noises.length
    ? "Außerdem gehört: " + data.noises.map((n) => `${n.name} (${Math.round(n.confidence)} %)`).join(", ")
    : "";
  resultsEl.hidden = false;
  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

const BADGES = {
  rare_here: ["Selten hier", "Europäische Art, die hier zu dieser Jahreszeit normalerweise nicht vorkommt."],
  escape: ["Gefangenschaftsflüchtling?", "Kommt in Europa nicht wild vor, wird aber oft in Volieren, Zoos oder Parks gehalten."],
  vagrant: ["Möglicher Irrgast", "Art von außerhalb Europas. Kann als verflogener Irrgast vorkommen, ist aber sehr selten – Verwechslung wahrscheinlicher."],
};

function resultItem(r, top) {
  const li = document.createElement("li");
  li.className = "result" + (top ? " top" : "");
  const pct = Math.round(r.confidence);
  const color = pct >= 70 ? "#2f8a3e" : pct >= 40 ? "#d39b1c" : "#c7622e";
  const label = r.category === "expected" || r.category === "rare_here"
    ? (pct >= 70 ? "sehr wahrscheinlich" : pct >= 40 ? "wahrscheinlich" : "möglich")
    : (pct >= 70 ? "Stimme passt sehr gut" : "Stimme passt teilweise");
  const wiki = `https://de.wikipedia.org/wiki/${encodeURIComponent(r.scientific.replace(/ /g, "_"))}`;
  const at = `${Math.floor(r.best_at / 60)}:${String(Math.floor(r.best_at % 60)).padStart(2, "0")}`;
  li.innerHTML = `
    <div class="ph">🐦</div>
    <div class="info">
      <div class="name"><a href="${wiki}" target="_blank" rel="noopener"></a></div>
      <div class="sci"></div>
      ${BADGES[r.category] ? `<div class="badge ${r.category}" title="${BADGES[r.category][1]}">⚠️ ${BADGES[r.category][0]}</div>` : ""}
      <div class="bar"><div style="width:${pct}%;background:${color}"></div></div>
      <div class="meta">${label} · am deutlichsten bei ${at}</div>
      ${BADGES[r.category] ? `<div class="meta">${BADGES[r.category][1]}</div>` : ""}
    </div>
    <div class="pct">${pct} %</div>`;
  li.querySelector(".name a").textContent = r.name;
  li.querySelector(".sci").textContent = r.scientific;
  loadImage(r.scientific, li.querySelector(".ph"));
  return li;
}

// Vorschaubild aus Wikipedia laden (optional)
async function loadImage(sci, placeholder) {
  try {
    const res = await fetch(`https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(sci.replace(/ /g, "_"))}`);
    if (!res.ok) return;
    const src = (await res.json()).thumbnail?.source;
    if (!src) return;
    const img = new Image();
    img.alt = sci;
    img.onload = () => placeholder.replaceWith(img);
    img.src = src;
  } catch { /* ohne Bild weiter */ }
}

// ---------- Hilfsfunktionen ----------
function showStatus(text) {
  statusEl.className = "status";
  statusEl.innerHTML = `<span class="spinner"></span>`;
  statusEl.append(text);
  statusEl.hidden = false;
}
function showError(text) {
  statusEl.className = "status error";
  statusEl.textContent = text;
  statusEl.hidden = false;
}
function hide(el) { el.hidden = true; }
