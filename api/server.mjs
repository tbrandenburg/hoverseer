import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { loadCatalog } from './catalog.mjs';
import { accessCheck, bearerAuth, fastifyAuth } from './auth.mjs';
import { withWorkspace, workspaceHeader } from './workspace.mjs';
import { RunError, workflowIdPattern } from './runs.mjs';
import { routeRuns } from './execution.mjs';
import { installWorkflowsUi } from './workflows-ui.mjs';
import { installMcp } from './mcp.mjs';
import { a2aOpenApiPaths, installA2a } from './a2a.mjs';

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
function sendRunError(request, reply, cause) {
  if (!(cause instanceof RunError)) throw cause;
  if (cause.status === 503) request.log.error({ err: cause }, 'Temporal request failed');
  return reply.code(cause.status).send({ message: cause.message });
}

export async function buildServer({
  client, storageDir, catalogFile, token, sessionUrl, workspaceExecutions = null, workspaceStudioUrls = {}, logger = false, publicOrigin = 'http://localhost:8081', ui,
}) {
  const catalog = await loadCatalog(catalogFile, storageDir);
  const origin = new URL(publicOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.href !== `${origin.origin}/`) {
    throw new Error('HOVERSEER_PUBLIC_URL must be an HTTP(S) origin without a path');
  }
  const studioUrls = new Map();
  for (const [namespace, value] of Object.entries(workspaceStudioUrls)) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href !== url.origin + '/') {
      throw Error('Workspace Studio URLs must be HTTP(S) origins');
    }
    studioUrls.set(namespace, url.origin);
  }
  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });
  app.decorateRequest('principal', null);
  const identity = accessCheck(token, { sessionUrl, origin: origin.origin, hitlyOrigin: ui?.hitlyUrl });
  const membership = withWorkspace(identity, { sessionUrl, hitlyOrigin: ui?.hitlyUrl });
  const runs = routeRuns(client, workspaceExecutions, ui?.namespace);
  const check = async (headers, options) => {
    const result = await membership(headers, options);
    if (!result.failure && runs.namespace(result.principal) === null) {
      return { failure: { status: 403, message: 'Workspace execution is not configured' } };
    }
    return result;
  };
  const auth = fastifyAuth(check, { allowCookie: true });
  const bearerOnly = fastifyAuth(check);
  app.removeContentTypeParser('text/plain');

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Hoverseer workflow API', version: '1.0.0' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    },
    transformObject({ openapiObject }) {
      Object.assign(openapiObject.paths, a2aOpenApiPaths);
      return openapiObject;
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

  app.get('/v1/me', { onRequest: fastifyAuth(membership, { allowCookie: true }), schema: { hide: true } }, async request => ({
    ...request.principal,
    executionNamespace: runs.namespace(request.principal),
    workspaceExecution: workspaceExecutions !== null,
    studioUrl: request.principal.kind === 'user' && workspaceExecutions !== null
      ? studioUrls.get(runs.namespace(request.principal)) ?? null : null,
  }));

  // A Studio instance asks about its own fixed namespace. Resolve its
  // workspace ID from the same configuration as execution routing; a client
  // header or an unrelated active-workspace cookie cannot change that target.
  app.get('/v1/studio-access/:namespace', { schema: { hide: true } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const entry = [...(workspaceExecutions ?? [])].find(([, value]) => value.namespace === request.params.namespace);
    if (!entry) return reply.code(403).send({ message: 'Studio workspace is not configured' });
    const [workspaceId] = entry;
    const result = await membership({ cookie: request.headers.cookie, [workspaceHeader]: workspaceId }, { allowCookie: true });
    if (result.failure) return reply.code(result.failure.status).send({ message: result.failure.message });
    if (result.principal.kind !== 'user' || result.principal.workspace.id !== workspaceId) {
      return reply.code(403).send({ message: 'Studio access denied' });
    }
    return reply.code(204).send();
  });

  // Preserve the public contract while displaying actual workspace metadata
  // (including project name, title and revision) in the authenticated UI.
  const catalogEntries = entries => entries.map(({ name, title, summary, project, revision, version }) => ({
    name, title, summary, project, revision, version, startUrl: '/v1/workflows/' + name + '/runs',
  }));
  app.get('/v1/workspace/workflows', { onRequest: auth, schema: { hide: true } }, async request => {
    const entry = request.principal.kind === 'user' ? workspaceExecutions?.get(request.principal.workspace.id) : undefined;
    return catalogEntries(entry?.catalog ?? catalog);
  });

  app.get('/v1/workflows', {
    schema: {
      operationId: 'listWorkflows',
      summary: 'List workflows enabled for HTTP calls',
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'title', 'startUrl', 'project', 'revision'],
            properties: {
              name: { type: 'string' },
              title: { type: 'string' },
              summary: { type: 'string' },
              startUrl: { type: 'string' },
              project: { type: 'string' },
              revision: { type: 'string' },
              version: { type: 'string' },
            },
          },
        },
      },
    },
  }, async () => catalogEntries(catalog));

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
          400: error, 401: error, 403: error, 409: error, 413: error, 415: error, 503: error,
        },
      },
    }, async (request, reply) => {
      if (request.body === undefined) {
        return reply.code(400).send({ message: 'A JSON request body is required' });
      }
      try {
        const result = await runs.start(workflow, request.body, request.headers['idempotency-key'], request.principal);
        return reply.header('Location', result.statusUrl).code(202).send(result);
      } catch (cause) {
        return sendRunError(request, reply, cause);
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
        properties: { workflowId: { type: 'string', pattern: workflowIdPattern } },
      },
      response: { 200: execution, 400: error, 401: error, 403: error, 404: error, 503: error },
    },
  }, async (request, reply) => {
    try {
      return await runs.get(request.params.workflowId, request.principal);
    } catch (cause) {
      return sendRunError(request, reply, cause);
    }
  });

  installWorkflowsUi(app, ui);
  installMcp(app, { catalog, runs, auth: bearerOnly, hostname: origin.hostname });
  await installA2a(app, { catalog, runs, check, origin: origin.origin });

  return app;
}
