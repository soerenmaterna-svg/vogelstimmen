"use strict";
/*
 * Heuschrecken-/Insekten-Erkennung im Browser mit BirdNET+ V3.0 (Apache 2.0) über
 * ONNX Runtime Web. Das Modell wurde auf Insekten (und Störgeräusche) gekürzt,
 * siehe tools/build_insects.py. Wird erst geladen, wenn man in den Insekten-Modus wechselt.
 */

const InsectNet = (() => {
  const SAMPLE_RATE = 32000;
  const SEGMENT = 3 * SAMPLE_RATE;   // 3-Sekunden-Abschnitte
  const HOP = 1.5 * SAMPLE_RATE;     // 1,5 s Überlappung
  const MIN_CONF = 0.05;
  const BATCH = 4;

  // wie bei den Vögeln: Ungewöhnliches muss sicherer erkannt sein
  const CATEGORIES = {
    expected:  { weight: 1.0, min: 0.10 },
    rare_here: { weight: 0.8, min: 0.25 },
    escape:    { weight: 0.7, min: 0.30 },
    vagrant:   { weight: 0.5, min: 0.50 },
  };

  let session = null, data = null, loading = null;

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} konnte nicht geladen werden (${res.status})`);
    return res.json();
  }

  /** Modelldatei mit Fortschrittsanzeige laden */
  async function fetchWithProgress(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Modell konnte nicht geladen werden (${res.status})`);
    const total = Number(res.headers.get("content-length")) || 0;
    if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const buf = new Uint8Array(total);
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > buf.length) { // falls komprimiert übertragen: dynamisch wachsen
        const bigger = new Uint8Array(Math.max(buf.length * 2, got + value.length));
        bigger.set(buf.subarray(0, got));
        return finishGrow(reader, bigger, got, value, onProgress, total);
      }
      buf.set(value, got);
      got += value.length;
      onProgress(Math.min(1, got / total));
    }
    return buf.subarray(0, got);
  }

  async function finishGrow(reader, buf, got, value, onProgress, total) {
    buf.set(value, got); got += value.length;
    for (;;) {
      const { done, value: v } = await reader.read();
      if (done) break;
      if (got + v.length > buf.length) {
        const bigger = new Uint8Array(buf.length * 2); bigger.set(buf.subarray(0, got)); buf = bigger;
      }
      buf.set(v, got); got += v.length;
      onProgress(Math.min(1, got / total));
    }
    return buf.subarray(0, got);
  }

  function load(onProgress = () => {}) {
    if (!loading) {
      loading = (async () => {
        const [labels, europe, regional, escapes] = await Promise.all([
          fetchJSON("data/insekten/labels.json"), fetchJSON("data/insekten/europe.json"),
          fetchJSON("data/insekten/regional.json"), fetchJSON("data/insekten/escapes.json"),
        ]);
        data = { labels, europe, europeSet: new Set(europe), regional, escapes };
        ort.env.wasm.wasmPaths = new URL("vendor/ort/", document.baseURI).href;
        ort.env.wasm.numThreads = 1; // GitHub Pages erlaubt keine Threads (fehlende Header)
        const bytes = await fetchWithProgress(window.INSECT_MODEL_URL || "model-insekten/insekten.onnx", onProgress);
        session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
      })().catch((e) => { loading = null; throw e; });
    }
    return loading;
  }

  function localSpecies(lat, lon) {
    const { points, masks } = data.regional;
    let best = -1, bestDist = Infinity;
    points.forEach(([plat, plon], i) => {
      const d = Math.hypot((plon - lon) * Math.cos((lat * Math.PI) / 180) * 111, (plat - lat) * 111);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    if (best < 0 || bestDist > 300) return null;
    const bits = Uint8Array.from(atob(masks[best][new Date().getMonth()]), (c) => c.charCodeAt(0));
    const set = new Set();
    data.europe.forEach((idx, i) => { if (bits[i >> 3] & (1 << (i & 7))) set.add(idx); });
    return set;
  }

  function categorize(idx, sci, local) {
    if (local && local.size) {
      if (local.has(idx)) return "expected";
      if (data.europeSet.has(idx)) return "rare_here";
    } else if (data.europeSet.has(idx)) {
      return "expected";
    }
    return data.escapes.includes(sci) ? "escape" : "vagrant";
  }

  async function analyze(blob, { lat = null, lon = null, exotics = true, onProgress = () => {} } = {}) {
    await load();
    const samples = await BirdNET.decode(blob, SAMPLE_RATE);
    if (samples.length < SAMPLE_RATE / 2) throw new Error("Die Aufnahme ist zu kurz (mindestens 1 Sekunde).");
    const local = lat != null && lon != null ? localSpecies(lat, lon) : null;

    const starts = [];
    for (let s = 0; s === 0 || s + SAMPLE_RATE <= samples.length; s += HOP) starts.push(s);

    const best = new Map();
    for (let n = 0; n < starts.length; n += BATCH) {
      const batch = starts.slice(n, n + BATCH);
      const input = new Float32Array(batch.length * SEGMENT);
      batch.forEach((s, k) => input.set(samples.subarray(s, s + SEGMENT), k * SEGMENT));
      const out = await session.run({ input: new ort.Tensor("float32", input, [batch.length, SEGMENT]) });
      const probs = out.predictions.data, C = out.predictions.dims[1];
      batch.forEach((s, k) => {
        for (let i = 0; i < C; i++) {
          const p = probs[k * C + i];
          if (p < MIN_CONF) continue;
          const b = best.get(i) || { conf: 0, at: 0, detections: 0 };
          if (p >= 0.25) b.detections++;
          if (p > b.conf) { b.conf = p; b.at = s / SAMPLE_RATE; }
          best.set(i, b);
        }
      });
      onProgress(Math.min(1, (n + batch.length) / starts.length));
      await new Promise((r) => setTimeout(r, 0)); // Oberfläche aktualisieren lassen
    }

    const found = [], noises = [];
    for (const [idx, b] of best) {
      const [sci, name, group] = data.labels[idx];
      if (group !== "Insecta") {
        if (b.conf >= 0.25) noises.push({ name, confidence: b.conf * 100 });
        continue;
      }
      const category = categorize(idx, sci, local);
      if (!exotics && (category === "escape" || category === "vagrant")) continue;
      if (b.conf < CATEGORIES[category].min) continue;
      found.push({
        scientific: sci, name, category, confidence: Math.round(b.conf * 1000) / 10,
        best_at: b.at, detections: b.detections, score: b.conf * CATEGORIES[category].weight,
      });
    }
    found.sort((a, b) => b.score - a.score);
    noises.sort((a, b) => b.confidence - a.confidence);
    return {
      results: found.slice(0, 6), noises,
      filter: local && local.size ? "regional" : "europe",
      species_count: local && local.size ? local.size : data.europe.length,
      duration: samples.length / SAMPLE_RATE,
    };
  }

  return { load, analyze };
})();
