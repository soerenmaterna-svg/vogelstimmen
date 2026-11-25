"use strict";
/*
 * BirdNET v2.4 im Browser (TensorFlow.js).
 * Modell: BirdNET (Cornell Lab of Ornithology & TU Chemnitz), CC BY-NC 4.0,
 * https://zenodo.org/records/15050749 – Gewichte hier auf float16 verkleinert.
 */

const BirdNET = (() => {
  const SAMPLE_RATE = 48000;
  const SEGMENT = 3 * SAMPLE_RATE;   // das Modell bewertet 3-Sekunden-Abschnitte
  const HOP = 1.5 * SAMPLE_RATE;     // Abschnitte überlappen um 1,5 s
  const MAX_SECONDS = 300;           // höchstens 5 Minuten analysieren
  const MIN_CONF = 0.05;

  // BirdNET-Klassen, die keine Vögel sind
  const NON_BIRD = new Set([
    "Dog", "Engine", "Environmental", "Fireworks", "Gun", "Human non-vocal",
    "Human vocal", "Human whistle", "Noise", "Power tools", "Siren",
  ]);

  // Kategorien: Gewicht fürs Ranking und Mindest-Sicherheit für die Anzeige.
  // Ungewöhnliche Arten müssen deutlich sicherer erkannt werden, damit sie erscheinen.
  const CATEGORIES = {
    expected:  { weight: 1.0, min: 0.10 }, // kommt hier (bzw. in Europa) regulär vor
    rare_here: { weight: 0.8, min: 0.25 }, // europäische Art, hier/jetzt eher ungewöhnlich
    escape:    { weight: 0.7, min: 0.30 }, // bekannter Gefangenschaftsflüchtling
    vagrant:   { weight: 0.5, min: 0.50 }, // Art von außerhalb Europas -> möglicher Irrgast
  };

  // ---------- Spektrogramm ----------
  // Radix-2-FFT (in-place), liefert Real- und Imaginärteil
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // Eigene Schicht des BirdNET-Modells: Mel-Spektrogramm aus Rohaudio.
  // Rechnet genau wie die Original-Schicht (tf.signal.stft, Realteil, Mel-Filter,
  // Kompression), aber in reinem JavaScript – schnell und auf jedem Backend gleich genau.
  class MelSpecLayerSimple extends tf.layers.Layer {
    constructor(config) {
      super(config);
      this.specShape = config.specShape;
      this.frameStep = config.frameStep;
      this.frameLength = config.frameLength;
      const fb = config.melFilterbank; // [frameLength/2+1][nMels]
      this.nMels = fb[0].length;
      // Filterbank spaltenweise und nur mit den Nicht-Null-Bereichen speichern
      this.filters = [];
      for (let m = 0; m < this.nMels; m++) {
        let lo = -1, hi = -1;
        for (let k = 0; k < fb.length; k++) if (fb[k][m] !== 0) { if (lo < 0) lo = k; hi = k; }
        const w = new Float32Array(Math.max(0, hi - lo + 1));
        for (let k = lo; k <= hi && lo >= 0; k++) w[k - lo] = fb[k][m];
        this.filters.push({ lo, w });
      }
      const L = this.frameLength;
      this.window = new Float32Array(L);
      for (let i = 0; i < L; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / L); // periodisches Hann-Fenster
    }
    build(inputShape) {
      this.magScale = this.addWeight("magnitude_scaling", [], "float32",
        tf.initializers.constant({ value: 1.23 }));
      super.build(inputShape);
    }
    computeOutputShape(inputShape) {
      return [inputShape[0], this.specShape[0], this.specShape[1], 1];
    }
    call(inputs) {
      const x = Array.isArray(inputs) ? inputs[0] : inputs;
      const [batch, len] = x.shape;
      const audio = x.dataSync();
      const L = this.frameLength, step = this.frameStep, nMels = this.nMels;
      const frames = Math.floor((len - L) / step) + 1;
      const exponent = 1 / (1 + Math.exp(this.magScale.read().dataSync()[0]));
      const out = new Float32Array(batch * nMels * frames);
      const re = new Float32Array(L), im = new Float32Array(L), sig = new Float32Array(len);

      for (let b = 0; b < batch; b++) {
        // auf -1..1 normalisieren
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < len; i++) { const v = audio[b * len + i]; if (v < min) min = v; }
        for (let i = 0; i < len; i++) { const v = audio[b * len + i] - min; sig[i] = v; if (v > max) max = v; }
        const scale = 1 / (max + 0.000001);
        for (let i = 0; i < len; i++) sig[i] = (sig[i] * scale - 0.5) * 2;

        for (let f = 0; f < frames; f++) {
          const off = f * step;
          for (let i = 0; i < L; i++) { re[i] = sig[off + i] * this.window[i]; im[i] = 0; }
          fft(re, im);
          for (let m = 0; m < nMels; m++) {
            const { lo, w } = this.filters[m];
            let acc = 0;
            for (let k = 0; k < w.length; k++) acc += re[lo + k] * w[k];
            // Quadrieren, Kompression; Mel-Achse umgedreht, Zeit als zweite Achse
            out[b * nMels * frames + (nMels - 1 - m) * frames + f] = Math.pow(acc * acc, exponent);
          }
        }
      }
      return tf.tensor4d(out, [batch, nMels, frames, 1]);
    }
    static get className() { return "MelSpecLayerSimple"; }
  }
  tf.serialization.registerClass(MelSpecLayerSimple);

  // Rechen-Backend: WebAssembly ist auf Handys schnell und überall gleich genau
  async function initBackend() {
    try {
      tf.wasm.setWasmPaths(new URL("vendor/", document.baseURI).href);
      if (await tf.setBackend("wasm")) return;
    } catch (e) { console.warn("WASM nicht verfügbar:", e); }
    for (const b of ["webgl", "cpu"]) {
      try { if (await tf.setBackend(b)) return; } catch { /* nächstes probieren */ }
    }
  }

  let model = null, data = null, loading = null;

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} konnte nicht geladen werden (${res.status})`);
    return res.json();
  }

  /** Lädt Modell und Daten (einmalig). onProgress(0..1) */
  function load(onProgress = () => {}) {
    if (!loading) {
      loading = (async () => {
        const [labels, europe, regional, escapes] = await Promise.all([
          fetchJSON("data/labels.json"), fetchJSON("data/europe.json"),
          fetchJSON("data/regional.json"), fetchJSON("data/escapes.json"),
        ]);
        data = { labels, europe, europeSet: new Set(europe), regional, escapes };
        await initBackend();
        model = await tf.loadLayersModel("model/model.json", { onProgress });
        // einmal "aufwärmen", damit die erste echte Analyse schneller ist
        tf.tidy(() => model.predict(tf.zeros([1, SEGMENT])).dataSync());
      })().catch((e) => { loading = null; throw e; });
    }
    return loading;
  }

  /** Beliebige Audiodatei -> Float32Array, mono, 48 kHz */
  async function decode(blob) {
    const buf = await blob.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    // Kontext mit 48 kHz anlegen: dann liefert decodeAudioData die Daten direkt in der
    // richtigen Abtastrate (eine doppelte Umrechnung kostet Erkennungsgenauigkeit)
    let ctx;
    try { ctx = new Ctx({ sampleRate: SAMPLE_RATE }); } catch { ctx = new Ctx(); }
    let audio;
    try {
      audio = await new Promise((resolve, reject) => ctx.decodeAudioData(buf, resolve, reject));
    } catch {
      throw new Error("Die Audiodatei konnte nicht gelesen werden. Versuche ein anderes Format (z. B. mp3, wav, m4a).");
    } finally {
      ctx.close?.();
    }
    const maxLen = MAX_SECONDS * audio.sampleRate;
    if (audio.sampleRate === SAMPLE_RATE) {
      // auf mono mischen
      const len = Math.min(audio.length, maxLen);
      const mono = new Float32Array(len);
      for (let c = 0; c < audio.numberOfChannels; c++) {
        const ch = audio.getChannelData(c);
        for (let i = 0; i < len; i++) mono[i] += ch[i] / audio.numberOfChannels;
      }
      return mono;
    }
    // sonst auf 48 kHz umrechnen (und dabei auf mono mischen)
    const length = Math.ceil((Math.min(audio.length, maxLen) / audio.sampleRate) * SAMPLE_RATE);
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OfflineCtx(1, length, SAMPLE_RATE);
    const src = off.createBufferSource();
    src.buffer = audio;
    src.connect(off.destination);
    src.start();
    return (await off.startRendering()).getChannelData(0);
  }

  /** Arten, die am Standort im aktuellen Monat vorkommen (Set von Label-Indizes) oder null */
  function localSpecies(lat, lon) {
    const { points, masks } = data.regional;
    let best = -1, bestDist = Infinity;
    points.forEach(([plat, plon], i) => {
      const dx = (plon - lon) * Math.cos((lat * Math.PI) / 180) * 111;
      const dy = (plat - lat) * 111;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    if (best < 0 || bestDist > 300) return null; // außerhalb Europas -> kein Standortfilter
    const bits = Uint8Array.from(atob(masks[best][new Date().getMonth()]), (c) => c.charCodeAt(0));
    const set = new Set();
    data.europe.forEach((labelIdx, i) => { if (bits[i >> 3] & (1 << (i & 7))) set.add(labelIdx); });
    return set;
  }

  function isEscape(sci) {
    return data.escapes.some((e) => sci === e || sci.startsWith(e + " "));
  }

  function categorize(idx, sci, local) {
    if (local) {
      if (local.has(idx)) return "expected";
      if (data.europeSet.has(idx)) return "rare_here";
    } else if (data.europeSet.has(idx)) {
      return "expected";
    }
    return isEscape(sci) ? "escape" : "vagrant";
  }

  /**
   * Analysiert ein Audio-Blob.
   * options: { lat, lon, exotics, onProgress(0..1) }
   */
  async function analyze(blob, { lat = null, lon = null, exotics = true, onProgress = () => {} } = {}) {
    await load();
    const samples = await decode(blob);
    if (samples.length < SAMPLE_RATE / 2) throw new Error("Die Aufnahme ist zu kurz (mindestens 1 Sekunde).");

    const local = lat != null && lon != null ? localSpecies(lat, lon) : null;

    const starts = [];
    for (let s = 0; s === 0 || s + SAMPLE_RATE <= samples.length; s += HOP) starts.push(s);

    const best = new Map(); // Label-Index -> { conf, at, detections }
    for (let n = 0; n < starts.length; n++) {
      const seg = new Float32Array(SEGMENT);
      seg.set(samples.subarray(starts[n], starts[n] + SEGMENT));
      const probs = await tf.tidy(() => model.predict(tf.tensor2d(seg, [1, SEGMENT]))).data();
      for (let i = 0; i < probs.length; i++) {
        const p = probs[i];
        if (p < MIN_CONF) continue;
        const b = best.get(i) || { conf: 0, at: 0, detections: 0 };
        if (p >= 0.25) b.detections++;
        if (p > b.conf) { b.conf = p; b.at = starts[n] / SAMPLE_RATE; }
        best.set(i, b);
      }
      onProgress((n + 1) / starts.length);
      await tf.nextFrame(); // Oberfläche aktualisieren lassen
    }

    const birds = [], noises = [];
    for (const [idx, b] of best) {
      const [sci, name] = data.labels[idx];
      if (NON_BIRD.has(sci)) {
        if (b.conf >= 0.25) noises.push({ name, confidence: b.conf * 100 });
        continue;
      }
      const category = categorize(idx, sci, local);
      if (!exotics && (category === "escape" || category === "vagrant")) continue;
      if (b.conf < CATEGORIES[category].min) continue;
      birds.push({
        scientific: sci, name, category, confidence: Math.round(b.conf * 1000) / 10,
        best_at: b.at, detections: b.detections, score: b.conf * CATEGORIES[category].weight,
      });
    }
    birds.sort((a, b) => b.score - a.score);
    noises.sort((a, b) => b.confidence - a.confidence);

    return {
      results: birds.slice(0, 6),
      noises,
      filter: local ? "regional" : "europe",
      species_count: local ? local.size : data.europe.length,
      duration: samples.length / SAMPLE_RATE,
    };
  }

  return { load, analyze };
})();
