import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentCard, Role, TaskState } from '@a2a-js/sdk';
import { ClientFactory, RestTransportFactory } from '@a2a-js/sdk/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { buildServer } from './server.mjs';

const auth = { authorization: 'Bearer test-token' };
const input = { orderId: 'refund-1', amountCents: 5000 };

test('MCP and A2A clients use the same managed runs and discovery catalog', async t => {
  const runs = new Map();
  const client = {
    connection: {
      withDeadline: (_deadline, operation) => operation(),
      withAbortSignal: (_signal, operation) => operation(),
    },
    workflow: {
      async start(type, options) {
        if (runs.has(options.workflowId)) {
          throw new WorkflowExecutionAlreadyStartedError('Already started', options.workflowId, type);
        }
        const run = { type, ...options, runId: randomUUID(), status: { name: 'RUNNING' } };
        runs.set(options.workflowId, run);
        return { firstExecutionRunId: run.runId };
      },
      getHandle(id) {
        const run = runs.get(id);
        return {
          describe: async () => run,
          async result() {
            run.status.name = 'COMPLETED';
            return { status: 'auto_approved' };
          },
          async cancel() {
            run.status.name = 'CANCELLED';
          },
        };
      },
    },
  };

  const app = await buildServer({
    client,
    storageDir: fileURLToPath(new URL('../workflows', import.meta.url)),
    catalogFile: fileURLToPath(new URL('../workflows/catalog.yaml', import.meta.url)),
    token: 'test-token',
    publicOrigin: 'https://workflows.example.com',
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());

  const mcp = new Client({ name: 'hoverseer-test', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
    requestInit: { headers: { ...auth, 'Idempotency-Key': 'mcp-retry-key' } },
  }));
  t.after(() => mcp.close());

  const tools = (await mcp.listTools()).tools;
  const refundTool = tools.find(tool => tool.name === 'start_refund_review');
  assert.deepEqual(refundTool?.inputSchema.required, ['orderId', 'amountCents']);
  assert.ok(tools.some(tool => tool.name === 'start_article_review'));
  const started = await mcp.callTool({ name: 'start_refund_review', arguments: input });
  assert.equal(started.isError, undefined);
  const retry = await mcp.callTool({ name: 'start_refund_review', arguments: input });
  assert.deepEqual(retry.structuredContent, started.structuredContent);
  assert.equal(runs.size, 1);

  const workflowId = started.structuredContent.workflowId;
  const polled = await mcp.callTool({ name: 'get_run', arguments: { workflowId } });
  assert.equal(polled.structuredContent.status, 'RUNNING');
  assert.equal(runs.get(workflowId).taskQueue, 'refund-review');
  assert.deepEqual(runs.get(workflowId).args, [input]);

  const badOrigin = await fetch(`${origin}/mcp`, { headers: { ...auth, origin: 'https://untrusted.example' } });
  assert.equal(badOrigin.status, 403);
  assert.equal((await fetch(`${origin}/mcp`)).status, 401);

  const card = await (await fetch(`${origin}/.well-known/agent-card.json`)).json();
  assert.equal(card.supportedInterfaces[0].url, 'https://workflows.example.com/a2a');
  assert.deepEqual(card.skills.map(skill => skill.id), ['article-review', 'refund-review']);
  assert.equal((await fetch(`${origin}/a2a/tasks/${workflowId}`)).status, 401);

  const transport = new RestTransportFactory({
    fetchImpl(url, init) {
      // Keep the public-origin test independent from this listener's ephemeral port.
      const target = new URL(url);
      const headers = new Headers(init?.headers);
      headers.set('Authorization', auth.authorization);
      return fetch(new URL(target.pathname + target.search, origin), { ...init, headers });
    },
  });
  const a2a = await new ClientFactory({ transports: [transport] }).createFromAgentCard(AgentCard.fromJSON(card));
  assert.equal((await a2a.getTask({ id: workflowId })).status.state, TaskState.TASK_STATE_WORKING);
  const msg = {
    messageId: randomUUID(),
    role: Role.ROLE_USER,
    parts: [{ content: { $case: 'data', value: { workflow: 'refund-review', input } } }],
  };
  const result = await a2a.sendMessage({ message: msg, configuration: { returnImmediately: true } });
  assert.equal(result.status.state, TaskState.TASK_STATE_SUBMITTED);
  const resubmitted = await a2a.sendMessage({ message: msg, configuration: { returnImmediately: true } });
  assert.equal(resubmitted.id, result.id);
  assert.equal((await a2a.cancelTask({ id: result.id })).status.state, TaskState.TASK_STATE_CANCELED);

  const blocking = await a2a.sendMessage({ message: { ...msg, messageId: randomUUID() } });
  assert.equal(blocking.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.deepEqual(blocking.artifacts[0].parts[0].content.value, { status: 'auto_approved' });
});
