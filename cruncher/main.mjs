import { NativeConnection, Worker } from '@temporalio/worker';
import { createActivities, taskQueue } from '../nodes/index.mjs';
import { loadHitlyCredentials } from './infisical.mjs';
import { createHitlyClient } from '../integrations/hitly/client.mjs';

// Validate configured Vault access before polling; fetch fresh credentials inside
// the approval activity so rotation does not require restarting the worker.
const initial = await loadHitlyCredentials();
const hitly = initial.projectId ? {
  async request(...args) {
    return createHitlyClient(await loadHitlyCredentials()).request(...args);
  },
} : createHitlyClient();
const activities = createActivities(hitly);
const connection = await NativeConnection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
});
try {
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue,
    activities,
  });
  await worker.run();
} finally {
  await connection.close();
}
