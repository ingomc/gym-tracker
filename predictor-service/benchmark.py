"""Chronological out-of-sample benchmark and prospective ledger evaluation.

Never imports the HTTP app or contacts a remote weather/source service.
Run `python benchmark.py --help` for reproducible defaults.
"""
import argparse
import hashlib
import json
import logging
import sqlite3
from pathlib import Path
import numpy as np
import pandas as pd
from calendar_features import BERLIN, normalize_readings, iso_utc
from models import KINDS, MODEL_VERSION, make_model, conformal_radius
from ledger import ForecastLedger


def load_export(path):
    value = json.loads(Path(path).read_text())
    return normalize_readings(value['readings'] if isinstance(value, dict) else value)


def statistics(rows):
    if rows.empty:
        return {'count': 0, 'mae': None, 'rmse': None, 'bias': None, 'p90': None, 'busyMae': None}
    error = rows['prediction'] - rows['actual']
    busy = rows['actual'] >= 25
    return {'count': len(rows), 'mae': float(error.abs().mean()),
            'rmse': float(np.sqrt(np.mean(error ** 2))), 'bias': float(error.mean()),
            'p90': float(error.abs().quantile(.9)),
            'busyCount': int(busy.sum()), 'busyMae': float(error.loc[busy].abs().mean()) if busy.any() else None}


def quiet_windows(rows):
    correlations, regrets = [], []
    # Compare a complete day issued at one time; intraday issues vary by target.
    for _, day in rows.loc[rows['horizon'].str.startswith('day_')].groupby(['issuedAt', 'targetDate']):
        day = day.sort_values('targetAt')
        windows = []
        for start in range(len(day) - 3):
            group = day.iloc[start:start + 4]
            if group['targetAt'].diff().iloc[1:].eq(pd.Timedelta(minutes=15)).all():
                windows.append((float(group['prediction'].mean()), float(group['actual'].mean())))
        if len(windows) < 4:
            continue
        predicted, actual = np.array(windows).T
        if np.std(predicted) > 0 and np.std(actual) > 0:
            correlations.append(float(pd.Series(predicted).rank().corr(pd.Series(actual).rank())))
        regrets.append(float(actual[np.argmin(predicted)] - actual.min()))
    return {'days': len(regrets), 'rankCorrelation': float(np.mean(correlations)) if correlations else None,
            'chosenHourRegret': float(np.mean(regrets)) if regrets else None}


def summarize(rows, include_quiet=True):
    by_horizon = {key: statistics(group) for key, group in rows.groupby('horizon')}
    intraday = [value['mae'] for key, value in by_horizon.items() if key.startswith('minute_')]
    future = [value['mae'] for key, value in by_horizon.items() if key.startswith('day_')]
    intraday_busy = [value['busyMae'] for key, value in by_horizon.items()
                    if key.startswith('minute_') and value['busyMae'] is not None]
    future_busy = [value['busyMae'] for key, value in by_horizon.items()
                  if key.startswith('day_') and value['busyMae'] is not None]
    score = (float(np.mean(intraday)) + float(np.mean(future))) / 2 if intraday and future else None
    busy_score = (float(np.mean(intraday_busy)) + float(np.mean(future_busy))) / 2 if intraday_busy and future_busy else None
    report = {**statistics(rows), 'horizons': by_horizon, 'equalModeScore': score,
              'equalModeBusyMae': busy_score}
    if include_quiet:
        report['quietWindows'] = quiet_windows(rows)
    if 'lower' in rows:
        interval = rows.loc[rows['lower'].notna() & rows['upper'].notna()]
        report['intervals'] = {'nominalCoverage': .8, 'count': len(interval),
            'empiricalCoverage': float(((interval['actual'] >= interval['lower'])
                                      & (interval['actual'] <= interval['upper'])).mean()) if len(interval) else None,
            'meanWidth': float((interval['upper'] - interval['lower']).mean()) if len(interval) else None}
    return report


def select_candidate(reports):
    reference, candidate = reports['corrected_prophet'], reports['weighted_profile']
    score, comparison = reference['equalModeScore'], candidate['equalModeScore']
    busy, comparison_busy = reference['equalModeBusyMae'], candidate['equalModeBusyMae']
    improvement = (score - comparison) / score if score and comparison is not None else None
    busy_delta = comparison_busy - busy if busy is not None and comparison_busy is not None else None
    qualified = improvement is not None and improvement >= .05 and busy_delta is not None and busy_delta <= .25
    return {'version': MODEL_VERSION, 'selected': 'weighted_profile' if qualified else 'corrected_prophet',
            'relativeImprovement': improvement, 'busyMaeDelta': busy_delta,
            'gate': {'minimumRelativeImprovement': .05, 'maximumBusyMaeIncrease': .25},
            'reason': 'Weighted profile passed both gates.' if qualified else 'Corrected Prophet retained; candidate did not pass both gates.'}


