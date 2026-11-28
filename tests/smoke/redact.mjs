import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const files = ['.env', ...['a', 'b', 'team'].map(suffix => 'cruncher/.env.infisical-' + suffix)];
const values = (await Promise.all(files.map(async file => Object.values(parseEnv(await readFile(file, 'utf8').catch(() => ''))))))
  .flat().filter(value => value.length >= 8).sort((a, b) => b.length - a.length);
let log = await readFile(process.argv[2], 'utf8');
for (const value of values) log = log.replaceAll(value, '[redacted]');
log = log.replace(/hitly_[A-Za-z0-9_-]+/g, '[redacted key]')
  .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]')
  .replace(/(?:https?:\/\/\S*?(?:token|verify|invite|reset)\S*)/gi, '[redacted URL]');
await writeFile(process.argv[3], log);
