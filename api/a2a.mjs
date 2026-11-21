import { AsyncLocalStorage } from 'node:async_hooks';
import { AgentCard, TaskState } from '@a2a-js/sdk';
import { PushNotificationNotSupportedError, RequestMalformedError, TaskNotCancelableError, TaskNotFoundError } from '@a2a-js/sdk/errors';
import { restHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import expressPlugin from '@fastify/express';
import { bearerAuth } from './auth.mjs';
import { RunError, workflowIdPattern } from './runs.mjs';

const version = { in: 'header', name: 'A2A-Version', required: true, schema: { type: 'string', const: '1.0' } };
const taskId = { in: 'path', name: 'id', required: true, schema: { type: 'string', pattern: workflowIdPattern } };
const response = (description, schema = { type: 'object' }) => ({
  description, content: { 'application/a2a+json': { schema } },
});
const taskSchema = {
  type: 'object',
  required: ['id', 'contextId', 'status'],
  properties: {
    id: { type: 'string', pattern: workflowIdPattern },
    contextId: { type: 'string' },
    status: {
      type: 'object',
      required: ['state'],
      properties: { state: { type: 'string' } },
    },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['artifactId', 'parts'],
        properties: {
          artifactId: { type: 'string' },
          name: { type: 'string' },
          parts: { type: 'array', items: { type: 'object', properties: { data: {} } } },
        },
      },
    },
  },
};
const errors = {
  400: response('Malformed or unsupported A2A request'),
  401: response('Bearer token required'),
  404: response('Task not found'),
  409: response('Request conflicts with the task state'),
  500: response('Workflow service unavailable'),
  503: response('Workflow API token is not configured'),
};
const taskResponses = { 200: response('A2A task', taskSchema), ...errors };
const messageRequest = {
  type: 'object',
  required: ['message'],
  properties: {
    message: {
      type: 'object',
      required: ['messageId', 'role', 'parts'],
      properties: {
        messageId: { type: 'string' },
        role: { const: 'ROLE_USER' },
        parts: {
          type: 'array', minItems: 1, maxItems: 1,
          items: {
            type: 'object', required: ['data'],
            properties: {
              data: {
                type: 'object', required: ['workflow', 'input'],
                properties: { workflow: { type: 'string' }, input: {} },
              },
            },
          },
        },
      },
    },
    configuration: { type: 'object', properties: { returnImmediately: { type: 'boolean' } } },
  },
};

export const a2aOpenApiPaths = {
  '/a2a/message:send': {
    post: {
      operationId: 'a2aSendMessage', summary: 'Start a managed workflow as an A2A task',
      security: bearerAuth, parameters: [version],
      responses: {
        200: response('Task created or recovered', {
          type: 'object', required: ['task'], properties: { task: taskSchema },
        }),
        ...errors,
      },
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: messageRequest },
          'application/a2a+json': { schema: messageRequest },
        },
      },
    },
  },
  '/a2a/tasks/{id}': {
    get: { operationId: 'a2aGetTask', summary: 'Read an A2A task', security: bearerAuth, parameters: [taskId, version], responses: taskResponses },
  },
  '/a2a/tasks/{id}:cancel': {
    post: { operationId: 'a2aCancelTask', summary: 'Request cancellation of an A2A task', security: bearerAuth, parameters: [taskId, version], responses: taskResponses },
  },
};

function buildCard(catalog, origin) {
  return AgentCard.fromJSON({
    name: 'Hoverseer',
    description: 'Run managed Zigflow workflows with optional human approval.',
    supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    version: '1.0.0',
    documentationUrl: `${origin}/openapi.json`,
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: { bearerAuth: { httpAuthSecurityScheme: { scheme: 'bearer' } } },
    securityRequirements: [{ schemes: { bearerAuth: { list: [] } } }],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: catalog.map(({ name, title, summary }) => ({
      id: name, name: title, description: summary ?? title, tags: ['workflow'],
    })),
  });
}

