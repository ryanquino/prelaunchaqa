/**
 * Goddard School Franchise — Down-Funnel values spec
 *
 * Read-only: NO form submissions. Runs against every page marked
 * `isUnderTest: true` in goddard.config.js.
 *
 *   • isFlowthrough: true  → START page (e.g. homepage). The suite still
 *                            navigates to `flowthroughDestination` (the form
 *                            page), but the down-funnel value under test is
 *                            the START page's OWN value — its cookie token
 *                            (e.g. spz_1010_control) must be present in the
 *                            destination's 0-1/cr01.
 *   • isFlowthrough: false → DESTINATION form page: landed directly, 0-1/cr01
 *                            must be populated with a bucket token per
 *                            expected experiment.
 *
 * BUCKET EVIDENCE — the rollout is live (50/50, no injection), so the suite
 * loops FRESH SESSIONS until BOTH buckets are observed for the page under
 * test, screenshotting each:
 *
 *   destination:  1_bucket_signal_<key>_variant|control.png
 *   flowthrough:  1_bucket_signal_<key>_variant|control.png   (start page df
 *                 2_flowthrough_<key>-to-<dest>_variant|control.png  value,
 *                                                                  checked on
 *                                                                  the form)
 *
 * The bucket used to split the screenshots is the FIRST expected experiment.
 */

import { test, expect } from '@playwright/test';
import { GODDARD_CONFIG } from './config/goddard.config.js';
import {
  gotoAndWait,
  getCookieSpzTokens,
  waitForCrField,
  assertCarriedIntoField,
  assertExpectedExperiments,
  screenshotDownfunnel,
} from './helpers/abtest.helpers.js';

test.setTimeout(300_000);

// Fresh sessions per bucket hunt — 50/50 live, 6 attempts ≈ 98% both buckets.
const SESSION_ATTEMPTS = 6;

const { name, pages, crFieldName, flowthroughDestination } = GODDARD_CONFIG;
const testedPages = Object.values(pages).filter((p) => p.isUnderTest);

if (testedPages.length === 0) {
  throw new Error('Config error: mark the page(s) under test with `isUnderTest: true` in goddard.config.js');
}

// Other form pages (non-flowthrough) that must NOT receive a destination's df value.
const nonFlowthroughPages = Object.values(pages).filter((p) => !p.isFlowthrough);

// ─────────────────────────────────────────────────────────────────────────────
//  SHARED
// ─────────────────────────────────────────────────────────────────────────────
/** Fresh session: drop cookies so SPZ re-randomizes the bucket. */
async function freshSession(page) {
  await page.context().clearCookies();
}

/** 'variant' | 'control' | null — bucket of the first expected experiment. */
function bucketOf(source, experimentId) {
  const m = String(source || '')
    .split(',').map((t) => t.trim())
    .find((t) => t === `spz_${experimentId}_variant` || t === `spz_${experimentId}_control`);
  return m ? m.split('_').pop() : null;
}

const expectedDisplayFor = (pageConfig) =>
  (pageConfig.expectedExperiments || []).map((id) => `spz_${id}_<variant|control>`).join(', ');

/**
 * Bucket evidence for a DESTINATION (non-flowthrough) page: iterate fresh
 * sessions, assert the down-funnel rules, and screenshot 0-1/cr01 once per
 * bucket seen. For each captured bucket, also visit every OTHER non-flowthrough
 * form page and assert the under-test df value does NOT pass onto those forms.
 * @returns {Promise<string[]>} captured bucket keys
 */
async function captureDestinationEvidence(page, pageConfig, otherForms) {
  const primaryExperiment = (pageConfig.expectedExperiments || [])[0];
  const captured = {};

  for (let i = 0; i < SESSION_ATTEMPTS && Object.keys(captured).length < 2; i++) {
    await freshSession(page);
    await gotoAndWait(page, pageConfig.url);

    const cookieTokens = await getCookieSpzTokens(page);
    const fieldValue = await waitForCrField(page, crFieldName);

    // Assert the down-funnel rules on every session we can read.
    assertExpectedExperiments(fieldValue, pageConfig.expectedExperiments || [], pageConfig.label, crFieldName);
    assertCarriedIntoField(fieldValue, cookieTokens, pageConfig.label, crFieldName);

    const bucket = bucketOf(fieldValue, primaryExperiment);
    if (!bucket || captured[bucket]) continue;
    captured[bucket] = { fieldValue, cookieTokens };

    console.log(`  bucket "${bucket}" seen → screenshot`);
    await screenshotDownfunnel(page, {
      label: `1_bucket_signal_${pageConfig.key}_${bucket}`,
      fieldName: crFieldName,
      fieldValue,
      expected: expectedDisplayFor(pageConfig),
      actual: fieldValue,
      experiments: pageConfig.expectedExperiments || [],
    });

    // The df value must NOT pass onto OTHER form pages (non-flowthrough).
    const sourceTokens = String(fieldValue || '').split(',').map((t) => t.trim()).filter(Boolean);
    for (const other of otherForms) {
      await gotoAndWait(page, other.url);
      const otherValue = await waitForCrField(page, crFieldName);
      const otherTokens = String(otherValue || '').split(',').map((t) => t.trim()).filter(Boolean);
      const leaked = sourceTokens.filter((t) => otherTokens.includes(t));

      expect(
        leaked.length === 0,
        `${other.label} must NOT receive the ${pageConfig.label} df value (${sourceTokens.join(', ')}); found leaked: ${JSON.stringify(leaked)}`
      ).toBe(true);

      console.log(`  ${bucket}: ${other.label} does NOT carry ${pageConfig.label} df value ✓`);
      await screenshotDownfunnel(page, {
        label: `3_no_flow_${other.key}_${bucket}`,
        fieldName: crFieldName,
        fieldValue: otherValue,
        expected: `${pageConfig.label} df value must NOT be here`,
        actual: otherValue,
        experiments: pageConfig.expectedExperiments || [],
      });
    }
  }
  return Object.keys(captured);
}

