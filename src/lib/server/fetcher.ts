import { db, schema } from './db';

const API_URL = process.env.API_URL || 'https://www.ai-fitness.de/connect/v1/studio/1412625590/utilization';

// Coburg, Germany coordinates for weather API
const WEATHER_LAT = 50.2612;
const WEATHER_LON = 10.9628;

// Extended weather API with UV index and sun times
const WEATHER_API_URL = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&current=temperature_2m,precipitation,cloud_cover,rain,uv_index&daily=sunrise,sunset&timezone=Europe/Berlin&forecast_days=1`;

// Bayern school holidays API
const HOLIDAYS_API_URL = 'https://ferien-api.de/api/v1/holidays/BY';

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
    slug: string;
}

// Cache for school holidays (refresh daily)
let holidayCache: { holidays: SchoolHoliday[]; fetchedAt: Date | null } = {
    holidays: [],
    fetchedAt: null
};

async function fetchSchoolHolidays(): Promise<SchoolHoliday[]> {
    // Check cache (valid for 24 hours)
    if (holidayCache.fetchedAt &&
        (Date.now() - holidayCache.fetchedAt.getTime()) < 24 * 60 * 60 * 1000) {
        return holidayCache.holidays;
    }

    try {
        const response = await fetch(HOLIDAYS_API_URL);
        if (!response.ok) {
            console.error(`[Holidays] API responded with status ${response.status}`);
            return holidayCache.holidays; // Return cached data on error
        }

        const holidays: SchoolHoliday[] = await response.json();
        holidayCache = { holidays, fetchedAt: new Date() };
        console.log(`[Holidays] Fetched ${holidays.length} Bayern school holidays`);
        return holidays;
    } catch (error) {
        console.error(`[Holidays] Failed to fetch:`, error);
        return holidayCache.holidays;
    }
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
        // Fetch utilization, weather, and holidays in parallel
        const [utilizationResponse, weather, holidays] = await Promise.all([
            fetch(API_URL),
            fetchWeather(),
            fetchSchoolHolidays(),
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
