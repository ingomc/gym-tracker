import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { predict, isReady } from '$lib/server/predictor';

export const GET: RequestHandler = async ({ url }) => {
    const dateParam = url.searchParams.get('date');

    let targetDate: Date;
    if (dateParam) {
        // Parse the date parameter (YYYY-MM-DD format)
        const [year, month, day] = dateParam.split('-').map(Number);
        targetDate = new Date(year, month - 1, day);
    } else {
        targetDate = new Date();
    }

    // Check if predictor is ready
    if (!isReady()) {
        return json({
            error: 'Predictor not ready yet, still training...',
            date: null,
            weekday: null,
            isHoliday: false,
            holidayName: null,
            predictions: [],
        }, { status: 503 });
    }

    const result = await predict(targetDate);
    return json(result);
};
