import { createRequestApproval } from './request-approval/activity.mjs';
import requestApproval from './request-approval/step.json' with { type: 'json' };

export function createActivities(hitly) {
  return {
    [requestApproval.activity]: createRequestApproval(hitly),
  };
}
