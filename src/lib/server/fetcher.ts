import { db, schema } from './db';

const API_URL = process.env.API_URL || 'https://www.ai-fitness.de/connect/v1/studio/1412625590/utilization';

// Coburg, Germany coordinates for weather API
const WEATHER_LAT = 50.2612;
const WEATHER_LON = 10.9628;
const WEATHER_API_URL = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&current=temperature_2m,precipitation,cloud_cover,rain`;

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
}

interface OpenMeteoResponse {
    current: {
        temperature_2m: number;
        precipitation: number;
        cloud_cover: number;
        rain: number;
    };
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
        };
    } catch (error) {
        console.error(`[Weather] Failed to fetch:`, error);
        return null;
    }
}

export async function fetchAndStoreUtilization(): Promise<{ success: boolean; percentage?: number; error?: string }> {
    try {
        // Fetch utilization and weather in parallel
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

        // Insert into database with weather data
        await db.insert(schema.utilizationReadings).values({
            timestamp: now,
            weekday,
            hour,
            percentage: currentSlot.percentage,
            level: currentSlot.level,
            temperature: weather?.temperature ?? null,
            precipitation: weather?.precipitation ?? null,
            cloudCover: weather?.cloudCover ?? null,
            isRaining: weather?.isRaining ?? null,
        });

        const weatherInfo = weather
            ? `${weather.temperature}°C, ${weather.isRaining ? 'Regen' : 'kein Regen'}`
            : 'no weather data';
        console.log(`[${now.toISOString()}] Stored: ${currentSlot.percentage}% (${currentSlot.level}) | Weather: ${weatherInfo}`);

        return { success: true, percentage: currentSlot.percentage };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${new Date().toISOString()}] Failed to fetch utilization: ${message}`);
        return { success: false, error: message };
    }
}
