# Forecast service

Python 3.11; install the pinned `requirements.txt`. Run production with the Dockerfile
(one Gunicorn worker, four threads). Startup schedules background training; requests
never train a model. Daily retraining atomically replaces the last successful model.
A failed attempt retains the previous model and retries after five minutes.

`DATABASE_PATH` points to the application's read-only SQLite database.
`PREDICTION_DATABASE_PATH` points to a separate writable, persistent SQLite ledger
(default `/app/predictions/predictions.db`). Do not mount the source database writable.
`BENCHMARK_SELECTION_PATH` optionally overrides the packaged `selection.json`.
The selection file contains only deployment configuration; historical measurements,
metrics, input hashes and backtest outputs remain in the git-ignored local `Archiv/`.

## Calendar and model

All valid observations are deduplicated by timestamp and reduced to the last available
observation per 15-minute slot, preserving the original observation time. Calendar
features use Europe/Berlin (including daylight-saving changes). Standard opening hours
are 06:00–22:00 Monday–Friday and 07:00–22:00 on weekends. Closed slots are excluded;
measured zeros stay. Unknown exceptions to public-holiday opening hours cannot be
inferred from the historical export. Missing slots are never synthesized as zeros.

The corrected Prophet baseline has separate daily curves per weekday, Bavarian public
holidays and the official inclusive Bavarian school-holiday calendar. The alternative
uses a 28-day half-life weekday/quarter-hour profile, shrunk holiday effects, and a
bounded, decaying adjustment from the preceding two hours of available measurements.
Issued weather forecasts can add a conservative correction to this calendar baseline; historical
observed weather is never substituted for an unavailable issued forecast in the calendar backtest.

The weighted candidate is deployed only when the chronological benchmark improves the
average of intraday and next-seven-day MAE by at least 5%, with busy-period (actual ≥25%)
MAE increasing by at most 0.25 points. Otherwise corrected Prophet remains selected.
Unknown/invalid deployment artifacts fail closed to corrected Prophet.

80% intervals use a finite-sample absolute-error quantile. Intraday calibration uses the
last seven complete Berlin days with a separate fit before each day, matching the daily
production training cadence. Horizons of 1–7 days use three seven-day historical holdouts.
Each calibration fit sees only observations preceding its holdout. Radii are
separate for 15/60/180-minute and 1–7-day horizons. Fewer than 50 errors yields null bounds
and `intervalStatus: insufficient_data`. 80% is a nominal calibration target, not a claim
of achieved future coverage; the benchmark and prospective audit report observed coverage.

## API and provenance

- `GET /health`: `status` is `training`, `unavailable`, or `ready`; readiness requires an
  existing model. `training` also shows background retraining with a good model retained.
- `GET /predict?date=YYYY-MM-DD`: strict Berlin calendar date, at most seven days ahead;
  unavailable/training returns 503, invalid dates return 400.
- `POST /train`: schedules training and returns 202 without blocking on a fit.

Predictions retain `date`, JS `weekday` (Sunday=0), holiday fields, and
`predictions[{hour,minute,percentage}]`. Added fields include opening hours, school
holidays, `status`, `issuedAt`, `trainedThrough`, `modelVersion`, `intervalCoverage`,
`intervalStatus`, `source: recorded`, and per-point `targetAt`, `lower`, `upper`,
`horizon`, and individual issuance/training provenance. Top-level `weather` remains null for compatibility; individual points contain the exact optional
weather forecast used, its retrieval time, `baselinePercentage`, `weatherAdjustment`,
`weatherStatus`, `weatherTrainedThrough` and `intervalCalibration`.

Only targets strictly after issue time enter the append-only ledger. Repeated requests
within a 15-minute issuance bucket preserve the original prediction and metadata.
Today's elapsed slots and archive dates return recorded forecasts only; historical
reconstructions never masquerade as issued forecasts. Past dates without a ledger entry
return a clear 503 response. No predictions from before installation can be recovered.
The maintenance thread captures today's remainder every quarter-hour and the following
seven days once per day and again at the next quarter-hour after weather availability,
weather training or model updates change, independently of browser traffic.

