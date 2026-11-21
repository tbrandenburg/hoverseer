import { createRequestApproval } from './request-approval/activity.mjs';
import requestApproval from './request-approval/node.json' with { type: 'json' };
import { runShell } from './shell/activity.mjs';
import shell from './shell/node.json' with { type: 'json' };

export const taskQueue = requestApproval.taskQueue;

export function createActivities(hitly) {
  return {
    [requestApproval.activity]: createRequestApproval(hitly),
    [shell.activity]: runShell,
  };
}
