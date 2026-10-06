import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$lib/server/db';
import { and, gte, lte } from 'drizzle-orm';
import { addStudioDays, studioDateString, studioDayBounds, studioParts, studioWeekday } from '$lib/utils/studio-time';

export const GET: RequestHandler = async ({ url }) => {
    const weeksParam = url.searchParams.get('weeks') ?? '4';
    if (!/^\d+$/.test(weeksParam) || Number(weeksParam) < 1 || Number(weeksParam) > 52) {
        return json({ error: 'weeks muss eine ganze Zahl zwischen 1 und 52 sein.' }, { status: 400 });
    }
    const weeks = Number(weeksParam);
    const now = new Date();
    const endDate = studioDateString(now);
    const startDate = addStudioDays(endDate, -weeks * 7);
    const { start } = studioDayBounds(startDate);
    const readings = await db.select({ timestamp: schema.utilizationReadings.timestamp, percentage: schema.utilizationReadings.percentage })
        .from(schema.utilizationReadings)
        .where(and(gte(schema.utilizationReadings.timestamp, start), lte(schema.utilizationReadings.timestamp, now)));
    const daily = new Map<string, { date: string; hour: number; values: number[] }>();
    for (const reading of readings) {
        const { date, hour } = studioParts(reading.timestamp);
        const key = `${date}/${hour}`;
        const cell = daily.get(key) ?? { date, hour, values: [] };
        cell.values.push(reading.percentage);
        daily.set(key, cell);
    }
    const weekdayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
    const cells = new Map<string, { means: number[]; min: number; max: number; count: number }>();
    for (const { date, hour, values } of daily.values()) {
        const key = `${studioWeekday(date)}/${hour}`;
        const cell = cells.get(key) ?? { means: [], min: 100, max: 0, count: 0 };
        cell.means.push(values.reduce((sum, value) => sum + value, 0) / values.length);
        for (const value of values) { cell.min = Math.min(cell.min, value); cell.max = Math.max(cell.max, value); }
        cell.count += values.length;
        cells.set(key, cell);
    }
    const data = weekdayNames.map((weekdayName, weekday) => ({
        weekday, weekdayName,
        hours: Array.from({ length: 24 }, (_, hour) => {
            const cell = cells.get(`${weekday}/${hour}`);
            return {
                hour,
                avgPercentage: cell ? Math.round(cell.means.reduce((sum, value) => sum + value, 0) / cell.means.length * 10) / 10 : null,
                maxPercentage: cell?.max ?? null, minPercentage: cell?.min ?? null,
                dataPoints: cell?.count ?? 0, observedDays: cell?.means.length ?? 0,
            };
        }),
    }));
    return json({ weeks, startDate, endDate, data });
};
