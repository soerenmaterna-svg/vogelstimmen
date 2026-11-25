"""Zählt für jede Insektenart im Modell die Fundmeldungen in Europa (GBIF) -> data/insekten/gbif_europa.json.

Wird von build_insects.py genutzt, um die Europa-Liste zu ergänzen: Das Verbreitungsmodell kennt
für viele Insekten zu wenige Daten, GBIF-Fundmeldungen zeigen zuverlässig, was in Europa vorkommt.
Aufruf: python tools/gbif_europe_counts.py
"""

import json
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DATA = Path(__file__).parent.parent / "data" / "insekten"


def get(url: str, tries: int = 5) -> dict:
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except OSError:
            if attempt == tries - 1:
                raise
            time.sleep(2 ** attempt)


def count(sci: str) -> int:
    m = get("https://api.gbif.org/v1/species/match?" + urllib.parse.urlencode({"name": sci, "class": "Insecta"}))
    key = m.get("usageKey") if m.get("matchType") in ("EXACT", "FUZZY") else None
    if not key:
        return 0
    q = urllib.parse.urlencode({"taxonKey": key, "continent": "EUROPE", "limit": 0})
    return get("https://api.gbif.org/v1/occurrence/search?" + q).get("count", 0)


def main() -> None:
    labels = json.loads((DATA / "labels.json").read_text(encoding="utf-8"))
    names = [l[0] for l in labels if l[2] == "Insecta"]
    with ThreadPoolExecutor(4) as ex:
        counts = dict(zip(names, ex.map(count, names)))
    (DATA / "gbif_europa.json").write_text(json.dumps(counts, indent=0, ensure_ascii=False))
    print(sum(1 for c in counts.values() if c >= 20), "Arten mit >= 20 Fundmeldungen in Europa")


if __name__ == "__main__":
    main()
