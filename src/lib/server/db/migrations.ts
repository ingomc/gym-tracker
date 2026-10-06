import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

/** Snapshot before enforcing unique timestamps; consolidate only identical rows. */
export function ensureUniqueReadingTimestamps(sqlite: Database.Database, databasePath: string): void {
    const indexes = sqlite.prepare('PRAGMA index_list(utilization_readings)').all() as { name: string; unique: number }[];
    if (indexes.some(index => index.name === 'idx_readings_timestamp_unique' && index.unique === 1)) return;
    const { count } = sqlite.prepare('SELECT COUNT(*) AS count FROM utilization_readings').get() as { count: number };
    let backupPath: string | null = null;
    if (count > 0) {
        backupPath = `${databasePath}.before-timestamp-unique-${Date.now()}-${randomUUID()}.bak`;
        // Includes committed WAL contents; a failed backup aborts before changing rows.
        sqlite.prepare('VACUUM INTO ?').run(backupPath);
        console.info(`[DB] Sicherung vor Zeitstempel-Migration: ${backupPath}`);
    }
    sqlite.transaction(() => {
        const duplicates = sqlite.prepare('SELECT timestamp FROM utilization_readings GROUP BY timestamp HAVING COUNT(*) > 1').all() as { timestamp: number }[];
        const findRows = sqlite.prepare('SELECT * FROM utilization_readings WHERE timestamp = ? ORDER BY id');
        const redundantIds: number[] = [];
        const conflicts: number[] = [];
        for (const { timestamp } of duplicates) {
            const [first, ...rest] = findRows.all(timestamp) as Record<string, unknown>[];
            if (rest.some(row => Object.keys(first).some(key => key !== 'id' && row[key] !== first[key]))) conflicts.push(timestamp);
            else redundantIds.push(...rest.map(row => row.id as number));
        }
        if (conflicts.length > 0) {
            throw new Error(`Zeitstempel-Migration abgebrochen: ${conflicts.length} widersprüchliche Messzeitpunkte (${conflicts.slice(0, 10).join(', ')}). Alle Daten bleiben erhalten. Konflikte vor einem Neustart manuell auflösen. Sicherung: ${backupPath}`);
        }
        const remove = sqlite.prepare('DELETE FROM utilization_readings WHERE id = ?');
        for (const id of redundantIds) remove.run(id);
        sqlite.exec('CREATE UNIQUE INDEX idx_readings_timestamp_unique ON utilization_readings(timestamp)');
        if (redundantIds.length) console.info(`[DB] ${redundantIds.length} identische Duplikate nach Sicherung zusammengeführt.`);
    }).immediate();
}
