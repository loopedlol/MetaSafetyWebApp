import { expect, type Page } from '@playwright/test';

export const screenshotPath = (name: string) => `test-artifacts/browser/screenshots/${name}.png`;

export async function openGlasses(page: Page) {
  await page.setViewportSize({ width: 600, height: 600 });
  await page.goto('/?mode=glasses&stress');
  await expect(page.locator('.glasses-screen')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
}

export async function beginGlassesReview(page: Page) {
  await page.getByRole('button', { name: '시작', exact: true }).click();
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await page.locator('[data-attendance-digit="presentOnes"]').selectOption('4');
  await page.getByRole('button', { name: '계속', exact: true }).click();
  await expect(page.locator('.is-hazard_decision')).toBeVisible();
}

export async function controlAllGlassesHazards(page: Page) {
  for (let index = 0; index < 4; index += 1) {
    await page.locator('[data-glasses-action="controlled"]').click();
    await page.locator('[data-glasses-action="evidence-continue"]').click();
    await page.locator('[data-glasses-action="hazard-confirm"]').click();
  }
  await expect(page.locator('.is-hazard_summary')).toBeVisible();
}

export async function openNormal(page: Page, viewport = { width: 600, height: 600 }) {
  await page.setViewportSize(viewport);
  await page.goto('/?stress');
  await expect(page.locator('[role="main"]')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
}

export async function reachNormalSummary(page: Page) {
  await page.getByRole('button', { name: /TBM 시작/ }).click();
  await page.getByRole('button', { name: /계속/ }).click();
  for (let index = 0; index < 4; index += 1) {
    await page.getByRole('button', { name: /통제됨/ }).click();
  }
  await expect(page.getByRole('heading', { level: 2, name: 'TBM 초안 — 최종 확정 차단됨' })).toBeVisible();
}

export async function focusByKeyboard(page: Page, selector: string, maximumTabs = 20) {
  for (let index = 0; index < maximumTabs; index += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((value) => document.activeElement?.matches(value) ?? false, selector)) return;
  }
  throw new Error(`Keyboard focus did not reach ${selector}.`);
}

export async function expectNoViewportOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight
  }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  if (await page.locator('html').evaluate((element) => element.classList.contains('is-glasses-mode'))) {
    expect(dimensions.height).toBeLessThanOrEqual(dimensions.viewportHeight + 1);
  }
}
