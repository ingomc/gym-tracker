import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$lib/server/db';
import { gte, asc } from 'drizzle-orm';

export const GET: RequestHandler = async () => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Get all individual readings from today, ordered by timestamp
    const readings = await db
        .select({
            timestamp: schema.utilizationReadings.timestamp,
            hour: schema.utilizationReadings.hour,
            percentage: schema.utilizationReadings.percentage,
            level: schema.utilizationReadings.level,
        })
        .from(schema.utilizationReadings)
        .where(gte(schema.utilizationReadings.timestamp, startOfDay))
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
    const dateFormatted = now.toLocaleDateString('de-DE', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
    });

    return json({
        date: startOfDay.toISOString().split('T')[0],
        dateFormatted,
        readings: formattedReadings,
        count: formattedReadings.length,
    });
};
