"""Non-blocking forecast API. Weather never gates utilization predictions."""
import json
import logging
import os
import sqlite3
import threading
from datetime import datetime, timedelta
from contextlib import closing
from pathlib import Path
import pandas as pd
from flask import Flask, jsonify, request
from calendar_features import BERLIN, UTC, day_info, day_slots, iso_utc, normalize_readings, opening_hours, parse_date
from ledger import ForecastLedger
from models import MODEL_VERSION, calibrate, make_model, horizon_key
from weather import WEATHER_VERSION, WeatherCache, interval_envelope, train_weather_response

LOGGER = logging.getLogger(__name__)
DATABASE_PATH = os.environ.get('DATABASE_PATH', '/app/data/gym.db')
PREDICTION_DATABASE_PATH = os.environ.get('PREDICTION_DATABASE_PATH', '/app/predictions/predictions.db')


def load_training_data():
    # Main application DB remains read-only; ledger has its own writable volume.
    with closing(sqlite3.connect(f'file:{DATABASE_PATH}?mode=ro', uri=True)) as connection:
        columns = {row[1] for row in connection.execute('PRAGMA table_info(utilization_readings)')}
        selected = ['timestamp', 'percentage'] + [column for column in
            ('temperature', 'precipitation', 'cloud_cover', 'is_raining') if column in columns]
        records = pd.read_sql_query(f'SELECT {",".join(selected)} FROM utilization_readings ORDER BY timestamp', connection)
    return normalize_readings(records)


def selected_model(path=None):
    """Fail closed to the corrected baseline unless the benchmark gate passed."""
    location = Path(path or os.environ.get('BENCHMARK_SELECTION_PATH', Path(__file__).with_name('selection.json')))
    try:
        result = json.loads(location.read_text())
        if (result.get('version') == MODEL_VERSION and result.get('selected') == 'weighted_profile'
                and result.get('selectionGatePassed') is True
                and result.get('selectionPolicy') == {
                    'minimumRelativeImprovement': .05, 'maximumBusyMaeIncrease': .25}):
            return 'weighted_profile'
    except (OSError, ValueError, TypeError):
        pass
    return 'corrected_prophet'


