import { createHash, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest();
export const bearerAuth = [{ bearerAuth: [] }];
const challenge = { 'WWW-Authenticate': 'Bearer' };
const denied = (status, message) => ({ failure: { status, message } });
const unauthorized = () => denied(401, 'A valid HITLy session or bearer token is required');
const unavailable = () => denied(503, 'The identity service is unavailable');
const service = Object.freeze({ kind: 'service', id: 'legacy-service', name: 'Service account' });

// Cookie scope is the host, not the port. Forward only Better Auth's session
// cookie, never arbitrary browser cookies or client-selected identity headers.
function sessionCookie(header) {
  return typeof header === 'string' ? header.split(';').map(part => part.trim())
    .filter(part => /^(?:__Secure-)?better-auth\.session_token=/.test(part)).join('; ') : '';
}

export function accessCheck(token, { sessionUrl, origin, fetchImpl = fetch } = {}) {
  const expected = token ? digest(token) : undefined;
  const endpoint = sessionUrl ? new URL('/api/auth/get-session?disableCookieCache=true&disableRefresh=true', sessionUrl) : undefined;
  if (endpoint && (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)) {
    throw new Error('HITLY_URL must be an HTTP(S) URL without credentials');
  }

  return async (headers, { allowCookie = false, method = 'GET' } = {}) => {
    const authorization = headers.authorization;
    const supplied = typeof authorization === 'string' ? authorization.match(/^Bearer (.+)$/i)?.[1] : undefined;
    if (expected && supplied && timingSafeEqual(digest(supplied), expected)) {
      return { principal: service };
    }
    const cookie = authorization === undefined && allowCookie ? sessionCookie(headers.cookie) : '';
    if (!supplied && !cookie) return expected || endpoint ? unauthorized() : unavailable();
    if (!endpoint) return unauthorized();

    // Ambient browser credentials must never authorize cross-origin writes,
    // including requests originating from a different port on the same host.
    if (cookie && !['GET', 'HEAD', 'OPTIONS'].includes(method) && headers.origin !== origin) {
      return denied(403, 'A same-origin browser request is required');
    }

    try {
      const response = await fetchImpl(endpoint, {
        headers: supplied ? { authorization: 'Bearer ' + supplied } : { cookie },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if ([401, 403].includes(response.status)) return unauthorized();
      if (!response.ok) return unavailable();
      const session = await response.json();
      const user = session?.user;
      if (!user || typeof user.id !== 'string' || !user.id || session?.session?.userId !== user.id) {
        return unauthorized();
      }
      return { principal: { kind: 'user', id: user.id, name: typeof user.name === 'string' ? user.name : user.id } };
    } catch {
      return unavailable();
    }
  };
}

export function fastifyAuth(check, { allowCookie = false } = {}) {
  return async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { principal, failure } = await check(request.headers, { allowCookie, method: request.method });
    if (!failure) {
      request.principal = principal;
      return;
    }
    if (failure.status === 401) reply.headers(challenge);
    return reply.code(failure.status).send({ message: failure.message });
  };
}
