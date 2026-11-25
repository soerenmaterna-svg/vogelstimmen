"""Setzt eine neue Versionsnummer an alle lokalen Dateien in index.html (z. B. style.css?v=...).

So laden Browser nach einer Änderung sicher die neuen Dateien statt alter aus dem Zwischenspeicher.
Aufruf vor jedem Hochladen:  python3 tools/version.py
"""

import re
import time
from pathlib import Path

INDEX = Path(__file__).parent.parent / "index.html"
version = time.strftime("%Y%m%d%H%M")
html = INDEX.read_text(encoding="utf-8")
html = re.sub(r'((?:src|href)="(?!https?:|#)[^"?]+\.(?:css|js|jpg|png|svg|webmanifest))(?:\?v=[^"]*)?"',
              rf'\1?v={version}"', html)
INDEX.write_text(html, encoding="utf-8")
print("Version", version)
