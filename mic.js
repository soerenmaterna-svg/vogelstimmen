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
  const flipBtn = document.getElementById("flipBtn");
  let device = null, flipped = false, manual = false, listening = false;

  const ready = detect().then((d) => {
    device = d;
    document.getElementById("deviceHint").innerHTML =
      `${d.type === "desktop" ? "💻" : "📱"} <b></b>: Mikrofon ${d.where}. Beim Aufnehmen zeigt dir ein Pfeil, welche Seite zum Vogel zeigen soll.`;
    document.querySelector("#deviceHint b").textContent = d.name;
    return d;
  });

  function setFlipped(on) {
    flipped = on;
    inner.classList.toggle("flipped", on);
  }

  // Lage des Geräts: beta ~ +90° aufrecht, ~0° flach, negativ = Oberkante zeigt nach unten
  function onOrientation(e) {
    if (manual || e.beta == null) return;
    // Nur bei Mikrofon unten: wird das Handy mit der Unterseite nach vorne/oben gehalten,
    // steht die Schrift für den Anwender auf dem Kopf -> Anzeige drehen
    if (device?.edge !== "bottom") return;
    if (e.beta < -12 && !flipped) setFlipped(true);
    else if (e.beta > 25 && flipped) setFlipped(false);
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
    overlay.classList.toggle("mic-top", d.edge === "top");
    overlay.classList.toggle("mic-bottom", d.edge === "bottom");
    document.getElementById("roDevice").textContent = `${d.type === "desktop" ? "💻" : "📱"} ${d.name}`;
    document.getElementById("roWhere").textContent = `Mikrofon ${d.where}`;
    document.getElementById("roHint").textContent = d.canFlip
      ? (d.edge === "bottom"
        ? "Halte diese Seite des Handys in Richtung Vogel. Die Anzeige dreht sich mit, damit du sie lesen kannst."
        : "Halte diese Seite des Geräts in Richtung Vogel.")
      : "Richte das Mikrofon auf den Vogel und sei möglichst leise.";
    flipBtn.hidden = !d.canFlip;
    manual = false;
    setFlipped(false);
    overlay.hidden = false;
    document.body.classList.add("no-scroll");
    if (d.canFlip && !listening) {
      window.addEventListener("deviceorientation", onOrientation);
      listening = true;
    }
  }

  function hide() {
    overlay.hidden = true;
    document.body.classList.remove("no-scroll");
    if (listening) { window.removeEventListener("deviceorientation", onOrientation); listening = false; }
  }

  flipBtn.addEventListener("click", () => { manual = true; setFlipped(!flipped); });

  return { ready, show, hide, requestSensor };
})();
