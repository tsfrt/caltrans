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

test.setTimeout(120_000);

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

test('smoke test - animation controls and live KPIs render from warehouse data', async ({ page }) => {
  await page.goto('/');

  // Play/pause exists and the Pacific clock reads a HH:MM wall time.
  await expect(page.getByTestId('play-toggle')).toBeVisible({ timeout: LOAD_TIMEOUT });
  const clock = page.getByTestId('clock-readout');
  await expect(clock).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(clock).toContainText(/\d{2}:\d{2}/);
  await expect(clock).toContainText('PT');

  // The KPI panel only renders once the time matrix has been parsed into typed arrays, so
  // this assertion transitively proves the Arrow payload arrived and decoded.
  await expect(page.getByTestId('before-after-kpis')).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText('Mean speed', { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText('Total flow', { exact: true })).toBeVisible();
  await expect(page.getByText('VHT', { exact: true })).toBeVisible();
  await expect(page.getByTestId('worst-corridors').locator('li').first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  await expect(page.getByTestId('scenario-builder')).toBeVisible();
  await expect(page.getByText('Scenario levers')).toBeVisible();
  await page.getByRole('button', { name: 'Add closure' }).click();
  await expect(page.getByTestId('scenario-summary')).toContainText('Close 1 lane');
  await expect(page.getByTestId('scenario-caveat')).toContainText('Mocked in the client');
  await page.getByRole('button', { name: 'Diff' }).click();
  await expect(page.getByText('Diff: red slower')).toBeVisible();

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
  // Wait for KPIs so the initial analytics requests have certainly been issued.
  await expect(page.getByText('Mean speed', { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByTestId('scenario-builder')).toBeVisible();

  await page.getByRole('button', { name: 'Add closure' }).click();
  await page.getByRole('button', { name: 'Diff' }).click();
  await expect(page.getByTestId('scenario-summary')).toContainText('Close 1 lane');

  const before = await clock.textContent();
  const callsAtStart = analyticsCalls;

  // Autoplay is on, so the readout should change on its own.
  await expect.poll(() => clock.textContent(), { timeout: 20_000, intervals: [400] }).not.toBe(before);

  expect(analyticsCalls).toBe(callsAtStart);
});

// ── AI Congestion Advisor ───────────────────────────────────────────────────
//
// These assert the parts of the advisor that do NOT need a model call, so the smoke suite
// stays fast and deterministic: the M1 layout is preserved, the panel mounts, the transport
// is negotiated rather than assumed, and the anchor reflects the map's CURRENT selection.
// A live end-to-end assessment (streaming, persistence, recommendation rendering) is
// exercised separately — see the PR body.

test('smoke test - advisor is closed by default and does not disturb the M1 layout', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('traffic-map')).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText('Mean speed', { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // Collapsed by default: the map keeps its full M1 width until the user opts in.
  await expect(page.getByTestId('advisor-panel')).toHaveCount(0);
  await expect(page.getByTestId('advisor-open')).toBeVisible();
});

test('smoke test - advisor panel opens, negotiates a transport, and anchors to the map', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText('Mean speed', { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  await page.getByTestId('advisor-open').click();
  await expect(page.getByTestId('advisor-panel')).toBeVisible();

  // The map must still be there — the panel is a sibling, never an overlay.
  await expect(page.getByTestId('traffic-map')).toBeVisible();

  // The transport badge starts as "probing…" and must RESOLVE. This is the guard against
  // shipping a streaming UX that silently degrades: the client measures whether SSE survives
  // the connection (proxy included) and says which path it chose.
  const badge = page.getByTestId('advisor-transport');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText(/streaming|buffered/, { timeout: 30_000 });

  // With no session yet, the anchor shows what a new session WOULD be created from, which
  // must match the corridor filter and the clock rather than a hardcoded default.
  const anchor = page.getByTestId('advisor-anchor');
  await expect(anchor).toContainText('all corridors');
  await expect(anchor).toContainText(/\d{4}-\d{2}-\d{2}/);
  await expect(anchor).toContainText(/\d{2}:\d{2} PT/);

  // The assess action is enabled only once the transport probe has resolved.
  await expect(page.getByTestId('advisor-assess')).toBeEnabled({ timeout: 30_000 });
  // Follow-ups are impossible before a session exists, so the composer stays disabled.
  await expect(page.getByTestId('advisor-input')).toBeDisabled();
});

test('smoke test - advisor anchor follows the corridor filter', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Mean speed', { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  await page.getByTestId('advisor-open').click();
  await expect(page.getByTestId('advisor-anchor')).toContainText('all corridors');

  // Switching corridor must re-target the anchor. This also covers the regression that used
  // to blank the page here: stale all-corridor matrix windows were applied to the newly
  // narrowed geometry, and applyPackedWindow's alignment guard threw into the router's
  // ErrorBoundary. If that returns, the map disappears and this assertion fails.
  await page.getByTestId('corridor-select').click();
  await page.getByRole('option', { name: /^I-405/ }).click();

  await expect(page.getByTestId('advisor-anchor')).toContainText('I-405', { timeout: 30_000 });
  await expect(page.getByTestId('traffic-map')).toBeVisible();
  await expect(page.getByText('Mean speed', { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
});

test('smoke test - advisor session history loads from Lakebase', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Mean speed', { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  await page.getByTestId('advisor-open').click();

  // The history toggle reports a count fetched from Lakebase via GET /api/advisor/sessions.
  // Reaching it at all proves the route answered; the count may legitimately be 0 in a fresh
  // database, so assert the list renders rather than that it has rows.
  const toggle = page.getByTestId('advisor-sessions-toggle');
  await expect(toggle).toContainText(/History \(\d+\)/);
  await toggle.click();
  await expect(page.getByTestId('advisor-session-list')).toBeVisible();
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
    const locationStr = location.url ? ` at ${location.url}:${location.lineNumber}:${location.columnNumber}` : '';
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
