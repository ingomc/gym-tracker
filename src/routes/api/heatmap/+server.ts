import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$lib/server/db';
import { gte, sql } from 'drizzle-orm';

export const GET: RequestHandler = async ({ url }) => {
    const weeks = parseInt(url.searchParams.get('weeks') || '4', 10);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - (weeks * 7));

    // Get average percentage for each weekday/hour combination
    const readings = await db
        .select({
            weekday: schema.utilizationReadings.weekday,
            hour: schema.utilizationReadings.hour,
            avgPercentage: sql<number>`ROUND(AVG(${schema.utilizationReadings.percentage}), 1)`.as('avgPercentage'),
            maxPercentage: sql<number>`MAX(${schema.utilizationReadings.percentage})`.as('maxPercentage'),
            minPercentage: sql<number>`MIN(${schema.utilizationReadings.percentage})`.as('minPercentage'),
            dataPoints: sql<number>`COUNT(*)`.as('dataPoints'),
        })
        .from(schema.utilizationReadings)
        .where(gte(schema.utilizationReadings.timestamp, cutoffDate))
        .groupBy(schema.utilizationReadings.weekday, schema.utilizationReadings.hour);

    // Create a 7x24 matrix (weekday x hour)
    // Gym hours are 06:00-22:00, but we'll include all for flexibility
    const weekdayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

    const heatmapData = weekdayNames.map((name, weekday) => {
        const hoursData = Array.from({ length: 24 }, (_, hour) => {
            const reading = readings.find(r => r.weekday === weekday && r.hour === hour);
            return {
                hour,
                avgPercentage: reading?.avgPercentage ?? null,
                maxPercentage: reading?.maxPercentage ?? null,
                minPercentage: reading?.minPercentage ?? null,
                dataPoints: reading?.dataPoints ?? 0,
            };
        });

        return {
            weekday,
            weekdayName: name,
            hours: hoursData,
        };
    });

    return json({
        weeks,
        startDate: cutoffDate.toISOString().split('T')[0],
        endDate: new Date().toISOString().split('T')[0],
        data: heatmapData,
    });
};
