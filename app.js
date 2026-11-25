"use strict";

const $ = (id) => document.getElementById(id);
const recBtn = $("recBtn"), recLabel = $("recLabel"), timerEl = $("timer"), levelCanvas = $("level");
const fileInput = $("fileInput"), geoCheck = $("geoCheck"), exoticsCheck = $("exoticsCheck");
const playerCard = $("playerCard"), player = $("player"), analyzeBtn = $("analyzeBtn");
const statusEl = $("status"), resultsEl = $("results"), resultList = $("resultList");

const MAX_REC_SECONDS = 120;
let currentBlob = null, currentName = "aufnahme.webm", currentSource = "Aufnahme", currentTime = Date.now();
let currentEntryId = null;
let recorder = null, stream = null, audioCtx = null, rafId = null, timerId = null, startedAt = 0;

// ---------- Ansichten ----------
const views = { identify: $("viewIdentify"), history: $("viewHistory"), detail: $("viewDetail") };
function showView(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  $("tabIdentify").classList.toggle("active", name === "identify");
  $("tabHistory").classList.toggle("active", name !== "identify");
  window.scrollTo({ top: 0 });
}
$("tabIdentify").addEventListener("click", () => showView("identify"));
$("tabHistory").addEventListener("click", () => openHistory());
$("backBtn").addEventListener("click", () => openHistory());

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
  const recordedAt = Date.now();
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const type = recorder.mimeType || "audio/webm";
    const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
    setAudio(new Blob(chunks, { type }), `aufnahme.${ext}`, "Aufnahme", recordedAt);
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
  positionPromise = getPosition(); // Fundort schon während der Aufnahme bestimmen
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
  setAudio(f, f.name, `Datei: ${f.name}`, Date.now());
  fileInput.value = "";
  positionPromise = null;
  analyze();
});

function setAudio(blob, name, source, time) {
  currentBlob = blob;
  currentName = name;
  currentSource = source;
  currentTime = time;
  currentEntryId = null;
  if (player.src) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(blob);
  playerCard.hidden = false;
}

// ---------- Analyse ----------
analyzeBtn.addEventListener("click", analyze);
let positionPromise = null;

async function analyze() {
  if (!currentBlob) return;
  analyzeBtn.disabled = true;
  hide(resultsEl);
  try {
    // Standort: für den Fundort im Verlauf und (falls gewünscht) für den Artenfilter
    showStatus("Standort wird ermittelt …");
    const pos = await (positionPromise || getPosition());
    positionPromise = null;
    const lat = pos?.coords.latitude ?? null, lon = pos?.coords.longitude ?? null;

    await ensureModel();
    showStatus("Vogelstimme wird analysiert …");
    const data = await BirdNET.analyze(currentBlob, {
      lat: geoCheck.checked ? lat : null, lon: geoCheck.checked ? lon : null,
      exotics: exoticsCheck.checked,
      onProgress: (p) => showStatus(`Vogelstimme wird analysiert … ${Math.round(p * 100)} %`),
    });

    const entry = {
      created: currentTime, source: currentSource, audio: currentBlob, mime: currentBlob.type,
      duration: data.duration, lat, lon, accuracy: pos?.coords.accuracy ?? null, place: null,
      results: data.results.slice(0, 5).map(({ score, ...r }) => r), noises: data.noises,
      filter: data.filter, species_count: data.species_count, confirmed: [], note: "",
    };
    if (currentEntryId != null) {
      // erneute Bestimmung derselben Aufnahme: vorhandenen Fund aktualisieren
      const old = await History.get(currentEntryId);
      if (old) Object.assign(entry, { id: old.id, place: old.place, note: old.note,
        confirmed: old.confirmed.filter((s) => entry.results.some((r) => r.scientific === s)) });
    }
    let saved = false;
    try {
      if (entry.id != null) await History.put(entry);
      else entry.id = await History.add(entry);
      currentEntryId = entry.id;
      saved = true;
      updateHistoryCount();
      if (lat != null && !entry.place) fillPlace(entry);
    } catch (e) {
      console.warn("Speichern im Verlauf fehlgeschlagen:", e);
    }
    renderResults(data, saved ? entry : null);
  } catch (e) {
    console.error(e);
    showError(e.message || String(e));
  } finally {
    analyzeBtn.disabled = false;
  }
}

async function fillPlace(entry) {
  const place = await History.placeName(entry.lat, entry.lon);
  if (!place) return;
  const fresh = await History.get(entry.id);
  if (!fresh) return;
  fresh.place = entry.place = place;
  await History.put(fresh);
  if (detailEntry?.id === entry.id) renderDetailHead(fresh);
}

