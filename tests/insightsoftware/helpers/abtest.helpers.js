/**
 * Insightsoftware A/B test helpers
 *
 * Covers:
 *  - Cookie injection (VWO experiment script evaluation)
 *  - Cookie reading (ExperimentName / ExperimentValue)
 *  - Hidden-field reading (CRO1)
 *  - Cookie screenshot overlay
 *  - Cloudflare/WAF backoff
 */

import { expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

// Evidence screenshots live OUTSIDE test-results/ — Playwright clears that
// folder at the start of every run, which would silently delete them. The
// config UI's "Screenshots" button opens this same folder.
const SCREENSHOT_DIR = path.resolve('screenshots', 'insightsoftware-cookies');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ─── Cookie / Session Helpers ───────────────────────────────────────────────

/**
 * Reads a cookie value by name from the page.
 */
export async function getCookie(page, name) {
  return page.evaluate((cookieName) => {
    const nameEQ = cookieName + '=';
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
      let c = ca[i].trim();
      if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length);
    }
    return null;
  }, name);
}

/**
 * Returns both ExperimentName and ExperimentValue cookies as a parsed object.
 */
export async function getExperimentCookies(page) {
  return page.evaluate(() => {
    function read(name) {
      const nameEQ = name + '=';
      const ca = document.cookie.split(';');
      for (let i = 0; i < ca.length; i++) {
        let c = ca[i].trim();
        if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length);
      }
      return null;
    }
    return {
      experimentName:  read('ExperimentName'),
      experimentValue: read('ExperimentValue'),
    };
  });
}

/**
 * Reads the value of input[name] holding the experiment value.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} fieldName  — the input[name] attribute value (e.g. 'cro1')
 * @param {string} [formSelector]  — optional CSS selector to scope the lookup
 * @returns {Promise<string>}  the field's value (empty string if not found)
 */
export async function getHiddenFieldValue(page, fieldName, formSelector) {
  return page.evaluate(({ fieldName, formSelector }) => {
    let root = document;
    if (formSelector) {
      const f = document.querySelector(formSelector);
      if (f) root = f;
    }
    const upper = fieldName.toUpperCase();
    const lower = fieldName.toLowerCase();
    const el =
      root.querySelector(`input[name="${upper}"]`) ||
      root.querySelector(`input[name="${lower}"]`) ||
      document.querySelector(`input[name="${upper}"]`) ||
      document.querySelector(`input[name="${lower}"]`);
    return el ? el.value : '';
  }, { fieldName, formSelector });
}

// ─── Cookie Injection (VWO Experiment Script) ───────────────────────────────

/**
 * Clears browser cache, cookies, and localStorage/sessionStorage so each
 * attempt starts with a clean session.
 */
export async function clearCacheAndCookies(page) {
  const context = page.context();
  await context.clearCookies();
  await page.evaluate(() => {
    try { localStorage.clear(); } catch (_) { /* ignore */ }
    try { sessionStorage.clear(); } catch (_) { /* ignore */ }
  });
}

/**
 * Cloudflare/WAF detection — returns true if the page is a challenge page.
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
 * Accepts DataGrail cookie-consent banner if present.
 * Returns true if the button was found and clicked.
 */
export async function acceptCookies(page) {
  const btn = page.locator('button.dg-button.accept_all, button[data-testid="dg-accept-all"]').first();
  if (await btn.count() > 0) {
    await btn.click().catch(() => {});
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForTimeout(3000);
    console.log('  ✓ Cookie consent accepted');
    return true;
  }
  return false;
}

/**
 * Activates the A/B test session for Insightsoftware/VWO.
 *
 * For prelaunch mode (cookieScript provided):
 *   1. Land on the page so cookies have a valid origin
 *   2. Clear cache + cookies + storage
 *   3. Evaluate the experiment script (sets ExperimentName / ExperimentValue)
 *   4. Reload so the web rollout picks up the cookies
 *   5. Wait for the target cookie to appear, return detected bucket
 *
 * For live/postlaunch mode (empty cookieScript):
 *   Just observe whatever the live site assigns.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} url
 * @param {string} cookieScript        — VWO experiment snippet; empty = live
 * @param {object} buckets             — { variant: { value }, control: { value } }
 * @param {object} [options]
 * @param {string} [options.hiddenFieldName]    — default 'cro1'
 * @param {string} [options.formSelector]       — scope for hidden field
 * @param {string} [options.squeezePage]        — false | 'both'
 * @param {number} [options.maxAttempts=10]
 * @returns {Promise<{ bucket: string, cookies: object, cro1: string }>}
 */
