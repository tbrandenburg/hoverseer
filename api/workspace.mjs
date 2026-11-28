import { sessionCookie } from './auth.mjs';

export const workspaceHeader = 'x-hitly-workspace-id';
const denied = (status, message) => ({ failure: { status, message } });
const forbidden = () => denied(403, 'You are not a member of the requested workspace');
const unavailable = () => denied(503, 'The workspace service is unavailable');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);

function selectedWorkspace(headers) {
  if (headers[workspaceHeader] !== undefined) return headers[workspaceHeader];
  // Browser workspace selection already belongs to HITLy. Treat its cookie
  // as a requested ID, not as evidence of membership.
  if (headers.authorization === undefined && typeof headers.cookie === 'string') {
    const pair = headers.cookie.split(';').map(part => part.trim())
      .find(part => part.startsWith('hitly-workspace-id='));
    if (pair) return pair.slice('hitly-workspace-id='.length);
  }
}

// A second live lookup is deliberately small: no duplicate membership store,
// no cached grants, no database access and no HITLy fork.
export function withWorkspace(check, { sessionUrl, hitlyOrigin = 'http://localhost:3001', fetchImpl = fetch } = {}) {
  const endpoint = sessionUrl ? new URL('/api/v1/workspace', sessionUrl) : undefined;
  const origin = new URL(hitlyOrigin).origin;
  return async (headers, options) => {
    const result = await check(headers, options);
    if (result.failure) return result;
    const requested = selectedWorkspace(headers);
    if (result.principal.kind === 'service') {
      // The old administrative automation token has no workspace membership.
      return requested === undefined ? result : forbidden();
    }
    if (!endpoint) return unavailable();
    if (requested !== undefined && !validId(requested)) return forbidden();
    try {
      const credentials = headers.authorization !== undefined
        ? { authorization: headers.authorization } : { cookie: sessionCookie(headers.cookie) };
      const response = await fetchImpl(endpoint, {
        headers: { origin, ...credentials, ...(requested !== undefined && { [workspaceHeader]: requested }) },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 401) return denied(401, 'A valid HITLy session is required');
      if ([403, 404].includes(response.status)) return forbidden();
      if (!response.ok) return unavailable();
      const workspace = await response.json();
      if (!validId(workspace?.id) || typeof workspace.name !== 'string'
          || !['owner', 'admin', 'member'].includes(workspace.role)) return unavailable();
      // HITLy deliberately falls back to another membership on unknown IDs.
      // Never silently accept a fallback for an explicitly selected workspace.
      if (requested !== undefined && workspace.id !== requested) return forbidden();
      return { principal: { ...result.principal, workspace: { id: workspace.id, name: workspace.name, role: workspace.role } } };
    } catch {
      return unavailable();
    }
  };
}
