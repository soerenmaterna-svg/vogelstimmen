"use strict";
/*
 * Mikrofon-Wegweiser: erkennt grob das Gerät und zeigt beim Aufnehmen mit einem Pfeil,
 * welche Seite zum Vogel zeigen soll. Dreht die Anzeige automatisch um 180°, wenn das
 * Handy "kopfüber" gehalten wird (Mikrofon nach vorne/oben), damit man sie lesen kann.
 *
 * Hinweis: Browser verraten die genaue Lage des Mikrofons nicht. Wir verwenden die
 * typische Lage je Gerätetyp (Handys: unten an der Ladebuchse; Tablets/Laptops: oben).
 */

const MicGuide = (() => {
  const BRANDS = [
    [/^SM-|Galaxy/i, "Samsung Galaxy"], [/Pixel/i, "Google Pixel"], [/^(M\d{4}|2\d{3}|Redmi|POCO|Mi )/i, "Xiaomi"],
    [/OnePlus|^(CPH|NE|LE|KB|IN|HD|GM)\d{4}/i, "OnePlus / Oppo"], [/moto/i, "Motorola"], [/Nokia/i, "Nokia"],
    [/^(VOG|ELE|ANA|LYA|NOH|JAD|MAR|HUAWEI)/i, "Huawei"], [/^(XQ-|SO-)/i, "Sony Xperia"], [/^(RMX|realme)/i, "realme"],
    [/Fairphone|^FP\d/i, "Fairphone"], [/^(V2\d{3}|vivo)/i, "vivo"],
  ];

  function brandName(model) {
    if (!model) return null;
    if (/^Pixel/i.test(model)) return `Google ${model}`;
    const hit = BRANDS.find(([re]) => re.test(model));
    return hit ? `${hit[1]} (${model})` : model;
  }

  /** -> { type, name, edge: "bottom"|"top", where, canFlip } */
  async function detect() {
    const ua = navigator.userAgent;
    const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    if (/iPhone|iPod/.test(ua)) {
      return { type: "phone", name: "iPhone", edge: "bottom", canFlip: true,
        where: "unten, neben der Ladebuchse" };
    }
    if (/iPad/.test(ua) || iPadOS) {
      return { type: "tablet", name: "iPad", edge: "top", canFlip: true,
        where: "am oberen Rand, bei der Frontkamera" };
    }
    if (/Android/.test(ua)) {
      let model = (ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|[;)])/) || [])[1];
      if (!model || model === "K") {
        try { model = (await navigator.userAgentData?.getHighEntropyValues(["model"]))?.model || null; } catch { /* egal */ }
      }
      const mobile = /Mobile/.test(ua) || navigator.userAgentData?.mobile;
      if (mobile) {
        return { type: "phone", name: brandName(model) || "Android-Handy", edge: "bottom", canFlip: true,
          where: "unten, neben der Ladebuchse" };
      }
      return { type: "tablet", name: brandName(model) || "Android-Tablet", edge: "top", canFlip: true,
        where: "meist am oberen Rand" };
    }
    const os = /Windows/.test(ua) ? "Windows-PC" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Computer" : "Gerät";
    return { type: "desktop", name: os, edge: "top", canFlip: false,
      where: "meist über dem Bildschirm, neben der Kamera (oder am externen Mikrofon)" };
  }

  // ---------- Vollbild während Aufnahme und Analyse ----------
  // Alles Wichtige steht zweimal da: unten richtig herum, oben auf dem Kopf. So ist es
  // immer lesbar, egal wie das Handy gehalten wird – ohne auf Lagesensoren angewiesen zu sein.
  const overlay = document.getElementById("recOverlay");
  const halves = [...overlay.querySelectorAll(".ro-half")];
  const SIDES = ["top", "right", "bottom", "left"]; // im Uhrzeigersinn
  let device = null, active = false, onButton = null;

  const ready = detect().then((d) => {
    device = d;
    document.getElementById("deviceHint").innerHTML =
      `${d.type === "desktop" ? "💻" : "📱"} <b></b>: Mikrofon ${d.where}. Beim Aufnehmen zeigt dir ein Pfeil, welche Seite zum Vogel zeigen soll.`;
    document.querySelector("#deviceHint b").textContent = d.name;
    return d;
  });

  /** Wie weit hat das Betriebssystem die Anzeige gedreht? 0, 90, 180 oder 270 Grad */
  function screenAngle() {
    let a = screen.orientation?.angle;
    if (a == null) a = window.orientation ?? 0; // ältere iPhones/iPads
    return ((Math.round(a / 90) * 90) % 360 + 360) % 360;
  }

  /** Pfeil an die Bildschirmseite setzen, an der das Mikrofon tatsächlich sitzt */
  function placeArrow() {
    if (!device) return;
    const side = SIDES[(SIDES.indexOf(device.edge) - screenAngle() / 90 + 8) % 4];
    for (const s of SIDES) overlay.classList.toggle(`side-${s}`, s === side);
  }

  function each(sel, fn) { halves.forEach((h) => fn(h.querySelector(sel), h)); }

  function setButton(label, show, kind) {
    each(".ro-btn", (b) => {
      b.hidden = !show;
      b.className = "ro-btn " + (kind === "stop" ? "rec recording" : "primary");
      b.querySelector(".ro-btn-label").textContent = label;
      b.querySelector(".dot").hidden = kind !== "stop";
    });
  }

  /** Aufnahme-Ansicht öffnen. onStop wird beim Tippen auf "Aufnahme beenden" aufgerufen */
  async function show(onStop) {
    const d = device || await ready;
    unflipPage();
    overlay.classList.toggle("single", d.type === "desktop"); // am Computer reicht eine Hälfte
    each(".ro-device", (el) => { el.textContent = `${d.type === "desktop" ? "💻" : "📱"} ${d.name}`; });
    each(".ro-status", (el) => { el.textContent = "Der Pfeil zeigt zum Mikrofon – diese Seite zum Vogel halten."; });
    each(".ro-timer", (el) => { el.hidden = false; el.textContent = "0:00"; });
    each(".ro-result", (el) => { el.hidden = true; el.textContent = ""; });
    setButton("Aufnahme beenden", true, "stop");
    onButton = () => onStop?.();
    placeArrow();
    overlay.classList.remove("done");
    overlay.hidden = false;
    active = true;
    document.body.classList.add("no-scroll");
    screen.orientation?.addEventListener?.("change", placeArrow);
    window.addEventListener("orientationchange", placeArrow);
    window.addEventListener("resize", placeArrow);
  }

  halves.forEach((h) => h.querySelector(".ro-btn").addEventListener("click", () => {
    const fn = onButton;
    onButton = null;
    fn?.(h.classList.contains("upside") ? "upside" : "upright");
  }));

  function setTimer(text) { each(".ro-timer", (el) => { el.textContent = text; }); }

  /** Während der Analyse: Statuszeile in beiden Hälften */
  function setStatus(text) {
    if (!active) return;
    each(".ro-timer", (el) => { el.hidden = true; });
    each(".ro-status", (el) => { el.textContent = text; });
    setButton("", false);
  }

  /**
   * Ergebnis kurz in beiden Hälften zeigen. Löst auf, sobald in einer Hälfte auf
   * "Ergebnis anzeigen" getippt wird – mit der Richtung dieser Hälfte ("upright"/"upside").
   */
  function finish(statusText, resultText, buttonLabel = "Ergebnis anzeigen") {
    if (!active) return Promise.resolve("upright");
    overlay.classList.add("done");
    each(".ro-timer", (el) => { el.hidden = true; });
    each(".ro-status", (el) => { el.textContent = statusText; });
    each(".ro-result", (el) => { el.hidden = !resultText; el.textContent = resultText || ""; });
    setButton(buttonLabel, true, "go");
    return new Promise((resolve) => { onButton = resolve; });
  }

  function hide() {
    overlay.hidden = true;
    active = false;
    onButton = null;
    document.body.classList.remove("no-scroll");
    screen.orientation?.removeEventListener?.("change", placeArrow);
    window.removeEventListener("orientationchange", placeArrow);
    window.removeEventListener("resize", placeArrow);
  }

  const isActive = () => active;

  /** Muss direkt im Klick-Handler aufgerufen werden (iOS fragt sonst nicht nach der Erlaubnis) */
  function requestSensor() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      return DOE.requestPermission().catch(() => "denied");
    }
    return Promise.resolve("granted");
  }

  // ---------- Ergebnisseite auf dem Kopf (wenn in der gedrehten Hälfte getippt wurde) ----------
  function flipPage() {
    document.body.classList.add("page-flipped");
    document.querySelector("main").scrollTop = 0;
    window.addEventListener("deviceorientation", onPageOrientation);
    screen.orientation?.addEventListener?.("change", unflipPage);
  }

  function unflipPage() {
    if (!document.body.classList.contains("page-flipped")) return;
    const main = document.querySelector("main");
    const anchor = [...main.querySelectorAll("#status, #results")].find((el) => !el.hidden);
    document.body.classList.remove("page-flipped");
    window.removeEventListener("deviceorientation", onPageOrientation);
    screen.orientation?.removeEventListener?.("change", unflipPage);
    anchor?.scrollIntoView({ block: "start" });
  }

  // Zurückdrehen, sobald die Oberkante des Handys deutlich nach oben zeigt
  function onPageOrientation(e) {
    if (e.beta == null) return;
    const up = Math.sin((e.beta * Math.PI) / 180); // Anteil "Oberkante oben"
    if (up > 0.5) unflipPage();
  }

  document.getElementById("unflipBtn").addEventListener("click", unflipPage);
  const isPageFlipped = () => document.body.classList.contains("page-flipped");

  return { ready, show, hide, finish, setStatus, setTimer, isActive, requestSensor, flipPage, unflipPage, isPageFlipped };
})();
