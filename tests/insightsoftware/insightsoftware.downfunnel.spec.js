/**
 * Insight Software — Down-funnel A/B QA (config-driven, mirrors the SailPoint suite)
 *
 * Structure and helper set match tests/sailpoint/sailpoint.downfunnel.spec.js so
 * both clients are QA'd the same way. Everything is derived from
 * config/insightsoftware.config.js:
 *
 *   pages.<key>.isUnderTest      → a test runs there (tests[].page must point here)
 *   pages.<key>.isFlowthrough    → no form: value CARRIES to flowthroughDestination
 *   tests[].flowthroughDestination → the form pages the value must reach
 *   tests[].cookieScript         → filled = PRELAUNCH (observe the bucket the
 *                                  site assigns); empty = A/A simulation
 *   tests[].buckets              → one test per bucket
 *
 * Two modes per test:
 *
 *   PRELAUNCH (cookieScript filled)
 *     1. loadBucket injects the dev activation snippet and retries until the
 *        site serves the target bucket (observed via CRO1 or the cookie)
 *     2. bucket signal asserted on the tested page
 *     3. for flowthrough pages: the value must carry to every destination —
 *        in the ExperimentValue cookie AND in the destination's CRO1
 *
 *   A/A (cookieScript empty)
 *     The deployed scripts are simulated: the experiment script sets the
 *     cookies, the web rollout writes CRO1 — proving the carry mechanism.
 *
 * Read-only: no form is ever submitted.
 */

import { test, expect } from '@playwright/test';
import { INSIGHT_CONFIG } from './config/insightsoftware.config.js';
import {
  loadBucket,
  getBodyClasses,
  getHiddenFieldValue,
  fieldHoldsValue,
  cookieHoldsValue,
  waitForFormField,
  waitForBucketSignal,
  screenshotWithCookies,
  gotoAndWait,
  logStep,
} from '../sailpoint/helpers/abtest.helpers.js';
import {
  generateExperimentScript,
  generateWebRolloutScript,
  getExperimentCookies,
  clearCacheAndCookies,
  acceptCookies,
  resolveTestPlans,
} from './helpers/abtest.helpers.js';

const { pages, tests, hiddenFields, clientDomain } = INSIGHT_CONFIG;

const slug = (label) => label.toLowerCase().replace(/\s+/g, '_');
const tokens = (raw) => String(raw || '').split(',').map(s => s.trim());

// Prelaunch needs room for the bucket retry loop; A/A is deterministic.
test.setTimeout(240_000);

