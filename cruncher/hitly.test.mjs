import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalDetails, createHitlyClient, HitlyRequestError } from '../gateway/hitly.mjs';

test('approval requests take generic review details and preserve retry identity', async t => {
  const attempted = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    attempted.push({ url: url.href, headers: options.headers, body: JSON.parse(options.body) });
    return attempted.length === 1
      ? new Response(null, { status: 503 })
      : Response.json({ id: 'approval-1' });
  });

  const details = approvalDetails({
    title: ' Review article draft ',
    context: 'Editorial review',
    payload: { headline: 'Release notes' },
  });
  const hitly = createHitlyClient({
    url: 'http://hotl:3001', temporalAddress: 'temporal:7233', projectId: 'test-project', apiKey: 'test-key',
  });
  const target = { workflowId: 'workflow-1', namespace: 'default', idempotencyKey: 'stable-key' };
  await assert.rejects(hitly.request(target, details),
    error => error instanceof HitlyRequestError && error.status === 503);
  assert.deepEqual(await hitly.request(target, details), { approvalId: 'approval-1' });
  assert.deepEqual(attempted[0], attempted[1]);
  assert.equal(attempted[0].url, 'http://hotl:3001/api/v1/approvals');
  assert.equal(attempted[0].headers['idempotency-key'], 'stable-key');
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
