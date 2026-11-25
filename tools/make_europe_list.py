"""Erzeugt europa_arten.txt: alle Arten, die laut BirdNET-Geomodell irgendwo in Europa
(Island bis Ural, Nordkap bis Mittelmeer) im Jahresverlauf vorkommen.

Start:  python make_europe_list.py
"""

from pathlib import Path

OUT = Path(__file__).parent.parent / "data" / "europa_arten.txt"

# grobe Umrisse Europas als (lat_min, lat_max, lon_min, lon_max)-Rechtecke
BOXES = [
    (36.0, 44.0, -9.5, 3.5),    # Iberische Halbinsel
    (42.0, 51.5, -5.0, 8.0),    # Frankreich, Benelux
    (37.0, 47.0, 7.0, 19.0),    # Italien, Alpen
    (46.0, 55.0, 6.0, 24.0),    # Mitteleuropa
    (35.0, 46.0, 19.0, 29.0),   # Balkan, Griechenland
    (50.0, 59.0, -10.0, 2.0),   # Britische Inseln
    (54.0, 71.0, 5.0, 31.0),    # Skandinavien, Finnland, Baltikum
    (44.0, 60.0, 24.0, 50.0),   # Osteuropa bis Ural
    (63.5, 66.5, -24.0, -13.5), # Island
]
STEP = 2.0


def grid():
    for lat0, lat1, lon0, lon1 in BOXES:
        lat = lat0
        while lat <= lat1:
            lon = lon0
            while lon <= lon1:
                yield round(lat, 2), round(lon, 2)
                lon += STEP
            lat += STEP


def build() -> set[str]:
    import birdnet

    geo = birdnet.load("geo", "2.4", "tf", lang="de", library="litert")
    species: set[str] = set()
    points = sorted(set(grid()))
    with geo.predict_session(min_confidence=0.05) as session:
        for lat, lon in points:
            species |= session.run(lat, lon).to_set()  # week=None -> ganzjährig
    return species


def main() -> None:
    species = build()
    OUT.write_text("\n".join(sorted(species)) + "\n", encoding="utf-8")
    print(f"{len(species)} Arten -> {OUT}")


if __name__ == "__main__":
    main()
