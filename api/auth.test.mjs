import assert from 'node:assert/strict';
import test from 'node:test';
import { accessCheck } from './auth.mjs';

test('legacy service credential and verified HITLy sessions remain distinct', async () => {
  const calls = [];
  const check = accessCheck('service-secret', {
    sessionUrl: 'http://hotl:3001', origin: 'http://localhost:8081',
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (options.headers.authorization === 'Bearer invalid') return Response.json(null);
      return Response.json({ user: { id: 'alice', name: 'Alice' }, session: { userId: 'alice' } });
    },
  });
  assert.equal((await check({ authorization: 'Bearer service-secret' })).principal.kind, 'service');
  assert.equal(calls.length, 0);
  assert.equal((await check({})).failure.status, 401);
  assert.equal((await check({ authorization: 'Bearer invalid' })).failure.status, 401);
  const headers = { cookie: 'other=ignore; better-auth.session_token=test-session' };
  assert.equal((await check(headers)).failure.status, 401);
  assert.equal((await check(headers, { allowCookie: true, method: 'POST' })).failure.status, 403);
  assert.equal((await check({ ...headers, origin: 'http://localhost:3001' }, { allowCookie: true, method: 'POST' })).failure.status, 403);
  const session = await check({ ...headers, origin: 'http://localhost:8081' }, { allowCookie: true, method: 'POST' });
  assert.deepEqual(session.principal, { kind: 'user', id: 'alice', name: 'Alice' });
  assert.equal(calls.at(-1).options.headers.cookie, 'better-auth.session_token=test-session');
  assert.equal(calls.at(-1).options.redirect, 'error');
  assert.equal((await check({ ...headers, authorization: 'Bearer invalid' }, { allowCookie: true })).failure.status, 401);
  assert.equal((await check({ authorization: 'Bearer session-token' })).principal.id, 'alice');
});

test('identity lookup fails closed when HITLy is unavailable or malformed', async () => {
  const headers = { authorization: 'Bearer session-token' };
  const error = accessCheck(undefined, { sessionUrl: 'http://hotl:3001', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await error(headers)).failure.status, 503);
  const invalid = accessCheck(undefined, { sessionUrl: 'http://hotl:3001', fetchImpl: async () => Response.json({
    user: { id: 'alice' }, session: { userId: 'bob' },
  }) });
  assert.equal((await invalid(headers)).failure.status, 401);
});
