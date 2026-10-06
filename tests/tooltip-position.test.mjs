import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import * as chartJs from 'chart.js';

const { outputText } = ts.transpileModule(readFileSync(new URL('../src/lib/utils/tooltip-position.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const exports = {};
new Function('exports', 'require', outputText)(exports, (name) => {
    assert.equal(name, 'chart.js');
    return chartJs;
});
const { aboveBelowPoint } = exports;
const context = { chart: { height: 222, data: { datasets: [{ label: 'Obere Grenze', data: [80] }, { label: 'Untere Grenze', data: [150] }, { label: 'Prognose', data: [100] }, { label: 'Messwert', data: [130] }] } } };
function point(datasetIndex, y) {
    return { datasetIndex, index: 0, element: { hasValue: () => true, getCenterPoint: () => ({ x: 120, y }), tooltipPosition: () => ({ x: 120, y }) } };
}

test('high measurement puts the tooltip below with its tip anchored to the value', () => {
    assert.deepEqual(aboveBelowPoint.call(context, [point(3, 60)], { x: 130, y: 65 }), { x: 120, y: 60, xAlign: 'center', yAlign: 'top' });
});

test('low forecast puts the tooltip above instead of beside the point', () => {
    assert.deepEqual(aboveBelowPoint.call(context, [point(2, 180)], { x: 130, y: 170 }), { x: 120, y: 180, xAlign: 'center', yAlign: 'bottom' });
});

test('the nearest actual or forecast value anchors the tip, never an invisible band boundary', () => {
    const items = [point(0, 80), point(1, 150), point(2, 100), point(3, 130)];
    assert.equal(aboveBelowPoint.call(context, items, { x: 120, y: 80 }).y, 100);
    assert.equal(aboveBelowPoint.call(context, items, { x: 120, y: 150 }).y, 130);
});

test('missing forecasts and measurements do not create a tooltip on the band alone', () => {
    assert.equal(aboveBelowPoint.call(context, [point(0, 80), point(1, 150)], { x: 120, y: 100 }), false);
});

test('a missing measurement bar cannot pull the forecast tip down to the zero baseline', () => {
    const missing = { chart: { ...context.chart, data: { datasets: context.chart.data.datasets.map((dataset) => dataset.label === 'Messwert' ? { ...dataset, data: [null] } : dataset) } } };
    const result = aboveBelowPoint.call(missing, [point(2, 100), point(3, 200)], { x: 120, y: 200 });
    assert.equal(result.y, 100);
    assert.equal(result.yAlign, 'top');
});
