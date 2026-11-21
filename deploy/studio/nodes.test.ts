import { validateWorkflow } from '#lib/schema/validate.js';
import type { ZigflowWorkflow } from '#lib/types/zigflow.js';
import { parseWorkflowYaml, stringifyWorkflowYaml } from '#lib/yaml/serialize.js';
import { describe, expect, it } from 'vitest';

import {
  activityInput,
  makeActivityTask,
  nodeForTask,
  parseField,
  workerNodes,
} from './nodes';

describe('shared worker nodes', () => {
  const shell = workerNodes.find((node) => node.id === 'shell')!;

  it('generates a valid YAML task for each manifest', () => {
    expect(workerNodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(['request-approval', 'shell']),
    );
    const workflow: ZigflowWorkflow = {
      document: {
        dsl: '1.0.0',
        taskQueue: 'sharedNodes',
        workflowType: 'sharedNodes',
        version: '0.1.0',
      },
      do: [
        {
          sharedNodes: {
            do: workerNodes.map((node) => ({
              [node.id]: makeActivityTask(node),
            })),
          },
        },
      ],
    };
    const reopened = parseWorkflowYaml(stringifyWorkflowYaml(workflow));
    expect(reopened).toEqual(workflow);
    expect(validateWorkflow(reopened).valid).toBe(true);
  });

  it('preserves multiline scripts, JSON objects, and workflow expressions', () => {
    const fields = shell.inputSchema.properties;
    const script = "printf '%s\\n' first\nprintf '%s\\n' second";
    expect(parseField(fields.script, script)).toEqual(script);
    expect(
      parseField(fields.environment, '{"MESSAGE":"${ $input.message }"}'),
    ).toEqual({ MESSAGE: '${ $input.message }' });
    expect(parseField(fields.timeoutSeconds, '${ $input.timeout }')).toEqual(
      '${ $input.timeout }',
    );
    expect(parseField(fields.timeoutSeconds, '10')).toEqual(10);
    expect(() => parseField(fields.environment, '[]')).toThrow();
    expect(() => parseField(fields.timeoutSeconds, '301')).toThrow();
  });

  it('matches the activity and queue and defers unfamiliar argument shapes', () => {
    const task = makeActivityTask(shell);
    expect(activityInput(task)).toMatchObject({
      shell: 'sh',
      timeoutSeconds: 60,
    });
    expect(nodeForTask(task)).toBe(shell);
    expect(task.metadata?.activityOptions).toEqual({
      startToCloseTimeout: { seconds: 305 },
      retryPolicy: { maximumAttempts: 1 },
    });
    expect(
      nodeForTask({
        ...task,
        with: { ...task.with, taskQueue: 'other-queue' },
      }),
    ).toBeUndefined();
    expect(
      nodeForTask({
        ...task,
        with: { ...task.with, arguments: ['${ $input }'] },
      }),
    ).toBeUndefined();
  });
});
