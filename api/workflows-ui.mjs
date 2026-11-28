import { readFileSync } from 'node:fs';

const loadAsset = name => readFileSync(new URL(`./workflows-ui/${name}`, import.meta.url), 'utf8');
const html = loadAsset('index.html');
const assets = [
  ['app.mjs', 'text/javascript; charset=utf-8'],
  ['style.css', 'text/css; charset=utf-8'],
];

function browserUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Workflow UI links must be HTTP(S) URLs without credentials');
  }
  return url.href;
}

function attribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

export function installWorkflowsUi(app, {
  hitlyUrl = 'http://localhost:3001',
  studioUrl = 'http://localhost:3000',
  temporalUrl = 'http://localhost:8233',
  namespace = 'default',
} = {}) {
  const page = html
    .replace('data-hitly=""', () => `data-hitly="${attribute(browserUrl(hitlyUrl))}"`)
    .replace('data-studio=""', () => `data-studio="${attribute(browserUrl(studioUrl))}"`)
    .replace('data-temporal=""', () => `data-temporal="${attribute(browserUrl(temporalUrl))}"`)
    .replace('data-namespace=""', () => `data-namespace="${attribute(namespace)}"`);

  const options = { schema: { hide: true } };
  app.get('/workflows', options, (_request, reply) => reply
    .header('Content-Security-Policy', "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .type('text/html; charset=utf-8')
    .send(page));

  for (const [name, type] of assets) {
    const source = loadAsset(name);
    app.get(`/workflows/${name}`, options, (_request, reply) => reply.type(type).send(source));
  }
}
