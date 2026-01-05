import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$lib/server/db';
import { eq, and, gte, sql } from 'drizzle-orm';

export const GET: RequestHandler = async () => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Get all readings from today, grouped by hour with the latest value per hour
    const readings = await db
        .select({
            hour: schema.utilizationReadings.hour,
            percentage: sql<number>`MAX(${schema.utilizationReadings.percentage})`.as('percentage'),
            level: schema.utilizationReadings.level,
            count: sql<number>`COUNT(*)`.as('count'),
        })
        .from(schema.utilizationReadings)
        .where(gte(schema.utilizationReadings.timestamp, startOfDay))
        .groupBy(schema.utilizationReadings.hour)
        .orderBy(schema.utilizationReadings.hour);

    // Create a full 24-hour array with nulls for missing hours
    const hourlyData = Array.from({ length: 24 }, (_, hour) => {
        const reading = readings.find(r => r.hour === hour);
        return {
            hour,
            percentage: reading?.percentage ?? null,
            level: reading?.level ?? null,
            dataPoints: reading?.count ?? 0,
        };
    });

    return json({
        date: startOfDay.toISOString().split('T')[0],
        hourlyData,
    });
};
