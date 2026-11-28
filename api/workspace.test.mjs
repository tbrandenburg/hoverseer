import assert from 'node:assert/strict';
import test from 'node:test';
import { withWorkspace } from './workspace.mjs';

const user = { kind: 'user', id: 'alice', name: 'Alice' };
const service = { kind: 'service', id: 'legacy-service' };

test('only the exact workspace returned by HITLy authorizes an explicit request', async () => {
  const calls = [];
  let member = true;
  const check = withWorkspace(async () => ({ principal: user }), {
    sessionUrl: 'http://hotl:3001',
    async fetchImpl(url, options) {
      calls.push({ url, options });
      const requested = options.headers['x-hitly-workspace-id'];
      return Response.json(requested === 'team' && member
        ? { id: 'team', name: 'Team', role: 'member' }
        : { id: 'alice', name: 'Personal', role: 'owner' });
    },
  });
  const headers = { authorization: 'Bearer session' };
  assert.equal((await check(headers)).principal.workspace.id, 'alice');
  assert.equal((await check({ ...headers, 'x-hitly-workspace-id': 'bob' })).failure.status, 403);
  assert.equal((await check({ ...headers, 'x-hitly-workspace-id': 'team' })).principal.workspace.id, 'team');
  member = false;
  assert.equal((await check({ ...headers, 'x-hitly-workspace-id': 'team' })).failure.status, 403);
  const browser = { cookie: 'other=ignore; hitly-workspace-id=alice; better-auth.session_token=session' };
  assert.equal((await check(browser)).principal.workspace.id, 'alice');
  assert.equal(calls.at(-1).options.headers.cookie, 'better-auth.session_token=session');
  assert.equal(calls.at(-1).options.headers['x-hitly-workspace-id'], 'alice');
  assert.equal((await check({ ...headers, 'x-hitly-workspace-id': 'bad,id' })).failure.status, 403);
});

test('workspace lookup fails closed and does not invent service membership', async () => {
  const check = withWorkspace(async () => ({ principal: user }), {
    sessionUrl: 'http://hotl:3001', fetchImpl: async () => { throw Error('offline'); },
  });
  assert.equal((await check({ authorization: 'Bearer session' })).failure.status, 503);
  const legacy = withWorkspace(async () => ({ principal: service }));
  assert.deepEqual((await legacy({ authorization: 'Bearer service' })).principal, service);
  assert.equal((await legacy({ authorization: 'Bearer service', 'x-hitly-workspace-id': 'team' })).failure.status, 403);
  const denied = withWorkspace(async () => ({ failure: { status: 401 } }));
  assert.equal((await denied({})).failure.status, 401);
});
