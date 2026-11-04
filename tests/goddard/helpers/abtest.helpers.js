/**
 * Goddard — read-only helpers. Land, let the SPZ cookies settle, read the
 * down-funnel field. Never submits a form.
 */

import fs from 'fs';
import path from 'path';
import { expect } from '@playwright/test';

/** Navigate and wait for the SPZ cookies / scripts to settle. */
export async function gotoAndWait(page, url, settleMs = 2500) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(settleMs);
  await page.mouse.wheel(0, 2000).catch(() => {});
}

/** All `spz_<id>_<bucket>` tokens found in the session cookies (comma-safe). */
export async function getCookieSpzTokens(page) {
  return page.evaluate(() => {
    const isSpzToken = (t) => /^spz_\d+_(variant|control|truecontrol|true_control|variant\d*)/i.test(t.trim());
    return document.cookie.split(';')
      .flatMap(c => String(c.slice(c.indexOf('=') + 1) || '').split(','))
      .map(t => t.trim())
      .filter(isSpzToken);
  });
}

/** Value of the named hidden field, or null when absent. */
export async function getHiddenFieldValue(page, fieldName) {
  const el = page.locator(`input[name="${fieldName}"], input[data-hsfc-id][id*="${fieldName}"]`).first();
  return (await el.count()) ? el.evaluate((n) => n.value) : null;
}

/**
 * Poll until the cr field exists AND becomes non-empty (or timeout), scrolling
 * to coax HubSpot/SPZ into finishing. Returns the final value ('' or null on
 * timeout). Read-only.
 */
export async function waitForCrField(page, fieldName, options = {}) {
  const { timeout = 20000, scrollInterval = 2000 } = options;
  const started = Date.now();
  let value = await getHiddenFieldValue(page, fieldName);
  while (Date.now() - started < timeout) {
    if (value !== null && value.trim().length > 0) return value;
    await page.mouse.wheel(0, 2500).catch(() => {});
    await page.waitForTimeout(scrollInterval);
    value = await getHiddenFieldValue(page, fieldName);
  }
  return value;
}

/** Assert every cookie-carried spz_* token made it into the cr01 field. */
export function assertCarriedIntoField(fieldValue, cookieTokens, label, fieldName) {
  const inField = new Set(String(fieldValue || '').split(',').map((t) => t.trim()));
  expect(
    fieldValue && fieldValue.trim().length > 0,
    `${label}: ${fieldName} must be populated (non-empty)`
  ).toBeTruthy();
  for (const token of cookieTokens) {
    expect(
      inField.has(token),
      `${label}: ${fieldName} must contain the carried value "${token}"`
    ).toBe(true);
  }
}

/**
 * Assert a comma-joined field value (or cookie token array) holds a bucket
 * token — control OR variant — for every expected experiment id.
 */
export function assertExpectedExperiments(source, expectedExperiments, label, targetName) {
  const tokens = source
    ? String(source).split(',').map((t) => t.trim()).filter((t) => t.length > 0)
    : [];
  expect(
    tokens.length > 0,
    `${label}: ${targetName} must be populated (non-empty)`
  ).toBeTruthy();

  const byExperiment = new Map();
  for (const token of tokens) {
    const m = String(token).match(/^(spz_(\d+)_(variant|control|truecontrol|true_control))$/i);
    if (m) byExperiment.set(m[2], m[1]);
  }

  for (const id of expectedExperiments) {
    expect(
      byExperiment.has(id),
      `${label}: ${targetName} must include a bucket value for experiment spz_${id} (expected a token like "spz_${id}_variant" or "spz_${id}_control"; got: ${JSON.stringify(tokens)})`
    ).toBe(true);
  }
}

// ─── Evidence Screenshot ─────────────────────────────────────────────────────

/**
 * Takes a screenshot with a DevTools-style panel overlaid (read-only — never
 * submits a form):
 *
 *  1. 🧪 Expecting  — expected down-funnel tokens and the page under test
 *  2. 🔍 Elements   — the hidden field outerHTML, value highlighted (when the
 *                      field exists on this page)
 *  3. 🍪 Cookies    — all document.cookie values as a Name/Value table
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} opts
 * @param {string} opts.label            - filename prefix
 * @param {string} [opts.fieldName]      - hidden field name (e.g. '0-1/cr01')
 * @param {string|null} [opts.fieldValue] - current field value, null when the
 *                                          page has no field (flowthrough start)
 * @param {string} [opts.expected]        - expected tokens, for display
 * @param {string} [opts.actual]          - actual tokens seen this session
 * @param {string[]} [opts.experiments]   - experiment ids; shows BOTH bucket
 *                                          values (variant + true control) for
 *                                          each, highlighting the one observed
 * @param {string} [opts.screenshotsDir]  - output folder (default
 *                                          screenshots/goddard-cookies — NOT
 *                                          test-results/, which Playwright wipes
 *                                          at the start of every run)
 * @returns {Promise<string>}             absolute path of the saved screenshot
 */
