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

  // ---------- PDF-Export (jsPDF wird erst beim Exportieren geladen) ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src; el.onload = resolve; el.onerror = () => reject(new Error(`${src} konnte nicht geladen werden`));
      document.head.appendChild(el);
    });
  }

  let pdfLib = null;
  function loadPDFLib() {
    if (!pdfLib) {
      pdfLib = loadScript("vendor/pdf/jspdf.umd.min.js")
        .then(() => loadScript("vendor/pdf/jspdf.plugin.autotable.min.js"))
        .catch((e) => { pdfLib = null; throw e; });
    }
    return pdfLib;
  }

  /** Alle Funde als PDF-Tabelle (ein Fund pro Zeile) herunterladen */
  async function savePDF() {
    await loadPDFLib();
    const entries = await all();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const today = new Date();
    doc.setFont("helvetica", "bold"); doc.setFontSize(16);
    doc.text("Meine Funde", 14, 16);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100);
    doc.text(`${entries.length} Funde · erstellt am ${today.toLocaleDateString("de-DE")} um ` +
      `${today.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr`, 14, 22);

    const body = entries.map((e, i) => {
      const d = new Date(e.created);
      // bestätigte Arten zuerst, dann die übrigen; jede Art in einer eigenen Zeile
      const sorted = [...e.results].sort((a, b) =>
        (e.confirmed.includes(b.scientific) - e.confirmed.includes(a.scientific)) || b.confidence - a.confidence);
      const species = sorted.length
        ? sorted.map((r) => `${r.name}  ${Math.round(r.confidence)} %${e.confirmed.includes(r.scientific) ? "  – gesehen" : ""}`).join("\n")
        : "(nichts erkannt)";
      const place = e.place || (e.lat != null ? `${e.lat.toFixed(5)}, ${e.lon.toFixed(5)}` : "–");
      return [String(entries.length - i), d.toLocaleDateString("de-DE"),
        d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }),
        e.mode === "insekten" ? "Insekten" : "Vögel", species, place, e.note || ""];
    });

    doc.autoTable({
      startY: 27,
      head: [["Nr.", "Datum", "Uhrzeit", "Gruppe", "Erkannt (Sicherheit)", "Fundort", "Notiz"]],
      body,
      theme: "grid",
      styles: { font: "helvetica", fontSize: 9, cellPadding: 2, valign: "top", lineColor: [210, 205, 190] },
      headStyles: { fillColor: [47, 93, 58], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [246, 243, 234] },
      columnStyles: {
        0: { cellWidth: 11, halign: "right" }, 1: { cellWidth: 22 }, 2: { cellWidth: 16 },
        3: { cellWidth: 18 }, 4: { cellWidth: 85 }, 5: { cellWidth: 60 }, 6: { cellWidth: "auto" },
      },
      didParseCell: (data) => { // bestätigte Sichtungen fett
        if (data.section === "body" && data.column.index === 4 && String(data.cell.raw).includes("gesehen")) {
          data.cell.styles.fontStyle = "bold";
        }
      },
      didDrawPage: () => {
        const n = doc.getNumberOfPages();
        doc.setFontSize(8); doc.setTextColor(140);
        doc.text(`Seite ${n}`, doc.internal.pageSize.getWidth() - 14, doc.internal.pageSize.getHeight() - 8, { align: "right" });
      },
    });
    doc.save(`meine-funde-${today.toISOString().slice(0, 10)}.pdf`);
  }

  return { add, put, get, remove, clear, all, count, placeName, savePDF };
})();
