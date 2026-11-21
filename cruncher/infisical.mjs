import { InfisicalSDK } from '@infisical/sdk';

const required = [
  'INFISICAL_SITE_URL',
  'INFISICAL_PROJECT_ID',
  'INFISICAL_CLIENT_ID',
  'INFISICAL_CLIENT_SECRET',
];

export async function loadHitlyCredentials(env = process.env) {
  if (!required.some(key => env[key]?.trim())) return {};

  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) {
    throw new Error(`Incomplete Infisical configuration for Cruncher. Missing ${missing.join(', ')}.`);
  }
  const url = URL.parse(env.INFISICAL_SITE_URL);
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('INFISICAL_SITE_URL must be an HTTP(S) URL without credentials.');
  }
  const scope = {
    projectId: env.INFISICAL_PROJECT_ID,
    environment: env.INFISICAL_ENVIRONMENT || 'prod',
    secretPath: env.INFISICAL_SECRET_PATH || '/cruncher',
  };
  const sdk = new InfisicalSDK({ siteUrl: url.href });
  try {
    await sdk.auth().universalAuth.login({
      clientId: env.INFISICAL_CLIENT_ID,
      clientSecret: env.INFISICAL_CLIENT_SECRET,
    });
  } catch {
    throw new Error('Cruncher could not authenticate to Infisical.');
  }

  async function secret(secretName) {
    let response;
    try {
      response = await sdk.secrets().getSecret({ ...scope, secretName, expandSecretReferences: false });
    } catch {
      throw new Error(`Cruncher could not read ${secretName} from Infisical.`);
    }
    if (typeof response?.secretValue !== 'string' || !response.secretValue.trim()) {
      throw new Error(`Infisical secret ${secretName} is empty.`);
    }
    return response.secretValue;
  }

  const [projectId, apiKey] = await Promise.all([secret('HITLY_PROJECT_ID'), secret('HITLY_API_KEY')]);
  return { projectId, apiKey };
}
