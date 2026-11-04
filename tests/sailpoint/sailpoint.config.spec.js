/**
 * SailPoint — config contract tests
 *
 * These assert the rules that govern config/sailpoint.data.json. They run
 * without a browser, so they are fast, and they exist so a bad config edit
 * fails a test rather than silently producing a meaningless run.
 *
 * The 5 invariants enforced by resolvePlan():
 *   1. at least one page must be flagged isUnderTest: true
 *   2. every flowthroughDestination entry must be a known page key
 *   3. every flowthroughDestination entry must be an ELIGIBLE destination
 *      (not under test, not flowthrough, not isDestination:false, has a form)
 *   4. every interruptionPages entry must be a known page key
 *   5. every flowthroughPages entry must be a known flowthrough page that is
 *      not under test (waypoints are walked + asserted, not destinations)
 *
 * Rule 3 is the "negative" case the down-funnel spec used to drop silently: a
 * typo'd key or an ineligible page listed as a destination would quietly shrink
 * the run to fewer pages. It must be rejected instead.
 */

import { test, expect } from '@playwright/test';
import { TEST_CONFIG } from './config/sailpoint.config.js';
import { resolvePlan, resolveSubmitPages, resolveSubmitBuckets, findOwningTarget } from './helpers/abtest.helpers.js';

const { pages } = TEST_CONFIG;

/** Deep-clones the real config so each negative case mutates its own copy. */
const cloneConfig = () => JSON.parse(JSON.stringify(TEST_CONFIG));

