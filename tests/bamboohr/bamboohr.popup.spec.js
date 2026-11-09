/**
 * BambooHR – Sitewide Popup A/B Test QA
 *
 * BambooHR opens its sitewide popup via a TRIGGER CLICK, and the popup
 * markup differs PER PAGE. So this spec is driven entirely by config:
 *
 *   - Page form location     → `hasHeroForm` per page. TRUE means the form sits
 *                               inline in the hero, so the suite asserts the DF
 *                               value directly and never opens a popup. FALSE
 *                               means the form is behind a modal, so the suite
 *                               clicks `popup.triggerSelector` first.
 *   - Which pages get popup  → any non-hero page with `popup.triggerSelector`
 *                               AND `popup.formSelector` set.
 *   - Popup selectors        → that page's `popup.triggerSelector`,
 *                               `popup.formSelector`, `popup.closeSelector`.
 *   - Popup CRO2 values      → popupValues.popupOpen /
 *                               popupOpenClosed / popupDidntOpen.
 *
 * DF value semantics (verified live on BambooHR):
 *   - CRO2 (ExperimentValue) carries the BUCKET value and nothing else — e.g.
 *     "#1057_variant" — with or without the popup ever being opened. The other
 *     tests on the page are comma-joined alongside it, so every assertion here
 *     is token-based.
 *   - The expected string therefore comes from whichever bucket the site served
 *     this run (`expectedFor(bucket)`). In live mode that is ~50/50, so a fixed
 *     expectedValue would fail half the time.
 *   - The popup's own hidden fields are populated only while the popup is open;
 *     they are asserted on the popup form itself, not elsewhere.
 *
 *  Winning condition:
 *    Variant total (Demo + Contact + Signup + Popup) > Control total (Demo + Contact + Signup)
 *    — net new conversions required, not redistribution.
 *
 *  Field-name reference:
 *    CRO1 → ExperimentName
 *    CRO2 → ExperimentValue
 */

// @ts-check
import { test, expect } from '@playwright/test';
import { TEST_CONFIG } from './config/bamboohr.config.js';
import {
  activateVariant,
  getBodyClasses,
  waitForFormField,
  screenshotWithCookies,
  gotoAndWait,
  logStep,
} from './helpers/abtest.helpers.js';

const { pages, cookieScript, hiddenFields, popupValues, buckets } = TEST_CONFIG;

// cookieScript is a PHASE MARKER for bhr (no snippet to inject): filled →
// PRELAUNCH label, empty → POSTLAUNCH. Either way the suite only OBSERVES
// buckets — ?spz-qa=true on the page URLs is what loads the test.
const isLive = !cookieScript.trim();

// Bucket-loading retries against a 50/50 randomiser, so a test can legitimately
// take several attempts. Give it room instead of fighting the 30s default:
// each attempt waits up to 15s for a bucket signal, and up to 10 attempts must
// fit before the test-level timeout cuts the retry loop short (otherwise you'd
// see "Test timeout" instead of the clear "could not load bucket" error when a
// test isn't actually live). Prelaunch also needs headroom for Cloudflare/WAF
// backoff (~15s per block). Both phases share the same observe/retry loop, so
// both get the full budget.
test.setTimeout(240_000);

// CRO2 is comma-joined when several tests run on the same page
// (e.g. "#1048_true_control,#1057_true_control"), so every assertion below is
// token-based — exact equality would fail on any multi-test page.
const tokens = (raw) => String(raw || '').split(',').map(s => s.trim()).filter(Boolean);

// ── Pages, derived from config ────────────────────────────────────────────────
// A page's form is EITHER inline in the hero OR behind a modal popup — the
// hasHeroForm flag decides which. So a page is "popup-configured" only when it
// is NOT a hero-form page AND it has a trigger AND a form selector.
const heroFormPages = Object.values(pages).filter(p => p.hasHeroForm === true);

const popupPages = Object.values(pages).filter(
  p => p.hasHeroForm !== true && p.popup && p.popup.triggerSelector && p.popup.formSelector
);

