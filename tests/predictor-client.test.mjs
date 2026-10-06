import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

function compile(path, dependencies = {}, globals = {}) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    const exports = {};
    new Function('require', 'exports', ...Object.keys(globals), outputText)(name => {
        assert.ok(name in dependencies, `Unexpected import: ${name}`);
        return dependencies[name];
    }, exports, ...Object.values(globals));
    return exports;
}

const time = compile('../src/lib/utils/studio-time.ts');
function client(response) {
    const requests = [];
    const module = compile('../src/lib/server/predictor.ts', { '../utils/studio-time': time }, {
        fetch: async (url, options) => { requests.push({ url, options }); return response(); },
        process: { env: { PREDICTOR_URL: 'http://predictor.test' } },
        console: { error() {} },
    });
    return { ...module, requests };
}

test('first training returns 503 and does not require a preceding health request', async () => {
    const api = client(() => Response.json({ status: 'training', error: 'Das Modell wird trainiert.' }, { status: 503 }));
    const result = await api.predict('2026-10-07');
    assert.equal(result.httpStatus, 503);
    assert.equal(result.data.status, 'training');
    assert.deepEqual(result.data.predictions, []);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].url, 'http://predictor.test/predict?date=2026-10-07');
});

test('validated zero predictions and their provenance reach the dashboard unchanged', async () => {
    const data = {
        date: '2026-10-07', status: 'ready', issuedAt: '2026-10-07T04:00:00Z', trainedThrough: '2026-10-06T19:45:00Z', modelVersion: 'test-1',
        predictions: [{ hour: 6, minute: 15, percentage: 0, lower: 0, upper: 5, targetAt: '2026-10-07T04:15:00Z', status: 'open' }],
    };
    const api = client(() => Response.json(data));
    assert.deepEqual(await api.predict(data.date), { httpStatus: 200, data });
});

test('wrong dates and malformed forecast points never masquerade as a valid empty forecast', async () => {
    for (const body of [
        { date: '2026-10-06', status: 'ready', predictions: [] },
        { date: '2026-10-07', status: 'ready', predictions: [{ hour: 99, minute: 0, percentage: 999 }] },
    ]) {
        const result = await client(() => Response.json(body)).predict('2026-10-07');
        assert.equal(result.httpStatus, 502);
        assert.equal(result.data.status, 'unavailable');
    }
});

test('timeouts are visible as unavailable rather than successful empty predictions', async () => {
    const api = client(() => { throw new DOMException('Timed out', 'TimeoutError'); });
    const result = await api.predict('2026-10-10');
    assert.equal(result.httpStatus, 503);
    assert.equal(result.data.weekday, 6);
    assert.equal(result.data.openingHours.startTime, '07:00:00');
});
