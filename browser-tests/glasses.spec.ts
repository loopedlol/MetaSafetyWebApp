import { expect, test } from '@playwright/test';
import { beginGlassesReview, captureGlassesScreenshot, controlAllGlassesHazards, expectNoViewportOverflow, openGlasses } from './helpers.ts';

test.describe('600×600 structured glasses preview', () => {
  test.afterEach(async ({ page }) => expectNoViewportOverflow(page));

  test('uses one start action, truthful context, and count-only attendance', async ({ page }) => {
    await openGlasses(page);
    await expect(page.locator('[data-device-diagnostics]')).toHaveCount(0);
    await captureGlassesScreenshot(page, 'glasses-start-polished');
    await expect(page.locator('.glasses-actions button')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '취소' })).toHaveCount(0);
    const startLayout = await page.evaluate(() => {
      const action = document.querySelector('.glasses-actions button')!.getBoundingClientRect();
      const status = document.querySelector('.glasses-sync')!.getBoundingClientRect();
      const help = document.querySelector('.glasses-help-button')!.getBoundingClientRect();
      return { actionWidth: action.width, footerDelta: Math.abs(status.y - help.y), placeholders: document.querySelectorAll('.glasses-actions:empty').length };
    });
    expect(startLayout.actionWidth).toBeGreaterThanOrEqual(350);
    expect(startLayout.footerDelta).toBeLessThanOrEqual(2);
    expect(startLayout.placeholders).toBe(0);
    await page.getByRole('button', { name: '시작', exact: true }).click();
    await expect(page.locator('.is-context_confirmation')).toContainText(/세션 현장|세션 좌표/);
    await expect(page.locator('.is-context_confirmation')).toContainText('기기 시간');
    await captureGlassesScreenshot(page, 'glasses-context-polished');
    await page.getByRole('button', { name: '거부' }).click();
    await expect(page.locator('.is-start')).toBeVisible();
    await page.getByRole('button', { name: '시작', exact: true }).click();
    await page.getByRole('button', { name: '확인', exact: true }).click();
    await page.locator('[data-attendance-digit="expectedOnes"]').selectOption('2');
    await page.locator('[data-attendance-digit="presentOnes"]').selectOption('3');
    await expect(page.getByRole('button', { name: '계속' })).toBeDisabled();
    await page.locator('[data-attendance-digit="presentOnes"]').selectOption('2');
    await expect(page.getByRole('button', { name: '계속' })).toBeEnabled();
    await page.locator('[data-attendance-digit="expectedTens"]').selectOption('9');
    await page.locator('[data-attendance-digit="expectedOnes"]').selectOption('9');
    await page.locator('[data-attendance-digit="presentTens"]').selectOption('9');
    await page.locator('[data-attendance-digit="presentOnes"]').selectOption('9');
    await captureGlassesScreenshot(page, 'glasses-attendance-polished');
  });

  test('routes Controlled and Not Controlled through evidence and confirmation', async ({ page }) => {
    await openGlasses(page); await beginGlassesReview(page);
    await captureGlassesScreenshot(page, 'glasses-hazard-decision-polished');
    await expect(page.getByRole('button', { name: '통제되지 않음' })).toBeVisible();
    await page.locator('[data-glasses-action="controlled"]').click();
    await expect(page.locator('.is-photo_evidence')).toBeVisible();
    await expect(page.getByRole('button', { name: '사진 촬영' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '사진 업로드' })).toBeDisabled();
    await page.locator('[data-glasses-action="mock-photo"]').click();
    await expect(page.locator('.is-photo_evidence')).toContainText('Browser preview mock');
    await captureGlassesScreenshot(page, 'glasses-evidence-polished');
    await page.locator('[data-glasses-action="evidence-continue"]').click();
    await captureGlassesScreenshot(page, 'glasses-confirmation-polished');
    await page.locator('[data-glasses-action="hazard-confirm"]').click();
    await page.locator('[data-glasses-action="action-required"]').click();
    await expect(page.locator('.is-corrective_action input[type="text"]')).toHaveCount(0);
    await expect(page.locator('.is-corrective_action select')).toHaveCount(5);
    await captureGlassesScreenshot(page, 'glasses-corrective-polished');
  });

  test('uses documented D-pad events and exposes no fake capture in the Meta Display adapter', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 600 });
    let exchangeRequests = 0;
    const createdProviders: string[] = [];
    await page.route('**/api/glasses/pair', async (route) => {
      exchangeRequests += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scope: {
        type: 'site', siteId: 'site-browser-test', sessionId: null, siteName: 'Pilot Site', siteArea: 'Area A', taskName: null,
        expiresAt: new Date(Date.now() + 900_000).toISOString()
      } }) });
    });
    await page.route('**/api/glasses/native-device-availability', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"available":true}' }));
    const handoff = { id: 'request-meta-1', sessionId: 'session-meta-1', hazardId: 'hazard-meta-1', status: 'pending', provider: 'native_dat_camera',
      expiresAt: new Date(Date.now() + 600_000).toISOString(), hazard: { title: 'Phone evidence hazard', location: 'Area A' },
      tbm: { siteName: 'Pilot Site', taskName: 'Task', siteArea: 'Area A' } };
    await page.route('**/api/glasses/evidence-requests/request-meta-1/attach', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...handoff, status: 'completed', attachedAt: new Date().toISOString(), evidence: { uploadId: 'upload-meta-1', mimeType: 'image/png', size: 68, source: 'browser_file_picker', url: '/api/uploads/upload-meta-1' } }) }));
    await page.route('**/api/glasses/evidence-requests/request-meta-1/ready', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...handoff, provider: 'native_dat_camera', nativeReadyAt: new Date().toISOString() }) }));
    await page.route('**/api/glasses/evidence-requests/request-meta-1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...handoff, status: 'completed', evidence: { uploadId: 'upload-meta-1', mimeType: 'image/png', size: 68, source: 'browser_file_picker', url: '/api/uploads/upload-meta-1' } }) }));
    await page.route('**/api/glasses/evidence-requests', (route) => {
      createdProviders.push(JSON.parse(route.request().postData() ?? '{}').provider);
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(handoff) });
    });
    await page.goto('/?mode=glasses&adapter=meta-display&stress');
    await expect(page.locator('.glasses-screen')).toBeVisible();
    await expect(page.locator('input[type="email"], input[type="password"]')).toHaveCount(0);
    await expect(page.locator('.pairing-screen select')).toHaveCount(0);
    await expect(page.locator('.pairing-screen .glasses-topline')).toHaveCount(0);
    await expect(page.locator('[data-focus-id][aria-current="true"]')).toHaveCount(1);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', 'width=600,height=600,initial-scale=1');
    expect((await page.locator('.pairing-screen button').allTextContents()).join(' ')).not.toMatch(/Focused|FOCUSED|선택됨/);
    const focusContrast = await page.locator('[data-focus-id]').evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element);
      return { current: element.getAttribute('aria-current'), background: style.backgroundColor, borderWidth: style.borderWidth,
        outlineWidth: style.outlineWidth, fontWeight: style.fontWeight };
    }));
    const focusedStyle = focusContrast.find((style) => style.current === 'true')!;
    const unfocusedStyle = focusContrast.find((style) => style.current !== 'true')!;
    expect(focusedStyle.background).not.toBe(unfocusedStyle.background);
    expect(focusedStyle.background).toBe('rgb(217, 45, 39)');
    expect(Number.parseFloat(focusedStyle.borderWidth)).toBeGreaterThanOrEqual(4);
    expect(Number.parseFloat(focusedStyle.outlineWidth)).toBeGreaterThanOrEqual(4);
    expect(Number.parseInt(focusedStyle.fontWeight, 10)).toBeGreaterThanOrEqual(900);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: '언어 선택' })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Choose language' })).toBeVisible();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');

    await page.keyboard.press('Enter');
    await expect(page.locator('[data-pairing-digit]')).toHaveCount(6);
    await expect(page.locator('.pairing-screen input, .pairing-screen select')).toHaveCount(0);
    await expect(page.locator('[data-pairing-digit="0"]')).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.pairing-code-preview')).toHaveText('100 000');

    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await page.keyboard.press('Enter');
    await expect(page.locator('.pairing-code-preview')).toHaveText('100 000');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-pairing-digit="1"]')).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.pairing-code-preview')).toHaveText('190 000');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.pairing-code-preview')).toHaveText('100 000');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.pairing-code-preview')).toHaveText('190 000');
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true })));
    await expect(page.locator('[data-pairing-digit="1"]')).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-pairing-digit="2"]')).toHaveAttribute('aria-current', 'true');
    for (let index = 0; index < 4; index += 1) await page.keyboard.press('Enter');
    await expect(page.locator('.pairing-screen')).toContainText('190 000');
    expect(exchangeRequests).toBe(0);
    await expect(page.locator('[data-focus-id][aria-current="true"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-pairing-digit="5"]')).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    expect(exchangeRequests).toBe(1);
    await expect(page.locator('.is-start')).toContainText('Meta Display Web App');
    await expect(page.locator('.is-start .glasses-topline, .is-start .glasses-sync')).toHaveCount(0);
    await expect(page.locator('.is-start')).toContainText('Pilot Site');
    const startLayout = await page.locator('.is-start').evaluate((screen) => {
      const button = screen.querySelector('[data-glasses-action="start"]')!.getBoundingClientRect();
      const actions = screen.querySelector('.glasses-actions')!.getBoundingClientRect();
      return { buttonWidth: button.width, actionsWidth: actions.width, buttonHeight: button.height };
    });
    expect(startLayout.buttonWidth).toBeGreaterThanOrEqual(startLayout.actionsWidth - 16);
    expect(startLayout.buttonHeight).toBeGreaterThanOrEqual(80);

    await page.keyboard.press('Enter');
    await expect(page.locator('.is-context_confirmation')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.is-attendance select, .is-attendance input')).toHaveCount(0);
    await expect(page.locator('.is-attendance .attendance-digit')).toHaveCount(4);
    await expect(page.locator('.is-attendance [data-glasses-action^="attendance-cycle-"]')).toHaveCount(4);
    await expect(page.locator('[data-focus-id="attendance-digit-expectedTens"]')).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-glasses-action="attendance-cycle-expectedTens"] strong')).toHaveText('9');
    await expect(page.locator('[data-glasses-action="attendance-cycle-expectedOnes"] strong')).toHaveText('4');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[data-glasses-action="attendance-cycle-expectedTens"] strong')).toHaveText('0');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-focus-id="attendance-digit-expectedOnes"]')).toHaveAttribute('aria-current', 'true');
    for (let index = 0; index < 4; index += 1) await page.keyboard.press('Enter');
    await expect(page.locator('.is-hazard_decision')).toBeVisible();

    for (const key of ['1', '2', 'm', 'M', 'p', 'P']) await page.keyboard.press(key);
    await expect(page.locator('.is-hazard_decision')).toBeVisible();
    await expect(page.locator('[data-glasses-action="mock-photo"]')).toHaveCount(0);
    await expect(page.locator('[data-glasses-action="controlled"]')).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Enter');
    await expect(page.locator('.is-photo_evidence')).toBeVisible();
    await expect(page.locator('[data-glasses-action="mock-photo"]')).toHaveCount(0);
    await expect(page.locator('.is-photo_evidence input[type="file"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '사진 촬영' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '사진 없이 계속' })).toBeEnabled();
    await expect(page.locator('.is-photo_evidence')).toContainText('Meta Display Web Apps');
    await expect(page.locator('.is-photo_evidence')).toContainText('사진 없음');
    await expect(page.locator('[data-glasses-action="native-evidence-start"]')).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Enter');
    await expect(page.locator('.is-native_capture_prepare')).toContainText('확인을 누르기 전에는 촬영되지 않습니다');
    expect(createdProviders).toEqual(['native_dat_camera']);
    await page.keyboard.press('Enter');
    await expect(page.locator('.is-evidence_handoff')).toContainText('카메라 대기 중');
    await expect(page.locator('.is-evidence_handoff input[type="file"]')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(page.locator('.is-evidence_handoff')).toContainText('사진 1장 수신됨');
    await expect(page.locator('[data-glasses-action="phone-evidence-attach"]')).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Enter');
    await expect(page.locator('.is-hazard_confirmation')).toBeVisible();
  });

  test('keeps native capture unavailable without a registered device and never calls a browser camera API', async ({ page }) => {
    await page.addInitScript(() => {
      (window as typeof window & { __cameraCalls?: number }).__cameraCalls = 0;
      const mediaDevices = navigator.mediaDevices ?? {} as MediaDevices;
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        ...mediaDevices,
        getUserMedia: () => {
          (window as typeof window & { __cameraCalls?: number }).__cameraCalls! += 1;
          throw new Error('Meta Display must not call getUserMedia');
        }
      } });
    });
    await page.route('**/api/glasses/pair', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scope: {
      type: 'site', siteId: 'site-no-native', sessionId: null, siteName: 'Pilot Site', siteArea: 'Area A', taskName: null,
      expiresAt: new Date(Date.now() + 900_000).toISOString()
    } }) }));
    await page.route('**/api/glasses/native-device-availability', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"available":false}' }));
    await page.setViewportSize({ width: 600, height: 600 });
    await page.goto('/?mode=glasses&adapter=meta-display');
    await page.locator('[data-glasses-action="pairing-enter"]').click();
    for (let index = 0; index < 6; index += 1) await page.keyboard.press('Enter');
    await page.locator('[data-glasses-action="pairing-submit"]').click();
    await page.locator('[data-glasses-action="start"]').click();
    await page.locator('[data-glasses-action="context-confirm"]').click();
    for (let index = 0; index < 4; index += 1) await page.locator('[data-glasses-action="attendance-cycle-presentOnes"]').click();
    await page.locator('[data-glasses-action="attendance-continue"]').click();
    await page.locator('[data-glasses-action="controlled"]').click();
    await expect(page.locator('[data-glasses-action="native-evidence-start"]')).toBeDisabled();
    await expect(page.locator('.is-photo_evidence')).toContainText('등록된 Android DAT 카메라 기기가 없습니다');
    await expect(page.locator('.is-photo_evidence input[type="file"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as typeof window & { __cameraCalls?: number }).__cameraCalls)).toBe(0);
  });

  test('enables local-only diagnostics explicitly and records every documented D-pad key', async ({ page }) => {
    const requests = [];
    const consoleText = [];
    page.on('request', (request) => requests.push({ method: request.method(), url: request.url() }));
    page.on('console', (message) => consoleText.push(message.text()));
    await page.setViewportSize({ width: 600, height: 600 });
    await page.goto('/?mode=glasses&adapter=meta-display&diagnostics=1');
    const diagnostics = page.locator('[data-device-diagnostics]');
    await expect(diagnostics).toBeVisible();
    await expect(page.locator('[data-diagnostic="adapter"]')).toContainText('meta_display_web / meta-display');
    await expect(page.locator('[data-diagnostic="viewport"]')).toHaveText('600×600');

    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape']) {
      await page.evaluate((eventKey) => window.dispatchEvent(new KeyboardEvent('keyup', { key: eventKey })), key);
      await expect(page.locator('[data-diagnostic="latest-key"]')).toHaveText(`${key} · keyup`);
    }
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })));
    await expect(page.locator('[data-diagnostic="latest-key"]')).toHaveText('ArrowUp · keydown');

    for (const key of ['1', '2', 'm', 'M', 'p', 'P']) await page.keyboard.press(key);
    await expect(page.locator('[data-diagnostic="latest-key"]')).toHaveText('ArrowUp · keydown');
    await expect(page.locator('[data-glasses-action], [data-action]')).toHaveCount(0);
    expect(requests.filter((request) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method))).toEqual([]);
    expect(requests.some((request) => request.url.includes('/api/sessions'))).toBe(false);

    await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', {
      message: 'password=hunter2 /Users/private/safety.ts secret.person@example.com',
      error: new Error('token=secret-token /Users/private/safety.ts secret.person@example.com')
    })));
    const rendered = await diagnostics.textContent();
    expect(rendered).not.toMatch(/hunter2|secret-token|secret\.person@example\.com|\/Users\/private/);
    expect(consoleText.join(' ')).not.toMatch(/hunter2|secret-token|secret\.person@example\.com/);

    await expect(page.locator('[data-diagnostic="indexed-db"]')).toContainText('완료');
    const diagnosticDatabaseExists = await page.evaluate(async () =>
      typeof indexedDB.databases === 'function' && (await indexedDB.databases()).some((database) => database.name === 'safety-lens-device-diagnostics-v1'));
    expect(diagnosticDatabaseExists).toBe(false);

    await page.context().setOffline(true);
    await expect(page.locator('[data-diagnostic="network"]')).toContainText('하드웨어 연결 해제를 의미하지 않음');
    await expect(page.locator('[data-device-diagnostics]')).not.toContainText('하드웨어 연결 끊김');
    await page.context().setOffline(false);

    await page.getByRole('button', { name: '진단 종료' }).click();
    await expect(page.locator('[data-device-diagnostics]')).toHaveCount(0);
    await expect(page).not.toHaveURL(/diagnostics=1/);
  });

  test('shows unauthenticated and network-error diagnostic auth states distinctly', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
    await page.goto('/?mode=glasses&adapter=meta-display&diagnostics=1');
    const authStatus = page.locator('[data-diagnostic="authentication"]');
    await expect(authStatus).toContainText('인증되지 않음');

    await page.unroute('**/api/auth/me');
    await page.route('**/api/auth/me', (route) => route.abort('failed'));
    await page.reload();
    await expect(authStatus).toContainText('네트워크 오류');
  });

  test('fails closed for an unknown adapter instead of loading browser preview', async ({ page }) => {
    await page.goto('/?mode=glasses&adapter=unknown');
    await expect(page.getByRole('heading', { name: '알 수 없는 글래스 어댑터' })).toBeVisible();
    await expect(page.locator('.glasses-screen, [data-device-diagnostics]')).toHaveCount(0);
    await page.keyboard.press('1');
    await page.keyboard.press('p');
    await expect(page.getByRole('heading', { name: '알 수 없는 글래스 어댑터' })).toBeVisible();
  });

  test('moves completed sharing to report review, preserves Back state, and submits once', async ({ page }) => {
    await openGlasses(page); await beginGlassesReview(page); await controlAllGlassesHazards(page);
    await expect(page.locator('.glasses-summary-list li')).toHaveCount(4);
    await captureGlassesScreenshot(page, 'glasses-summary-polished');
    await page.locator('[data-glasses-action="summary-continue"]').click();
    const continueButton = page.locator('[data-glasses-action="record-continue"]');
    await expect(continueButton).toBeDisabled();
    const disabledBackground = await continueButton.evaluate((element) => getComputedStyle(element).backgroundColor);
    await captureGlassesScreenshot(page, 'glasses-sharing-incomplete-polished');
    await page.locator('[data-sharing-field="shared"]').check();
    await page.locator('[data-sharing-field="method"]').selectOption('team_meeting');
    await page.locator('[data-sharing-field="proofType"]').selectOption('no_independent_proof');
    await expect(page.locator('[data-glasses-action="record-continue"]')).toBeEnabled();
    const enabledBackground = await continueButton.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(enabledBackground).not.toBe(disabledBackground);
    await captureGlassesScreenshot(page, 'glasses-sharing-ready-polished');
    await page.locator('[data-glasses-action="record-continue"]').click();
    await expect(page.locator('.is-report_review')).toBeVisible();
    await expect(page.locator('.is-report_review')).toContainText('팀 회의');
    await expect(page.locator('.is-report_review')).toContainText('독립 증빙 없음');
    await expect(page.locator('.glasses-report-section > h2')).toHaveText(['TBM 기록', '참석 근로자', '전체 유해위험요인', '근로자 공유 증빙']);
    const reportOverflow = await page.locator('.glasses-card').evaluate((element) => ({ horizontal: element.scrollWidth > element.clientWidth + 1, vertical: element.scrollHeight > element.clientHeight + 1 }));
    expect(reportOverflow.horizontal).toBe(false);
    expect(reportOverflow.vertical).toBe(true);
    await captureGlassesScreenshot(page, 'glasses-report-review-polished');
    await page.locator('[data-glasses-action="prev"]').click();
    await expect(page.locator('[data-sharing-field="shared"]')).toBeChecked();
    await expect(page.locator('[data-sharing-field="method"]')).toHaveValue('team_meeting');
    await expect(page.locator('[data-sharing-field="proofType"]')).toHaveValue('no_independent_proof');
    await page.locator('[data-glasses-action="record-continue"]').click();
    const submit = page.locator('[data-glasses-action="submit-report"]');
    await expect(submit).toBeEnabled();
    await submit.dblclick();
    await expect(page.locator('.is-complete')).toContainText('보고서 제출 완료');
    await captureGlassesScreenshot(page, 'glasses-complete-polished');
  });

  test('pending synchronization does not block sharing-to-review navigation', async ({ page, context }) => {
    await openGlasses(page); await beginGlassesReview(page); await controlAllGlassesHazards(page);
    await page.locator('[data-glasses-action="summary-continue"]').click();
    await page.locator('[data-sharing-field="shared"]').check();
    await page.locator('[data-sharing-field="method"]').selectOption('verbal_briefing');
    await page.locator('[data-sharing-field="proofType"]').selectOption('supervisor_confirmation');
    await context.setOffline(true);
    await page.locator('[data-glasses-action="record-continue"]').click();
    await expect(page.locator('.is-report_review')).toBeVisible();
    await expect(page.locator('.glasses-sync')).toContainText('동기화 대기 중');
    await page.locator('[data-glasses-action="submit-report"]').click();
    await expect(page.locator('.is-complete')).toContainText('제출 대기열에 추가됨');
    await captureGlassesScreenshot(page, 'glasses-queued-polished');
  });

  test('a finalization conflict never claims submission success', async ({ page }) => {
    await openGlasses(page); await beginGlassesReview(page); await controlAllGlassesHazards(page);
    await page.locator('[data-glasses-action="summary-continue"]').click();
    await page.locator('[data-sharing-field="shared"]').check();
    await page.locator('[data-sharing-field="method"]').selectOption('team_meeting');
    await page.locator('[data-sharing-field="proofType"]').selectOption('attendance_record');
    await page.locator('[data-glasses-action="record-continue"]').click();
    await expect(page.locator('.is-report_review')).toBeVisible();
    await page.route('**/api/sessions', async (route) => {
      if (route.request().method() === 'POST') await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Conflict requires review.', conflict: { serverRevision: 99 } }) });
      else await route.continue();
    });
    await page.locator('[data-glasses-action="submit-report"]').click();
    await expect(page.locator('.glasses-screen.is-conflict')).toBeVisible();
    await expect(page.locator('.glasses-screen')).not.toContainText('보고서 제출 완료');
    await captureGlassesScreenshot(page, 'glasses-conflict-polished');
  });
});
