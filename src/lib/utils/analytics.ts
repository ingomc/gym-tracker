/**
 * Umami Analytics Tracking Helper
 * https://umami.is/docs/tracker-functions
 */

declare global {
    interface Window {
        umami?: {
            track: (event: string, data?: Record<string, string | number>) => void;
        };
    }
}

/**
 * Track a custom event in Umami
 * @param event - Event name (e.g., 'date-change', 'login')
 * @param data - Optional data object
 */
export function trackEvent(event: string, data?: Record<string, string | number>) {
    if (typeof window !== 'undefined' && window.umami) {
        window.umami.track(event, data);
    }
}

// Pre-defined tracking functions for common actions
export const analytics = {
    /** Track when user changes the date in the chart */
    dateChange: (date: string, isToday: boolean) => {
        trackEvent('date-change', { date, type: isToday ? 'today' : 'archive' });
    },

    /** Track when user selects weeks in heatmap */
    heatmapWeeksChange: (weeks: number) => {
        trackEvent('heatmap-weeks', { weeks });
    },

    /** Track login/logout */
    login: () => trackEvent('admin-login'),
    logout: () => trackEvent('admin-logout'),

    /** Track data export/import */
    exportData: () => trackEvent('data-export'),
    importData: (count: number) => trackEvent('data-import', { count }),

    /** Track weather popover open */
    weatherView: () => trackEvent('weather-view'),
};
