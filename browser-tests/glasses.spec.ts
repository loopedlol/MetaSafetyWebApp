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
    await page.goto('/?mode=glasses&adapter=meta-display&stress');
    await expect(page.locator('.glasses-screen')).toBeVisible();
    await expect(page.locator('.is-start')).toContainText('Meta Display Web App');
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', 'width=600,height=600,initial-scale=1');

    await page.keyboard.press('Enter');
    await expect(page.locator('.is-context_confirmation')).toBeVisible();
    await page.getByRole('button', { name: '확인', exact: true }).click();
    await page.locator('[data-attendance-digit="presentOnes"]').selectOption('4');
    await page.getByRole('button', { name: '계속', exact: true }).click();
    await expect(page.locator('.is-hazard_decision')).toBeVisible();

    for (const key of ['1', '2', 'm', 'M', 'p', 'P']) await page.keyboard.press(key);
    await expect(page.locator('.is-hazard_decision')).toBeVisible();
    await expect(page.locator('[data-glasses-action="mock-photo"]')).toHaveCount(0);
    await expect(page.locator('[data-glasses-action="controlled"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.is-photo_evidence')).toBeVisible();
    await expect(page.locator('[data-glasses-action="mock-photo"]')).toHaveCount(0);
    await expect(page.locator('.is-photo_evidence')).toContainText('Meta Display Web Apps');
    await expect(page.locator('.is-photo_evidence')).toContainText('사진 없음');
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
