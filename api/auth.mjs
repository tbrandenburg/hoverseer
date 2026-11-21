import { createHash, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest();
export const bearerAuth = [{ bearerAuth: [] }];
const challenge = { 'WWW-Authenticate': 'Bearer' };

export function accessCheck(token) {
  const expected = token ? digest(token) : undefined;
  return header => {
    if (!expected) return { status: 503, message: 'The workflow API token is not configured' };
    const supplied = header?.match(/^Bearer (.+)$/i)?.[1];
    if (!timingSafeEqual(digest(supplied ?? ''), expected)) {
      return { status: 401, message: 'A valid bearer token is required' };
    }
  };
}

export function fastifyAuth(check) {
  return async (request, reply) => {
    const failure = check(request.headers.authorization);
    if (!failure) return;
    if (failure.status === 401) reply.headers(challenge);
    return reply.code(failure.status).send({ message: failure.message });
  };
}
