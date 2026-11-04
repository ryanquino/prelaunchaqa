/**
 * SailPoint A/B Test – Down-Funnel QA (config-driven)
 *
 * Every page marked `isUnderTest: true` in sailpoint.config.js is a page being
 * tested; every remaining FORM page is a downstream destination. Assertions
 * adapt automatically to the page type:
 *
 *   isFlowthrough: true  (e.g. Homepage / Products — no form)
 *     → value CARRIES to downstream forms via the SPZ cookie AND the
 *       destination form's CRO hidden field must hold the value too
 *   isFlowthrough: false (e.g. Contact Us — has a tabbed form)
 *     → value stays here, does NOT carry to other forms
 *     → (tabbed forms) switching tabs unmounts the Marketo form; the suite
 *       cycles every tab and asserts the down-funnel value survives when the
 *       user returns to the form tab.
 *
 * Bucket detection (driven by the `buckets` config):
 *   Each bucket is identified by its body class, its CRO hidden-field value, or
 *   on flowthrough pages, the `ExperimentValue` cookie. One test runs per bucket.
 *
 * Prelaunch vs postlaunch (driven by `cookieScript` in the config):
 *   cookieScript FILLED IN  → PRELAUNCH. The snippet is injected to activate
 *     the test and force each bucket, then carry-over is verified.
 *   cookieScript EMPTY      → POSTLAUNCH (live). Nothing is injected — each
 *     fresh navigation gets whatever bucket live traffic gets (~50/50), and
 *     the retry loop still lands on both buckets.
 *
 * Field-name reference (Janak update) — verified against the live page:
 *   intellimize1 = CRO1 = ExperimentName — on the Discovery Tool it also carries the value
 *   intellimize2 = CRO2 = ExperimentValue — stays empty on the Discovery Tool
 */

// @ts-nocheck
import { test, expect } from '@playwright/test';
import { TEST_CONFIG } from './config/sailpoint.config.js';
import {
  resolvePlan,
  loadBucket,
  assertBodyClass,
  getBodyClasses,
  assertHiddenFields,
  getHiddenFieldValue,
  fieldHoldsValue,
  cookieHoldsValue,
  readSpzCookie,
  waitForFormField,
  waitForBucketSignal,
  screenshotWithCookies,
  gotoAndWait,
  logStep,
} from './helpers/abtest.helpers.js';

const { pages, cookieScript, hiddenFields, buckets, spzCookies } = TEST_CONFIG;
// SPZ namespaces the bucket cookie per test id (HiddenFieldValue3018 for #3018).
// Reading it by name is precise; cookieHoldsValue falls back to a value scan if
// the cookie is missing (e.g. the site renames it again).
const SPZ_VALUE_COOKIE = spzCookies?.value ?? '';

// ── Dynamic test layout, derived from config ─────────────────────────────────
// resolvePlan throws on a bad config (unknown/ineligible destination key,
// unknown interruption key, no page under test) so a typo fails loudly here
// instead of silently testing fewer pages.
const {
  testedPages,
  destinations,
  interruptionPages,
  flowthroughWaypoints,
  waypointTerminal,
  bucketList,
  configuredDestinationKeys,
  isLive,
  mode,
} = resolvePlan(TEST_CONFIG);

if (flowthroughWaypoints.length) {
  console.log(`  flowthroughPages (waypoints): ${flowthroughWaypoints.map(w => w.label).join(', ')}\n`);
}

if (configuredDestinationKeys && configuredDestinationKeys.length) {
  console.log(`\n  flowthroughDestination: ${JSON.stringify(configuredDestinationKeys)}`);
  console.log(`  destinations resolved to: ${destinations.map(d => d.label).join(', ') || '(none)'}\n`);
} else {
  console.log(`\n  flowthroughDestination: (not set — using automatic derivation)`);
  console.log(`  destinations resolved to: ${destinations.map(d => d.label).join(', ') || '(none)'}\n`);
}

const slug = (label) => label.toLowerCase().replace(/\s+/g, '_');

// isLive / mode come from resolvePlan (empty cookieScript → POSTLAUNCH/live).

