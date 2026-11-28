import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkspaceNamespaces, routeRuns } from './execution.mjs';

test('workspace namespace mapping is explicit, unique and never uses the default namespace', () => {
  assert.equal(parseWorkspaceNamespaces(undefined), null);
  assert.equal(parseWorkspaceNamespaces('{}').size, 0);
  assert.deepEqual([...parseWorkspaceNamespaces('{"ws-a":"workspace-a","ws-b":"workspace-b"}')], [
    ['ws-a', 'workspace-a'], ['ws-b', 'workspace-b'],
  ]);
  for (const source of ['[]', 'null', '{"ws-a":"default"}', '{"ws-a":"../other"}',
    '{"a":"same","b":"same"}', '{"a":7}']) {
    assert.throws(() => parseWorkspaceNamespaces(source));
  }
});

test('verified workspace routes every operation to the same worker namespace', async () => {
  const calls = [];
  const handlers = Object.fromEntries(['start', 'get', 'wait', 'cancel'].map(name =>
    [name, async (...args) => { calls.push([name, ...args]); return name; }]));
  const principal = { kind: 'user', id: 'alice', workspace: { id: 'a' } };
  const actual = { name: 'refund', taskQueue: 'private' };
  const routes = routeRuns({ workflow: {} }, new Map([
    ['a', { namespace: 'workspace-a', runs: handlers, catalog: [actual] }],
  ]));
  assert.equal(routes.namespace(principal), 'workspace-a');
  assert.equal(await routes.start({ name: 'refund' }, {}, 'key', principal), 'start');
  assert.equal(calls[0][1], actual);
  await routes.get('id', principal);
  await routes.wait('id', undefined, principal);
  await routes.cancel('id', principal);
  assert.deepEqual(calls.map(call => call[0]), ['start', 'get', 'wait', 'cancel']);
  const missing = { ...principal, workspace: { id: 'b' } };
  assert.equal(routes.namespace(missing), null);
  assert.throws(() => routes.get('id', missing), { status: 403 });
  assert.equal(routes.namespace({ kind: 'service' }), 'default');
});
