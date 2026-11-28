import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { AgentCard, Role, TaskState } from '@a2a-js/sdk';
import { ClientFactory, RestTransportFactory } from '@a2a-js/sdk/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { chromium } from 'playwright';
import { configureInfisicalServer, provisionInfisical } from '../tests/smoke/infisical.mjs';

const exec = promisify(execFile);
const api = 'http://localhost:8081';
const studio = 'http://localhost:3000';
const hitly = 'http://localhost:3001';
const artifacts = 'smoke-artifacts';

async function eventually(label, action, timeout = 120_000) {
  const end = Date.now() + timeout;
  let last;
  do {
    try {
      const result = await action();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await sleep(1000);
  } while (Date.now() < end);
  throw new Error(label + ' did not become ready', { cause: last });
}

async function json(url, options = {}, expected = 200) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, expected, new URL(url).pathname + ' HTTP status');
  return response.json();
}

function post(body, headers = {}) {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

async function compose(...args) {
  await exec('docker', ['compose', ...args], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
}

async function ready() {
  for (const [label, url] of [
    ['Homepage', 'http://localhost:8082/'],
    ['Studio', studio + '/api/workflows'],
    ['HITLy', hitly + '/api/v1/health'],
    ['Temporal UI', 'http://localhost:8233/'],
    ['API', api + '/v1/workflows'],
  ]) {
    await eventually(label, async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      return response.ok;
    }, 240_000);
    console.log(label + ' ready');
  }
}

test('real Hoverseer stack', { timeout: 15 * 60_000 }, async t => {
  process.loadEnvFile('.env');
  assert.ok(process.env.HOVERSEER_API_TOKEN, 'Run ./hoverseer init first');
  const auth = { authorization: 'Bearer ' + process.env.HOVERSEER_API_TOKEN };
  await mkdir(artifacts + '/screenshots', { recursive: true });
  const results = [];
  t.after(async () => {
    await writeFile(artifacts + '/workflow-results.json', JSON.stringify(results, null, 2) + '\n');
  });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  const start = (name, input, key = randomUUID()) => json(api + '/v1/workflows/' + name + '/runs', post(input, {
    ...auth, 'idempotency-key': key,
  }), 202);
  const status = (run, headers = auth) => json(api + run.statusUrl, { headers });
  const complete = async (label, run, expected, headers = auth) => {
    const value = await eventually(label, async () => {
      const current = await status(run, headers);
      return current.status === 'RUNNING' ? null : current;
    });
    assert.equal(value.status, 'COMPLETED', label);
    if (expected) assert.equal(value.result?.status, expected, label);
    results.push({ label, workflowId: run.workflowId, status: value.status, result: value.result });
    return value;
  };

  await ready();
  console.log('Checking Homepage, Studio and public workflow catalog');
  await page.goto('http://localhost:8082/', { waitUntil: 'domcontentloaded' });
  try {
    for (const target of [studio, hitly, api + '/workflows', 'http://localhost:8233']) {
      const links = page.locator('a[href="' + target + '"], a[href="' + target + '/"]');
      await links.first().waitFor({ state: 'attached', timeout: 30_000 });
    }
  } finally {
    await page.screenshot({ path: artifacts + '/screenshots/homepage.png', fullPage: true });
    console.log('Homepage title:', await page.title());
    console.log('Homepage body:', (await page.locator('body').innerText()).slice(0, 1000));
  }
  await page.goto(studio + '/workflows/article-review', { waitUntil: 'domcontentloaded' });
  await page.locator('body').waitFor();
  await page.screenshot({ path: artifacts + '/screenshots/studio.png', fullPage: true });
  const catalog = await json(api + '/v1/workflows');
  assert.ok(catalog.some(item => item.name === 'refund-review'));
  assert.ok(catalog.some(item => item.name === 'article-review'));
  const spec = await json(api + '/openapi.json');
  assert.ok(spec.paths['/v1/workflows/refund-review/runs'].post);
  const refund = { orderId: 'smoke-refund', amountCents: 5000 };
  const denied = await fetch(api + '/v1/workflows/refund-review/runs', post(refund));
  assert.equal(denied.status, 401);

  console.log('Checking REST, idempotency and actual Zigflow execution');
  const key = randomUUID();
  const run = await start('refund-review', refund, key);
  assert.deepEqual(await start('refund-review', refund, key), run);
  await complete('automatic refund', run, 'auto_approved');
  assert.equal((await fetch(api + run.statusUrl)).status, 401);

  console.log('Checking individual HITLy identities');
  await page.goto(api + '/workflows', { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: 'Sign in with HITLy' }).waitFor();
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal((await fetch(api + '/v1/me')).status, 401);
  assert.equal((await fetch(api + '/v1/me', { headers: { authorization: 'Bearer invalid-session' } })).status, 401);
  async function register(ctx, name, email) {
    const password = 'Smoke-' + randomUUID();
    const response = await ctx.request.post(hitly + '/api/auth/sign-up/email', {
      headers: { origin: hitly },
      data: { name, email, password },
    });
    assert.ok(response.ok(), 'HITLy signup: HTTP ' + response.status());
    const token = response.headers()['set-auth-token'] ?? (await response.json()).token;
    if (typeof token !== 'string' || !token) throw new Error('HITLy did not issue a session token');
    const who = await ctx.request.get(api + '/v1/me');
    assert.equal(who.status(), 200);
    const identity = await who.json();
    assert.equal(identity.name, name);
    assert.equal(identity.kind, 'user');
    const headers = { authorization: 'Bearer ' + token };
    const bearer = await fetch(api + '/v1/me', { headers });
    assert.equal(bearer.status, 200);
    assert.equal((await bearer.json()).id, identity.id);
    assert.ok(identity.workspace?.id, 'Personal HITLy workspace');
    assert.equal(identity.workspace.role, 'owner');
    return { identity, password, headers: { ...headers, 'x-hitly-workspace-id': identity.workspace.id } };
  }
  const alice = await register(context, 'CI Alice', 'ci-alice@example.com');
  const bobContext = await browser.newContext();
  t.after(() => bobContext.close());
  const bob = await register(bobContext, 'CI Bob', 'ci-bob@example.com');
  assert.notEqual(alice.identity.id, bob.identity.id);
  assert.notEqual(alice.identity.workspace.id, bob.identity.workspace.id);
  console.log('Checking live personal and shared workspace memberships');
  const teamContext = await browser.newContext();
  t.after(() => teamContext.close());
  const team = await register(teamContext, 'CI Team', 'ci-team@example.com');
  const teamId = team.identity.workspace.id;
  const teamPage = await teamContext.newPage();
  teamPage.setDefaultTimeout(60_000);
  await teamPage.goto(hitly + '/settings/team', { waitUntil: 'networkidle' });
  // HITLy itself adds existing accounts to a workspace; no test SQL or mock grants.
  for (const email of ['ci-alice@example.com', 'ci-bob@example.com']) {
    await teamPage.getByPlaceholder('Invite email').fill(email);
    await teamPage.getByRole('button', { name: 'Invite', exact: true }).click();
    await teamPage.locator('li').filter({ hasText: email }).waitFor();
  }
  const inWorkspace = (user, id) => ({ ...user.headers, 'x-hitly-workspace-id': id });
  const who = headers => fetch(api + '/v1/me', { headers });
  for (const user of [alice, bob]) {
    const member = await who(inWorkspace(user, teamId));
    assert.equal(member.status, 200);
    const identity = await member.json();
    assert.equal(identity.workspace.id, teamId);
    assert.equal(identity.workspace.role, 'member');
    assert.equal((await who(inWorkspace(user, 'ws-forged'))).status, 403);
  }
  assert.equal((await who(inWorkspace(alice, bob.identity.workspace.id))).status, 403);
  assert.equal((await who(inWorkspace(bob, alice.identity.workspace.id))).status, 403);
  assert.equal((await fetch(api + '/v1/workflows/refund-review/runs',
    post(refund, inWorkspace(alice, bob.identity.workspace.id)))).status, 403);
  assert.equal((await fetch(api + '/mcp', { headers: inWorkspace(alice, bob.identity.workspace.id) })).status, 403);
  assert.equal((await fetch(api + '/a2a/tasks/' + run.workflowId, {
    headers: { ...inWorkspace(alice, bob.identity.workspace.id), 'A2A-Version': '1.0' },
  })).status, 403);

  // Real native HITLy workspace switching; Hoverseer reflects the selected workspace.
  await page.goto(hitly + '/inbox', { waitUntil: 'networkidle' });
  const switcher = page.getByRole('combobox', { name: 'Workspace', exact: true });
  await switcher.locator('option[value="' + teamId + '"]').waitFor({ state: 'attached' });
  await switcher.selectOption(teamId);
  await eventually('HITLy selected team', async () => {
    const r = await context.request.get(api + '/v1/me');
    return r.ok() && (await r.json()).workspace.id === teamId;
  });
  await page.goto(api + '/workflows', { waitUntil: 'domcontentloaded' });
  await page.locator('#workspace-name').filter({ hasText: team.identity.workspace.name }).waitFor();
  await page.screenshot({ path: artifacts + '/screenshots/shared-workspace.png', fullPage: true });
  await page.goto(hitly + '/inbox', { waitUntil: 'networkidle' });
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(alice.identity.workspace.id);
  await eventually('HITLy selected personal workspace', async () => {
    const r = await context.request.get(api + '/v1/me');
    return r.ok() && (await r.json()).workspace.id === alice.identity.workspace.id;
  });

  const teamKey = randomUUID();
  const personal = await json(api + '/v1/workflows/refund-review/runs', post(refund, {
    ...alice.headers, 'idempotency-key': teamKey,
  }), 202);
  const shared = await json(api + '/v1/workflows/refund-review/runs', post(refund, {
    ...inWorkspace(alice, teamId), 'idempotency-key': teamKey,
  }), 202);
  assert.notEqual(personal.workflowId, shared.workflowId);
  assert.equal((await fetch(api + shared.statusUrl, { headers: alice.headers })).status, 404);
  assert.equal((await fetch(api + shared.statusUrl, { headers: inWorkspace(alice, teamId) })).status, 200);
  assert.equal((await fetch(api + shared.statusUrl, { headers: inWorkspace(bob, teamId) })).status, 404);
  await complete('team context execution', shared, 'auto_approved');

  const bobTeam = await json(api + '/v1/workflows/refund-review/runs', post(refund, inWorkspace(bob, teamId)), 202);
  await complete('Bob team context execution', bobTeam, 'auto_approved');
  // Removing membership in HITLy must revoke access on the very next request.
  await teamPage.locator('li').filter({ hasText: 'ci-bob@example.com' })
    .getByRole('button', { name: 'Remove', exact: true }).click();
  await teamPage.locator('li').filter({ hasText: 'ci-bob@example.com' }).waitFor({ state: 'detached' });
  assert.equal((await who(inWorkspace(bob, teamId))).status, 403);
  assert.equal((await fetch(api + bobTeam.statusUrl, { headers: inWorkspace(bob, teamId) })).status, 403);
  assert.equal((await who(bob.headers)).status, 200);
  const retryKey = randomUUID();
  const aliceRun = await json(api + '/v1/workflows/refund-review/runs', post(refund, {
    ...alice.headers, 'idempotency-key': retryKey,
  }), 202);
  const bobRun = await json(api + '/v1/workflows/refund-review/runs', post(refund, {
    ...bob.headers, 'idempotency-key': retryKey,
  }), 202);
  assert.notEqual(aliceRun.workflowId, bobRun.workflowId);
  assert.equal((await fetch(api + aliceRun.statusUrl, { headers: bob.headers })).status, 404);
  assert.equal((await fetch(api + bobRun.statusUrl, { headers: alice.headers })).status, 404);
  assert.equal((await fetch(api + run.statusUrl, { headers: alice.headers })).status, 404);
  assert.equal((await context.request.get(api + aliceRun.statusUrl)).status(), 200);
  assert.equal((await bobContext.request.get(api + aliceRun.statusUrl)).status(), 404);
  assert.equal((await context.request.post(api + '/v1/workflows/refund-review/runs', {
    data: refund, headers: { origin: hitly },
  })).status(), 403);
  const forged = await context.request.get(api + '/v1/me', { headers: { authorization: 'Bearer invalid-session' } });
  assert.equal(forged.status(), 401);
  await complete('Alice private execution', aliceRun, 'auto_approved');
  await complete('Bob private execution', bobRun, 'auto_approved');

  console.log('Checking Workflows browser page');
  await page.goto(api + '/workflows', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Refund review', exact: true }).click();
  await page.locator('#fields input').nth(0).fill('smoke-browser');
  await page.locator('#fields input').nth(1).fill('5000');
  await page.getByText('Signed in as CI Alice', { exact: true }).waitFor();
  await page.locator('#start').click();
  await page.locator('#run-status').filter({ hasText: 'COMPLETED' }).waitFor({ timeout: 120_000 });
  assert.match(await page.locator('#run-result').innerText(), /auto_approved/);
  await page.screenshot({ path: artifacts + '/screenshots/workflows.png', fullPage: true });

  console.log('Checking actual Cruncher shell execution');
  const { stdout } = await exec('docker', [
    'compose', 'exec', '-T', 'temporal', 'temporal', 'workflow', 'execute',
    '--type', 'shellExample', '--task-queue', 'shellExample', '--workflow-id', 'smoke-shell-' + randomUUID(),
    '--input', JSON.stringify({ message: 'smoke-shell-output' }),
  ], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  assert.match(stdout, /smoke-shell-output/);
  results.push({ label: 'shell', status: 'COMPLETED' });

  console.log('Checking MCP against the running server');
  const mcp = new Client({ name: 'hoverseer-smoke', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL('/mcp', api), {
    requestInit: { headers: alice.headers },
  }));
  try {
    assert.ok((await mcp.listTools()).tools.some(tool => tool.name === 'start_refund_review'));
    const started = await mcp.callTool({ name: 'start_refund_review', arguments: refund });
    assert.ok(!started.isError && started.structuredContent?.workflowId);
    const finished = await eventually('MCP refund', async () => {
      const response = await mcp.callTool({ name: 'get_run', arguments: { workflowId: started.structuredContent.workflowId } });
      assert.ok(!response.isError);
      return response.structuredContent.status === 'RUNNING' ? null : response.structuredContent;
    });
    assert.equal(finished.status, 'COMPLETED');
    assert.equal(finished.result.status, 'auto_approved');
    results.push({ label: 'MCP', status: finished.status });
  } finally {
    await mcp.close();
  }

  console.log('Checking A2A against the running server');
  const card = await json(api + '/.well-known/agent-card.json');
  assert.ok(card.skills.some(skill => skill.id === 'refund-review'));
  const transport = new RestTransportFactory({
    fetchImpl(url, init) {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', alice.headers.authorization);
      return fetch(url, { ...init, headers });
    },
  });
  const a2a = await new ClientFactory({ transports: [transport] }).createFromAgentCard(AgentCard.fromJSON(card));
  const task = await a2a.sendMessage({
    message: {
      messageId: randomUUID(), role: Role.ROLE_USER,
      parts: [{ content: { $case: 'data', value: { workflow: 'refund-review', input: refund } } }],
    },
    configuration: { returnImmediately: true },
  });
  const taskResult = await eventually('A2A refund', async () => {
    const current = await a2a.getTask({ id: task.id });
    return current.status.state === TaskState.TASK_STATE_COMPLETED ? current : null;
  });
  assert.equal(taskResult.artifacts[0].parts[0].content.value.status, 'auto_approved');
  results.push({ label: 'A2A', status: 'COMPLETED' });
  assert.equal((await fetch(api + '/a2a/tasks/' + task.id, {
    headers: { ...bob.headers, 'A2A-Version': '1.0' },
  })).status, 404);
  const bobMcp = new Client({ name: 'hoverseer-smoke-bob', version: '1.0.0' });
  await bobMcp.connect(new StreamableHTTPClientTransport(new URL('/mcp', api), { requestInit: { headers: bob.headers } }));
  try {
    const deniedRun = await bobMcp.callTool({ name: 'get_run', arguments: { workflowId: aliceRun.workflowId } });
    assert.equal(deniedRun.isError, true);
    assert.equal(deniedRun.structuredContent.status, 404);
  } finally {
    await bobMcp.close();
  }
  // Use the same server-side revocation endpoint and JSON body as HITLy's own browser UI.
  const signedOut = await bobContext.request.post(hitly + '/api/session/sign-out', {
    headers: { origin: hitly }, data: {},
  });
  assert.equal(signedOut.status(), 200, 'HITLy sign-out HTTP status');
  assert.equal((await signedOut.json()).ok, true);
  assert.equal((await bobContext.request.get(api + '/v1/me')).status(), 401);
  assert.equal((await fetch(api + '/v1/me', { headers: bob.headers })).status, 401);

  console.log('Provisioning a real local HITLy reviewer and Temporal project');
  await page.goto(hitly + '/projects', { waitUntil: 'networkidle' });
  const newProject = page.getByRole('button', { name: 'New project', exact: true });
  const projectDialog = page.getByRole('dialog');
  // Next.js can render the button before its React click handler is hydrated.
  // Retry only opening the dialog (no server-side mutation), never creation.
  try {
    await eventually('HITLy project dialog', async () => {
      if (await projectDialog.isVisible()) return true;
      await newProject.click({ timeout: 5000 });
      return projectDialog.isVisible();
    }, 30_000);
  } catch (error) {
    await page.screenshot({ path: artifacts + '/screenshots/hitly-project-dialog-failure.png', fullPage: true });
    throw error;
  }
  await page.locator('dialog input[name="name"]').fill('Hoverseer smoke');
  await page.locator('dialog select[name="plugin"]').selectOption('temporal');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/projects\/[^/]+\/config/);
  await page.waitForLoadState('networkidle');
  const projectId = new URL(page.url()).pathname.split('/')[2];
  const config = await context.request.patch(hitly + '/api/v1/projects/' + projectId + '/config', {
    headers: { origin: hitly },
    data: { name: 'Hoverseer smoke', address: 'temporal:7233', baseUrl: 'temporal:7233', namespace: 'default', taskQueue: 'articleReview', sla: '10' },
  });
  assert.ok(config.ok(), 'HITLy configuration: HTTP ' + config.status());
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  const keyNotice = page.getByText('Copy now — this is shown once:', { exact: false });
  await keyNotice.waitFor();
  const apiKey = (await keyNotice.innerText()).match(/hitly_[A-Za-z0-9_-]+/)?.[0];
  assert.ok(apiKey, 'HITLy project API key was created');
  // Never save the key screen, session cookies or HTTP traces as artifacts.
  await page.goto(hitly + '/projects', { waitUntil: 'domcontentloaded' });
  const env = await readFile('.env', 'utf8');
  await writeFile('.env', env.replace(/^HITLY_PROJECT_ID=.*$/m, 'HITLY_PROJECT_ID=' + projectId)
    .replace(/^HITLY_API_KEY=.*$/m, 'HITLY_API_KEY=' + apiKey), { mode: 0o600 });
  process.env.HITLY_PROJECT_ID = projectId;
  process.env.HITLY_API_KEY = apiKey;
  await compose('up', '-d', '--no-deps', '--force-recreate', 'cruncher', 'approval-gateway');

  async function review(decision, restart = false) {
    const run = await start('article-review', { headline: 'CI ' + decision, draft: 'A smoke test article.' });
    const approval = await eventually('HITLy approval ' + decision, async () => {
      const response = await fetch(hitly + '/api/v1/approvals/by-run-id?plugin=temporal&runId=' + encodeURIComponent(run.workflowId), {
        headers: { authorization: 'Bearer ' + apiKey }, signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) return null;
      assert.equal(response.status, 200);
      return response.json();
    });
    assert.equal((await status(run)).status, 'RUNNING');
    if (restart) {
      await compose('restart', 'zigflow', 'cruncher');
      assert.equal((await status(run)).status, 'RUNNING');
    }
    await page.goto(hitly + '/inbox', { waitUntil: 'networkidle' });
    await page.screenshot({ path: artifacts + '/screenshots/inbox-' + decision + '.png', fullPage: true });
    await page.goto(hitly + '/inbox/' + approval.id, { waitUntil: 'networkidle' });
    await page.getByText('Review article draft', { exact: true }).first().waitFor();
    await page.screenshot({ path: artifacts + '/screenshots/approval-pending-' + decision + '.png', fullPage: true });
    const response = await context.request.post(hitly + '/api/v1/approvals/' + approval.id + '/decide', {
      headers: { origin: hitly },
      data: { decision, ...(decision === 'reject' && { reason: 'CI rejection' }) },
    });
    assert.ok(response.ok(), 'HITLy decision: HTTP ' + response.status());
    const body = await response.json();
    assert.ok(!body.resumeError, 'HITLy must actually resume Temporal');
    await complete('approval ' + decision, run, decision === 'accept' ? 'ready_to_publish' : 'changes_requested');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Decision', exact: true }).waitFor();
    await page.screenshot({ path: artifacts + '/screenshots/approval-decided-' + decision + '.png', fullPage: true });
    if (decision === 'accept') {
      const adminPage = await context.newPage();
      await adminPage.goto('http://localhost:8233/namespaces/default/workflows/' + run.workflowId + '/' + run.runId + '/history', { waitUntil: 'networkidle' });
      await eventually('Temporal history visible', async () => (await adminPage.locator('body').innerText()).includes(run.workflowId));
      await adminPage.screenshot({ path: artifacts + '/screenshots/temporal-admin-history.png', fullPage: true });
      await adminPage.close();
    }
  }

  console.log('Checking real approval acceptance after worker restart');
  await review('accept', true);
  console.log('Checking real approval rejection');
  await review('reject');

  console.log('Checking Studio save, reopen and workflow reload');
  const path = studio + '/api/workflows/refund-review';
  const definition = await json(path);
  definition.document.title = 'Refund review smoke edit';
  await json(path, { ...post(definition), method: 'PUT' });
  assert.equal((await json(path)).document.title, definition.document.title);
  await compose('restart', 'zigflow', 'api');
  await eventually('reloaded API catalog', async () => {
    const entries = await json(api + '/v1/workflows');
    return entries.some(item => item.name === 'refund-review' && item.title === definition.document.title);
  });
  await complete('refund after Studio save and reload', await start('refund-review', refund), 'auto_approved');

  console.log('Checking optional static workspace execution deployment');
  // Provision resources only in this disposable test, using the same manual
  // commands and Compose overlay documented for administrators.
  const namespaces = {
    [alice.identity.workspace.id]: 'workspace-a',
    [bob.identity.workspace.id]: 'workspace-b',
    [teamId]: 'workspace-team',
  };
  for (const namespace of Object.values(namespaces)) {
    await compose('exec', '-T', 'temporal', 'temporal', 'operator', 'namespace', 'create', '--namespace', namespace);
    await mkdir('workspace-data/' + namespace, { recursive: true });
    await cp('workflows', 'workspace-data/' + namespace, { recursive: true });
  }
  // Different YAML implementations make a namespace-routing error observable.
  for (const namespace of Object.values(namespaces)) {
    const file = 'workspace-data/' + namespace + '/refund-review/workflow.yaml';
    const source = await readFile(file, 'utf8');
    assert.ok(source.includes('auto_approved'));
    await writeFile(file, source.replaceAll('auto_approved', 'approved-' + namespace));
  }
  const scopedConfig = await context.request.patch(hitly + '/api/v1/projects/' + projectId + '/config', {
    headers: { origin: hitly },
    data: { name: 'Hoverseer smoke', address: 'temporal:7233', baseUrl: 'temporal:7233',
      namespace: 'workspace-a', taskQueue: 'articleReview', sla: '10' },
  });
  assert.ok(scopedConfig.ok(), 'Workspace approval project configuration');
  const workspaceEnv = {
    HOVERSEER_WORKSPACE_NAMESPACES: JSON.stringify(namespaces),
    WORKSPACE_A_HITLY_PROJECT_ID: projectId,
    WORKSPACE_A_HITLY_API_KEY: apiKey,
  };
  await writeFile('.env', (await readFile('.env', 'utf8')) + '\n'
    + Object.entries(workspaceEnv).map(([name, value]) => name + '=' + value).join('\n') + '\n', { mode: 0o600 });
  Object.assign(process.env, workspaceEnv);
  const overlay = ['-f', 'compose.yaml', '-f', 'compose.workspaces.yaml'];
  await exec('sudo', ['chown', '-R', '1000:1000', 'workspace-data']);
  // Recreate Temporal too, removing its previously published Web port.
  await compose(...overlay, 'up', '-d', '--no-deps', 'temporal');
  await eventually('Temporal healthy after port removal', async () => {
    await compose('exec', '-T', 'temporal', 'temporal', 'operator', 'cluster', 'health');
    return true;
  });
  await compose(...overlay, 'up', '-d', '--no-deps', 'api', 'studio', 'dashboard',
    'studio-a', 'studio-b', 'studio-team',
    'zigflow-a', 'zigflow-b', 'zigflow-team', 'cruncher-a', 'cruncher-b', 'cruncher-team');
  await eventually('workspace execution API', async () => {
    const r = await fetch(api + '/v1/me', { headers: alice.headers });
    return r.ok && (await r.json()).executionNamespace === 'workspace-a';
  });
  // A fresh user-facing dashboard must not link to raw administrative ports.
  const finalHome = await context.newPage();
  await eventually('workspace Homepage ready', async () => {
    await finalHome.goto('http://localhost:8082/', { waitUntil: 'domcontentloaded' });
    return (await finalHome.locator('body').innerText()).includes('Administration and integration');
  });
  assert.equal(await finalHome.locator('a[href*=":8233"]').count(), 0);
  assert.equal(await finalHome.locator('a[href*=":3000"]').count(), 0);
  await finalHome.screenshot({ path: artifacts + '/screenshots/homepage-multiuser.png', fullPage: true });
  await finalHome.close();
  assert.equal(await fetch('http://localhost:8233/', { signal: AbortSignal.timeout(3000) }).then(() => true).catch(() => false), false);
  const bobLogin = await bobContext.request.post(hitly + '/api/auth/sign-in/email', {
    headers: { origin: hitly },
    data: { email: 'ci-bob@example.com', password: bob.password },
  });
  assert.ok(bobLogin.ok(), 'Bob signs in again');
  const bobToken = bobLogin.headers()['set-auth-token'] ?? (await bobLogin.json()).token;
  assert.ok(bobToken);
  const bobPrivate = { authorization: 'Bearer ' + bobToken, 'x-hitly-workspace-id': bob.identity.workspace.id };
  const teamHeaders = inWorkspace(alice, teamId);
  const mappedStart = (headers, name = 'refund-review', input = refund) =>
    json(api + '/v1/workflows/' + name + '/runs', post(input, headers), 202);
  const mappedAlice = await mappedStart(alice.headers);
  const mappedBob = await mappedStart(bobPrivate);
  const mappedTeam = await mappedStart(teamHeaders);
  await complete('Alice namespace', mappedAlice, 'approved-workspace-a', alice.headers);
  await complete('Bob namespace', mappedBob, 'approved-workspace-b', bobPrivate);
  await complete('Shared namespace (Alice)', mappedTeam, 'approved-workspace-team', teamHeaders);
  await complete('Shared namespace (owner)', await mappedStart(team.headers), 'approved-workspace-team', team.headers);
  assert.equal((await fetch(api + mappedAlice.statusUrl, { headers: bobPrivate })).status, 404);
  assert.equal((await fetch(api + mappedAlice.statusUrl, { headers: teamHeaders })).status, 404);
  assert.equal((await fetch(api + mappedAlice.statusUrl, { headers: auth })).status, 404);
  assert.equal((await fetch(api + mappedTeam.statusUrl, { headers: inWorkspace({ headers: bobPrivate }, teamId) })).status, 403);
  for (const [namespace, execution] of [['workspace-a', mappedAlice], ['workspace-b', mappedBob], ['workspace-team', mappedTeam]]) {
    await compose('exec', '-T', 'temporal', 'temporal', 'workflow', 'describe', '--namespace', namespace, '--workflow-id', execution.workflowId);
    // The same IDs must not exist in the legacy namespace or any other workspace.
    for (const other of ['default', ...Object.values(namespaces)].filter(n => n !== namespace)) {
      await assert.rejects(exec('docker', ['compose', 'exec', '-T', 'temporal', 'temporal', 'workflow', 'describe',
        '--namespace', other, '--workflow-id', execution.workflowId], { timeout: 15_000 }));
    }
    const shell = await exec('docker', ['compose', 'exec', '-T', 'temporal', 'temporal', 'workflow', 'execute',
      '--namespace', namespace, '--type', 'shellExample', '--task-queue', 'shellExample',
      '--workflow-id', 'scoped-shell-' + randomUUID(), '--input', JSON.stringify({ message: 'shell-' + namespace })],
    { timeout: 120_000, maxBuffer: 1024 * 1024 });
    assert.match(shell.stdout, new RegExp('shell-' + namespace));
  }
  const scopedApproval = await mappedStart(alice.headers, 'article-review', { headline: 'Scoped approval', draft: 'CI workspace review.' });
  const item = await eventually('workspace approval', async () => {
    const r = await fetch(hitly + '/api/v1/approvals/by-run-id?plugin=temporal&runId=' + encodeURIComponent(scopedApproval.workflowId), {
      headers: { authorization: 'Bearer ' + apiKey }, signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 404) return null;
    assert.equal(r.status, 200);
    return r.json();
  });
  const decided = await context.request.post(hitly + '/api/v1/approvals/' + item.id + '/decide', {
    headers: { origin: hitly }, data: { decision: 'accept' },
  });
  assert.ok(decided.ok());
  assert.ok(!(await decided.json()).resumeError);
  await complete('workspace approval', scopedApproval, 'ready_to_publish', alice.headers);

  // The actual managed protocol adapters must use the same namespace router.
  const scopedMcp = new Client({ name: 'workspace-mcp', version: '1.0.0' });
  await scopedMcp.connect(new StreamableHTTPClientTransport(new URL('/mcp', api), { requestInit: { headers: teamHeaders } }));
  try {
    const r = await scopedMcp.callTool({ name: 'start_refund_review', arguments: refund });
    assert.ok(!r.isError);
    await complete('workspace MCP', r.structuredContent, 'approved-workspace-team', teamHeaders);
  } finally {
    await scopedMcp.close();
  }
  const scopedTransport = new RestTransportFactory({
    fetchImpl(url, init) {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(bobPrivate)) headers.set(name, value);
      return fetch(url, { ...init, headers });
    },
  });
  const scopedA2a = await new ClientFactory({ transports: [scopedTransport] }).createFromAgentCard(AgentCard.fromJSON(card));
  const scopedTask = await scopedA2a.sendMessage({
    message: { messageId: randomUUID(), role: Role.ROLE_USER,
      parts: [{ content: { $case: 'data', value: { workflow: 'refund-review', input: refund } } }] },
    configuration: { returnImmediately: true },
  });
  await complete('workspace A2A', { statusUrl: '/v1/runs/' + scopedTask.id }, 'approved-workspace-b', bobPrivate);
  const unconfiguredContext = await browser.newContext();
  t.after(() => unconfiguredContext.close());
  const unconfigured = await register(unconfiguredContext, 'CI Unconfigured', 'ci-unconfigured@example.com');
  assert.equal((await (await fetch(api + '/v1/me', { headers: unconfigured.headers })).json()).executionNamespace, null);
  assert.equal((await fetch(api + '/v1/workflows/refund-review/runs', post(refund, unconfigured.headers))).status, 403);
  await page.goto(api + '/workflows', { waitUntil: 'domcontentloaded' });
  await page.locator('#execution-context').filter({ hasText: 'workspace-a' }).waitFor();
  await page.getByRole('button', { name: 'Refund review', exact: true }).click();
  await page.locator('#fields input').nth(0).fill('scoped-browser');
  await page.locator('#fields input').nth(1).fill('5000');
  await page.locator('#start').click();
  await page.locator('#run-status').filter({ hasText: 'COMPLETED' }).waitFor({ timeout: 120_000 });
  assert.match(await page.locator('#run-result').innerText(), /approved-workspace-a/);
  assert.equal(await page.locator('#run-link').isVisible(), false);
  assert.equal(await page.locator('#temporal-link').isVisible(), false);
  assert.match(await page.locator('#run-id').innerText(), /^hoverseer-/);
  assert.match(await page.locator('#deploy-note').innerText(), /administrator must validate and reload/);
  assert.equal(await page.locator('#edit-link').isVisible(), true);
  assert.equal(await page.locator('#edit-link').getAttribute('href'), 'http://localhost:3002/workflows/refund-review');
  await page.screenshot({ path: artifacts + '/screenshots/workspace-execution.png', fullPage: true });
  const teamWorkflows = await teamContext.newPage();
  await teamWorkflows.goto(api + '/workflows', { waitUntil: 'domcontentloaded' });
  await teamWorkflows.locator('#execution-context').filter({ hasText: 'workspace-team' }).waitFor();
  await teamWorkflows.getByRole('button', { name: 'Refund review', exact: true }).waitFor();
  await teamWorkflows.screenshot({ path: artifacts + '/screenshots/team-workflows.png', fullPage: true });
  await teamWorkflows.close();

  console.log('Checking protected workspace Studio authoring');
  const studioA = 'http://localhost:3002';
  const studioB = 'http://localhost:3003';
  const studioTeam = 'http://localhost:3004';
  const definitionPath = '/api/workflows/refund-review';
  for (const url of [studioA, studioB, studioTeam]) {
    await eventually('protected Studio ' + url, async () => {
      const r = await fetch(url + definitionPath);
      return r.status === 401;
    });
    assert.equal((await fetch(url + '/workflows/refund-review')).status, 401);
  }
  assert.equal((await context.request.get(studioA + definitionPath)).status(), 200);
  assert.equal((await context.request.get(studioB + definitionPath)).status(), 403);
  assert.equal((await bobContext.request.get(studioA + definitionPath)).status(), 403);
  assert.equal((await bobContext.request.get(studioA + '/workflows/refund-review')).status(), 403);
  assert.equal((await bobContext.request.get(studioB + definitionPath)).status(), 200);
  assert.equal((await context.request.get(studioTeam + definitionPath)).status(), 200);
  assert.equal((await teamContext.request.get(studioTeam + definitionPath)).status(), 200);
  assert.equal((await bobContext.request.get(studioTeam + definitionPath)).status(), 403);
  assert.equal((await unconfiguredContext.request.get(studioA + definitionPath)).status(), 403);
  assert.equal((await fetch(api + '/v1/studio-access/workspace-a', { headers: auth })).status, 401);
  const oldStudio = await fetch(studio + definitionPath, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  assert.ok(!oldStudio || !oldStudio.ok, 'Legacy Studio must no longer expose workflow data');

  const beforeAlice = await (await context.request.get(studioA + definitionPath)).json();
  const beforeBob = await (await bobContext.request.get(studioB + definitionPath)).json();
  const beforeTeam = await (await teamContext.request.get(studioTeam + definitionPath)).json();
  assert.equal((await bobContext.request.put(studioA + definitionPath, {
    headers: { origin: studioA }, data: beforeBob,
  })).status(), 403);
  assert.equal((await bobContext.request.delete(studioA + definitionPath, {
    headers: { origin: studioA },
  })).status(), 403);
  assert.equal((await context.request.put(studioA + definitionPath, {
    headers: { origin: studioB }, data: beforeAlice,
  })).status(), 403);
  assert.equal((await context.request.get(studioB + definitionPath, {
    headers: { 'x-hitly-workspace-id': alice.identity.workspace.id },
  })).status(), 403);
  assert.equal((await context.request.get(studioA + '/api/workflows/%2e%2e%2fworkspace-b')).ok(), false);

  // Real browser editor save, not a simulated Studio API or DOM.
  await page.locator('#edit-link').click();
  await page.waitForURL(studioA + '/workflows/refund-review');
  await page.waitForLoadState('networkidle');
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Alice protected edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await eventually('Studio browser saved Alice title', async () => {
    const r = await context.request.get(studioA + definitionPath);
    return r.ok() && (await r.json()).document.title === 'Alice protected edit';
  });
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getByRole('textbox', { name: 'Title', exact: true }).inputValue(), 'Alice protected edit');
  await page.getByText('Workspace: workspace-a', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Back to Hoverseer' }).getAttribute('href'), api + '/workflows');
  await page.screenshot({ path: artifacts + '/screenshots/protected-studio.png', fullPage: true });
  const studioNodes = await context.newPage();
  await studioNodes.goto(studioA + '/workflows/article-review/articleReview', { waitUntil: 'networkidle' });
  await studioNodes.getByText('requestReview', { exact: true }).first().waitFor();
  await studioNodes.screenshot({ path: artifacts + '/screenshots/studio-expanded-nodes.png', fullPage: true });
  await studioNodes.close();

  const aliceEdited = await (await context.request.get(studioA + definitionPath)).json();
  // Change behavior through the real Studio API and prove the edited YAML is executed.
  const updated = JSON.parse(JSON.stringify(aliceEdited).replaceAll('approved-workspace-a', 'approved-protected-edit'));
  assert.notDeepEqual(updated, aliceEdited);
  const saved = await context.request.put(studioA + definitionPath, {
    headers: { origin: studioA }, data: updated,
  });
  assert.equal(saved.status(), 200);
  assert.deepEqual((await (await bobContext.request.get(studioB + definitionPath)).json()).document, beforeBob.document);
  assert.deepEqual((await (await teamContext.request.get(studioTeam + definitionPath)).json()).document, beforeTeam.document);
  assert.match(await readFile('workspace-data/workspace-a/refund-review/workflow.yaml', 'utf8'), /approved-protected-edit/);
  assert.doesNotMatch(await readFile('workspace-data/workspace-b/refund-review/workflow.yaml', 'utf8'), /approved-protected-edit/);

  console.log('Checking safe reload preflight against an incompatible saved workflow');
  const incompatible = structuredClone(updated);
  incompatible.input.schema.document.properties.extra = { type: 'string' };
  const invalidSave = await context.request.put(studioA + definitionPath, {
    headers: { origin: studioA }, data: incompatible,
  });
  assert.equal(invalidSave.status(), 200, 'A draft may be saved but cannot change the managed API contract');
  const priorCatalog = await json(api + '/v1/workspace/workflows', { headers: alice.headers });
  await assert.rejects(exec('./hoverseer', ['docker', 'reload', 'workspace-a'], { timeout: 60_000 }),
    error => /Workspace catalog must match the shared public workflow names and input schemas/.test(error.stderr));
  assert.deepEqual(await json(api + '/v1/workspace/workflows', { headers: alice.headers }), priorCatalog);
  await complete('Bob unaffected by rejected deployment', await mappedStart(bobPrivate), 'approved-workspace-b', bobPrivate);
  const restored = await context.request.put(studioA + definitionPath, {
    headers: { origin: studioA }, data: updated,
  });
  assert.equal(restored.status(), 200);
  await exec('./hoverseer', ['docker', 'reload', 'workspace-a'], { timeout: 180_000 });
  await eventually('workspace catalog reloaded from edited YAML', async () => {
    const r = await fetch(api + '/v1/workspace/workflows', { headers: alice.headers });
    return r.ok && (await r.json()).some(item => item.title === 'Alice protected edit');
  });
  await complete('protected Studio edited execution', await mappedStart(alice.headers), 'approved-protected-edit', alice.headers);
  await complete('Bob unaffected by Alice edit', await mappedStart(bobPrivate), 'approved-workspace-b', bobPrivate);
  await complete('Team unaffected by Alice edit', await mappedStart(teamHeaders), 'approved-workspace-team', teamHeaders);
  const revokedStudioSession = await bobContext.request.post(hitly + '/api/session/sign-out', {
    headers: { origin: hitly }, data: {},
  });
  assert.equal(revokedStudioSession.status(), 200);
  assert.equal((await bobContext.request.get(studioB + definitionPath)).status(), 401);

  console.log('Checking live Infisical credentials for personal and team workspaces');
  // Give Bob and the team their own real HITLy projects, rather than sharing
  // Alice's approval key. All setup uses HITLy's existing browser and API.
  const bobAgain = await bobContext.request.post(hitly + '/api/auth/sign-in/email', {
    headers: { origin: hitly }, data: { email: 'ci-bob@example.com', password: bob.password },
  });
  assert.ok(bobAgain.ok(), 'Bob signs in for credential tests');
  const bobAgainToken = bobAgain.headers()['set-auth-token'] ?? (await bobAgain.json()).token;
  assert.ok(bobAgainToken);
  const bobVaultHeaders = { authorization: 'Bearer ' + bobAgainToken, 'x-hitly-workspace-id': bob.identity.workspace.id };
  async function createVaultApproval(ctx, namespace) {
    const editor = await ctx.newPage();
    editor.setDefaultTimeout(60_000);
    await editor.goto(hitly + '/projects', { waitUntil: 'networkidle' });
    const button = editor.getByRole('button', { name: 'New project', exact: true });
    const dialog = editor.getByRole('dialog');
    await eventually('HITLy credential project dialog', async () => {
      if (await dialog.isVisible()) return true;
      await button.click({ timeout: 5000 });
      return dialog.isVisible();
    }, 30_000);
    await editor.locator('dialog input[name="name"]').fill('Vault ' + namespace);
    await editor.locator('dialog select[name="plugin"]').selectOption('temporal');
    await editor.getByRole('button', { name: 'Create', exact: true }).click();
    await editor.waitForURL(/\/projects\/[^/]+\/config/);
    await editor.waitForLoadState('networkidle');
    const projectId = new URL(editor.url()).pathname.split('/')[2];
    const cfg = await ctx.request.patch(hitly + '/api/v1/projects/' + projectId + '/config', {
      headers: { origin: hitly },
      data: { name: 'Vault ' + namespace, address: 'temporal:7233', baseUrl: 'temporal:7233',
        namespace, taskQueue: 'articleReview', sla: '10' },
    });
    assert.ok(cfg.ok(), 'Vault HITLy project configuration');
    await editor.getByRole('button', { name: 'Create key', exact: true }).click();
    const notice = editor.getByText('Copy now — this is shown once:', { exact: false });
    await notice.waitFor();
    const apiKey = (await notice.innerText()).match(/hitly_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(apiKey, 'Vault HITLy project API key');
    await editor.close();
    return { projectId, apiKey };
  }
  const credentials = {
    a: { projectId, apiKey },
    b: await createVaultApproval(bobContext, 'workspace-b'),
    team: await createVaultApproval(teamContext, 'workspace-team'),
  };
  await configureInfisicalServer();
  const vaultOverlay = [...overlay, '-f', 'compose.infisical.yaml'];
  await compose(...vaultOverlay, 'up', '-d', 'infisical');
  await eventually('Infisical', async () => (await fetch('http://localhost:8084/api/status', {
    signal: AbortSignal.timeout(5000),
  })).ok, 240_000);
  const vaultAdmin = await provisionInfisical(credentials);
  // Remove direct approval keys. Success now requires live SDK authentication
  // and a secret read in the actual worker container.
  const clear = Object.fromEntries(['A', 'B', 'TEAM'].flatMap(suffix => [
    ['WORKSPACE_' + suffix + '_HITLY_PROJECT_ID', ''],
    ['WORKSPACE_' + suffix + '_HITLY_API_KEY', ''],
  ]));
  Object.assign(process.env, clear);
  const directEnv = (await readFile('.env', 'utf8')).split('\n')
    .filter(line => !Object.keys(clear).some(key => line.startsWith(key + '='))).join('\n');
  await writeFile('.env', directEnv + '\n', { mode: 0o600 });
  await compose(...vaultOverlay, 'up', '-d', '--no-deps', '--force-recreate', 'cruncher-a', 'cruncher-b', 'cruncher-team');

  for (const [suffix, namespace, headers, reviewer] of [
    ['a', 'workspace-a', alice.headers, context],
    ['b', 'workspace-b', bobVaultHeaders, bobContext],
    ['team', 'workspace-team', teamHeaders, teamContext],
  ]) {
    const secret = credentials[suffix];
    const run = await mappedStart(headers, 'article-review', { headline: 'Infisical ' + suffix, draft: 'Vault smoke approval.' });
    const approval = await eventually('Infisical approval ' + suffix, async () => {
      const r = await fetch(hitly + '/api/v1/approvals/by-run-id?plugin=temporal&runId=' + encodeURIComponent(run.workflowId), {
        headers: { authorization: 'Bearer ' + secret.apiKey }, signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 404) return null;
      assert.equal(r.status, 200);
      return r.json();
    });
    const decision = await reviewer.request.post(hitly + '/api/v1/approvals/' + approval.id + '/decide', {
      headers: { origin: hitly }, data: { decision: 'accept' },
    });
    assert.ok(decision.ok(), 'Vault approval decision');
    assert.ok(!(await decision.json()).resumeError);
    await complete('Infisical approval ' + suffix, run, 'ready_to_publish', headers);
    const history = await exec('docker', ['compose', 'exec', '-T', 'temporal', 'temporal', 'workflow', 'show',
      '--namespace', namespace, '--workflow-id', run.workflowId, '--output', 'json'],
    { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    for (const value of Object.values(credentials).flatMap(item => [item.projectId, item.apiKey])) {
      assert.ok(!history.stdout.includes(value) && !history.stdout.includes(Buffer.from(value).toString('base64')),
        'Approval credential must not appear in Temporal history');
    }
  }

  console.log('Capturing the native Infisical project access controls (no secret values)');
  const vaultBrowser = await browser.newContext();
  t.after(() => vaultBrowser.close());
  const vaultPage = await vaultBrowser.newPage();
  vaultPage.setDefaultTimeout(60_000);
  await vaultPage.goto('http://localhost:8084/login', { waitUntil: 'domcontentloaded' });
  await vaultPage.locator('input[name="email"]').fill(vaultAdmin.email);
  await vaultPage.locator('input[name="password"]').fill(vaultAdmin.password);
  await vaultPage.getByRole('button', { name: 'Continue with Email' }).click();
  await vaultPage.waitForURL(/\/organizations\/[^/]+\/projects/, { timeout: 90_000 });
  // API bootstrap creates the administrator, but the pinned native UI still
  // requires the first-run access/review wizard. Complete it with the secure
  // invite-only default, not a bypass or direct database update.
  const projectsUrl = 'http://localhost:8084/organizations/' + vaultAdmin.organizationId + '/projects/secret-management';
  await vaultPage.goto(projectsUrl, { waitUntil: 'domcontentloaded' });
  try {
    await vaultPage.getByText('Control who can join', { exact: true }).waitFor();
    assert.equal(await vaultPage.locator('#signup-disabled').getAttribute('data-state'), 'checked', 'Invite-only default');
    await vaultPage.getByRole('button', { name: 'Continue', exact: true }).click();
    await vaultPage.getByText('Review your settings', { exact: true }).waitFor();
    await vaultPage.getByRole('button', { name: 'Finish setup', exact: true }).click();
    await vaultPage.getByText('Your instance is ready.', { exact: true }).waitFor();
    await vaultPage.getByRole('button', { name: /Go to dashboard/ }).click();
    await vaultPage.waitForURL(/\/organizations\/[^/]+\/projects/);
    await vaultPage.goto(projectsUrl, { waitUntil: 'domcontentloaded' });
    await vaultPage.getByText('Hoverseer a', { exact: true }).first().waitFor();
    await vaultPage.getByText('Hoverseer b', { exact: true }).first().waitFor();
    await vaultPage.getByText('Hoverseer team', { exact: true }).first().waitFor();
  } catch (error) {
    await vaultPage.screenshot({ path: artifacts + '/screenshots/infisical-project-list-failure.png', fullPage: true });
    throw error;
  }
  await vaultPage.screenshot({ path: artifacts + '/screenshots/infisical-projects.png', fullPage: true });
  await vaultPage.goto('http://localhost:8084/organizations/' + vaultAdmin.organizationId
    + '/projects/secret-management/' + vaultAdmin.projectIds.a + '/access-management', { waitUntil: 'domcontentloaded' });
  try {
    await vaultPage.getByRole('tab', { name: 'Machine Identities' }).click();
    await vaultPage.getByText('Cruncher a', { exact: true }).first().waitFor();
  } catch (error) {
    await vaultPage.screenshot({ path: artifacts + '/screenshots/infisical-access-failure.png', fullPage: true });
    throw error;
  }
  await vaultPage.screenshot({ path: artifacts + '/screenshots/infisical-workspace-access.png', fullPage: true });
  await vaultPage.close();
});
