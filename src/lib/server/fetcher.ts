import { db, schema } from './db';

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
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD

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
    try {
        const date = new Date(isoString);
        return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    } catch {
        return null;
    }
}

async function fetchWeather(): Promise<WeatherData | null> {
    try {
        const response = await fetch(WEATHER_API_URL);
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

export async function fetchAndStoreUtilization(): Promise<{ success: boolean; percentage?: number; error?: string }> {
    try {
        // Get holidays (static data) and fetch utilization + weather in parallel
        const holidays = getSchoolHolidays();
        const [utilizationResponse, weather] = await Promise.all([
            fetch(API_URL),
            fetchWeather(),
        ]);

        if (!utilizationResponse.ok) {
            throw new Error(`API responded with status ${utilizationResponse.status}`);
        }

        const data: UtilizationResponse = await utilizationResponse.json();

        // Find the current slot
        const currentSlot = data.items.find(item => item.isCurrent);
        if (!currentSlot) {
            return { success: false, error: 'No current slot found in API response' };
        }

        const now = new Date();
        const weekday = now.getDay(); // 0=Sunday, 1=Monday, ...
        const hour = now.getHours();

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
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${new Date().toISOString()}] Failed to fetch utilization: ${message}`);
        return { success: false, error: message };
    }
}