// Modell beim Öffnen der Seite schon im Hintergrund laden (ca. 26 MB, danach im Browser-Cache)
let modelReady = false, statusBusy = false;
const modelPromise = BirdNET.load((p) => {
  if (!modelReady && !statusEl.classList.contains("error") && statusBusy) {
    showStatus(`Erkennungsmodell wird geladen … ${Math.round(p * 100)} %`);
  }
}).then(() => { modelReady = true; }, () => {});

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
      enableHighAccuracy: true, timeout: 10000, maximumAge: 2 * 60 * 1000,
    });
  });
}

function renderResults(data, entry) {
  hide(statusEl);
  $("filterInfo").textContent = data.filter === "regional"
    ? `Abgeglichen mit ${data.species_count} Arten, die an deinem Standort zu dieser Jahreszeit vorkommen.`
    : `Abgeglichen mit ${data.species_count} europäischen Vogelarten.`;
  renderResultItems(resultList, data.results.slice(0, 5), entry);
  $("noiseInfo").textContent = noiseText(data.noises);
  $("savedInfo").hidden = !entry;
  resultsEl.hidden = false;
  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}
$("openSaved").addEventListener("click", () => currentEntryId != null && openDetail(currentEntryId));

function noiseText(noises) {
  return noises?.length
    ? "Außerdem gehört: " + noises.map((n) => `${n.name} (${Math.round(n.confidence)} %)`).join(", ")
    : "";
}

function renderResultItems(list, results, entry) {
  list.innerHTML = "";
  if (!results.length) {
    list.innerHTML = `<li class="hint">Leider keinen Vogel sicher erkannt. Versuche es mit einer längeren
      oder klareren Aufnahme (näher am Vogel, weniger Wind und Verkehr).</li>`;
  }
  results.forEach((r, i) => list.appendChild(resultItem(r, i === 0, entry)));
}

const BADGES = {
  rare_here: ["Selten hier", "Europäische Art, die hier zu dieser Jahreszeit normalerweise nicht vorkommt."],
  escape: ["Gefangenschaftsflüchtling?", "Kommt in Europa nicht wild vor, wird aber oft in Volieren, Zoos oder Parks gehalten."],
  vagrant: ["Möglicher Irrgast", "Art von außerhalb Europas. Kann als verflogener Irrgast vorkommen, ist aber sehr selten – Verwechslung wahrscheinlicher."],
};