export async function screenshotDownfunnel(page, opts) {
  const {
    label,
    fieldName = '0-1/cr01',
    fieldValue = null,
    expected = '',
    actual = '',
    experiments = [],
    screenshotsDir,
  } = opts;

  const outDir = screenshotsDir || path.resolve('screenshots', 'goddard-cookies');
  fs.mkdirSync(outDir, { recursive: true });

  const safeName  = label.replace(/[^a-z0-9_-]/gi, '_').replace(/_+/g, '_');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath  = path.join(outDir, `${safeName}_${timestamp}.png`);

  // Read the hidden field outerHTML on the page (only when a value was given).
  let outerHTML = '';
  if (fieldValue !== null) {
    const loc = page.locator(`input[name="${fieldName}"], input[data-hsfc-id][id*="${fieldName}"]`).first();
    if (await loc.count() > 0) {
      outerHTML = await loc.evaluate((el) => el.outerHTML) || '';
    }
  }

  await page.evaluate(({ fieldName, fieldValue, outerHTML, expected, actual, experiments }) => {
    const existing = document.getElementById('__qa_goddard_overlay__');
    if (existing) existing.remove();

    const hasToken = (token) => String(actual || fieldValue || '')
      .split(',').map((t) => t.trim()).includes(token);

    // Bucket value rows — ALWAYS show variant AND true control for every
    // expected experiment, highlighting which one this session actually got.
    const bucketRows = experiments.length > 0 ? experiments.map((id) => {
      const variant = `spz_${id}_variant`;
      const control = `spz_${id}_control`;
      const chip = (token) => {
        const on = hasToken(token);
        return `<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 10px;
                             border-radius:12px;font-family:monospace;font-size:12px;
                             background:${on ? '#1a3a1a' : '#2d2d2d'};
                             color:${on ? '#4ec9b0' : '#858585'};
                             border:1px solid ${on ? '#2e7d32' : '#3a3a3a'}">
                 ${token}${on ? ' ✓' : ''}</span>`;
      };
      return `<div style="padding:3px 12px;background:#252526;border-bottom:1px solid #2d2d2d">
                <span style="color:#858585;font-size:11px;font-weight:600;
                             text-transform:uppercase;letter-spacing:.05em">spz_${id}</span>
                ${chip(variant)}${chip(control)}
              </div>`;
    }).join('') : '';

    // ── Cookies ──────────────────────────────────────────────────────────────
    const cookies = document.cookie
      .split(';').map(c => c.trim()).filter(Boolean)
      .map(c => {
        const idx = c.indexOf('=');
        return { name: idx >= 0 ? c.slice(0, idx).trim() : c.trim(),
                 value: idx >= 0 ? c.slice(idx + 1).trim() : '' };
      });

    const cookieRows = cookies.length > 0
      ? cookies.map(({ name, value }) => `
          <tr>
            <td style="padding:4px 10px;border-bottom:1px solid #3a3a3a;color:#9cdcfe;
                       font-family:monospace;font-size:12px;white-space:nowrap;
                       max-width:240px;overflow:hidden;text-overflow:ellipsis"
                title="${name}">${name}</td>
            <td style="padding:4px 10px;border-bottom:1px solid #3a3a3a;color:#ce9178;
                       font-family:monospace;font-size:12px;white-space:nowrap;
                       max-width:340px;overflow:hidden;text-overflow:ellipsis"
                title="${value}">${value || '(empty)'}</td>
          </tr>`).join('')
      : `<tr><td colspan="2" style="padding:8px 10px;color:#888;font-style:italic;font-size:12px">
           No cookies for this origin</td></tr>`;

    // ── Elements-style renderer (value attribute highlighted) ───────────────
    const elementsHTML = outerHTML
      ? outerHTML
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
          .replace(
            /(value=&quot;)([^&]*)(&quot;)/g,
            `<span style="color:#9cdcfe">value</span>=<span style="background:#3a3000;color:#ffd700;border-radius:2px;padding:0 2px">&quot;$2&quot;</span>`
          )
          .replace(/(\w[\w-]*)=&quot;/g, '<span style="color:#9cdcfe">$1</span>=&quot;')
          .replace(/^(&lt;\w+)/, '<span style="color:#4ec9b0">$1</span>')
          .replace(/(&gt;)$/, '<span style="color:#4ec9b0">$1</span>')
      : `<span style="color:#888;font-style:italic;font-size:12px">
          &lt;input name="${fieldName}"&gt; not present on this page (flowthrough start)</span>`;

    const badge = fieldValue
      ? `<span style="margin-left:8px;background:#1a3a1a;color:#4ec9b0;
                    border-radius:10px;padding:1px 8px;font-size:11px;font-family:monospace">${fieldValue}</span>`
      : `<span style="margin-left:8px;background:#4a1515;color:#f48771;
                    border-radius:10px;padding:1px 8px;font-size:11px;font-family:monospace">(no field)</span>`;

    const panel = document.createElement('div');
    panel.id = '__qa_goddard_overlay__';
    panel.innerHTML = `
      <div style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;
                  background:#1e1e1e;border-top:2px solid #007acc;
                  font-family:'Segoe UI',system-ui,sans-serif;
                  max-height:380px;overflow-y:auto;
                  box-shadow:0 -4px 20px rgba(0,0,0,0.6)">

        <div style="display:flex;align-items:center;gap:8px;padding:5px 12px;
                    background:#1a1a2e;border-bottom:1px solid #3a3a3a;position:sticky;top:0">
          <span style="font-size:13px">🔍</span>
          <span style="color:#cccccc;font-weight:600;font-size:12px">Elements — Hidden Field Inspection</span>
          <span style="margin-left:auto;color:#858585;font-size:11px">${window.location.pathname}</span>
        </div>

        <div style="padding:6px 12px 2px;background:#252526;
                    border-bottom:1px solid #2d2d2d">
          <span style="color:#858585;font-size:11px;font-weight:600;
                       text-transform:uppercase;letter-spacing:.05em">
            Experiment — ${fieldName}
          </span>
          ${badge}
        </div>
        <div style="padding:6px 12px 8px;background:#252526;border-bottom:1px solid #3a3a3a">
          <code style="font-family:monospace;font-size:12px;color:#d4d4d4;
                       white-space:pre-wrap;word-break:break-all;line-height:1.6">
            ${elementsHTML}
          </code>
        </div>

        <div style="padding:3px 12px;background:#252526;border-bottom:1px solid #2d2d2d">
          <span style="color:#858585;font-size:11px;font-weight:600;
                       text-transform:uppercase;letter-spacing:.05em">
            Bucket values (variant / true control)
          </span>
          <span style="margin-left:8px;color:#ffd07b;font-family:monospace;font-size:12px">${expected || '(none listed)'}</span>
        </div>
        ${bucketRows}

        <div style="display:flex;align-items:center;gap:8px;padding:5px 12px;
                    background:#2d2d2d;border-bottom:1px solid #3a3a3a">
          <span style="font-size:13px">🍪</span>
          <span style="color:#cccccc;font-weight:600;font-size:12px">
            Cookies — ${window.location.hostname}
          </span>
          <span style="margin-left:auto;background:#007acc;color:#fff;
                       border-radius:10px;padding:1px 8px;font-size:11px">
            ${cookies.length} cookie${cookies.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div style="display:grid;grid-template-columns:240px 1fr;padding:4px 10px;
                    background:#2d2d2d;border-bottom:1px solid #3a3a3a">
          <span style="color:#858585;font-size:11px;font-weight:600;
                       text-transform:uppercase;letter-spacing:.05em">Name</span>
          <span style="color:#858585;font-size:11px;font-weight:600;
                       text-transform:uppercase;letter-spacing:.05em">Value</span>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <tbody>${cookieRows}</tbody>
        </table>
      </div>`;
    document.body.appendChild(panel);
    // Several client sites (SailPoint proven) carry an !important rule that hides
    // unknown body-level <div>s, which silently drops this overlay out of the
    // screenshot � the evidence then looks like "no CRO value was captured".
    // An inline !important declaration wins over any author stylesheet rule.
    panel.style.setProperty('display', 'block', 'important');
  }, { fieldName, fieldValue, outerHTML, expected, actual, experiments });

  await page.waitForTimeout(300);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`  📸 Screenshot: ${filePath}`);

  await page.evaluate(() => {
    const el = document.getElementById('__qa_goddard_overlay__');
    if (el) el.remove();
  });

  return filePath;
}