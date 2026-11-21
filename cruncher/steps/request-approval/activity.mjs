import { createHash } from 'node:crypto';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { approvalDetails, HitlyRequestError } from '../../../integrations/hitly/client.mjs';

export function createRequestApproval(hitly) {
  return async function requestApproval(input) {
    const details = approvalDetails(input);
    if (!details) {
      throw ApplicationFailure.nonRetryable('Invalid approval request', 'InvalidApprovalRequest');
    }

    const context = Context.current();
    const { activityId, workflowExecution, workflowNamespace } = context.info;
    if (!workflowExecution || !workflowNamespace) {
      throw ApplicationFailure.nonRetryable('Approval must be requested from a workflow execution', 'InvalidApprovalOrigin');
    }
    // Temporal keeps the activity ID stable across retries. A subsequent
    // approval in the same execution gets a different activity ID.
    const idempotencyKey = createHash('sha256').update(JSON.stringify([
      workflowNamespace, workflowExecution.workflowId, workflowExecution.runId, activityId,
    ])).digest('hex');

    try {
      return await hitly.request({
        workflowId: workflowExecution.workflowId,
        namespace: workflowNamespace,
        idempotencyKey,
      }, details, context.cancellationSignal);
    } catch (error) {
      if (error instanceof HitlyRequestError && error.status >= 400 && error.status < 500
          && error.status !== 408 && error.status !== 429) {
        throw ApplicationFailure.nonRetryable(error.message, 'HitlyRejectedApprovalRequest');
      }
      throw error;
    }
  };
}
