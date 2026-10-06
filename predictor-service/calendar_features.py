"""One Berlin calendar for training, inference and chronological evaluation."""
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo
import re
import holidays
import pandas as pd

BERLIN = ZoneInfo('Europe/Berlin')
UTC = timezone.utc
OPEN_HOUR, CLOSE_HOUR = 6, 22
# Official Bavarian school calendar, inclusive endpoints:
# https://www.gesetze-bayern.de/Content/Document/BayVV_2230_1_1_0_K_13479-0
SCHOOL_HOLIDAYS = [
    ('2025-12-22', '2026-01-05', 'Weihnachtsferien'),
    ('2026-02-16', '2026-02-20', 'Frühjahrsferien'),
    ('2026-03-30', '2026-04-10', 'Osterferien'),
    ('2026-05-26', '2026-06-05', 'Pfingstferien'),
    ('2026-08-03', '2026-09-14', 'Sommerferien'),
    ('2026-11-02', '2026-11-06', 'Herbstferien'),
    ('2026-12-24', '2027-01-08', 'Weihnachtsferien'),
    ('2027-02-08', '2027-02-12', 'Frühjahrsferien'),
    ('2027-03-22', '2027-04-02', 'Osterferien'),
    ('2027-05-18', '2027-05-28', 'Pfingstferien'),
    ('2027-08-02', '2027-09-13', 'Sommerferien'),
    ('2027-11-02', '2027-11-05', 'Herbstferien'),
    ('2027-12-24', '2028-01-07', 'Weihnachtsferien'),
    ('2028-02-28', '2028-03-03', 'Frühjahrsferien'),
    ('2028-04-10', '2028-04-21', 'Osterferien'),
    ('2028-06-06', '2028-06-16', 'Pfingstferien'),
    ('2028-07-31', '2028-09-11', 'Sommerferien'),
    ('2028-10-30', '2028-11-03', 'Herbstferien'),
    ('2028-12-23', '2029-01-05', 'Weihnachtsferien'),
    ('2029-02-12', '2029-02-16', 'Frühjahrsferien'),
    ('2029-03-26', '2029-04-06', 'Osterferien'),
    ('2029-05-22', '2029-06-01', 'Pfingstferien'),
    ('2029-07-30', '2029-09-10', 'Sommerferien'),
    ('2029-10-29', '2029-11-02', 'Herbstferien'),
    ('2029-12-24', '2030-01-04', 'Weihnachtsferien'),
]


def parse_date(value):
    if not isinstance(value, str) or re.fullmatch(r'\d{4}-\d{2}-\d{2}', value) is None:
        raise ValueError('Use YYYY-MM-DD')
    return date.fromisoformat(value)


@lru_cache(maxsize=32)
def bavarian_holidays(year):
    return holidays.Germany(subdiv='BY', years=year, language='de')


@lru_cache(maxsize=4096)
def day_info(day):
    public_name = bavarian_holidays(day.year).get(day)
    school_name = next((name for start, end, name in SCHOOL_HOLIDAYS
                        if start <= day.isoformat() <= end), None)
    return {'weekday': (day.weekday() + 1) % 7, 'isHoliday': bool(public_name),
            'holidayName': public_name, 'isSchoolHoliday': bool(school_name),
            'schoolHolidayName': school_name}


def opening_hours(day):
    return (7 if day.weekday() >= 5 else 6), CLOSE_HOUR


def day_slots(day):
    return pd.DatetimeIndex([datetime.combine(day, time(hour, minute), BERLIN)
                             for hour in range(*opening_hours(day))
                             for minute in (0, 15, 30, 45)])


def iso_utc(value):
    return pd.Timestamp(value).tz_convert('UTC').isoformat().replace('+00:00', 'Z')


def feature_frame(times):
    local = pd.DatetimeIndex(times).tz_convert(BERLIN)
    frame = pd.DataFrame({'ds': local.tz_localize(None)})
    frame['school_holiday'] = [int(day_info(day)['isSchoolHoliday']) for day in local.date]
    for weekday in range(7):
        frame[f'day_{weekday}'] = local.weekday == weekday
    return frame


def normalize_readings(records):
    """Validate, deduplicate timestamps, then retain last observed value per open slot.

    `observed_at` preserves the original availability time for leakage-free cutoffs;
    zero is a genuine measurement. No values are generated for missing/closed slots.
    """
    raw = pd.DataFrame(records)
    if raw.empty:
        return pd.DataFrame(columns=['timestamp', 'observed_at', 'y', 'local', 'weekday', 'slot', 'anomaly'])
    source = raw['timestamp']
    numeric = pd.to_numeric(source, errors='coerce')
    raw['observed_at'] = pd.to_datetime(source, utc=True, errors='coerce', format='mixed')
    if pd.api.types.is_numeric_dtype(source):
        raw['observed_at'] = pd.to_datetime(numeric, unit='s', utc=True, errors='coerce')
    raw['y'] = pd.to_numeric(raw['percentage'], errors='coerce')
    for column, alias in [('temperature', 'temperature'), ('precipitation', 'precipitation'),
                          ('cloud_cover', 'cloudCover'), ('is_raining', 'isRaining')]:
        values = raw[column] if column in raw else raw[alias] if alias in raw else None
        raw[column] = pd.to_numeric(values, errors='coerce')
    valid = raw['observed_at'].notna() & raw['y'].between(0, 100)
    raw = raw.loc[valid, ['observed_at', 'y', 'temperature', 'precipitation', 'cloud_cover', 'is_raining']].sort_values('observed_at', kind='stable')
    raw = raw.drop_duplicates('observed_at', keep='last')
    local = raw['observed_at'].dt.tz_convert(BERLIN)
    opening = local.dt.weekday.map(lambda weekday: 7 if weekday >= 5 else 6)
    raw = raw.loc[(local.dt.hour >= opening) & (local.dt.hour < CLOSE_HOUR)].copy()
    raw['timestamp'] = raw['observed_at'].dt.floor('15min')
    raw = raw.drop_duplicates('timestamp', keep='last').reset_index(drop=True)
    raw['local'] = raw['timestamp'].dt.tz_convert(BERLIN)
    raw['weekday'] = raw['local'].dt.weekday
    raw['slot'] = raw['local'].dt.hour * 4 + raw['local'].dt.minute // 15
    # Flag large adjacent changes, never delete observations from the main analysis.
    raw['anomaly'] = (raw['y'].diff().abs().ge(25)
                      & raw['timestamp'].diff().le(pd.Timedelta(minutes=30)))
    return raw


def before(readings, issued_at):
    return readings.loc[readings['observed_at'] < pd.Timestamp(issued_at)].copy()
