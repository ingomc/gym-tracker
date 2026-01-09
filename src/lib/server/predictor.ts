/**
 * Predictor service client - calls Python Prophet microservice for predictions.
 */

interface PredictionResult {
    hour: number;
    minute: number;
    percentage: number;
}

interface PredictionResponse {
    date: string;
    weekday: number;
    isHoliday: boolean;
    holidayName: string | null;
    predictions: PredictionResult[];
    error?: string;
}

// URL of the Python predictor service (set via env var or default for Docker)
const PREDICTOR_URL = process.env.PREDICTOR_URL || 'http://predictor:5000';

/**
 * Get predictions for a given date from the Python Prophet service.
 */
export async function predict(date: Date): Promise<PredictionResponse> {
    // Format date as YYYY-MM-DD
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    try {
        const response = await fetch(`${PREDICTOR_URL}/predict?date=${dateStr}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(10000), // 10 second timeout
        });

        if (!response.ok) {
            console.error(`[Predictor] Service returned ${response.status}`);
            return createEmptyResponse(date);
        }

        const data = await response.json();
        return data as PredictionResponse;
    } catch (error) {
        console.error('[Predictor] Failed to fetch predictions:', error);
        return createEmptyResponse(date);
    }
}

/**
 * Check if the predictor service is healthy.
 */
export async function isReady(): Promise<boolean> {
    try {
        const response = await fetch(`${PREDICTOR_URL}/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) return false;

        const data = await response.json();
        return data.model_trained === true;
    } catch {
        return false;
    }
}

/**
 * Create an empty response for when the service is unavailable.
 */
function createEmptyResponse(date: Date): PredictionResponse {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return {
        date: `${year}-${month}-${day}`,
        weekday: date.getDay(),
        isHoliday: false,
        holidayName: null,
        predictions: [],
        error: 'Predictor service unavailable',
    };
}
