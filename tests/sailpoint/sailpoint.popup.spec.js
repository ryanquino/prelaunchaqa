/**
 * SailPoint – Sitewide Popup A/B Test QA
 *
 * Special rules for sitewide popup (squeeze page):
 *
 *  - Popup is a squeeze page → does NOT carry its value to other forms.
 *  - Popup's hidden fields should only be populated while the popup is open.
 *  - Other forms (Demo, Contact, Signup) track popup state via CRO2:
 *      "1034 popup open"           → conversion happened inside popup
 *      "1034 popup opened & closed"→ popup was opened then dismissed; user converted elsewhere
 *      "Popup didn't open"         → popup never appeared; user converted elsewhere
 *
 *  Winning condition:
 *    Variant total (Demo + Contact + Signup + Popup) > Control total (Demo + Contact + Signup)
 *    — net new conversions required, not redistribution.
 *
 *  Field-name reference (Janak update):
 *    CRO1 → ExperimentName   (was HiddenFieldName)
 *    CRO2 → ExperimentValue  (was HiddenFieldValue)
 */

// @ts-check
import { test, expect } from '@playwright/test';
import { TEST_CONFIG } from './config/sailpoint.config.js';
import {
  activateVariant,
  getBodyClasses,
  getHiddenFieldValue,
  assertHiddenFields,
  screenshotWithCookies,
  gotoAndWait,
  logStep,
} from './helpers/abtest.helpers.js';

const { pages, cookieScript, hiddenFields, popupValues, buckets } = TEST_CONFIG;

// The popup spec only runs when a popup test is actually configured. Fill in
// popupValues.popupOpen / popupOpenClosed / popupDidntOpen in the config
// and these tests activate; until then they skip cleanly.
const popupConfigured = Boolean(
  popupValues.popupOpen && popupValues.popupOpenClosed && popupValues.popupDidntOpen
);
test.skip(!popupConfigured, 'Popup test not configured — add popupValues.popupOpen / popupOpenClosed / popupDidntOpen to sailpoint.config.js');

// ─── Popup selector – update if the actual selector differs ──────────────────
const POPUP_TRIGGER_SELECTOR  = '[data-popup-trigger], .cta-popup-trigger, button.popup-open';
const POPUP_FORM_SELECTOR     = '.popup-form form, .modal form, [role="dialog"] form';
const POPUP_CLOSE_SELECTOR    = '.popup-close, .modal-close, [aria-label="Close"]';

