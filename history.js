"use strict";
/*
 * Verlauf ("Meine Funde"): speichert Aufnahmen, Ergebnisse, Fundort, Notizen und
 * bestätigte Sichtungen in der IndexedDB des Browsers – nur auf diesem Gerät.
 */

const History = (() => {
  const DB_NAME = "vogelstimmen", STORE = "entries";
  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
          store.createIndex("created", "created");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      // Browser bitten, die Daten nicht automatisch zu löschen
      navigator.storage?.persist?.().catch(() => {});
    }
    return dbPromise;
  }

  async function run(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  const add = (entry) => run("readwrite", (s) => s.add(entry));
  const put = (entry) => run("readwrite", (s) => s.put(entry));
  const get = (id) => run("readonly", (s) => s.get(id));
  const remove = (id) => run("readwrite", (s) => s.delete(id));
  const count = () => run("readonly", (s) => s.count());
  const clear = () => run("readwrite", (s) => s.clear());
  async function all() {
    const list = await run("readonly", (s) => s.getAll());
    return list.sort((a, b) => b.created - a.created);
  }

  /** Ortsname zu Koordinaten über OpenStreetMap (Nominatim); null, wenn offline/fehlgeschlagen */
  async function placeName(lat, lon) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=de&lat=${lat}&lon=${lon}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const a = (await res.json()).address || {};
      const local = a.village || a.town || a.city || a.municipality || a.suburb || a.hamlet;
      const region = a.county || a.state;
      return [local, region && region !== local ? region : null].filter(Boolean).join(", ") || null;
    } catch {
      return null;
    }
  }

  function csvCell(v) {
    const s = v == null ? "" : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** Alle Funde als CSV (eine Zeile pro erkannter Art), für Excel mit Semikolon */
  async function toCSV() {
    const rows = [["Datum", "Uhrzeit", "Fundort", "Breite", "Länge", "Art", "Wissenschaftlicher Name",
      "Sicherheit (%)", "Gesehen", "Notiz"]];
    for (const e of await all()) {
      const d = new Date(e.created);
      const base = [d.toLocaleDateString("de-DE"), d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }),
        e.place || "", e.lat?.toFixed(5) ?? "", e.lon?.toFixed(5) ?? ""];
      const species = e.results.length ? e.results : [{ name: "(kein Vogel erkannt)", scientific: "", confidence: "" }];
      for (const r of species) {
        rows.push([...base, r.name, r.scientific, String(r.confidence).replace(".", ","),
          e.confirmed.includes(r.scientific) ? "ja" : "", e.note || ""]);
      }
    }
    return "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\n");
  }

  return { add, put, get, remove, clear, all, count, placeName, toCSV };
})();