def deployment_selection(selection):
    """Only deploy the gated decision; export-derived metrics stay in local Archiv."""
    return {'version': selection['version'], 'selected': selection['selected'],
            'selectionGatePassed': selection['selected'] == 'weighted_profile',
            'selectionPolicy': selection['gate']}


def forecast_origin(readings, origin, kinds=KINDS):
    end = origin + pd.DateOffset(days=8)
    targets = readings.loc[(readings['timestamp'] >= origin) & (readings['timestamp'] < end)]
    if targets.empty:
        return []
    output = []
    for kind in kinds:
        model = make_model(kind).fit(readings, origin)
        base = model.predict(targets['timestamp'])
        values = targets.assign(prediction=base)
        today = values.loc[values['local'].dt.date == origin.date()]
        for minutes in (15, 60, 180):
            issued_times = today['timestamp'] - pd.Timedelta(minutes=minutes)
            # The daily fit is available before every intraday forecast issue.
            valid = issued_times >= origin
            subset = today.loc[valid]
            issued_times = issued_times.loc[valid]
            predicted = (model.predict_issued(subset['timestamp'], issued_times, readings)
                         if kind == 'weighted_profile' else subset['prediction'].to_numpy())
            for row, issued, point in zip(subset.itertuples(), issued_times, predicted):
                output.append({'model': kind, 'issuedAt': issued, 'trainedThrough': model.trained_through,
                    'targetAt': row.timestamp, 'targetDate': row.local.date().isoformat(),
                    'horizon': f'minute_{minutes}', 'prediction': float(point), 'actual': float(row.y),
                    'anomaly': bool(row.anomaly)})
        future = values.loc[values['local'].dt.date > origin.date()]
        for row in future.itertuples():
            days = (row.local.date() - origin.date()).days
            output.append({'model': kind, 'issuedAt': origin, 'trainedThrough': model.trained_through,
                'targetAt': row.timestamp, 'targetDate': row.local.date().isoformat(),
                'horizon': f'day_{days}', 'prediction': float(row.prediction), 'actual': float(row.y),
                'anomaly': bool(row.anomaly)})
    return output


