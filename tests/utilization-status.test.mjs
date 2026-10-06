import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import ts from 'typescript';

// Run with a different host timezone to catch accidental use of local Date hours.
const originalTimezone = process.env.TZ;
process.env.TZ = 'UTC';
after(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
});

const source = readFileSync(new URL('../src/lib/server/utilization-status.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { getUtilizationStatus, getPollIntervalMinutes } = await import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

function status({ now, lastUpdated = null, source = null, pollIntervalMinutes = 15 }) {
    return getUtilizationStatus({
        now: new Date(now),
        lastUpdated: lastUpdated === null ? null : new Date(lastUpdated),
        source: source === null ? null : {
            ...source,
            checkedAt: new Date(source.checkedAt),
            ...(source.openingHoursCheckedAt === undefined ? {} : {
                openingHoursCheckedAt: new Date(source.openingHoursCheckedAt),
            }),
        },
        pollIntervalMinutes,
    });
}

test('the observed 17% reading from the previous night is closed at 00:52 in Berlin', () => {
    assert.equal(status({
        now: '2026-10-07T00:52:00+02:00',
        lastUpdated: '2026-10-06T22:00:00+02:00',
        source: { checkedAt: '2026-10-07T00:50:00+02:00', status: 'missing' },
    }), 'closed');
});

test('22:00 closes the studio even when the source still flags a current slot', () => {
    const lastUpdated = '2026-10-06T21:59:00+02:00';
    const source = { checkedAt: lastUpdated, status: 'current' };
    assert.equal(status({ now: '2026-10-06T21:59:59+02:00', lastUpdated, source }), 'live');
    assert.equal(status({ now: '2026-10-06T22:00:00+02:00', lastUpdated, source }), 'closed');
});

test('weekday reopening at 06:00 does not revive yesterday’s measurement', () => {
    const lastUpdated = '2026-10-06T22:00:00+02:00';
    assert.equal(status({ now: '2026-10-07T05:59:59+02:00', lastUpdated }), 'closed');
    assert.equal(status({ now: '2026-10-07T06:00:00+02:00', lastUpdated }), 'stale');
});

test('both weekend days reopen at 07:00', () => {
    for (const day of ['2026-10-10', '2026-10-11']) {
        assert.equal(status({ now: `${day}T06:59:59+02:00` }), 'closed');
        assert.equal(status({ now: `${day}T07:00:00+02:00` }), 'unavailable');
    }
});

test('a missing current slot means unavailable while open, and closed after closing', () => {
    assert.equal(status({
        now: '2026-10-07T12:00:00+02:00',
        lastUpdated: '2026-10-07T11:59:00+02:00',
        source: { checkedAt: '2026-10-07T12:00:00+02:00', status: 'missing' },
    }), 'unavailable');
    assert.equal(status({
        now: '2026-10-07T22:01:00+02:00',
        lastUpdated: '2026-10-07T21:59:00+02:00',
        source: { checkedAt: '2026-10-07T22:01:00+02:00', status: 'missing' },
    }), 'closed');
});

test('a failed fetch marks even a recent saved measurement stale', () => {
    assert.equal(status({
        now: '2026-10-07T12:00:00+02:00',
        lastUpdated: '2026-10-07T11:59:00+02:00',
        source: { checkedAt: '2026-10-07T12:00:00+02:00', status: 'error' },
    }), 'stale');
});

test('a fresh actual measurement, including zero occupancy, remains live while open', () => {
    // Status depends on measurement freshness, not the occupancy percentage.
    assert.equal(status({
        now: '2026-10-07T12:00:00+02:00',
        lastUpdated: '2026-10-07T12:00:00+02:00',
        source: { checkedAt: '2026-10-07T12:00:00+02:00', status: 'current' },
    }), 'live');
});

test('a 15-minute poll allows two minutes of delay before a reading becomes stale', () => {
    const lastUpdated = '2026-10-07T12:00:00+02:00';
    assert.equal(status({ now: '2026-10-07T12:17:00+02:00', lastUpdated }), 'live');
    assert.equal(status({ now: '2026-10-07T12:17:01+02:00', lastUpdated }), 'stale');
    assert.equal(status({
        now: '2026-10-07T12:03:01+02:00', lastUpdated, pollIntervalMinutes: 1,
    }), 'stale');
});

test('a future measurement timestamp cannot appear live', () => {
    assert.equal(status({
        now: '2026-10-07T12:00:00+02:00',
        lastUpdated: '2026-10-07T12:01:00+02:00',
        source: { checkedAt: '2026-10-07T12:00:00+02:00', status: 'current' },
    }), 'stale');
});

test('Berlin opening and closing times follow winter and summer offsets on a UTC host', () => {
    for (const { beforeOpening, opening, closing } of [
        {
            beforeOpening: '2026-01-13T04:59:59Z',
            opening: '2026-01-13T05:00:00Z',
            closing: '2026-01-13T21:00:00Z',
        },
        {
            beforeOpening: '2026-07-14T03:59:59Z',
            opening: '2026-07-14T04:00:00Z',
            closing: '2026-07-14T20:00:00Z',
        },
    ]) {
        assert.equal(status({ now: beforeOpening }), 'closed');
        assert.equal(status({ now: opening, lastUpdated: opening }), 'live');
        assert.equal(status({ now: closing, lastUpdated: closing }), 'closed');
    }
});

test('today’s source opening hours override the usual schedule', () => {
    const openingHours = { startTime: '08:00:00', endTime: '20:00:00' };
    assert.equal(status({
        now: '2026-10-07T07:00:00+02:00',
        lastUpdated: '2026-10-07T07:00:00+02:00',
        source: { checkedAt: '2026-10-07T06:50:00+02:00', status: 'current', openingHours },
    }), 'closed');
    assert.equal(status({
        now: '2026-10-07T19:59:00+02:00',
        lastUpdated: '2026-10-07T19:59:00+02:00',
        source: { checkedAt: '2026-10-07T19:59:00+02:00', status: 'current', openingHours },
    }), 'live');
    assert.equal(status({
        now: '2026-10-07T20:00:00+02:00',
        lastUpdated: '2026-10-07T20:00:00+02:00',
        source: { checkedAt: '2026-10-07T20:00:00+02:00', status: 'current', openingHours },
    }), 'closed');
});

test('Friday’s source hours cannot override Saturday’s later opening', () => {
    assert.equal(status({
        now: '2026-10-10T06:30:00+02:00',
        lastUpdated: '2026-10-10T06:30:00+02:00',
        source: {
            checkedAt: '2026-10-09T23:00:00+02:00',
            status: 'current',
            openingHours: { startTime: '06:00:00', endTime: '22:00:00' },
        },
    }), 'closed');
});

test('malformed source hours fall back to the verified schedule after closing', () => {
    for (const openingHours of [
        { startTime: 'invalid', endTime: '22:00:00' },
        { startTime: '06:00:00', endTime: 'invalid' },
        { startTime: '06:00:00' },
        { startTime: '06:00:00', endTime: '24:01:00' },
    ]) {
        assert.equal(status({
            now: '2026-10-07T23:50:00+02:00',
            lastUpdated: '2026-10-07T23:49:00+02:00',
            source: { checkedAt: '2026-10-07T23:50:00+02:00', status: 'current', openingHours },
        }), 'closed');
    }
});

test('a fetch error retains today’s verified early weekend opening and marks data stale', () => {
    assert.equal(status({
        now: '2026-10-10T06:30:00+02:00',
        lastUpdated: '2026-10-10T06:25:00+02:00',
        source: {
            checkedAt: '2026-10-10T06:30:00+02:00',
            status: 'error',
            openingHours: { startTime: '06:00:00', endTime: '22:00:00' },
            openingHoursCheckedAt: '2026-10-10T06:25:00+02:00',
        },
    }), 'stale');
});

test('a fetch error today cannot extend yesterday’s retained hours into Saturday', () => {
    assert.equal(status({
        now: '2026-10-10T06:30:00+02:00',
        lastUpdated: '2026-10-10T06:25:00+02:00',
        source: {
            checkedAt: '2026-10-10T06:30:00+02:00',
            status: 'error',
            openingHours: { startTime: '06:00:00', endTime: '22:00:00' },
            openingHoursCheckedAt: '2026-10-09T21:45:00+02:00',
        },
    }), 'closed');
});

test('a verified midnight closing time of 24:00 keeps the studio open until midnight', () => {
    assert.equal(status({
        now: '2026-10-07T23:50:00+02:00',
        lastUpdated: '2026-10-07T23:49:00+02:00',
        source: {
            checkedAt: '2026-10-07T23:50:00+02:00',
            status: 'current',
            openingHours: { startTime: '06:00:00', endTime: '24:00:00' },
        },
    }), 'live');
});

test('an open studio without any saved measurement is unavailable', () => {
    assert.equal(status({
        now: '2026-10-07T12:00:00+02:00',
        source: { checkedAt: '2026-10-07T12:00:00+02:00', status: 'current' },
    }), 'unavailable');
});

test('poll interval parsing accepts scheduler-supported whole minutes and defaults safely', () => {
    assert.equal(getPollIntervalMinutes('15'), 15);
    assert.equal(getPollIntervalMinutes('59'), 59);
    for (const value of ['0', '-1', '60', '1.5', 'invalid', '']) {
        assert.equal(getPollIntervalMinutes(value), 1);
    }
});
