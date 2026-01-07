import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$lib/server/db';
import { gte, lt, and, asc } from 'drizzle-orm';

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

    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    // Get all individual readings for the specified day, ordered by timestamp
    const readings = await db
        .select({
            timestamp: schema.utilizationReadings.timestamp,
            hour: schema.utilizationReadings.hour,
            percentage: schema.utilizationReadings.percentage,
            level: schema.utilizationReadings.level,
        })
        .from(schema.utilizationReadings)
        .where(and(
            gte(schema.utilizationReadings.timestamp, startOfDay),
            lt(schema.utilizationReadings.timestamp, endOfDay)
        ))
        .orderBy(asc(schema.utilizationReadings.timestamp));

    // Format readings with time strings
    const formattedReadings = readings.map(r => ({
        time: r.timestamp.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
        timestamp: r.timestamp.toISOString(),
        hour: r.hour,
        minute: r.timestamp.getMinutes(),
        percentage: r.percentage,
        level: r.level,
    }));

    // Format date in German
    const dateFormatted = startOfDay.toLocaleDateString('de-DE', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
    });

    // Check if this is today
    const now = new Date();
    const isToday = startOfDay.toDateString() === new Date(now.getFullYear(), now.getMonth(), now.getDate()).toDateString();

    // Format date as YYYY-MM-DD in local timezone
    const year = startOfDay.getFullYear();
    const month = String(startOfDay.getMonth() + 1).padStart(2, '0');
    const day = String(startOfDay.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    return json({
        date: dateStr,
        dateFormatted,
        isToday,
        readings: formattedReadings,
        count: formattedReadings.length,
    });
};