def run_benchmark(args):
    readings = load_export(args.input)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    test_start = pd.Timestamp(args.test_start, tz=BERLIN)
    end = pd.Timestamp(args.end, tz=BERLIN) if args.end else readings['local'].max().normalize() + pd.DateOffset(days=1)
    tune_origins = pd.date_range(pd.Timestamp(args.tune_start, tz=BERLIN), test_start - pd.DateOffset(days=8),
                                 freq=f'{args.tune_stride}D')
    test_origins = pd.date_range(test_start, end - pd.DateOffset(days=1), freq=f'{args.stride}D')
    tuning, testing = [], []
    for phase, origins, destination in [('calibration', tune_origins, tuning), ('test', test_origins, testing)]:
        for index, origin in enumerate(origins):
            print(f'{phase} {index+1}/{len(origins)} {origin.date()}', flush=True)
            records = forecast_origin(readings, origin)
            # Exclude later targets from calibration, and targets outside the declared evaluation window.
            destination.extend(row for row in records if row['targetAt'] < (test_start if phase == 'calibration' else end))
    tuning, testing = pd.DataFrame(tuning), pd.DataFrame(testing)
    assert (testing['issuedAt'] < testing['targetAt']).all()
    assert (testing['trainedThrough'] < testing['issuedAt']).all()
    radii = {}
    for (kind, horizon), group in tuning.groupby(['model', 'horizon']):
        radii[(kind, horizon)] = conformal_radius(group['actual'] - group['prediction'])
    testing['radius'] = [radii.get((row.model, row.horizon)) for row in testing.itertuples()]
    testing['lower'] = (testing['prediction'] - testing['radius']).clip(0, 100)
    testing['upper'] = (testing['prediction'] + testing['radius']).clip(0, 100)
    reports = {kind: summarize(group) for kind, group in testing.groupby('model')}
    selection = select_candidate(reports)
    selection.update({'testStart': args.test_start, 'testEndExclusive': end.date().isoformat(),
                      'inputSha256': hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
                      'cadenceDays': args.stride,
                      'scores': {kind: {'mae': report['mae'], 'equalModeScore': report['equalModeScore'],
                                        'equalModeBusyMae': report['equalModeBusyMae']} for kind, report in reports.items()}})
    report = {'selection': selection, 'observations': len(readings), 'anomalyFlags': int(readings['anomaly'].sum()),
              'calendar': 'Europe/Berlin; 15-minute open slots weekdays [06:00,22:00), weekends [07:00,22:00)',
              'training': 'Expanding history, daily midnight fit; observations strictly before issue time.',
              'calibration': {'start': args.tune_start, 'endExclusive': args.test_start,
                              'originCadenceDays': args.tune_stride, 'radii': {f'{kind}/{key}': radius for (kind, key), radius in radii.items()}},
              'models': reports, 'sensitivityWithoutFlaggedTargets': {
                  kind: summarize(group.loc[~group['anomaly']], include_quiet=False) for kind, group in testing.groupby('model')},
              'limitations': ['Reconstructed historical forecasts; no issued historical forecasts exist.',
                             'Legacy reference preserves original UTC/local mismatch and Prophet configuration on the common validated sample.',
                             'Observed weather is deliberately excluded; historical forecast weather was not recorded.',
                             'Future public-holiday opening-hour exceptions are not known; standard weekday/weekend hours apply.',
                             'Intervals use pre-test calibration; nominal 80% is not a guarantee under distribution shift.',
                             'School/public holidays use the known Bavarian calendar, not future measured metadata.']}
    (output / 'benchmark-report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + '\n')
    (output / 'selection.json').write_text(json.dumps(selection, indent=2, ensure_ascii=False, allow_nan=False) + '\n')
    testing.to_csv(output / 'benchmark-predictions.csv.gz', index=False)
    print(json.dumps(selection, indent=2), flush=True)
    if args.selection:
        Path(args.selection).write_text(json.dumps(deployment_selection(selection), indent=2, ensure_ascii=False, allow_nan=False) + '\n')


def evaluate_ledger(args):
    readings = load_export(args.input)
    until = pd.Timestamp(args.until, tz=BERLIN) if args.until else pd.Timestamp.now(tz=BERLIN).normalize()
    since = until - pd.DateOffset(days=28)
    ledger = ForecastLedger(args.ledger)
    rows = ledger.evaluated_rows(readings, since, until)
    result = {'start': iso_utc(since), 'endExclusive': iso_utc(until), 'windowDays': 28,
              'forecastRows': len(rows), 'status': 'insufficient_data' if rows.empty else 'evaluated'}
    if not rows.empty:
        # Keep one observation per model/target/horizon: latest valid issue within that horizon.
        # Dashboard traffic therefore cannot change the relative weighting of targets.
        rows = rows.sort_values('issued_at').drop_duplicates(['model_version', 'target_at', 'horizon'], keep='last')
        rows = rows.rename(columns={'percentage': 'prediction', 'y': 'actual'})
        rows['targetAt'] = pd.to_datetime(rows['target_at'], unit='s', utc=True)
        rows['issuedAt'] = pd.to_datetime(rows['issued_at'], unit='s', utc=True)
        rows['targetDate'] = rows['targetAt'].dt.tz_convert(BERLIN).dt.date.astype(str)
        result['models'] = {kind: summarize(group) for kind, group in rows.groupby('model_version')}
        paired = rows.loc[rows['weather_status'].eq('applied') & rows['baseline_percentage'].notna()]
        result['weatherComparison'] = {
            'scope': 'Same-issued live weather forecast versus its stored calendar-only baseline.',
            'pairedRows': len(paired),
            'models': {kind: {
                'activeWeather': statistics(group),
                'calendarBaseline': statistics(group.assign(prediction=group['baseline_percentage']))
            } for kind, group in paired.groupby('model_version')}
        }
    Path(args.output).write_text(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False) + '\n')
    print(json.dumps(result, indent=2), flush=True)


def main():
    logging.getLogger('cmdstanpy').setLevel(logging.WARNING)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    bench = commands.add_parser('backtest')
    bench.add_argument('--input', required=True)
    bench.add_argument('--output', required=True)
    bench.add_argument('--selection', help='Optional compact deployable selection artifact (no raw readings).')
    bench.add_argument('--tune-start', default='2026-03-01')
    bench.add_argument('--test-start', default='2026-07-01')
    bench.add_argument('--end', help='Exclusive end date; defaults to day after final measurement.')
    bench.add_argument('--tune-stride', type=int, default=7)
    bench.add_argument('--stride', type=int, default=1)
    audit = commands.add_parser('evaluate-ledger')
    audit.add_argument('--input', required=True, help='Current measurement export.')
    audit.add_argument('--ledger', required=True)
    audit.add_argument('--until', help='Exclusive Berlin date; defaults to today.')
    audit.add_argument('--output', required=True)
    args = parser.parse_args()
    run_benchmark(args) if args.command == 'backtest' else evaluate_ledger(args)

if __name__ == '__main__':
    main()
