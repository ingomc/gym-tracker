import { Tooltip, type ChartType, type TooltipPositionerFunction } from 'chart.js';

declare module 'chart.js' {
    interface TooltipPositionerMap {
        aboveBelowPoint: TooltipPositionerFunction<ChartType>;
    }
}

/** Anchor to the nearest visible reading/forecast, with the box strictly above or below. */
export const aboveBelowPoint: TooltipPositionerFunction<ChartType> = function (items, eventPosition) {
    const values = items.filter((item) => {
        const dataset = this.chart.data.datasets[item.datasetIndex];
        const value = dataset.data[item.index];
        return (dataset.label === 'Messwert' || dataset.label === 'Prognose')
            && typeof value === 'number' && Number.isFinite(value);
    });
    const point = Tooltip.positioners.nearest.call(this, values, eventPosition);
    if (!point || typeof point.y !== 'number') return false;
    return { ...point, xAlign: 'center', yAlign: point.y >= this.chart.height / 2 ? 'bottom' : 'top' };
};

Tooltip.positioners.aboveBelowPoint = aboveBelowPoint;
