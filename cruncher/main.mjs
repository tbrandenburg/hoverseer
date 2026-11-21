import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities.mjs';

const connection = await NativeConnection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
});
try {
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: 'hoverseer-activities',
    activities,
  });
  await worker.run();
} finally {
  await connection.close();
}