// Bucket-loading retries against a 50/50 randomiser, so a test can legitimately
// take several attempts. Give it room instead of fighting the 30s default.
// Live mode needs more: each attempt waits up to 15s for a bucket signal, and
// up to 10 attempts must fit before the test-level timeout cuts the retry loop
// short (otherwise you'd see "Test timeout" instead of the clear "could not
// load bucket" error when a test isn't actually live).
// Prelaunch also needs headroom for Cloudflare/WAF backoff (~15s per block).
// True-control buckets (no code changes) can be served sparingly in QA mode —
// the retry loop needs a bigger budget for prelaunch so a rare control still
// gets captured instead of erroring after 10 fast mis-hits. Prelaunch also gets
// a long budget because the run now visits EVERY downstream destination (not
// stopping at the first failure) to produce evidence screenshots for them all —
// 8 destinations × a settled form-field wait each can exceed 5 minutes once a
// rare control took many load attempts on top.
test.setTimeout(isLive ? 240_000 : 450_000);

// ─────────────────────────────────────────────────────────────────────────────
//  SHARED — run all assertions for a given bucket
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {import('@playwright/test').Page} page
 * @param {{ key: string, label: string, bodyClass: string, expectedValue: string }} bucket
 */
async function runAssertions(page, bucket) {
  const expectedValue = bucket.expectedValue;
  const carries       = testedPages.some(p => p.isFlowthrough);
  const firstPage     = testedPages[0];
  const pageSlug      = slug(firstPage.label);
  let step = 1;

  // ── 1. Bucket signal on EVERY tested page ──────────────────────────────────
  // loadBucket already confirmed the bucket on the first tested page; for each
  // additional one we navigate and assert the signal (body class, hidden-field
  // value, or — on flowthrough pages with no form — the SPZ value cookie).
  for (const p of testedPages) {
    logStep(`[${bucket.key}] ${step}. Assert bucket signal on ${p.label}`);
    if (p !== firstPage) {
      await gotoAndWait(page, p.url);
      // SPZ buckets asynchronously after navigation — give it time to land
      // before asserting the signal (WAF / lazy scripts can delay it).
      const landed = await waitForBucketSignal(page, bucketList, hiddenFields.experimentValue, p.formSelector, 15000);
      console.log(`  ${p.label} bucket signal after wait: ${landed ? landed.label : 'NONE'}`);
    }

    if (!p.isFlowthrough) {
      // Form page — variant adds a body class; a true control (no class) is
      // confirmed by asserting that NO variant body class is present.
      if (bucket.bodyClass) {
        await assertBodyClass(page, bucket.bodyClass);
      } else {
        const classes = await getBodyClasses(page);
        const variantClasses = Object.values(buckets)
          .filter(b => b.bodyClass)
          .map(b => b.bodyClass);
        const hitVariant = variantClasses.find(c => classes.includes(c));
        console.log(`  ${p.label} body classes: "${classes}"`);
        expect(
          hitVariant,
          `${p.label} should NOT have any variant body class (control bucket) — found "${hitVariant}"`
        ).toBeUndefined();
      }
    } else {
      // Flowthrough page — bucket confirmed via body class OR SPZ cookie.
      const bodyClasses = await getBodyClasses(page);
      const bucketOk = (bucket.bodyClass && bodyClasses.includes(bucket.bodyClass)) ||
        await cookieHoldsValue(page, expectedValue, SPZ_VALUE_COOKIE);
      console.log(`  ${p.label} body classes: "${bodyClasses}"`);
      expect(
        bucketOk,
        `${p.label} should show bucket "${bucket.label}" (body class or SPZ value cookie)`
      ).toBe(true);
    }
    await screenshotWithCookies(page, `1_bucket_signal_${bucket.key}_${slug(p.label)}`, hiddenFields, p.formSelector, undefined, {
      stepLabel:  `Step 1: bucket signal on ${p.label}`,
      bucketLabel: bucket.label,
      bucketValue: bucket.expectedValue,
      showCookieCarry: p.isFlowthrough,
    });
    step++;
  }

  // ── 2. CRO fields on tested pages' forms (only for those with one) ─────────
  for (const p of testedPages.filter(pp => !pp.isFlowthrough)) {
    logStep(`[${bucket.key}] ${step}. Assert CRO hidden fields on ${p.label} form`);
    await gotoAndWait(page, p.url);
    // The SPZ rollout fills intellimize1 a few seconds AFTER load. gotoAndWait
    // only waits 1.5s, so reading straight away returns "" and the assertion
    // throws before the screenshot below ever runs.
    const fieldValue = await waitForFormField(page, p.formSelector, hiddenFields.experimentValue, { timeout: 20000, scrollInterval: 1500 });
    console.log(`  ${p.label} ${hiddenFields.experimentValue} = ${JSON.stringify(fieldValue)}`);
    await assertHiddenFields(
      page,
      { experimentName: expectedValue, experimentValue: expectedValue },
      hiddenFields,
      p.formSelector
    );
    await screenshotWithCookies(page, `2_${slug(p.label)}_form_${bucket.key}`, hiddenFields, p.formSelector, undefined, {
      stepLabel:  `Step 2: CRO hidden fields on ${p.label} form`,
      bucketLabel: bucket.label,
      bucketValue: bucket.expectedValue,
    });
    step++;

    // ── 2b. TABS (e.g. Contact Us Sales/Support/Locations): the form re-mounts
    // when switching tabs — the down-funnel value must still be there when the
    // user returns to the form tab. Runs automatically on ANY tabbed form page.
    if (await page.locator('button[role="tab"]').count() > 0) {
      logStep(`[${bucket.key}] ${step}. Tab persistence — df value must survive tab switches on ${p.label}`);
      const tabLabels = (await page.locator('button[role="tab"]').allInnerTexts()).map((t) => t.trim());
      const activeTab = (await page.locator('button[role="tab"][aria-selected="true"]').allInnerTexts())[0]?.trim() || tabLabels[0];
      const otherTabs = tabLabels.filter((t) => t && t !== activeTab);
      const baseline = String((await getHiddenFieldValue(page, hiddenFields.experimentValue)) || '');
      const baselineTokens = baseline.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      console.log(`  tabs: active="${activeTab}", others=${JSON.stringify(otherTabs)} | baseline ${hiddenFields.experimentValue} = "${baseline}"`);

      const waitForTabShape = (wantsFormTab, label) => page.waitForFunction(
        ({ wantsFormTab, label }) => {
          const active = [...document.querySelectorAll('button[role="tab"]')]
            .find((t) => t.getAttribute('aria-selected') === 'true');
          const hasIdForm = [...document.querySelectorAll('form.mktoForm')].some((f) => f.id);
          return wantsFormTab
            ? (hasIdForm && (!label || active?.innerText?.trim() === label))
            : (!hasIdForm && (!label || active?.innerText?.trim() === label));
        },
        { wantsFormTab, label },
        { timeout: 30000 }
      );

      // Cycle through every OTHER tab (form unmounts there).
      for (const [i, tabLabel] of otherTabs.entries()) {
        logStep(`[${bucket.key}] ${step}.${i + 1} Switch to "${tabLabel}" tab`);
        await page.locator('button[role="tab"]').filter({ hasText: tabLabel }).first().click();
        await waitForTabShape(false, tabLabel);
      }

      // Back to the form tab — every df value must have persisted.
      logStep(`[${bucket.key}] ${step}.${otherTabs.length + 1} Back to "${activeTab}" tab — df value must persist`);
      await page.locator('button[role="tab"]').filter({ hasText: activeTab }).first().click();
      await waitForTabShape(true, activeTab);
      const after = await waitForFormField(page, p.formSelector, hiddenFields.experimentValue, { timeout: 25000, scrollInterval: 2000 });
      const afterTokens = String(after || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      console.log(`  ${activeTab} tab after re-render ${hiddenFields.experimentValue} = "${after}"`);

      for (const token of baselineTokens) {
        expect(
          afterTokens.includes(token),
          `After tab-switching, ${hiddenFields.experimentValue} on ${p.label} must still contain "${token}" (down-funnel value lost on re-render)`
        ).toBe(true);
      }
      expect(
        await fieldHoldsValue(page, hiddenFields.experimentValue, p.formSelector, expectedValue),
        `${p.label} ${hiddenFields.experimentValue} must still hold "${expectedValue}" after tab switches (form re-render dropped the value)`
      ).toBe(true);
      const bodyAfter = await getBodyClasses(page);
      console.log(`  ${p.label} body classes after tab cycle: "${bodyAfter}"`);
      if (bucket.bodyClass) {
        expect(
          bodyAfter.includes(bucket.bodyClass),
          `${p.label} bucket body class "${bucket.bodyClass}" must persist after tab re-render`
        ).toBe(true);
      }
      await screenshotWithCookies(page, `${step}_back_to_${slug(activeTab)}_${bucket.key}`, hiddenFields, p.formSelector, undefined, {
      stepLabel:  `Step ${step}: back to "${activeTab}" tab — df value persisted`,
      bucketLabel: bucket.label,
      bucketValue: bucket.expectedValue,
    });
      step++;
    }
  }

  // ── 2c. Flowthrough under-test pages that ALSO have a form (e.g. homepage): ──
  // their own hidden field must hold the df value too (the spec lists the
  // homepage as a page where values are written into intellimize1).
  for (const p of testedPages.filter(pp => pp.isFlowthrough)) {
    logStep(`[${bucket.key}] ${step}. ${p.label} own form df value`);
    await gotoAndWait(page, p.url);
    const ownVal = await waitForFormField(page, p.formSelector, hiddenFields.experimentValue, { timeout: 15000 });
    if (ownVal === null) {
      console.log(`  ${p.label}: no ${hiddenFields.experimentValue} field on page (nothing to populate — ok)`);
    } else {
      console.log(`  ${p.label} ${hiddenFields.experimentValue} = "${ownVal}"`);
      expect(
        String(ownVal).split(/[,;]/).map(s => s.trim()).filter(Boolean).includes(expectedValue),
        `${p.label} own form ${hiddenFields.experimentValue} must hold "${expectedValue}" (got "${ownVal}")`
      ).toBe(true);
    }
    await screenshotWithCookies(page, `${step}_${slug(p.label)}_own_form_${bucket.key}`, hiddenFields, p.formSelector, undefined, {
      stepLabel:  `Step ${step}: ${p.label} own form df value`,
      bucketLabel: bucket.label,
      bucketValue: bucket.expectedValue,
      showCookieCarry: p.isFlowthrough,
    });
    step++;
  }

  // ── 2d. Interruption pages: browsing a page OUTSIDE the test must not clear ──
  // the SPZ value cookie. Reproduces the reported #2038 edge case (home →
  // unrelated page → demo, cookie gone). The destination checks below run right
  // after, so they prove the value still reaches the target pages.
  const interruptFailures = [];
  if (interruptionPages.length) {
    for (const q of interruptionPages) {
      logStep(`[${bucket.key}] ${step}. Interruption: ${q.label} (outside the test) must not clear the value`);
      await gotoAndWait(page, q.url);

      const stillThere = await cookieHoldsValue(page, expectedValue, SPZ_VALUE_COOKIE);
      console.log(`  ${q.label} SPZ value cookie carries "${expectedValue}": ${stillThere}`);
      if (!stillThere) {
        interruptFailures.push(`${q.label}: value cookie lost after visiting a page outside the test`);
      }

      await screenshotWithCookies(page, `${step}_interruption_${slug(q.label)}_${bucket.key}`, hiddenFields, q.formSelector, undefined, {
        stepLabel:  `Step ${step}: interruption — ${q.label} (outside the test)`,
        bucketLabel: bucket.label,
        bucketValue: expectedValue,
        showCookieCarry: true,
      });
      step++;
    }
  }

  // ── 3. Flowthrough waypoints ───────────────────────────────────────────────
  // Intermediate no-form pages the user passes through on the way downstream
  // (enabled via `flowthroughPages` in the config). The df value must survive
  // each hop — asserted via the SPZ value COOKIE (the Cookie section in the
  // DevTools Application panel), NOT the hidden field: these pages have no
  // form, so the cookie is the only carrier. The screenshot's 🍪 panel shows
  // the same cookie list for evidence.
  // Token-based matching, so an appended multi-test value still matches.
  // Like destinations, every waypoint is visited even if one fails.
  const waypointFailures = [];
  for (const wp of flowthroughWaypoints) {
    logStep(`[${bucket.key}] ${step}. Flowthrough waypoint ${wp.label} — df value must carry (cookie check)`);
    const overlay = {
      stepLabel:  `Step ${step}: ${firstPage.label} → ${wp.label} — df value must carry`,
      bucketLabel: bucket.label,
      bucketValue: bucket.expectedValue,
      showCookieCarry: true,
    };
    try {
      await gotoAndWait(page, wp.url);

      // Poll the SPZ value cookie — SPZ can write it a beat after navigation.
      // No hidden-field read here: waypoints are no-form pages, so the cookie
      // (DevTools → Application → Cookies) is the ONLY carrier to check.
      let carried = await cookieHoldsValue(page, expectedValue, SPZ_VALUE_COOKIE);
      for (let i = 0; i < 10 && !carried; i++) {
        await page.waitForTimeout(1000);
        carried = await cookieHoldsValue(page, expectedValue, SPZ_VALUE_COOKIE);
      }
      const rawCookie = await readSpzCookie(page, SPZ_VALUE_COOKIE);

      console.log(`  ${wp.label} body classes: "${await getBodyClasses(page)}"`);
      console.log(`  ${wp.label} cookie ${SPZ_VALUE_COOKIE || '(any)'} = ${JSON.stringify(rawCookie)} → carries "${expectedValue}": ${carried}`);

      await screenshotWithCookies(page, `${step}_${slug(wp.label)}_${bucket.key}`, hiddenFields, wp.formSelector, undefined, overlay);
      expect(
        carried,
        `${wp.label} should still carry the df value "${expectedValue}" in the ${SPZ_VALUE_COOKIE || 'value'} cookie (Cookie section) — visited as a flowthrough waypoint but the cookie lost the value`
      ).toBe(true);
    } catch (e) {
      waypointFailures.push(`${wp.label}: ${e.message.split('\n')[0]}`);
      console.log(`  FAILED on ${wp.label}: ${e.message.split('\n')[0]}`);
    }
    step++;
  }

  // ── 3b. Waypoint terminal: after walking all flowthrough pages, assert that
  //        the df value is appended in the hidden field on the final form page.
  //        Terminal = squeeze page under test (if one exists) OR the first
  //        flowthroughDestination. This proves the full journey end-to-end.
  if (flowthroughWaypoints.length > 0 && waypointTerminal) {
    logStep(`[${bucket.key}] ${step}. Waypoint terminal: ${waypointTerminal.label} — df value must be in hidden field after full journey`);
    const terminalOverlay = {
      stepLabel:  `Step ${step}: waypoint terminal — ${waypointTerminal.label} (end of flowthrough journey)`,
      bucketLabel: bucket.label,
      bucketValue: bucket.expectedValue,
    };
    try {
      await gotoAndWait(page, waypointTerminal.url);
      console.log(`  ${waypointTerminal.label} body classes: "${await getBodyClasses(page)}"`);

      const terminalVal = await waitForFormField(
        page,
        waypointTerminal.formSelector,
        hiddenFields.experimentValue,
        { timeout: 20000, scrollInterval: 2000 }
      );
      console.log(`  ${waypointTerminal.label} ${hiddenFields.experimentValue} = "${terminalVal}"`);

      await screenshotWithCookies(
        page,
        `${step}_waypoint_terminal_${slug(waypointTerminal.label)}_${bucket.key}`,
        hiddenFields,
        waypointTerminal.formSelector,
        undefined,
        terminalOverlay
      );

      const terminalTokens = String(terminalVal || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
      expect(
        terminalTokens.includes(expectedValue),
        `${waypointTerminal.label} ${hiddenFields.experimentValue} must contain "${expectedValue}" after walking the full flowthrough journey — got "${terminalVal}"`
      ).toBe(true);
    } catch (e) {
      waypointFailures.push(`Terminal ${waypointTerminal.label}: ${e.message.split('\n')[0]}`);
      console.log(`  FAILED on terminal ${waypointTerminal.label}: ${e.message.split('\n')[0]}`);
    }
    step++;
  }

  // ── 4+. Downstream destinations ────────────────────────────────────────────
  // Flowthrough tested page → value CARRIES to destinations via the SPZ value
  // cookie (that is the documented carry mechanism — form fields on other pages
  // are not necessarily wired to read it).
  // Form tested page       → value must NOT appear in any destination form.
  // Each destination is checked even if an earlier one fails, so the evidence
  // screenshots cover EVERY flowthrough page for this variant/control bucket —
  // assertions only aggregate and fail the test once all pages were visited.
  const destFailures = [];
  for (const dest of destinations) {
    const action = carries ? 'value must CARRY to' : 'value must NOT carry to';
    logStep(`[${bucket.key}] ${step}. ${firstPage.label} → ${dest.label}: ${action}`);
    const overlay = {
      stepLabel:  `Step ${step}: ${firstPage.label} → ${dest.label} — ${action}`,
      bucketLabel: bucket.label,
      bucketValue: bucket.expectedValue,
    };
    try {
    await gotoAndWait(page, dest.url);
    console.log(`  ${dest.label} body classes: "${await getBodyClasses(page)}"`);

    if (carries) {
      const carried = await cookieHoldsValue(page, expectedValue, SPZ_VALUE_COOKIE);
      // Wait for the (lazy-loaded) destination form to render, then read the
      // CRO hidden field — an empty value means the form loaded but was never
      // populated; null means the field never appeared at all.
      const fieldVal = await waitForFormField(page, dest.formSelector, hiddenFields.experimentValue);
      const inField  = fieldVal !== null &&
        String(fieldVal).split(/[,;]/).map(s => s.trim()).filter(Boolean).includes(expectedValue);
      console.log(`  ${dest.label} SPZ value cookie carries "${expectedValue}": ${carried}`);
      console.log(`  ${dest.label} ${hiddenFields.experimentValue} field holds "${expectedValue}": ${inField} (value: ${JSON.stringify(fieldVal)})`);
      await screenshotWithCookies(page, `${step}_${slug(dest.label)}_${bucket.key}`, hiddenFields, dest.formSelector, undefined, overlay);
      expect(
        carried,
        `${dest.label} should carry "${expectedValue}" in the SPZ value cookie — flowthrough values carry via cookie`
      ).toBe(true);
      // Flowthrough values carry via the cookie AND the CRO hidden field must
      // be populated on the destination form too — an empty field means the
      // downstream form never received the value.
      expect(
        inField,
        `${dest.label} form field ${hiddenFields.experimentValue} must hold "${expectedValue}" — cookie carried but field was empty/absent`
      ).toBe(true);
    } else {
      // Form tested page → destination must NOT receive the value. Wait for the
      // destination form's CRO field to settle (populate with the page's own
      // experiment, if any) first, so the screenshot + assertion reflect the
      // final state instead of the pre-load empty field.
      const destValue = await waitForFormField(page, dest.formSelector, hiddenFields.experimentValue, { timeout: 20000, scrollInterval: 2000 });
      console.log(`  ${dest.label} ${hiddenFields.experimentValue}: "${destValue}"`);
      await screenshotWithCookies(page, `${step}_${slug(dest.label)}_${bucket.key}`, hiddenFields, dest.formSelector, undefined, overlay);
      expect(
        await fieldHoldsValue(page, hiddenFields.experimentValue, dest.formSelector, expectedValue),
        `${dest.label} must NOT contain the ${firstPage.label} value — form page values do not carry forward`
      ).toBe(false);
    }
    } catch (e) {
      destFailures.push(`${dest.label}: ${e.message.split('\n')[0]}`);
      console.log(`  FAILED on ${dest.label}: ${e.message.split('\n')[0]}`);
    }
    step++;
  }
  if (destFailures.length > 0 || interruptFailures.length > 0 || waypointFailures.length > 0) {
    const parts = [];
    if (interruptFailures.length) {
      parts.push(`Interruption check failed on ${interruptFailures.length}/${interruptionPages.length} page(s) — value lost outside the test: ${interruptFailures.join(' | ')}`);
    }
    if (waypointFailures.length) {
      parts.push(`Flowthrough waypoint checks failed on ${waypointFailures.length}/${flowthroughWaypoints.length} page(s) — see screenshots: ${waypointFailures.join(' | ')}`);
    }
    if (destFailures.length) {
      parts.push(`Destination checks failed on ${destFailures.length}/${destinations.length} page(s) — see screenshots: ${destFailures.join(' | ')}`);
    }
    throw new Error(parts.join(' || '));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TESTS — one per bucket in the config
// ─────────────────────────────────────────────────────────────────────────────
for (const bucket of bucketList) {
  test(`${bucket.label.toUpperCase()} | ${TEST_CONFIG.testName} – ${testedPages[0].label} (${mode})`, async ({ page }) => {
    logStep(`Loading ${bucket.label} bucket on ${testedPages[0].url}… [${mode}]`);
    await loadBucket(
      page,
      bucket.key,
      testedPages[0].url,
      cookieScript,
      buckets,
      hiddenFields.experimentValue,
      testedPages[0].formSelector,
      isLive ? 10 : 25   // prelaunch: rare true-control needs more fresh sessions
    );
    await runAssertions(page, bucket);
  });
}
