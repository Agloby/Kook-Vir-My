import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('sign-in screen has no serious automated accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter(v => ['critical','serious'].includes(v.impact))).toEqual([]);
});

test('main tabs support keyboard navigation without page overflow', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { document.querySelector('#authScreen').classList.add('hidden'); document.querySelector('#appShell').classList.remove('hidden'); });
  const first = page.getByRole('tab', { name: 'New recipes' });
  await first.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Favourites' })).toHaveAttribute('aria-selected', 'true');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow).toBe(false);
});

test('manifest and service worker provide an offline shell', async ({ page, context, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright WebKit cannot reliably reload an offline service-worker navigation; covered manually on mobile Safari.');
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(Boolean))).toBe(true);
  const manifest = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifest).toBe('manifest.webmanifest');
  await page.reload();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
