import { NativeConnection, Worker } from '@temporalio/worker';
import { createActivities, runShell, shellStep } from './steps/index.mjs';
import { loadHitlyCredentials } from './infisical.mjs';
import { createHitlyClient } from '../integrations/hitly/client.mjs';

const isShellWorker = process.argv[2] === 'shell';
const activities = isShellWorker
  ? { [shellStep.activity]: runShell }
  : createActivities(createHitlyClient(await loadHitlyCredentials()));

const connection = await NativeConnection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
});
try {
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: isShellWorker ? 'hoverseer-shell' : 'hoverseer-activities',
    ...(isShellWorker && { maxConcurrentActivityTaskExecutions: 1 }),
    activities,
  });
  await worker.run();
} finally {
  await connection.close();
}
