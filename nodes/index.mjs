import { createRequestApproval } from './request-approval/activity.mjs';
import requestApproval from './request-approval/node.json' with { type: 'json' };

export function createActivities(hitly) {
  return {
    [requestApproval.activity]: createRequestApproval(hitly),
  };
}

export { runShell } from './shell/activity.mjs';
export { default as shellStep } from './shell/node.json' with { type: 'json' };

export { requestApproval };
