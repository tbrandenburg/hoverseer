import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { buildServer } from './server.mjs';

const storageDir = fileURLToPath(new URL('../workflows', import.meta.url));
const defaultCatalog = fileURLToPath(new URL('../workflows/catalog.yaml', import.meta.url));
const auth = { authorization: 'Bearer test-token' };
const refundRoute = '/v1/workflows/refund-review/runs';

async function installApi(t, { catalogFile = defaultCatalog, token = 'test-token' } = {}) {
  const runs = new Map();
  const client = {
    connection: { withDeadline: (_deadline, operation) => operation() },
    workflow: {
      async start(type, options) {
        if (runs.has(options.workflowId)) {
          throw new WorkflowExecutionAlreadyStartedError('Already started', options.workflowId, type);
        }
        const run = { type, ...options, runId: 'run-1', status: { name: 'COMPLETED' } };
        runs.set(options.workflowId, run);
        return { firstExecutionRunId: run.runId };
      },
      getHandle(id) {
        return {
          describe: async () => runs.get(id),
          result: async () => ({ status: 'auto_approved' }),
        };
      },
    },
  };
  const app = await buildServer({ client, catalogFile, token, storageDir });
  t.after(() => app.close());
  return { app, runs };
}

test('OpenAPI discovers each enabled workflow and its Zigflow input schema', async t => {
  const { app } = await installApi(t);
  const response = await app.inject('/openapi.json');
  assert.equal(response.statusCode, 200);
  const spec = response.json();
  assert.deepEqual(Object.keys(spec.paths).sort(), [
    '/.well-known/agent-card.json', '/a2a/message:send', '/a2a/tasks/{id}', '/a2a/tasks/{id}:cancel',
    '/mcp', '/openapi.json', '/v1/runs/{workflowId}', '/v1/workflows',
    '/v1/workflows/article-review/runs', refundRoute,
  ]);
  const refund = spec.paths[refundRoute].post;
  assert.deepEqual(refund.requestBody.content['application/json'].schema.required, ['orderId', 'amountCents']);
  assert.deepEqual(refund.security, [{ bearerAuth: [] }]);
  assert.equal(refund.responses['202'].headers.Location.schema.type, 'string');
});

test('only explicitly managed projects are callable or advertised', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hoverseer-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogFile = join(directory, 'managed-workflows.yaml');
  await writeFile(catalogFile, 'editorial: article-review\n');
  const { app } = await installApi(t, { catalogFile });
  const list = (await app.inject('/v1/workflows')).json();
  assert.deepEqual(list.map(entry => entry.name), ['editorial']);
  assert.equal((await app.inject({ method: 'POST', url: refundRoute, headers: auth, payload: {} })).statusCode, 404);
});

test('starts require auth and retries reuse the execution with matching input', async t => {
  const { app, runs } = await installApi(t);
  const call = (payload, headers) => app.inject({ method: 'POST', url: refundRoute, headers, payload });
  const input = { orderId: 'r1', amountCents: 5000 };
  assert.equal((await call(input, {})).statusCode, 401);
  const headers = { ...auth, 'idempotency-key': 'test-key' };
  assert.equal((await call('{broken', { ...headers, 'content-type': 'application/json' })).statusCode, 400);
  const response = await call(input, headers);
  assert.equal(response.statusCode, 202);
  const run = response.json();
  assert.equal(response.headers.location, run.statusUrl);
  assert.deepEqual((await call({ amountCents: 5000, orderId: 'r1' }, headers)).json(), run);
  assert.equal((await call({ ...input, amountCents: 15000 }, headers)).statusCode, 409);
  assert.equal(runs.size, 1);
  const scheduled = runs.get(run.workflowId);
  assert.equal(scheduled.type, 'refundReview');
  assert.equal(scheduled.taskQueue, 'refund-review');
  assert.deepEqual(scheduled.args, [input]);
  assert.equal((await app.inject(run.statusUrl)).statusCode, 401);
  const status = (await app.inject({ url: run.statusUrl, headers: auth })).json();
  assert.equal(status.status, 'COMPLETED');
  assert.deepEqual(status.result, { status: 'auto_approved' });
});
