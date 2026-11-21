import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { approvalDetails, createHitlyClient, HitlyRequestError } from '../integrations/hitly/client.mjs';

const openApi = JSON.parse(readFileSync(new URL('./openapi.json', import.meta.url), 'utf8'));
const hitly = createHitlyClient();
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

function gatewayApprovalDetails(input) {
  const { title, context, payload, orderId, amountCents } = input;
  if (title === undefined && context === undefined && payload === undefined
      && typeof orderId === 'string' && orderId.length > 0 && orderId.length <= 80
      && Number.isSafeInteger(amountCents) && amountCents >= 1 && amountCents <= 100000000) {
    // Existing Studio volumes can still contain the original refund definition.
    return {
      actionName: 'Review simulated refund',
      contextMarkdown: 'Review the requested USD refund. This request simulates a refund.',
      args: { orderId, amountCents },
    };
  }

  return approvalDetails(input);
}

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/openapi.json') {
    return respond(res, 200, openApi);
  }
  if (req.method === 'GET' && req.url === '/health') {
    return respond(res, 200, { configured: hitly.configured });
  }
  if (req.method !== 'POST' || req.url !== '/approvals') {
    return respond(res, 404, { error: 'Route not found' });
  }
  if (!hitly.configured) {
    return respond(res, 503, { error: 'Configure the HITLy project and API key' });
  }

  const input = await readJson(req).catch(() => null);
  const { workflowId, runId, stepId } = input ?? {};
  const details = input && gatewayApprovalDetails(input);
  if (!details || ![workflowId, runId, stepId].every(value =>
      typeof value === 'string' && /^[\w.-]{1,120}$/.test(value))) {
    return respond(res, 400, { error: 'Invalid approval request' });
  }

  try {
    const result = await hitly.request({
      workflowId,
      namespace: temporalNamespace,
      idempotencyKey: `${workflowId}:${runId}:${stepId}`,
    }, details);
    return respond(res, 201, result);
  } catch (error) {
    if (error instanceof HitlyRequestError) {
      console.error('HITLy ingest returned HTTP %d', error.status);
      return respond(res, 502, { error: error.message });
    }
    console.error('HITLy ingest failed: %s', error.name);
    return respond(res, 502, { error: 'HITLy request failed' });
  }
}).listen(8080, '0.0.0.0');
