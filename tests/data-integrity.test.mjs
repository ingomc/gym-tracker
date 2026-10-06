import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import ts from 'typescript';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const originalTimezone = process.env.TZ;
process.env.TZ = 'UTC';
after(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
});

// Execute the actual TypeScript route handlers with a real isolated SQLite database.
function loadTs(relative, overrides = {}, cache = new Map()) {
    const path = resolve(root, relative);
    if (cache.has(path)) return cache.get(path);
    const source = readFileSync(path, 'utf8');
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    });
    const module = { exports: {} };
    cache.set(path, module.exports);
    const localRequire = specifier => {
        if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
        if (specifier === '@sveltejs/kit') return { json: (value, options = {}) => new Response(JSON.stringify(value), { ...options, headers: { 'Content-Type': 'application/json' } }) };
        if (specifier.startsWith('.') || specifier.startsWith('$lib/')) {
            let dependency = specifier.startsWith('$lib/') ? join(root, 'src/lib', specifier.slice(5)) : resolve(dirname(path), specifier);
            dependency = existsSync(`${dependency}.ts`) ? `${dependency}.ts` : join(dependency, 'index.ts');
            return loadTs(dependency, overrides, cache);
        }
        return require(specifier);
    };
    new Function('require', 'module', 'exports', outputText)(localRequire, module, module.exports);
    return module.exports;
}

const time = loadTs('src/lib/utils/studio-time.ts');
const transfer = loadTs('src/lib/server/data-transfer.ts');
const migration = loadTs('src/lib/server/db/migrations.ts');
const schema = loadTs('src/lib/server/db/schema.ts');

function database({ unique = true, path = ':memory:' } = {}) {
    const sqlite = new Database(path);
    sqlite.pragma('journal_mode = WAL');
    sqlite.exec(`CREATE TABLE utilization_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL, weekday INTEGER NOT NULL, hour INTEGER NOT NULL,
        percentage INTEGER NOT NULL, level TEXT NOT NULL,
        temperature REAL, precipitation REAL, cloud_cover INTEGER, is_raining INTEGER,
        uv_index REAL, sunrise TEXT, sunset TEXT, is_school_holiday INTEGER, holiday_name TEXT
    )`);
    if (unique) sqlite.exec('CREATE UNIQUE INDEX idx_readings_timestamp_unique ON utilization_readings(timestamp)');
    const db = drizzle(sqlite, { schema });
    return { sqlite, db, schema };
}

function fixture(overrides = {}) {
    return {
        timestamp: '2026-01-13T12:15:00Z', weekday: 2, hour: 13,
        percentage: 17, level: 'LOW', temperature: -1.5, precipitation: 0.1,
        cloudCover: 70, isRaining: 1, uvIndex: 0.3, sunrise: '08:04', sunset: '16:40',
        isSchoolHoliday: 0, holidayName: null, ...overrides,
    };
}

function request(readings, version = 2) {
    return new Request('http://localhost/api/import', { method: 'POST', body: JSON.stringify({ version, readings }) });
}

function importer(context) {
    return loadTs('src/routes/api/import/+server.ts', { '$lib/server/db': context }).POST;
}
const cookies = { get: () => 'valid' };

function insert(context, rows) {
    const parsed = transfer.parseImportPayload({ version: 2, readings: rows }, new Date('2100-01-01T00:00:00Z'));
    for (const row of parsed) context.db.insert(schema.utilizationReadings).values(row).run();
}

test('Berlin calendar dates validate strictly and use actual DST day boundaries on a UTC server', () => {
    for (const invalid of ['', '2026-1-01', '2026-02-30', '2025-02-29', '2026-13-01', '2026-01-01junk']) {
        assert.equal(time.isValidStudioDate(invalid), false, invalid);
    }
    assert.equal(time.isValidStudioDate('2024-02-29'), true);
    assert.equal(time.studioDateString(new Date('2026-01-01T23:30:00Z')), '2026-01-02');
    assert.equal(time.addStudioDays('2026-03-29', 1), '2026-03-30');
    assert.equal(time.studioParts(new Date('2026-07-13T22:15:00Z')).hour, 0);
    const spring = time.studioDayBounds('2026-03-29');
    const autumn = time.studioDayBounds('2026-10-25');
    assert.equal(spring.start.toISOString(), '2026-03-28T23:00:00.000Z');
    assert.equal(spring.end.toISOString(), '2026-03-29T22:00:00.000Z');
    assert.equal((spring.end - spring.start) / 3_600_000, 23);
    assert.equal((autumn.end - autumn.start) / 3_600_000, 25);
    assert.deepEqual(time.studioOpeningHours('2026-10-10'), { startHour: 7, endHour: 22 });
});

