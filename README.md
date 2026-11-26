# 🐦 Vogelstimmen-Erkennung

**➡️ App öffnen: https://soerenmaterna-svg.github.io/vogelstimmen/**

Vogelstimme mit dem Handy aufnehmen oder Audiodatei hochladen – die App zeigt, welcher Vogel
das ist und wie sicher sie sich ist (in Prozent).

Die Erkennung läuft mit [BirdNET](https://birdnet.cornell.edu/) (Cornell Lab of Ornithology &
TU Chemnitz) **komplett im Browser auf deinem Gerät**. Es gibt keinen Server. Aufnahmen und Funde
werden nur im Browser auf deinem Gerät gespeichert (IndexedDB); nur für den Ortsnamen wird der
Standort an OpenStreetMap geschickt. Beim ersten Öffnen lädt die App das Erkennungsmodell (ca. 26 MB),
danach liegt es im Browser-Cache.

<img src="vorschau.png" width="300" alt="Vorschau der App">

## Funktionen

- **Umschalter 🐦 / 🦗 / 🐸** oben rechts: Vögel, **Heuschrecken, Grillen und Zikaden** oder
  **rufende Amphibien** erkennen.
  - Insekten: 248 in Europa vorkommende Arten (z. B. Grünes Heupferd, Feldgrille, Weinhähnchen,
    Nachtigall-Grashüpfer, Roesels Beißschrecke, Gemeine Singzikade, Mannasingzikade)
  - Amphibien: 32 in Europa vorkommende Arten (Laubfrösche inkl. Mittelmeer-, Italienischer und
    Iberischer Laubfrosch, Wasserfrösche, Gras-, Moor- und Springfrosch, Erd-, Kreuz- und
    Wechselkröte, Rot- und Gelbbauchunke, Knoblauchkröte, Geburtshelferkröten, Schlammtaucher)
  - Beide nutzen ein gemeinsames Modell (BirdNET+ V3.0, ca. 60 MB mit Rechen-Engine), das erst
    beim Wechsel in einen dieser Modi geladen wird.

- Aufnahme direkt im Browser mit buntem Live-Spektrum (bis 2 Minuten), danach automatische Analyse
- **Mikrofon-Wegweiser:** Die App erkennt das Gerät (iPhone, Android-Handy, iPad/Tablet, Computer)
  und zeigt während der Aufnahme mit einem großen Pfeil, wo das Mikrofon ist. Das Aufnahme-Vollbild
  bleibt immer im Hochformat am Gerät ausgerichtet (auch wenn das Handy ins Querformat schaltet)
  und dreht sich nur um 180°, wenn das Handy auf dem Kopf gehalten wird (Lagesensor; liegt das
  Handy flach, bleibt die Anzeige wie sie ist). Zusätzlich gibt es den Knopf „Drehen“. War die
  Anzeige beim Beenden gedreht, erscheint auch das Ergebnis gedreht, bis man das Handy wieder
  gerade hält (oder „Normal anzeigen“ tippt).
  Hinweis: Browser verraten die genaue Mikrofon-Lage nicht; die App nutzt die typische Lage
  (Handys unten an der Ladebuchse, Tablets und Laptops oben).
- Hochladen von Aufnahmen (mp3, m4a, wav, ogg, flac, webm …)
- Bis zu 5 Treffer mit Prozentwert, Wikipedia-Link und Vorschaubild
- **Europäische Arten** (559 Arten, siehe `data/europa_arten.txt`) werden bevorzugt
- Optional mit **Standort**: Arten, die dort im aktuellen Monat vorkommen, werden bevorzugt
- **Irrgäste und Gefangenschaftsflüchtlinge** werden auch erkannt, aber gekennzeichnet und
  erst ab einer höheren Sicherheit angezeigt:

  | Kennzeichnung | Bedeutung | angezeigt ab |
  |---|---|---|
  | – | erwartete Art | 10 % |
  | Selten hier | europäische Art, am Standort/zur Jahreszeit untypisch | 25 % |
  | Gefangenschaftsflüchtling? | Volieren-, Zoo- oder Parkvogel (`data/gefangenschaftsfluechtlinge.txt`) | 30 % |
  | Möglicher Irrgast | Art von außerhalb Europas | 50 % |

- Störgeräusche (Motor, Stimmen, Hund …) werden gemeldet
- **Meine Funde (Verlauf):** Jede Bestimmung wird mit Aufnahme, Datum, Uhrzeit und Fundort
  (Koordinaten, Ortsname über OpenStreetMap, Kartenlink) gespeichert. Pro Fund gibt es eine
  Notiz, und man kann die Aufnahme jederzeit wieder anhören.
