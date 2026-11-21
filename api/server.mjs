import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import stringify from 'json-stable-stringify';
import { loadCatalog } from './catalog.mjs';

const bearerAuth = [{ bearerAuth: [] }];
const error = {
  type: 'object',
  required: ['message'],
  properties: { message: { type: 'string' } },
};
const started = {
  type: 'object',
  required: ['workflowId', 'runId', 'statusUrl'],
  properties: {
    workflowId: { type: 'string' },
    runId: { type: 'string' },
    statusUrl: { type: 'string' },
  },
};
const execution = {
  type: 'object',
  required: ['workflowId', 'runId', 'workflow', 'status'],
  properties: {
    workflowId: { type: 'string' },
    runId: { type: 'string' },
    workflow: { type: 'string' },
    status: { type: 'string' },
    result: {},
  },
};
const idPattern = '^hoverseer-[a-f0-9]{48}$';

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function authenticate(token) {
  const expected = token ? hash(token) : undefined;
  return async (request, reply) => {
    if (!expected) {
      return reply.code(503).send({ message: 'The workflow API token is not configured' });
    }
    const supplied = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    const actual = hash(supplied ?? '');
    if (!timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
      return reply.header('WWW-Authenticate', 'Bearer').code(401).send({ message: 'A valid bearer token is required' });
    }
  };
}

function startResponse(reply, workflowId, runId) {
  const statusUrl = `/v1/runs/${workflowId}`;
  return reply.header('Location', statusUrl).code(202).send({ workflowId, runId, statusUrl });
}

export async function buildServer({ client, storageDir, catalogFile, token, logger = false }) {
  const catalog = await loadCatalog(catalogFile, storageDir);
  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });
  const auth = authenticate(token);
  const workflows = client.workflow;
  const temporal = operation => client.connection.withDeadline(Date.now() + 5000, operation);
  app.removeContentTypeParser('text/plain');

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Hoverseer workflow API', version: '1.0.0' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    },
    transform({ schema, url, route }) {
      // Publish Zigflow's JSON Schema without compiling a second validator or changing input.
      const body = route.config?.workflowInputSchema;
      return { schema: body === undefined ? schema : { ...schema, body }, url };
    },
  });

  app.get('/openapi.json', {
    schema: {
      operationId: 'getOpenApi',
      summary: 'Discover the Hoverseer HTTP API',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => app.swagger());

  app.get('/v1/workflows', {
    schema: {
      operationId: 'listWorkflows',
      summary: 'List workflows enabled for HTTP calls',
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'title', 'startUrl'],
            properties: {
              name: { type: 'string' },
              title: { type: 'string' },
              summary: { type: 'string' },
              startUrl: { type: 'string' },
            },
          },
        },
      },
    },
  }, async () => catalog.map(({ name, title, summary }) => ({
    name, title, summary, startUrl: `/v1/workflows/${name}/runs`,
  })));

  for (const workflow of catalog) {
    app.post(`/v1/workflows/${workflow.name}/runs`, {
      onRequest: auth,
      config: { workflowInputSchema: workflow.inputSchema },
      schema: {
        operationId: `start-${workflow.name}`,
        summary: `Start ${workflow.title}`,
        description: workflow.summary,
        security: bearerAuth,
        body: {},
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 200 } },
        },
        response: {
          202: { ...started, headers: { Location: { type: 'string', description: 'Status URL for this execution' } } },
          400: error, 401: error, 409: error, 413: error, 415: error, 503: error,
        },
      },
    }, async (request, reply) => {
      if (request.body === undefined) {
        return reply.code(400).send({ message: 'A JSON request body is required' });
      }
      const idempotencyKey = request.headers['idempotency-key'];
      const key = idempotencyKey ?? randomUUID();
      const workflowId = `hoverseer-${hash(JSON.stringify([workflow.name, key])).slice(0, 48)}`;
      const requestHash = hash(stringify(request.body));
      try {
        const run = await temporal(() => workflows.start(workflow.type, {
          args: [request.body],
          taskQueue: workflow.taskQueue,
          workflowId,
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
          memo: { hoverseerWorkflow: workflow.name, hoverseerRequestHash: requestHash },
        }));
        return startResponse(reply, workflowId, run.firstExecutionRunId);
      } catch (cause) {
        if (idempotencyKey && cause instanceof WorkflowExecutionAlreadyStartedError) {
          try {
            const run = await temporal(() => workflows.getHandle(workflowId).describe());
            if (run.memo?.hoverseerWorkflow !== workflow.name || run.memo?.hoverseerRequestHash !== requestHash) {
              return reply.code(409).send({ message: 'The idempotency key was used with different input' });
            }
            return startResponse(reply, workflowId, run.runId);
          } catch (lookupError) {
            request.log.error({ err: lookupError }, 'Could not resolve the existing Temporal run');
          }
        } else {
          request.log.error({ err: cause }, 'Could not start a Temporal run');
        }
        return reply.code(503).send({ message: 'The workflow service is unavailable' });
      }
    });
  }

  app.get('/v1/runs/:workflowId', {
    onRequest: auth,
    schema: {
      operationId: 'getRun',
      summary: 'Read run status and completed output',
      security: bearerAuth,
      params: {
        type: 'object',
        required: ['workflowId'],
        properties: { workflowId: { type: 'string', pattern: idPattern } },
      },
      response: { 200: execution, 400: error, 401: error, 404: error, 503: error },
    },
  }, async (request, reply) => {
    const { workflowId } = request.params;
    try {
      const handle = workflows.getHandle(workflowId);
      const run = await temporal(() => handle.describe());
      const workflow = run.memo?.hoverseerWorkflow;
      if (typeof workflow !== 'string') {
        return reply.code(404).send({ message: 'Run not found' });
      }
      const response = { workflowId, runId: run.runId, workflow, status: run.status.name };
      if (run.status.name === 'COMPLETED') {
        response.result = await temporal(() => workflows.getHandle(workflowId, run.runId).result({ followRuns: false }));
      }
      return response;
    } catch (cause) {
      if (cause instanceof WorkflowNotFoundError) {
        return reply.code(404).send({ message: 'Run not found' });
      }
      request.log.error({ err: cause }, 'Could not read a Temporal run');
      return reply.code(503).send({ message: 'The workflow service is unavailable' });
    }
  });

  return app;
}
