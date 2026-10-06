/** Familiar occupancy scale: green (5), yellow (27.5), red (50 and above).
 * These are visual reference points, not a claim about the studio's capacity.
 */
export function getUtilizationColorRGBA(percentage: number | null, opacity = 0.9): string {
    if (percentage === null) return `rgba(128, 128, 128, ${opacity * 0.3})`;
    const ratio = (Math.max(5, Math.min(50, percentage)) - 5) / 45;
    const stops = [[34, 197, 94], [234, 179, 8], [239, 68, 68]];
    const segment = ratio <= 0.5 ? 0 : 1;
    const t = ratio <= 0.5 ? ratio * 2 : (ratio - 0.5) * 2;
    const rgb = stops[segment].map((value, index) => Math.round(value + (stops[segment + 1][index] - value) * t));
    return `rgba(${rgb.join(', ')}, ${opacity})`;
}
export function getUtilizationColor(percentage: number | null, opacity = 1): string {
    if (percentage === null) return `hsla(0, 0%, 30%, ${opacity * 0.3})`;
    const ratio = (Math.max(5, Math.min(50, percentage)) - 5) / 45;
    return `hsla(${120 - ratio * 120}, ${70 + ratio * 15}%, ${45 + ratio * 5}%, ${opacity})`;
}
export function getUtilizationTextColor(percentage: number | null): string {
    return percentage === null ? 'var(--text-secondary)' : '#101218';
}
export function getUtilizationStyle(percentage: number | null): string {
    return `--utilization-color: ${getUtilizationColor(percentage)}; --utilization-color-rgba: ${getUtilizationColorRGBA(percentage)};`;
}
