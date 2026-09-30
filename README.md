# 👻 Ghostclipz

Ein Arcade-Spiel, in dem deine eigene Vergangenheit dein Gegner ist.
Läuft auf Handy und PC, ohne Installation und ohne Build-Schritt.

## Die Idee

Alle **4 Sekunden** wird ein **Clip** von dir aufgenommen. Ab dann spukt dein
**Echo** genau diese 4 Sekunden in Dauerschleife durch die Arena (hin und zurück).
Je mehr du dich bewegst, desto voller wird die Arena mit deinen eigenen Geistern.

## Spielen

- **Bewegen:** auf dem Handy ziehen (irgendwo auf dem Bildschirm), am PC Maus oder WASD / Pfeiltasten
- **Seelen** einsammeln (+10). Sammelst du schnell hintereinander, steigt die Combo bis x6.
  Goldene Seelen bringen +50 und eine Dash-Ladung.
- **Berühr nie deine Echos.** Frische Echos sind kurz durchsichtig und noch harmlos.
- **Dash** (Tippen / Klick / Leertaste / Shift): kurzer Sprint, bei dem du unverwundbar bist.
  Echos, durch die du dashst, werden zerstört. Kostet 1 Ladung, 3 Seelen = 1 Ladung (max. 3).
- Echos sammeln auch Seelen ein (+5 für dich), klauen dir aber die Combo.
- Alle 20 Sekunden steigt das Level: mehr Echos gleichzeitig, schnellere Echos, mehr Seelen.
- **P / Esc**: Pause, **M**: Ton an/aus

Die Top-5-Highscores werden lokal im Browser gespeichert.

## Lokal starten

Einfach `index.html` im Browser öffnen, oder:

```bash
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

## Online stellen (GitHub Pages)

1. Auf GitHub im Repo: **Settings → Pages**
2. Bei *Source* „Deploy from a branch“ wählen, den Branch auswählen, Ordner `/ (root)`, **Save**
3. Nach ca. 1 Minute läuft das Spiel unter `https://<benutzername>.github.io/ghostclipz/`

Auf dem Handy kann man die Seite über „Zum Home-Bildschirm hinzufügen“ wie eine App starten.

## Dateien

| Datei | Inhalt |
| --- | --- |
| `index.html` | Seite, Menüs, HUD |
| `style.css` | Aussehen der Menüs und des HUD |
| `game.js` | Das ganze Spiel (Echo-Aufnahme, Grafik, Sounds, Highscores) |
| `icon.svg`, `icon-180.png`, `manifest.webmanifest` | App-Icon und Home-Bildschirm-Unterstützung |

Die Werte für Clip-Länge, Tempo, Echo-Anzahl usw. stehen gesammelt oben in `game.js` im `CFG`-Objekt.
