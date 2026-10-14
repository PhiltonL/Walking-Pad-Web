# Walking Pad Web

Steuere dein Walking Pad per Bluetooth direkt im Browser und zeichne jedes Training auf – ohne App-Installation, ohne Konto, ohne Server. Alle Daten bleiben in deinem Browser.

**Inoffiziell:** Dieses Projekt steht in keiner Verbindung zu einem Laufband-Hersteller.

## Funktionen

- Live-Anzeige von Tempo, Zeit, Strecke und Kalorien (Schritte geschätzt, Puls wenn das Gerät ihn meldet)
- Start, Pause, Weiter, Stop und Tempo-Steuerung mit Voreinstellungen
- Automatische Aufzeichnung jedes Trainings mit Verlauf, Wochen- und Monatssummen
- Tempo-Diagramm pro Training mit Hover-Anzeige
- Export als **FIT-Datei** (Garmin Connect, Strava), JSON und CSV; Import von JSON
- Gespeichertes Gerät: verbindet sich beim nächsten Öffnen automatisch (wenn der Browser es unterstützt)
- Funktionen lassen sich in den Einstellungen ausblenden (z. B. Steigung, wenn dein Band keine hat)
- Heller und dunkler Modus, Bildschirm bleibt während des Trainings an
- Demo-Modus zum Ausprobieren ohne Laufband
- Entwickleransicht mit Log und Rohdaten zur Fehlersuche

## Voraussetzungen

- **Browser:** Chrome, Edge oder Opera auf dem Computer oder auf Android. Web Bluetooth gibt es in Safari, Firefox und auf iPhone/iPad nicht.
- **Laufband:** Es muss eingeschaltet und nicht gleichzeitig mit einer anderen App verbunden sein.

## Unterstützte Laufbänder

| Protokoll | Status |
|---|---|
| FitShow (Service `F100`/`FFF0`) | Getestet mit dem swalk Laufband |
| FTMS (Bluetooth Fitness Machine Service) | Lesen und Steuern nach Standard implementiert, nicht an echter Hardware getestet |
| Eway (Service `FFF0`) | Nach Protokollbeschreibung implementiert, nicht an echter Hardware getestet |

Andere Modelle können sich anders verhalten. Ob dein Band funktioniert, siehst du nach dem Verbinden.

## Datenschutz

Die Seite hat kein Backend und kein Tracking. Trainings und Einstellungen liegen im `localStorage` deines Browsers. Wer den Browser-Speicher löscht, verliert sie – exportiere sie deshalb regelmäßig (Einstellungen → Daten).

## Hinweis

Die Seite steuert einen Motor. Die Nutzung erfolgt auf eigene Gefahr, es gibt keine Gewähr. Stell dich erst aufs Band, wenn du es startest, und nutze den Sicherheitsschlüssel deines Geräts.
