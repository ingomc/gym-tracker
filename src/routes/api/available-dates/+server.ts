import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$lib/server/db';
import { sql } from 'drizzle-orm';

export const GET: RequestHandler = async () => {
    // Get all unique dates that have data
    const result = await db
        .select({
            date: sql<string>`DATE(${schema.utilizationReadings.timestamp}, 'unixepoch', 'localtime')`.as('date'),
            count: sql<number>`COUNT(*)`.as('count'),
        })
        .from(schema.utilizationReadings)
        .groupBy(sql`DATE(${schema.utilizationReadings.timestamp}, 'unixepoch', 'localtime')`)
        .orderBy(sql`DATE(${schema.utilizationReadings.timestamp}, 'unixepoch', 'localtime') DESC`);

    const dates = result.map(r => ({
        date: r.date,
        count: r.count,
    }));

    return json({
        dates,
        count: dates.length,
    });
};
