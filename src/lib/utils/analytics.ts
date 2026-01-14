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
    dateChange: (date: string) => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const selected = new Date(date);
        selected.setHours(0, 0, 0, 0);

        const diffTime = selected.getTime() - today.getTime();
        const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

        let relative = 'Other';
        if (diffDays === 0) relative = 'Today';
        else if (diffDays === 1) relative = 'Tomorrow';
        else if (diffDays === -1) relative = 'Yesterday';
        else if (diffDays > 0) relative = `In ${diffDays} days`;
        else relative = `${Math.abs(diffDays)} days ago`;

        trackEvent('date-change', {
            relative_date: relative,
            days_diff: diffDays
        });
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
