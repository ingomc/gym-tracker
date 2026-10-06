"""Issued hourly weather cache and a bounded weather response for calendar forecasts.

Primary API definitions: https://open-meteo.com/en/docs
The hourly API does not provide the initialization time of its stitched model runs.
We record retrieval completion as availability, never fabricate a provider issue time.
"""
import json
import logging
import math
import threading
from pathlib import Path
from urllib.request import urlopen
import numpy as np
import pandas as pd
from calendar_features import BERLIN, before, iso_utc
from models import make_model

LOGGER = logging.getLogger(__name__)
WEATHER_VERSION = 'weather-response-v1'
WEATHER_URL = ('https://api.open-meteo.com/v1/forecast?latitude=50.2612&longitude=10.9628'
               '&hourly=temperature_2m,precipitation,rain,cloud_cover'
               '&forecast_days=9&timezone=UTC&timeformat=unixtime'
               '&temperature_unit=celsius&precipitation_unit=mm')
MAX_BYTES = 262144
WEATHER_COLUMNS = ['temperature', 'precipitation', 'cloud_cover', 'is_raining']


def fetch_weather():
    # Runs exclusively on the weather worker. Limit both socket waits and response size.
    with urlopen(WEATHER_URL, timeout=5) as response:
        payload = response.read(MAX_BYTES + 1)
    if len(payload) > MAX_BYTES:
        raise ValueError('Weather response exceeds 256 KiB')
    return json.loads(payload)


def parse_hours(payload):
    hourly = payload.get('hourly', {})
    names = ('time', 'temperature_2m', 'precipitation', 'rain', 'cloud_cover')
    arrays = [hourly.get(name) for name in names]
    if not all(isinstance(values, list) for values in arrays):
        raise ValueError('Missing hourly forecast arrays')
    if len({len(values) for values in arrays}) != 1 or not 1 <= len(arrays[0]) <= 240:
        raise ValueError('Invalid hourly forecast lengths')
    units = payload.get('hourly_units', {})
    for key, expected in [('temperature_2m', '°C'), ('precipitation', 'mm'), ('rain', 'mm'), ('cloud_cover', '%')]:
        if key in units and units[key] != expected:
            raise ValueError('Unexpected weather units')
    hours = {}
    for stamp, temperature, precipitation, rain, cloud in zip(*arrays):
        values = (stamp, temperature, precipitation, rain, cloud)
        if not all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in values):
            continue
        if stamp % 3600 or not (-70 <= temperature <= 65 and 0 <= precipitation <= 300
                                 and 0 <= rain <= 300 and 0 <= cloud <= 100):
            continue
        hours[int(stamp)] = {'temperature': float(temperature), 'precipitation': float(precipitation),
                             'rain': float(rain), 'cloudCover': float(cloud)}
    if not hours:
        raise ValueError('No valid hourly weather forecast')
    return hours


class WeatherCache:
    def __init__(self, path=None, fetcher=fetch_weather, clock=None):
        self.path = Path(path) if path else None
        self.fetcher = fetcher
        self.clock = clock or (lambda: pd.Timestamp.now(tz='UTC'))
        self.lock = threading.Lock()
        self.hours, self.fetched_at, self.last_error = {}, None, None
        self.refreshing = False
        self.stop_event = threading.Event()
        self.started = False
        if self.path and self.path.exists():
            try:
                cached = json.loads(self.path.read_text())
                self.hours = parse_hours(cached['payload'])
                self.fetched_at = pd.Timestamp(cached['fetchedAt'])
                if self.fetched_at.tzinfo is None:
                    raise ValueError('Cache availability must include a timezone')
            except (OSError, ValueError, KeyError, TypeError):
                self.hours, self.fetched_at = {}, None

    def refresh(self):
        with self.lock:
            if self.refreshing:
                return False
            self.refreshing = True
        try:
            payload = self.fetcher()
            hours = parse_hours(payload)
            fetched = pd.Timestamp(self.clock())
            if self.path:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.path.with_suffix('.tmp')
                temporary.write_text(json.dumps({'fetchedAt': iso_utc(fetched), 'payload': payload}, allow_nan=False))
                temporary.replace(self.path)
            with self.lock:
                self.hours, self.fetched_at, self.last_error = hours, fetched, None
            return True
        except Exception as error:
            with self.lock:
                self.last_error = str(error)
            LOGGER.warning('Weather refresh failed; calendar forecasts remain available: %s', error)
            return False
        finally:
            with self.lock:
                self.refreshing = False

    def start(self):
        with self.lock:
            if self.started:
                return
            self.started = True
        threading.Thread(target=self._worker, name='weather-forecast-cache', daemon=True).start()

    def _worker(self):
        while not self.stop_event.is_set():
            successful = self.refresh()
            if self.stop_event.wait(1800 if successful else 300):
                break

    def at(self, target, issued_at):
        target, issued = pd.Timestamp(target), pd.Timestamp(issued_at)
        with self.lock:
            fetched, hours = self.fetched_at, self.hours
        if (fetched is None or fetched > issued or target <= issued
                or issued - fetched > pd.Timedelta(hours=6)):
            return None
        stamp = int(target.floor('h').timestamp())
        value = hours.get(stamp)
        if value is None:
            return None
        # Hourly temperature/cloud apply at this hour. Precipitation/rain are sums
        # over the preceding hour, exactly as returned by the provider (not observations).
        return {**value, 'fetchedAt': iso_utc(fetched), 'targetAt': iso_utc(pd.Timestamp(stamp, unit='s', tz='UTC')),
                'providerIssuedAt': None, 'provider': 'open-meteo', 'source': 'forecast'}


