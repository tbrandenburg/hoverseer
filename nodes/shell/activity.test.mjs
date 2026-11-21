import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '../../cruncher/activity-runtime.mjs';
import { createActivities, taskQueue } from '../index.mjs';
import shell from './node.json' with { type: 'json' };

const { runShell } = createActivities({});

async function useWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'hoverseer-workspace-test-'));
  const previous = process.env.HOVERSEER_WORKSPACES_DIR;
  process.env.HOVERSEER_WORKSPACES_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.HOVERSEER_WORKSPACES_DIR;
    else process.env.HOVERSEER_WORKSPACES_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });

  const workflowExecution = { workflowId: 'example', runId: 'first-run' };
  t.mock.method(Context, 'current', () => ({
    cancellationSignal: new AbortController().signal,
    info: { workflowNamespace: 'default', workflowExecution },
  }));
  return workflowExecution;
}

test('passes workflow data literally and shares files with later steps in the run', async t => {
  assert.equal(shell.taskQueue, taskQueue);
  const workflowExecution = await useWorkspace(t);
  const message = 'Literal $(printf expanded) and "$HOME"';
  const output = await runShell({
    script: 'printf "%s" "$MESSAGE" > checkout.txt; printf "%s\\n" "$PWD" "$MESSAGE" "${HITLY_API_KEY-unset}"',
    environment: { MESSAGE: message },
  });
  const [workspace, received, credential] = output.trimEnd().split('\n');
  assert.equal(received, message);
  assert.equal(credential, 'unset');
  const later = await runShell({ script: 'printf "%s\\n" "$PWD"; cat checkout.txt' });
  assert.equal(later, `${workspace}\n${message}`);

  workflowExecution.runId = 'second-run';
  const other = await runShell({ script: 'test ! -e checkout.txt; printf "%s" "$PWD"' });
  assert.notEqual(other, workspace);
});

test('fails on a nonzero exit or excessive output', async t => {
  await useWorkspace(t);
  await assert.rejects(runShell({ script: 'false\nprintf unreachable' }),
    { type: 'ShellCommandFailed' });
  await assert.rejects(runShell({ script: 'head -c 70000 /dev/zero' }),
    { type: 'ShellOutputLimit' });
});

test('stops commands that exceed their timeout', async t => {
  await useWorkspace(t);
  await assert.rejects(runShell({ script: 'sleep 30', timeoutSeconds: 1 }),
    { type: 'ShellTimeout' });
});