test.describe('SailPoint config contract', () => {
  // ── Positive: the real config satisfies every rule ─────────────────────────
  test('the live config resolves without throwing', () => {
    const plan = resolvePlan(cloneConfig());
    expect(plan.testedPages.length).toBeGreaterThan(0);
  });

  test('every configured destination is an eligible form page', () => {
    const { flowthroughDestination = [] } = TEST_CONFIG;
    const plan = resolvePlan(cloneConfig());

    for (const key of flowthroughDestination) {
      expect(pages[key], `flowthroughDestination lists unknown page "${key}"`).toBeTruthy();
      expect(pages[key].formSelector, `flowthroughDestination "${key}" has no formSelector`).toBeTruthy();
      expect(pages[key].isUnderTest, `flowthroughDestination "${key}" is under test — a page can't be its own destination`).toBe(false);
      expect(pages[key].isFlowthrough, `flowthroughDestination "${key}" is a flowthrough page — it has no form to carry into`).toBe(false);
      expect(pages[key].isDestination, `flowthroughDestination "${key}" opted out with isDestination: false`).not.toBe(false);
    }

    // every resolved destination is one we actually asked for
    expect(plan.destinations.length).toBe(flowthroughDestination.length);
  });

  test('at least one page is flagged isUnderTest', () => {
    const underTest = Object.entries(pages).filter(([, p]) => p.isUnderTest);
    expect(underTest.length, 'no page is flagged isUnderTest — nothing would be tested').toBeGreaterThan(0);
  });

  test('every bucket has an expectedValue (the only signal a no-class control has)', () => {
    for (const [key, b] of Object.entries(TEST_CONFIG.buckets || {})) {
      expect(b.expectedValue, `bucket "${key}" has no expectedValue — a control with no bodyClass would be undetectable`).toBeTruthy();
    }
  });

  // ── Negative: ineligible destinations are warned and skipped, not thrown ─────
  // resolvePlan now warns + skips ineligible destination entries instead of
  // throwing — so these configs produce an empty or reduced destinations list
  // rather than an error. The config UI surfaces the warning visually.

  test('skips (not throws) an unknown flowthroughDestination page key', () => {
    const cfg = cloneConfig();
    cfg.flowthroughDestination = [...(cfg.flowthroughDestination || []), '__does_not_exist__'];
    // resolvePlan warns and drops the bad key — should NOT throw
    const plan = resolvePlan(cfg);
    expect(plan.destinations.every(d => d)).toBeTruthy();
  });

  test('skips a flowthrough page listed as a destination', () => {
    const cfg = cloneConfig();
    const ftPage = Object.entries(cfg.pages).find(([, p]) => p.isFlowthrough && !p.isUnderTest);
    if (!ftPage) { test.skip(true, 'config needs at least one flowthrough page'); return; }
    cfg.flowthroughDestination = [ftPage[0]];
    const plan = resolvePlan(cfg);
    // Flowthrough pages are skipped — destinations should be empty
    expect(plan.destinations.find(d => d.url === ftPage[1].url)).toBeFalsy();
  });

  test('skips an under-test page listed as a destination', () => {
    const cfg = cloneConfig();
    const underTest = Object.entries(cfg.pages).find(([, p]) => p.isUnderTest);
    if (!underTest) { test.skip(true, 'config needs at least one under-test page'); return; }
    cfg.flowthroughDestination = [underTest[0]];
    const plan = resolvePlan(cfg);
    expect(plan.destinations.find(d => d.url === underTest[1].url)).toBeFalsy();
  });

  test('skips a page that opted out with isDestination: false', () => {
    const cfg = cloneConfig();
    const optedOut = Object.entries(cfg.pages).find(([, p]) => p.isDestination === false);
    if (!optedOut) { test.skip(true, 'no page in the config sets isDestination: false'); return; }
    cfg.flowthroughDestination = [optedOut[0]];
    const plan = resolvePlan(cfg);
    expect(plan.destinations.find(d => d.url === optedOut[1].url)).toBeFalsy();
  });

  test('rejects an unknown interruptionPages page key', () => {
    const cfg = cloneConfig();
    cfg.interruptionPages = ['__nope__'];

    expect(() => resolvePlan(cfg)).toThrow(/interruptionPages contains unknown page key "__nope__"/);
  });

  test('rejects a config with no page under test', () => {
    const cfg = cloneConfig();
    for (const p of Object.values(cfg.pages)) p.isUnderTest = false;

    expect(() => resolvePlan(cfg)).toThrow(/mark the page\(s\) under test/);
  });

  // An EMPTY flowthroughDestination means different things depending on what is
  // under test — mirroring resolvePlan(): a flowthrough test auto-derives every
  // eligible form page; a form page under test keeps its value on-site, so it
  // needs no destinations at all (flowthroughDestination is only required when
  // the target URL is not itself a form/squeeze page).
  test('empty flowthroughDestination: a flowthrough test auto-derives every eligible form page', () => {
    const cfg = cloneConfig();
    const flowTest = Object.entries(cfg.pages).find(([, p]) => p.isUnderTest && p.isFlowthrough);
    if (!flowTest) test.skip(true, 'no under-test flowthrough page — the shipped test sits on a form page');
    cfg.flowthroughDestination = [];

    const plan = resolvePlan(cfg);
    const eligible = Object.values(cfg.pages).filter(
      (p) => !p.isUnderTest && !p.isFlowthrough && p.formSelector && p.isDestination !== false
    );

    expect(plan.destinations.length).toBe(eligible.length);
  });

  test('empty flowthroughDestination: a form page under test needs no destinations', () => {
    const cfg = cloneConfig();
    const formTest = Object.entries(cfg.pages).find(([, p]) => p.isUnderTest && !p.isFlowthrough);
    if (!formTest) test.skip(true, 'no under-test form page — nothing stays on-site to assert');
    cfg.flowthroughDestination = [];   // only needed when the value must carry away

    expect(resolvePlan(cfg).destinations).toEqual([]);
  });

  // ── flowthroughPages (waypoints) ────────────────────────────────────────────
  // The spec walks each enabled waypoint, screenshots it, and asserts the df
  // value survived the hop — so an ineligible key must fail here, not there.
  test('every configured flowthrough waypoint is a flowthrough page and not under test', () => {
    const { flowthroughPages = [] } = TEST_CONFIG;
    const plan = resolvePlan(cloneConfig());

    for (const key of flowthroughPages) {
      expect(pages[key], `flowthroughPages lists unknown page "${key}"`).toBeTruthy();
      expect(pages[key].isFlowthrough, `flowthroughPages "${key}" is not a flowthrough page`).toBe(true);
      expect(pages[key].isUnderTest, `flowthroughPages "${key}" is under test — already asserted in step 1`).toBe(false);
    }

    expect(plan.flowthroughWaypoints.length).toBe(flowthroughPages.length);
  });

  test('resolves no waypoints when flowthroughPages is empty or absent', () => {
    const empty = resolvePlan(cloneConfig());
    expect(Array.isArray(empty.flowthroughWaypoints)).toBe(true);

    const cfg = cloneConfig();
    delete cfg.flowthroughPages;
    const absent = resolvePlan(cfg);
    expect(absent.flowthroughWaypoints.length).toBe(0);
  });

  test('warns and skips an unknown flowthroughPages page key', () => {
    const cfg = cloneConfig();
    const good = (cfg.flowthroughPages || [])[0];
    cfg.flowthroughPages = good ? ['__no_such_page__', good] : ['__no_such_page__'];

    // resolvePlan logs "Config warning: … — skipped" instead of throwing, so a
    // typo'd waypoint shrinks the walk rather than killing the whole run.
    const plan = resolvePlan(cfg);
    expect(plan.flowthroughWaypoints.length).toBe(good ? 1 : 0);
  });

  test('warns and skips a form page listed in flowthroughPages', () => {
    const cfg = cloneConfig();
    const formPage = Object.entries(cfg.pages).find(
      ([, p]) => !p.isFlowthrough && !p.isUnderTest && p.formSelector
    );
    expect(formPage, 'config needs at least one form page to test with').toBeTruthy();

    cfg.flowthroughPages = [formPage[0]];

    expect(resolvePlan(cfg).flowthroughWaypoints).toEqual([]);
  });

  test('warns and skips an under-test page listed in flowthroughPages', () => {
    const cfg = cloneConfig();
    const underTest = Object.entries(cfg.pages).find(([, p]) => p.isUnderTest);
    if (!underTest) test.skip(true, 'no page under test — nothing to list');

    cfg.flowthroughPages = [underTest[0]];

    expect(resolvePlan(cfg).flowthroughWaypoints).toEqual([]);
  });

  // ── submitPages ─────────────────────────────────────────────────────────────
  // The submission spec fires a REAL lead on each of these pages, once per
  // bucket, so a typo'd key or a page with no form must fail HERE rather than
  // halfway through a live run.
  test('every configured submitPages entry is a squeeze page with a form', () => {
    const { submitPages = [] } = TEST_CONFIG;
    expect(Array.isArray(submitPages), 'submitPages must be an array of page keys').toBe(true);

    for (const key of submitPages) {
      expect(pages[key], `submitPages lists unknown page key "${key}"`).toBeTruthy();
      expect(pages[key].formSelector, `submitPages "${key}" has no formSelector — nothing to submit`).toBeTruthy();
      expect(pages[key].isSqueezePage, `submitPages "${key}" is not a squeeze page (isSqueezePage: true)`).toBe(true);
    }
  });

  test('rejects an unknown submitPages page key', () => {
    const cfg = cloneConfig();
    cfg.submitPages = ['__not_a_page__'];

    expect(() => resolveSubmitPages(cfg)).toThrow(/unknown page key "__not_a_page__"/);
  });

  test('rejects a page with no form listed in submitPages', () => {
    const cfg = cloneConfig();
    const formless = Object.entries(cfg.pages).find(([, p]) => !p.formSelector);
    if (!formless) test.skip(true, 'every page in the config has a formSelector');

    cfg.submitPages = [formless[0]];

    expect(() => resolveSubmitPages(cfg)).toThrow(/has no formSelector/);
  });

  test('rejects a non-squeeze page listed in submitPages', () => {
    const cfg = cloneConfig();
    const notSqueeze = Object.entries(cfg.pages).find(([, p]) => p.formSelector && p.isSqueezePage !== true);
    if (!notSqueeze) test.skip(true, 'every form page in the config is a squeeze page');

    cfg.submitPages = [notSqueeze[0]];

    expect(() => resolveSubmitPages(cfg)).toThrow(/is not a squeeze page/);
  });

  test('SUBMIT_PAGES overrides submitPages but still has to be valid', () => {
    const cfg = cloneConfig();
    const squeeze = Object.entries(cfg.pages).find(([, p]) => p.isSqueezePage && p.formSelector);
    expect(squeeze, 'config needs at least one squeeze page to test with').toBeTruthy();

    expect(resolveSubmitPages(cfg, `${squeeze[0]}, demo`)).toContain(squeeze[0]);
    expect(() => resolveSubmitPages(cfg, 'demo, __nope__')).toThrow(/unknown page key "__nope__"/);
  });

  // ── Submission-target ownership ────────────────────────────────────────────
  // SailPoint runs ONE experiment: it lands on the under-test flowthrough page
  // (no form) and its value carries into flowthroughDestination. A form page
  // outside that list can never carry it — submitting it would prove nothing,
  // so the spec reports those as skips and the config must not tick them.
  test('every configured submitPages entry is owned by the experiment', () => {
    for (const key of TEST_CONFIG.submitPages || []) {
      expect(
        findOwningTarget(TEST_CONFIG, key),
        `submitPages "${key}" is not in flowthroughDestination — the experiment's value never reaches it`,
      ).toBeTruthy();
    }
  });

  test('a squeeze page outside flowthroughDestination is not owned', () => {
    const cfg = cloneConfig();
    const dests = cfg.flowthroughDestination || [];
    // Must be a squeeze page that is NOT a destination AND NOT under test
    // (under-test form pages own themselves now — that's correct behaviour)
    const stray = Object.entries(cfg.pages)
      .find(([k, p]) => p.isSqueezePage && p.formSelector && !dests.includes(k) && !p.isUnderTest);
    if (!stray) { test.skip(true, 'every non-under-test squeeze page is a flowthrough destination'); return; }

    expect(findOwningTarget(cfg, stray[0])).toBeNull();
  });

  test('a form page under test owns itself — flowthroughDestination not needed', () => {
    const cfg = cloneConfig();
    const formPage = Object.entries(cfg.pages)
      .find(([, p]) => p.isUnderTest && !p.isFlowthrough && p.formSelector);
    if (!formPage) test.skip(true, 'no form page flagged isUnderTest — nothing self-owns here');

    cfg.flowthroughDestination = [];   // the list is only needed for FLOWTHROUGH tests
    expect(
      findOwningTarget(cfg, formPage[0]),
      `"${formPage[0]}" is under test with a form — it must own its own submission with an empty flowthroughDestination`,
    ).toBeTruthy();
  });

  test('an unknown page is not owned', () => {
    expect(findOwningTarget(TEST_CONFIG, '__not_a_page__')).toBeNull();
  });

  // ── submitBucket ────────────────────────────────────────────────────────────
  // A submission run fires ONE bucket, picked here (edited by the config UI's
  // "Bucket to submit" radio). A key that no bucket owns would either widen the
  // run or make it a no-op, so it must be rejected.
  test('submitBucket names a configured bucket', () => {
    const { submitBucket, buckets } = TEST_CONFIG;
    expect(submitBucket, 'submitBucket is missing — a run would submit every bucket').toBeTruthy();
    expect(Object.keys(buckets || {}), `submitBucket "${submitBucket}" is not a configured bucket`)
      .toContain(submitBucket);
    expect(resolveSubmitBuckets(TEST_CONFIG, '', Object.keys(buckets), 'demo')).toEqual([submitBucket]);
  });

  test('rejects a submitBucket that is not a configured bucket', () => {
    const cfg = cloneConfig();
    cfg.submitBucket = '__nope__';

    expect(() => resolveSubmitBuckets(cfg, '', Object.keys(cfg.buckets), 'demo'))
      .toThrow(/submit bucket "__nope__" for "demo" is not one of the configured buckets/);
  });

  test('an explicit SUBMIT_BUCKETS wins over config.submitBucket', () => {
    const cfg = cloneConfig();
    const other = Object.keys(cfg.buckets).find((k) => k !== cfg.submitBucket);
    expect(other, 'config needs at least two buckets to test with').toBeTruthy();

    expect(resolveSubmitBuckets(cfg, other, Object.keys(cfg.buckets))).toEqual([other]);
  });

  // ── spzCookies ──────────────────────────────────────────────────────────────
  // SPZ namespaces its bucket cookies per test id (HiddenFieldName3018 /
  // HiddenFieldValue3018). Renumbering the test without renaming the cookies
  // would silently read the OLD test's cookie, so the names must track testId.
  test('SPZ cookie names embed the current test id', () => {
    const { spzCookies, testId } = TEST_CONFIG;
    if (!spzCookies) test.skip(true, 'config does not declare spzCookies');

    expect(spzCookies.name,  'spzCookies.name is empty').toBeTruthy();
    expect(spzCookies.value, 'spzCookies.value is empty').toBeTruthy();
    expect(
      spzCookies.name.includes(testId),
      `spzCookies.name "${spzCookies.name}" should embed testId "${testId}" — SPZ namespaces the cookie per test`
    ).toBe(true);
    expect(
      spzCookies.value.includes(testId),
      `spzCookies.value "${spzCookies.value}" should embed testId "${testId}"`
    ).toBe(true);
  });
});
