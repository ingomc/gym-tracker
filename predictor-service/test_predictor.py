"""Regression tests use synthetic readings only; exports remain local."""
import json
import os
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
os.environ['PREDICTOR_TESTING'] = '1'
import numpy as np
import pandas as pd
from app import ForecastService, create_app, selected_model
from benchmark import forecast_origin, select_candidate, statistics
from calendar_features import BERLIN, before, day_info, day_slots, feature_frame, normalize_readings, parse_date
from ledger import ForecastLedger
from models import MODEL_VERSION, Calibration, ProphetCandidate, WeightedProfile, calibrate, conformal_radius, horizon_key


def synthetic(start='2026-01-01', days=35):
    rows = []
    for day in pd.date_range(start, periods=days):
        for target in day_slots(day.date()):
            rows.append({'timestamp': (target + pd.Timedelta(minutes=2)).isoformat(),
                         'percentage': 10 + target.weekday() + max(0, 12 - abs(target.hour - 17) * 3)})
    return normalize_readings(rows)


class CalendarTests(unittest.TestCase):
    def test_berlin_clock_changes_without_shift(self):
        frame = normalize_readings([
            {'timestamp': '2026-03-27T17:02:00Z', 'percentage': 17},
            {'timestamp': '2026-03-30T16:02:00Z', 'percentage': 18}])
        self.assertEqual(frame['slot'].tolist(), [72, 72])
        self.assertEqual(feature_frame(frame['timestamp'])['ds'].dt.hour.tolist(), [18, 18])

    def test_open_slots_and_real_zero(self):
        frame = normalize_readings([
            {'timestamp': '2026-03-30T03:45:00Z', 'percentage': 5},
            {'timestamp': '2026-03-30T04:01:00Z', 'percentage': 0},
            {'timestamp': '2026-03-30T20:00:00Z', 'percentage': 18},
            {'timestamp': '2026-03-30T05:00:00Z', 'percentage': 999}])
        self.assertEqual(frame['y'].tolist(), [0])

    def test_weekend_opening_is_seven(self):
        slots = day_slots(date(2026, 10, 10))
        self.assertEqual((len(slots), slots[0].hour), (60, 7))
        frame = normalize_readings([
            {'timestamp': '2026-10-10T04:15:00Z', 'percentage': 8},
            {'timestamp': '2026-10-10T05:15:00Z', 'percentage': 0}])
        self.assertEqual(frame['y'].tolist(), [0])

    def test_duplicate_timestamp_and_slot_last_measurement(self):
        frame = normalize_readings([
            {'timestamp': '2026-10-05T10:00:00Z', 'percentage': 5},
            {'timestamp': '2026-10-05T10:00:00Z', 'percentage': 6},
            {'timestamp': '2026-10-05T10:09:00Z', 'percentage': 8}])
        self.assertEqual(frame['y'].tolist(), [8])
        self.assertEqual(frame['observed_at'].iloc[0].minute, 9)
        self.assertTrue(before(frame, pd.Timestamp('2026-10-05T10:08Z')).empty)

    def test_numeric_sqlite_timestamps_are_seconds(self):
        stamp = pd.Timestamp('2026-10-05T10:02:00Z')
        frame = normalize_readings([{'timestamp': int(stamp.timestamp()), 'percentage': 20}])
        self.assertEqual(frame['observed_at'].iloc[0], stamp)

    def test_strict_date_validation(self):
        for value in ('2026-2-01', '2026-02-30', '2026-01-01junk', 'junk', ''):
            with self.assertRaises(ValueError):
                parse_date(value)
        self.assertEqual(parse_date('2026-10-07'), date(2026, 10, 7))

    def test_bavarian_calendar_and_js_weekday(self):
        self.assertTrue(day_info(date(2026, 1, 6))['isHoliday'])
        self.assertTrue(day_info(date(2026, 1, 5))['isSchoolHoliday'])
        self.assertEqual(day_info(date(2026, 10, 11))['weekday'], 0)

    def test_anomalies_flagged_not_deleted(self):
        frame = normalize_readings([
            {'timestamp': '2026-10-05T10:00:00Z', 'percentage': 5},
            {'timestamp': '2026-10-05T10:15:00Z', 'percentage': 45}])
        self.assertEqual(len(frame), 2)
        self.assertTrue(frame['anomaly'].iloc[1])


class ModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.readings = synthetic()
        cls.cutoff = pd.Timestamp('2026-02-01', tz=BERLIN)

    def test_prophet_training_uses_berlin_and_weekday_profiles(self):
        class CaptureProphet:
            def __init__(self, **options):
                self.options, self.seasons = options, []
            def add_country_holidays(self, **kwargs):
                pass
            def add_seasonality(self, **kwargs):
                self.seasons.append(kwargs)
            def add_regressor(self, *args, **kwargs):
                pass
            def fit(self, frame, **kwargs):
                self.frame = frame
        with patch.dict('sys.modules', {'prophet': SimpleNamespace(Prophet=CaptureProphet)}):
            corrected = ProphetCandidate().fit(self.readings, self.cutoff)
            legacy = ProphetCandidate(legacy=True).fit(self.readings, self.cutoff)
        first_local = self.readings['local'].iloc[0]
        self.assertEqual(corrected.model.frame['ds'].iloc[0].hour, first_local.hour)
        self.assertEqual(legacy.model.frame['ds'].iloc[0].hour, first_local.hour - 1)
        self.assertEqual(len(corrected.model.seasons), 7)
        self.assertFalse(corrected.model.options['daily_seasonality'])
        self.assertIn('school_holiday', corrected.model.frame)

    def test_training_is_strictly_before_issue(self):
        changed = self.readings.copy()
        changed.loc[changed['observed_at'] >= self.cutoff, 'y'] = 100
        first = WeightedProfile().fit(self.readings, self.cutoff)
        second = WeightedProfile().fit(changed, self.cutoff)
        np.testing.assert_allclose(first.predict(day_slots(self.cutoff.date())), second.predict(day_slots(self.cutoff.date())))
        self.assertLess(first.trained_through, self.cutoff)

    def test_recent_adaptation_never_reads_future_measurements(self):
        model = WeightedProfile().fit(self.readings, self.cutoff)
        target = pd.Timestamp('2026-02-02T14:00:00', tz=BERLIN)
        issued = target - pd.Timedelta(hours=1)
        changed = self.readings.copy()
        changed.loc[changed['observed_at'] >= issued, 'y'] = 100
        first = model.predict_issued([target], [issued], self.readings)
        second = model.predict_issued([target], [issued], changed)
        np.testing.assert_allclose(first, second)
        np.testing.assert_allclose(first, model.predict([target], issued, self.readings))

    def test_conformal_quantile_and_insufficient_data(self):
        self.assertIsNone(conformal_radius([1, 2]))
        self.assertEqual(conformal_radius(range(100)), 81)
        self.assertEqual(Calibration({'day_1': None}, {}).bounds(20, 'day_1'), (None, None))
        self.assertEqual(Calibration({'day_1': 10}, {}).bounds(2, 'day_1'), (0, 12))

    def test_calibration_uses_only_held_out_predictions(self):
        calls = []
        class Frozen:
            def fit(self, readings, cutoff):
                self.cutoff = cutoff
                return self
            def predict(self, times):
                assert all(pd.Timestamp(time) > self.cutoff for time in times)
                calls.append((self.cutoff, min(times), max(times)))
                return np.full(len(times), 15.0)
        readings = synthetic(days=65)
        with patch('models.make_model', return_value=Frozen()):
            result = calibrate(readings, pd.Timestamp('2026-03-06', tz=BERLIN), 'corrected_prophet')
        self.assertEqual(len(calls), 10)
        weekly, daily = calls[:3], calls[3:]
        self.assertTrue(all(first.tz_convert(BERLIN).date() > origin.date()
                            for origin, first, last in weekly))
        self.assertEqual([origin.date().isoformat() for origin, first, last in daily],
                         [day.date().isoformat() for day in pd.date_range('2026-02-27', periods=7)])
        self.assertTrue(all(first.tz_convert(BERLIN).date() == origin.date()
                            == last.tz_convert(BERLIN).date() for origin, first, last in daily))
        self.assertTrue(all(radius is not None for radius in result.radii.values()))
        self.assertGreaterEqual(result.counts['day_7'], 50)

    def test_horizon_uses_calendar_days_across_dst(self):
        self.assertEqual(horizon_key(pd.Timestamp('2026-03-28T23:00Z'), pd.Timestamp('2026-03-30T04:00Z')), 'day_1')
        self.assertEqual(horizon_key(pd.Timestamp('2026-10-07T10:00Z'), pd.Timestamp('2026-10-07T10:15Z')), 'minute_15')

    def test_chronological_backtest_provenance(self):
        rows = forecast_origin(self.readings, self.cutoff, ['weighted_profile'])
        self.assertTrue(rows)
        self.assertTrue(all(row['trainedThrough'] < row['issuedAt'] < row['targetAt'] for row in rows))
        self.assertIn('day_1', {row['horizon'] for row in rows})
        self.assertIn('minute_180', {row['horizon'] for row in rows})

    def test_model_selection_requires_both_gates(self):
        reports = {'corrected_prophet': {'equalModeScore': 4, 'equalModeBusyMae': 6},
                   'weighted_profile': {'equalModeScore': 3.7, 'equalModeBusyMae': 6.3}}
        self.assertEqual(select_candidate(reports)['selected'], 'corrected_prophet')
        reports['weighted_profile']['equalModeBusyMae'] = 6.2
        self.assertEqual(select_candidate(reports)['selected'], 'weighted_profile')
        reports['weighted_profile']['equalModeScore'] = 3.9
        self.assertEqual(select_candidate(reports)['selected'], 'corrected_prophet')

    def test_metric_bias_sign_and_busy_threshold(self):
        report = statistics(pd.DataFrame({'prediction': [21, 21], 'actual': [20, 25]}))
        self.assertEqual(report['mae'], 2.5)
        self.assertEqual(report['bias'], -1.5)
        self.assertEqual(report['busyMae'], 4)

    def test_invalid_selection_artifact_falls_back(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'selection.json'
            path.write_text(json.dumps({'version': MODEL_VERSION, 'selected': 'weighted_profile',
                                        'relativeImprovement': .1, 'busyMaeDelta': .3}))
            self.assertEqual(selected_model(path), 'corrected_prophet')

    def test_only_qualified_compact_configuration_selects_weighted(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'selection.json'
            configuration = {'version': MODEL_VERSION, 'selected': 'weighted_profile',
                'selectionGatePassed': True, 'selectionPolicy': {
                    'minimumRelativeImprovement': .05, 'maximumBusyMaeIncrease': .25}}
            path.write_text(json.dumps(configuration))
            self.assertEqual(selected_model(path), 'weighted_profile')
            configuration['selectionGatePassed'] = False
            path.write_text(json.dumps(configuration))
            self.assertEqual(selected_model(path), 'corrected_prophet')


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.ledger = ForecastLedger(Path(self.folder.name) / 'predictions.db')
        self.now = pd.Timestamp('2026-10-07T10:01Z')
        self.service = ForecastService(loader=lambda: synthetic(), ledger=self.ledger, clock=lambda: self.now)
        self.client = create_app(self.service, start_background=False).test_client()

    def tearDown(self):
        self.folder.cleanup()

    def bundle(self):
        readings = synthetic('2026-09-01', 30)
        model = WeightedProfile().fit(readings, pd.Timestamp('2026-10-01T00:00Z'))
        return {'model': model, 'calibration': Calibration({'minute_15': 3, 'minute_60': 3, 'minute_180': 4,
                                                          **{f'day_{day}': 6 for day in range(1, 8)}}, {}),
                'readings': readings, 'trainedThrough': model.trained_through,
                'modelVersion': MODEL_VERSION + ':weighted_profile', 'kind': 'weighted_profile'}

    def test_first_request_returns_readiness_without_training(self):
        with patch.object(self.service, 'train_async') as train:
            response = self.client.get('/predict?date=2026-10-07')
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json['status'], 'unavailable')
            train.assert_not_called()
        self.service.training = True
        self.assertEqual(self.client.get('/predict').json['status'], 'training')

    def test_invalid_and_out_of_range_dates(self):
        self.assertEqual(self.client.get('/predict?date=2026-02-30').status_code, 400)
        self.assertEqual(self.client.get('/predict?date=2026-10-15').status_code, 400)

    def test_failed_retraining_keeps_good_model(self):
        previous = self.bundle()
        self.service.current = previous
        self.service.loader = lambda: (_ for _ in ()).throw(RuntimeError('db offline'))
        self.service.training = True
        with self.assertLogs('app', level='ERROR'):
            self.service._train()
        self.assertIs(self.service.snapshot(), previous)
        self.assertEqual(self.service.status(), 'ready')
        self.assertFalse(self.service.training)

    def test_overlapping_training_not_started(self):
        self.service.training = True
        self.assertFalse(self.service.train_async())

    def test_predict_stores_only_forward_targets_with_provenance(self):
        self.service.current = self.bundle()
        response = self.client.get('/predict')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json['predictions'])
        for point in response.json['predictions']:
            self.assertLess(pd.Timestamp(point['issuedAt']), pd.Timestamp(point['targetAt']))
            self.assertLess(pd.Timestamp(point['trainedThrough']), pd.Timestamp(point['issuedAt']))
        with self.ledger.connect() as db:
            count = db.execute('SELECT count(*) FROM forecasts').fetchone()[0]
        original_issue = response.json['issuedAt']
        self.now += pd.Timedelta(minutes=1)
        repeated = self.client.get('/predict')
        self.assertEqual(repeated.json['issuedAt'], original_issue)
        self.assertEqual(repeated.json['issuedAt'], max(point['issuedAt'] for point in repeated.json['predictions']))
        with self.ledger.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM forecasts').fetchone()[0], count)

    def test_past_without_ledger_is_not_reconstructed(self):
        self.service.current = self.bundle()
        response = self.client.get('/predict?date=2026-10-06')
        self.assertEqual(response.status_code, 503)
        self.assertIn('keine Prognose gespeichert', response.json['error'])

    def test_past_returns_original_stored_forecast_even_without_ready_model(self):
        self.ledger.save('2026-10-06T10:00:00Z', '2026-10-05T19:47:00Z', 'original', [
            {'targetAt': '2026-10-06T11:00:00Z', 'horizon': 'minute_60', 'percentage': 19, 'lower': 12, 'upper': 26}])
        response = self.client.get('/predict?date=2026-10-06')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['modelVersion'], 'original')
        self.assertEqual(response.json['predictions'][0]['percentage'], 19)

    def test_health_and_weekend_response(self):
        self.service.current = self.bundle()
        self.assertEqual(self.client.get('/health').json['status'], 'ready')
        response = self.client.get('/predict?date=2026-10-10')
        self.assertEqual(response.json['openingHours'], {'startTime': '07:00', 'endTime': '22:00'})
        self.assertEqual(response.json['predictions'][0]['hour'], 7)

    def test_prospective_evaluation_joins_only_matching_observations(self):
        self.ledger.save('2026-10-06T10:00:00Z', '2026-10-05T19:47:00Z', 'original', [
            {'targetAt': '2026-10-06T11:00:00Z', 'horizon': 'minute_60', 'percentage': 19}])
        actual = normalize_readings([{'timestamp': '2026-10-06T11:03:00Z', 'percentage': 23}])
        joined = self.ledger.evaluated_rows(actual, pd.Timestamp('2026-10-01T00:00Z'), self.now)
        self.assertEqual(len(joined), 1)
        self.assertEqual(joined.iloc[0]['y'], 23)
        self.assertLess(joined.iloc[0]['issued_at'], joined.iloc[0]['target_at'])

    def test_ledger_rejects_retrospective_or_leaked_entries(self):
        point = {'targetAt': '2026-10-06T10:00:00Z', 'horizon': 'minute_60', 'percentage': 5}
        self.ledger.save('2026-10-07T00:00Z', '2026-10-06T00:00Z', 'test', [point])
        self.assertEqual(self.ledger.for_day(date(2026, 10, 6)), [])
        self.ledger.save('2026-10-06T09:00Z', '2026-10-06T09:00Z', 'test', [point])
        self.assertEqual(self.ledger.for_day(date(2026, 10, 6)), [])


if __name__ == '__main__':
    unittest.main()
