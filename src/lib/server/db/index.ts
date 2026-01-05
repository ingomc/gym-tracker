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

export const db = drizzle(sqlite, { schema });

export { schema };