export async function activateVariant(page, url, cookieScript, buckets, options = {}) {
  const {
    hiddenFieldName = 'cro1',
    formSelector    = null,
    squeezePage     = false,
    maxAttempts     = 10,
  } = options;

  const live = !cookieScript.trim();

  if (live) {
    console.log(`\n  POSTLAUNCH (live) — cookieScript is empty → observing LIVE buckets (no injection).`);
  } else {
    console.log(`\n  VWO experiment script — URL: ${url}`);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\n  ── Attempt ${attempt}/${maxAttempts} ──`);

    // Step 1 — land so cookies have a valid origin
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    // Step 2 — clear everything for a fresh session
    await clearCacheAndCookies(page);

    // Step 3 — inject the experiment script (prelaunch only)
    if (!live) {
      await page.evaluate((script) => { eval(script); }, cookieScript);
      const cookies = await getExperimentCookies(page);
      console.log(`  ExperimentName: "${cookies.experimentName}"  |  ExperimentValue: "${cookies.experimentValue}"`);
    }

    // Step 4 — reload so the web rollout fires and picks up cookies
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Step 5 — accept consent if needed
    await acceptCookies(page);

    // Check for WAF block
    if (await isBlockedByWAF(page)) {
      console.log('  ⚠ Cloudflare/WAF block detected');
      await rideOutWafBlock(page, url);
    }

    // Step 6 — read cookies and hidden field
    const cookies = await getExperimentCookies(page);
    const cro1    = await getHiddenFieldValue(page, hiddenFieldName, formSelector);

    console.log(`  ExperimentName: "${cookies.experimentName}"`);
    console.log(`  ExperimentValue: "${cookies.experimentValue}"`);
    console.log(`  CRO1: "${cro1}"`);

    // Step 7 — determine which bucket we landed on
    if (cookies.experimentValue) {
      const detectedValue = cookies.experimentValue.split(',').pop().trim();
      for (const [key, bucket] of Object.entries(buckets)) {
        if (detectedValue === bucket.value) {
          console.log(`  ✓ Bucket detected: ${key} (${bucket.value})`);
          return { bucket: key, cookies, cro1 };
        }
      }
      console.log(`  ⟳ ExperimentValue present ("${cookies.experimentValue}") but no bucket matched — retrying…`);
    } else {
      console.log(`  ⟳ No bucket detected — clearing cache and retrying…`);
    }
  }

  throw new Error(`Failed to detect any bucket after ${maxAttempts} attempts on ${url}`);
}

// ─── Cookie Screenshot ──────────────────────────────────────────────────────

/**
 * Takes a screenshot with a DevTools-style cookie overlay panel.
 */
export async function takeCookieScreenshot(page, label, hiddenFields) {
  const filePath = path.join(
    SCREENSHOT_DIR,
    `${label.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.png`
  );

  const experimentName  = await getCookie(page, hiddenFields?.experimentName  ?? 'ExperimentName');
  const experimentValue = await getCookie(page, hiddenFields?.experimentValue ?? 'ExperimentValue');
  const cro1            = await getHiddenFieldValue(page, hiddenFields?.cro1 ?? 'cro1');

  await page.evaluate(({ expName, expValue, cro1Val }) => {
    const existing = document.getElementById('__qa_cookie_overlay__');
    if (existing) existing.remove();

    const cookies = document.cookie.split(';').map(c => {
      const [n, ...v] = c.trim().split('=');
      return { name: n, value: v.join('=') };
    });

    const panel = document.createElement('div');
    panel.id = '__qa_cookie_overlay__';
    panel.innerHTML = `
      <div style="position:fixed;bottom:0;right:0;width:420px;max-height:80vh;
                  overflow-y:auto;z-index:2147483647;font-family:'Segoe UI',system-ui,sans-serif;
                  font-size:13px;background:#1e1e1e;color:#d4d4d4;border-top-left-radius:12px;
                  box-shadow:0 -4px 24px rgba(0,0,0,.5)">

        <!-- Header -->
        <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;
                    background:#252526;border-bottom:1px solid #3a3a3a;border-top-left-radius:12px">
          <span style="font-size:15px">🧪</span>
          <span style="color:#e0e0e0;font-weight:700;font-size:13px">QA Cookie Inspector</span>
          <span style="margin-left:auto;font-size:11px;color:#858585">${window.location.hostname}</span>
        </div>

        <!-- ExperimentName -->
        <div style="padding:6px 12px 2px;background:#252526;border-bottom:1px solid #2d2d2d">
          <span style="color:#858585;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">
            ExperimentName
          </span>
          <span style="margin-left:8px;background:${!expName ? '#4a1515' : '#1a3a1a'};
                       color:${!expName ? '#f48771' : '#4ec9b0'};
                       border-radius:10px;padding:1px 8px;font-size:11px;font-family:monospace">
            ${expName || '(not set)'}
          </span>
        </div>

        <!-- ExperimentValue -->
        <div style="padding:6px 12px 2px;background:#252526;border-bottom:1px solid #2d2d2d">
          <span style="color:#858585;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">
            ExperimentValue
          </span>
          <span style="margin-left:8px;background:${!expValue ? '#4a1515' : '#1a3a1a'};
                       color:${!expValue ? '#f48771' : '#4ec9b0'};
                       border-radius:10px;padding:1px 8px;font-size:11px;font-family:monospace">
            ${expValue || '(not set)'}
          </span>
        </div>

        <!-- CRO1 -->
        <div style="padding:6px 12px 2px;background:#252526;border-bottom:1px solid #2d2d2d">
          <span style="color:#858585;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">
            CRO1 (hidden field)
          </span>
          <span style="margin-left:8px;background:${!cro1Val ? '#4a1515' : '#1a3a1a'};
                       color:${!cro1Val ? '#f48771' : '#4ec9b0'};
                       border-radius:10px;padding:1px 8px;font-size:11px;font-family:monospace">
            ${cro1Val || '(not set)'}
          </span>
        </div>

        <!-- All cookies table -->
        <div style="display:flex;align-items:center;gap:8px;padding:5px 12px;
                    background:#252526;border-bottom:1px solid #3a3a3a;border-top:2px solid #3a3a3a">
          <span style="font-size:13px">🍪</span>
          <span style="color:#cccccc;font-weight:600;font-size:12px">Cookies</span>
          <span style="margin-left:auto;background:#007acc;color:#fff;border-radius:10px;padding:1px 8px;font-size:11px">
            ${cookies.length}
          </span>
        </div>
        <div style="display:grid;grid-template-columns:200px 1fr;padding:4px 10px;
                    background:#2d2d2d;border-bottom:1px solid #3a3a3a">
          <span style="color:#858585;font-size:11px;font-weight:600;text-transform:uppercase">Name</span>
          <span style="color:#858585;font-size:11px;font-weight:600;text-transform:uppercase">Value</span>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <tbody>${cookies.map(c => `
            <tr>
              <td style="padding:3px 10px;border-bottom:1px solid #333;color:#9cdcfe;font-family:monospace;font-size:11px">${c.name}</td>
              <td style="padding:3px 10px;border-bottom:1px solid #333;color:#ce9178;font-family:monospace;font-size:11px;word-break:break-all">${c.value}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    document.body.appendChild(panel);
    // Several client sites (SailPoint proven) carry an !important rule that hides
    // unknown body-level <div>s, which silently drops this overlay out of the
    // screenshot � the evidence then looks like "no CRO value was captured".
    // An inline !important declaration wins over any author stylesheet rule.
    panel.style.setProperty('display', 'block', 'important');
  }, {
    expName:  experimentName,
    expValue: experimentValue,
    cro1Val:  cro1,
  });

  await page.waitForTimeout(300);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`  📸 Screenshot: ${filePath}`);

  await page.evaluate(() => {
    const el = document.getElementById('__qa_cookie_overlay__');
    if (el) el.remove();
  });

  return filePath;
}

// ─── Assertion Helpers ──────────────────────────────────────────────────────

/**
 * Asserts that ExperimentValue cookie contains the expected token
 * (comma-aware — matches if the token appears in the list).
 */
export async function assertCookieValue(page, cookieName, expectedToken) {
  const raw = await getCookie(page, cookieName);
  expect(raw, `${cookieName} cookie should be set`).toBeTruthy();
  const tokens = raw.split(',').map(t => t.trim());
  expect(tokens, `${cookieName} should contain "${expectedToken}"`).toContain(expectedToken);
}

/**
 * Asserts that the CRO1 hidden field contains the expected token
 * (comma-aware).
 */
export async function assertCRO1Contains(page, expectedToken, fieldName = 'cro1', formSelector) {
  const value = await getHiddenFieldValue(page, fieldName, formSelector);
  expect(value, 'CRO1 hidden field should be set').toBeTruthy();
  const tokens = value.split(',').map(t => t.trim());
  expect(tokens, `CRO1 should contain "${expectedToken}"`).toContain(expectedToken);
}

/**
 * Asserts that CRO1 contains exactly the given list (order-sensitive).
 */
export async function assertCRO1Exact(page, expectedTokens, fieldName = 'cro1', formSelector) {
  const value = await getHiddenFieldValue(page, fieldName, formSelector);
  const actual = value ? value.split(',').map(t => t.trim()) : [];
  expect(actual, `CRO1 should equal [${expectedTokens}]`).toEqual(expectedTokens);
}

// ─── Deployed-Script Generators (A/A simulation) ────────────────────────────

/**
 * Generates the test-specific experiment script exactly as it is deployed via
 * VWO — sets ExperimentName / ExperimentValue cookies, appending comma-separated
 * when other tests are already present.
 *
 * squeezePage:
 *   false  → non-form page: cookies only
 *   true   → form page: window.squeezePageValue only
 *   'both' → form page: cookies AND window.squeezePageValue
 *
 * Only used in A/A mode (no cookieScript in the config) — in prelaunch the
 * site's own script runs and the suite only observes.
 *
 * @param {string} testId
 * @param {string} variantValue
 * @param {string} domain
 * @param {boolean|'both'} squeezePage
 * @returns {string} JS source to eval in the page
 */
export function generateExperimentScript(testId, variantValue, domain, squeezePage = false) {
  return `(function() {
    var squeezePage = ${JSON.stringify(squeezePage)};
    var expName = ${JSON.stringify(testId)};
    var variantName = ${JSON.stringify(variantValue)};
    var clientDomain = ${JSON.stringify(domain)};

    var formHiddenValue = variantName;
    if (squeezePage === true) {
        window.squeezePageValue = formHiddenValue;
    } else if (squeezePage === false) {
        hiddenValue(expName, variantName);
    } else if (squeezePage === 'both') {
        hiddenValue(expName, variantName);
        window.squeezePageValue = formHiddenValue;
    }

    function hiddenValue(currentExperimentName, currentExperimentValue) {
        function setCookie(name, value, days) {
            var expires = "";
            if (days) {
                var date = new Date();
                date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
                expires = "; expires=" + date.toUTCString();
            }
            document.cookie = name + "=" + (value || "") + expires + ";domain=" + clientDomain + ";path=/";
        }
        function getCookie(name) {
            var nameEQ = name + "=";
            var ca = document.cookie.split(';');
            for (var i = 0; i < ca.length; i++) {
                var c = ca[i];
                while (c.charAt(0) == ' ') c = c.substring(1, c.length);
                if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
            }
            return null;
        }
        var ExistingExperimentName = getCookie('ExperimentName');
        var ExistingExperimentValue = getCookie('ExperimentValue');
        var ExistingExperimentNameList = ExistingExperimentName ? ExistingExperimentName.split(',') : [];
        if (!ExistingExperimentName) {
            setCookie('ExperimentName', currentExperimentName, 1);
            setCookie('ExperimentValue', currentExperimentValue, 1);
        } else if (ExistingExperimentNameList.length > 0 && ExistingExperimentNameList.indexOf(currentExperimentName) == -1) {
            setCookie('ExperimentName', ExistingExperimentName + ',' + currentExperimentName, 1);
            setCookie('ExperimentValue', ExistingExperimentValue + ',' + currentExperimentValue, 1);
        } else if (ExistingExperimentNameList.length > 0 && ExistingExperimentNameList.indexOf(currentExperimentName) > -1) {
            var existingNames = ExistingExperimentName.split(',');
            var existingValues = ExistingExperimentValue.split(',');
            var index = existingNames.indexOf(currentExperimentName);
            existingValues[index] = currentExperimentValue;
            setCookie('ExperimentName', existingNames.join(','), 1);
            setCookie('ExperimentValue', existingValues.join(','), 1);
        }
    }
}());`;
}

/**
 * Generates the web-rollout script: reads the ExperimentValue cookie (merging
 * window.squeezePageValue) and writes the result into the CRO hidden field.
 * Retries while waiting for a lazily-rendered form.
 *
 * Only used in A/A mode — in prelaunch the site's own rollout runs.
 *
 * @param {string} hiddenFieldSelector e.g. 'input[name="cro1"]'
 * @returns {string} JS source to eval in the page
 */
export function generateWebRolloutScript(hiddenFieldSelector) {
  return `var inputFieldSelector = '${hiddenFieldSelector}';
var hiddenFieldEl = document.querySelector(inputFieldSelector);

function getCookieForHiddenValue(name) {
    var nameEQ = name + "=";
    var cookies = document.cookie.split(';');
    for (var i = 0; i < cookies.length; i++) {
        var c = cookies[i].trim();
        if (c.indexOf(nameEQ) === 0) {
            return c.substring(nameEQ.length);
        }
    }
    return null;
}

function setHiddenField() {
    if (!hiddenFieldEl) return;
    var squeezePageValue = (window.squeezePageValue !== undefined) ? window.squeezePageValue : "";
    var landingPageValue = getCookieForHiddenValue("ExperimentValue") || "";
    var finalList = landingPageValue ? landingPageValue.split(",") : [];
    if (squeezePageValue) {
        finalList = finalList.filter(v => v !== squeezePageValue);
        finalList.push(squeezePageValue);
    }
    var finalValue = finalList.join(",");
    if (finalValue) {
        hiddenFieldEl.value = finalValue;
    }
}

var attempts = 0;
var setHiddenFieldInterval = setInterval(() => {
    if (!hiddenFieldEl) {
        hiddenFieldEl = document.querySelector(inputFieldSelector);
    }
    if (hiddenFieldEl) {
        setHiddenField();
    }
    if (attempts >= 14) {
        clearInterval(setHiddenFieldInterval);
    }
    attempts++;
}, 1000);`;
}


/**
 * Validates the Insight config and resolves one plan per test.
 *
 * Called by the down-funnel spec at load time so a bad config fails fast, and by
 * insightsoftware.config.spec.js so the rules are permanently asserted as tests.
 *
 * Invariants enforced (all throw on violation):
 *   1. tests[].page must be a known page key
 *   2. tests[].page must be flagged isUnderTest: true
 *   3. tests[].flowthroughDestination entries must be known page keys
 *   4. tests[].flowthroughDestination entries must be FORM pages (have a formSelector)
 *   5. in prelaunch mode every {{placeholder}} in tests[].cookieScript must have a
 *      non-blank bucketActivation value for every bucket
 *
 * @param {object} config  INSIGHT_CONFIG
 * @returns {{test: object, tested: object, destinations: object[], carries: boolean,
 *            prelaunch: boolean, mode: string, bucketList: object[]}[]}
 */
export function resolveTestPlans(config) {
    const { pages, tests } = config;

    return tests.map((t) => {
        const tested = pages[t.page];
        if (!tested) {
            throw new Error(`Config error: test ${t.testId} references unknown page "${t.page}"`);
        }
        if (!tested.isUnderTest) {
            throw new Error(
                `Config error: test ${t.testId} runs on "${t.page}" but that page is not marked isUnderTest: true`
            );
        }

        const destinations = (t.flowthroughDestination || []).map((key) => {
            const p = pages[key];
            if (!p) {
                throw new Error(`Config error: test ${t.testId} lists unknown flowthroughDestination "${key}"`);
            }
            if (!p.formSelector) {
                throw new Error(
                    `Config error: test ${t.testId} flowthroughDestination "${key}" has no formSelector. Destinations are where a flowthrough value lands in a CRO field — list form pages (e.g. simbaDemo), not no-form flowthrough pages.`
                );
            }
            if (p.isUnderTest) {
                throw new Error(
                    `Config error: test ${t.testId} flowthroughDestination "${key}" is under test. A page can't be its own carry destination — the value originates here, it doesn't arrive here.`
                );
            }
            return p;
        });

        const prelaunch = Boolean(t.cookieScript.trim());

        // The activation snippet may be templated ({{combi}} for VWO) with the
        // per-bucket value in tests[].bucketActivation. A blank/null value would
        // be substituted verbatim and produce a broken script at runtime, so
        // reject it here — at load time — as a config error instead.
        if (prelaunch) {
            const placeholders = [...t.cookieScript.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
            for (const bucketKey of Object.keys(t.buckets)) {
                const values = t.bucketActivation?.[bucketKey] || {};
                const blank = placeholders.filter((p) => {
                    const v = values[p];
                    return v === undefined || v === null || String(v).trim() === '';
                });
                if (blank.length) {
                    throw new Error(
                        `Config error: test ${t.testId} bucket "${bucketKey}" cookieScript placeholder(s) ${[...new Set(blank)].join(', ')} have no bucketActivation value`
                    );
                }
            }
        }

        const bucketList = Object.entries(t.buckets).map(([key, b]) => ({
            key,
            label: b.label ?? key,
            bodyClass: b.bodyClass ?? '',
            expectedValue: b.expectedValue ?? '',
        }));

        // Waypoints: intermediate no-form pages the user passes through on the
        // way to the destination (e.g. home → products → demo). Optional —
        // empty/absent skips the waypoint loop entirely.
        const flowthroughWaypoints = (t.flowthroughPages || []).flatMap((key) => {
            const p = pages[key];
            if (!p) {
                console.warn(`Config warning: test ${t.testId} flowthroughPages lists unknown page key "${key}" — skipped`);
                return [];
            }
            if (!p.isFlowthrough) {
                console.warn(`Config warning: test ${t.testId} flowthroughPages "${key}" is not a flowthrough page — skipped`);
                return [];
            }
            if (p.isUnderTest) {
                console.warn(`Config warning: test ${t.testId} flowthroughPages "${key}" is under test — already asserted in step 1, skipped as waypoint`);
                return [];
            }
            return [p];
        });

        // Terminal: the form page asserted AFTER walking all waypoints.
        // Priority: squeeze-page-under-test → first flowthroughDestination.
        const waypointTerminal = flowthroughWaypoints.length > 0
            ? (Object.values(pages).find(p => p.isSqueezePage && p.isUnderTest && p.formSelector) ?? destinations[0] ?? null)
            : null;

        return {
            test: t,
            tested,
            destinations,
            flowthroughWaypoints,
            waypointTerminal,
            carries: tested.isFlowthrough,
            prelaunch,
            mode: prelaunch ? 'PRELAUNCH' : 'A/A',
            bucketList,
        };
    });
}

/**
 * Which test owns a SUBMISSION target page.
 *
 * A test claims a page two ways:
 *   t.page === key                   the experiment runs ON that page (the form
 *                                     is there too — 2002/request-a-price style)
 *   t.flowthroughDestination.includes(key)  the experiment runs on a no-form
 *                                     flowthrough page and FLOWS THROUGH to
 *                                     that squeeze page, where the form lives
 *                                     (5003/certent → certentDemo style)
 *
 * The second case is why a flowthrough test's submission target is never its
 * own `t.page`: you force the bucket on the tested page, walk the funnel, then
 * submit on the destination.
 *
 * @param {{tests?: {page?: string, flowthroughDestination?: string[]}[]}} config
 * @param {string} pageKey
 * @returns {object|null} the owning test, or null when nothing owns the page
 */
export function findOwningTest(config, pageKey) {
    return (config.tests || []).find((t) =>
        t.page === pageKey || (t.flowthroughDestination || []).includes(pageKey),
    ) || null;
}
