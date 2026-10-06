"""Local observed-weather diagnostic; never an authentic forecast-weather backtest.

Calendar predictions must be chronological benchmark outputs. Weather coefficients
are fit only on completed past months; future actual weather is used solely as an
oracle diagnostic. Aggregated results belong in ignored Archiv/, never in Git.
"""
import argparse
import json
from pathlib import Path
import numpy as np
import pandas as pd

FEATURES = ['temperaturePer10C', 'heatAbove25Per10C', 'rainFlag', 'logPrecipitation', 'cloudFraction']


def features(rows):
    temperature = rows['temperature'].to_numpy(float)
    return np.column_stack([temperature / 10, np.maximum(temperature - 25, 0) / 10,
        rows['isRaining'].to_numpy(float), np.log1p(rows['precipitation'].to_numpy(float)),
        rows['cloudCover'].to_numpy(float) / 100])


def residualize(values, groups):
    """Two-way fixed-effect removal: weekday/hour and calendar fortnight."""
    result = np.asarray(values, dtype=float).copy()
    for _ in range(12):
        for group in groups:
            ids, inverse = np.unique(group, return_inverse=True)
            count = np.bincount(inverse, minlength=len(ids))
            sums = np.zeros((len(ids), result.shape[1]))
            np.add.at(sums, inverse, result)
            result -= (sums / count[:, None])[inverse]
    return result


def fit_weather(rows):
    x = features(rows)
    y = (rows['actual'] - rows['prediction']).to_numpy(float)
    groups = [rows['weekdayHour'].to_numpy(), rows['fortnight'].to_numpy()]
    partial = residualize(np.column_stack([x, y]), groups)
    xr, yr = partial[:, :-1], partial[:, -1]
    # Fixed standardized feature units and strong ridge prevent rare rain/heat
    # observations or collinear temperature/cloud features driving extrapolation.
    beta = np.linalg.solve(xr.T @ xr + np.eye(x.shape[1]) * len(rows) * .1, xr.T @ yr)
    return beta, xr, yr


def correction(training, testing, beta, strength=.5):
    # Compare target weather with recent weather at that studio hour, not with
    # an absolute zero-temperature/clear-sky reference. Centers use past only.
    cutoff = training['targetAt'].max() - pd.Timedelta(days=28)
    history = training.loc[training['targetAt'] >= cutoff]
    history_x = features(history)
    global_center = history_x.mean(axis=0)
    centers = {hour: history_x[history['hour'].to_numpy() == hour].mean(axis=0)
               for hour in history['hour'].unique()}
    expected = np.array([centers.get(hour, global_center) for hour in testing['hour']])
    x = features(testing)
    # Empirical support bounds contain weather scenarios seen during fitting.
    low, high = np.quantile(features(training), [.01, .99], axis=0)
    x = np.clip(x, low, high)
    return np.clip(strength * ((x - expected) @ beta), -3, 3)


def metrics(rows, prediction):
    residual = prediction - rows['actual'].to_numpy()
    busy = rows['actual'].to_numpy() >= 25
    return {'count': len(rows), 'mae': float(np.abs(residual).mean()),
            'bias': float(residual.mean()), 'p90': float(np.quantile(np.abs(residual), .9)),
            'busyMae': float(np.abs(residual[busy]).mean()) if busy.any() else None}


