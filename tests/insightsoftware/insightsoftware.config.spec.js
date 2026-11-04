/**
 * Insight Software — config contract tests
 *
 * These assert the rules that govern config/insightsoftware.config.js. They run
 * without a browser, so they are fast, and they exist so a bad config edit fails
 * a test rather than silently producing a meaningless run.
 *
 * The 5 invariants enforced by resolveTestPlans():
 *   1. tests[].page must be a known page key
 *   2. tests[].page must be flagged isUnderTest: true
 *   3. tests[].flowthroughDestination entries must be known page keys
 *   4. tests[].flowthroughDestination entries must be FORM pages (have a formSelector)
 *   5. in prelaunch mode every {{placeholder}} in tests[].cookieScript must have a
 *      non-blank bucketActivation value for every bucket
 *
 * Rule 4 is the "negative" case: a no-form flowthrough page can never be a carry
 * destination, because a destination is where the value lands in a CRO field —
 * listing one must be rejected instead of quietly producing a no-op assertion.
 *
 * PRELAUNCH vs LIVE: a test is prelaunch only when tests[].cookieScript is
 * non-empty (rendered from cookieScriptExp). Blank cookieScriptExp means the
 * experiment is already live, so nothing is injected and bucketActivation is
 * never read — blank combi values are fine in that mode.
 *
 * MULTI-VARIANT: a test may carry any number of buckets (Var1 = combi 2,
 * Var2 = 3, True Control = 4). The contract also proves a 3-bucket scenario
 * resolves and that a blank combi on ANY of its buckets is rejected by name.
 *
 * EXCLUSIONS: a test may declare `excludeExps` (`48=Disabling 1000`) — sibling
 * experiments pinned at combi 1 for THAT test only. Contract: the line renders
 * into that test's snippet, no declaration means no line, and a malformed
 * entry throws instead of shipping a broken setCookie() to the page.
 */

import { test, expect } from '@playwright/test';
import { INSIGHT_CONFIG, buildCookieScript } from './config/insightsoftware.config.js';
import { parseExcludeExps, HELD_EXP } from './config/cookie-scripts.js';
import { resolveTestPlans, findOwningTest } from './helpers/abtest.helpers.js';
import { resolveSubmitPages, resolveSubmitBuckets } from '../sailpoint/helpers/abtest.helpers.js';

const { pages, tests } = INSIGHT_CONFIG;

/** Deep-clones the real config so each negative case mutates its own copy. */
const cloneConfig = () => JSON.parse(JSON.stringify(INSIGHT_CONFIG));

