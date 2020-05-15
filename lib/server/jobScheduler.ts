import { DataProviders } from './dataProvider/dataProviders';
import { CronJob } from 'cron';

export let EquivalentClosureJob: CronJob = null;;

export async function initializeJobs(dataProviders: DataProviders) {

  // Run every 12 hours
  EquivalentClosureJob = new CronJob('0 */12 * * *', async () => {
    await dataProviders.idiom.computeEquivalentClosure();
  });
}

export function stopJobs() {
  if (EquivalentClosureJob) {
    EquivalentClosureJob.stop();
  }
}
