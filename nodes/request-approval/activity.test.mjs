import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '../../cruncher/activity-runtime.mjs';
import { createHitlyClient, HitlyRequestError } from '../../integrations/hitly/client.mjs';
import { createActivities } from '../index.mjs';

test('approval requests take generic review details and preserve retry identity', async t => {
  const attempted = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    attempted.push({ url: url.href, headers: options.headers, body: JSON.parse(options.body) });
    return attempted.length === 1
      ? new Response(null, { status: 503 })
      : Response.json({ id: 'approval-1' });
  });

  const input = {
    title: ' Review article draft ',
    context: 'Editorial review',
    payload: { headline: 'Release notes' },
  };
  const hitly = createHitlyClient({
    url: 'http://hotl:3001', temporalAddress: 'temporal:7233', projectId: 'test-project', apiKey: 'test-key',
  });
  const info = {
    workflowExecution: { workflowId: 'workflow-1', runId: 'run-1' },
    workflowNamespace: 'default',
    activityId: 'activity-1',
    attempt: 1,
  };
  t.mock.method(Context, 'current', () => ({ info }));
  const { requestApproval } = createActivities(hitly);

  await assert.rejects(requestApproval(input),
    error => error instanceof HitlyRequestError && error.status === 503);
  info.attempt = 2;
  assert.deepEqual(await requestApproval(input), { approvalId: 'approval-1' });
  assert.deepEqual(attempted[0], attempted[1]);
  assert.equal(attempted[0].url, 'http://hotl:3001/api/v1/approvals');
  assert.match(attempted[0].headers['idempotency-key'], /^[0-9a-f]{64}$/);
  assert.deepEqual(attempted[0].body, {
    plugin: 'temporal',
    projectId: 'test-project',
    workflowId: 'workflow-1',
    address: 'temporal:7233',
    namespace: 'default',
    actionName: 'Review article draft',
    contextMarkdown: 'Editorial review',
    args: { headline: 'Release notes' },
  });
});

test('invalid step input fails without attempting an approval', async () => {
  const { requestApproval } = createActivities({
    request: () => assert.fail('Invalid input reached HITLy'),
  });
  await assert.rejects(requestApproval({ title: ' ' }), {
    type: 'InvalidApprovalRequest',
    nonRetryable: true,
  });
});