// ─────────────────────────────────────────────────────────────────────────────
//  POPUP SCENARIO 1
//  User fills the POPUP form → conversion in popup
//  CRO2 in popup = "1034 popup open"
//  Other forms should NOT have popup test value
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Popup Scenario 1 – Conversion inside popup', () => {

  test('POP-1 | Popup hidden field CRO2 = "popup open" when popup form is open', async ({ page }) => {
    logStep('POP-1: Activate variant & load homepage');
    await activateVariant(page, pages.home.url, cookieScript, buckets, hiddenFields.experimentValue);
    console.log(`  Body classes: "${await getBodyClasses(page)}"`);
    await screenshotWithCookies(page, 'POP1_variant_homepage', hiddenFields);

    logStep('POP-1: Open the sitewide popup');
    const trigger = page.locator(POPUP_TRIGGER_SELECTOR).first();
    if (await trigger.count() > 0) {
      await trigger.click();
      await page.waitForSelector(POPUP_FORM_SELECTOR, { timeout: 5000 });
    } else {
      console.warn('  ⚠ Popup trigger not found – checking if popup is already visible');
    }

    logStep('POP-1: Read hidden fields from popup form');
    const expName  = await getHiddenFieldValue(page, hiddenFields.experimentName,  POPUP_FORM_SELECTOR);
    const expValue = await getHiddenFieldValue(page, hiddenFields.experimentValue, POPUP_FORM_SELECTOR);
    console.log(`  ExperimentName  (CRO1): "${expName}"`);
    console.log(`  ExperimentValue (CRO2): "${expValue}"`);
    await screenshotWithCookies(page, 'POP1_popup_open_cookies', hiddenFields, POPUP_FORM_SELECTOR);

    expect(expValue, 'Popup CRO2 should equal "popup open" value').toBe(popupValues.popupOpen);
  });

  test('POP-1b | Quote / Demo form should NOT contain popup test value (popup never triggered)', async ({ page }) => {
    logStep('POP-1b: Activate variant & load homepage, then go to Demo WITHOUT opening popup');
    await activateVariant(page, pages.home.url, cookieScript, buckets, hiddenFields.experimentValue);

    // Navigate to Demo WITHOUT touching popup
    await gotoAndWait(page, pages.demo.url);
    console.log(`  Demo body classes: "${await getBodyClasses(page)}"`);

    const expValue = await getHiddenFieldValue(page, hiddenFields.experimentValue, pages.demo.formSelector);
    console.log(`  Demo ExperimentValue (CRO2): "${expValue}"`);

    // When popup never opened, CRO2 on Demo should reflect "Popup didn't open"
    expect(
      expValue,
      `Demo CRO2 should be "${popupValues.popupDidntOpen}" when popup was never opened`
    ).toBe(popupValues.popupDidntOpen);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
//  POPUP SCENARIO 2
//  User opens popup → closes it → fills Demo form
//  CRO2 in Demo = "1034 popup opened & closed"
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Popup Scenario 2 – Popup opened & closed, then Demo form filled', () => {

  test('POP-2 | Demo CRO2 = "popup opened & closed" when popup was dismissed', async ({ page }) => {
    logStep('POP-2: Activate variant & load homepage');
    await activateVariant(page, pages.home.url, cookieScript, buckets, hiddenFields.experimentValue);

    logStep('POP-2: Open the popup');
    const trigger = page.locator(POPUP_TRIGGER_SELECTOR).first();
    if (await trigger.count() > 0) {
      await trigger.click();
      await page.waitForSelector(POPUP_FORM_SELECTOR, { timeout: 5000 });
      console.log('  Popup opened');

      logStep('POP-2: Close the popup');
      const closeBtn = page.locator(POPUP_CLOSE_SELECTOR).first();
      if (await closeBtn.count() > 0) {
        await closeBtn.click();
        await page.waitForTimeout(500);
        console.log('  Popup closed');
      } else {
        console.warn('  ⚠ Close button not found – pressing Escape');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      }
    } else {
      console.warn('  ⚠ Popup trigger not found – skipping open/close step');
    }

    logStep('POP-2: Navigate to Demo form');
    await gotoAndWait(page, pages.demo.url);
    console.log(`  Demo body classes: "${await getBodyClasses(page)}"`);
    await screenshotWithCookies(page, 'POP2_after_popup_closed_demo', hiddenFields, pages.demo.formSelector);

    logStep('POP-2: Check Demo CRO2');
    const expValue = await getHiddenFieldValue(page, hiddenFields.experimentValue, pages.demo.formSelector);
    console.log(`  Demo ExperimentValue (CRO2): "${expValue}"`);

    expect(
      expValue,
      `Demo CRO2 should be "${popupValues.popupOpenClosed}" after popup dismissed`
    ).toBe(popupValues.popupOpenClosed);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
//  POPUP SCENARIO 3
//  Popup never opened → user fills Quote / Demo form
//  CRO2 = "Popup didn't open"
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Popup Scenario 3 – Popup never opened', () => {

  test('POP-3 | Demo CRO2 = "Popup didn\'t open" when popup was never shown', async ({ page }) => {
    logStep('POP-3: Activate variant & load homepage (no popup interaction)');
    await activateVariant(page, pages.home.url, cookieScript, buckets, hiddenFields.experimentValue);

    logStep('POP-3: Navigate to Demo without opening popup');
    await gotoAndWait(page, pages.demo.url);
    console.log(`  Demo body classes: "${await getBodyClasses(page)}"`);

    const expValue = await getHiddenFieldValue(page, hiddenFields.experimentValue, pages.demo.formSelector);
    console.log(`  Demo ExperimentValue (CRO2): "${expValue}"`);

    expect(
      expValue,
      `Demo CRO2 should be "${popupValues.popupDidntOpen}"`
    ).toBe(popupValues.popupDidntOpen);
  });

  test('POP-3b | Contact CRO2 = "Popup didn\'t open" when popup was never shown', async ({ page }) => {
    logStep('POP-3b: Activate variant & load homepage');
    await activateVariant(page, pages.home.url, cookieScript, buckets, hiddenFields.experimentValue);

    logStep('POP-3b: Navigate to Contact without opening popup');
    await gotoAndWait(page, pages.contact.url);

    const expValue = await getHiddenFieldValue(page, hiddenFields.experimentValue, pages.contact.formSelector);
    console.log(`  Contact ExperimentValue (CRO2): "${expValue}"`);

    expect(
      expValue,
      `Contact CRO2 should be "${popupValues.popupDidntOpen}"`
    ).toBe(popupValues.popupDidntOpen);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
//  POPUP NON-CARRY-OVER CHECK
//  Popup value must NEVER appear in Demo/Contact/Trial on its own
//  (it should not carry over from popup to regular forms)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Popup Non-Carry-Over Rule', () => {

  test('POP-NCO | Popup test value does NOT appear in Demo form after Quote form fill', async ({ page }) => {
    logStep('POP-NCO: Activate variant & load homepage (no popup interaction)');
    await activateVariant(page, pages.home.url, cookieScript, buckets, hiddenFields.experimentValue);

    // Navigate to Demo directly (no popup)
    await gotoAndWait(page, pages.demo.url);
    const expName = await getHiddenFieldValue(page, hiddenFields.experimentName, pages.demo.formSelector);
    console.log(`  Demo ExperimentName (CRO1): "${expName}"`);

    // Popup's test name should NOT be in Demo's ExperimentName
    expect(
      expName,
      'Popup test name must NOT appear in Demo ExperimentName'
    ).not.toContain('popup');
  });

});
