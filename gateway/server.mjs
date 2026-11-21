import { createServer } from 'node:http';

const hitlyUrl = new URL('/api/v1/approvals', process.env.HITLY_URL ?? 'http://hitly:3001');
const projectId = process.env.HITLY_PROJECT_ID;
const apiKey = process.env.HITLY_API_KEY;
const temporalAddress = process.env.TEMPORAL_ADDRESS ?? 'temporal:7233';
const temporalNamespace = process.env.TEMPORAL_NAMESPACE ?? 'default';

function respond(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req.setEncoding('utf8')) {
    body += chunk;
    if (Buffer.byteLength(body) > 8192) return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return respond(res, 200, { configured: Boolean(projectId && apiKey) });
  }
  if (req.method !== 'POST' || req.url !== '/approvals') {
    return respond(res, 404, { error: 'Route not found' });
  }
  if (!projectId || !apiKey) {
    return respond(res, 503, { error: 'Configure the HITLy project and API key' });
  }

  const input = await readJson(req).catch(() => null);
  const { workflowId, runId, stepId, orderId, amountCents } = input ?? {};
  if (![workflowId, runId, stepId].every(value => typeof value === 'string' && /^[\w.-]{1,120}$/.test(value))
      || typeof orderId !== 'string' || orderId.length < 1 || orderId.length > 80
      || !Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 100000000) {
    return respond(res, 400, { error: 'Invalid approval request' });
  }

  try {
    const approval = await fetch(hitlyUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': `${workflowId}:${runId}:${stepId}`,
      },
      body: JSON.stringify({
        plugin: 'temporal',
        projectId,
        workflowId,
        address: temporalAddress,
        namespace: temporalNamespace,
        actionName: 'Review simulated refund',
        args: { orderId, amountCents },
        contextMarkdown: 'Review the requested USD refund. This request simulates a refund.',
      }),
    });
    if (!approval.ok) {
      console.error('HITLy ingest returned HTTP %d', approval.status);
      return respond(res, 502, { error: `HITLy returned HTTP ${approval.status}` });
    }
    const result = await approval.json();
    if (typeof result?.id !== 'string' || !result.id) {
      return respond(res, 502, { error: 'HITLy response did not contain an approval ID' });
    }
    return respond(res, 201, { approvalId: result.id });
  } catch (error) {
    console.error('HITLy ingest failed: %s', error.name);
    return respond(res, 502, { error: 'HITLy request failed' });
  }
}).listen(8080, '0.0.0.0');