class ForecastService:
    def __init__(self, loader=load_training_data, ledger=None, clock=None, weather_cache=None):
        self.loader = loader
        self.ledger = ledger or ForecastLedger(PREDICTION_DATABASE_PATH)
        self.clock = clock or (lambda: datetime.now(UTC))
        self.weather = weather_cache or WeatherCache(Path(self.ledger.path).with_name('weather-cache.json'), clock=self.clock)
        self.lock = threading.Lock()
        self.training = False
        self.current = None
        self.last_error = None
        self.last_trained = None
        self.last_attempt = None
        self.started = False
        self.stop_event = threading.Event()

    def snapshot(self):
        with self.lock:
            return self.current

    def status(self):
        with self.lock:
            return 'ready' if self.current is not None else 'training' if self.training else 'unavailable'

    def train_async(self):
        with self.lock:
            if self.training:
                return False
            self.training = True
            self.last_attempt = pd.Timestamp(self.clock())
        threading.Thread(target=self._train, name='predictor-training', daemon=True).start()
        return True

    def _train(self):
        try:
            cutoff = pd.Timestamp(self.clock())
            readings = self.loader()
            # No same-request fitting; every successful model replaces the entire bundle atomically.
            kind = selected_model()
            intervals = calibrate(readings, cutoff, kind)
            model = make_model(kind).fit(readings, cutoff)
            previous = self.snapshot()
            previous_weather = previous.get('weatherModel') if previous and previous['kind'] == kind else None
            bundle = {'model': model, 'calibration': intervals, 'readings': readings,
                      'trainedThrough': model.trained_through,
                      'modelVersion': f'{MODEL_VERSION}:{kind}:{WEATHER_VERSION}', 'kind': kind,
                      'weatherModel': previous_weather}
            with self.lock:
                self.current = bundle
                self.last_trained = cutoff
                self.last_error = None
            # The calendar model is ready before optional weather-response fitting.
            # Neither weather network availability nor this extra fitting blocks requests.
            try:
                weather_model = train_weather_response(readings, cutoff, kind)
                with self.lock:
                    if self.current is bundle:
                        self.current = {**bundle, 'weatherModel': weather_model}
            except Exception:
                LOGGER.exception('Weather response unavailable; calendar model remains ready')
        except Exception as error:
            LOGGER.exception('Forecast training failed; previous successful model retained')
            with self.lock:
                self.last_error = str(error)
        finally:
            with self.lock:
                self.training = False

    def start(self):
        with self.lock:
            if self.started:
                return
            self.started = True
        self.weather.start()
        self.train_async()
        threading.Thread(target=self._maintenance, name='predictor-maintenance', daemon=True).start()

    def future_capture_key(self, now):
        bundle = self.snapshot() or {}
        response = bundle.get('weatherModel')
        with self.weather.lock:
            fetched = self.weather.fetched_at
        return (pd.Timestamp(now).tz_convert(BERLIN).date(), fetched,
                response.trained_through if response is not None and response.coefficients is not None else None,
                bundle.get('trainedThrough'), bundle.get('modelVersion'))

    def _maintenance(self):
        # Forecast collection is independent of dashboard traffic, once each quarter-hour.
        last_capture = None
        last_future_key = None
        while not self.stop_event.wait(15):
            now = pd.Timestamp(self.clock())
            with self.lock:
                trained = self.last_trained
                attempted = self.last_attempt
            if ((trained is None or now - trained >= pd.Timedelta(days=1))
                    and (attempted is None or now - attempted >= pd.Timedelta(minutes=5))):
                self.train_async()
            capture = int(now.timestamp()) // 900
            if self.snapshot() is not None and capture != last_capture:
                try:
                    today = now.tz_convert(BERLIN).date()
                    self.predict(today, now)
                    future_key = self.future_capture_key(now)
                    if last_future_key != future_key:
                        for offset in range(1, 8):
                            self.predict(today + timedelta(days=offset), now)
                        last_future_key = future_key
                    last_capture = capture
                except Exception:
                    LOGGER.exception('Could not persist scheduled forecast')

    def predict(self, day, issued_at=None):
        now = pd.Timestamp(issued_at or self.clock())
        today = now.tz_convert(BERLIN).date()
        metadata = {'date': day.isoformat(), **day_info(day), 'weather': None,
                    'openingHours': {'startTime': f'{opening_hours(day)[0]:02d}:00', 'endTime': '22:00'},
                    'intervalCoverage': .8}
        stored = self.ledger.for_day(day, now)
        if day < today:
            if not stored:
                return {**metadata, 'status': 'unavailable', 'predictions': [],
                        'error': 'Für dieses Datum wurde keine Prognose gespeichert.'}, 503
            latest = max(stored, key=lambda point: point['issuedAt'])
            return {**metadata, 'status': 'ready', 'source': 'recorded', 'predictions': stored,
                    'issuedAt': latest['issuedAt'], 'trainedThrough': latest['trainedThrough'],
                    'modelVersion': latest['modelVersion'], 'intervalCalibration': latest['intervalCalibration'],
                    'weatherStatus': latest['weatherStatus'], 'intervalStatus': 'calibrated'
                    if all(point['lower'] is not None for point in stored) else 'insufficient_data'}, 200
        bundle = self.snapshot()
        if bundle is None:
            return {**metadata, 'status': self.status(), 'predictions': [],
                    'error': 'Das Prognosemodell wird vorbereitet.'}, 503
        # Recent observations improve only future weighted-profile forecasts; the fitted
        # profile stays immutable until the daily training completes.
        recent = bundle['readings']
        if bundle['kind'] == 'weighted_profile':
            try:
                recent = self.loader()
            except Exception:
                LOGGER.warning('Recent measurements unavailable; using fitted profile')
        times = day_slots(day)
        future = times[times > now]
        points = bundle['model'].predict(future, now, recent) if len(future) else []
        new_points = []
        for target, point in zip(future, points):
            key = horizon_key(now, target)
            lower, upper = bundle['calibration'].bounds(point, key)
            forecast_weather = self.weather.at(target, now)
            weather_model = bundle.get('weatherModel')
            supported = (weather_model is not None and weather_model.coefficients is not None
                         and weather_model.trained_through is not None and weather_model.trained_through < now)
            adjustment = weather_model.correction(forecast_weather, target, now) if supported else 0.0
            adjusted = max(0, min(100, float(point) + adjustment))
            adjustment = adjusted - float(point)
            active_lower, active_upper = interval_envelope(lower, upper, adjustment)
            weather_status = 'forecast_unavailable' if forecast_weather is None else 'applied' if supported else 'insufficient_training'
            new_points.append({'hour': target.hour, 'minute': target.minute,
                               'percentage': round(adjusted, 2), 'targetAt': iso_utc(target),
                               'lower': active_lower, 'upper': active_upper, 'status': 'open', 'horizon': key,
                               'baselinePercentage': round(float(point), 2), 'baselineLower': lower, 'baselineUpper': upper,
                               'weatherAdjustment': round(adjustment, 2), 'weather': forecast_weather,
                               'weatherStatus': weather_status, 'intervalCalibration': 'calendar_envelope' if weather_status == 'applied' else 'calendar',
                               'weatherTrainedThrough': iso_utc(weather_model.trained_through) if supported else None})
        self.ledger.save(now, bundle['trainedThrough'], bundle['modelVersion'], new_points)
        # Read back persisted values: repeated requests in a quarter never rewrite history.
        predictions = self.ledger.for_day(day, now)
        if not predictions:
            return {**metadata, 'status': 'unavailable', 'predictions': [],
                    'error': 'Für diesen Tag liegen noch keine gespeicherten Prognosen vor.'}, 503
        latest = max(predictions, key=lambda point: point['issuedAt'])
        return {**metadata, 'status': 'ready', 'source': 'recorded', 'predictions': predictions,
                'issuedAt': latest['issuedAt'], 'trainedThrough': latest['trainedThrough'],
                'modelVersion': latest['modelVersion'], 'intervalCalibration': latest['intervalCalibration'],
                    'weatherStatus': latest['weatherStatus'], 'intervalStatus': 'calibrated'
                if all(point['lower'] is not None for point in predictions) else 'insufficient_data'}, 200


