"""Synthetic tests for real forecast availability, weather response and provenance."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
os.environ['PREDICTOR_TESTING'] = '1'
import numpy as np
import pandas as pd
from app import ForecastService
from calendar_features import BERLIN, day_slots, normalize_readings
from ledger import ForecastLedger
from models import Calibration, WeightedProfile
from weather import WeatherCache, WeatherResponse, fetch_weather, interval_envelope, parse_hours


def payload(start='2026-10-07T12:00Z', length=36):
    times = pd.date_range(start, periods=length, freq='h')
    return {'hourly': {'time': [int(time.timestamp()) for time in times],
        'temperature_2m': [25.] * length, 'precipitation': [0.4] * length,
        'rain': [0.4] * length, 'cloud_cover': [40.] * length}}


def historical_weather(days=56):
    values = []
    for index, day in enumerate(pd.date_range('2026-07-01', periods=days)):
        for target in day_slots(day.date()):
            temp = 8 + (index % 11) * 2 + (target.hour - 6) * .2
            values.append({'timestamp': (target + pd.Timedelta(minutes=2)).isoformat(),
                           'percentage': 30 + target.weekday() - .6 * (temp - 15) - .7 * max(0, temp - 25),
                           'temperature': temp, 'precipitation': .2 if index % 4 == 0 else 0,
                           'isRaining': int(index % 4 == 0), 'cloudCover': 20 + index % 7 * 10})
    rows = normalize_readings(values)
    rows['calendar_prediction'] = 30 + rows['local'].dt.weekday
    return rows


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.now = pd.Timestamp('2026-10-07T12:01:00.100Z')

    def test_only_weather_available_at_issue_is_used(self):
        cache = WeatherCache(fetcher=lambda: payload(), clock=lambda: self.now)
        self.assertTrue(cache.refresh())
        target = pd.Timestamp('2026-10-07T13:15Z')
        self.assertIsNone(cache.at(target, self.now - pd.Timedelta(seconds=1)))
        weather = cache.at(target, self.now)
        self.assertEqual(weather['source'], 'forecast')
        self.assertEqual(weather['temperature'], 25)
        self.assertEqual(weather['targetAt'], '2026-10-07T13:00:00Z')
        self.assertIsNone(weather['providerIssuedAt'])
        self.assertIsNone(cache.at(self.now, self.now))

    def test_stale_and_missing_forecasts_fall_back(self):
        cache = WeatherCache(fetcher=lambda: payload(), clock=lambda: self.now)
        cache.refresh()
        self.assertIsNone(cache.at(pd.Timestamp('2026-10-07T21:00Z'), self.now + pd.Timedelta(hours=7)))
        self.assertIsNone(cache.at(pd.Timestamp('2026-10-15T13:00Z'), self.now))

    def test_failed_refresh_preserves_last_valid_cache_and_read_never_fetches(self):
        calls = []
        def fetch():
            calls.append(1)
            if len(calls) > 1:
                raise TimeoutError('timed out')
            return payload()
        cache = WeatherCache(fetcher=fetch, clock=lambda: self.now)
        cache.refresh()
        with self.assertLogs('weather', level='WARNING'):
            self.assertFalse(cache.refresh())
        self.assertIsNotNone(cache.at(pd.Timestamp('2026-10-07T13:00Z'), self.now))
        self.assertEqual(len(calls), 2)

    def test_socket_timeout_and_size_limit(self):
        with patch('weather.urlopen', side_effect=TimeoutError('timeout')) as open_url:
            with self.assertRaises(TimeoutError):
                fetch_weather()
            self.assertEqual(open_url.call_args.kwargs['timeout'], 5)
        with patch('weather.urlopen') as open_url:
            open_url.return_value.__enter__.return_value.read.return_value = b'x' * 262145
            with self.assertRaises(ValueError):
                fetch_weather()

    def test_malformed_forecast_does_not_replace_cache(self):
        wrong = payload()
        wrong['hourly']['temperature_2m'] = []
        with self.assertRaises(ValueError):
            parse_hours(wrong)
        wrong = payload()
        wrong['hourly_units'] = {'temperature_2m': '°F'}
        with self.assertRaises(ValueError):
            parse_hours(wrong)

    def test_cache_survives_restart_with_original_availability(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'weather.json'
            cache = WeatherCache(path, fetcher=lambda: payload(), clock=lambda: self.now)
            cache.refresh()
            restored = WeatherCache(path, fetcher=lambda: self.fail('Reading should not fetch'), clock=lambda: self.now)
            self.assertEqual(restored.at(pd.Timestamp('2026-10-07T13:00Z'), self.now)['fetchedAt'], self.now.isoformat().replace('+00:00', 'Z'))


class WeatherResponseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = historical_weather()
        cls.cutoff = pd.Timestamp('2026-08-26', tz=BERLIN)

    def forecast(self, temperature=20):
        return {'temperature': temperature, 'precipitation': .4, 'rain': .4, 'cloudCover': 40,
                'fetchedAt': '2026-10-07T12:00:00Z'}

    def test_temperature_changes_active_prediction_with_bounded_effect(self):
        model = WeatherResponse().fit(self.rows, self.rows, self.cutoff)
        self.assertIsNotNone(model.coefficients)
        target, issued = pd.Timestamp('2026-10-07T15:00Z'), pd.Timestamp('2026-10-07T12:01Z')
        hot = model.correction(self.forecast(35), target, issued)
        cool = model.correction(self.forecast(10), target, issued)
        self.assertLess(hot, cool)
        self.assertLessEqual(abs(hot), 3)
        self.assertLessEqual(abs(cool), 3)
        self.assertEqual(model.correction(None, target, issued), 0)
        self.assertEqual(model.correction(self.forecast(), target, pd.Timestamp('2026-10-07T11:59Z')), 0)

    def test_future_observed_weather_cannot_change_coefficients(self):
        cutoff = pd.Timestamp('2026-08-10', tz=BERLIN)
        first = WeatherResponse().fit(self.rows, self.rows, cutoff)
        changed = self.rows.copy()
        changed.loc[changed['observed_at'] >= cutoff, ['temperature', 'y']] = 100
        second = WeatherResponse().fit(changed, changed, cutoff)
        np.testing.assert_allclose(first.coefficients, second.coefficients)
        np.testing.assert_allclose(first.center, second.center)

    def test_training_provenance_includes_newer_hour_reference_observations(self):
        residuals = self.rows.loc[self.rows['observed_at'] < pd.Timestamp('2026-08-20', tz=BERLIN)]
        model = WeatherResponse().fit(residuals, self.rows, self.cutoff)
        self.assertEqual(model.trained_through, self.rows['observed_at'].max())
        self.assertGreater(model.trained_through, residuals['observed_at'].max())

    def test_missing_historical_weather_does_not_invent_an_effect(self):
        rows = self.rows.copy()
        rows['temperature'] = np.nan
        response = WeatherResponse().fit(rows, rows, self.cutoff)
        self.assertIsNone(response.coefficients)

    def test_bands_enclose_calendar_and_weather_shift(self):
        self.assertEqual(interval_envelope(10, 20, -3), (7, 20))
        self.assertEqual(interval_envelope(10, 20, 3), (10, 23))
        self.assertEqual(interval_envelope(None, None, 3), (None, None))

    def test_amount_regressor_is_omitted_for_mismatched_aggregation(self):
        first = WeatherResponse().fit(self.rows, self.rows, self.cutoff)
        changed = self.rows.copy()
        changed['precipitation'] *= 4
        second = WeatherResponse().fit(changed, changed, self.cutoff)
        np.testing.assert_allclose(first.coefficients, second.coefficients)

    def test_actual_service_persists_paired_baseline_and_weather(self):
        with tempfile.TemporaryDirectory() as folder:
            issued = pd.Timestamp('2026-10-07T12:01:00.500Z')
            cache = WeatherCache(fetcher=lambda: payload(), clock=lambda: issued - pd.Timedelta(milliseconds=200))
            cache.refresh()
            ledger = ForecastLedger(Path(folder) / 'forecasts.db')
            service = ForecastService(loader=lambda: self.rows, ledger=ledger, clock=lambda: issued, weather_cache=cache)
            baseline = WeightedProfile().fit(self.rows, self.cutoff)
            response = WeatherResponse().fit(self.rows, self.rows, self.cutoff)
            key_without_response = service.future_capture_key(issued)
            service.current = {'model': baseline, 'readings': self.rows, 'kind': 'weighted_profile',
                'trainedThrough': baseline.trained_through, 'modelVersion': 'test-weather-v1', 'weatherModel': response,
                'calibration': Calibration({'minute_15': 3, 'minute_60': 3, 'minute_180': 4}, {})}
            key_with_response = service.future_capture_key(issued)
            self.assertNotEqual(key_without_response, key_with_response)
            cache.fetched_at -= pd.Timedelta(seconds=1)
            self.assertNotEqual(service.future_capture_key(issued), key_with_response)
            result, status = service.predict(issued.tz_convert(BERLIN).date())
            self.assertEqual(status, 200)
            points = result['predictions']
            self.assertTrue(any(abs(point['weatherAdjustment']) > .01 for point in points))
            point = points[0]
            self.assertEqual(point['weatherStatus'], 'applied')
            self.assertEqual(point['intervalCalibration'], 'calendar_envelope')
            self.assertLessEqual(pd.Timestamp(point['weather']['fetchedAt']), pd.Timestamp(point['issuedAt']))
            self.assertAlmostEqual(point['baselinePercentage'] + point['weatherAdjustment'], point['percentage'], places=1)
            self.assertEqual(ledger.for_day(issued.tz_convert(BERLIN).date())[0]['weather'], point['weather'])
            cache.hours = {}
            later, status = service.predict(issued.tz_convert(BERLIN).date(), issued + pd.Timedelta(minutes=15))
            future = [item for item in later['predictions'] if pd.Timestamp(item['targetAt']) > issued + pd.Timedelta(minutes=15)]
            self.assertTrue(all(item['weatherStatus'] == 'forecast_unavailable' for item in future))
            self.assertTrue(all(item['percentage'] == item['baselinePercentage'] for item in future))


if __name__ == '__main__':
    unittest.main()