// ─────────────────────────────────────────────────────────────────────────────
//  Per-test setup, derived from config
// ─────────────────────────────────────────────────────────────────────────────
// resolveTestPlans validates the config (page exists, is flagged isUnderTest,
// and every flowthroughDestination is a flowthrough page) — a bad config throws
// here, before any test runs. The same rules are asserted in
// insightsoftware.config.spec.js.
for (const { test: t, tested, destinations, flowthroughWaypoints, waypointTerminal, carries, prelaunch, mode, bucketList } of resolveTestPlans(INSIGHT_CONFIG)) {

  // ── Load the target bucket ────────────────────────────────────────────────
  // The activation script may be templated (e.g. {{combi}} for VWO), with the
  // per-bucket value coming from tests[].bucketActivation. An unresolved
  // placeholder is a config error, not something to run.
  const scriptFor = (bucketKey) => {
    const values = t.bucketActivation?.[bucketKey] || {};
    const missing = new Set();
    const script = t.cookieScript.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
      const v = values[key];
      // null/"" come from a cleared bucketActivation field in the config UI.
      // Treating them as unset keeps this a clear config error instead of
      // injecting e.g. setCookie(name, , 1) — a syntax error on the page.
      if (v === undefined || v === null || String(v).trim() === '') { missing.add(key); return match; }
      return String(v);
    });
    if (missing.size) {
      throw new Error(
        `Config error: test ${t.testId} bucket "${bucketKey}" cookieScript placeholder(s) ${[...missing].join(', ')} have no bucketActivation value`
      );
    }
    return script;
  };

  const loadTargetBucket = async (page, bucketKey) => {
    if (prelaunch) {
      const script = scriptFor(bucketKey);
      const target = t.buckets[bucketKey];

      if (!target.bodyClass) {
        // Control has no positive signal to wait for — forcing it is observable
        // only by the ABSENCE of every variant signal, which the test asserts
        // later. loadBucket would wait for a bucket that can never appear.
        logStep(`  [${bucketKey}] control bucket — forcing activation, will verify by absence`);
        await page.addInitScript(script);
        await gotoAndWait(page, tested.url);
        await acceptCookies(page);
        return;
      }

      // Observe what the live site assigns once the dev snippet activates it.
      await loadBucket(page, bucketKey, tested.url, script, t.buckets, hiddenFields.cro1, tested.formSelector, 15);
      return;
    }

    // A/A: simulate the deployed experiment script, then let the rollout write CRO1.
    logStep(`  A/A simulation — injecting experiment script for #${t.testId} (${bucketKey})`);
    await page.goto(tested.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await acceptCookies(page);
    await clearCacheAndCookies(page);

    const expScript = generateExperimentScript(
      t.testId,
      t.buckets[bucketKey].expectedValue,
      clientDomain,
      tested.isSqueezePage ? 'both' : false
    );
    await page.evaluate((script) => { eval(script); }, expScript); // eslint-disable-line no-eval

    // Assert the cookies the injection produced BEFORE re-navigating — the
    // site's own live experiment scripts can rewrite ExperimentValue on a fresh
    // page load, which would mask whether our injection actually worked.
    const cookies = await getExperimentCookies(page);
    console.log(`  ExperimentName : "${cookies.experimentName}"`);
    console.log(`  ExperimentValue: "${cookies.experimentValue}"`);
    expect(cookies.experimentName, 'ExperimentName should be set').toBeTruthy();
    expect(cookies.experimentValue, 'ExperimentValue should be set').toBeTruthy();
    expect(
      tokens(cookies.experimentValue),
      `ExperimentValue should contain "${t.buckets[bucketKey].expectedValue}"`
    ).toContain(t.buckets[bucketKey].expectedValue);

    // Fresh navigation so the page picks the cookies up like a real visitor.
    await page.goto(tested.url, { waitUntil: 'load' });
    await acceptCookies(page);
  };

  // Injects the web rollout so CRO1 gets written (A/A only — in prelaunch the
  // site's own rollout does it).
  const injectRollout = async (page) => {
    if (prelaunch) return;
    const rollout = generateWebRolloutScript(t.hiddenFieldSelector || 'input[name="cro1"]');
    await page.evaluate((script) => { eval(script); }, rollout); // eslint-disable-line no-eval
    await page.waitForTimeout(3000);
  };

  // ───────────────────────────────────────────────────────────────────────────
  //  Tests — one per bucket
  // ───────────────────────────────────────────────────────────────────────────
  for (const [bucketKey, bucket] of Object.entries(t.buckets)) {
    test(`${t.testName} [${bucket.label}] (${mode})`, async ({ page }) => {
      const expectedValue = bucket.expectedValue;
      let step = 1;

      // Screenshot helper — every step gets one, and a failure still leaves
      // evidence in the persistent folder instead of only test-results/.
      const shot = async (name, formSel, extra = {}) => {
        try {
          await screenshotWithCookies(page, name, hiddenFields, formSel, undefined, {
            stepLabel:  extra.stepLabel,
            bucketLabel: bucket.label,
            bucketValue: extra.bucketValue ?? expectedValue,
            showCookieCarry: extra.showCookieCarry ?? carries,
          });
        } catch (e) {
          console.log(`  screenshot "${name}" failed: ${e.message.split('\n')[0]}`);
        }
      };

      try {
        logStep(`Loading ${bucket.label} bucket on ${tested.label}… [${mode}]`);
        await loadTargetBucket(page, bucketKey);

        // ── 1. Bucket signal on the tested page ──────────────────────────────
        // A bucket can be proved by ANY of its configured signals — body class,
        // CRO field, or the ExperimentValue cookie (Insight uses all three).
        // Control has no body class, so for control "no variant signal" IS the
        // expected result.
        //
        // NB: capture the signal AND the screenshot together, before any slow
        // wait below — the page can re-render mid-wait and land in a different
        // bucket, which would make the filename disagree with the picture.
        logStep(`[${bucketKey}] ${step}. Bucket signal on ${tested.label}`);
        await injectRollout(page);

        const landed = await waitForBucketSignal(page, bucketList, hiddenFields.cro1, tested.formSelector, 20000);
        const bodyClasses = await getBodyClasses(page);

        console.log(`  ${tested.label} bucket signal : ${landed ? landed.label : 'NONE'}`);
        console.log(`  ${tested.label} body classes  : ${bodyClasses || '(none)'}`);

        if (bucket.bodyClass) {
          expect(
            landed && landed.key === bucketKey,
            `${tested.label} should be in bucket "${bucket.label}" (body class "${bucket.bodyClass}") — signal was ${landed ? landed.label : 'NONE'}, classes: "${bodyClasses}"`
          ).toBe(true);
        } else {
          expect(
            !landed || landed.key === bucketKey,
            `${tested.label} is control (no body class) but variant signal "${landed ? landed.label : ''}" was present, classes: "${bodyClasses}"`
          ).toBe(true);
        }

        await shot(`${step}_${slug(tested.label)}_${bucketKey}`, tested.formSelector, {
          stepLabel: `Step ${step}: bucket signal on ${tested.label} — ${landed ? landed.label : 'no variant signal'}`,
        });
        step++;

        // ── 2. Hidden-field value on the tested page (form pages only) ───────
        if (!carries) {
          const fieldVal = await waitForFormField(page, tested.formSelector, hiddenFields.cro1, { timeout: 20000, scrollInterval: 1500 });
          const classesAfter = await getBodyClasses(page);
          console.log(`  ${tested.label} ${hiddenFields.cro1} : ${JSON.stringify(fieldVal)}`);
          if (classesAfter !== bodyClasses) {
            console.log(`  WARNING: body classes changed while waiting for the field:`);
            console.log(`     before: "${bodyClasses}"`);
            console.log(`     after : "${classesAfter}"`);
          }
          if (fieldVal === null) {
            console.log(`  ${tested.label}: no ${hiddenFields.cro1} input — bucket proved by ${bucket.bodyClass || 'value/cookie'} alone`);
          } else {
            expect(
              fieldVal === expectedValue,
              `${tested.label} ${hiddenFields.cro1} should be "${expectedValue}" for bucket "${bucket.label}" but was ${JSON.stringify(fieldVal)}`
            ).toBe(true);

            await shot(`${step}_${slug(tested.label)}_field_${bucketKey}`, tested.formSelector, {
              stepLabel: `Step ${step}: ${tested.label} ${hiddenFields.cro1} = ${JSON.stringify(fieldVal)}`,
            });
            step++;
          }
        } else {
          // Flowthrough page (no form): the cookie is the real carry signal.
          const carriesHere = await cookieHoldsValue(page, expectedValue);
          console.log(`  ${tested.label} cookie carries "${expectedValue}": ${carriesHere}`);
          expect(
            carriesHere,
            `${tested.label} should carry bucket "${bucket.label}" in a cookie (flowthrough pages have no form field)`
          ).toBe(true);
        }

        // ── 2b. Flowthrough waypoints (optional) ─────────────────────────────
        // Walk each no-form page in order (e.g. home → products → pricing),
        // screenshot the SPZ cookie on each, and assert the df value survives
        // every hop. Then assert the final form page (terminal) has the value
        // in its hidden field.
        if (flowthroughWaypoints.length > 0) {
          const wpFailures = [];

          for (const wp of flowthroughWaypoints) {
            logStep(`[${bucketKey}] ${step}. Waypoint ${wp.label} — df value must carry (cookie)`);
            try {
              await gotoAndWait(page, wp.url);
              await acceptCookies(page);

              let carried = await cookieHoldsValue(page, expectedValue);
              for (let i = 0; i < 10 && !carried; i++) {
                await page.waitForTimeout(1000);
                carried = await cookieHoldsValue(page, expectedValue);
              }
              console.log(`  ${wp.label} body classes: "${await getBodyClasses(page)}"`);
              console.log(`  ${wp.label} cookie carries "${expectedValue}": ${carried}`);

              await shot(`${step}_waypoint_${slug(wp.label)}_${bucketKey}`, wp.formSelector, {
                stepLabel: `Step ${step}: waypoint ${wp.label} — df value must carry`,
                showCookieCarry: true,
              });

              if (!carried) wpFailures.push(`${wp.label}: df cookie lost at this waypoint`);
            } catch (e) {
              wpFailures.push(`${wp.label}: ${e.message.split('\n')[0]}`);
            }
            step++;
          }

          // Terminal: assert the df value is in the hidden field on the final
          // form page (squeeze-page-under-test, or first flowthroughDestination).
          if (waypointTerminal) {
            logStep(`[${bucketKey}] ${step}. Waypoint terminal: ${waypointTerminal.label} — df value must be in hidden field`);
            try {
              await gotoAndWait(page, waypointTerminal.url);
              await acceptCookies(page);
              await injectRollout(page);

              const termVal = await waitForFormField(
                page, waypointTerminal.formSelector, hiddenFields.cro1,
                { timeout: 20000, scrollInterval: 2000 }
              );
              const inField = termVal !== null && tokens(termVal).includes(expectedValue);
              console.log(`  ${waypointTerminal.label} ${hiddenFields.cro1} = ${JSON.stringify(termVal)} → has "${expectedValue}": ${inField}`);

              await shot(`${step}_waypoint_terminal_${slug(waypointTerminal.label)}_${bucketKey}`, waypointTerminal.formSelector, {
                stepLabel: `Step ${step}: waypoint terminal — ${waypointTerminal.label} hidden field`,
              });

              if (!inField) wpFailures.push(`Terminal ${waypointTerminal.label}: ${hiddenFields.cro1} does not hold "${expectedValue}" after full journey (was ${JSON.stringify(termVal)})`);
            } catch (e) {
              wpFailures.push(`Terminal ${waypointTerminal.label}: ${e.message.split('\n')[0]}`);
            }
            step++;
          }

          if (wpFailures.length > 0) {
            throw new Error(`Waypoint journey failed — see screenshots:\n  ${wpFailures.join('\n  ')}`);
          }
        }

        // ── 3. Downstream destinations (flowthrough pages only) ────────────────
        if (carries) {
          const destFailures = [];
          for (const dest of destinations) {
            logStep(`[${bucketKey}] ${step}. ${tested.label} → ${dest.label}: value must CARRY to`);
            await gotoAndWait(page, dest.url);
            await acceptCookies(page);
            await injectRollout(page);

            const carried = await cookieHoldsValue(page, expectedValue);
            const destVal = await waitForFormField(page, dest.formSelector, hiddenFields.cro1, { timeout: 20000, scrollInterval: 1500 });
            const inField  = destVal !== null && tokens(destVal).includes(expectedValue);

            console.log(`  ${dest.label} ExperimentValue cookie carries "${expectedValue}": ${carried}`);
            console.log(`  ${dest.label} ${hiddenFields.cro1} holds "${expectedValue}": ${inField} (value: ${JSON.stringify(destVal)})`);

            await shot(`${step}_${slug(dest.label)}_${bucketKey}`, dest.formSelector, {
              stepLabel: `Step ${step}: ${tested.label} → ${dest.label} — value must CARRY to`,
              showCookieCarry: true,
            });
            step++;

            if (!carried) destFailures.push(`${dest.label}: cookie does not carry "${expectedValue}"`);
            if (!inField)  destFailures.push(`${dest.label}: ${hiddenFields.cro1} does not hold "${expectedValue}" (was ${JSON.stringify(destVal)})`);
          }
          expect(destFailures, `Carry check failed — see screenshots: ${destFailures.join(' | ')}`).toEqual([]);
        }
      } catch (err) {
        // A timeout closes the page, so this must not throw a second time.
        await shot(`FAILED_step${step}_${slug(tested.label)}_${bucketKey}`, tested.formSelector, {
          stepLabel: `FAILED at step ${step}: ${String(err.message || err).split('\n')[0]}`,
        });
        throw err;
      }
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Negative test — the value must NOT leak onto OTHER form pages
  // ───────────────────────────────────────────────────────────────────────────
  // Insight's rollout is supposed to stamp CRO1 only where the value belongs.
  // On a form-page test this asserts the value does NOT appear in the CRO1 of
  // any other isFlowthrough=false page, so a wrongly-scoped rollout is caught.
  if (!carries) {
    const otherFormPages = Object.entries(pages)
      .filter(([key, p]) => !p.isFlowthrough && key !== t.page)
      .map(([key, p]) => p);

    for (const [bucketKey, bucket] of Object.entries(t.buckets)) {
      test(`${t.testName} [${bucket.label}] (${mode}) — must NOT leak to other form pages`, async ({ page }) => {
        const expectedValue = bucket.expectedValue;
        logStep(`[${bucketKey}] Loading ${bucket.label} on ${tested.label} to test for cross-page leak… [${mode}]`);
        await loadTargetBucket(page, bucketKey);

        const leaks = [];
        for (const other of otherFormPages) {
          await gotoAndWait(page, other.url);
          await acceptCookies(page);
          await injectRollout(page);

          const val = await waitForFormField(page, other.formSelector, hiddenFields.cro1, { timeout: 20000, scrollInterval: 1500 });
          const leaked = val !== null && tokens(val).includes(expectedValue);

          console.log(`  ${other.label} ${hiddenFields.cro1} = ${JSON.stringify(val)} → leaked: ${leaked}`);

          if (leaked) {
            leaks.push(other.label);
            await screenshotWithCookies(page, `leak_${slug(other.label)}_${bucketKey}`, hiddenFields, other.formSelector, undefined, {
              stepLabel:  `LEAK: "${expectedValue}" found on ${other.label}`,
              bucketLabel: bucket.label,
              bucketValue: expectedValue,
            });
          }
        }

        expect(
          leaks,
          `"${expectedValue}" leaked onto other form pages: ${leaks.join(', ') || 'none'}`
        ).toEqual([]);
      });
    }
  }
}
