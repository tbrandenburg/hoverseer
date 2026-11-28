import type { Handle } from '@sveltejs/kit/hooks';
import { handle as upstreamHandle } from './hooks.upstream.server';

function denied(status: number, message: string): Response {
  return Response.json({ message }, { status, headers: { 'cache-control': 'no-store' } });
}

// Wrap the upstream locale hook without modifying its editor or API routes.
// The instance's namespace is fixed by Compose, never by the browser.
export const handle: Handle = async ({ event, resolve }) => {
  const namespace = process.env.HOVERSEER_STUDIO_NAMESPACE;
  if (!namespace) return upstreamHandle({ event, resolve }); // legacy local deployment
  const origin = process.env.ORIGIN;
  if (!origin) return denied(503, 'Studio origin is not configured');
  const method = event.request.method;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && event.request.headers.get('origin') !== origin) {
    return denied(403, 'A same-origin Studio request is required');
  }
  const cookie = (event.request.headers.get('cookie') ?? '').split(';').map(part => part.trim())
    .filter(part => /^(?:__Secure-)?better-auth\.session_token=/.test(part)).join('; ');
  if (!cookie) return denied(401, 'Sign in to HITLy and reopen Studio from Hoverseer Workflows');
  try {
    const endpoint = new URL('/v1/studio-access/' + encodeURIComponent(namespace),
      process.env.HOVERSEER_AUTH_URL ?? 'http://api:8081');
    const response = await fetch(endpoint, {
      headers: { cookie },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) return denied(401, 'Sign in to HITLy and reopen Studio from Hoverseer Workflows');
    if (response.status === 403 || response.status === 404) return denied(403, 'You are not authorized for this Studio workspace');
    if (response.status !== 204) return denied(503, 'Workspace authorization is unavailable');
  } catch {
    return denied(503, 'Workspace authorization is unavailable');
  }
  const response = await upstreamHandle({ event, resolve });
  // Workflow data and server-rendered pages must not be cached across sessions.
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
