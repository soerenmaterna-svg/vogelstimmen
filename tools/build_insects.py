"""Erzeugt Modell und Daten für den Heuschrecken-/Insekten-Modus (BirdNET+ V3.0, Apache 2.0).

Quellen (https://zenodo.org/records/24362980):
  BirdNET+_V3.0_Global_12K_FP16_pruned.onnx   Erkennungsmodell (Audio, 32 kHz, 3 s)
  BirdNET+_V3.0_Global_12K_Labels.csv         Artenliste mit deutschen Namen
  BirdNET+_Geomodel_V3.0.5_Global_14K.zip     Verbreitungsmodell (Breite, Länge, Woche)

Ergebnis:
  model-insekten/insekten.onnx   Erkennungsmodell, Ausgabe auf Insekten (+ Störgeräusche) gekürzt
  data/insekten/labels.json      [wiss. Name, deutscher Name, Gruppe] je Modell-Ausgabe
  data/insekten/europe.json      Indizes der Insekten, die in Europa vorkommen
  data/insekten/regional.json    Raster über Europa: Vorkommen je Monat (Bitmasken)
  data/insekten/escapes.json     Futter-/Terrarieninsekten, die entkommen können

Vorher: python tools/gbif_europe_counts.py (ergänzt die Europa-Liste um GBIF-Fundmeldungen)

Aufruf:
  python tools/build_insects.py <pruned.onnx> <labels.csv> <geomodel_fp32.onnx> <geo_labels.csv>
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
DATA = ROOT / "data" / "insekten"
MODEL_DIR = ROOT / "model-insekten"
GEO_MIN_CONF = 0.05
KEEP_GROUPS = {"Insecta", "Anthropogenic"}

# Insekten aus Zoohandel/Terraristik (Futtergrillen), die in Europa entkommen können
ESCAPES = ["Gryllus assimilis", "Gryllodes sigillatus", "Gryllus bimaculatus", "Acheta domesticus"]
# Mindestzahl an GBIF-Fundmeldungen in Europa (tools/gbif_europe_counts.py)
GBIF_MIN = 20
# offensichtliche Fehlmeldungen / nicht europäische Arten
NOT_EUROPE = {"Gryllus firmus", "Gryllus assimilis", "Bombus impatiens"}


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


def main(model: Path, labels_csv: Path, geo_model: Path, geo_labels_csv: Path) -> None:
    rows = list(csv.DictReader(labels_csv.open(encoding="utf-8")))
    keep = [i for i, r in enumerate(rows) if r["taxon_group"] in KEEP_GROUPS]
    labels = [[rows[i]["scientific_name"], german_name(rows[i]), rows[i]["taxon_group"]] for i in keep]

    # Verbreitung: welche Insekten kommen wo in Europa in welchem Monat vor?
    geo_rows = list(csv.DictReader(geo_labels_csv.open(encoding="utf-8")))
    geo_index = {r["scientific_name"]: n for n, r in enumerate(geo_rows)}
    sess = ort.InferenceSession(str(geo_model), providers=["CPUExecutionProvider"])
    points = sorted(set(grid()))
    insect_pos = [(k, geo_index.get(l[0])) for k, l in enumerate(labels) if l[2] == "Insecta"]
    presence = np.zeros((len(points), 12, len(labels)), dtype=bool)
    for p, (lat, lon) in enumerate(points):
        x = np.array([[lat, lon, w] for w in range(1, 49)], dtype=np.float32)
        probs = sess.run(None, {"input": x})[0]  # [48, Arten]
        for k, g in insect_pos:
            if g is None:
                continue
            weekly = probs[:, g] >= GEO_MIN_CONF
            presence[p, :, k] = weekly.reshape(12, 4).any(axis=1)
    gbif_file = DATA / "gbif_europa.json"
    gbif = json.loads(gbif_file.read_text(encoding="utf-8")) if gbif_file.exists() else {}
    europe = [k for k in range(len(labels))
              if labels[k][2] == "Insecta" and labels[k][0] not in NOT_EUROPE
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

    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "labels.json").write_text(json.dumps(labels, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (DATA / "europe.json").write_text(json.dumps(europe))
    (DATA / "regional.json").write_text(json.dumps({"points": points, "masks": masks}, separators=(",", ":")))
    (DATA / "escapes.json").write_text(json.dumps(ESCAPES))
    (DATA / "europa_insekten.txt").write_text(
        "\n".join(f"{labels[k][0]}_{labels[k][1]}" for k in europe) + "\n", encoding="utf-8")

    prune_model(model, MODEL_DIR / "insekten.onnx", keep)
    size = (MODEL_DIR / "insekten.onnx").stat().st_size / 1e6
    print(f"{len(labels)} Klassen im Modell ({size:.1f} MB), {len(europe)} Insekten in Europa, {len(points)} Rasterpunkte")


if __name__ == "__main__":
    main(*(Path(a) for a in sys.argv[1:5]))
