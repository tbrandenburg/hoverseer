import { NativeConnection, Worker } from '@temporalio/worker';
import { createActivities, taskQueue } from '../nodes/index.mjs';
import { loadHitlyCredentials } from './infisical.mjs';
import { createHitlyClient } from '../integrations/hitly/client.mjs';

const activities = createActivities(createHitlyClient(await loadHitlyCredentials()));
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
