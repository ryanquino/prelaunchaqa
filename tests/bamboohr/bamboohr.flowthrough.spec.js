/**
 * BambooHR – Flowthrough Bucket Diagnostic
 *
 * Verifies bucket detection on a FLOWTHROUGH page (no form, often no body
 * class). loadBucket confirms the bucket via, in order:
 *   1. the bucket's <body> class
 *   2. the CRO hidden-field value
 *   3. the SPZ value cookie (name-agnostic) — the ONLY signal on a true
 *      flowthrough page
 *
 * This is a diagnostic — it only loads the bucket and reports what was
 * detected. It does NOT run the assertion suite (see bamboohr.downfunnel.spec.js).
 *
 * Run with:
 *   npx playwright test tests/bamboohr/bamboohr.flowthrough.spec.js
 *
 * Fill in OVERRIDES below for the flowthrough page you're checking.
 * Empty cookieScript = postlaunch (live) — nothing is injected, the live site
 * buckets each fresh navigation (~50/50), and the retry loop converges.
 */

// @ts-check
import { test, expect } from '@playwright/test';
import { loadBucket, logStep } from './helpers/abtest.helpers.js';
import { TEST_CONFIG } from './config/bamboohr.config.js';

// ─────────────────────────────────────────────────────────────────────────────
//  OVERRIDES — fill these in for the flowthrough page you're probing
// ─────────────────────────────────────────────────────────────────────────────
const OVERRIDES = {
  url:              'https://www.bamboohr.com/',   // ← TODO: flowthrough page to probe
  label:            'Homepage',
  cookieScript:     TEST_CONFIG.cookieScript,   // same dev snippet as the config ('' = live)
  buckets:          TEST_CONFIG.buckets,            // all buckets of the test
  valueFieldName:   'intellimize1',                 // ← TODO: hidden input (may not exist on flowthrough pages)
  formSelector:     'form[id], form.mktoForm, form',
  maxAttempts:      10,
};

// Headroom for Cloudflare/WAF backoff (~15s per block) + the 50/50 retry loop.
test.setTimeout(180_000);

const bucketList = Object.entries(OVERRIDES.buckets).map(([key, b]) => ({ key, ...b }));

test.describe(`Flowthrough diagnostic – ${OVERRIDES.label}`, () => {

  for (const bucket of bucketList) {
    test(`loadBucket detects ${bucket.label.toUpperCase()} on the flowthrough page`, async ({ page }) => {
      logStep(`Loading ${bucket.label} bucket on ${OVERRIDES.url}…`);
      const result = await loadBucket(
        page,
        bucket.key,
        OVERRIDES.url,
        OVERRIDES.cookieScript,
        OVERRIDES.buckets,
        OVERRIDES.valueFieldName,
        OVERRIDES.formSelector,
        OVERRIDES.maxAttempts
      );
      expect(result.bucket, `loadBucket should confirm the "${bucket.key}" bucket`).toBe(bucket.key);
      console.log(`  ✅ Confirmed bucket: ${result.bucket}`);
    });
  }

});
