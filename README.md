# Gym Tracker · AI Fitness Coburg

SvelteKit-Dashboard mit SQLite-Messwerten und einem getrennten Python-Prognosedienst. Alle Kalendertage und Viertelstunden verwenden `Europe/Berlin`. Geschlossen wird als Anzeigezustand mit 0 % dargestellt; dadurch entstehen keine erfundenen Nullmessungen in der Historie.

## Lokal starten

Node.js 22 und Python 3.11 verwenden. `npm ci` installiert das Dashboard; eine isolierte Python-Umgebung installiert `predictor-service/requirements.txt`.

```sh
python3.11 -m venv .venv
.venv/bin/pip install -r predictor-service/requirements.txt
DATABASE_PATH="$PWD/data/gym.db" PREDICTION_DATABASE_PATH="$PWD/data/predictions.db" .venv/bin/gunicorn --chdir predictor-service --bind 127.0.0.1:5000 --workers 1 --threads 4 app:app
```

In einem zweiten Terminal:

```sh
PREDICTOR_URL=http://127.0.0.1:5000 npm run dev
```

Das Dashboard legt seine Messdatenbank beim ersten Start an. Der Prognosedienst versucht fehlgeschlagenes Training später erneut. `DATABASE_PATH` erlaubt eine separate Datenbank; `DISABLE_POLLING=true` schaltet für lokale Vorschauen die externen Messwertabrufe ab. Exportdateien und lokale Untersuchungen gehören in `Archiv/`; dieser Ordner ist aus Git und dem Docker-Buildkontext ausgeschlossen.

## Prognosebetrieb

Der Dienst trainiert beim Start im Hintergrund und danach täglich. Anfragen verwenden ausschließlich ein fertig trainiertes Modell. `/health` meldet `training`, `ready` oder `unavailable`; `/predict?date=YYYY-MM-DD` antwortet während des ersten Trainings mit HTTP 503. Eine fehlgeschlagene Neuberechnung erhält das vorherige Modell. Der Dienst läuft mit einem Gunicorn-Worker und mehreren Threads, damit Training und Scheduler genau einmal existieren.

Messwerte und Vorhersagen liegen in getrennten Datenbanken. Docker Compose bindet die Messwerte für den Prognosedienst nur lesbar ein und speichert ausgegebene Prognosen im Volume `gym-predictions`. Dieses Volume zusammen mit `gym-data` sichern. Für jeden Punkt werden Ausgabezeit, Trainingsstand, Modellversion, Zielzeit, Horizont und gegebenenfalls Unter-/Obergrenze gespeichert. Abgelaufene Zeitfenster werden niemals nachträglich als neue Prognosen erzeugt. Im Archiv sind nur tatsächlich vorher ausgegebene Prognosen sichtbar; vor Einführung der Speicherung fehlen sie erwartungsgemäß.

Der Hintergrunddienst speichert den restlichen Tag viertelstündlich und die kommenden sieben Tage täglich sowie nach Änderungen des Wettercaches oder des fertigen Modells, spätestens im nächsten Viertelstundenfenster. Das funktioniert unabhängig von Dashboard-Aufrufen. Die regulären Öffnungszeiten sind Montag–Freitag 06–22 Uhr, Samstag/Sonntag 07–22 Uhr. Abweichende künftige Feiertagsöffnungszeiten sind nicht bekannt. Bayern-Feiertage und Schulferien gehen in die Modelle ein. Für Live-Prognosen kommen stündliche Wettervorhersagen hinzu; historisch gemessenes Wetter wird nur zum Lernen des Wettereinflusses verwendet.

80-%-Prognosebänder werden aus Fehlern früherer, zeitlich getrennter Vorhersagen kalibriert. Ohne ausreichende Kalibrierungsdaten bleiben die Grenzen `null`. Die empirische Abdeckung wird im Rücktest und in der späteren Auswertung mitberichtet; 80 % ist ein Zielwert, keine Garantie für jede neue Woche. Bei einer Wetterkorrektur umschließt das Band sowohl die Kalenderprognose als auch die verschobene Prognose (`intervalCalibration=calendar_envelope`); die Wetter-Erweiterung hat noch keine belegte historische Testdeckung.

## Reproduzierbarer Modellvergleich

```sh
.venv/bin/python predictor-service/benchmark.py backtest \
  --input Archiv/gym-tracker-export-2026-10-06.json \
  --output Archiv/benchmark \
  --selection predictor-service/selection.json
```

Standardmäßig: Kalibrierungsursprünge ab 1. März im Wochenabstand, Testursprünge täglich vom 1. Juli bis zum letzten Exporttag. Jeder Ursprung trainiert ausschließlich mit damals verfügbaren Beobachtungen; die Anpassung des Tagesverlaufs verwendet ebenfalls nur zuvor eingetroffene Werte. Fehlende Messungen und geschlossene Zeitfenster werden nicht mit Nullen aufgefüllt. Auffällige Sprünge bleiben in der Hauptauswertung erhalten und werden zusätzlich in einer Sensitivitätsauswertung markiert.

Dieser Rücktest vergleicht ausschließlich die Kalenderprognosen ohne damals unbekannte Wettervorhersagen. Verglichen werden die bisherige Prophet-Konfiguration einschließlich UTC-/Lokalzeitfehler, korrigiertes Prophet mit separaten Tagesprofilen pro Wochentag und ein zeitlich gewichtetes Profil mit gedämpfter Anpassung an den aktuellen Tagesverlauf. Berichte enthalten MAE, RMSE, Bias, 90. Fehlerperzentil, Fehler ab 25 % Auslastung, Prognoseband-Abdeckung und Rangfolge/Mehrbelegung gewählter ruhiger Stunden. Horizonte sind 15/60/180 Minuten sowie 1–7 Kalendertage. Innerhalb jeder Gruppe werden Horizonte gleich gewichtet, danach beide Gruppen zu je 50 %.

