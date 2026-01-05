import { startCronJob } from '$lib/server/cron';

// Start the cron job when the server starts
startCronJob();

console.log('Gym Tracker server started');
