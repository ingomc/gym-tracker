import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { utilizationReadings } from '$lib/server/db/schema';
import { sql } from 'drizzle-orm';

interface ImportReading {
    id?: number;
    timestamp: string | number;
    weekday: number;
    hour: number;
    percentage: number;
    level: string;
    temperature?: number | null;
    precipitation?: number | null;
    cloudCover?: number | null;
    isRaining?: number | null;
}

interface ImportPayload {
    version: number;
    readings: ImportReading[];
}

/**
 * Import utilization readings from JSON backup.
 * Uses INSERT OR REPLACE to handle duplicates based on timestamp.
 */
export const POST: RequestHandler = async ({ request }) => {
    try {
        const payload: ImportPayload = await request.json();

        if (!payload.readings || !Array.isArray(payload.readings)) {
            return json({ error: 'Invalid import format: readings array required' }, { status: 400 });
        }

        let imported = 0;
        let skipped = 0;

        // Process in batches
        const batchSize = 100;
        for (let i = 0; i < payload.readings.length; i += batchSize) {
            const batch = payload.readings.slice(i, i + batchSize);

            for (const reading of batch) {
                // Convert timestamp to Date object
                let timestamp: Date;
                if (typeof reading.timestamp === 'string') {
                    timestamp = new Date(reading.timestamp);
                } else if (typeof reading.timestamp === 'number') {
                    // Could be seconds or milliseconds
                    timestamp = reading.timestamp > 1e12
                        ? new Date(reading.timestamp)
                        : new Date(reading.timestamp * 1000);
                } else {
                    skipped++;
                    continue;
                }

                if (isNaN(timestamp.getTime())) {
                    skipped++;
                    continue;
                }

                try {
                    // Use INSERT OR REPLACE based on timestamp uniqueness
                    await db.insert(utilizationReadings).values({
                        timestamp,
                        weekday: reading.weekday,
                        hour: reading.hour,
                        percentage: reading.percentage,
                        level: reading.level,
                        temperature: reading.temperature ?? null,
                        precipitation: reading.precipitation ?? null,
                        cloudCover: reading.cloudCover ?? null,
                        isRaining: reading.isRaining ?? null,
                    }).onConflictDoNothing();

                    imported++;
                } catch (err) {
                    // Skip duplicates or other insert errors
                    skipped++;
                }
            }
        }

        return json({
            success: true,
            imported,
            skipped,
            total: payload.readings.length,
        });
    } catch (error) {
        console.error('Import failed:', error);
        return json({ error: 'Import failed: ' + (error instanceof Error ? error.message : 'Unknown error') }, { status: 500 });
    }
};
