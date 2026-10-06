import { studioOpeningHours, studioWeekday } from '../utils/studio-time';

export interface ForecastWeather {
    temperature: number;
    precipitation: number;
    cloudCover: number;
    fetchedAt: string;
    targetAt: string;
    provider: 'open-meteo';
    source: 'forecast';
}

export interface PredictionResult {
    hour: number;
    minute: number;
    percentage: number;
    targetAt: string;
    lower: number | null;
    upper: number | null;
    status: 'open';
    baselinePercentage?: number;
    weatherAdjustment?: number;
    weather?: ForecastWeather | null;
    intervalCalibration?: string;
}

export interface PredictionResponse {
    date: string;
    weekday: number;
    status: 'ready' | 'training' | 'unavailable';
    isHoliday: boolean;
    holidayName: string | null;
    isSchoolHoliday?: boolean;
    schoolHolidayName?: string | null;
    issuedAt: string | null;
    trainedThrough: string | null;
    modelVersion: string | null;
    intervalCoverage: number;
    openingHours: { startTime: string; endTime: string };
    predictions: PredictionResult[];
    error?: string;
}

const PREDICTOR_URL = process.env.PREDICTOR_URL || 'http://predictor:5000';

function unavailable(date: string, error: string, status: 'training' | 'unavailable' = 'unavailable'): PredictionResponse {
    const hours = studioOpeningHours(date);
    return {
        date, weekday: studioWeekday(date), status,
        isHoliday: false, holidayName: null,
        issuedAt: null, trainedThrough: null, modelVersion: null,
        intervalCoverage: 0.8,
        openingHours: {
            startTime: `${String(hours.startHour).padStart(2, '0')}:00:00`,
            endTime: `${String(hours.endHour).padStart(2, '0')}:00:00`,
        },
        predictions: [], error,
    };
}

function isPrediction(value: unknown): value is PredictionResult {
    if (!value || typeof value !== 'object') return false;
    const point = value as PredictionResult;
    const bounded = (value: unknown): value is number => typeof value === 'number'
        && Number.isFinite(value) && value >= 0 && value <= 100;
    return Number.isInteger(point.hour) && point.hour >= 0 && point.hour < 24
        && [0, 15, 30, 45].includes(point.minute) && bounded(point.percentage)
        && typeof point.targetAt === 'string' && Number.isFinite(Date.parse(point.targetAt))
        && (point.lower === null || bounded(point.lower))
        && (point.upper === null || bounded(point.upper))
        && (point.lower === null || point.upper === null || point.lower <= point.upper);
}

/** The service owns readiness; preflight health requests would race startup training. */
export async function predict(date: string): Promise<{ data: PredictionResponse; httpStatus: number }> {
    try {
        const response = await fetch(`${PREDICTOR_URL}/predict?date=${encodeURIComponent(date)}`, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        const body = await response.json();
        if (!response.ok) {
            const status = body?.status === 'training' ? 'training' : 'unavailable';
            const message = typeof body?.error === 'string' ? body.error
                : 'Die Prognose ist vorübergehend nicht verfügbar.';
            return { data: unavailable(date, message, status), httpStatus: response.status === 400 ? 400 : 503 };
        }
        if (body?.date !== date || body?.status !== 'ready' || !Array.isArray(body.predictions)
            || !body.predictions.every(isPrediction)) {
            return { data: unavailable(date, 'Die Prognose enthält ungültige Daten.'), httpStatus: 502 };
        }
        return { data: body as PredictionResponse, httpStatus: 200 };
    } catch (error) {
        console.error('[Predictor] Request failed:', error instanceof Error ? error.message : 'Unknown error');
        return { data: unavailable(date, 'Die Prognose ist vorübergehend nicht erreichbar.'), httpStatus: 503 };
    }
}
