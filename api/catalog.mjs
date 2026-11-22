import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

const aliasPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const projectPattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?$/;

export async function loadCatalog(catalogFile, storageDir) {
  const entries = parse(await readFile(catalogFile, 'utf8'));
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('The managed workflow catalog must map public names to Studio projects');
  }

  return Promise.all(Object.entries(entries).map(async ([name, project]) => {
    if (!aliasPattern.test(name) || typeof project !== 'string' || !projectPattern.test(project)) {
      throw new Error(`Invalid managed workflow entry: ${name}`);
    }
    const path = join(storageDir, project, 'workflow.yaml');
    const source = await readFile(path, 'utf8');
    const workflow = parse(source);
    const document = workflow?.document;
    if (typeof document?.workflowType !== 'string' || !document.workflowType.trim()
        || typeof document.taskQueue !== 'string' || !document.taskQueue.trim()) {
      throw new Error(`Missing workflowType or taskQueue in ${path}`);
    }

    const input = workflow.input?.schema;
    return {
      name,
      project,
      revision: createHash('sha256').update(source).digest('hex'),
      version: typeof document.version === 'string' ? document.version : undefined,
      type: document.workflowType,
      taskQueue: document.taskQueue,
      title: typeof document.title === 'string' ? document.title : name,
      summary: typeof document.summary === 'string' ? document.summary : undefined,
      inputSchema: input?.format === 'json' ? input.document : undefined,
    };
  }));
}