function resultItem(r, top, entry) {
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
    <div class="result-main">
      <div class="ph">🐦</div>
      <div class="info">
        <div class="name"><a href="${wiki}" target="_blank" rel="noopener"></a></div>
        <div class="sci"></div>
        ${BADGES[r.category] ? `<div class="badge ${r.category}" title="${BADGES[r.category][1]}">⚠️ ${BADGES[r.category][0]}</div>` : ""}
        <div class="bar"><div style="width:${pct}%;background:${color}"></div></div>
        <div class="meta">${label} · am deutlichsten bei ${at}</div>
        ${BADGES[r.category] ? `<div class="meta">${BADGES[r.category][1]}</div>` : ""}
      </div>
      <div class="pct">${pct} %</div>
    </div>`;
  li.querySelector(".name a").textContent = r.name;
  li.querySelector(".sci").textContent = r.scientific;
  if (entry) li.appendChild(seenButton(r, entry));
  loadImage(r.scientific, li.querySelector(".ph"));
  return li;
}

// Knopf "Gesehen": bestätigt, dass man den Vogel auch gesehen hat
function seenButton(r, entry) {
  const btn = document.createElement("button");
  btn.className = "seen";
  const update = () => {
    const on = entry.confirmed.includes(r.scientific);
    btn.classList.toggle("on", on);
    btn.textContent = on ? "✅ Gesehen – bestätigt" : "👁️ Gesehen? Hier bestätigen";
    btn.closest?.(".result")?.classList.toggle("confirmed", on);
  };
  btn.addEventListener("click", async () => {
    const fresh = (await History.get(entry.id)) || entry;
    const set = new Set(fresh.confirmed);
    set.has(r.scientific) ? set.delete(r.scientific) : set.add(r.scientific);
    fresh.confirmed = entry.confirmed = [...set];
    await History.put(fresh);
    update();
  });
  queueMicrotask(update);
  return btn;
}

// Vorschaubild aus Wikipedia laden (optional)
const imageCache = new Map();
async function loadImage(sci, placeholder) {
  try {
    if (!imageCache.has(sci)) {
      imageCache.set(sci, fetch(`https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(sci.replace(/ /g, "_"))}`)
        .then((res) => (res.ok ? res.json() : {})).then((j) => j.thumbnail?.source || null).catch(() => null));
    }
    const src = await imageCache.get(sci);
    if (!src) return;
    const img = new Image();
    img.alt = sci;
    img.className = placeholder.className === "ph" ? "" : placeholder.className;
    img.onload = () => placeholder.replaceWith(img);
    img.src = src;
  } catch { /* ohne Bild weiter */ }
}

// ---------- Verlauf: "Meine Funde" ----------
async function updateHistoryCount() {
  try {
    const n = await History.count();
    $("historyCount").textContent = n ? `(${n})` : "";
  } catch { /* IndexedDB nicht verfügbar */ }
}
updateHistoryCount();

$("onlyConfirmed").addEventListener("change", renderHistory);

async function openHistory() {
  showView("history");
  await renderHistory();
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" })
    + ", " + d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr";
}

function placeText(e) {
  if (e.place) return e.place;
  if (e.lat != null) return `${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}`;
  return "Fundort unbekannt";
}

async function renderHistory() {
  const list = $("historyList");
  let entries;
  try {
    entries = await History.all();
  } catch {
    list.innerHTML = `<li class="hint">Der Verlauf ist in diesem Browser nicht verfügbar (z. B. im privaten Modus).</li>`;
    return;
  }
  if ($("onlyConfirmed").checked) entries = entries.filter((e) => e.confirmed.length);
  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = `<li class="hint empty">Noch keine Funde gespeichert. Nimm eine Vogelstimme auf –
      jede Bestimmung landet automatisch hier.</li>`;
    return;
  }
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = "history-item";
    const top = e.results[0];
    const seen = e.results.filter((r) => e.confirmed.includes(r.scientific));
    li.innerHTML = `
      <div class="ph">🐦</div>
      <div class="info">
        <div class="h-species"></div>
        <div class="h-meta"></div>
        <div class="h-meta h-place"></div>
      </div>
      <div class="h-arrow">›</div>`;
    const title = seen.length
      ? seen.map((r) => `✅ ${r.name}`).join(", ")
      : top ? `${top.name} · ${Math.round(top.confidence)} %` : "Kein Vogel erkannt";
    li.querySelector(".h-species").textContent = title;
    li.querySelector(".h-meta").textContent = formatDate(e.created) + (e.results.length > 1 && !seen.length ? ` · +${e.results.length - 1} weitere` : "");
    li.querySelector(".h-place").textContent = "📍 " + placeText(e);
    li.addEventListener("click", () => openDetail(e.id));
    if (top || seen[0]) loadImage((seen[0] || top).scientific, li.querySelector(".ph"));
    list.appendChild(li);
  }
}

$("exportBtn").addEventListener("click", async () => {
  const csv = await History.toCSV();
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), {
    href: url, download: `vogelfunde-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// ---------- Detailansicht eines Fundes ----------
let detailEntry = null, noteTimer = null;

async function openDetail(id) {
  const e = await History.get(id);
  if (!e) return openHistory();
  detailEntry = e;
  showView("detail");
  renderDetailHead(e);
  const p = $("detailPlayer");
  if (p.src) URL.revokeObjectURL(p.src);
  p.src = URL.createObjectURL(e.audio);
  $("detailNote").value = e.note || "";
  renderResultItems($("detailResults"), e.results, e);
  $("detailNoise").textContent = noiseText(e.noises);
  if (e.lat != null && !e.place) fillPlace(e);
}

function renderDetailHead(e) {
  $("detailDate").textContent = formatDate(e.created) + " · " + e.source;
  const place = $("detailPlace");
  place.textContent = "📍 " + placeText(e);
  if (e.lat != null) {
    const a = document.createElement("a");
    a.href = `https://www.openstreetmap.org/?mlat=${e.lat}&mlon=${e.lon}#map=15/${e.lat}/${e.lon}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Auf Karte zeigen";
    const coords = document.createElement("div");
    coords.className = "coords";
    coords.textContent = `${e.lat.toFixed(5)}, ${e.lon.toFixed(5)}` +
      (e.accuracy ? ` (± ${Math.round(e.accuracy)} m)` : "") + " · ";
    coords.appendChild(a);
    place.appendChild(coords);
  }
}

$("detailNote").addEventListener("input", () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(async () => {
    if (!detailEntry) return;
    const fresh = await History.get(detailEntry.id);
    if (!fresh) return;
    fresh.note = detailEntry.note = $("detailNote").value;
    await History.put(fresh);
  }, 400);
});

$("deleteBtn").addEventListener("click", async () => {
  if (!detailEntry || !confirm("Diesen Fund mit Aufnahme wirklich löschen?")) return;
  await History.remove(detailEntry.id);
  if (currentEntryId === detailEntry.id) currentEntryId = null;
  detailEntry = null;
  updateHistoryCount();
  openHistory();
});

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
