import { startCronJob } from '$lib/server/cron';

// Offline previews and integration fixtures can use a separate DB without polling.
if (process.env.DISABLE_POLLING !== 'true') startCronJob();

console.log('Gym Tracker server started');
