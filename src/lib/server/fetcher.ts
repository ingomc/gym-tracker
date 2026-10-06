import { db, schema } from './db';
import { getPollIntervalMinutes, getUtilizationStatus, type UtilizationSourceSnapshot } from './utilization-status';
import { studioDateString, studioParts } from '../utils/studio-time';

const API_URL = process.env.API_URL || 'https://www.ai-fitness.de/connect/v1/studio/1412625590/utilization';

// Coburg, Germany coordinates for weather API
const WEATHER_LAT = 50.2612;
const WEATHER_LON = 10.9628;

// Extended weather API with UV index and sun times
const WEATHER_API_URL = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&current=temperature_2m,precipitation,cloud_cover,rain,uv_index&daily=sunrise,sunset&timezone=Europe/Berlin&forecast_days=1`;

interface UtilizationItem {
    startTime: string;
    endTime: string;
    percentage: number;
    level: string;
    isCurrent: boolean;
}

interface UtilizationResponse {
    startTime: string;
    endTime: string;
    items: UtilizationItem[];
}

let sourceSnapshot: UtilizationSourceSnapshot | null = null;

export function getUtilizationSourceSnapshot(): UtilizationSourceSnapshot | null {
    return sourceSnapshot;
}

interface WeatherData {
    temperature: number;
    precipitation: number;
    cloudCover: number;
    isRaining: number;
    uvIndex: number | null;
    sunrise: string | null;
    sunset: string | null;
}

interface OpenMeteoResponse {
    current: {
        temperature_2m: number;
        precipitation: number;
        cloud_cover: number;
        rain: number;
        uv_index?: number;
    };
    daily?: {
        sunrise?: string[];
        sunset?: string[];
    };
}

interface SchoolHoliday {
    start: string;
    end: string;
    name: string;
}

// Bayern school holidays - static data from Bayerisches Kultusministerium
// Source: https://www.gesetze-bayern.de (Bekanntmachung vom 7. Dezember 2022)
const BAYERN_SCHOOL_HOLIDAYS: SchoolHoliday[] = [
    // 2025/2026 (ab Januar 2026)
    { start: '2025-12-22', end: '2026-01-05', name: 'Weihnachtsferien' },
    { start: '2026-02-16', end: '2026-02-20', name: 'Frühjahrsferien' },
    { start: '2026-03-30', end: '2026-04-10', name: 'Osterferien' },
    { start: '2026-05-26', end: '2026-06-05', name: 'Pfingstferien' },
    { start: '2026-08-03', end: '2026-09-14', name: 'Sommerferien' },
    { start: '2026-11-02', end: '2026-11-06', name: 'Herbstferien' },
    { start: '2026-12-24', end: '2027-01-08', name: 'Weihnachtsferien' },
    // 2026/2027
    { start: '2027-02-08', end: '2027-02-12', name: 'Frühjahrsferien' },
    { start: '2027-03-22', end: '2027-04-02', name: 'Osterferien' },
    { start: '2027-05-18', end: '2027-05-28', name: 'Pfingstferien' },
    { start: '2027-08-02', end: '2027-09-13', name: 'Sommerferien' },
    { start: '2027-11-02', end: '2027-11-05', name: 'Herbstferien' },
    { start: '2027-12-24', end: '2028-01-07', name: 'Weihnachtsferien' },
    // 2027/2028
    { start: '2028-02-28', end: '2028-03-03', name: 'Frühjahrsferien' },
    { start: '2028-04-10', end: '2028-04-21', name: 'Osterferien' },
    { start: '2028-06-06', end: '2028-06-16', name: 'Pfingstferien' },
    { start: '2028-07-31', end: '2028-09-11', name: 'Sommerferien' },
    { start: '2028-10-30', end: '2028-11-03', name: 'Herbstferien' },
    { start: '2028-12-23', end: '2029-01-05', name: 'Weihnachtsferien' },
    // 2028/2029
    { start: '2029-02-12', end: '2029-02-16', name: 'Frühjahrsferien' },
    { start: '2029-03-26', end: '2029-04-06', name: 'Osterferien' },
    { start: '2029-05-22', end: '2029-06-01', name: 'Pfingstferien' },
    { start: '2029-07-30', end: '2029-09-10', name: 'Sommerferien' },
    { start: '2029-10-29', end: '2029-11-02', name: 'Herbstferien' },
    { start: '2029-12-24', end: '2030-01-04', name: 'Weihnachtsferien' },
];

function getSchoolHolidays(): SchoolHoliday[] {
    return BAYERN_SCHOOL_HOLIDAYS;
}

function checkSchoolHoliday(holidays: SchoolHoliday[], date: Date): { isHoliday: boolean; name: string | null } {
    const dateStr = studioDateString(date);

    for (const holiday of holidays) {
        const start = holiday.start.split('T')[0];
        const end = holiday.end.split('T')[0];

        if (dateStr >= start && dateStr <= end) {
            return { isHoliday: true, name: holiday.name };
        }
    }

    return { isHoliday: false, name: null };
}

function formatTime(isoString: string | undefined): string | null {
    if (!isoString) return null;
    // Open-Meteo supplies studio-local times because timezone=Europe/Berlin.
    return /T(\d{2}:\d{2})/.exec(isoString)?.[1] ?? null;
}

async function fetchWeather(): Promise<WeatherData | null> {
    try {
        const response = await fetch(WEATHER_API_URL, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) {
            console.error(`[Weather] API responded with status ${response.status}`);
            return null;
        }

        const data: OpenMeteoResponse = await response.json();

        return {
            temperature: data.current.temperature_2m,
            precipitation: data.current.precipitation,
            cloudCover: data.current.cloud_cover,
            isRaining: data.current.rain > 0 ? 1 : 0,
            uvIndex: data.current.uv_index ?? null,
            sunrise: formatTime(data.daily?.sunrise?.[0]),
            sunset: formatTime(data.daily?.sunset?.[0]),
        };
    } catch (error) {
        console.error(`[Weather] Failed to fetch:`, error);
        return null;
    }
}

type FetchResult = { success: boolean; percentage?: number; error?: string };
let activeFetch: Promise<FetchResult> | null = null;

export function fetchAndStoreUtilization(): Promise<FetchResult> {
    // Startup, scheduled ticks and manual callers share a single pending poll.
    if (!activeFetch) {
        activeFetch = performFetch().finally(() => { activeFetch = null; });
    }
    return activeFetch;
}

async function performFetch(): Promise<FetchResult> {
    try {
        const holidays = getSchoolHolidays();
        const weatherPromise = fetchWeather();
        const utilizationResponse = await fetch(API_URL, { signal: AbortSignal.timeout(8000) });

        if (!utilizationResponse.ok) {
            throw new Error(`API responded with status ${utilizationResponse.status}`);
        }

        const data: UtilizationResponse = await utilizationResponse.json();
        // Timestamp the source observation before waiting for optional weather.
        const now = new Date();
        if (!Array.isArray(data.items)) throw new Error('Invalid utilization response');

        // Find the current slot
        const currentSlot = data.items.find(item => item.isCurrent === true);
        sourceSnapshot = {
            checkedAt: now,
            status: currentSlot ? 'current' : 'missing',
            openingHours: { startTime: data.startTime, endTime: data.endTime },
        };
        const status = getUtilizationStatus({
            now,
            lastUpdated: null,
            source: sourceSnapshot,
            pollIntervalMinutes: getPollIntervalMinutes(),
        });
        if (status === 'closed') {
            // Closure is display state, not a measured zero for historical charts.
            return { success: true };
        }
        if (!currentSlot) {
            console.warn(`[${now.toISOString()}] No current slot found during opening hours`);
            return { success: false, error: 'No current slot found in API response' };
        }

        if (!Number.isFinite(currentSlot.percentage) || currentSlot.percentage < 0
            || currentSlot.percentage > 100 || !['LOW', 'MEDIUM', 'HIGH'].includes(currentSlot.level)) {
            throw new Error('Invalid current utilization measurement');
        }
        const { weekday, hour } = studioParts(now);
        const weather = await weatherPromise;

        // Check school holidays
        const schoolHoliday = checkSchoolHoliday(holidays, now);

        // Insert into database with all data
        await db.insert(schema.utilizationReadings).values({
            timestamp: now,
            weekday,
            hour,
            percentage: currentSlot.percentage,
            level: currentSlot.level,
            // Weather data
            temperature: weather?.temperature ?? null,
            precipitation: weather?.precipitation ?? null,
            cloudCover: weather?.cloudCover ?? null,
            isRaining: weather?.isRaining ?? null,
            // Extended weather
            uvIndex: weather?.uvIndex ?? null,
            sunrise: weather?.sunrise ?? null,
            sunset: weather?.sunset ?? null,
            // School holidays
            isSchoolHoliday: schoolHoliday.isHoliday ? 1 : 0,
            holidayName: schoolHoliday.name,
        });

        const weatherInfo = weather
            ? `${weather.temperature}°C, UV:${weather.uvIndex ?? '-'}, ${weather.isRaining ? 'Regen' : 'kein Regen'}`
            : 'no weather data';
        const holidayInfo = schoolHoliday.isHoliday ? ` | Ferien: ${schoolHoliday.name}` : '';
        console.log(`[${now.toISOString()}] Stored: ${currentSlot.percentage}% (${currentSlot.level}) | Weather: ${weatherInfo}${holidayInfo}`);

        return { success: true, percentage: currentSlot.percentage };
    } catch (error) {
        sourceSnapshot = {
            checkedAt: new Date(),
            status: 'error',
            openingHours: sourceSnapshot?.openingHours,
            openingHoursCheckedAt: sourceSnapshot?.openingHoursCheckedAt ?? sourceSnapshot?.checkedAt,
        };
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${new Date().toISOString()}] Failed to fetch utilization: ${message}`);
        return { success: false, error: message };
    }
}