- **„Gesehen“-Knopf:** Bei jedem erkannten Vogel lässt sich bestätigen, dass man ihn auch
  gesehen hat. Im Verlauf kann man nach bestätigten Sichtungen filtern.
- **Löschen:** einzelne Funde per 🗑️ in der Liste oder in der Detailansicht, direkt nach der
  Bestimmung per „Wieder entfernen“, oder alle auf einmal
- **Meine Funde nach Gruppen:** Schalter Alle / Vögel / Insekten / Amphibien. Beim Öffnen ist die
  Rubrik des aktuellen Modus gewählt; „Alle“ zeigt alle Funde nach Zeit sortiert. PDF und
  „Alle löschen“ beziehen sich auf die gewählte Auswahl.
- **PDF:** Alle Funde als übersichtliche Tabelle im PDF (ein Fund pro Zeile, bestätigte Sichtungen fett)
- Lässt sich über „Zum Startbildschirm hinzufügen“ wie eine App aufs Handy legen

## Tipps für gute Ergebnisse

- 10–30 Sekunden aufnehmen, Handy Richtung Vogel halten
- Wind, Verkehr und Gespräche vermeiden
- Der Prozentwert ist die Sicherheit des Modells, kein Beweis. Bei seltenen Arten lieber
  ein zweites Mal hinhören oder hinschauen.

## Aufbau

| Datei/Ordner | Inhalt |
|---|---|
| `index.html`, `app.js`, `style.css` | Oberfläche (Aufnahme, Upload, Ergebnisse) |
| `birdnet.js` | Vogelerkennung (BirdNET 2.4): Audio einlesen, Spektrogramm, Modell, Bewertung |
| `v3net.js` | Erkennung von Insekten und Amphibien (BirdNET+ 3.0, ONNX Runtime Web) |
| `mic.js` | Geräteerkennung, Mikrofon-Pfeil, Drehen des Aufnahme-Vollbilds (0°/180°) |
| `history.js` | Verlauf „Meine Funde“ (IndexedDB), Ortsname, PDF-Export |
| `model/` | BirdNET v2.4 als TensorFlow.js-Modell (Gewichte als float16) |
| `model-v3/` | BirdNET+ V3.0, Ausgabe auf Insekten, Amphibien und Störgeräusche gekürzt (`tools/build_v3.py`) |
| `data/` | deutsche Namen, Europa-Artenliste, Standort-Raster, Gefangenschaftsflüchtlinge (Insekten/Amphibien: `data/v3/`, `data/insekten/`, `data/amphibien/`) |
| `vendor/` | TensorFlow.js 4.22 mit WebAssembly-Backend, ONNX Runtime Web 1.31 (`vendor/ort`, MIT), jsPDF 4.2 + AutoTable 5.0 (`vendor/pdf`, MIT) |
| `tools/` | Python-Skripte, mit denen `model/` und `data/` erzeugt wurden |

Lokal testen: im Ordner `python3 -m http.server` starten und <http://localhost:8000> öffnen.

Vor dem Hochladen von Änderungen `python3 tools/version.py` ausführen: Das hängt eine neue
Versionsnummer an alle Dateien, damit Browser keine veralteten Dateien aus dem Zwischenspeicher nehmen.

Daten neu erzeugen (Python 3.10+):

```bash
pip install -r tools/requirements.txt
```

```bash
cd tools && python make_europe_list.py && python build_data.py
```

## Vogelfotos

Die Vogelfotos sind gemeinfrei (CC0) und stammen von [iNaturalist](https://www.inaturalist.org/).
Die Quellen stehen in `img/voegel/quellen.txt`.

## Erkennungsmodelle und Lizenzen

- **Vögel:** BirdNET v2.4 (Cornell Lab of Ornithology & TU Chemnitz), **CC BY-NC 4.0** –
  private und nicht-kommerzielle Nutzung erlaubt.
  Quelle: <https://zenodo.org/records/15050749>
- **Heuschrecken/Insekten und Amphibien:** BirdNET+ V3.0 und BirdNET+ Geomodel V3.0.5 (The BirdNET Team),
  **Apache License 2.0**. Das Modell wurde auf Insekten, Amphibien und Störgeräusche gekürzt.
  Quelle: <https://zenodo.org/records/24362980>
- Europa-Listen der Insekten und Amphibien ergänzt um Fundmeldungen aus [GBIF](https://www.gbif.org/).
