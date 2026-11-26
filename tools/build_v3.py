"""Erzeugt Modell und Daten für den Heuschrecken- und den Amphibien-Modus (BirdNET+ V3.0, Apache 2.0).

Beide Modi nutzen ein gemeinsames Modell, dessen Ausgabe auf Insekten, Amphibien und
Störgeräusche gekürzt ist.

Quellen (https://zenodo.org/records/24362980):
  BirdNET+_V3.0_Global_12K_FP16_pruned.onnx   Erkennungsmodell (Audio, 32 kHz, 3 s)
  BirdNET+_V3.0_Global_12K_Labels.csv         Artenliste mit deutschen Namen
  BirdNET+_Geomodel_V3.0.5_Global_14K.zip     Verbreitungsmodell (Breite, Länge, Woche)

Ergebnis:
  model-v3/v3.onnx               Erkennungsmodell, Ausgabe gekürzt
  data/v3/labels.json            [wiss. Name, deutscher Name, Gruppe] je Modell-Ausgabe
  data/<gruppe>/europe.json      Indizes der Arten, die in Europa vorkommen
  data/<gruppe>/regional.json    Raster über Europa: Vorkommen je Monat (Bitmasken)
  data/<gruppe>/escapes.json     Arten aus Zoohandel/Terraristik, die entkommen/ausgesetzt sein können
  (<gruppe> = insekten, amphibien)

Ablauf:
  python tools/build_v3.py <pruned.onnx> <labels.csv> <geomodel_fp32.onnx> <geo_labels.csv>
  python tools/gbif_europe_counts.py insekten && python tools/gbif_europe_counts.py amphibien
  python tools/build_v3.py ...   (noch einmal, jetzt mit den GBIF-Zahlen)
"""

import base64
import csv
import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import numpy_helper

sys.path.insert(0, str(Path(__file__).parent))
from make_europe_list import grid  # noqa: E402  (gleiches Europa-Raster wie bei den Vögeln)

ROOT = Path(__file__).parent.parent
MODEL_DIR = ROOT / "model-v3"
GEO_MIN_CONF = 0.05
GBIF_MIN = 20  # Mindestzahl an GBIF-Fundmeldungen in Europa (tools/gbif_europe_counts.py)

GROUPS = {
    "insekten": {
        "taxon": "Insecta",
        # Futtergrillen aus Zoohandel/Terraristik, die entkommen können
        "escapes": ["Gryllus assimilis", "Gryllodes sigillatus", "Gryllus bimaculatus", "Acheta domesticus"],
        # offensichtliche Fehlmeldungen / nicht europäische Arten
        "not_europe": {"Gryllus firmus", "Gryllus assimilis", "Bombus impatiens"},
    },
    "amphibien": {
        "taxon": "Amphibia",
        # eingeschleppt bzw. aus Terrarien ausgesetzt
        "escapes": ["Lithobates catesbeianus", "Xenopus laevis", "Bombina orientalis",
                    "Polypedates leucomystax", "Eleutherodactylus johnstonei"],
        # Fundmeldungen in Europa nur aus Gewächshäusern/Terrarien
        "not_europe": {"Bombina orientalis", "Polypedates leucomystax", "Eleutherodactylus johnstonei"},
    },
}
KEEP_GROUPS = {g["taxon"] for g in GROUPS.values()} | {"Anthropogenic"}


def german_name(row: dict) -> str:
    return row.get("common_name_de") or row.get("common_name_en") or row["common_name"] or row["scientific_name"]


def prune_model(src: Path, dst: Path, keep: list[int]) -> None:
    """Gewichte der Ausgabeschicht auf die gewünschten Klassen kürzen (Sigmoid je Klasse,
    daher ändern sich die Werte der übrigen Klassen nicht)."""
    m = onnx.load(src)
    inits = {i.name: i for i in m.graph.initializer}
    for name in ("head.weight_stored_fp16", "head.bias"):
        arr = numpy_helper.to_array(inits[name])
        new = numpy_helper.from_array(arr[keep], name)
        inits[name].CopyFrom(new)
    # Konstanten, die die Klassenzahl tragen (z. B. Form der Summe über die Köpfe), anpassen
    n_classes = int(numpy_helper.to_array(inits["head.bias"]).shape[0])
    for init in m.graph.initializer:
        if init.data_type in (6, 7) and len(init.dims) <= 1:
            arr = numpy_helper.to_array(init)
            if arr.size == 1 and int(arr.ravel()[0]) == 11725:
                init.CopyFrom(numpy_helper.from_array(np.full_like(arr, n_classes), init.name))
    for out in m.graph.output:
        if out.name == "predictions":
            out.type.tensor_type.shape.dim[1].dim_value = len(keep)
    # Zwischenformen, die noch die alte Klassenzahl tragen, neu ableiten lassen
    del m.graph.value_info[:]
    dst.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(m, dst)


