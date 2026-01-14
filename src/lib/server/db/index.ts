import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const DB_PATH = process.env.DATABASE_PATH || './data/gym.db';

// Ensure data directory exists
const dbDir = dirname(DB_PATH);
if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
}

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');

// Create table if it doesn't exist
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS utilization_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        weekday INTEGER NOT NULL,
        hour INTEGER NOT NULL,
        percentage INTEGER NOT NULL,
        level TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_weekday_hour ON utilization_readings(weekday, hour);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON utilization_readings(timestamp);
`);

// Migration: Add new columns if they don't exist
// SQLite doesn't support IF NOT EXISTS for columns, so we check manually
function addColumnIfNotExists(table: string, column: string, type: string) {
    try {
        const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        const exists = columns.some(col => col.name === column);
        if (!exists) {
            sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
            console.log(`[DB] Added column ${column} to ${table}`);
        }
    } catch (error) {
        console.error(`[DB] Failed to add column ${column}:`, error);
    }
}

// Weather columns (original)
addColumnIfNotExists('utilization_readings', 'temperature', 'REAL');
addColumnIfNotExists('utilization_readings', 'precipitation', 'REAL');
addColumnIfNotExists('utilization_readings', 'cloud_cover', 'INTEGER');
addColumnIfNotExists('utilization_readings', 'is_raining', 'INTEGER');

// Extended weather columns (new)
addColumnIfNotExists('utilization_readings', 'uv_index', 'REAL');
addColumnIfNotExists('utilization_readings', 'sunrise', 'TEXT');
addColumnIfNotExists('utilization_readings', 'sunset', 'TEXT');

// School holiday columns (new)
addColumnIfNotExists('utilization_readings', 'is_school_holiday', 'INTEGER');
addColumnIfNotExists('utilization_readings', 'holiday_name', 'TEXT');

export const db = drizzle(sqlite, { schema });

export { schema };
