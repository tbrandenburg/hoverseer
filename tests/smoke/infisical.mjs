import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';

const base = 'http://localhost:8084';
const generated = () => randomBytes(32).toString('hex');

export async function configureInfisicalServer() {
  const values = {
    INFISICAL_ENCRYPTION_KEY: randomBytes(16).toString('hex'),
    INFISICAL_AUTH_SECRET: randomBytes(32).toString('base64'),
    INFISICAL_DB_PASSWORD: generated(),
    HOVERSEER_INFISICAL_UI_URL: base,
  };
  await writeFile('.env', (await readFile('.env', 'utf8')) + '\n'
    + Object.entries(values).map(([key, value]) => key + '=' + value).join('\n') + '\n', { mode: 0o600 });
  Object.assign(process.env, values);
}

export async function provisionInfisical(projects) {
  // The pinned upstream bootstrap API creates a test-only administrator and
  // token. No production provisioning code or database manipulation.
  const call = async (path, body, token, method = 'POST') => {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    // Do not dump response bodies, which may contain plaintext credentials.
    assert.ok(response.ok, 'Infisical ' + method + ' ' + path + ' HTTP ' + response.status);
    return response.json();
  };
  const boot = await call('/api/v1/admin/bootstrap', {
    email: 'ci-admin@example.com', password: 'Smoke-' + generated(), organization: 'Hoverseer CI',
  });
  const admin = boot.identity.credentials.token;
  assert.ok(admin);
  // Redact the ephemeral bootstrap token from diagnostics as well.
  await writeFile('.env', (await readFile('.env', 'utf8')) + '\nSMOKE_INFISICAL_ADMIN_TOKEN=' + admin + '\n', { mode: 0o600 });
  const scopes = {};
  for (const [suffix, credentials] of Object.entries(projects)) {
    const project = (await call('/api/v1/projects', { projectName: 'Hoverseer ' + suffix }, admin)).project;
    assert.ok(project.id);
    for (const [name, value] of Object.entries({ HITLY_PROJECT_ID: credentials.projectId, HITLY_API_KEY: credentials.apiKey })) {
      await call('/api/v4/secrets/' + name, {
        projectId: project.id, environment: 'prod', secretPath: '/', secretValue: value,
      }, admin);
    }
    const identity = (await call('/api/v1/identities', {
      name: 'Cruncher ' + suffix, organizationId: boot.organization.id, role: 'no-access',
    }, admin)).identity;
    assert.ok(identity.id);
    await call('/api/v2/workspace/' + project.id + '/identity-memberships/' + identity.id, {
      role: 'viewer',
    }, admin);
    const authPath = '/api/v1/auth/universal-auth/identities/' + identity.id;
    const attached = await call(authPath, { accessTokenTTL: 3600, accessTokenMaxTTL: 3600 }, admin);
    const clientId = attached.identityUniversalAuth.clientId;
    const secret = await call(authPath + '/client-secrets', { description: 'Disposable smoke worker' }, admin);
    assert.ok(clientId && secret.clientSecret);
    const values = {
      INFISICAL_SITE_URL: 'http://infisical:8080',
      INFISICAL_PROJECT_ID: project.id,
      INFISICAL_CLIENT_ID: clientId,
      INFISICAL_CLIENT_SECRET: secret.clientSecret,
      INFISICAL_ENVIRONMENT: 'prod',
      INFISICAL_SECRET_PATH: '/',
    };
    await writeFile('cruncher/.env.infisical-' + suffix,
      Object.entries(values).map(([key, value]) => key + '=' + value).join('\n') + '\n', { mode: 0o600 });
    // Directly prove Infisical itself refuses a cross-project read and a write.
    const login = await call('/api/v1/auth/universal-auth/login', { clientId, clientSecret: secret.clientSecret });
    assert.ok(login.accessToken);
    scopes[suffix] = { projectId: project.id, token: login.accessToken };
  }
  for (const [suffix, scope] of Object.entries(scopes)) {
    for (const [other, target] of Object.entries(scopes)) {
      const query = new URLSearchParams({ workspaceId: target.projectId, environment: 'prod', secretPath: '/' });
      const response = await fetch(base + '/api/v3/secrets/raw/HITLY_API_KEY?' + query, {
        headers: { authorization: 'Bearer ' + scope.token }, signal: AbortSignal.timeout(15_000),
      });
      if (suffix === other) {
        assert.equal(response.status, 200, 'Own Infisical project read');
        // Compare booleans to avoid printing a secret on failure.
        assert.ok((await response.json()).secret.secretValue === projects[suffix].apiKey, 'Own project credential matches');
      } else {
        assert.ok([403, 404].includes(response.status), 'Cross-project secret read must fail');
        await response.body?.cancel();
      }
    }
    const write = await fetch(base + '/api/v4/secrets/UNAUTHORIZED_WRITE', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + scope.token, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: scope.projectId, environment: 'prod', secretPath: '/', secretValue: 'not-allowed' }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.ok([403, 404].includes(write.status), 'Viewer must not write credentials');
    await write.body?.cancel();
  }
}
