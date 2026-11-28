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

  async function describe(workflowId, principal) {
    if (!workflowIdRegex.test(workflowId)) throw notFound();
    try {
      const run = await temporal(() => workflows.getHandle(workflowId).describe());
      if (typeof run.memo?.hoverseerWorkflow === 'string'
          && (principal.kind === 'service' || run.memo.hoverseerUserId === principal.id)) return run;
    } catch (cause) {
      if (!(cause instanceof WorkflowNotFoundError)) throw unavailable(cause);
    }
    throw notFound();
  }

  async function start(workflow, input, idempotencyKey, principal) {
    const key = idempotencyKey ?? randomUUID();
    // Preserve legacy service IDs. Users have independent retry identities.
    const scope = principal.kind === 'user' ? ['user', principal.id, workflow.name, key] : [workflow.name, key];
    const workflowId = `hoverseer-${hash(JSON.stringify(scope)).slice(0, 48)}`;
    const requestHash = hash(stringify(input));
    let runId;
    try {
      const run = await temporal(() => workflows.start(workflow.type, {
        args: [input],
        taskQueue: workflow.taskQueue,
        workflowId,
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        memo: {
          hoverseerWorkflow: workflow.name, hoverseerRequestHash: requestHash,
          ...(principal.kind === 'user' && { hoverseerUserId: principal.id }),
        },
      }));
      runId = run.firstExecutionRunId;
    } catch (cause) {
      if (!idempotencyKey || !(cause instanceof WorkflowExecutionAlreadyStartedError)) throw unavailable(cause);
      const run = await describe(workflowId, principal);
      if (run.memo.hoverseerWorkflow !== workflow.name || run.memo.hoverseerRequestHash !== requestHash) {
        throw new RunError(409, 'The idempotency key was used with different input');
      }
      runId = run.runId;
    }
    return { workflowId, runId, statusUrl: `/v1/runs/${workflowId}` };
  }

  async function get(workflowId, principal) {
    const run = await describe(workflowId, principal);
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

  async function wait(workflowId, signal, principal) {
    await describe(workflowId, principal);
    try {
      await client.connection.withAbortSignal(signal, () => workflows.getHandle(workflowId).result());
    } catch (cause) {
      // A failed business execution still has a readable terminal status.
      if (!(cause instanceof WorkflowFailedError)) throw unavailable(cause);
    }
    return get(workflowId, principal);
  }

  async function cancel(workflowId, principal) {
    const run = await describe(workflowId, principal);
    if (run.status.name !== 'RUNNING') throw new RunError(409, 'This run cannot be canceled');
    try {
      await temporal(() => workflows.getHandle(workflowId, run.runId).cancel());
    } catch (cause) {
      if (!(cause instanceof WorkflowNotFoundError)) throw unavailable(cause);
      throw new RunError(409, 'This run can no longer be canceled');
    }
    return get(workflowId, principal);
  }

  return { start, get, wait, cancel };
}
