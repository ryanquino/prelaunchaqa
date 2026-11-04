/**
 * ConnectWise — Conversion Pages Identification (Web Rollout) spec
 *
 * Verifies the SITEWIDE rollout that passes the page <title> into the hidden
 * field CWS_Cr02__c on every targeted page:
 *
 *   • Regular form   → CWS_Cr02__c == <title>            (no query param)
 *   • Footer form    → CWS_Cr02__c == "Footer: " + <title>
 *
 * CWS_Cr01__c carries the SPZ experiment value (variant OR control). Rule: if a
 * page has a non-footer (REGULAR) form, that form's Cr01 must be populated and
 * is asserted; pages with only footer forms don't require it (logged only).
 * That rollout is US-gated, so values only appear when the test runs via a
 * US-exiting proxy/VPN (CW_PROXY) or a US IP, and the bucket is seeded by
 * landing on /platform/demo first.
 *
 * One test per targeted page. Every test first opens /platform/demo to seed the
 * US-gated SPZ experiment bucket into the session, then redirects to the URL
 * under test. The rollout is LIVE — we observe the values the deployed script
 * writes, exactly as a site visitor would see them.
 */

import { test, expect } from '@playwright/test';
import { PAGES, HIDDEN_FIELD, FOOTER_PREFIX } from './config/connectwise.config.js';
import {
  loadPageAndTriggerRollout,
  getPageTitle,
  getCwsCr02Fields,
  waitForCwsCr02Fields,
  waitForCwsFieldsPopulation,
  takeDiagnosticScreenshot,
  assertTitlePassedToFields,
} from './helpers/abtest.helpers.js';

// WAF headroom + US-VPN latency + consent/scroll retries + the platform/demo
// seed step need more than the 30s default per test.
test.setTimeout(150_000);

// Every test lands here first to seed the US-gated SPZ experiment bucket into
// the session before redirecting to the URL under test.
const PLATFORM_DEMO_URL = 'https://www.connectwise.com/platform/demo';

for (const pageConfig of PAGES) {
  test(`ConnectWise: ${pageConfig.label} (CWS_Cr02__c = <title> + CWS_Cr01__c populated)`, async ({ page }) => {
    console.log(`\n  URL under test: ${pageConfig.url}`);

    // 0 — ALWAYS open platform/demo first so the (US-gated) SPZ engine seeds a
    //     bucket + experiment value into this session's cookies, then redirect
    //     to the URL under test so the value carries over per the rollout.
    if (pageConfig.url !== PLATFORM_DEMO_URL) {
      console.log(`  → Seeding SPZ bucket via ${PLATFORM_DEMO_URL} …`);
      await loadPageAndTriggerRollout(page, PLATFORM_DEMO_URL);
      await waitForCwsFieldsPopulation(page, 'CWS_Cr01__c', { maxAttempts: 5 });
      console.log('  ✓ SPZ bucket seeded');
    }

    // 1 — now land + accept consent + scroll so the rollout populates lazy forms
    await loadPageAndTriggerRollout(page, pageConfig.url);

    // 2 — collect every CWS_Cr02__c field, retrying until the rollout has
    //     populated them (consent / lazy Marketo forms can take a few seconds)
    const fields = await waitForCwsCr02Fields(page);
    console.log(`  CWS_Cr02__c fields found: ${fields.length}`);
    for (const f of fields) {
      console.log(`    [${f.inFooter ? 'FOOTER' : 'REGULAR'}] ${f.formId}: "${f.value}"`);
    }

    // CWS_Cr01__c carries the SPZ experiment value (e.g. "spz_2002_variant" /
    // "spz_1001_true_control"). Rule: IF the page has a non-footer (REGULAR)
    // form, that form's Cr01 MUST be populated — that is asserted. Pages with
    // only footer forms don't need Cr01 (logged only, never asserted). Served
    // REGULAR forms populate within 1-2 attempts, but some take ~37-50s
    // (SLI/Ultimate Guide/IT Nation), so 6 attempts avoids false negatives.
    const cr01 = await waitForCwsFieldsPopulation(page, 'CWS_Cr01__c', { maxAttempts: 6 });
    const regularCr01 = cr01.filter((f) => !f.inFooter);
    const footerCr01 = cr01.filter((f) => f.inFooter);

    if (regularCr01.length > 0) {
      console.log(`  CWS_Cr01__c REGULAR fields: ${regularCr01.length}`);
      for (const f of regularCr01) {
        console.log(`    [REGULAR] ${f.formId}: "${f.value}"`);
        expect(
          f.value.trim().length,
          `CWS_Cr01__c must populate the non-footer form ${f.formId} on "${pageConfig.label}"`
        ).toBeGreaterThan(0);
      }
    } else {
      console.log('  CWS_Cr01__c: no non-footer form on this page — not required (footer values logged only)');
      for (const f of footerCr01) {
        console.log(`    [FOOTER] ${f.formId}: "${f.value || '(empty — not required)'}"`);
      }
    }

    // 3 — read the authoritative page title (document.title has no query param)
    const title = await getPageTitle(page);
    console.log(`  Page title: "${title}"`);

    // 4 — assert title was passed (footer forms prefixed)
    assertTitlePassedToFields(fields, title, FOOTER_PREFIX);

    // 5 — diagnostic screenshot with overlay
    await takeDiagnosticScreenshot(page, pageConfig.label);

    console.log(`  ✓ ${pageConfig.label} passed`);
  });
}