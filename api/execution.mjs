import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadCatalog } from './catalog.mjs';
import { createRuns, RunError } from './runs.mjs';

// A static one-to-one mapping, not a provisioning system. An unset map keeps
// the existing single-environment deployment; an empty map enables strict mode.
export function parseWorkspaceNamespaces(source, defaultNamespace = 'default') {
  if (source === undefined || source === '') return null;
  const data = JSON.parse(source);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Workspace namespaces must be a JSON object');
  const used = new Set([defaultNamespace]);
  const mapping = new Map();
  for (const [id, namespace] of Object.entries(data)) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || typeof namespace !== 'string'
        || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace) || used.has(namespace)) {
      throw Error('Invalid or duplicate workspace namespace');
    }
    used.add(namespace);
    mapping.set(id, namespace);
  }
  return mapping;
}

export async function loadWorkspaceExecutions(mapping, { root, catalog, createClient }) {
  if (mapping === null) return null;
  const entries = new Map();
  for (const [id, namespace] of mapping) {
    const directory = join(root, namespace);
    const workflows = await loadCatalog(join(directory, 'catalog.yaml'), directory);
    // Keep the existing public API contract shared for this milestone. The
    // implementation and worker queues may differ; private discovery is later.
    if (workflows.length !== catalog.length || catalog.some(publicWorkflow => {
      const actual = workflows.find(item => item.name === publicWorkflow.name);
      return !actual || !isDeepStrictEqual(actual.inputSchema, publicWorkflow.inputSchema);
    })) throw Error('Workspace catalog must match the shared public workflow names and input schemas: ' + namespace);
    entries.set(id, { namespace, runs: createRuns(createClient(namespace)), catalog: workflows });
  }
  return entries;
}

export function routeRuns(client, executions, defaultNamespace = 'default') {
  const legacy = { namespace: defaultNamespace, runs: createRuns(client) };
  function resolve(principal) {
    if (principal.kind === 'service' || executions === null) return legacy;
    const entry = executions.get(principal.workspace.id);
    if (!entry) throw new RunError(403, 'Workspace execution is not configured');
    return entry;
  }
  return {
    namespace(principal) {
      if (principal.kind === 'service' || executions === null) return defaultNamespace;
      return executions.get(principal.workspace.id)?.namespace ?? null;
    },
    async start(workflow, input, key, principal) {
      const entry = resolve(principal);
      const actual = entry.catalog?.find(item => item.name === workflow.name) ?? workflow;
      return entry.runs.start(actual, input, key, principal);
    },
    get: (id, principal) => resolve(principal).runs.get(id, principal),
    wait: (id, signal, principal) => resolve(principal).runs.wait(id, signal, principal),
    cancel: (id, principal) => resolve(principal).runs.cancel(id, principal),
  };
}
