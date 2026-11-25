# 🐦 Vogelstimmen-Erkennung

Kleine Web-App: Vogelstimme mit dem Handy aufnehmen oder Audiodatei hochladen.
Die App zeigt dann, welcher Vogel das ist und wie sicher sie sich ist (in Prozent).

Die Erkennung läuft mit [BirdNET](https://birdnet.cornell.edu/) (Cornell Lab of Ornithology & TU Chemnitz).

## Funktionen

- Aufnahme direkt im Browser mit Live-Spektrum (bis 2 Minuten), danach automatische Analyse
- Hochladen von Aufnahmen (wav, mp3, m4a, ogg, flac, webm …)
- Bis zu 5 Treffer mit Prozentwert, Wikipedia-Link und Vorschaubild
- **Europäische Arten** (559 Arten, siehe `europa_arten.txt`) werden bevorzugt
- Optional mit **Standort**: Arten, die dort zur aktuellen Jahreszeit vorkommen, werden bevorzugt
- **Irrgäste und Gefangenschaftsflüchtlinge** werden auch erkannt, aber gekennzeichnet und
  erst ab einer höheren Sicherheit angezeigt:

  | Kennzeichnung | Bedeutung | angezeigt ab |
  |---|---|---|
  | – | erwartete Art | 10 % |
  | Selten hier | europäische Art, am Standort/zur Jahreszeit untypisch | 25 % |
  | Gefangenschaftsflüchtling? | Volieren-, Zoo- oder Parkvogel (`gefangenschaftsfluechtlinge.txt`) | 30 % |
  | Möglicher Irrgast | Art von außerhalb Europas | 50 % |

- Störgeräusche (Motor, Stimmen, Hund …) werden gemeldet

## Installation

Voraussetzungen: Python 3.10 oder neuer und `ffmpeg`.

```bash
python3 -m venv .venv
```

```bash
source .venv/bin/activate
```

```bash
pip install -r requirements.txt
```

```bash
python app.py
```

Dann <http://localhost:8000> öffnen. Beim ersten Start lädt BirdNET seine Modelle herunter (ca. 120 MB).

## Auf dem Handy benutzen

Browser erlauben den Zugriff aufs Mikrofon nur über **HTTPS**, außer auf `localhost`.
Für das Handy gibt es zwei einfache Wege:

1. **Tunnel**, z. B. mit [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/).
   Das erzeugt eine HTTPS-Adresse, die man auf dem Handy öffnet:
   ```bash
   cloudflared tunnel --url http://localhost:8000
   ```
2. **Eigenes Zertifikat** im Heimnetz, z. B. mit [mkcert](https://github.com/FiloSottile/mkcert):
   ```bash
   python app.py --ssl-certfile cert.pem --ssl-keyfile key.pem
   ```

Ohne HTTPS funktioniert auf dem Handy trotzdem das **Hochladen** von Aufnahmen.
Über „Zum Startbildschirm hinzufügen“ bekommt die App ein eigenes Icon.

## Anpassen

- `gefangenschaftsfluechtlinge.txt`: Arten oder ganze Gattungen, eine pro Zeile
- `make_europe_list.py`: erzeugt `europa_arten.txt` neu (z. B. mit anderem Gebiet)
- `CATEGORIES` in `app.py`: Gewichtung und Mindest-Sicherheit je Kategorie

## Tipps für gute Ergebnisse

- 10–30 Sekunden aufnehmen, Handy Richtung Vogel halten
- Wind, Verkehr und Gespräche vermeiden
- Der Prozentwert ist die Sicherheit des Modells, kein Beweis. Bei seltenen Arten lieber
  ein zweites Mal hinhören oder hinschauen.

## Lizenz der Modelle

Die BirdNET-Modelle stehen unter **CC BY-NC-SA 4.0**.
Für private und nicht-kommerzielle Nutzung ist das in Ordnung, kommerzielle Nutzung ist nicht erlaubt.
