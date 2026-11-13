import { and, gte, notInArray } from 'drizzle-orm';
import { db, schema } from './db';
import { isValidStudioDate } from '../utils/studio-time';
import type { OpeningHours } from './utilization-status';

/** Parses AI Fitness ranges such as "07:00-13:00"; anything else is unknown, not closed. */
export function parseHoursRange(range: unknown): OpeningHours | undefined {
    const match = typeof range === 'string'
        ? /^\s*([01]\d|2[0-4]):([0-5]\d)\s*-\s*([01]\d|2[0-4]):([0-5]\d)\s*$/.exec(range) : null;
    if (!match) return undefined;
    const [, startHour, startMinute, endHour, endMinute] = match;
    if (Number(startHour) * 60 + Number(startMinute) >= Number(endHour) * 60 + Number(endMinute)) return undefined;
    return { startTime: `${startHour}:${startMinute}:00`, endTime: `${endHour}:${endMinute}:00` };
}

let lastSignature: string | null = null;

/**
 * Mirrors the published special hours for today and later. Past rows stay as history;
 * an unchanged payload causes no write, so 15-minute polling stays cheap.
 */
export function syncHolidayHours(raw: unknown, today: string, now = new Date()): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const entries: { date: string; startTime: string; endTime: string }[] = [];
    for (const [date, range] of Object.entries(raw)) {
        const hours = parseHoursRange(range);
        if (isValidStudioDate(date) && hours) entries.push({ date, ...hours });
        else console.warn(`[StudioHours] Ignoring unrecognised special hours ${JSON.stringify(date)}: ${JSON.stringify(range)}`);
    }
    const signature = JSON.stringify([today, entries]);
    if (signature === lastSignature) return;
    const table = schema.studioHours;
    db.transaction(tx => {
        const upcoming = gte(table.date, today);
        tx.delete(table).where(entries.length ? and(upcoming, notInArray(table.date, entries.map(entry => entry.date))) : upcoming).run();
        for (const entry of entries) {
            tx.insert(table).values({ ...entry, updatedAt: now })
                .onConflictDoUpdate({ target: table.date, set: { startTime: entry.startTime, endTime: entry.endTime, updatedAt: now } })
                .run();
        }
    });
    lastSignature = signature;
}
