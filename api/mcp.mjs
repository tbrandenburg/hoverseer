import { AsyncLocalStorage } from 'node:async_hooks';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { bearerAuth } from './auth.mjs';
import { RunError, workflowIdPattern } from './runs.mjs';

function toolResult(value, isError = false) {
  return {
    structuredContent: value,
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError && { isError: true }),
  };
}

async function runTool(operation) {
  try {
    return toolResult(await operation());
  } catch (cause) {
    if (!(cause instanceof RunError)) throw cause;
    return toolResult({ message: cause.message, status: cause.status }, true);
  }
}

export function installMcp(app, { catalog, runs, auth, hostname }) {
  const principals = new AsyncLocalStorage();
  const handler = createMcpHandler(({ requestInfo }) => {
    const principal = principals.getStore();
    const key = requestInfo?.headers.get('idempotency-key') ?? undefined;
    const server = new McpServer({ name: 'hoverseer', version: '1.0.0' });
    for (const workflow of catalog) {
      const name = workflow.name.replaceAll('-', '_');
      const schema = workflow.inputSchema ?? {};
      // MCP requires an object schema for tool arguments. Keep non-object
      // workflow inputs intact inside a single input argument.
      const wrapped = schema.type !== 'object';
      const input = wrapped ? {
        type: 'object', properties: { input: schema }, required: ['input'],
      } : schema;
      server.registerTool(`start_${name}`, {
        description: `Start ${workflow.title}.${workflow.summary ? ` ${workflow.summary}` : ''} Returns a run ID for get_run.`,
        inputSchema: fromJsonSchema(input),
      }, args => runTool(() => runs.start(workflow, wrapped ? args.input : args, key, principal)));
    }
    server.registerTool('get_run', {
      description: 'Read the status and completed output of a Hoverseer run.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: { workflowId: { type: 'string', pattern: workflowIdPattern } },
        required: ['workflowId'],
      }),
      annotations: { readOnlyHint: true },
    }, ({ workflowId }) => runTool(() => runs.get(workflowId, principal)));
    return server;
  });
  const handle = toNodeHandler(handler);
  const hosts = [...new Set(['localhost', '127.0.0.1', '[::1]', hostname])];
  const onRequest = [hostHeaderValidation(hosts), originValidation(hosts), auth];
  for (const method of ['POST', 'GET', 'DELETE']) {
    app.route({
      method,
      url: '/mcp',
      onRequest,
      schema: {
        operationId: `mcp-${method.toLowerCase()}`,
        summary: 'MCP Streamable HTTP transport',
        description: 'Use the MCP protocol for tool discovery and invocation. No session stream is retained.',
        security: bearerAuth,
        ...(method === 'POST' && {
          body: {},
          headers: {
            type: 'object',
            properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 200 } },
          },
        }),
        response: {
          200: { description: 'MCP response over JSON or SSE' },
          202: { description: 'Notification accepted' },
          400: { description: 'Invalid MCP request' },
          401: { description: 'Bearer token required' },
          403: { description: 'Host or Origin rejected' },
          405: { description: 'Method unavailable in stateless mode' },
        },
      },
      handler(request, reply) {
        return principals.run(request.principal, () => handle(request.raw, reply.raw, request.body));
      },
    });
  }
  app.addHook('onClose', () => handler.close());
}
