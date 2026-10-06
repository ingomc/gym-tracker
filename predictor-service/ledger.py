"""Append-only forecasts, isolated from the read-only measurement database."""
import sqlite3
import json
from contextlib import contextmanager
from pathlib import Path
import pandas as pd
from calendar_features import BERLIN, iso_utc


class ForecastLedger:
    def __init__(self, path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('''CREATE TABLE IF NOT EXISTS forecasts (
                id INTEGER PRIMARY KEY, issued_at REAL NOT NULL,
                issue_slot INTEGER NOT NULL, trained_through REAL NOT NULL,
                model_version TEXT NOT NULL, target_at INTEGER NOT NULL,
                horizon TEXT NOT NULL, percentage REAL NOT NULL, lower REAL, upper REAL,
                CHECK(issued_at < target_at), CHECK(trained_through < issued_at),
                UNIQUE(issue_slot, target_at, model_version))''')
            db.execute('CREATE INDEX IF NOT EXISTS forecast_targets ON forecasts(target_at, issued_at)')
            columns = {row[1] for row in db.execute('PRAGMA table_info(forecasts)')}
            for name, kind in [('baseline_percentage', 'REAL'), ('baseline_lower', 'REAL'), ('baseline_upper', 'REAL'),
                               ('weather_adjustment', 'REAL'), ('weather_json', 'TEXT'), ('weather_status', 'TEXT'),
                               ('interval_calibration', 'TEXT'), ('weather_trained_through', 'REAL')]:
                if name not in columns:
                    db.execute(f'ALTER TABLE forecasts ADD COLUMN {name} {kind}')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def save(self, issued_at, trained_through, version, predictions):
        issued, trained = pd.Timestamp(issued_at).timestamp(), pd.Timestamp(trained_through).timestamp()
        rows = []
        for point in predictions:
            target = int(pd.Timestamp(point['targetAt']).timestamp())
            if trained >= issued or target <= issued:
                continue
            rows.append((issued, int(issued) // 900, trained, version, target, point['horizon'],
                         point['percentage'], point.get('lower'), point.get('upper'),
                         point.get('baselinePercentage', point['percentage']), point.get('baselineLower', point.get('lower')),
                         point.get('baselineUpper', point.get('upper')), point.get('weatherAdjustment', 0),
                         json.dumps(point['weather'], allow_nan=False) if point.get('weather') is not None else None,
                         point.get('weatherStatus', 'forecast_unavailable'), point.get('intervalCalibration', 'calendar'),
                         pd.Timestamp(point['weatherTrainedThrough']).timestamp() if point.get('weatherTrainedThrough') else None))
        columns = ('issued_at,issue_slot,trained_through,model_version,target_at,horizon,percentage,lower,upper,'
                   'baseline_percentage,baseline_lower,baseline_upper,weather_adjustment,weather_json,weather_status,'
                   'interval_calibration,weather_trained_through')
        with self.connect() as db:
            placeholders = ','.join('?' for _ in columns.split(','))
            db.executemany(f'INSERT OR IGNORE INTO forecasts ({columns}) VALUES ({placeholders})', rows)

    def for_day(self, day, cutoff=None):
        start = pd.Timestamp(day).tz_localize(BERLIN)
        end = start + pd.DateOffset(days=1)
        now = pd.Timestamp(cutoff).timestamp() if cutoff is not None else 2**62
        with self.connect() as db:
            rows = db.execute('''SELECT * FROM (
                SELECT *, ROW_NUMBER() OVER(PARTITION BY target_at ORDER BY issued_at DESC,id DESC) AS position
                FROM forecasts WHERE target_at >= ? AND target_at < ? AND issued_at <= ?
            ) WHERE position=1 ORDER BY target_at''', (int(start.timestamp()), int(end.timestamp()), now)).fetchall()
        return [self.public_point(row) for row in rows]

    @staticmethod
    def public_point(row):
        target = pd.Timestamp(row['target_at'], unit='s', tz='UTC').tz_convert(BERLIN)
        return {'hour': target.hour, 'minute': target.minute, 'percentage': row['percentage'],
                'lower': row['lower'], 'upper': row['upper'], 'targetAt': iso_utc(target),
                'status': 'open', 'issuedAt': iso_utc(pd.Timestamp(row['issued_at'], unit='s', tz='UTC')),
                'trainedThrough': iso_utc(pd.Timestamp(row['trained_through'], unit='s', tz='UTC')),
                'modelVersion': row['model_version'], 'horizon': row['horizon'],
                'baselinePercentage': row['baseline_percentage'] if row['baseline_percentage'] is not None else row['percentage'],
                'baselineLower': row['baseline_lower'], 'baselineUpper': row['baseline_upper'],
                'weatherAdjustment': row['weather_adjustment'] or 0,
                'weather': json.loads(row['weather_json']) if row['weather_json'] else None,
                'weatherStatus': row['weather_status'] or 'forecast_unavailable',
                'intervalCalibration': row['interval_calibration'] or 'calendar',
                'weatherTrainedThrough': iso_utc(pd.Timestamp(row['weather_trained_through'], unit='s', tz='UTC'))
                    if row['weather_trained_through'] is not None else None}

    def evaluated_rows(self, readings, since, until):
        with self.connect() as db:
            forecasts = pd.read_sql_query('''SELECT * FROM forecasts
                WHERE target_at >= ? AND target_at < ?''', db,
                params=(int(pd.Timestamp(since).timestamp()), int(pd.Timestamp(until).timestamp())))
        if forecasts.empty:
            return forecasts
        actuals = readings[['timestamp', 'y', 'anomaly']].copy()
        actuals['target_at'] = actuals['timestamp'].astype('int64') // 10**9
        return forecasts.merge(actuals, on='target_at', how='inner')
