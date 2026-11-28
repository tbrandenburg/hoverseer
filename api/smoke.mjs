import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { AgentCard, Role, TaskState } from '@a2a-js/sdk';
import { ClientFactory, RestTransportFactory } from '@a2a-js/sdk/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { chromium } from 'playwright';

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
  const status = run => json(api + run.statusUrl, { headers: auth });
  const complete = async (label, run, expected) => {
    const value = await eventually(label, async () => {
      const current = await status(run);
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

  console.log('Checking Workflows browser page');
  await page.goto(api + '/workflows', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Refund review', exact: true }).click();
  await page.locator('#fields input').nth(0).fill('smoke-browser');
  await page.locator('#fields input').nth(1).fill('5000');
  await page.locator('#token').fill(process.env.HOVERSEER_API_TOKEN);
  await page.locator('#start').click();
  await page.locator('#run-status').filter({ hasText: 'COMPLETED' }).waitFor({ timeout: 120_000 });
  assert.match(await page.locator('#run-result').innerText(), /auto_approved/);
  await page.locator('#token').fill('');
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
    requestInit: { headers: auth },
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
      headers.set('Authorization', auth.authorization);
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

  console.log('Provisioning a real local HITLy reviewer and Temporal project');
  const signup = await context.request.post(hitly + '/api/auth/sign-up/email', {
    headers: { origin: hitly },
    data: { name: 'CI Reviewer', email: 'ci-reviewer@example.com', password: 'Smoke-' + randomUUID() },
  });
  assert.ok(signup.ok(), 'HITLy signup: HTTP ' + signup.status());
  await page.goto(hitly + '/projects', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.locator('dialog input[name="name"]').fill('Hoverseer smoke');
  await page.locator('dialog select[name="plugin"]').selectOption('temporal');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/projects\/[^/]+\/config/);
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
    await page.goto(hitly + '/inbox', { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: artifacts + '/screenshots/inbox-' + decision + '.png', fullPage: true });
    const response = await context.request.post(hitly + '/api/v1/approvals/' + approval.id + '/decide', {
      headers: { origin: hitly },
      data: { decision, ...(decision === 'reject' && { reason: 'CI rejection' }) },
    });
    assert.ok(response.ok(), 'HITLy decision: HTTP ' + response.status());
    const body = await response.json();
    assert.ok(!body.resumeError, 'HITLy must actually resume Temporal');
    await complete('approval ' + decision, run, decision === 'accept' ? 'ready_to_publish' : 'changes_requested');
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
});
