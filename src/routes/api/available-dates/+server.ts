import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$lib/server/db';
import { studioDateString } from '$lib/utils/studio-time';

export const GET: RequestHandler = async () => {
    const readings = await db.select({ timestamp: schema.utilizationReadings.timestamp }).from(schema.utilizationReadings);
    // SQLite's 'localtime' follows the server timezone, not necessarily the studio.
    const counts = new Map<string, number>();
    for (const { timestamp } of readings) {
        const date = studioDateString(timestamp);
        counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    const dates = [...counts.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, count]) => ({ date, count }));
    return json({ dates, count: dates.length });
};
