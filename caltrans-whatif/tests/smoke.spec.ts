import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Smoke test for the California Traffic What-If map.
 *
 * Selectors target THIS app, not the AppKit template defaults (the template checked for
 * "Minimal Databricks App" / "hello world" and an /analytics route, none of which exist
 * here).
 *
 * Timeouts are generous because the first paint waits on three real warehouse queries
 * (station geometry + a 191k-row Arrow time matrix + 85k H3 rows). Measured p50 is ~0.8s
 * warm, but a Serverless Starter cold start can add ~20s.
 */

const LOAD_TIMEOUT = 60_000;

let testArtifactsDir: string;
let consoleLogs: string[] = [];
let consoleErrors: string[] = [];
let pageErrors: string[] = [];
let failedRequests: string[] = [];

test('smoke test - app shell renders', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'California Traffic What-If' })).toBeVisible();

  // The map container mounts immediately, before data arrives.
  await expect(page.getByTestId('traffic-map')).toBeVisible({ timeout: LOAD_TIMEOUT });
});

test('smoke test - animation controls and live KPIs render from warehouse data', async ({
  page,
}) => {
  await page.goto('/');

  // Play/pause exists and the Pacific clock reads a HH:MM wall time.
  await expect(page.getByTestId('play-toggle')).toBeVisible({ timeout: LOAD_TIMEOUT });
  const clock = page.getByTestId('clock-readout');
  await expect(clock).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(clock).toContainText(/\d{2}:\d{2}/);
  await expect(clock).toContainText('PT');

  // The KPI panel only renders once the time matrix has been parsed into typed arrays, so
  // this assertion transitively proves the Arrow payload arrived and decoded.
  await expect(page.getByText('Mean speed', { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText('Total flow', { exact: true })).toBeVisible();
  await expect(page.getByTestId('worst-corridors').locator('li').first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // Corridor filter is populated from corridor_options.
  await expect(page.getByTestId('corridor-select')).toBeVisible();
});

test('smoke test - animation advances without querying the warehouse', async ({ page }) => {
  // This is the architectural invariant from docs/ARCHITECTURE.md §3 under test:
  // the clock must advance while the analytics request count stays flat.
  let analyticsCalls = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/analytics/query/')) analyticsCalls++;
  });

  await page.goto('/');

  const clock = page.getByTestId('clock-readout');
  await expect(clock).toBeVisible({ timeout: LOAD_TIMEOUT });
  // Wait for KPIs so all three initial queries have certainly been issued.
  await expect(page.getByText('Mean speed', { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  const before = await clock.textContent();
  const callsAtStart = analyticsCalls;

  // Autoplay is on, so the readout should change on its own.
  await expect
    .poll(() => clock.textContent(), { timeout: 20_000, intervals: [400] })
    .not.toBe(before);

  expect(analyticsCalls).toBe(callsAtStart);
});

// ── Lifecycle hooks ─────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  consoleLogs = [];
  consoleErrors = [];
  pageErrors = [];
  failedRequests = [];

  testArtifactsDir = join(process.cwd(), '.smoke-test');
  mkdirSync(testArtifactsDir, { recursive: true });

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (!text.trim() || /^%[osd]$/.test(text.trim())) return;
    const location = msg.location();
    const locationStr = location.url
      ? ` at ${location.url}:${location.lineNumber}:${location.columnNumber}`
      : '';
    consoleLogs.push(`[${type}] ${text}${locationStr}`);
    if (type === 'error') consoleErrors.push(`${text}${locationStr}`);
  });

  page.on('pageerror', (error) => {
    const errorDetails = `Page error: ${error.message}\nStack: ${error.stack || 'No stack trace available'}`;
    pageErrors.push(errorDetails);
    console.error('Page error detected:', errorDetails);
  });

  page.on('requestfailed', (request) => {
    failedRequests.push(`Failed request: ${request.url()} - ${request.failure()?.errorText}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const testName = testInfo.title.replace(/ /g, '-').toLowerCase();
  const screenshotPath = join(testArtifactsDir, `${testName}-app-screenshot.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const logsPath = join(testArtifactsDir, `${testName}-console-logs.txt`);
  const allLogs = [
    '=== Console Logs ===',
    ...consoleLogs,
    '\n=== Console Errors (React errors) ===',
    ...consoleErrors,
    '\n=== Page Errors ===',
    ...pageErrors,
    '\n=== Failed Requests ===',
    ...failedRequests,
  ];
  writeFileSync(logsPath, allLogs.join('\n'), 'utf-8');

  console.log(`Screenshot saved to: ${screenshotPath}`);
  console.log(`Console logs saved to: ${logsPath}`);
  if (consoleErrors.length > 0) console.log('Console errors detected:', consoleErrors);
  if (pageErrors.length > 0) console.log('Page errors detected:', pageErrors);
  if (failedRequests.length > 0) console.log('Failed requests detected:', failedRequests);

  await page.close();
});
