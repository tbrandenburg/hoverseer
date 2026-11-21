import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { loadHitlyCredentials } from './infisical.mjs';

test('direct environment configuration works without Infisical', async () => {
  assert.deepEqual(await loadHitlyCredentials({ HITLY_API_KEY: 'direct-key' }), {});
  await assert.rejects(loadHitlyCredentials({ INFISICAL_PROJECT_ID: 'project' }),
    /Incomplete Infisical configuration/);
});

test('reads only the two HITLy keys with scoped Universal Auth', async t => {
  const values = { HITLY_PROJECT_ID: 'hitly-project', HITLY_API_KEY: 'hitly-key' };
  const requests = [];
  let denyApiKey = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('content-type', 'application/json');

    if (request.method === 'POST' && url.pathname === '/api/v1/auth/universal-auth/login') {
      const body = [];
      for await (const chunk of request) body.push(chunk);
      requests.push({ login: JSON.parse(Buffer.concat(body)) });
      response.end(JSON.stringify({ accessToken: 'machine-token' }));
      return;
    }

    const secretName = url.pathname.replace('/api/v3/secrets/raw/', '');
    requests.push({
      method: request.method,
      authorization: request.headers.authorization,
      secretName,
      query: Object.fromEntries(url.searchParams),
    });
    if (denyApiKey && secretName === 'HITLY_API_KEY') {
      response.statusCode = 403;
      response.end(JSON.stringify({ message: 'private server diagnostic' }));
      return;
    }
    response.end(JSON.stringify({ secret: { secretValue: values[secretName] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = {
    INFISICAL_SITE_URL: `http://127.0.0.1:${server.address().port}`,
    INFISICAL_CLIENT_ID: 'client',
    INFISICAL_CLIENT_SECRET: 'client-secret',
    INFISICAL_PROJECT_ID: 'infisical-project',
    HITLY_API_KEY: 'direct-key',
  };

  assert.deepEqual(await loadHitlyCredentials(env), { projectId: 'hitly-project', apiKey: 'hitly-key' });
  const [login, ...reads] = requests;
  assert.deepEqual(login, { login: { clientId: 'client', clientSecret: 'client-secret' } });
  assert.deepEqual(reads.map(read => read.secretName).sort(), Object.keys(values).sort());
  for (const read of reads) {
    assert.equal(read.method, 'GET');
    assert.equal(read.authorization, 'Bearer machine-token');
    assert.equal(read.query.workspaceId, 'infisical-project');
    assert.equal(read.query.environment, 'prod');
    assert.equal(read.query.secretPath, '/cruncher');
    assert.equal(read.query.expandSecretReferences, 'false');
  }

  denyApiKey = true;
  await assert.rejects(loadHitlyCredentials(env), { message: 'Cruncher could not read HITLY_API_KEY from Infisical.' });
});
