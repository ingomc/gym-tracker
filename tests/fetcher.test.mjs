import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const statusSource = readFileSync(new URL('../src/lib/server/utilization-status.ts', import.meta.url), 'utf8');
const { outputText: statusCode } = ts.transpileModule(statusSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const statusHelpers = await import(`data:text/javascript;base64,${Buffer.from(statusCode).toString('base64')}`);
const { outputText: timeCode } = ts.transpileModule(readFileSync(new URL('../src/lib/utils/studio-time.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const timeHelpers = await import(`data:text/javascript;base64,${Buffer.from(timeCode).toString('base64')}`);
const fetcherSource = readFileSync(new URL('../src/lib/server/fetcher.ts', import.meta.url), 'utf8');
const { outputText: fetcherCode } = ts.transpileModule(fetcherSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});

function loadFetcher(now, utilization, options = {}) {
    const rows = [];
    let sourceFails = false;
    let currentTime = now;
    const requests = [];
    const apiUrl = 'https://fixture.invalid/utilization';
    const exports = {};
    class FixedDate extends Date {
        constructor(value = currentTime) { super(value); }
        static now() { return new Date(currentTime).getTime(); }
    }
    const dependencies = {
        './db': { db: { insert: () => ({ values: async row => { rows.push(row); } }) }, schema: { utilizationReadings: {} } },
        './utilization-status': statusHelpers,
        '../utils/studio-time': timeHelpers,
    };
    const fixtureFetch = async (url, init) => {
        requests.push({ url, signal: init?.signal });
        if (url === apiUrl && sourceFails) throw new Error('Source unavailable');
        if (url !== apiUrl && options.weatherFails) throw new Error('Weather timeout');
        if (url !== apiUrl && options.weatherGate) await options.weatherGate;
        const data = url === apiUrl ? utilization : {
            current: { temperature_2m: 10, precipitation: 0, cloud_cover: 0, rain: 0 },
        };
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    };
    // Execute the real fetcher with an isolated clock, source and database sink.
    new Function('require', 'exports', 'fetch', 'Date', 'process', 'console', fetcherCode)(
        name => {
            assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
            return dependencies[name];
        },
        exports, fixtureFetch, FixedDate,
        { env: { API_URL: apiUrl, POLL_INTERVAL_MINUTES: '15' } },
        { log() {}, warn() {}, error() {} },
    );
    return { ...exports, rows, requests, failSource() { sourceFails = true; }, setTime(value) { currentTime = value; } };
}

function source(percentage, isCurrent) {
    return {
        startTime: '06:00:00', endTime: '22:00:00',
        items: [{ startTime: '21:00:00', endTime: '22:00:00', percentage, level: 'LOW', isCurrent }],
    };
}

test('closed polls do not insert a synthetic zero or a lingering current-slot value into history', async () => {
    for (const isCurrent of [false, true]) {
        const fetcher = loadFetcher('2026-10-06T22:00:00+02:00', source(17, isCurrent));
        assert.deepEqual(await fetcher.fetchAndStoreUtilization(), { success: true });
        assert.deepEqual(fetcher.rows, []);
    }
});

test('a real zero from the open studio is still recorded as a measurement', async () => {
    const fetcher = loadFetcher('2026-10-07T12:00:00+02:00', source(0, true));
    assert.deepEqual(await fetcher.fetchAndStoreUtilization(), { success: true, percentage: 0 });
    assert.equal(fetcher.rows.length, 1);
    assert.equal(fetcher.rows[0].percentage, 0);
    assert.equal(fetcher.getUtilizationSourceSnapshot().status, 'current');
});

test('a missing slot during opening hours is unavailable and does not create a measurement', async () => {
    const now = new Date('2026-10-07T12:00:00+02:00');
    const fetcher = loadFetcher(now.toISOString(), source(0, false));
    assert.equal((await fetcher.fetchAndStoreUtilization()).success, false);
    assert.deepEqual(fetcher.rows, []);
    assert.equal(statusHelpers.getUtilizationStatus({
        now, lastUpdated: now, source: fetcher.getUtilizationSourceSnapshot(), pollIntervalMinutes: 15,
    }), 'unavailable');
});

test('a source outage keeps previously confirmed early weekend hours and labels the saved reading stale', async () => {
    const now = new Date('2026-10-10T06:30:00+02:00');
    const fetcher = loadFetcher(now.toISOString(), source(17, true));
    assert.equal((await fetcher.fetchAndStoreUtilization()).success, true);
    fetcher.failSource();
    assert.equal((await fetcher.fetchAndStoreUtilization()).success, false);
    assert.equal(fetcher.rows.length, 1);
    assert.equal(statusHelpers.getUtilizationStatus({
        now, lastUpdated: now, source: fetcher.getUtilizationSourceSnapshot(), pollIntervalMinutes: 15,
    }), 'stale');
});

test('overlapping startup and scheduled polls share one observation', async () => {
    const fetcher = loadFetcher('2026-10-07T12:00:00+02:00', source(17, true));
    const first = fetcher.fetchAndStoreUtilization();
    const second = fetcher.fetchAndStoreUtilization();
    assert.equal(first, second);
    await Promise.all([first, second]);
    assert.equal(fetcher.rows.length, 1);
    assert.equal(fetcher.requests.filter(request => request.url.includes('fixture.invalid')).length, 1);
    assert.ok(fetcher.requests.every(request => request.signal instanceof AbortSignal));
});

test('optional weather failure does not drop a source measurement', async () => {
    const fetcher = loadFetcher('2026-10-07T12:00:00+02:00', source(17, true), { weatherFails: true });
    assert.equal((await fetcher.fetchAndStoreUtilization()).success, true);
    assert.equal(fetcher.rows[0].percentage, 17);
    assert.equal(fetcher.rows[0].temperature, null);
});

test('delayed weather cannot move a measurement into a later hour', async () => {
    let release;
    const weatherGate = new Promise(resolve => { release = resolve; });
    const observed = '2026-10-07T12:59:59+02:00';
    const fetcher = loadFetcher(observed, source(17, true), { weatherGate });
    const pending = fetcher.fetchAndStoreUtilization();
    await new Promise(resolve => setImmediate(resolve));
    fetcher.setTime('2026-10-07T13:00:01+02:00');
    release();
    await pending;
    assert.equal(fetcher.rows[0].timestamp.toISOString(), new Date(observed).toISOString());
    assert.equal(fetcher.rows[0].hour, 12);
});
