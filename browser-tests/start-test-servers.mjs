import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const sandbox = mkdtempSync(path.join(tmpdir(), 'safety-lens-browser-'));
const dataDir = path.join(sandbox, 'data');
const uploadsDir = path.join(sandbox, 'uploads');
mkdirSync(dataDir, { recursive: true });
mkdirSync(uploadsDir, { recursive: true });

const children = [
  spawn(process.execPath, ['server.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '3101',
      DATABASE_PATH: path.join(dataDir, 'browser.sqlite'),
      UPLOADS_DIR: uploadsDir,
      REGISTRATION_KEY: 'browser-registration-key',
      SESSION_SECRET: 'browser-test-session-secret-with-adequate-length',
      AI_MODE: 'mock',
      NODE_ENV: 'test',
      DEV_TUNNEL_MODE: 'false',
      DEV_TUNNEL_ORIGIN: ''
    }
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_API_TARGET: 'http://127.0.0.1:3101', DEV_TUNNEL_MODE: 'false', DEV_TUNNEL_ORIGIN: '' }
  })
];

let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(code);
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (!closing) close(code || (signal ? 1 : 0));
  });
}
process.on('SIGINT', () => close(0));
process.on('SIGTERM', () => close(0));
