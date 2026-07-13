import { expect, test } from '@playwright/test';
import { beginGlassesReview, controlAllGlassesHazards, expectNoViewportOverflow, openGlasses, screenshotPath } from './helpers.ts';

test.describe('600×600 structured glasses preview', () => {
  test.afterEach(async ({ page }) => expectNoViewportOverflow(page));

  test('uses one start action, truthful context, and count-only attendance', async ({ page }) => {
    await openGlasses(page);
    await expect(page.locator('.glasses-actions button')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '취소' })).toHaveCount(0);
    await page.getByRole('button', { name: '시작', exact: true }).click();
    await expect(page.locator('.is-context_confirmation')).toContainText(/세션 현장|세션 좌표/);
    await expect(page.locator('.is-context_confirmation')).toContainText('기기 시간');
    await page.getByRole('button', { name: '거부' }).click();
    await expect(page.locator('.is-start')).toBeVisible();
    await page.getByRole('button', { name: '시작', exact: true }).click();
    await page.getByRole('button', { name: '확인', exact: true }).click();
    await page.locator('[data-attendance-digit="expectedOnes"]').selectOption('2');
    await page.locator('[data-attendance-digit="presentOnes"]').selectOption('3');
    await expect(page.getByRole('button', { name: '계속' })).toBeDisabled();
    await page.locator('[data-attendance-digit="presentOnes"]').selectOption('2');
    await expect(page.getByRole('button', { name: '계속' })).toBeEnabled();
    await page.screenshot({ path: screenshotPath('glasses-attendance') });
  });

  test('routes Controlled and Not Controlled through evidence and confirmation', async ({ page }) => {
    await openGlasses(page); await beginGlassesReview(page);
    await expect(page.getByRole('button', { name: '통제되지 않음' })).toBeVisible();
    await page.locator('[data-glasses-action="controlled"]').click();
    await expect(page.locator('.is-photo_evidence')).toBeVisible();
    await page.locator('[data-glasses-action="mock-photo"]').click();
    await expect(page.locator('.is-photo_evidence')).toContainText('Browser preview mock');
    await page.locator('[data-glasses-action="evidence-continue"]').click();
    await page.locator('[data-glasses-action="hazard-confirm"]').click();
    await page.locator('[data-glasses-action="action-required"]').click();
    await expect(page.locator('.is-corrective_action input[type="text"]')).toHaveCount(0);
    await expect(page.locator('.is-corrective_action select')).toHaveCount(5);
  });

  test('shows hazard summary before required structured sharing', async ({ page }) => {
    await openGlasses(page); await beginGlassesReview(page); await controlAllGlassesHazards(page);
    await expect(page.locator('.glasses-summary-list li')).toHaveCount(4);
    await page.locator('[data-glasses-action="summary-continue"]').click();
    await expect(page.locator('[data-glasses-action="record-continue"]')).toBeDisabled();
    await page.locator('[data-sharing-field="shared"]').check();
    await page.locator('[data-sharing-field="method"]').selectOption('team_meeting');
    await page.locator('[data-sharing-field="proofType"]').selectOption('no_independent_proof');
    await expect(page.locator('[data-glasses-action="record-continue"]')).toBeEnabled();
  });
});
