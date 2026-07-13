import { mkdir } from 'node:fs/promises';
import { request } from '@playwright/test';

export default async function globalSetup() {
  await mkdir('.cache/browser-tests', { recursive: true });
  await mkdir('test-artifacts/browser/screenshots', { recursive: true });
  const context = await request.newContext({ baseURL: 'http://127.0.0.1:4173' });
  let response;
  for (let attempt = 0; attempt < 50 && !response; attempt += 1) {
    try {
      const candidate = await context.post('/api/auth/register', {
        data: {
          name: '브라우저 테스트 감독자',
          email: 'browser-supervisor@example.test',
          password: 'deterministic-browser-password',
          role: 'supervisor',
          registrationKey: 'browser-registration-key'
        }
      });
      if (candidate.status() === 201) response = candidate;
      else await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!response) throw new Error('Browser test API did not become ready.');
  await context.storageState({ path: '.cache/browser-tests/auth.json' });
  await context.dispose();
}
