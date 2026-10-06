import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { utilizationReadings } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { ImportError, parseImportPayload, readImportRequest, readingsMatch } from '$lib/server/data-transfer';

export const POST: RequestHandler = async ({ request, cookies }) => {
    const session = cookies.get('auth_session');
    if (session !== 'valid') return json({ error: 'Nicht autorisiert' }, { status: 401 });

    try {
        const readings = parseImportPayload(await readImportRequest(request));
        const result = db.transaction(tx => {
            let imported = 0;
            let skipped = 0;
            for (const reading of readings) {
                const inserted = tx.insert(utilizationReadings).values(reading).onConflictDoNothing({ target: utilizationReadings.timestamp }).run();
                if (inserted.changes > 0) {
                    imported += inserted.changes;
                } else {
                    const existing = tx.select().from(utilizationReadings).where(eq(utilizationReadings.timestamp, reading.timestamp)).get();
                    if (!existing || !readingsMatch(reading, existing)) {
                        throw new ImportError(`Widersprüchliche Messung für ${reading.timestamp.toISOString()}. Der gesamte Import wurde zurückgerollt; vorhandene Daten bleiben erhalten.`, 409);
                    }
                    skipped++;
                }
            }
            return { imported, skipped };
        }, { behavior: 'immediate' });
        return json({ success: true, ...result, total: readings.length });
    } catch (error) {
        if (error instanceof ImportError) return json({ error: error.message }, { status: error.status });
        console.error('Import failed:', error);
        return json({ error: 'Import fehlgeschlagen. Es wurden keine Messungen importiert.' }, { status: 500 });
    }
};
