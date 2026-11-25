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

  // ---------- Vollbild-Anzeige während der Aufnahme ----------
  const overlay = document.getElementById("recOverlay");
  const inner = document.getElementById("roInner");
  const arrow = document.getElementById("roArrow");
  const flipBtn = document.getElementById("flipBtn");
  const SIDES = ["top", "right", "bottom", "left"]; // im Uhrzeigersinn
  let device = null, flipped = false, manual = false, listening = false;

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

  /**
   * Pfeil an die Bildschirmseite setzen, an der das Mikrofon tatsächlich sitzt.
   * Dreht das Gerät die Anzeige um a Grad (Querformat, kopfüber), wandert die
   * Mikrofon-Seite auf dem Bildschirm entsprechend mit.
   */
  function update() {
    if (!device) return;
    const a = screenAngle();
    const deviceSide = SIDES.indexOf(device.edge);
    const side = SIDES[(deviceSide - a / 90 + 8) % 4];
    if (a !== 0 && !manual) flipped = false; // das Betriebssystem hat schon gedreht
    for (const s of SIDES) {
      overlay.classList.toggle(`side-${s}`, s === side);
    }
    inner.classList.toggle("flipped", flipped);
    arrow.classList.toggle("flipped", flipped);
  }

  // Lage des Geräts: beta ~ +90° aufrecht, ~0° flach, negativ = Oberkante zeigt nach unten.
  // Bleibt die Anzeige im Hochformat stehen (z. B. Drehsperre, iPhone kopfüber), drehen
  // wir den Inhalt selbst um 180°, damit man ihn lesen kann. Der Pfeil bleibt dabei am Mikrofon.
  function onOrientation(e) {
    if (manual || e.beta == null || screenAngle() !== 0) return;
    if (e.beta < -12 && !flipped) { flipped = true; update(); }
    else if (e.beta > 25 && flipped) { flipped = false; update(); }
  }

  /** Muss direkt im Klick-Handler aufgerufen werden (iOS fragt sonst nicht nach der Erlaubnis) */
  function requestSensor() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      return DOE.requestPermission().catch(() => "denied");
    }
    return Promise.resolve("granted");
  }

  async function show() {
    const d = device || await ready;
    document.getElementById("roDevice").textContent = `${d.type === "desktop" ? "💻" : "📱"} ${d.name}`;
    document.getElementById("roWhere").textContent = `Mikrofon ${d.where}`;
    document.getElementById("roHint").textContent = d.canFlip
      ? "Halte die Seite, auf die der Pfeil zeigt, in Richtung Vogel. Der Pfeil zeigt immer zum Mikrofon – auch wenn du das Gerät drehst."
      : "Richte das Mikrofon auf den Vogel und sei möglichst leise.";
    flipBtn.hidden = !d.canFlip;
    manual = false;
    flipped = false;
    update();
    overlay.hidden = false;
    document.body.classList.add("no-scroll");
    if (!listening) {
      if (d.canFlip) window.addEventListener("deviceorientation", onOrientation);
      screen.orientation?.addEventListener?.("change", update);
      window.addEventListener("orientationchange", update);
      window.addEventListener("resize", update);
      listening = true;
    }
  }

  function hide() {
    overlay.hidden = true;
    document.body.classList.remove("no-scroll");
    if (listening) {
      window.removeEventListener("deviceorientation", onOrientation);
      screen.orientation?.removeEventListener?.("change", update);
      window.removeEventListener("orientationchange", update);
      window.removeEventListener("resize", update);
      listening = false;
    }
  }

  flipBtn.addEventListener("click", () => { manual = true; flipped = !flipped; update(); });

  return { ready, show, hide, requestSensor };
})();
