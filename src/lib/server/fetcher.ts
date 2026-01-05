import { db, schema } from './db';

const API_URL = process.env.API_URL || 'https://www.ai-fitness.de/connect/v1/studio/1412625590/utilization';

interface UtilizationItem {
    startTime: string;
    endTime: string;
    percentage: number;
    level: string;
    isCurrent: boolean;
}

interface UtilizationResponse {
    startTime: string;
    endTime: string;
    items: UtilizationItem[];
}

export async function fetchAndStoreUtilization(): Promise<{ success: boolean; percentage?: number; error?: string }> {
    try {
        const response = await fetch(API_URL);
        if (!response.ok) {
            throw new Error(`API responded with status ${response.status}`);
        }

        const data: UtilizationResponse = await response.json();

        // Find the current slot
        const currentSlot = data.items.find(item => item.isCurrent);
        if (!currentSlot) {
            return { success: false, error: 'No current slot found in API response' };
        }

        const now = new Date();
        const weekday = now.getDay(); // 0=Sunday, 1=Monday, ...
        const hour = now.getHours();

        // Insert into database
        await db.insert(schema.utilizationReadings).values({
            timestamp: now,
            weekday,
            hour,
            percentage: currentSlot.percentage,
            level: currentSlot.level,
        });

        console.log(`[${now.toISOString()}] Stored utilization: ${currentSlot.percentage}% (${currentSlot.level})`);

        return { success: true, percentage: currentSlot.percentage };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${new Date().toISOString()}] Failed to fetch utilization: ${message}`);
        return { success: false, error: message };
    }
}
