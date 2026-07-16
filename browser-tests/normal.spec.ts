import { expect, test } from '@playwright/test';
import { expectNoViewportOverflow, focusByKeyboard, openNormal, reachNormalSummary } from './helpers.ts';

test.describe('normal browser verification', () => {
  test('keeps memo and corrective-action nodes, focus, caret, scroll, and drafts stable while typing', async ({ page }) => {
    await openNormal(page, { width: 900, height: 650 });
    await page.getByRole('button', { name: /TBM 시작/ }).click();
    await page.getByRole('button', { name: /계속/ }).click();

    const memo = page.locator('#memo');
    const memoNode = await memo.elementHandle();
    await memo.fill('');
    await memo.pressSequentially('긴 한국어 메모 입력', { delay: 15 });
    await expect(memo).toBeFocused();
    expect(await memo.evaluate((element, original) => element === original, memoNode)).toBe(true);
    await expect(memo).toHaveValue('긴 한국어 메모 입력');

    await page.getByRole('button', { name: /조치 필요/ }).click();
    const control = page.locator('[data-corrective-field="immediateControl"]');
    const originalControl = await control.elementHandle();
    await control.focus();
    await control.scrollIntoViewIfNeeded();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const syncResponse = page.waitForResponse((response) => response.url().includes('/api/sessions') && response.request().method() === 'POST');
    await control.pressSequentially('통제선 설치 및 출입 제한', { delay: 20 });
    await syncResponse;

    expect(await control.evaluate((element, original) => element === original, originalControl)).toBe(true);
    await expect(control).toBeFocused();
    await expect(control).toHaveValue('통제선 설치 및 출입 제한');
    expect(await control.evaluate((element) => element.selectionStart)).toBe('통제선 설치 및 출입 제한'.length);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await expect.poll(() => page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('safety-lens-offline-v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const drafts = await new Promise<any[]>((resolve, reject) => {
        const request = database.transaction('drafts').objectStore('drafts').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return drafts[0]?.responses?.[0]?.correctiveAction?.immediateControl ?? '';
    })).toBe('통제선 설치 및 출입 제한');

    await control.evaluate((element) => {
      element.focus();
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      element.value = '안';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '안', inputType: 'insertCompositionText', isComposing: true }));
      element.value = '안전조치';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '전조치', inputType: 'insertCompositionText', isComposing: true }));
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '안전조치' }));
    });
    expect(await control.evaluate((element, original) => element === original, originalControl)).toBe(true);
    await expect(control).toHaveValue('안전조치');
    await expect(control).toBeFocused();
    await expect.poll(() => page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('safety-lens-offline-v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const drafts = await new Promise<any[]>((resolve, reject) => {
        const request = database.transaction('drafts').objectStore('drafts').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return drafts[0]?.responses?.[0]?.correctiveAction?.immediateControl ?? '';
    })).toBe('안전조치');

    await page.locator('[data-corrective-field="verificationStatus"]').selectOption('verified');
    await expect(page.locator('[data-corrective-field="verifiedBy"]')).toBeVisible();
    expect(await originalControl?.evaluate((element) => element.isConnected)).toBe(false);
  });

  test('keeps sharing text fields stable through synchronization and rerenders only structural choices', async ({ page }) => {
    await openNormal(page);
    await reachNormalSummary(page);
    const status = page.locator('[data-sharing-field="status"]');
    const oldStatus = await status.elementHandle();
    await status.selectOption('shared');
    await expect(page.locator('[data-sharing-field="method"]')).toBeVisible();
    expect(await oldStatus?.evaluate((element) => element.isConnected)).toBe(false);

    const method = page.locator('[data-sharing-field="method"]');
    const acknowledgment = page.locator('[data-sharing-field="acknowledgmentResults"]');
    const methodNode = await method.elementHandle();
    const syncResponse = page.waitForResponse((response) => response.url().includes('/api/sessions') && response.request().method() === 'POST');
    await method.pressSequentially('현장 대면 브리핑', { delay: 15 });
    await syncResponse;
    expect(await method.evaluate((element, original) => element === original, methodNode)).toBe(true);
    await expect(method).toBeFocused();
    const acknowledgmentNode = await acknowledgment.elementHandle();
    await acknowledgment.pressSequentially('질문 두 건 확인 후 답변 완료', { delay: 15 });
    expect(await acknowledgment.evaluate((element, original) => element === original, acknowledgmentNode)).toBe(true);
    await expect(acknowledgment).toBeFocused();
  });

  test('keeps authentication, worker-name, and manual-entry controls stable during native text entry', async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:4173', locale: 'ko-KR', storageState: { cookies: [], origins: [] }
    });
    const page = await context.newPage();
    await page.goto('/');
    const email = page.locator('input[name="email"]');
    const emailNode = await email.elementHandle();
    await email.pressSequentially('ime@example.test', { delay: 10 });
    expect(await email.evaluate((element, original) => element === original, emailNode)).toBe(true);
    await context.close();

    const authContext = await browser.newContext({
      baseURL: 'http://127.0.0.1:4173', locale: 'ko-KR', storageState: '.cache/browser-tests/auth.json'
    });
    const authPage = await authContext.newPage();
    await openNormal(authPage);
    await authPage.getByRole('button', { name: /TBM 시작/ }).click();
    const worker = authPage.locator('#worker-name');
    const workerNode = await worker.elementHandle();
    await worker.pressSequentially('김안전');
    expect(await worker.evaluate((element, original) => element === original, workerNode)).toBe(true);
    await authPage.getByRole('button', { name: /계속/ }).click();
    await authPage.getByRole('button', { name: /새 유해위험요인 기록/ }).click();
    const title = authPage.locator('input[name="title"]');
    const description = authPage.locator('textarea[name="description"]');
    const titleNode = await title.elementHandle();
    const descriptionNode = await description.elementHandle();
    await title.pressSequentially('수기 유해위험요인');
    await description.pressSequentially('긴 설명을 입력해도 화면이 다시 그려지지 않습니다.');
    expect(await title.evaluate((element, original) => element === original, titleNode)).toBe(true);
    expect(await description.evaluate((element, original) => element === original, descriptionNode)).toBe(true);
    await authContext.close();
  });

  test('uploads private evidence before generating a visibly simulated mock suggestion', async ({ page }) => {
    const requests: Array<{ url: string; method: string; body: string | null }> = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && ['/api/uploads', '/api/ai/analyze-hazard'].some((path) => request.url().includes(path))) {
        requests.push({ url: request.url(), method: request.method(), body: request.postData() });
      }
    });
    await openNormal(page);
    await page.getByRole('button', { name: /TBM 시작/ }).click();
    await page.getByRole('button', { name: /계속/ }).click();
    await page.getByRole('button', { name: /새 유해위험요인 기록/ }).click();
    await page.locator('input[name="evidencePhotos"]').setInputFiles({
      name: 'deterministic-evidence.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=', 'base64')
    });
    const generate = page.getByRole('button', { name: '모의 제안 생성' });
    await expect(generate).toBeVisible();
    await generate.click();

    await expect(page.getByRole('region', { name: '시뮬레이션된 모의 제안' })).toBeVisible();
    await expect(page.getByText('고정 모의 데이터이며 이미지 픽셀을 해석하지 않았습니다.')).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toContain('/api/uploads');
    expect(requests[1].url).toContain('/api/ai/analyze-hazard');
    const analysisBody = JSON.parse(requests[1].body ?? '{}');
    expect(typeof analysisBody.uploadId).toBe('string');
    expect(analysisBody.photos).toBeUndefined();
    expect(analysisBody.imageUrl).toBeUndefined();

    await page.getByRole('button', { name: '제안 수정 후 사용' }).click();
    await page.locator('input[name="title"]').fill('사람이 수정한 유해위험요인');
    await page.locator('input[name="location"]').fill('테스트 구역');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'TBM 점검표' })).toBeVisible();
  });

  test('defaults to Korean and switches the active document language to English', async ({ page }) => {
    await openNormal(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('TBM 시작');
    const language = page.getByRole('combobox', { name: '언어' });
    await language.selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Start TBM');
    await expect(page.getByRole('combobox', { name: 'Language' })).toBeFocused();
  });

  test('reflows at narrow and high-zoom-equivalent viewports without losing long Korean labels', async ({ page }) => {
    await openNormal(page, { width: 390, height: 844 });
    await expect(page.getByRole('button', { name: /TBM 시작/ })).toBeVisible();
    await expectNoViewportOverflow(page);
    await page.setViewportSize({ width: 320, height: 568 });
    await expect(page.getByText(/작업 전 안전회의를 시작해/)).toBeVisible();
    await expectNoViewportOverflow(page);
    const startButtonSize = await page.getByRole('button', { name: /TBM 시작/ }).evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize)
    }));
    expect(startButtonSize.height).toBeGreaterThanOrEqual(44);
    expect(startButtonSize.fontSize).toBeGreaterThanOrEqual(13);

    await page.getByRole('button', { name: /TBM 시작/ }).click();
    await page.getByRole('button', { name: /계속/ }).click();
    await page.getByRole('button', { name: /조치 필요/ }).click();
    await page.locator('[data-corrective-field="immediateControl"]').fill('매우 긴 한국어 즉시 통제 조치를 기록하여 좁은 화면에서도 카드 바깥으로 넘치지 않는지 확인합니다.');
    await expectNoViewportOverflow(page);
    const layout = await page.evaluate(() => {
      const card = document.querySelector('.v2-corrective-card')!.getBoundingClientRect();
      const controls = Array.from(document.querySelectorAll('.v2-corrective-card input, .v2-corrective-card select'))
        .map((element) => element.getBoundingClientRect());
      const memo = document.querySelector('#memo')!;
      const memoStyle = getComputedStyle(memo);
      return {
        controlsInside: controls.every((control) => control.left >= card.left - 1 && control.right <= card.right + 1),
        memoMinHeight: Number.parseFloat(memoStyle.minHeight),
        memoResize: memoStyle.resize,
        bodyOverflowX: getComputedStyle(document.body).overflowX
      };
    });
    expect(layout.controlsInside).toBe(true);
    expect(layout.memoMinHeight).toBeGreaterThanOrEqual(96);
    expect(layout.memoResize).toBe('vertical');
    expect(layout.bodyOverflowX).toBe('hidden');
  });

  test('supports keyboard progress, visible focus, headings, names, blockers, and live sync messages', async ({ page, context }) => {
    await openNormal(page);
    const start = page.getByRole('button', { name: /TBM 시작/ });
    await start.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: '근로자 참여' })).toBeVisible();
    await page.getByRole('button', { name: /계속/ }).press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'TBM 점검표' })).toBeVisible();
    const controlled = page.getByRole('button', { name: /통제됨/ });
    await focusByKeyboard(page, '[data-action="controlled"]');
    const focusStyle = await controlled.evaluate((element) => {
      const style = getComputedStyle(element);
      return Number.parseFloat(style.outlineWidth);
    });
    expect(focusStyle).toBeGreaterThanOrEqual(3);
    for (let index = 0; index < 4; index += 1) {
      await page.getByRole('button', { name: /통제됨/ }).click();
    }
    await expect(page.getByRole('heading', { level: 2, name: 'TBM 초안 — 최종 확정 차단됨' })).toBeVisible();
    await expect(page.getByText(/근로자 공유 여부/)).toBeVisible();
    await expect(page.locator('[role="main"] h1')).toHaveCount(1);

    await context.setOffline(true);
    await page.getByRole('button', { name: '초안 기록' }).click();
    await expect(page.locator('.draft-status span')).toHaveText('동기화 대기 중');
    const live = page.locator('[role="status"][aria-live="polite"]');
    await expect(live).toContainText(/동기화 대기 중|초안/);
  });

  test('shows deterministic conflict messaging and honors reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openNormal(page);
    await reachNormalSummary(page);
    await page.route('**/api/sessions', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
          error: 'Conflict requires review.', conflict: { serverRevision: 25 }
        }) });
      } else await route.continue();
    });
    await page.getByRole('button', { name: '초안 기록' }).click();
    await expect(page.getByText(/충돌 검토 필요/).first()).toBeVisible();
    await expect(page.locator('[role="alert"]')).toContainText('충돌 검토 필요');
    const duration = await page.locator('.v2-key-button').first().evaluate((element) => {
      const value = getComputedStyle(element).transitionDuration;
      return value ? Number.parseFloat(value) : 0;
    });
    expect(duration).toBeLessThanOrEqual(0.001);
  });

  test('keeps phone evidence selection local until explicit private-upload confirmation', async ({ page }) => {
    const pending = { id: 'request-browser-1', sessionId: 'session-1', hazardId: 'hazard-1', status: 'pending',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
      hazard: { title: 'Open edge', location: 'Level 3' }, tbm: { siteName: 'Pilot Site', taskName: 'Cable work', siteArea: 'A' } };
    let uploads = 0;
    await page.route('**/api/evidence-requests?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ requests: [pending] }) }));
    await page.route('**/api/uploads', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      uploads += 1;
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify([{ id: 'upload-1', uploadId: 'upload-1' }]) });
    });
    await page.route('**/api/evidence-requests/request-browser-1/complete', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...pending, status: 'completed' }) }));
    await openNormal(page);
    const camera = page.locator('[data-evidence-camera="request-browser-1"]');
    const gallery = page.locator('[data-evidence-gallery="request-browser-1"]');
    await expect(camera).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    await expect(camera).toHaveAttribute('capture', 'environment');
    await expect(gallery).not.toHaveAttribute('capture', /.+/);
    await camera.setInputFiles({ name: 'capture.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
    expect(uploads).toBe(0);
    await expect(page.getByAltText('Local evidence preview')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm private upload' })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm private upload' }).click();
    await expect.poll(() => uploads).toBe(1);
  });
});