/**
 * Bucket evidence for a FLOWTHROUGH (start) page: iterate fresh sessions. The
 * down-funnel value under test is the START PAGE's OWN value — read on the
 * start page (cookies), then verified on the destination form page: the start
 * token must be present in the destination's 0-1/cr01.
 * @returns {Promise<string[]>} captured bucket keys
 */
async function captureFlowthroughEvidence(page, pageConfig, dest) {
  const primaryExperiment = (pageConfig.expectedExperiments || [])[0];
  const captured = {};

  for (let i = 0; i < SESSION_ATTEMPTS && Object.keys(captured).length < 2; i++) {
    await freshSession(page);
    await gotoAndWait(page, pageConfig.url);

    const cookieTokens = await getCookieSpzTokens(page);
    assertExpectedExperiments(cookieTokens, pageConfig.expectedExperiments || [], pageConfig.label, 'session cookies');

    const bucket = bucketOf(cookieTokens.join(','), primaryExperiment);
    if (!bucket || captured[bucket]) continue;
    captured[bucket] = true;

    console.log(`  bucket "${bucket}" seen → screenshots`);
    await screenshotDownfunnel(page, {
      label: `1_bucket_signal_${pageConfig.key}_${bucket}`,
      fieldValue: null, // start page: no cr form — df value is in the cookies
      expected: expectedDisplayFor(pageConfig),
      actual: cookieTokens.join(','),
      experiments: pageConfig.expectedExperiments || [],
    });

    // Navigate to the form page, but check the START page's down-funnel value:
    // the start cookie token must have carried into the destination's 0-1/cr01.
    await gotoAndWait(page, dest.url);
    const fieldValue = await waitForCrField(page, crFieldName);
    assertCarriedIntoField(fieldValue, cookieTokens, `${dest.label} (checking ${pageConfig.label} df value)`, crFieldName);

    await screenshotDownfunnel(page, {
      label: `2_flowthrough_${pageConfig.key}-to-${dest.key}_${bucket}`,
      fieldName: crFieldName,
      fieldValue,
      expected: expectedDisplayFor(pageConfig),
      actual: fieldValue,
      experiments: pageConfig.expectedExperiments || [], // homepage df value chips
    });
  }
  return Object.keys(captured);
}

// ─────────────────────────────────────────────────────────────────────────────
//  TESTS — one per under-test page, numbered
// ─────────────────────────────────────────────────────────────────────────────
for (const [index, pageConfig] of testedPages.entries()) {
  const testNumber = index + 1;

  if (pageConfig.isFlowthrough) {
    const dest = pages[flowthroughDestination];
    if (!dest) throw new Error(`Config error: flowthroughDestination "${flowthroughDestination}" is not a page`);

    test(`${name} — Test #${testNumber}/${testedPages.length}: ${pageConfig.label} flowthrough df value (LIVE)`, async ({ page }) => {
      console.log(`\n  ${name} — Test #${testNumber}`);
      console.log(`  page      : ${pageConfig.label} (${pageConfig.url}) — df value checked, then on ${dest.label}`);
      console.log(`  expecting : ${expectedDisplayFor(pageConfig)} (both buckets)`);

      const captured = await captureFlowthroughEvidence(page, pageConfig, dest);
      expect(
        captured.length === 2,
        `${pageConfig.label}: expected to observe BOTH buckets (variant + control); after ${SESSION_ATTEMPTS} fresh sessions only saw: ${JSON.stringify(captured)}`
      ).toBe(true);

      console.log(`  ✓ passed (${pageConfig.label} df value carried to ${dest.label}; variant + control evidence)`);
    });
    continue;
  }

  test(`${name} — Test #${testNumber}/${testedPages.length}: ${pageConfig.label} down-funnel values (LIVE)`, async ({ page }) => {
    console.log(`\n  ${name} — Test #${testNumber}`);
    console.log(`  page      : ${pageConfig.label} (${pageConfig.url}), ${crFieldName} checked directly`);
    console.log(`  expecting : ${expectedDisplayFor(pageConfig)} (both buckets)`);
    console.log(`  no-flow   : ${nonFlowthroughPages.filter((p) => p.key !== pageConfig.key).map((p) => p.label).join(', ') || '(none)'}`);

    const captured = await captureDestinationEvidence(
      page,
      pageConfig,
      nonFlowthroughPages.filter((p) => p.key !== pageConfig.key)
    );
    expect(
      captured.length === 2,
      `${pageConfig.label}: expected to observe BOTH buckets (variant + control); after ${SESSION_ATTEMPTS} fresh sessions only saw: ${JSON.stringify(captured)}`
    ).toBe(true);

    console.log(`  ✓ passed (variant + control evidence; df value not passing onto other form pages)`);
  });
}