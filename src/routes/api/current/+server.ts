import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$lib/server/db';
import { desc } from 'drizzle-orm';
import { getUtilizationSourceSnapshot } from '$lib/server/fetcher';
import { getPollIntervalMinutes, getUtilizationStatus } from '$lib/server/utilization-status';

export const GET: RequestHandler = async () => {
    // Get the latest reading
    const latest = await db
        .select()
        .from(schema.utilizationReadings)
        .orderBy(desc(schema.utilizationReadings.timestamp))
        .limit(1);

    const reading = latest[0];
    const status = getUtilizationStatus({
        now: new Date(),
        lastUpdated: reading?.timestamp ?? null,
        source: getUtilizationSourceSnapshot(),
        pollIntervalMinutes: getPollIntervalMinutes(),
    });
    return json({
        status,
        percentage: status === 'closed' ? 0 : status === 'unavailable' ? null : reading?.percentage ?? null,
        level: status === 'closed' || status === 'unavailable' ? null : reading?.level ?? null,
        lastUpdated: reading?.timestamp.toISOString() ?? null,
        weather: status === 'live' && reading && reading.temperature !== null ? {
            temperature: reading.temperature,
            precipitation: reading.precipitation,
            cloudCover: reading.cloudCover,
            isRaining: reading.isRaining === 1,
        } : null,
    }, { headers: { 'Cache-Control': 'no-store' } });
};