def run(args):
    payload = json.loads(Path(args.input).read_text())
    raw = pd.DataFrame(payload['readings'])
    raw['observedAt'] = pd.to_datetime(raw['timestamp'], utc=True)
    raw['targetAt'] = raw['observedAt'].dt.floor('15min')
    raw = raw.sort_values('observedAt').drop_duplicates('targetAt', keep='last')
    columns = ['temperature', 'precipitation', 'cloudCover', 'isRaining']
    coverage = {column: {'observations': int(raw[column].notna().sum()),
                        'fraction': float(raw[column].notna().mean()),
                        'min': float(raw[column].min()), 'max': float(raw[column].max())}
                for column in columns}
    full_year = raw.dropna(subset=columns).copy()
    full_local = full_year['observedAt'].dt.tz_convert('Europe/Berlin')
    full_year = full_year.loc[(full_local.dt.hour >= np.where(full_local.dt.weekday >= 5, 7, 6))
                             & (full_local.dt.hour < 22)].copy()
    full_local = full_year['observedAt'].dt.tz_convert('Europe/Berlin')
    full_year['weekdayHour'] = full_local.dt.weekday * 24 + full_local.dt.hour
    full_year['fortnight'] = full_local.dt.dayofyear // 14
    full_year['actual'], full_year['prediction'] = full_year['percentage'], 0
    full_beta, full_x, full_y = fit_weather(full_year)
    full_year_relationship = {'scope': 'Descriptive fixed-effect regression on all open-hour observations; not held out.',
        'observations': len(full_year), 'days': full_local.dt.date.nunique(),
        'rainObservations': int(full_year['isRaining'].sum()),
        'controlledRidgeCoefficients': dict(zip(FEATURES, full_beta.tolist())),
        'partialCorrelations': {feature: float(np.corrcoef(full_x[:, index], full_y)[0, 1])
                                for index, feature in enumerate(FEATURES)}}
    benchmark = pd.read_csv(args.benchmark)
    benchmark = benchmark.loc[benchmark['model'].eq('corrected_prophet') & benchmark['horizon'].eq('minute_60')].copy()
    benchmark['targetAt'] = pd.to_datetime(benchmark['targetAt'], utc=True)
    rows = benchmark.merge(raw[['targetAt', 'observedAt'] + columns], on='targetAt', validate='one_to_one').dropna(subset=columns)
    local = rows['targetAt'].dt.tz_convert('Europe/Berlin')
    rows['hour'] = local.dt.hour
    rows['weekdayHour'] = local.dt.weekday * 24 + local.dt.hour
    rows['fortnight'] = (local.dt.dayofyear // 14).astype(int)
    rows['day'] = local.dt.date.astype(str)
    rows['month'] = local.dt.strftime('%Y-%m')
    y = rows['actual'] - rows['prediction']
    bins = pd.cut(rows['temperature'], [-100, 10, 20, 25, 30, 100], right=False)
    descriptive = []
    for label, group in rows.assign(residual=y, temperatureBin=bins).groupby('temperatureBin', observed=True):
        descriptive.append({'temperatureBin': str(label), 'count': len(group), 'days': group['day'].nunique(),
                            'meanCalendarResidual': float(group['residual'].mean())})
    beta, xr, yr = fit_weather(rows)
    partial_correlations = {feature: float(np.corrcoef(xr[:, index], yr)[0, 1])
                            for index, feature in enumerate(FEATURES)}
    evaluations, combined, monthly_coefficients = [], [], {}
    months = sorted(rows['month'].unique())
    for month in months[1:]:
        issue = pd.Timestamp(month + '-01', tz='Europe/Berlin')
        training = rows.loc[rows['observedAt'] < issue]
        testing = rows.loc[rows['month'].eq(month)].copy()
        month_beta, _, _ = fit_weather(training)
        adjustment = correction(training, testing, month_beta)
        predicted = np.clip(testing['prediction'].to_numpy() + adjustment, 0, 100)
        monthly_coefficients[month] = dict(zip(FEATURES, month_beta.tolist()))
        evaluations.append({'testMonth': month, 'trainingDays': training['day'].nunique(),
                            'testDays': testing['day'].nunique(), 'baseline': metrics(testing, testing['prediction'].to_numpy()),
                            'observedWeatherOracle': metrics(testing, predicted),
                            'meanAbsoluteAdjustment': float(np.abs(adjustment).mean()),
                            'maxAbsoluteAdjustment': float(np.abs(adjustment).max())})
        testing['weatherPrediction'] = predicted
        testing['weatherAdjustment'] = adjustment
        combined.append(testing)
    holdout = pd.concat(combined)
    seasonal = [{'month': month, 'temperatureMean': float(group['temperature'].mean()),
                 'rainFraction': float(group['isRaining'].mean()), 'days': group['day'].nunique()}
                for month, group in rows.groupby('month')]
    result = {'scope': 'Observed-weather oracle diagnostic, not weather-forecast accuracy or causal evidence.',
        'calendarBaseline': 'Chronological corrected Prophet, 60-minute horizon, daily fit strictly before target day.',
        'controls': ['weekday by studio hour', '14-day calendar blocks'],
        'featureUnits': {'temperaturePer10C': 'per 10°C', 'heatAbove25Per10C': 'per 10°C above 25°C',
                         'rainFlag': 'rain vs dry', 'logPrecipitation': 'log(1 + mm)', 'cloudFraction': '100% vs 0% cloud'},
        'coverage': coverage, 'fullYearControlledRelationship': full_year_relationship,
        'diagnosticRows': len(rows), 'diagnosticDays': rows['day'].nunique(),
        'seasonalConditions': seasonal, 'descriptiveCalendarResiduals': descriptive,
        'partialCorrelations': partial_correlations,
        'controlledRidgeCoefficients': dict(zip(FEATURES, beta.tolist())),
        'pastOnlyMonthlyCoefficients': monthly_coefficients,
        'monthlyObservedWeatherHoldouts': evaluations,
        'heldOutAggregate': {'baseline': metrics(holdout, holdout['prediction'].to_numpy()),
            'observedWeatherOracle': metrics(holdout, holdout['weatherPrediction'].to_numpy())},
        'guardrails': {'ridgePenaltyPerRow': .1, 'effectStrength': .5, 'maximumAbsolutePercentagePoints': 3,
            'weatherReference': 'past 28 days by studio hour', 'featureSupport': 'training 1st–99th percentiles'},
        'limitations': ['Actual target weather is unavailable at forecast issue; this diagnostic is optimistic about weather inputs.',
            'Coefficients describe associations after calendar adjustment, not causal weather effects.',
            'No randomized or final unused test period: do not count this exploratory diagnostic as a deployment-selection gate.',
            'Only July–October have chronological calendar residuals here; January–June still inform raw weather coverage.',
            'Out-of-support heatwaves and cold spells require bounded or zero correction; do not extrapolate linear coefficients.']}
    Path(args.output).write_text(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False) + '\n')
    print(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', default='Archiv/gym-tracker-export-2026-10-06.json')
    parser.add_argument('--benchmark', default='Archiv/benchmark/benchmark-predictions.csv.gz')
    parser.add_argument('--output', default='Archiv/weather-audit.json')
    run(parser.parse_args())
