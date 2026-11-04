/**
 * ConnectWise helpers — Conversion Pages Identification verification
 *
 * Covers:
 *  - Cookie-consent dismissal
 *  - Page <title> reading (no query params)
 *  - CWS_Cr02__c hidden-field collection (footer vs regular classification)
 *  - Scroll-trigger for lazy-loaded Marketo forms
 *  - Cloudflare/WAF backoff
 *  - Diagnostic screenshot
 */

import { expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const SCREENSHOT_DIR = path.resolve('test-results', 'connectwise-titles');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ─── Consent / session ──────────────────────────────────────────────────────

/**
 * Dismisses the OneTrust cookie-consent banner if present.
 * The rollout may not fire until consent is given. Retries briefly because
 * the banner can load late.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [attempts=3]
 * @returns {Promise<boolean>} true if a button was clicked
 */
export async function acceptCookies(page, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const btn = page
      .locator('#onetrust-accept-btn-handler')
      .or(page.locator('button:has-text("Accept All")'))
      .or(page.locator('button:has-text("ACCEPT")'))
      .first();
    if (await btn.count() > 0) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(2500);
      console.log('  ✓ Cookie consent accepted');
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

// ─── Page title ─────────────────────────────────────────────────────────────

/**
 * Returns the current page <title>. document.title never contains a query
 * string, so "without query param" is satisfied by definition.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>}
 */
export async function getPageTitle(page) {
  return page.title();
}

// ─── CWS_Cr0X__c fields ─────────────────────────────────────────────────────

/**
 * Collects every hidden field with the given name (e.g. CWS_Cr01__c or
 * CWS_Cr02__c) on the page, with its classification.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} fieldName
 * @returns {Promise<Array<{ fieldName, formId, inFooter: boolean, value }>>}
 */
export async function getCwsFields(page, fieldName) {
  return page.evaluate((f) => {
    const lower = f.toLowerCase();
    return Array
      .from(document.querySelectorAll(`input[name="${f}"], input[name="${lower}"]`))
      .map(el => ({
        fieldName: el.name,
        formId:    el.closest('form')?.id || '(no form)',
        inFooter:  !!el.closest('footer'),
        value:     el.value,
      }));
  }, fieldName);
}

/**
 * Collects every CWS_Cr02__c hidden field on the page with its classification.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Array<{ fieldName, formId, inFooter: boolean, value }>>}
 */
export async function getCwsCr02Fields(page) {
  return getCwsFields(page, 'CWS_Cr02__c');
}

/**
 * Waits until every field with the given name (e.g. CWS_Cr01__c) on the page
 * has a non-empty value — the rollout dependencies (consent + lazy Marketo
 * forms) can take a few seconds. On each attempt it re-fires consent and
 * scrolls to coax the late-loading forms, then re-reads. Returns the final
 * field list regardless (so callers can distinguish "populated" vs "empty").
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} fieldName
 * @param {object} [options]
 * @param {number} [options.maxAttempts=8]
 * @param {number} [options.retryDelay=3000]
 * @returns {Promise<Array<{ fieldName, formId, inFooter: boolean, value }>>}
 */
export async function waitForCwsFieldsPopulation(page, fieldName, options = {}) {
  const { maxAttempts = 8, retryDelay = 3000 } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const fields = await getCwsFields(page, fieldName);
    const allPopulated = fields.length > 0 && fields.every(f => f.value.trim().length > 0);

    if (allPopulated) return fields;

    if (attempt < maxAttempts) {
      console.log(`  ⟳ ${fieldName} not populated yet (attempt ${attempt}/${maxAttempts}) — consent + scroll retry…`);
      await acceptCookies(page, 1);
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(retryDelay);
    }
  }
  return getCwsFields(page, fieldName);
}

/**
 * Waits until every CWS_Cr02__c field on the page has a non-empty value
 * (the rollout dependencies — consent + lazy Marketo forms — can take a few
 * seconds). On each attempt it re-fires consent and scrolls to coax the
 * late-loading forms, then re-reads.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} [options]
 * @param {number} [options.maxAttempts=8]
 * @param {number} [options.retryDelay=3000]
 * @returns {Promise<Array<{ fieldName, formId, inFooter: boolean, value }>>}
 */
export async function waitForCwsCr02Fields(page, options = {}) {
  return waitForCwsFieldsPopulation(page, 'CWS_Cr02__c', options);
}

/**
 * True when the current page is a Cloudflare/WAF challenge page.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>}
 */
export async function isBlockedByWAF(page) {
  return page.evaluate(() => {
    const t   = document.title || '';
    const txt = document.body ? document.body.innerText : '';
    return /attention required/i.test(t) || /you have been blocked/i.test(txt);
  }).catch(() => true);
}

/**
 * Waits out a Cloudflare/WAF block with short backoffs.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} url
 * @returns {Promise<boolean>} true if the site recovered
 */
export async function rideOutWafBlock(page, url) {
  for (let i = 0; i < 3; i++) {
    if (!(await isBlockedByWAF(page))) return true;
    console.log(`  ⚠ Cloudflare/WAF challenge — backing off 15s (${i + 1}/3)…`);
    await page.waitForTimeout(15000);
    await page.goto(url, { waitUntil: 'load' }).catch(() => {});
  }
  return !(await isBlockedByWAF(page));
}

/**
 * Navigates to a page, accepts consent, and scrolls to trigger lazy-loaded
 * Marketo forms so the sitewide rollout has time to populate CWS_Cr02__c.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} url
 * @param {object} [options]
 * @param {boolean} [options.scroll=true]  — whether to scroll to trigger lazy forms
 * @returns {Promise<void>}
 */
export async function loadPageAndTriggerRollout(page, url, options = {}) {
  const { scroll = true } = options;

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  if (await isBlockedByWAF(page)) {
    console.log('  ⚠ Cloudflare/WAF block detected');
    await rideOutWafBlock(page, url);
    await page.waitForTimeout(1500);
  }

  await acceptCookies(page);

  if (scroll) {
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(2000);
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(2500);
  } else {
    await page.waitForTimeout(3000);
  }
}

// ─── Diagnostic screenshot ──────────────────────────────────────────────────

/**
 * Takes a screenshot with a QA overlay showing the page title and every
 * CWS_Cr01__c / CWS_Cr02__c hidden-field value (per form and location).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} label
 * @returns {Promise<string>} screenshot path
 */
export async function takeDiagnosticScreenshot(page, label) {
  const filePath = path.join(
    SCREENSHOT_DIR,
    `${label.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 80)}-${Date.now()}.png`
  );

  const data = await page.evaluate(() => {
    const fieldNames = ['CWS_Cr01__c', 'CWS_Cr02__c'];
    const fields = fieldNames.flatMap(fieldName => {
      const lower = fieldName.toLowerCase();
      return Array
        .from(document.querySelectorAll(`input[name="${fieldName}"], input[name="${lower}"]`))
        .map(el => ({
          fieldName: el.name,
          formId:    el.closest('form')?.id || '(no form)',
          inFooter:  !!el.closest('footer'),
          value:     el.value,
        }));
    });

    const existing = document.getElementById('__qa_cw_overlay__');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = '__qa_cw_overlay__';
    panel.innerHTML = `
      <div style="position:fixed;top:0;left:0;width:420px;max-height:60vh;overflow-y:auto;
                  z-index:2147483647;font-family:'Segoe UI',system-ui,sans-serif;font-size:12px;
                  background:#1e1e1e;color:#d4d4d4;border-bottom-right-radius:12px;
                  box-shadow:0 4px 24px rgba(0,0,0,.5)">
        <div style="padding:8px 12px;background:#252526;border-bottom:1px solid #3a3a3a;border-bottom-right-radius:0">
          <span style="font-weight:700;color:#e0e0e0;font-size:13px">🧪 ConnectWise Title QA</span>
          <span style="margin-left:auto;float:right;color:#858585;font-size:11px">${window.location.hostname}</span>
        </div>
        <div style="padding:8px 12px;background:#2d2d2d;border-bottom:1px solid #3a3a3a">
          <span style="color:#858585;font-size:11px;font-weight:600;text-transform:uppercase">Page title</span>
          <div style="color:#4ec9b0;font-family:monospace;margin-top:4px;font-size:12px;word-break:break-all">"${document.title}"</div>
        </div>
        <div style="padding:8px 12px;background:#2d2d2d;border-bottom:1px solid #3a3a3a">
          <span style="color:#858585;font-size:11px;font-weight:600;text-transform:uppercase">
            CWS_Cr01__c / CWS_Cr02__c fields (${fields.length})
          </span>
          ${fields.length === 0 ? '<div style="color:#f48771;margin-top:4px">NO FIELDS FOUND</div>' : fields.map(f => `
            <div style="margin-top:6px;padding:6px 8px;background:#1a1a1a;border-radius:6px;border-left:3px solid ${f.inFooter ? '#c586c0' : '#007acc'}">
              <div style="color:#9cdcfe;font-family:monospace;font-size:11px">${f.fieldName} · ${f.formId} — ${f.inFooter ? 'FOOTER' : 'REGULAR'}</div>
              <div style="color:#ce9178;font-family:monospace;font-size:11px;word-break:break-all;margin-top:2px">"${f.value}"</div>
            </div>
          `).join('')}
        </div>
      </div>`;

    document.body.appendChild(panel);
    // Several client sites (SailPoint proven) carry an !important rule that hides
    // unknown body-level <div>s, which silently drops this overlay out of the
    // screenshot � the evidence then looks like "no CRO value was captured".
    // An inline !important declaration wins over any author stylesheet rule.
    panel.style.setProperty('display', 'block', 'important');
    return { title: document.title, fields };
  });

  await page.waitForTimeout(300);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`  📸 Screenshot: ${filePath}`);

  await page.evaluate(() => {
    const el = document.getElementById('__qa_cw_overlay__');
    if (el) el.remove();
  });

  return data;
}

// ─── Assertions ─────────────────────────────────────────────────────────────

/**
 * Asserts that every CWS_Cr02__c field on the page holds the expected value:
 *   footer forms → "Footer: " + title
 *   regular forms → title
 *
 * Comparison is whitespace-tolerant: some pages emit the page title with a
 * dynamic leading/trailing space (e.g. "… | ConnectWise "), and the rollout
 * writes document.title verbatim at the moment it fires, so the field and a
 * title read moments later can differ only by whitespace.
 *
 * @param {Array<{ formId, inFooter, value }>} fields
 * @param {string} title
 * @param {string} footerPrefix
 */
export function assertTitlePassedToFields(fields, title, footerPrefix) {
  expect(fields.length, `Expected at least one CWS_Cr02__c field on the page`).toBeGreaterThan(0);

  const normalizedTitle = title.trim();

  for (const f of fields) {
    const expected = f.inFooter ? `${footerPrefix}${normalizedTitle}` : normalizedTitle;
    expect(f.value.trim(), `Field ${f.formId} should hold "${expected}"`).toBe(expected);
  }
}