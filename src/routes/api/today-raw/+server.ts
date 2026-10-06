import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$lib/server/db';
import { gte, lt, and, asc, max } from 'drizzle-orm';
import { isValidStudioDate, studioDateString, studioDayBounds, studioParts, STUDIO_TIME_ZONE } from '$lib/utils/studio-time';

export const GET: RequestHandler = async ({ url }) => {
    const date = url.searchParams.get('date') ?? studioDateString();
    if (!isValidStudioDate(date)) return json({ error: 'Ungültiges Datum. Erwartet wird YYYY-MM-DD.' }, { status: 400 });
    const { start, end } = studioDayBounds(date);
    const readings = await db.select({
        timestamp: schema.utilizationReadings.timestamp,
        percentage: schema.utilizationReadings.percentage,
        level: schema.utilizationReadings.level,
    }).from(schema.utilizationReadings)
        .where(and(gte(schema.utilizationReadings.timestamp, start), lt(schema.utilizationReadings.timestamp, end)))
        .orderBy(asc(schema.utilizationReadings.timestamp));
    const formattedReadings = readings.map(reading => {
        const { hour, minute } = studioParts(reading.timestamp);
        return {
            time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
            timestamp: reading.timestamp.toISOString(), hour, minute,
            percentage: reading.percentage, level: reading.level,
        };
    });
    const [maxResult] = await db.select({ maxPct: max(schema.utilizationReadings.percentage) }).from(schema.utilizationReadings);
    return json({
        date,
        dateFormatted: start.toLocaleDateString('de-DE', { timeZone: STUDIO_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long' }),
        isToday: date === studioDateString(),
        allTimeMax: maxResult?.maxPct ?? 0,
        readings: formattedReadings,
        count: formattedReadings.length,
    });
};