test.describe('Insight config contract', () => {
  test.beforeEach(() => {
    test.skip(tests.length === 0, 'no tests configured — nothing to assert or mutate');
  });
  // ── Positive: the real config satisfies every rule ─────────────────────────
  test('the live config resolves without throwing', () => {
    const plans = resolveTestPlans(cloneConfig());
    expect(plans.length).toBe(tests.length);
  });

  test('every flowthroughDestination is a form page', () => {
    for (const t of tests) {
      for (const key of t.flowthroughDestination || []) {
        expect(pages[key], `test ${t.testId} lists unknown destination "${key}"`).toBeTruthy();
        expect(
          pages[key].formSelector,
          `test ${t.testId} lists no-form page "${key}" as a destination — destinations must have a form to carry into`
        ).toBeTruthy();
      }
    }
  });

  test('no-form flowthrough pages are never used as carry destinations', () => {
    const noFormPages = Object.entries(pages)
      .filter(([, p]) => !p.formSelector)
      .map(([key]) => key);

    expect(noFormPages.length).toBeGreaterThan(0); // guard: needs such pages to exist

    for (const t of tests) {
      for (const key of t.flowthroughDestination || []) {
        expect(noFormPages).not.toContain(key);
      }
    }
  });

  test('every test runs on a page flagged isUnderTest', () => {
    for (const t of tests) {
      expect(pages[t.page], `test ${t.testId} references unknown page "${t.page}"`).toBeTruthy();
      expect(pages[t.page].isUnderTest, `test ${t.testId} page "${t.page}" is not flagged isUnderTest`).toBe(true);
    }
  });

  // ── Negative: each rule must reject a bad config ───────────────────────────
  test('rejects a no-form flowthrough page listed in flowthroughDestination', () => {
    const cfg = cloneConfig();
    const badPage = Object.entries(cfg.pages).find(([, p]) => !p.formSelector);
    expect(badPage, 'config needs at least one no-form page to test with').toBeTruthy();

    cfg.tests[0].flowthroughDestination = [badPage[0]];

    expect(() => resolveTestPlans(cfg)).toThrow(
      /has no formSelector/
    );
  });

  test('rejects an unknown flowthroughDestination page key', () => {
    const cfg = cloneConfig();
    cfg.tests[0].flowthroughDestination = ['__does_not_exist__'];

    expect(() => resolveTestPlans(cfg)).toThrow(/lists unknown flowthroughDestination/);
  });

  test('rejects an under-test page listed as a flowthroughDestination', () => {
    const cfg = cloneConfig();
    const underTest = Object.entries(cfg.pages).find(([, p]) => p.isUnderTest && p.formSelector);
    if (!underTest) { test.skip(true, 'config needs an under-test form page to test with'); return; }

    cfg.tests[0].flowthroughDestination = [underTest[0]];

    expect(() => resolveTestPlans(cfg)).toThrow(/is under test/);
  });

  test('rejects a test pointing at an unknown page key', () => {
    const cfg = cloneConfig();
    cfg.tests[0].page = '__nope__';

    expect(() => resolveTestPlans(cfg)).toThrow(/references unknown page/);
  });

  test('rejects a test on a page not flagged isUnderTest', () => {
    const cfg = cloneConfig();
    const notUnderTest = Object.entries(cfg.pages).find(([, p]) => !p.isUnderTest);
    if (!notUnderTest) test.skip(true, 'every page in the config is currently flagged isUnderTest');

    cfg.tests[0].page = notUnderTest[0];

    expect(() => resolveTestPlans(cfg)).toThrow(/not marked isUnderTest: true/);
  });

  // ── PRELAUNCH activation values ────────────────────────────────────────────
  test('rejects a blank bucketActivation value in prelaunch mode', () => {
    const cfg = cloneConfig();
    const prelaunchTest = cfg.tests.find((t) => (t.cookieScript || '').trim());
    if (!prelaunchTest) test.skip(true, 'no prelaunch test configured — nothing to assert');
    if (!prelaunchTest.bucketActivation) test.skip(true, 'prelaunch test declares no bucketActivation');

    // A cleared combi field in the config UI stores null — it must fail loudly
    // rather than be substituted into the activation snippet as an empty value.
    const bucketKey = Object.keys(prelaunchTest.buckets)[0];
    prelaunchTest.bucketActivation = { ...prelaunchTest.bucketActivation, [bucketKey]: { combi: null } };

    expect(() => resolveTestPlans(cfg)).toThrow(/have no bucketActivation value/);
  });

  test('a live (no cookieScript) test ignores blank bucketActivation values', () => {
    const cfg = cloneConfig();
    // Blank cookieScriptExp = already live: nothing is injected, so the
    // activation values are never read and may be blank.
    cfg.tests[0].cookieScript = '';
    cfg.tests[0].bucketActivation = { variant: { combi: null }, control: { combi: '' } };

    expect(() => resolveTestPlans(cfg)).not.toThrow();
  });

  // ── Multi-variant scenario (Var1 / Var2 / True Control) ────────────────────
  // VWO's combi number IS the activation switch: 2 = Var1, 3 = Var2,
  // 4 = True Control. With 3+ buckets every variant owns its own value, so a
  // blank combi on ANY bucket must be caught — the config resolves as a whole
  // or not at all.
  const multiVariantConfig = () => {
    const cfg = cloneConfig();
    cfg.tests = [{
      ...cfg.tests[0],
      testId: '4999',
      testName: '#4999 | InsightSoftware | multi-variant scenario',
      buckets: {
        variant1: { label: 'Var1', bodyClass: 'spz_4999_v1', expectedValue: 'SPZ_#4999_variant1' },
        variant2: { label: 'Var2', bodyClass: 'spz_4999_v2', expectedValue: 'SPZ_#4999_variant2' },
        control: { label: 'True Control', bodyClass: '', expectedValue: 'SPZ_#4999_true_control' },
      },
      bucketActivation: { variant1: { combi: 2 }, variant2: { combi: 3 }, control: { combi: 4 } },
    }];
    return cfg;
  };

  test('resolves a multi-variant test with one bucketList entry per bucket', () => {
    const cfg = multiVariantConfig();
    const [plan] = resolveTestPlans(cfg);

    expect(plan.prelaunch, 'the scenario inherits a cookieScriptExp, so it runs PRELAUNCH').toBe(true);
    expect(plan.bucketList.map((b) => b.key)).toEqual(['variant1', 'variant2', 'control']);
    expect(plan.bucketList.map((b) => b.label)).toEqual(['Var1', 'Var2', 'True Control']);
    expect(plan.bucketList.filter((b) => b.bodyClass).length, 'only true control carries no body class').toBe(2);
  });

  for (const bucketKey of ['variant1', 'variant2', 'control']) {
    test(`rejects a multi-variant test with a blank combi on bucket "${bucketKey}"`, () => {
      const cfg = multiVariantConfig();
      if (!(cfg.tests[0].cookieScript || '').trim()) {
        test.skip(true, 'base test is live (no cookieScript) — there is no {{combi}} placeholder to validate');
      }

      // Each variant is checked separately: one missing value must name the
      // bucket that owns it, not just "some bucket failed".
      cfg.tests[0].bucketActivation[bucketKey] = { combi: null };

      expect(() => resolveTestPlans(cfg)).toThrow(
        new RegExp(`test 4999 bucket "${bucketKey}" cookieScript placeholder\\(s\\) combi have no bucketActivation value`)
      );
    });
  }

  // ── submitPages ─────────────────────────────────────────────────────────────
  // The submission spec fires a REAL lead on each of these pages, once per
  // bucket, so a typo'd key or a page with no form must fail HERE rather than
  // halfway through a live run.
  test('every configured submitPages entry is a squeeze page with a form', () => {
    const { submitPages = [] } = INSIGHT_CONFIG;
    expect(Array.isArray(submitPages), 'submitPages must be an array of page keys').toBe(true);

    for (const key of submitPages) {
      expect(pages[key], `submitPages lists unknown page key "${key}"`).toBeTruthy();
      expect(pages[key].formSelector, `submitPages "${key}" has no formSelector — nothing to submit`).toBeTruthy();
      expect(pages[key].isSqueezePage, `submitPages "${key}" is not a squeeze page (isSqueezePage: true)`).toBe(true);
    }
  });

  test('rejects an unknown submitPages page key', () => {
    const cfg = cloneConfig();
    cfg.submitPages = ['__does_not_exist__'];

    expect(() => resolveSubmitPages(cfg)).toThrow(/unknown page key "__does_not_exist__"/);
  });

  test('rejects a page with no form listed in submitPages', () => {
    const cfg = cloneConfig();
    const formless = Object.entries(cfg.pages).find(([, p]) => !p.formSelector);
    if (!formless) test.skip(true, 'every page in the config has a formSelector');

    cfg.submitPages = [formless[0]];

    expect(() => resolveSubmitPages(cfg)).toThrow(/has no formSelector/);
  });

  test('SUBMIT_PAGES overrides submitPages but still has to be valid', () => {
    const cfg = cloneConfig();
    const squeeze = Object.entries(cfg.pages).find(([, p]) => p.isSqueezePage && p.formSelector);
    expect(squeeze, 'config needs at least one squeeze page to test with').toBeTruthy();

    expect(resolveSubmitPages(cfg, `${squeeze[0]}, pricing`)).toContain(squeeze[0]);
    expect(() => resolveSubmitPages(cfg, 'pricing, __nope__')).toThrow(/unknown page key "__nope__"/);
  });

  // ── Submission-target ownership ────────────────────────────────────────────
  // A test claims a submission target either by running ON that page or by
  // FLOWING THROUGH to it (flowthroughDestination) — a flowthrough test has no
  // form of its own, so its submission happens on the destination squeeze page.
  const owningTest = (cfg = INSIGHT_CONFIG, key = (cfg.submitPages || [])[0]) =>
    findOwningTest(cfg, key);

  test('the first submission target is owned by a test', () => {
    const { submitPages = [] } = INSIGHT_CONFIG;
    expect(submitPages.length, 'submitPages is empty — nothing would be submitted').toBeGreaterThan(0);
    expect(
      owningTest(),
      `no test owns submitPages[0] "${submitPages[0]}" (tests[].page or flowthroughDestination)`,
    ).toBeTruthy();
  });

  test('a flowthrough test owns its destination squeeze page', () => {
    const cfg = cloneConfig();
    const dest = (cfg.tests[0].flowthroughDestination || [])[0];
    if (!dest) test.skip(true, 'no flowthroughDestination configured — nothing to bind');

    expect(owningTest(cfg, dest), `"${dest}" must be owned by the test flowing to it`).toBeTruthy();
    expect(cfg.tests[0].page, 'the flowthrough test itself must stay on its no-form page').not.toBe(dest);
  });

  test('a page no test reaches is not owned', () => {
    const cfg = cloneConfig();
    const owned = new Set(cfg.tests.flatMap((t) => [t.page, ...(t.flowthroughDestination || [])]));
    const stray = Object.keys(cfg.pages).find((k) => !owned.has(k));
    if (!stray) test.skip(true, 'every configured page is owned by a test');

    expect(owningTest(cfg, stray)).toBeNull();
  });

  // ── submitBucket ────────────────────────────────────────────────────────────
  // A submission run fires ONE bucket, picked here (the config UI's "Bucket to
  // submit" radio), and it has to be a bucket the test that OWNS the first
  // submission target actually ships — otherwise the run widens or no-ops.
  test('submitBucket is a bucket of the test owning the first submission target', () => {
    const { submitBucket, submitPages = [] } = INSIGHT_CONFIG;
    expect(submitPages.length, 'submitPages is empty — nothing would be submitted').toBeGreaterThan(0);
    expect(submitBucket, 'submitBucket is missing — a run would submit every bucket').toBeTruthy();

    const t = owningTest();
    expect(t, `no test owns submitPages[0] "${submitPages[0]}"`).toBeTruthy();
    expect(Object.keys(t.buckets), `submitBucket "${submitBucket}" is not a bucket of test ${t.testId}`)
      .toContain(submitBucket);
    expect(resolveSubmitBuckets(INSIGHT_CONFIG, '', Object.keys(t.buckets), submitPages[0]))
      .toEqual([submitBucket]);
  });

  test('rejects a submitBucket the owning test does not ship', () => {
    const cfg = cloneConfig();
    cfg.submitBucket = '__nope__';
    const t = owningTest(cfg);
    expect(t, 'config needs a test owning the first submission target').toBeTruthy();

    expect(() => resolveSubmitBuckets(cfg, '', Object.keys(t.buckets), cfg.submitPages[0]))
      .toThrow(new RegExp(`submit bucket "__nope__" for "${cfg.submitPages[0]}" is not one of the configured buckets`));
  });

  test('an explicit SUBMIT_BUCKETS wins over config.submitBucket', () => {
    const cfg = cloneConfig();
    const t = owningTest(cfg);
    expect(t, 'config needs a test owning the first submission target').toBeTruthy();
    const other = Object.keys(t.buckets).find((k) => k !== cfg.submitBucket);
    if (!other) test.skip(true, 'the owning test ships a single bucket — nothing else to pick');

    expect(resolveSubmitBuckets(cfg, other, Object.keys(t.buckets), cfg.submitPages[0])).toEqual([other]);
  });

  // ── Per-test exclusions (tests[].excludeExps) ──────────────────────────────
  // Some tests must also pin a sibling experiment at combi 1 (e.g.
  // `48=Disabling 1000`) so it can never bucket the session. The line belongs
  // to THAT test's snippet only — a test that doesn't declare one gets none.
  test('renders a per-test exclusion line into the snippet', () => {
    const snippet = buildCookieScript('69', '48=Disabling 1000');

    expect(snippet, 'the exclusion line, exactly as configured').toContain(
      `setCookie('_vis_opt_exp_48_combi', 1, 1); // Disabling 1000`
    );
    expect(snippet, 'the held experiment is still pinned').toContain(
      `setCookie('_vis_opt_exp_${HELD_EXP}_combi', 1, 1);`
    );
    expect(snippet, 'the test\'s own experiment still holds {{combi}}').toContain(
      `setCookie('_vis_opt_exp_69_combi', {{combi}}, 1);`
    );
  });

  test('a test with no excludeExps gets no exclusion line', () => {
    const snippet = buildCookieScript('69');
    expect(snippet).not.toContain('_vis_opt_exp_48');
    expect(parseExcludeExps('')).toEqual([]);
    expect(parseExcludeExps(undefined)).toEqual([]);
  });

  test('rejects a malformed excludeExps entry', () => {
    expect(() => buildCookieScript('69', 'forty-eight')).toThrow(/Invalid excludeExps entry "forty-eight"/);
    expect(() => buildCookieScript('69', '48=ok, 4a=nope')).toThrow(/Invalid excludeExps entry "4a=nope"/);
  });

  test('every configured excludeExps entry lands in its own rendered snippet', () => {
    let seen = 0;
    for (const t of tests) {
      for (const { exp, note } of parseExcludeExps(t.excludeExps)) {
        seen++;
        expect(t.cookieScript, `test ${t.testId} must pin exp ${exp}`).toContain(
          `setCookie('_vis_opt_exp_${exp}_combi', 1, 1);`
        );
        if (note) {
          expect(t.cookieScript, `test ${t.testId} must keep the "${note}" note`).toContain(`// ${note}`);
        }
      }
    }
    if (!seen) test.skip(true, 'no test configures excludeExps — nothing to assert');
  });
});

  // ── flowthroughPages (waypoints) ────────────────────────────────────────────
  // Waypoints are intermediate no-form pages walked before the terminal form.
  // They warn+skip (not throw) on ineligible entries, so the spec asserts the
  // resolved count rather than expecting a throw.

  test('flowthroughPages resolves only isFlowthrough non-under-test pages', () => {
    const cfg = cloneConfig();
    const plans = resolveTestPlans(cfg);
    for (const { flowthroughWaypoints } of plans) {
      for (const wp of flowthroughWaypoints) {
        expect(wp.isFlowthrough, `waypoint "${wp.label}" must be a flowthrough page`).toBe(true);
        expect(wp.isUnderTest,   `waypoint "${wp.label}" must not be under test`).toBe(false);
      }
    }
  });

  test('waypointTerminal is the squeeze-page-under-test or first destination', () => {
    const plans = resolveTestPlans(cloneConfig());
    for (const { flowthroughWaypoints, waypointTerminal, destinations } of plans) {
      if (flowthroughWaypoints.length === 0) {
        expect(waypointTerminal).toBeNull();
        continue;
      }
      // When waypoints exist, terminal must be a form page
      expect(waypointTerminal,         'waypointTerminal should be set when waypoints exist').toBeTruthy();
      expect(waypointTerminal.formSelector, 'waypointTerminal must have a formSelector').toBeTruthy();
    }
  });

  test('an under-test page listed in flowthroughPages is skipped with a warning', () => {
    const cfg = cloneConfig();
    const underTestFt = Object.entries(cfg.pages).find(([, p]) => p.isUnderTest && p.isFlowthrough);
    if (!underTestFt) { return; } // skip silently — config may not have one

    cfg.tests[0].flowthroughPages = [underTestFt[0]];
    // Should NOT throw — warns and skips
    const plans = resolveTestPlans(cfg);
    expect(plans[0].flowthroughWaypoints.find(wp => wp === cfg.pages[underTestFt[0]])).toBeFalsy();
  });

  test('an unknown flowthroughPages key is skipped with a warning', () => {
    const cfg = cloneConfig();
    cfg.tests[0].flowthroughPages = ['__no_such_page__'];
    // Should NOT throw
    const plans = resolveTestPlans(cfg);
    expect(plans[0].flowthroughWaypoints.length).toBe(0);
  });
