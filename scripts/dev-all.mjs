import { spawn } from 'node:child_process';

const commands = [
  { name: 'server', command: 'npm', args: ['run', 'server'] },
  { name: 'dev', command: 'npm', args: ['run', 'dev'] }
];

const children = commands.map(({ name, command, args }) => {
  const child = spawn(command, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: process.platform === 'win32'
  });

  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${name}] exited with ${signal ?? code}`);
    shutdown(code || 1);
  });

  return child;
});

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  children.forEach((child) => {
    if (!child.killed) child.kill('SIGTERM');
  });
  windowlessExit(code);
}

function windowlessExit(code) {
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
