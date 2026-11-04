/**
 * SailPoint – Flowthrough Bucket Diagnostic
 *
 * Verifies bucket detection on a FLOWTHROUGH page (no form, often no body
 * class). loadBucket confirms the bucket via, in order:
 *   1. the bucket's <body> class
 *   2. the CRO hidden-field value
 *   3. the SPZ value cookie (name-agnostic) — the ONLY signal on a true
 *      flowthrough page like the homepage
 *
 * This is a diagnostic — it only loads the bucket and reports what was
 * detected. It does NOT run the assertion suite (see sailpoint.downfunnel.spec.js).
 *
 * Run with:
 *   npx playwright test tests/sailpoint/sailpoint.flowthrough.spec.js
 *
 * The target page(s) are derived from sailpoint.config.js — any page marked
 * isUnderTest: true AND isFlowthrough: true is probed, for every bucket.
 */

// @ts-check
import { test, expect } from '@playwright/test';
import { loadBucket, logStep } from './helpers/abtest.helpers.js';
import { TEST_CONFIG } from './config/sailpoint.config.js';

// ─────────────────────────────────────────────────────────────────────────────
//  Target page — derived from sailpoint.config.js (NOT hardcoded)
// ─────────────────────────────────────────────────────────────────────────────
// A bucket can only be detected on a page that is actually under test. Deriving
// the target from the config keeps this spec in step with the config, so it
// cannot silently drift the way a hardcoded URL does.
const pages = TEST_CONFIG.pages ?? {};

// Every under-test page flagged isFlowthrough gets probed.
const flowPages = Object.entries(pages)
  .filter(([, p]) => p.isUnderTest && p.isFlowthrough)
  .map(([key, p]) => ({ key, url: p.url, label: p.label || key }));

if (flowPages.length === 0) {
  test('Flowthrough diagnostic — skipped', () => {
    test.skip(true,
      'No page is marked isUnderTest: true AND isFlowthrough: true in sailpoint.config.js — ' +
      'the current test runs on a form page, not a flowthrough page. This diagnostic only applies to flowthrough tests.'
    );
  });
}

// Same self-contained dev snippet (or empty → postlaunch) as the config.
const cookieScript = TEST_CONFIG.cookieScript;
const buckets      = TEST_CONFIG.buckets;

const valueFieldName = 'intellimize1';   // hidden input (may not exist on flowthrough pages)
const formSelector   = 'form[id], form.mktoForm, form';
const maxAttempts    = 10;

// Headroom for Cloudflare/WAF backoff (~15s per block) + the 50/50 retry loop.
test.setTimeout(180_000);

const bucketList = Object.entries(buckets).map(([key, b]) => ({ key, ...b }));

test.describe('Flowthrough diagnostic', () => {
  if (flowPages.length === 0) return; // already registered a skip test above

  for (const target of flowPages) {
    test.describe(`${target.label} — ${target.url}`, () => {
      for (const bucket of bucketList) {
        test(`loadBucket detects ${bucket.label.toUpperCase()}`, async ({ page }) => {
          logStep(`Loading ${bucket.label} bucket on ${target.url}…`);
          const result = await loadBucket(
            page,
            bucket.key,
            target.url,
            cookieScript,
            buckets,
            valueFieldName,
            formSelector,
            maxAttempts
          );
          expect(result.bucket, `loadBucket should confirm the "${bucket.key}" bucket`).toBe(bucket.key);
          console.log(`  ✅ Confirmed bucket: ${result.bucket}`);
        });
      }
    });
  }
});