test('export v2 and legacy v1 preserve all measurement fields and derive Berlin time fields', () => {
    const [reading] = transfer.parseImportPayload({ version: 1, readings: [fixture({ weekday: 0, hour: 0 })] }, new Date('2026-10-07T12:00:00Z'));
    assert.equal(reading.weekday, 2);
    assert.equal(reading.hour, 13);
    const exported = transfer.createExportPayload([{ id: 22, ...reading }]);
    assert.equal(exported.version, 2);
    assert.equal(exported.timeZone, 'Europe/Berlin');
    assert.deepEqual(transfer.parseImportPayload(exported), [reading]);
    assert.equal(exported.readings[0].uvIndex, 0.3);
    assert.equal(exported.readings[0].sunrise, '08:04');
    assert.equal(exported.readings[0].isSchoolHoliday, 0);
});

test('validation rejects malformed measurements before writing anything', async () => {
    const context = database();
    try {
        const post = importer(context);
        for (const bad of [
            { percentage: -1 }, { percentage: 101 }, { percentage: null }, { percentage: '17' },
            { timestamp: '2026-02-30T12:00:00Z' }, { timestamp: '2026-01-13T12:00:00' },
            { timestamp: '2200-01-13T12:00:00Z' }, { isRaining: 2 }, { sunrise: '28:00' },
            { level: '<script>' }, { temperature: 1000 }, { uvIndex: -2 },
        ]) {
            const response = await post({ cookies, request: request([fixture(), fixture(bad)]) });
            assert.equal(response.status, 400, JSON.stringify(bad));
            assert.equal(context.sqlite.prepare('SELECT COUNT(*) n FROM utilization_readings').get().n, 0);
        }
        const malformed = await post({ cookies, request: new Request('http://localhost/api/import', { method: 'POST', body: '{' }) });
        assert.equal(malformed.status, 400);
    } finally { context.sqlite.close(); }
});

test('actual import handler is idempotent, preserves new fields, and reports real insert counts', async () => {
    const context = database();
    try {
        const post = importer(context);
        const rows = [fixture(), fixture({ timestamp: '2026-01-13T12:30:00Z', percentage: 0 })];
        const first = await post({ cookies, request: request([...rows, rows[0]], 1) });
        assert.equal(first.status, 200);
        assert.deepEqual(await first.json(), { success: true, imported: 2, skipped: 1, total: 3 });
        const repeated = await post({ cookies, request: request(rows) });
        assert.deepEqual(await repeated.json(), { success: true, imported: 0, skipped: 2, total: 2 });
        const exported = loadTs('src/routes/api/export/+server.ts', { '$lib/server/db': context }).GET;
        const payload = await (await exported({ cookies })).json();
        assert.equal(payload.version, 2);
        assert.equal(payload.readings.length, 2);
        for (const key of ['temperature', 'precipitation', 'cloudCover', 'isRaining', 'uvIndex', 'sunrise', 'sunset', 'isSchoolHoliday', 'holidayName']) {
            assert.equal(payload.readings[0][key], rows[0][key], key);
        }
        assert.equal(payload.readings[1].percentage, 0);
    } finally { context.sqlite.close(); }
});

test('conflicting duplicates roll back the complete import instead of silently overwriting data', async () => {
    const context = database();
    try {
        insert(context, [fixture()]);
        const response = await importer(context)({ cookies, request: request([
            fixture({ timestamp: '2026-01-13T13:00:00Z' }), fixture({ percentage: 40 }),
        ]) });
        assert.equal(response.status, 409);
        const rows = context.sqlite.prepare('SELECT * FROM utilization_readings').all();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].percentage, 17);
    } finally { context.sqlite.close(); }
});

test('import enforces 16 MiB with and without Content-Length; authentication stays required', async () => {
    const context = database();
    try {
        const post = importer(context);
        const noAuth = await post({ cookies: { get: () => undefined }, request: request([fixture()]) });
        assert.equal(noAuth.status, 401);
        const oversizedHeader = new Request('http://localhost/api/import', { method: 'POST', body: '{}', headers: { 'content-length': String(transfer.MAX_IMPORT_BYTES + 1) } });
        assert.equal((await post({ cookies, request: oversizedHeader })).status, 413);
        const oversizedBody = new Request('http://localhost/api/import', { method: 'POST', body: new Uint8Array(transfer.MAX_IMPORT_BYTES + 1) });
        const response = await post({ cookies, request: oversizedBody });
        assert.equal(response.status, 413);
        assert.match((await response.json()).error, /16 MiB/);
    } finally { context.sqlite.close(); }
});

