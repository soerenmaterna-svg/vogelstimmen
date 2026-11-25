"""Vogelstimmen-Erkennung – kleine Web-App auf Basis von BirdNET.

Start:  python app.py   ->  http://localhost:8000
"""

from __future__ import annotations

import asyncio
import datetime as dt
import shutil
import subprocess
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import birdnet
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE = Path(__file__).parent
STATIC = BASE / "static"

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB
MAX_DURATION_S = 300  # nur die ersten 5 Minuten werden analysiert

# BirdNET-Klassen, die keine Vögel sind
NON_BIRD = {
    "Dog", "Engine", "Environmental", "Fireworks", "Gun", "Human non-vocal",
    "Human vocal", "Human whistle", "Noise", "Power tools", "Siren",
}

MODELS: dict[str, object] = {}
EUROPE: set[str] = set()  # europäische Artenliste (europa_arten.txt)
ESCAPES: tuple[str, ...] = ()  # Gefangenschaftsflüchtlinge (gefangenschaftsfluechtlinge.txt)
LOCK = asyncio.Lock()  # Analysen nacheinander ausführen


@asynccontextmanager
async def lifespan(_: FastAPI):
    print("Lade BirdNET-Modelle (beim ersten Start werden ~120 MB heruntergeladen) …")
    MODELS["acoustic"] = birdnet.load("acoustic", "2.4", "tf", lang="de", library="litert")
    MODELS["geo"] = birdnet.load("geo", "2.4", "tf", lang="de", library="litert")
    europe_file = BASE / "europa_arten.txt"
    if not europe_file.exists():
        import make_europe_list
        make_europe_list.main()
    EUROPE.update(l.strip() for l in europe_file.read_text(encoding="utf-8").splitlines() if l.strip())
    global ESCAPES
    ESCAPES = load_escapes()
    print(f"{len(EUROPE)} europäische Arten, {len(ESCAPES)} Einträge Gefangenschaftsflüchtlinge geladen.")
    print("Modelle geladen.")
    yield


app = FastAPI(title="Vogelstimmen-Erkennung", lifespan=lifespan)


def to_wav(src: Path, dst: Path) -> None:
    """Beliebiges Audioformat (webm, m4a, mp3, ogg, wav …) in 48-kHz-Mono-WAV umwandeln."""
    cmd = [
        "ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src),
        "-t", str(MAX_DURATION_S), "-ac", "1", "-ar", "48000", str(dst),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0 or not dst.exists() or dst.stat().st_size < 1000:
        raise HTTPException(400, "Die Audiodatei konnte nicht gelesen werden.")


def split_label(label: str) -> tuple[str, str]:
    sci, _, common = label.partition("_")
    return sci, common or sci


def regional_species(lat: float, lon: float) -> set[str]:
    week = min(48, (dt.date.today().timetuple().tm_yday - 1) // 7 + 1)  # BirdNET-Woche 1–48
    return MODELS["geo"].predict(lat, lon, week=week).to_set()


# Kategorien: wie stark ein Treffer gewichtet wird und ab welcher Sicherheit er angezeigt wird.
# Ungewöhnliche Arten müssen deutlich sicherer erkannt werden, damit sie erscheinen.
CATEGORIES = {
    #             Gewicht fürs Ranking, Mindest-Sicherheit
    "expected":  (1.00, 0.10),  # kommt hier (bzw. in Europa) regulär vor
    "rare_here": (0.80, 0.25),  # europäische Art, aber hier/jetzt eher ungewöhnlich
    "escape":    (0.70, 0.30),  # bekannter Gefangenschaftsflüchtling
    "vagrant":   (0.50, 0.50),  # Art von außerhalb Europas -> möglicher Irrgast
}


def load_escapes() -> tuple[str, ...]:
    f = BASE / "gefangenschaftsfluechtlinge.txt"
    lines = (l.split("#")[0].strip() for l in f.read_text(encoding="utf-8").splitlines())
    return tuple(l for l in lines if l)


def is_escape(sci: str) -> bool:
    # Einträge sind Artnamen oder Gattungen ("Agapornis" passt auf alle Unzertrennlichen)
    return any(sci == e or sci.startswith(e + " ") for e in ESCAPES)


def categorize(label: str, sci: str, local: set[str] | None) -> str:
    if local is not None:
        if label in local:
            return "expected"
        if label in EUROPE:
            return "rare_here"
    elif label in EUROPE:
        return "expected"
    return "escape" if is_escape(sci) else "vagrant"


def analyze(wav: Path, lat: float | None, lon: float | None, exotics: bool) -> dict:
    # Ohne Standort gelten alle europäischen Arten als erwartet, mit Standort nur die,
    # die dort in der aktuellen Jahreszeit vorkommen.
    local = regional_species(lat, lon) if lat is not None and lon is not None else None

    if exotics:
        species_list = None  # alle ~6.500 Klassen zulassen, danach nach Kategorie bewerten
    else:
        species_list = set(local or EUROPE) | {
            l for l in MODELS["acoustic"].species_list if split_label(l)[0] in NON_BIRD
        }

    result = MODELS["acoustic"].predict(
        str(wav),
        top_k=10,
        overlap_duration_s=1.5,
        default_confidence_threshold=0.05,
        custom_species_list=species_list,
    )
    df = result.to_dataframe()

    birds: dict[str, dict] = {}
    noises: dict[str, float] = {}
    for row in df.itertuples(index=False):
        sci, common = split_label(row.species_name)
        conf = float(row.confidence)
        if sci in NON_BIRD:
            noises[common] = max(noises.get(common, 0.0), conf)
            continue
        b = birds.setdefault(sci, {
            "scientific": sci, "name": common, "confidence": 0.0, "detections": 0,
            "best_at": 0.0, "category": categorize(row.species_name, sci, local),
        })
        if conf >= 0.25:
            b["detections"] += 1
        if conf > b["confidence"]:
            b["confidence"] = conf
            b["best_at"] = float(row.start_time)

    shown = [b for b in birds.values() if b["confidence"] >= CATEGORIES[b["category"]][1]]
    shown.sort(key=lambda b: b["confidence"] * CATEGORIES[b["category"]][0], reverse=True)
    for b in shown:
        b["confidence"] = round(b["confidence"] * 100, 1)
    return {
        "results": shown[:6],
        "noises": [
            {"name": n, "confidence": round(c * 100, 1)}
            for n, c in sorted(noises.items(), key=lambda x: -x[1]) if c >= 0.25
        ],
        "filter": "regional" if local is not None else "europe",
        "species_count": len(local if local is not None else EUROPE),
        "exotics": exotics,
    }


@app.post("/api/analyze")
async def api_analyze(
    audio: UploadFile = File(...),
    lat: float | None = Form(None),
    lon: float | None = Form(None),
    exotics: bool = Form(True),
):
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / ("upload" + Path(audio.filename or "").suffix[:8])
        size = 0
        with src.open("wb") as f:
            while chunk := await audio.read(1 << 20):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "Datei zu groß (max. 50 MB).")
                f.write(chunk)
        wav = tmp / "audio.wav"
        await asyncio.to_thread(to_wav, src, wav)
        async with LOCK:
            return await asyncio.to_thread(analyze, wav, lat, lon, exotics)


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import argparse

    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg wird benötigt (z. B. 'brew install ffmpeg' oder 'apt install ffmpeg').")
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--ssl-certfile")
    p.add_argument("--ssl-keyfile")
    a = p.parse_args()
    uvicorn.run(app, host=a.host, port=a.port,
                ssl_certfile=a.ssl_certfile, ssl_keyfile=a.ssl_keyfile)
