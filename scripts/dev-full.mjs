import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

if (!existsSync('.env.local')) copyFileSync('.env.local.example', '.env.local');
process.loadEnvFile('.env.local');
const packageManager = process.env.npm_execpath;
if (!packageManager) throw new Error('Run this script with pnpm dev:full.');
const scriptPackageManager = /\.[cm]?js$/.test(packageManager);
const command = scriptPackageManager ? process.execPath : packageManager;
async function run(args) {
  const child = spawn(command, scriptPackageManager ? [packageManager, ...args] : args, {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0) process.exit(typeof code === 'number' ? code : 1);
}
const containers =
  spawnSync('docker', ['ps', '--format', '{{.Names}} {{.Ports}}'], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout ?? '';
const mailpitRunning = containers
  .split('\n')
  .some((line) => line.startsWith('meeting-hub-mailpit-1 ') && line.includes('->'));
const dockerPorts = new Set(
  [
    ...containers
      .split('\n')
      .filter((line) => !line.startsWith('meeting-hub-mailpit-1 '))
      .join(' ')
      .matchAll(/:(\d+)->/g),
  ].map((match) => Number(match[1])),
);
async function freePort(start) {
  for (let port = start; port < start + 100; port++) {
    if (dockerPorts.has(port)) continue;
    const available = await new Promise((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('No free local Mailpit port found.');
}
if (['localhost', '127.0.0.1'].includes(process.env.SMTP_HOST) && !mailpitRunning) {
  const smtp = await freePort(
    Number(process.env.MAILPIT_SMTP_PORT ?? process.env.SMTP_PORT ?? 1025),
  );
  const ui = await freePort(Number(process.env.MAILPIT_UI_PORT ?? 8025));
  const values = {
    SMTP_PORT: String(smtp),
    MAILPIT_SMTP_PORT: String(smtp),
    MAILPIT_UI_PORT: String(ui),
    MAILPIT_URL: `http://127.0.0.1:${ui}`,
  };
  let local = readFileSync('.env.local', 'utf8');
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    local = pattern.test(local)
      ? local.replace(pattern, `${key}=${value}`)
      : local + `\n${key}=${value}\n`;
  }
  writeFileSync('.env.local', local);
}
process.stdout.write(`Local Mailpit: ${process.env.MAILPIT_URL ?? 'http://localhost:8025'}\n`);
await run(['infra:up']);
await run([
  'exec',
  'docker',
  'compose',
  '-f',
  'infra/docker-compose.yml',
  '--profile',
  'rooms',
  'up',
  '-d',
  '--wait',
  'livekit-server',
  'livekit-egress',
]);
await run(['db:migrate']);
await run(['db:seed']);
await run(['exec', 'turbo', 'run', 'dev', '--env-mode=loose']);
