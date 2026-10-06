import cron, { type ScheduledTask } from 'node-cron';
import { fetchAndStoreUtilization } from './fetcher';
import { getPollIntervalMinutes } from './utilization-status';

let cronJob: ScheduledTask | null = null;

export function startCronJob(): void {
    if (cronJob) {
        console.log('Cron job already running');
        return;
    }

    const intervalMinutes = getPollIntervalMinutes();

    // Create cron expression: run every X minutes
    const cronExpression = intervalMinutes === 1
        ? '* * * * *'  // Every minute
        : `*/${intervalMinutes} * * * *`;  // Every X minutes

    console.log(`Starting cron job with expression: ${cronExpression}`);

    cronJob = cron.schedule(cronExpression, async () => {
        await fetchAndStoreUtilization();
    }, { timezone: 'Europe/Berlin', noOverlap: true });

    // Run immediately on startup
    console.log('Running initial fetch...');
    fetchAndStoreUtilization();
}

export function stopCronJob(): void {
    if (cronJob) {
        cronJob.stop();
        cronJob = null;
        console.log('Cron job stopped');
    }
}