## Actual weather influence

The independent cache worker requests Open-Meteo hourly temperature, precipitation,
rain and cloud cover for Coburg (50.2612, 10.9628). It uses UTC Unix times, °C and mm,
refreshes every 30 minutes, retries failures after five minutes, limits socket waits to
five seconds and response bodies to 256 KiB, and persists its last valid response beside
the forecast ledger. Requests only read cached forecasts fetched before their own issue
time, with at most six hours of cache age. Model readiness never waits on a weather fetch.
Primary variable definitions: https://open-meteo.com/en/docs

Temperature and cloud cover refer to the selected target-hour start. The provider's
precipitation/rain values sum the preceding hour. `targetAt` records that hourly timestamp;
`fetchedAt` records retrieval completion. `providerIssuedAt` is null because the stitched
forecast API does not expose a single model initialization time. These are forecasts,
not later observed weather substituted retrospectively.

After publishing the ready calendar model, background fitting generates past-only
calendar residuals from 16 weekly origins, each fitted before its seven future days.
At least 500 weather-bearing observations across 28 days are required. A ridge response
removes weekday/hour and calendar-fortnight effects before estimating temperature,
additional heat above 25°C, a separate rain flag (`rain > 0`) and cloud cover effects.
Rain/cloud receive ten times stronger regularization because their historical association
is weak and unstable. Historical current precipitation covers 15 minutes whereas forecast
amounts are hourly sums, so precipitation amount is deliberately not a model regressor.

Corrections compare forecast weather with past-28-day weather at the same studio hour,
clip features to historical 1st–99th percentiles, halve the learned response, and cap the
result at ±3 percentage points. Missing/stale forecasts or insufficient training leave the
calendar value unchanged. Existing successful weather coefficients stay available during
retraining. Every issued row stores its baseline, adjusted value and weather provenance
for a paired prospective comparison; data collection does not depend on browser visits.

For weather-adjusted values the displayed band conservatively encloses both the calendar
band and its shifted counterpart (`intervalCalibration: calendar_envelope`). The reported
historical interval coverage and model benchmark validate the calendar baseline only.
Weather-adjusted accuracy/coverage must be measured with actual issued forecasts over
subsequent weeks; observed-weather diagnostics are not an authentic forecast-weather test.

## Reproducible evaluation

From the repository root, using the predictor virtual environment:

```sh
python predictor-service/benchmark.py backtest \
  --input Archiv/gym-tracker-export-2026-10-06.json \
  --output Archiv/benchmark \
  --selection predictor-service/selection.json
python -m unittest discover -s predictor-service -p 'test_*.py'
```

Defaults: weekly calibration origins from March–June; daily expanding-training test
origins from July 1 through the last exported day. Fits occur before each Berlin day;
intraday issues are 15/60/180 minutes before each target, future-day issues at midnight.
All training and recent-adaptation observations must precede issuance. The legacy
reference preserves the original UTC/local mismatch and original Prophet configuration
on the same validated observations. MAE, RMSE, bias, p90, busy MAE, hourly quiet-window
rank correlation/regret and interval coverage are reported. Targets with a ≥25-point
adjacent jump are flagged, retained in the main evaluation, and excluded only in a
separate sensitivity report.

After deployment, collect at least 28 days and export the current actual readings:

```sh
python predictor-service/benchmark.py evaluate-ledger \
  --input Archiv/current-readings.json \
  --ledger /path/to/predictions.db \
  --output Archiv/prospective-28-days.json
```

The audit uses the 28 complete Berlin days ending today (or `--until YYYY-MM-DD`), joins
only issued forward forecasts to observed targets, and de-weights repeated requests by
keeping one issue per model/target/horizon. `weatherComparison` compares active weather and
stored calendar values on identical issued rows. Missing measurements remain missing.
