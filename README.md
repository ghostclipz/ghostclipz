# 👻 Ghostclipz

Ein kleines Browser-Spiel: Du fliegst als Geist durch einen Spukfriedhof.
Läuft auf Handy und PC, ohne Installation und ohne Build-Schritt.

## Spielen

- **Tippen / Klicken / Leertaste**: hochschweben
- Den Steinsäulen und (ab 12 Punkten) den Fledermäusen ausweichen
- **Seelen** (leuchtende Kugeln) geben +1 Punkt. Bei 5 Seelen startet der
  **Geistermodus**, dann fliegst du 4 Sekunden lang durch Wände.
- Ab 8 Punkten bewegen sich manche Säulen.
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
| `game.js` | Das ganze Spiel (Canvas-Grafik, Physik, Sounds, Highscores) |
| `icon.svg`, `icon-180.png`, `manifest.webmanifest` | App-Icon und Home-Bildschirm-Unterstützung |

Die Werte für Schwierigkeit, Tempo usw. stehen gesammelt oben in `game.js` im `CFG`-Objekt.
