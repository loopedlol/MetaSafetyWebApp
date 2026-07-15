import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean)
  .filter((file) => !file.startsWith('test-artifacts/') && !file.startsWith('dist/'));
const signatures = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bsk-[A-Za-z0-9]{32,}\b/
];
const findings = [];

for (const file of files) {
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  contents.split(/\r?\n/).forEach((line, index) => {
    if (signatures.some((signature) => signature.test(line))) findings.push(`${file}:${index + 1}`);
  });
}

if (findings.length) {
  console.error(`Potential high-confidence secrets found at ${findings.join(', ')}. Values are intentionally not printed.`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed (${files.length} non-ignored files, high-confidence signatures).`);
}
