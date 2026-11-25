"""Verkleinert das offizielle BirdNET-TF.js-Modell (float32) auf float16-Gewichte (51 -> 26 MB).

Quelle: https://zenodo.org/records/15050749/files/BirdNET_v2.4_tfjs.zip
Aufruf: python tools/quantize_model.py <entpackter_ordner>/model  model
"""

import json
import sys
from pathlib import Path

import numpy as np

SHARD_BYTES = 4 * 1024 * 1024


def main(src: Path, dst: Path) -> None:
    meta = json.loads((src / "model.json").read_text())
    group = meta["weightsManifest"][0]
    raw = b"".join((src / p).read_bytes() for p in group["paths"])

    out, offset, weights = bytearray(), 0, []
    for w in group["weights"]:
        n = int(np.prod(w["shape"])) if w["shape"] else 1
        arr = np.frombuffer(raw, dtype="<f4", count=n, offset=offset)
        offset += n * 4
        out += arr.astype("<f2").tobytes()
        weights.append({**w, "quantization": {"dtype": "float16", "original_dtype": "float32"}})
    assert offset == len(raw), "Gewichte passen nicht zur Manifest-Beschreibung"

    dst.mkdir(parents=True, exist_ok=True)
    for old in dst.glob("*.bin"):
        old.unlink()
    n_shards = -(-len(out) // SHARD_BYTES)
    paths = []
    for i in range(n_shards):
        name = f"group1-shard{i + 1}of{n_shards}.bin"
        (dst / name).write_bytes(out[i * SHARD_BYTES:(i + 1) * SHARD_BYTES])
        paths.append(name)

    meta["weightsManifest"] = [{"paths": paths, "weights": weights}]
    (dst / "model.json").write_text(json.dumps(meta, separators=(",", ":")))
    print(f"{len(raw) / 1e6:.1f} MB -> {len(out) / 1e6:.1f} MB in {n_shards} Dateien")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