Das gewichtete Profil ersetzt korrigiertes Prophet nur ab 5 % geringerem Gesamtfehler und maximal 0,25 Prozentpunkten zusätzlichem Fehler bei hoher Auslastung. Ohne qualifizierte Modellkonfiguration bleibt korrigiertes Prophet aktiv. Detaillierte Ergebnisse bleiben unter `Archiv/`; versioniert wird nur die kompakte Modellentscheidung.

## Wetter berücksichtigen

Die Live-Prognose verwendet die zum Ausgabezeitpunkt verfügbare stündliche Open-Meteo-Vorhersage für Coburg: Temperatur, Niederschlag/Regen und Bewölkung. Der Abruf läuft im Hintergrund mit Timeout und Cache. Fehlende oder veraltete Wetterdaten lassen die Kalenderprognose unverändert; sie werden niemals durch erfundene Wetterwerte ersetzt.

Der Wettereffekt wird aus historischen Messungen gelernt, unter Berücksichtigung von Tageszeit, Wochentag und saisonalen Unterschieden. Starke Regularisierung, eine gedämpfte Korrektur und Grenzen des beobachteten Wetterbereichs vermeiden überzogene Schlussfolgerungen aus einzelnen heißen oder regnerischen Tagen. Wettertraining blockiert die Verfügbarkeit des bereits fertigen Kalendermodells nicht.

Jede ausgegebene Prognose speichert auch `baselinePercentage`, `weatherAdjustment` und die tatsächlich verwendete Wettervorhersage mit Abrufzeit und Zielstunde. Damit kann die spätere Auswertung Wetter- und Kalenderprognose für genau dieselben Zielzeiten vergleichen. Temperatur und Niederschlag sind in den Diagrammdetails sichtbar; die Hauptansicht bleibt kompakt.

Die lokale Untersuchung lässt sich nach dem Kalender-Rücktest wiederholen:

```sh
.venv/bin/python scripts/weather-audit.py
```

Sie schreibt ausschließlich nach `Archiv/weather-audit.json`. Ihre zeitlich getrennten Diagnoseabschnitte verwenden beobachtetes Zielwetter und zeigen deshalb nur mögliches Verbesserungspotenzial. Sie ersetzen keinen Rücktest mit damals ausgegebenen Wettervorhersagen; belastbare Wetter-Prognosefehler liefert erst das gespeicherte Prognosejournal im Betrieb.

## 28 Tage nach Veröffentlichung auswerten

Nach 28 vollständigen Betriebstagen einen aktuellen Messwertexport und die gesicherte Prognosedatenbank lokal verwenden:

```sh
.venv/bin/python predictor-service/benchmark.py evaluate-ledger \
  --input Archiv/aktueller-export.json \
  --ledger Archiv/predictions.db \
  --until YYYY-MM-DD \
  --output Archiv/prognosebetrieb-28-tage.json
```

`--until` ist die exklusive Berliner Tagesgrenze, standardmäßig heute. Die Auswertung betrachtet die 28 vorhergehenden Tage und zählt je Modell, Zielzeit und Horizont nur eine ausgegebene Prognose. Seitenaufrufe verändern dadurch nicht das Gewicht einer Zielzeit. Historischer Rücktest und echte Betriebsprognosen bleiben unterscheidbar.

## Import, Migration und Prüfungen

Exportformat v2 erhält alle Wetter-/Ferienfelder; Import akzeptiert v1 und v2. Zeitmerkmale werden aus dem Zeitstempel neu abgeleitet. Die Importgrenze beträgt 16 MiB (`BODY_SIZE_LIMIT=16777216` beim Node-Produktionsserver). Wiederholte identische Importe ändern nichts. Widersprüchliche Messungen mit identischem Zeitstempel erzeugen HTTP 409 und rollen den gesamten Import zurück.

Vor Anlage des eindeutigen Zeitstempelindex sichert die Migration bestehende Messwerte inklusive WAL über SQLite `VACUUM INTO` in eine benachbarte `.bak`-Datei. Nur vollständig identische Dubletten werden zusammengeführt. Bei widersprüchlichen Dubletten stoppt der Start mit Sicherungspfad und betroffenen Zeitstempeln; diese Daten müssen anhand der Sicherung geprüft werden, bevor die Migration erneut startet.

```sh
npm test
npm run check
npm run build
.venv/bin/python -m unittest discover -s predictor-service -p 'test_*.py' -v
```

Browserabnahme: Kalender vor der ersten heutigen Messung, schnelle Datumswechsel, automatische Aktualisierung, gemeinsame Diagramm-Details, fehlende Prognosen/Fehlerzustände, Heatmap mit Maus/Pfeiltasten/Escape und schmale Smartphone-Ansicht. Die Admin-Anmeldung ist außerhalb dieser Überarbeitung.

## Laufzeit und Sicherheitsupdates

Node.js 22.23.4 ist in `.nvmrc` und den Docker-Stufen festgelegt (Brotli-Fix für CVE-2026-111497). Lokal `nvm install` und `nvm use` ausführen. Bei einem Deployment das Basisimage neu ziehen, das Image neu bauen und die laufende Instanz ersetzen; vorhandene Datenvolumes erhalten. Anschließend `node --version` im laufenden Container prüfen.
