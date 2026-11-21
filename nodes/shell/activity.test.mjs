import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { test } from 'node:test';
import { Context } from '../../cruncher/activity-runtime.mjs';
import { createActivities, taskQueue } from '../index.mjs';
import shell from './node.json' with { type: 'json' };

const { runShell } = createActivities({});

test('passes workflow data literally and cleans up the working directory', async t => {
  assert.equal(shell.taskQueue, taskQueue);
  const controller = new AbortController();
  t.mock.method(Context, 'current', () => ({ cancellationSignal: controller.signal }));
  const message = 'Literal $(printf expanded) and "$HOME"';
  const output = await runShell({
    script: 'printf "%s\\n" "$PWD" "$MESSAGE" "${HITLY_API_KEY-unset}"',
    environment: { MESSAGE: message },
  });
  const [workspace, received, credential] = output.trimEnd().split('\n');
  assert.equal(received, message);
  assert.equal(credential, 'unset');
  await assert.rejects(stat(workspace), { code: 'ENOENT' });
});

test('fails on a nonzero exit or excessive output', async t => {
  t.mock.method(Context, 'current', () => ({ cancellationSignal: new AbortController().signal }));
  await assert.rejects(runShell({ script: 'false\nprintf unreachable' }),
    { type: 'ShellCommandFailed' });
  await assert.rejects(runShell({ script: 'head -c 70000 /dev/zero' }),
    { type: 'ShellOutputLimit' });
});

test('stops commands that exceed their timeout', async t => {
  t.mock.method(Context, 'current', () => ({ cancellationSignal: new AbortController().signal }));
  await assert.rejects(runShell({ script: 'sleep 30', timeoutSeconds: 1 }),
    { type: 'ShellTimeout' });
});