// The DF value is the BUCKET value (comma-joined with any other live tests), so
// the expected string comes from whichever bucket the site served this run.
// In live mode that is ~50/50 — a fixed expectedValue would fail half the time.
const expectedFor = (bucketKey) => buckets[bucketKey]?.expectedValue ?? '';

const popupConfigured = Boolean(
  popupPages.length &&
  popupValues?.popupOpen !== undefined &&
  popupValues?.popupOpenClosed !== undefined &&
  popupValues?.popupDidntOpen !== undefined
);

// A form page (other than the one under test) used to verify the DF value
// carries between pages regardless of popup interaction.
const otherFormPage = Object.values(pages).find(
  p => p.formSelector && !popupPages.includes(p)
) ?? Object.values(pages).find(p => p.formSelector);

// Where the DF cookie actually gets minted. The A/B script only assigns a bucket
// on the test's primary page — secondary pages (pricing, hr-software, …) read the
// value OUT of the cookie but never set it, so activating directly on them times
// out after every attempt. Mirror the downfunnel spec: activate once here, then
// navigate — the cookie carries to every other page.
const activationPage = Object.values(pages).find(p => p.isUnderTest) ?? Object.values(pages)[0];

// The file still needs at least one declared test when nothing is configured,
// otherwise Playwright errors with "No tests found" instead of skipping.
if (!heroFormPages.length && !popupConfigured) {
  test.skip(
    'No scenarios configured — tick hasHeroForm on a hero-form page, or set per-page popup.triggerSelector/formSelector/closeSelector plus popupValues in bamboohr.data.json',
    async () => {}
  );
} else {
  // ───────────────────────────────────────────────────────────────────────────
  //  Per-page scenario helpers
  // ───────────────────────────────────────────────────────────────────────────
  async function openPopup(page, popupCfg) {
    const trigger = page.locator(popupCfg.triggerSelector).first();
    if ((await trigger.count()) === 0) {
      throw new Error(`Popup trigger not found: "${popupCfg.triggerSelector}". Check config popup.triggerSelector.`);
    }

    // Marketo renders the modal and then injects the form into it, both async —
    // a short fixed wait races that and fails intermittently. Scroll the trigger
    // into view, click, and retry once (an overlay can swallow the first click).
    const tryOpen = async () => {
      await trigger.scrollIntoViewIfNeeded().catch(() => {});
      await trigger.click({ timeout: 10000 }).catch(() => {});
      await page.waitForSelector(popupCfg.formSelector, { state: 'visible', timeout: 15000 });
    };

    try {
      await tryOpen();
    } catch (firstError) {
      console.warn(`  ⚠ Popup did not open on first click – retrying (${firstError.message.split('\n')[0]})`);
      await tryOpen();
    }
  }

  async function closePopup(page, popupCfg) {
    const closeBtn = page.locator(popupCfg.closeSelector).first();
    if (await closeBtn.count() > 0) {
      await closeBtn.click();
      await page.waitForTimeout(500);
      console.log('  Popup closed');
    } else if (popupCfg.closeSelector) {
      console.warn(`  ⚠ Close selector "${popupCfg.closeSelector}" not found – pressing Escape`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  HERO-FORM SCENARIOS — form is inline, so no popup is ever opened
  // ───────────────────────────────────────────────────────────────────────────
  for (const p of heroFormPages) {
    const slug = p.label.toLowerCase().replace(/\s+/g, '_');

    test.describe(`Hero-form scenarios – ${p.label}`, () => {

      test(`HERO-1 | ${p.label}: hero form CRO2 = the DF bucket value (no popup)`, async ({ page }) => {
        logStep(`HERO-1 [${p.label}]: Activate variant on ${activationPage?.label} (where the DF cookie is minted)`);
        const { bucket } = await activateVariant(page, activationPage.url, cookieScript, buckets, hiddenFields.experimentValue);
        const expected = expectedFor(bucket);
        console.log(`  Body classes: "${await getBodyClasses(page)}"`);
        console.log(`  Observed bucket: "${bucket}" → expected CRO2 "${expected}"`);

        logStep(`HERO-1 [${p.label}]: Navigate to ${p.url} and read the hero form (popup untouched)`);
        await gotoAndWait(page, p.url);
        const expValue = await waitForFormField(page, p.formSelector, hiddenFields.experimentValue);
        console.log(`  ExperimentValue (CRO2): "${expValue}"`);
        await screenshotWithCookies(page, `HERO1_${slug}_hero_form`, hiddenFields, p.formSelector);

        expect(
          tokens(expValue),
          `${p.label} hero-form CRO2 should contain the bucket value "${expected}" (got "${expValue}")`
        ).toContain(expected);
      });

      test(`HERO-2 | ${p.label}: value carries to ${otherFormPage?.label} without any popup`, async ({ page }) => {
        logStep(`HERO-2 [${p.label}]: Activate variant on ${activationPage?.label}`);
        const { bucket } = await activateVariant(page, activationPage.url, cookieScript, buckets, hiddenFields.experimentValue);
        const expected = expectedFor(bucket);

        logStep(`HERO-2 [${p.label}]: Navigate to ${otherFormPage?.label} (no popup interaction)`);
        await gotoAndWait(page, otherFormPage.url);
        const expValue = await waitForFormField(page, otherFormPage.formSelector, hiddenFields.experimentValue);
        console.log(`  ${otherFormPage.label} ExperimentValue (CRO2): "${expValue}"`);
        await screenshotWithCookies(page, `HERO2_${slug}_carry`, hiddenFields, otherFormPage.formSelector);

        expect(
          tokens(expValue),
          `${otherFormPage.label} CRO2 should carry the bucket value "${expected}" (got "${expValue}")`
        ).toContain(expected);
      });

    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  POPUP SCENARIOS — form is behind a modal, so the trigger is clicked first
  // ───────────────────────────────────────────────────────────────────────────
  if (popupConfigured) {
    for (const p of popupPages) {
      const popupCfg = p.popup;
      const slug     = p.label.toLowerCase().replace(/\s+/g, '_');

      test.describe(`Popup scenarios – ${p.label}`, () => {

        // ── SCENARIO 1: conversion inside the popup ────────────────────────────
        test(`POP-1 | ${p.label}: popup form CRO2 = the DF bucket value while open`, async ({ page }) => {
          logStep(`POP-1 [${p.label}]: Activate variant & load ${p.url}`);
          const { bucket } = await activateVariant(page, p.url, cookieScript, buckets, hiddenFields.experimentValue);
          const expected = expectedFor(bucket);
          console.log(`  Body classes: "${await getBodyClasses(page)}"`);
          console.log(`  Observed bucket: "${bucket}" → expected CRO2 "${expected}"`);
          await screenshotWithCookies(page, `POP1_${slug}_variant`, hiddenFields);

          logStep(`POP-1 [${p.label}]: Open the popup via trigger`);
          await openPopup(page, popupCfg);

          logStep(`POP-1 [${p.label}]: Read hidden fields from the popup form`);
          const expValue = await waitForFormField(page, popupCfg.formSelector, hiddenFields.experimentValue);
          console.log(`  ExperimentValue (CRO2): "${expValue}"`);
          await screenshotWithCookies(page, `POP1_${slug}_popup_open`, hiddenFields, popupCfg.formSelector);

          expect(
            tokens(expValue),
            `Popup form CRO2 should contain the bucket value "${expected}" (got "${expValue}")`
          ).toContain(expected);
        });

        // ── SCENARIO 1b: popup never triggered, value already carried ──────────
        test(`POP-1b | ${p.label}: ${otherFormPage?.label} CRO2 already holds the bucket value (popup never triggered)`, async ({ page }) => {
          logStep(`POP-1b [${p.label}]: Activate variant, then go to ${otherFormPage?.label} WITHOUT opening popup`);
          const { bucket } = await activateVariant(page, p.url, cookieScript, buckets, hiddenFields.experimentValue);
          const expected = expectedFor(bucket);
          await gotoAndWait(page, otherFormPage.url);
          console.log(`  ${otherFormPage.label} body classes: "${await getBodyClasses(page)}"`);

          const expValue = await waitForFormField(page, otherFormPage.formSelector, hiddenFields.experimentValue);
          console.log(`  ${otherFormPage.label} ExperimentValue (CRO2): "${expValue}"`);

          expect(
            tokens(expValue),
            `${otherFormPage.label} CRO2 should contain the bucket value "${expected}" (got "${expValue}")`
          ).toContain(expected);
        });

        // ── SCENARIO 2: popup opened & dismissed, then another form filled ─────
        test(`POP-2 | ${p.label}: ${otherFormPage?.label} CRO2 still = the bucket value after popup dismissed`, async ({ page }) => {
          logStep(`POP-2 [${p.label}]: Activate variant & load ${p.url}`);
          const { bucket } = await activateVariant(page, p.url, cookieScript, buckets, hiddenFields.experimentValue);
          const expected = expectedFor(bucket);

          logStep(`POP-2 [${p.label}]: Open the popup`);
          await openPopup(page, popupCfg);
          console.log('  Popup opened');

          logStep(`POP-2 [${p.label}]: Close the popup`);
          await closePopup(page, popupCfg);

          logStep(`POP-2 [${p.label}]: Navigate to ${otherFormPage.label}`);
          await gotoAndWait(page, otherFormPage.url);
          await screenshotWithCookies(page, `POP2_${slug}_after_closed`, hiddenFields, otherFormPage.formSelector);

          const expValue = await waitForFormField(page, otherFormPage.formSelector, hiddenFields.experimentValue);
          console.log(`  ${otherFormPage.label} ExperimentValue (CRO2): "${expValue}"`);

          expect(
            tokens(expValue),
            `${otherFormPage.label} CRO2 should still contain the bucket value "${expected}" after the popup was dismissed (got "${expValue}")`
          ).toContain(expected);
        });

        // ── SCENARIO 3: popup never opened at all ──────────────────────────────
        test(`POP-3 | ${p.label}: ${otherFormPage?.label} CRO2 = the bucket value with no popup interaction`, async ({ page }) => {
          logStep(`POP-3 [${p.label}]: Activate variant (no popup interaction)`);
          const { bucket } = await activateVariant(page, p.url, cookieScript, buckets, hiddenFields.experimentValue);
          const expected = expectedFor(bucket);

          logStep(`POP-3 [${p.label}]: Navigate to ${otherFormPage.label} without opening popup`);
          await gotoAndWait(page, otherFormPage.url);

          const expValue = await waitForFormField(page, otherFormPage.formSelector, hiddenFields.experimentValue);
          console.log(`  ${otherFormPage.label} ExperimentValue (CRO2): "${expValue}"`);

          expect(
            tokens(expValue),
            `${otherFormPage.label} CRO2 should contain the bucket value "${expected}" (got "${expValue}")`
          ).toContain(expected);
        });

        // ── POPUP NON-CARRY-OVER CHECK ─────────────────────────────────────────
        test(`POP-NCO | ${p.label}: popup test name must NOT appear in ${otherFormPage?.label}`, async ({ page }) => {
          logStep(`POP-NCO [${p.label}]: Activate variant (no popup interaction)`);
          await activateVariant(page, p.url, cookieScript, buckets, hiddenFields.experimentValue);

          logStep(`POP-NCO [${p.label}]: Navigate to ${otherFormPage.label}`);
          await gotoAndWait(page, otherFormPage.url);

          const expName = await waitForFormField(page, otherFormPage.formSelector, hiddenFields.experimentName);
          console.log(`  ${otherFormPage.label} ExperimentName (CRO1): "${expName}"`);

          expect(
            expName,
            `Popup test name must NOT appear in ${otherFormPage.label} ExperimentName`
          ).not.toContain('popup');
        });

      });
    }
  }
}
