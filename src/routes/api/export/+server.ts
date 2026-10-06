import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { utilizationReadings } from '$lib/server/db/schema';
import { asc } from 'drizzle-orm';
import { createExportPayload } from '$lib/server/data-transfer';
import { studioDateString } from '$lib/utils/studio-time';

/**
 * Export all utilization readings as JSON for backup/transfer.
 * Requires authentication.
 */
export const GET: RequestHandler = async ({ cookies }) => {
    // Check authentication
    const session = cookies.get('auth_session');
    if (session !== 'valid') {
        return json({ error: 'Nicht autorisiert' }, { status: 401 });
    }

    try {
        const readings = await db
            .select()
            .from(utilizationReadings)
            .orderBy(asc(utilizationReadings.timestamp));

        const exportPayload = createExportPayload(readings);

        return new Response(JSON.stringify(exportPayload, null, 2), {
            headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="gym-tracker-export-${studioDateString()}.json"`,
            },
        });
    } catch (error) {
        console.error('Export failed:', error);
        return json({ error: 'Export failed' }, { status: 500 });
    }
};
