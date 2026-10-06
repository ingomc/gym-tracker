"""Forecast candidates with identical calendar/availability rules."""
from dataclasses import dataclass
import math
import numpy as np
import pandas as pd
from calendar_features import BERLIN, before, feature_frame, bavarian_holidays, day_info

MODEL_VERSION = 'berlin-quarter-hour-v2'
KINDS = ('legacy_prophet', 'corrected_prophet', 'weighted_profile')


class ProphetCandidate:
    def __init__(self, legacy=False):
        self.kind = 'legacy_prophet' if legacy else 'corrected_prophet'
        self.legacy = legacy
        self.model = None

    def fit(self, readings, cutoff):
        from prophet import Prophet
        train = before(readings, cutoff)
        if len(train) < 50:
            raise ValueError('At least 50 open-slot observations are required')
        self.trained_through = train['observed_at'].max()
        common = dict(growth='flat', yearly_seasonality=False, weekly_seasonality=True,
                      daily_seasonality=self.legacy, seasonality_mode='additive',
                      seasonality_prior_scale=10.0, changepoint_prior_scale=0.001,
                      uncertainty_samples=0)
        if self.legacy:
            # Preserve original UTC-training/local-inference bug as benchmark reference.
            model = Prophet(**common)
            model.add_country_holidays(country_name='DE')
            frame = pd.DataFrame({'ds': train['observed_at'].dt.tz_localize(None), 'y': train['y']})
        else:
            first, last = train['local'].dt.year.min(), train['local'].dt.year.max() + 1
            holiday_rows = [{'ds': pd.Timestamp(day), 'holiday': name}
                            for year in range(first, last + 1)
                            for day, name in bavarian_holidays(year).items()]
            model = Prophet(holidays=pd.DataFrame(holiday_rows), **common)
            for weekday in range(7):
                model.add_seasonality(name=f'daily_{weekday}', period=1, fourier_order=5,
                                      condition_name=f'day_{weekday}')
            model.add_regressor('school_holiday', standardize=False, prior_scale=5.0)
            frame = feature_frame(train['timestamp'])
            frame['y'] = train['y'].to_numpy()
        model.fit(frame, seed=42)
        self.model = model
        return self

    def predict(self, times, issued_at=None, recent=None):
        frame = feature_frame(times)
        return np.clip(self.model.predict(frame)['yhat'].to_numpy(), 0, 100)