def create_app(service=None, start_background=True):
    flask_app = Flask(__name__)
    state = service or ForecastService()
    flask_app.extensions['forecast_service'] = state

    @flask_app.get('/health')
    def health():
        bundle = state.snapshot()
        return jsonify({'status': state.status(), 'model_trained': bundle is not None,
                        'training': state.training, 'last_trained': iso_utc(state.last_trained)
                        if state.last_trained is not None else None,
                        'modelVersion': bundle['modelVersion'] if bundle else None,
                        'lastError': state.last_error})

    @flask_app.get('/predict')
    def predict():
        today = pd.Timestamp(state.clock()).tz_convert(BERLIN).date()
        try:
            day = parse_date(request.args['date']) if 'date' in request.args else today
        except ValueError:
            return jsonify({'error': 'Invalid date. Use YYYY-MM-DD.', 'status': 'unavailable'}), 400
        if day > today + timedelta(days=7):
            return jsonify({'error': 'Predictions are available up to seven days ahead.', 'status': 'unavailable'}), 400
        try:
            result, status = state.predict(day)
            return jsonify(result), status
        except Exception:
            LOGGER.exception('Forecast request failed')
            return jsonify({'status': 'unavailable', 'date': day.isoformat(), 'predictions': [],
                            'error': 'Die Prognose ist vorübergehend nicht verfügbar.'}), 503

    @flask_app.post('/train')
    def train():
        queued = state.train_async()
        return jsonify({'status': state.status(), 'training': True, 'queued': queued}), 202

    if start_background:
        state.start()
    return flask_app


# Gunicorn imports this factory; initialization therefore also happens in production.
# Tests disable autostart and construct an isolated app with a temporary ledger.
app = create_app(start_background=os.environ.get('PREDICTOR_AUTOSTART', '1') != '0') if os.environ.get('PREDICTOR_TESTING') != '1' else None

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)
