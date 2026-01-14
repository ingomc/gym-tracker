/**
 * Calculate utilization color based on percentage.
 * Scale: 5% (green/empty) to 50% (red/full)
 * Uses HSL color interpolation for smooth gradient.
 * 
 * @param percentage - Current utilization percentage (0-100)
 * @returns HSL color string
 */
export function getUtilizationColor(percentage: number | null, opacity: number = 1): string {
    if (percentage === null) return `hsla(0, 0%, 30%, ${opacity * 0.3})`;

    // Min/max thresholds for color scale
    const MIN_PERCENT = 5;   // Green
    const MAX_PERCENT = 50;  // Red

    // Clamp percentage to our scale
    const clamped = Math.max(MIN_PERCENT, Math.min(MAX_PERCENT, percentage));

    // Calculate ratio (0 = green, 1 = red)
    const ratio = (clamped - MIN_PERCENT) / (MAX_PERCENT - MIN_PERCENT);

    // HSL interpolation: Green (120°) to Red (0°)
    // We go through yellow (60°) for a nicer gradient
    const hue = 120 - (ratio * 120); // 120 (green) -> 0 (red)
    const saturation = 70 + (ratio * 15); // 70% -> 85%
    const lightness = 45 + (ratio * 5); // 45% -> 50%

    return `hsla(${hue}, ${saturation}%, ${lightness}%, ${opacity})`;
}

/**
 * Get RGBA color for Chart.js compatibility
 */
export function getUtilizationColorRGBA(percentage: number | null, opacity: number = 0.8): string {
    if (percentage === null) return `rgba(128, 128, 128, ${opacity * 0.3})`;

    const MIN_PERCENT = 5;
    const MAX_PERCENT = 50;

    const clamped = Math.max(MIN_PERCENT, Math.min(MAX_PERCENT, percentage));
    const ratio = (clamped - MIN_PERCENT) / (MAX_PERCENT - MIN_PERCENT);

    // RGB interpolation: Green (34, 197, 94) -> Yellow (234, 179, 8) -> Red (239, 68, 68)
    let r: number, g: number, b: number;

    if (ratio <= 0.5) {
        // Green to Yellow
        const t = ratio * 2;
        r = Math.round(34 + (234 - 34) * t);
        g = Math.round(197 + (179 - 197) * t);
        b = Math.round(94 + (8 - 94) * t);
    } else {
        // Yellow to Red
        const t = (ratio - 0.5) * 2;
        r = Math.round(234 + (239 - 234) * t);
        g = Math.round(179 + (68 - 179) * t);
        b = Math.round(8 + (68 - 8) * t);
    }

    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Get appropriate text color based on background
 */
export function getUtilizationTextColor(percentage: number | null): string {
    if (percentage === null) return 'var(--text-secondary)';
    if (percentage > 25) return 'white';
    return 'var(--text-primary)';
}

/**
 * Get CSS variable style for dynamic coloring
 */
export function getUtilizationStyle(percentage: number | null): string {
    return `--utilization-color: ${getUtilizationColor(percentage)}; --utilization-color-rgba: ${getUtilizationColorRGBA(percentage)};`;
}