function task(run, state) {
  return {
    id: run.workflowId,
    contextId: run.workflowId,
    status: { state },
    history: [],
    artifacts: run.result === undefined ? [] : [{
      artifactId: 'workflow-output',
      name: 'Workflow output',
      parts: [{ content: { $case: 'data', value: run.result }, mediaType: 'application/json' }],
      extensions: [],
    }],
  };
}

function taskFromRun(run) {
  const statuses = {
    COMPLETED: TaskState.TASK_STATE_COMPLETED,
    CANCELLED: TaskState.TASK_STATE_CANCELED,
    FAILED: TaskState.TASK_STATE_FAILED,
    TIMED_OUT: TaskState.TASK_STATE_FAILED,
    TERMINATED: TaskState.TASK_STATE_FAILED,
  };
  return task(run, statuses[run.status] ?? TaskState.TASK_STATE_WORKING);
}

async function taskOperation(operation, cancel = false) {
  try {
    return taskFromRun(await operation());
  } catch (cause) {
    if (!(cause instanceof RunError)) throw cause;
    if (cause.status === 404) throw new TaskNotFoundError();
    if (cause.status === 409 && cancel) throw new TaskNotCancelableError();
    if (cause.status === 409) throw new RequestMalformedError(cause.message);
    throw new Error(cause.message);
  }
}

export async function installA2a(app, { catalog, runs, check, origin }) {
  const card = buildCard(catalog, origin);
  const workflows = new Map(catalog.map(workflow => [workflow.name, workflow]));
  const requests = new AsyncLocalStorage();
  const transport = restHandler({
    userBuilder: UserBuilder.noAuthentication,
    requestHandler: {
      getAgentCard: async () => card,
      getTask: ({ id }) => taskOperation(() => runs.get(id)),
      cancelTask: ({ id }) => taskOperation(() => runs.cancel(id), true),
      async sendMessage({ message, configuration }) {
        if (configuration?.taskPushNotificationConfig) throw new PushNotificationNotSupportedError();
        if (message.taskId || message.contextId) {
          throw new RequestMalformedError('Send a new message to start a workflow. Use Get Task for an existing run.');
        }
        const part = message.parts[0]?.content;
        const data = part?.$case === 'data' ? part.value : undefined;
        const workflow = workflows.get(data?.workflow);
        if (message.parts.length !== 1 || !workflow || !Object.hasOwn(data, 'input')) {
          throw new RequestMalformedError('Send one data part with a managed workflow name and input');
        }
        let run;
        try {
          run = await runs.start(workflow, data.input, `a2a:${message.messageId}`);
        } catch (cause) {
          if (cause instanceof RunError && cause.status === 409) throw new RequestMalformedError(cause.message);
          throw cause;
        }
        if (configuration?.returnImmediately) return task(run, TaskState.TASK_STATE_SUBMITTED);
        return taskOperation(() => runs.wait(run.workflowId, requests.getStore()));
      },
    },
  });

  await app.register(async scope => {
    await scope.register(expressPlugin);
    scope.use('/a2a', (req, res, next) => {
      const supported = (req.method === 'POST' && req.path === '/message:send')
        || (req.method === 'GET' && /^\/tasks\/[^/:]+$/.test(req.path))
        || (req.method === 'POST' && /^\/tasks\/[^/:]+:cancel$/.test(req.path));
      if (!supported) return next();
      const failure = check(req.headers.authorization);
      if (failure) {
        if (failure.status === 401) res.set('WWW-Authenticate', 'Bearer');
        const status = failure.status === 401 ? 'UNAUTHENTICATED' : 'UNAVAILABLE';
        res.status(failure.status).type('application/a2a+json')
          .json({ error: { code: failure.status, status, message: failure.message, details: [] } });
        return;
      }
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      return requests.run(controller.signal, () => transport(req, res, next));
    });
    scope.all('/a2a/*', { schema: { hide: true } }, (_request, reply) => reply.callNotFound());
  });

  app.get('/.well-known/agent-card.json', {
    schema: {
      operationId: 'getA2aAgentCard',
      summary: 'Discover the A2A interface and managed workflow skills',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => AgentCard.toJSON(card));
}
