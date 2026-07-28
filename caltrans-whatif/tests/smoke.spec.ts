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

  // Staging a lever must NOT run the engine: a run is 5 warehouse queries and only
  // a Run press may spend them. Until then the map is explicitly the baseline, and
  // the scenario map treatments stay unavailable.
  await expect(page.getByTestId('scenario-not-run')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Diff' })).toBeDisabled();

  // Corridor filter is populated from corridor_options.
  await expect(page.getByTestId('corridor-select')).toBeVisible();
});

test('smoke test - running the engine produces a real BPR result and a diff map', async ({ page }) => {
  // A failed bind still lets the UI look fine (the next attempt succeeds), so
  // assert the query layer reported no error at all. This is what catches an
  // UNBOUND_SQL_PARAMETER / parameter-validation regression directly rather than
  // via a symptom.
  const queryErrors: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' && /useAnalyticsQuery|UNBOUND_SQL_PARAMETER|Invalid value for/.test(text)) {
      queryErrors.push(text);
    }
  });

  await page.goto('/');
  await expect(page.getByText('Mean speed', { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId('scenario-builder')).toBeVisible();

  await page.getByRole('button', { name: 'Add closure' }).click();
  await page.getByTestId('scenario-run').click();

  // 5 real warehouse queries (4 animation windows + the KPI roll-up), each measured
  // at 2.3-3.7s warm but up to ~25s on a cold Serverless Starter.
  const engineKpis = page.getByTestId('engine-network-kpis');
  await expect(engineKpis).toBeVisible({ timeout: LOAD_TIMEOUT });

  // The model block must state which BPR pair actually ran. The UI deliberately
  // refused to pick between 0.15/4.0 and 0.55/4.5 and required the engine to
  // declare it; this asserts the declaration is rendered rather than assumed.
  const model = page.getByTestId('scenario-model');
  await expect(model).toContainText('alpha=0.55');
  await expect(model).toContainText('beta=4.5');
  // ...and that it does not overclaim the reassignment.
  await expect(model).toContainText('NOT network assignment');

  // Conservation is the audit that makes the reassignment trustworthy: the NETWORK
  // row is a closed system, so this must be 0.0 vehicles. A non-zero value here is
  // a real bug, not a rounding artefact.
  await expect(page.getByTestId('engine-conservation')).toContainText('0.0 veh');

  // A result unlocks the scenario map treatments.
  await expect(page.getByRole('button', { name: 'Diff' })).toBeEnabled();
  await page.getByRole('button', { name: 'Diff' }).click();
  await expect(page.getByText('Diff: red slower')).toBeVisible();
  await expect(page.getByTestId('traffic-map')).toBeVisible();

  expect(queryErrors, 'no scenario query may fail, even if a later one succeeds').toEqual([]);
});

test('smoke test - animation advances without querying the warehouse', async ({ page }) => {
  // This is the architectural invariant from docs/ARCHITECTURE.md §3 under test:
  // the clock must advance while the analytics request count stays flat.
  //
  // The invariant is about ANIMATION, not about scenarios. Running the engine
  // legitimately issues 5 queries — that is a user pressing a button, not an
  // animation frame — so this test covers staging a lever and playing back, and the
  // test below covers the fact that a run's queries also stop once it completes.
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

  // Staging a lever must not query at all — that is the whole point of Run being
  // explicit rather than reactive.
  await page.getByRole('button', { name: 'Add closure' }).click();
  await expect(page.getByTestId('scenario-summary')).toContainText('Close 1 lane');

  const before = await clock.textContent();
  const callsAtStart = analyticsCalls;

  // Autoplay is on, so the readout should change on its own.
  await expect.poll(() => clock.textContent(), { timeout: 20_000, intervals: [400] }).not.toBe(before);

  expect(analyticsCalls).toBe(callsAtStart);
});

test('smoke test - a scenario run queries once and then animation stays flat again', async ({ page }) => {
  // The companion to the test above. A run SPENDS queries (5: four 24-bucket
  // animation windows plus the KPI roll-up) and then must go quiet — the scenario
  // matrix lives in memory exactly like the baseline, so playing the scenario back
  // must not re-query any more than playing the baseline does.
  let analyticsCalls = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/analytics/query/')) analyticsCalls++;
  });

  await page.goto('/');
  await expect(page.getByText('Mean speed', { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId('scenario-builder')).toBeVisible();

  // Count SCENARIO queries specifically, so this cannot be satisfied by the
  // baseline's own reads.
  let scenarioCalls = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/analytics/query/scenario')) scenarioCalls++;
  });

  await page.getByRole('button', { name: 'Add closure' }).click();
  await expect(page.getByTestId('scenario-summary')).toContainText('Close 1 lane');
  await page.waitForTimeout(1500);

  // ZERO, not "no more than before". Staging a lever must not touch the warehouse
  // at all.
  //
  // This assertion exists because the first version of this wiring gated the
  // queries with `parameters: null`, which does NOT suppress them — all five fired
  // on every lever edit and failed with [UNBOUND_SQL_PARAMETER]. The run still
  // worked afterwards, so a test that only compared before/after counts passed
  // while five warehouse calls were being wasted and erroring. Hence: exactly 0.
  expect(scenarioCalls, 'staging a lever must not query the warehouse').toBe(0);

  const callsBeforeRun = analyticsCalls;

  await page.getByTestId('scenario-run').click();
  await expect(page.getByTestId('engine-network-kpis')).toBeVisible({ timeout: LOAD_TIMEOUT });

  // The run cost real queries. Asserted as a floor rather than exactly 5 so an
  // AppKit cache hit on a repeated window cannot make this brittle.
  expect(analyticsCalls).toBeGreaterThan(callsBeforeRun);
  expect(scenarioCalls).toBeGreaterThan(0);

  // Now play the SCENARIO back and prove the count is flat again.
  await page.getByRole('button', { name: 'Diff' }).click();
  const clock = page.getByTestId('clock-readout');
  const before = await clock.textContent();
  const callsAfterRun = analyticsCalls;

  await expect.poll(() => clock.textContent(), { timeout: 20_000, intervals: [400] }).not.toBe(before);

  expect(analyticsCalls).toBe(callsAfterRun);
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
