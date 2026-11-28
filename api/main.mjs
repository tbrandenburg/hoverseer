import { Client, Connection } from '@temporalio/client';
import { buildServer } from './server.mjs';
import { parseWorkspaceNamespaces, loadWorkspaceExecutions } from './execution.mjs';
import { loadCatalog } from './catalog.mjs';

const connection = Connection.lazy({
  address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
});
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const client = new Client({ connection, namespace });
const port = Number(process.env.PORT ?? 8081);
const storageDir = process.env.ZIGFLOW_STORAGE_DIR ?? '/workflows';
const catalogFile = process.env.HOVERSEER_CATALOG ?? '/config/managed-workflows.yaml';
const mapping = parseWorkspaceNamespaces(process.env.HOVERSEER_WORKSPACE_NAMESPACES, namespace);
const catalog = await loadCatalog(catalogFile, storageDir);
const workspaceExecutions = await loadWorkspaceExecutions(mapping, {
  root: process.env.HOVERSEER_WORKSPACE_ROOT ?? '/workspace-data',
  catalog,
  createClient: namespace => new Client({ connection, namespace }),
});
// The operator preflight reads the same files and checks the same contract as
// startup, without binding a port or changing the running API or workers.
if (process.argv[2] === '--check-catalog') {
  const target = process.argv[3];
  if (target && ![...(mapping?.values() ?? [])].includes(target)) {
    throw Error('Workspace namespace is not configured: ' + target);
  }
  console.log('Managed workflow catalogs are compatible.');
  process.exit(0);
}
const app = await buildServer({
  client,
  storageDir,
  catalogFile,
  workspaceExecutions,
  workspaceStudioUrls: JSON.parse(process.env.HOVERSEER_WORKSPACE_STUDIO_URLS || '{}'),
  token: process.env.HOVERSEER_API_TOKEN,
  sessionUrl: process.env.HITLY_URL ?? 'http://hotl:3001',
  logger: true,
  ui: {
    namespace,
    hitlyUrl: process.env.HOVERSEER_HITLY_URL || undefined,
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
