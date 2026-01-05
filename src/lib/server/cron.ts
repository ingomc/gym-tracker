import cron from 'node-cron';
import { fetchAndStoreUtilization } from './fetcher';

let cronJob: cron.ScheduledTask | null = null;

export function startCronJob(): void {
    if (cronJob) {
        console.log('Cron job already running');
        return;
    }

    const intervalMinutes = parseInt(process.env.POLL_INTERVAL_MINUTES || '1', 10);

    // Create cron expression: run every X minutes
    const cronExpression = intervalMinutes === 1
        ? '* * * * *'  // Every minute
        : `*/${intervalMinutes} * * * *`;  // Every X minutes

    console.log(`Starting cron job with expression: ${cronExpression}`);

    cronJob = cron.schedule(cronExpression, async () => {
        await fetchAndStoreUtilization();
    });

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
