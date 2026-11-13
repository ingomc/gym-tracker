import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getUpcomingClasses } from '$lib/server/classes';

export const GET: RequestHandler = async () => {
    try {
        return json({ classes: await getUpcomingClasses() }, { headers: { 'Cache-Control': 'public, max-age=300' } });
    } catch (error) {
        console.error('[Classes] Failed to load class schedule:', error);
        return json({ classes: [], error: 'Kursplan ist gerade nicht verfügbar.' }, { status: 503 });
    }
};
