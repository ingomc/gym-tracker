import { isValidStudioDate, studioParts } from '../utils/studio-time';
import type { NewUtilizationReading, UtilizationReading } from './db/schema';

export const TRANSFER_VERSION = 2;
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
export const IMPORT_SIZE_MESSAGE = 'Die Datei ist zu groß. Maximal 16 MiB sind erlaubt.';

export class ImportError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}

function object(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberField(row: Record<string, unknown>, key: string, min: number, max: number, integer = false): number | null {
    const value = row[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        throw new ImportError(`${key} muss ${integer ? 'eine ganze Zahl' : 'eine Zahl'} zwischen ${min} und ${max} sein.`);
    }
    return value;
}

function timeField(row: Record<string, unknown>, key: string): string | null {
    const value = row[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        throw new ImportError(`${key} muss eine Uhrzeit im Format HH:MM sein.`);
    }
    return value;
}

function timestampField(value: unknown, now: Date): Date {
    let timestamp: Date;
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
        timestamp = new Date(value >= 1e12 ? value : value * 1000);
    } else if (typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)
        && isValidStudioDate(value.slice(0, 10))) {
        timestamp = new Date(value);
    } else {
        throw new ImportError('timestamp muss ein ISO-Zeitstempel mit Zeitzone oder Unix-Zeitstempel sein.');
    }
    if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() < 0 || timestamp.getTime() > now.getTime() + 60_000) {
        throw new ImportError('timestamp ist ungültig oder liegt in der Zukunft.');
    }
    // SQLite timestamp mode stores seconds; normalize before comparing duplicate keys.
    return new Date(Math.floor(timestamp.getTime() / 1000) * 1000);
}

export function parseImportPayload(payload: unknown, now = new Date()): NewUtilizationReading[] {
    if (!object(payload) || ![1, TRANSFER_VERSION].includes(payload.version as number) || !Array.isArray(payload.readings)) {
        throw new ImportError('Ungültiges Exportformat: Unterstützt werden Version 1 und 2 mit einem readings-Array.');
    }
    return payload.readings.map((value, index) => {
        try {
            if (!object(value)) throw new ImportError('Messung muss ein Objekt sein.');
            const timestamp = timestampField(value.timestamp, now);
            const { hour, weekday } = studioParts(timestamp);
            numberField(value, 'hour', 0, 23, true);
            numberField(value, 'weekday', 0, 6, true);
            const percentage = numberField(value, 'percentage', 0, 100, true);
            if (percentage === null) throw new ImportError('percentage fehlt.');
            if (typeof value.level !== 'string' || !['LOW', 'MEDIUM', 'HIGH'].includes(value.level)) {
                throw new ImportError('level muss LOW, MEDIUM oder HIGH sein.');
            }
            const holidayName = value.holidayName ?? null;
            if (holidayName !== null && (typeof holidayName !== 'string' || holidayName.length > 200)) {
                throw new ImportError('holidayName muss Text mit maximal 200 Zeichen sein.');
            }
            return {
                timestamp, hour, weekday, percentage, level: value.level,
                temperature: numberField(value, 'temperature', -100, 70),
                precipitation: numberField(value, 'precipitation', 0, 1000),
                cloudCover: numberField(value, 'cloudCover', 0, 100, true),
                isRaining: numberField(value, 'isRaining', 0, 1, true),
                uvIndex: numberField(value, 'uvIndex', 0, 30),
                sunrise: timeField(value, 'sunrise'), sunset: timeField(value, 'sunset'),
                isSchoolHoliday: numberField(value, 'isSchoolHoliday', 0, 1, true), holidayName,
            };
        } catch (error) {
            if (error instanceof ImportError) throw new ImportError(`Messung ${index + 1}: ${error.message}`);
            throw error;
        }
    });
}

export function readingsMatch(a: NewUtilizationReading, b: NewUtilizationReading): boolean {
    return Object.entries(a).every(([key, value]) => {
        if (key === 'id') return true;
        const other = b[key as keyof NewUtilizationReading];
        return value instanceof Date && other instanceof Date ? value.getTime() === other.getTime() : (value ?? null) === (other ?? null);
    });
}

export function createExportPayload(readings: UtilizationReading[], now = new Date()) {
    return {
        version: TRANSFER_VERSION,
        exportedAt: now.toISOString(),
        recordCount: readings.length,
        timeZone: 'Europe/Berlin',
        readings: readings.map(row => ({ ...row, timestamp: row.timestamp.toISOString() })),
    };
}

export async function readImportRequest(request: Request): Promise<unknown> {
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_IMPORT_BYTES) throw new ImportError(IMPORT_SIZE_MESSAGE, 413);
    if (!request.body) throw new ImportError('Die Importdatei ist leer.');
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_IMPORT_BYTES) {
                await reader.cancel();
                throw new ImportError(IMPORT_SIZE_MESSAGE, 413);
            }
            chunks.push(value);
        }
    } catch (error) {
        if (error instanceof ImportError) throw error;
        if (object(error) && error.status === 413) throw new ImportError(IMPORT_SIZE_MESSAGE, 413);
        throw new ImportError('Die Importdatei konnte nicht gelesen werden.');
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        throw new ImportError('Die Importdatei enthält kein gültiges UTF-8-JSON.');
    }
}
