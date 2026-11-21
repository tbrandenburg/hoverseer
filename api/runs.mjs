import { createHash, randomUUID } from 'node:crypto';
import { WorkflowExecutionAlreadyStartedError, WorkflowFailedError, WorkflowNotFoundError } from '@temporalio/client';
import stringify from 'json-stable-stringify';

export const workflowIdPattern = '^hoverseer-[a-f0-9]{48}$';
const workflowIdRegex = new RegExp(workflowIdPattern);

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export class RunError extends Error {
  constructor(status, message, cause) {
    super(message, { cause });
    this.status = status;
  }
}

export function createRuns(client) {
  const workflows = client.workflow;
  const temporal = operation => client.connection.withDeadline(Date.now() + 5000, operation);
  const unavailable = cause => new RunError(503, 'The workflow service is unavailable', cause);
  const notFound = () => new RunError(404, 'Run not found');

  async function describe(workflowId) {
    if (!workflowIdRegex.test(workflowId)) throw notFound();
    try {
      const run = await temporal(() => workflows.getHandle(workflowId).describe());
      if (typeof run.memo?.hoverseerWorkflow === 'string') return run;
    } catch (cause) {
      if (!(cause instanceof WorkflowNotFoundError)) throw unavailable(cause);
    }
    throw notFound();
  }

  async function start(workflow, input, idempotencyKey) {
    const key = idempotencyKey ?? randomUUID();
    const workflowId = `hoverseer-${hash(JSON.stringify([workflow.name, key])).slice(0, 48)}`;
    const requestHash = hash(stringify(input));
    let runId;
    try {
      const run = await temporal(() => workflows.start(workflow.type, {
        args: [input],
        taskQueue: workflow.taskQueue,
        workflowId,
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        memo: { hoverseerWorkflow: workflow.name, hoverseerRequestHash: requestHash },
      }));
      runId = run.firstExecutionRunId;
    } catch (cause) {
      if (!idempotencyKey || !(cause instanceof WorkflowExecutionAlreadyStartedError)) throw unavailable(cause);
      const run = await describe(workflowId);
      if (run.memo.hoverseerWorkflow !== workflow.name || run.memo.hoverseerRequestHash !== requestHash) {
        throw new RunError(409, 'The idempotency key was used with different input');
      }
      runId = run.runId;
    }
    return { workflowId, runId, statusUrl: `/v1/runs/${workflowId}` };
  }

  async function get(workflowId) {
    const run = await describe(workflowId);
    const response = {
      workflowId, runId: run.runId, workflow: run.memo.hoverseerWorkflow, status: run.status.name,
    };
    if (run.status.name === 'COMPLETED') {
      try {
        response.result = await temporal(() => workflows.getHandle(workflowId, run.runId).result({ followRuns: false }));
      } catch (cause) {
        throw unavailable(cause);
      }
    }
    return response;
  }

  async function wait(workflowId, signal) {
    try {
      await client.connection.withAbortSignal(signal, () => workflows.getHandle(workflowId).result());
    } catch (cause) {
      // A failed business execution still has a readable terminal status.
      if (!(cause instanceof WorkflowFailedError)) throw unavailable(cause);
    }
    return get(workflowId);
  }

  async function cancel(workflowId) {
    const run = await describe(workflowId);
    if (run.status.name !== 'RUNNING') throw new RunError(409, 'This run cannot be canceled');
    try {
      await temporal(() => workflows.getHandle(workflowId, run.runId).cancel());
    } catch (cause) {
      if (!(cause instanceof WorkflowNotFoundError)) throw unavailable(cause);
      throw new RunError(409, 'This run can no longer be canceled');
    }
    return get(workflowId);
  }

  return { start, get, wait, cancel };
}