test('timestamp migration backs up WAL data before consolidating exact duplicates', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gym-data-migration-'));
    const context = database({ unique: false, path: join(directory, 'gym.db') });
    try {
        insert(context, [fixture(), fixture()]);
        migration.ensureUniqueReadingTimestamps(context.sqlite, join(directory, 'gym.db'));
        assert.equal(context.sqlite.prepare('SELECT COUNT(*) n FROM utilization_readings').get().n, 1);
        const backups = readdirSync(directory).filter(name => name.endsWith('.bak'));
        assert.equal(backups.length, 1);
        const backup = new Database(join(directory, backups[0]), { readonly: true });
        assert.equal(backup.prepare('SELECT COUNT(*) n FROM utilization_readings').get().n, 2);
        backup.close();
        assert.throws(() => insert(context, [fixture()]), /UNIQUE/);
        migration.ensureUniqueReadingTimestamps(context.sqlite, join(directory, 'gym.db'));
        assert.equal(readdirSync(directory).filter(name => name.endsWith('.bak')).length, 1);
    } finally { context.sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('timestamp migration preserves every conflicting row and aborts with a recovery path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gym-data-conflict-'));
    const context = database({ unique: false });
    try {
        insert(context, [fixture(), fixture({ percentage: 40 })]);
        assert.throws(() => migration.ensureUniqueReadingTimestamps(context.sqlite, join(directory, 'gym.db')), /widersprüchliche Messzeitpunkte.*Sicherung:/);
        assert.equal(context.sqlite.prepare('SELECT COUNT(*) n FROM utilization_readings').get().n, 2);
        assert.equal(readdirSync(directory).length, 1);
        assert.equal(context.sqlite.prepare('PRAGMA index_list(utilization_readings)').all().length, 0);
    } finally { context.sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('date APIs reject invalid dates and include only the Berlin DST calendar day', async () => {
    const context = database();
    try {
        insert(context, [
            fixture({ timestamp: '2026-03-28T22:59:00Z' }),
            fixture({ timestamp: '2026-03-28T23:00:00Z', percentage: 20 }),
            fixture({ timestamp: '2026-03-29T21:59:00Z', percentage: 30 }),
            fixture({ timestamp: '2026-03-29T22:00:00Z' }),
        ]);
        const get = loadTs('src/routes/api/today-raw/+server.ts', { '$lib/server/db': context }).GET;
        for (const value of ['2026-02-30', '', '2026-03-29junk']) {
            assert.equal((await get({ url: new URL(`http://localhost/api/today-raw?date=${value}`) })).status, 400);
        }
        const response = await get({ url: new URL('http://localhost/api/today-raw?date=2026-03-29') });
        const payload = await response.json();
        assert.equal(payload.count, 2);
        assert.deepEqual(payload.readings.map(reading => reading.time), ['00:00', '23:59']);
        assert.equal(payload.date, '2026-03-29');
        const available = loadTs('src/routes/api/available-dates/+server.ts', { '$lib/server/db': context }).GET;
        assert.deepEqual((await (await available()).json()).dates, [
            { date: '2026-03-30', count: 1 }, { date: '2026-03-29', count: 2 }, { date: '2026-03-28', count: 1 },
        ]);
    } finally { context.sqlite.close(); }
});

test('hourly latest values do not accidentally report the maximum with an unrelated level', async () => {
    const context = database();
    try {
        insert(context, [fixture({ percentage: 50, level: 'HIGH' }), fixture({ timestamp: '2026-01-13T12:30:00Z', percentage: 10, level: 'LOW' })]);
        const get = loadTs('src/routes/api/today/+server.ts', { '$lib/server/db': context }).GET;
        const payload = await (await get({ url: new URL('http://localhost/api/today?date=2026-01-13') })).json();
        assert.deepEqual(payload.hourlyData[13], { hour: 13, percentage: 10, level: 'LOW', dataPoints: 2 });
        assert.equal(payload.hourlyData[14].percentage, null);
    } finally { context.sqlite.close(); }
});

test('heatmap weights days equally and exposes true sample sizes, ranges, and strict weeks', async () => {
    const context = database();
    try {
        const day1 = time.addStudioDays(time.studioDateString(), -1);
        const day2 = time.addStudioDays(day1, -7);
        const make = (day, minute, percentage) => {
            const instant = new Date(`${day}T10:${String(minute).padStart(2, '0')}:00Z`);
            instant.setUTCHours(instant.getUTCHours() + 12 - time.studioParts(instant).hour);
            return fixture({ timestamp: instant.toISOString(), percentage });
        };
        insert(context, [0, 15, 30, 45].map(minute => make(day1, minute, 0)).concat(make(day2, 0, 40)));
        const get = loadTs('src/routes/api/heatmap/+server.ts', { '$lib/server/db': context }).GET;
        for (const weeks of ['0', '53', '-1', '4weeks', '1.5', '']) {
            assert.equal((await get({ url: new URL(`http://localhost/api/heatmap?weeks=${weeks}`) })).status, 400);
        }
        const payload = await (await get({ url: new URL('http://localhost/api/heatmap?weeks=2') })).json();
        const hour = 12;
        const cell = payload.data[time.studioWeekday(day1)].hours[hour];
        assert.deepEqual(cell, { hour, avgPercentage: 20, maxPercentage: 40, minPercentage: 0, dataPoints: 5, observedDays: 2 });
    } finally { context.sqlite.close(); }
});