class WeightedProfile:
    kind = 'weighted_profile'

    def fit(self, readings, cutoff):
        train = before(readings, cutoff)
        if len(train) < 50:
            raise ValueError('At least 50 open-slot observations are required')
        self.trained_through = train['observed_at'].max()
        age = (pd.Timestamp(cutoff) - train['timestamp']).dt.total_seconds() / 86400
        train['weight'] = np.exp(-np.log(2) * age / 28.0)
        self.profile = {}
        self.fallback = float(np.average(train['y'], weights=train['weight']))
        for (weekday, slot), values in train.groupby(['weekday', 'slot']):
            self.profile[(weekday, slot)] = float(np.average(values['y'], weights=values['weight']))
        # Known calendar effects are estimated from residuals and shrunk for rare days.
        baseline = np.array([self.profile.get((row.weekday, row.slot), self.fallback)
                             for row in train.itertuples()])
        self.effects = {}
        for key in ('isHoliday', 'isSchoolHoliday'):
            flags = np.array([day_info(day)[key] for day in train['local'].dt.date])
            days = len(set(train.loc[flags, 'local'].dt.date))
            self.effects[key] = (float(np.average((train['y'].to_numpy() - baseline)[flags],
                                                 weights=train.loc[flags, 'weight']))
                                 * days / (days + 14)) if days else 0.0
        return self

    def base(self, times):
        local = pd.DatetimeIndex(times).tz_convert(BERLIN)
        return np.array([self.profile.get((dt.weekday(), dt.hour * 4 + dt.minute // 15), self.fallback)
                         + sum(value for key, value in self.effects.items() if day_info(dt.date())[key])
                         for dt in local])

    def predict(self, times, issued_at=None, recent=None):
        predictions = self.base(times)
        if issued_at is not None and recent is not None:
            issued = pd.Timestamp(issued_at)
            available = before(recent, issued)
            available = available.loc[(available['timestamp'] >= issued - pd.Timedelta(hours=2))
                                      & (available['local'].dt.date == issued.tz_convert(BERLIN).date())]
            if len(available) >= 2:
                residuals = available['y'].to_numpy() - self.base(available['timestamp'])
                ages = (issued - available['observed_at']).dt.total_seconds().to_numpy() / 3600
                correction = np.clip(np.average(residuals, weights=np.exp(-ages)), -12, 12)
                horizons = (pd.DatetimeIndex(times) - issued).total_seconds().to_numpy() / 3600
                same_day = np.array([dt.date() == issued.tz_convert(BERLIN).date()
                                     for dt in pd.DatetimeIndex(times).tz_convert(BERLIN)])
                predictions += 0.65 * correction * np.exp(-np.maximum(horizons, 0) / 3) * same_day
        return np.clip(predictions, 0, 100)

    def predict_issued(self, times, issued_times, recent):
        """Batch variable-issue predictions, retaining each observation's availability."""
        times, issues = pd.DatetimeIndex(times), pd.DatetimeIndex(issued_times)
        result = self.base(times)
        available = recent.sort_values('observed_at')
        observed = available['observed_at'].astype('int64').to_numpy()
        values = available['y'].to_numpy() - self.base(available['timestamp'])
        local_days = available['local'].dt.date.to_numpy()
        for index, (target, issued) in enumerate(zip(times, issues)):
            start = np.searchsorted(observed, (issued - pd.Timedelta(hours=2)).value, side='left')
            stop = np.searchsorted(observed, issued.value, side='left')
            selected = np.arange(start, stop)
            selected = selected[local_days[selected] == issued.tz_convert(BERLIN).date()]
            if len(selected) < 2 or target.tz_convert(BERLIN).date() != issued.tz_convert(BERLIN).date():
                continue
            ages = (issued.value - observed[selected]) / 3.6e12
            correction = np.clip(np.average(values[selected], weights=np.exp(-ages)), -12, 12)
            horizon = max(0, (target - issued).total_seconds() / 3600)
            result[index] += .65 * correction * np.exp(-horizon / 3)
        return np.clip(result, 0, 100)


def make_model(kind):
    if kind == 'weighted_profile':
        return WeightedProfile()
    if kind in ('legacy_prophet', 'corrected_prophet'):
        return ProphetCandidate(legacy=kind == 'legacy_prophet')
    raise ValueError(f'Unknown model {kind}')


def horizon_key(issued_at, target_at):
    issued, target = pd.Timestamp(issued_at), pd.Timestamp(target_at)
    days = (target.tz_convert(BERLIN).date() - issued.tz_convert(BERLIN).date()).days
    if days > 0:
        return f'day_{min(days, 7)}'
    minutes = (target - issued).total_seconds() / 60
    return 'minute_15' if minutes <= 15 else 'minute_60' if minutes <= 60 else 'minute_180'


def conformal_radius(errors, coverage=.8, minimum=50):
    values = np.asarray(errors, dtype=float)
    values = values[np.isfinite(values)]
    if len(values) < minimum:
        return None
    # Finite-sample split-conformal quantile, with deliberately separate calibration data.
    quantile = min(1.0, math.ceil((len(values) + 1) * coverage) / len(values))
    return float(np.quantile(np.abs(values), quantile, method='higher'))


@dataclass
class Calibration:
    radii: dict
    counts: dict

    def bounds(self, point, key):
        radius = self.radii.get(key)
        return (None, None) if radius is None else (round(max(0, point - radius), 2),
                                                  round(min(100, point + radius), 2))


def calibrate(readings, cutoff, kind):
    """Daily fits for intraday errors; three weekly origins for 1–7-day errors."""
    errors = {f'minute_{m}': [] for m in (15, 60, 180)}
    errors.update({f'day_{d}': [] for d in range(1, 8)})
    eligible = before(readings, cutoff)
    end = pd.Timestamp(cutoff).tz_convert(BERLIN).normalize()
    for weeks_ago in (3, 2, 1):
        origin = end - pd.DateOffset(days=weeks_ago * 7 + 1)
        if len(before(eligible, origin)) < 200:
            continue
        model = make_model(kind).fit(eligible, origin)
        held_out = eligible.loc[(eligible['timestamp'] >= origin + pd.DateOffset(days=1))
                                & (eligible['timestamp'] < origin + pd.DateOffset(days=8))]
        if held_out.empty:
            continue
        points = model.predict(held_out['timestamp'])
        for target, actual, point in zip(held_out['timestamp'], held_out['y'], points):
            day_number = (target.tz_convert(BERLIN).date() - origin.date()).days
            errors[f'day_{day_number}'].append(actual - point)
    # Match the daily training cadence used for intraday point forecasts. Reusing
    # week-old fits here would calibrate a different error distribution from production.
    for days_ago in range(7, 0, -1):
        origin = end - pd.DateOffset(days=days_ago)
        if len(before(eligible, origin)) < 200:
            continue
        held_out = eligible.loc[(eligible['timestamp'] >= origin)
                                & (eligible['timestamp'] < origin + pd.DateOffset(days=1))]
        if held_out.empty:
            continue
        model = make_model(kind).fit(eligible, origin)
        points = model.predict(held_out['timestamp'])
        for minutes in (15, 60, 180):
            issued = held_out['timestamp'] - pd.Timedelta(minutes=minutes)
            valid = issued >= origin
            if kind == 'weighted_profile':
                points_now = model.predict_issued(held_out.loc[valid, 'timestamp'], issued.loc[valid], eligible)
            else:
                points_now = points[valid.to_numpy()]
            errors[f'minute_{minutes}'].extend(held_out.loc[valid, 'y'].to_numpy() - points_now)
    return Calibration({key: conformal_radius(values) for key, values in errors.items()},
                       {key: len(values) for key, values in errors.items()})
