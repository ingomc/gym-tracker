import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { predict } from '$lib/server/predictor';
import { addStudioDays, isValidStudioDate, studioDateString } from '$lib/utils/studio-time';

export const GET: RequestHandler = async ({ url }) => {
    const today = studioDateString();
    const date = url.searchParams.get('date') ?? today;
    if (!isValidStudioDate(date) || date > addStudioDays(today, 7)) {
        return json({ status: 'unavailable', error: 'Bitte ein gültiges Datum bis sieben Tage im Voraus wählen.', predictions: [] }, { status: 400 });
    }
    const result = await predict(date);
    return json(result.data, { status: result.httpStatus, headers: { 'Cache-Control': 'no-store' } });
};
