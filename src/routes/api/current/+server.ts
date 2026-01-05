import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$lib/server/db';
import { desc } from 'drizzle-orm';

export const GET: RequestHandler = async () => {
    // Get the latest reading
    const latest = await db
        .select()
        .from(schema.utilizationReadings)
        .orderBy(desc(schema.utilizationReadings.timestamp))
        .limit(1);

    if (latest.length === 0) {
        return json({
            percentage: null,
            level: null,
            lastUpdated: null,
            message: 'No data available yet'
        });
    }

    const reading = latest[0];
    return json({
        percentage: reading.percentage,
        level: reading.level,
        lastUpdated: reading.timestamp.toISOString(),
    });
};
