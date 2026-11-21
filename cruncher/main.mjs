import { NativeConnection, Worker } from '@temporalio/worker';
import { createActivities, requestApproval, runShell, shellStep } from '../nodes/index.mjs';
import { loadHitlyCredentials } from './infisical.mjs';
import { createHitlyClient } from '../integrations/hitly/client.mjs';

const hitly = createHitlyClient(await loadHitlyCredentials());
const connection = await NativeConnection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
});
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const stop = Promise.withResolvers();

// Saved workflows address activities by queue, so poll both queues in this process.
const runs = [
  {
    taskQueue: requestApproval.taskQueue,
    activities: createActivities(hitly),
  },
  {
    taskQueue: shellStep.taskQueue,
    activities: { [shellStep.activity]: runShell },
    maxConcurrentActivityTaskExecutions: 1,
  },
].map(async options => {
  const worker = await Worker.create({ connection, namespace, ...options });
  stop.promise.then(() => {
    if (worker.getState() === 'RUNNING') worker.shutdown();
  });
  await worker.run();
});

try {
  await Promise.all(runs);
} finally {
  stop.resolve();
  await Promise.allSettled(runs);
  await connection.close();
}
