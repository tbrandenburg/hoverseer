export function approvalDetails(input) {
  const { title, context, payload } = input ?? {};
  if (typeof title !== 'string' || !title.trim() || title.length > 160
      || (context !== undefined && typeof context !== 'string')
      || (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload)))) {
    return null;
  }
  return { actionName: title.trim(), contextMarkdown: context, args: payload ?? {} };
}

export class HitlyRequestError extends Error {
  constructor(status) {
    super(`HITLy returned HTTP ${status}`);
    this.status = status;
  }
}

export function createHitlyClient({
  url = process.env.HITLY_URL ?? 'http://hotl:3001',
  projectId = process.env.HITLY_PROJECT_ID,
  apiKey = process.env.HITLY_API_KEY,
  temporalAddress = process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
} = {}) {
  const endpoint = new URL('/api/v1/approvals', url);
  const configured = Boolean(projectId && apiKey);

  async function request({ workflowId, namespace, idempotencyKey }, details, cancellation) {
    if (!configured) throw new Error('Configure the HITLy project and API key');
    const timeout = AbortSignal.timeout(8000);
    const approval = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: cancellation ? AbortSignal.any([timeout, cancellation]) : timeout,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        plugin: 'temporal',
        projectId,
        workflowId,
        address: temporalAddress,
        namespace,
        ...details,
      }),
    });
    if (!approval.ok) {
      await approval.body?.cancel();
      throw new HitlyRequestError(approval.status);
    }
    const result = await approval.json();
    if (typeof result?.id !== 'string' || !result.id) {
      throw new Error('HITLy response did not contain an approval ID');
    }
    return { approvalId: result.id };
  }

  return { configured, request };
}
