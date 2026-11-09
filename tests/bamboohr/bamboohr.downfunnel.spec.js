/**
 * BambooHR A/B Test – Down-Funnel QA (config-driven)
 *
 * Every page marked `isUnderTest: true` in bamboohr.config.js is a page being
 * tested; every remaining FORM page is a downstream destination. Assertions
 * adapt automatically to the page type:
 *
 *   isFlowthrough: true  (e.g. Homepage / Pricing — no form)
 *     → value CARRIES to downstream forms via the SPZ cookie
 *   isFlowthrough: false (e.g. Demo — has a form)
 *     → value stays here, does NOT carry to other forms
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
 */

// @ts-check
import { test, expect } from '@playwright/test';
import { TEST_CONFIG } from './config/bamboohr.config.js';
import {
  loadBucket,
  assertBodyClass,
  getBodyClasses,
  assertHiddenFields,
  getHiddenFieldValue,
  fieldHoldsValue,
  cookieHoldsValue,
  screenshotWithCookies,
  gotoAndWait,
  logStep,
} from './helpers/abtest.helpers.js';

const {
  pages,
  cookieScript,
  hiddenFields,
  buckets,
} = TEST_CONFIG;

// ── Dynamic test layout, derived from config ─────────────────────────────────
// Every page marked isUnderTest: true is a tested page (one or more). Downstream
// destinations are the remaining form pages (flowthrough pages are not
// destinations — they either are tested pages or are skipped).
const testedPages  = Object.values(pages).filter(p => p.isUnderTest);
const destinations = Object.values(pages).filter(p => !p.isUnderTest && !p.isFlowthrough && p.formSelector);
const bucketList   = Object.entries(buckets).map(([key, b]) => ({ key, ...b }));

if (testedPages.length === 0) {
  test('BambooHR down-funnel — no page under test', () => {
    test.skip(true, 'Config error: mark the page(s) under test with `isUnderTest: true` in bamboohr.config.js');
  });
} else {

const slug = (label) => label.toLowerCase().replace(/\s+/g, '_');

// cookieScript is a PHASE MARKER for bhr (no snippet to inject): filled →
// PRELAUNCH label, empty → POSTLAUNCH. Either way the suite only OBSERVES
// buckets — ?spz-qa=true on the page URLs is what loads the test.
const isLive = !cookieScript.trim();
const mode   = isLive ? 'LIVE (postlaunch)' : 'PRELAUNCH';

// Bucket-loading retries against a 50/50 randomiser, so a test can legitimately
// take several attempts. Give it room instead of fighting the 30s default:
// each attempt waits up to 15s for a bucket signal, and up to 10 attempts must
// fit before the test-level timeout cuts the retry loop short (otherwise you'd
// see "Test timeout" instead of the clear "could not load bucket" error when a
// test isn't actually live). Prelaunch also needs headroom for Cloudflare/WAF
// backoff (~15s per block). Both phases share the same observe/retry loop, so
// both get the full budget.
test.setTimeout(240_000);

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
        await cookieHoldsValue(page, expectedValue);
      console.log(`  ${p.label} body classes: "${bodyClasses}"`);
      expect(
        bucketOk,
        `${p.label} should show bucket "${bucket.label}" (body class or SPZ value cookie)`
      ).toBe(true);
    }
    await screenshotWithCookies(page, `1_bucket_signal_${bucket.key}_${slug(p.label)}`, hiddenFields, p.formSelector);
    step++;
  }

  // ── 2. CRO fields on tested pages' forms (only for variants — control may
  //      not populate the hidden field at all, so skip this step)  ───────────
  if (bucket.bodyClass) {
    for (const p of testedPages.filter(pp => !pp.isFlowthrough)) {
      logStep(`[${bucket.key}] ${step}. Assert CRO hidden fields on ${p.label} form`);
      await gotoAndWait(page, p.url);
      await assertHiddenFields(
        page,
        { experimentName: expectedValue, experimentValue: expectedValue },
        hiddenFields,
        p.formSelector
      );
      await screenshotWithCookies(page, `2_${slug(p.label)}_form_${bucket.key}`, hiddenFields, p.formSelector);
      step++;
    }
  }

  // ── 3+. Downstream destinations ────────────────────────────────────────────
  // Flowthrough tested page → value CARRIES to destinations via the SPZ value
  // cookie (that is the documented carry mechanism — form fields on other pages
  // are not necessarily wired to read it).
  // Form tested page       → value must NOT appear in any destination form.
  for (const dest of destinations) {
    const action = carries ? 'value must CARRY to' : 'value must NOT carry to';
    logStep(`[${bucket.key}] ${step}. ${firstPage.label} → ${dest.label}: ${action}`);
    await gotoAndWait(page, dest.url);
    console.log(`  ${dest.label} body classes: "${await getBodyClasses(page)}"`);

    if (carries) {
      const carried = await cookieHoldsValue(page, expectedValue);
      console.log(`  ${dest.label} SPZ value cookie carries "${expectedValue}": ${carried}`);
      await screenshotWithCookies(page, `${step}_${slug(dest.label)}_${bucket.key}`, hiddenFields, dest.formSelector);
      expect(
        carried,
        `${dest.label} should carry "${expectedValue}" in the SPZ value cookie — flowthrough values carry via cookie`
      ).toBe(true);
    } else {
      const destValue = await getHiddenFieldValue(page, hiddenFields.experimentValue, dest.formSelector);
      console.log(`  ${dest.label} ${hiddenFields.experimentValue}: "${destValue}"`);
      await screenshotWithCookies(page, `${step}_${slug(dest.label)}_${bucket.key}`, hiddenFields, dest.formSelector);
      expect(
        await fieldHoldsValue(page, hiddenFields.experimentValue, dest.formSelector, expectedValue),
        `${dest.label} must NOT contain the ${firstPage.label} value — form page values do not carry forward`
      ).toBe(false);
    }
    step++;
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
      testedPages[0].formSelector
    );
    await runAssertions(page, bucket);
  });
}

} // end else (testedPages.length > 0)