def weather_features(rows):
    # Historical current amounts cover 15 minutes; forecasts are hourly sums.
    # Omit the amount regressor rather than invent comparable aggregation metadata.
    temperature = rows['temperature'].to_numpy(float)
    return np.column_stack([temperature / 10, np.maximum(temperature - 25, 0) / 10,
        rows['is_raining'].to_numpy(float), rows['cloud_cover'].to_numpy(float) / 100])


def partial_out(values, groups):
    result = np.asarray(values, dtype=float).copy()
    for _ in range(12):
        for group in groups:
            _, inverse = np.unique(group, return_inverse=True)
            count = np.bincount(inverse)
            sums = np.zeros((len(count), result.shape[1]))
            np.add.at(sums, inverse, result)
            result -= (sums / count[:, None])[inverse]
    return result


class WeatherResponse:
    """Associational, shrunk response; actual future forecast skill is audited prospectively."""
    def __init__(self):
        self.coefficients = None
        self.trained_through = None
        self.training_days = 0

    def fit(self, residuals, available_readings, cutoff):
        rows = before(residuals, cutoff).dropna(subset=WEATHER_COLUMNS + ['calendar_prediction']).copy()
        rows = rows.loc[rows['temperature'].between(-70, 65) & rows['precipitation'].between(0, 300)
                        & rows['cloud_cover'].between(0, 100) & rows['is_raining'].isin([0, 1])]
        self.training_days = rows['local'].dt.date.nunique()
        if len(rows) < 500 or self.training_days < 28:
            return self
        x = weather_features(rows)
        y = (rows['y'] - rows['calendar_prediction']).to_numpy(float)
        groups = [rows['local'].dt.weekday.to_numpy() * 24 + rows['local'].dt.hour.to_numpy(),
                  rows['local'].dt.year.to_numpy() * 27 + rows['local'].dt.dayofyear.to_numpy() // 14]
        partial = partial_out(np.column_stack([x, y]), groups)
        xr, yr = partial[:, :-1], partial[:, -1]
        # Temperature/heat have the robust signal in the observed-weather diagnostic;
        # rain/cloud receive ten times stronger regularization, never assumed signs.
        penalty = np.diag([.1, .1, 1, 1]) * len(rows)
        self.coefficients = np.linalg.solve(xr.T @ xr + penalty, xr.T @ yr)
        self.low, self.high = np.quantile(x, [.01, .99], axis=0)
        self.trained_through = rows['observed_at'].max()
        history = before(available_readings, cutoff).dropna(subset=WEATHER_COLUMNS)
        history = history.loc[history['timestamp'] >= pd.Timestamp(cutoff) - pd.Timedelta(days=28)]
        if history.empty:
            self.coefficients = None
            return self
        self.trained_through = max(self.trained_through, history['observed_at'].max())
        hx = weather_features(history)
        self.center = hx.mean(axis=0)
        self.hour_centers = {hour: hx[history['local'].dt.hour.to_numpy() == hour].mean(axis=0)
                             for hour in history['local'].dt.hour.unique()}
        return self

    def correction(self, weather, target, issued_at):
        if (self.coefficients is None or self.trained_through is None
                or self.trained_through >= pd.Timestamp(issued_at) or weather is None
                or pd.Timestamp(weather['fetchedAt']) > pd.Timestamp(issued_at)
                or pd.Timestamp(target) <= pd.Timestamp(issued_at)):
            return 0.0
        row = pd.DataFrame([{'temperature': weather['temperature'], 'precipitation': weather['precipitation'],
                             'cloud_cover': weather['cloudCover'], 'is_raining': int(weather['rain'] > 0)}])
        features = np.clip(weather_features(row)[0], self.low, self.high)
        center = self.hour_centers.get(pd.Timestamp(target).tz_convert(BERLIN).hour, self.center)
        return float(np.clip(.5 * ((features - center) @ self.coefficients), -3, 3))


def train_weather_response(readings, cutoff, kind):
    """Past-only weekly-origin errors across 16 weeks, independent of local audit files."""
    eligible = before(readings, cutoff)
    if not all(column in eligible for column in WEATHER_COLUMNS):
        return WeatherResponse()
    eligible_weather = eligible.dropna(subset=WEATHER_COLUMNS)
    if len(eligible_weather) < 500 or eligible_weather['local'].dt.date.nunique() < 28:
        return WeatherResponse()
    end = pd.Timestamp(cutoff).tz_convert(BERLIN).normalize()
    residuals = []
    for weeks_ago in range(16, 0, -1):
        origin = end - pd.DateOffset(days=weeks_ago * 7 + 1)
        training = before(eligible, origin)
        held = eligible_weather.loc[(eligible_weather['timestamp'] >= origin + pd.DateOffset(days=1))
                                     & (eligible_weather['timestamp'] < origin + pd.DateOffset(days=8))].copy()
        if len(training) < 200 or held.empty:
            continue
        calendar = make_model(kind).fit(training, origin)
        held['calendar_prediction'] = calendar.predict(held['timestamp'])
        residuals.append(held)
    if not residuals:
        return WeatherResponse()
    return WeatherResponse().fit(pd.concat(residuals), eligible_weather, cutoff)


def interval_envelope(lower, upper, adjustment):
    if lower is None or upper is None:
        return None, None
    return round(max(0, min(lower, lower + adjustment)), 2), round(min(100, max(upper, upper + adjustment)), 2)
