/**
 * InsightSoftware A/B Test Configuration.
 *
 * The DATA lives in insightsoftware.data.json (edited by the config UI or by
 * hand). This module only:
 *   1. reads that JSON,
 *   2. renders each test's `cookieScriptExp` NUMBER into the real VWO snippet
 *      (see cookie-scripts.js) — so a typo throws here instead of the page
 *      evaluating nonsense later,
 *   3. re-exports INSIGHT_CONFIG in the shape the specs already expect.
 *
 * `cookieScriptExp` in the JSON is '' (postlaunch / live: nothing injected) or
 * a VWO experiment number, e.g. "68". `excludeExps` (optional, per test) pins
 * sibling experiments at combi 1 — e.g. `48=Disabling 1000` — so they never
 * bucket the session.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCookieScript } from './cookie-scripts.js';

export { buildCookieScript, COOKIE_EXP_OPTIONS } from './cookie-scripts.js';

// Playwright loads these .js files as CJS (no "type": "module"), so import.meta
// is unavailable. Tests always run with cwd = repo root.
const data = JSON.parse(readFileSync(join(process.cwd(), 'tests/insightsoftware/config/insightsoftware.data.json'), 'utf8'));

export const INSIGHT_CONFIG = {
  ...data,
  // excludeExps pins sibling experiments at combi 1 for THIS test only — the
  // rendered snippet (cookieScript) is what the specs inject.
  tests: data.tests.map((t) => ({
    ...t,
    cookieScript: buildCookieScript(t.cookieScriptExp ?? '', t.excludeExps ?? ''),
  })),
};
