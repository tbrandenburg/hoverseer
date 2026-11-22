import { Client, Connection } from '@temporalio/client';
import { buildServer } from './server.mjs';

const connection = Connection.lazy({
  address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
});
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const client = new Client({ connection, namespace });
const port = Number(process.env.PORT ?? 8081);
const app = await buildServer({
  client,
  storageDir: process.env.ZIGFLOW_STORAGE_DIR ?? '/workflows',
  catalogFile: process.env.HOVERSEER_CATALOG ?? '/config/managed-workflows.yaml',
  token: process.env.HOVERSEER_API_TOKEN,
  logger: true,
  ui: {
    namespace,
    studioUrl: process.env.HOVERSEER_STUDIO_URL || undefined,
    temporalUrl: process.env.HOVERSEER_TEMPORAL_WEB_URL || undefined,
  },
  publicOrigin: process.env.HOVERSEER_PUBLIC_URL || `http://localhost:${port}`,
});
app.addHook('onClose', () => connection.close());
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => app.close().catch(error => app.log.error(error)));
}
await app.listen({ host: process.env.HOST ?? '0.0.0.0', port });