def build_group(name: str, cfg: dict, labels: list, presence: np.ndarray, points: list) -> int:
    data = ROOT / "data" / name
    data.mkdir(parents=True, exist_ok=True)
    gbif_file = data / "gbif_europa.json"
    gbif = json.loads(gbif_file.read_text(encoding="utf-8")) if gbif_file.exists() else {}
    europe = [k for k in range(len(labels))
              if labels[k][2] == cfg["taxon"] and labels[k][0] not in cfg["not_europe"]
              and (presence[:, :, k].any() or gbif.get(labels[k][0], 0) >= GBIF_MIN)]
    pos = {k: i for i, k in enumerate(europe)}
    masks = []
    for p in range(len(points)):
        months = []
        for mth in range(12):
            bits = bytearray(-(-len(europe) // 8))
            for k in europe:
                if presence[p, mth, k]:
                    i = pos[k]
                    bits[i // 8] |= 1 << (i % 8)
            months.append(base64.b64encode(bytes(bits)).decode())
        masks.append(months)
    (data / "europe.json").write_text(json.dumps(europe))
    (data / "regional.json").write_text(json.dumps({"points": points, "masks": masks}, separators=(",", ":")))
    (data / "escapes.json").write_text(json.dumps(cfg["escapes"]))
    (data / f"europa_{name}.txt").write_text(
        "\n".join(f"{labels[k][0]}_{labels[k][1]}" for k in europe) + "\n", encoding="utf-8")
    return len(europe)


def main(model: Path, labels_csv: Path, geo_model: Path, geo_labels_csv: Path) -> None:
    rows = list(csv.DictReader(labels_csv.open(encoding="utf-8")))
    keep = [i for i, r in enumerate(rows) if r["taxon_group"] in KEEP_GROUPS]
    labels = [[rows[i]["scientific_name"], german_name(rows[i]), rows[i]["taxon_group"]] for i in keep]
    (ROOT / "data" / "v3").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "v3" / "labels.json").write_text(
        json.dumps(labels, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # Verbreitung: welche Art kommt wo in Europa in welchem Monat vor?
    geo_rows = list(csv.DictReader(geo_labels_csv.open(encoding="utf-8")))
    geo_index = {r["scientific_name"]: n for n, r in enumerate(geo_rows)}
    sess = ort.InferenceSession(str(geo_model), providers=["CPUExecutionProvider"])
    points = sorted(set(grid()))
    taxa = {g["taxon"] for g in GROUPS.values()}
    geo_pos = [(k, geo_index.get(l[0])) for k, l in enumerate(labels) if l[2] in taxa]
    presence = np.zeros((len(points), 12, len(labels)), dtype=bool)
    for p, (lat, lon) in enumerate(points):
        x = np.array([[lat, lon, w] for w in range(1, 49)], dtype=np.float32)
        probs = sess.run(None, {"input": x})[0]  # [48 Wochen, Arten]
        for k, g in geo_pos:
            if g is not None:
                presence[p, :, k] = (probs[:, g] >= GEO_MIN_CONF).reshape(12, 4).any(axis=1)

    counts = {name: build_group(name, cfg, labels, presence, points) for name, cfg in GROUPS.items()}
    prune_model(model, MODEL_DIR / "v3.onnx", keep)
    size = (MODEL_DIR / "v3.onnx").stat().st_size / 1e6
    print(f"{len(labels)} Klassen im Modell ({size:.1f} MB); in Europa: {counts}; {len(points)} Rasterpunkte")


if __name__ == "__main__":
    main(*(Path(a) for a in sys.argv[1:5]))
