import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$lib/server/db';
import { and, asc, gte, lt } from 'drizzle-orm';
import { isValidStudioDate, studioDateString, studioDayBounds, studioParts } from '$lib/utils/studio-time';

export const GET: RequestHandler = async ({ url }) => {
    const date = url.searchParams.get('date') ?? studioDateString();
    if (!isValidStudioDate(date)) return json({ error: 'Ungültiges Datum. Erwartet wird YYYY-MM-DD.' }, { status: 400 });
    const { start, end } = studioDayBounds(date);
    const readings = await db.select().from(schema.utilizationReadings)
        .where(and(gte(schema.utilizationReadings.timestamp, start), lt(schema.utilizationReadings.timestamp, end)))
        .orderBy(asc(schema.utilizationReadings.timestamp));
    const hourlyData = Array.from({ length: 24 }, (_, hour) => ({
        hour, percentage: null as number | null, level: null as string | null, dataPoints: 0,
    }));
    // Keep the last observed value in each hour, rather than labelling the maximum as latest.
    for (const reading of readings) {
        const hour = hourlyData[studioParts(reading.timestamp).hour];
        hour.percentage = reading.percentage;
        hour.level = reading.level;
        hour.dataPoints++;
    }
    return json({ date, hourlyData });
};
