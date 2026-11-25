"""Erzeugt die Datendateien für die Browser-App in data/:

- labels.json    wissenschaftlicher + deutscher Name aller 6.522 BirdNET-Klassen
                 (gleiche Reihenfolge wie die Modell-Ausgabe)
- europe.json    Indizes der europäischen Arten (aus europa_arten.txt)
- regional.json  Raster über Europa: welche europäischen Arten an welchem Punkt
                 in welchem Monat vorkommen (BirdNET-Geomodell, als Bitmasken)
- escapes.json   Gefangenschaftsflüchtlinge (aus gefangenschaftsfluechtlinge.txt)

Aufruf (mit installiertem 'birdnet' und 'ai-edge-litert'):  python tools/build_data.py
"""

import base64
import json
from pathlib import Path

import birdnet

from make_europe_list import grid

DATA = Path(__file__).parent.parent / "data"


def main() -> None:
    acoustic = birdnet.load("acoustic", "2.4", "tf", lang="de", library="litert")
    labels = [l.split("_", 1) for l in acoustic.species_list]
    (DATA / "labels.json").write_text(json.dumps(labels, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    index = {l: i for i, l in enumerate(acoustic.species_list)}
    europe = sorted(
        index[l.strip()] for l in (DATA / "europa_arten.txt").read_text(encoding="utf-8").splitlines() if l.strip()
    )
    (DATA / "europe.json").write_text(json.dumps(europe))
    pos = {idx: i for i, idx in enumerate(europe)}

    geo = birdnet.load("geo", "2.4", "tf", lang="de", library="litert")
    points = sorted(set(grid()))
    masks = []
    with geo.predict_session(min_confidence=0.05) as session:
        for lat, lon in points:
            months = []
            for month in range(12):  # BirdNET-Wochen 1-48, je 4 Wochen = 1 Monat
                present = set()
                for week in range(month * 4 + 1, month * 4 + 5):
                    present |= session.run(lat, lon, week=week).to_set()
                bits = bytearray(-(-len(europe) // 8))
                for l in present:
                    i = pos.get(index.get(l, -1))
                    if i is not None:
                        bits[i // 8] |= 1 << (i % 8)
                months.append(base64.b64encode(bytes(bits)).decode())
            masks.append(months)
    (DATA / "regional.json").write_text(json.dumps(
        {"points": points, "masks": masks}, separators=(",", ":")))

    escapes = [l.split("#")[0].strip() for l in
               (DATA / "gefangenschaftsfluechtlinge.txt").read_text(encoding="utf-8").splitlines()]
    (DATA / "escapes.json").write_text(json.dumps([e for e in escapes if e], ensure_ascii=False))
    print(f"{len(labels)} Klassen, {len(europe)} europäische Arten, {len(points)} Rasterpunkte")


if __name__ == "__main__":
    main()
