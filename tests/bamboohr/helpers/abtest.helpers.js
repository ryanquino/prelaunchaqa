/**
 * Reusable helpers for A/B test down-funnel QA
 *
 * Covers:
 *  - Cookie injection (variant / control activation)
 *  - Body-class verification
 *  - Hidden-field reading  (ExperimentName / ExperimentValue)
 *  - Down-funnel carry-over assertions
 *  - Cookie screenshot (DevTools-style panel overlaid on the page)
 */

import { expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

// ─── Cookie / Session Activation ─────────────────────────────────────────────

/**
 * Dismisses the DataGrail cookie-consent banner if present. A/B test scripts
 * often don't fire until the user accepts cookies.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>} true if the button was found and clicked
 */
export async function acceptCookies(page) {
  const btn = page.locator('button.dg-button.accept_all, button[data-testid="dg-accept-all"]').first();
  if (await btn.count() > 0) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(500);
    console.log('  ✓ Cookie consent accepted');
    return true;
  }
  return false;
}

/**
 * Normalizes a buckets config (object or array) into an array of
 * { key, label, bodyClass, expectedValue }.
 *
 * Config shape (object):
 *   buckets: {
 *     variantA: { label: 'Variant A', bodyClass: '…', expectedValue: '…' },
 *     variantB: { label: 'Variant B', bodyClass: '…', expectedValue: '…' },  // optional
 *     control:  { label: 'Control',   bodyClass: '…', expectedValue: '…' },
 *   }
 *
 * @param {object|Array} buckets
 * @returns {Array<{ key: string, label: string, bodyClass: string, expectedValue: string }>}
 */
function toBucketList(buckets) {
  if (Array.isArray(buckets)) return buckets;
  return Object.entries(buckets || {}).map(([key, b]) => ({
    key,
    label:       b.label ?? key,
    bodyClass:   b.bodyClass ?? '',
    expectedValue: b.expectedValue ?? '',
  }));
}

/**
 * Playwright waitForFunction predicate — true when ANY configured bucket is
 * observable via body class, hidden-field value, or the SPZ value cookie.
 * Runs inside the page, so it must be fully self-contained.
 */
function bucketDetectedInPage(args) {
  const cls = document.body.className;
  const input = document.querySelector(`input[name="${args.valueField}"]`);
  const val = input ? input.value : '';
  const tokens = (raw) => String(raw || '').split(',').map(s => s.trim());
  const fieldHas = (expected) => Boolean(expected) && tokens(val).includes(expected);
  const cookieHas = (expected) => Boolean(expected) && document.cookie.split(';').some(c => {
    const eq = c.indexOf('=');
    return eq >= 0 && tokens(c.slice(eq + 1)).includes(expected);
  });
  return args.buckets.some(b =>
    (b.bodyClass && cls.includes(b.bodyClass)) ||
    fieldHas(b.expectedValue) || cookieHas(b.expectedValue)
  );
}

/**
 * Detects which configured bucket is currently observable on the page.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Array} bucketList
 * @param {string} [valueFieldName]
 * @param {string} [formSelector]
 * @param {string} bodyClasses
 * @returns {Promise<object|null>}
 */
async function detectBucket(page, bucketList, valueFieldName, formSelector, bodyClasses) {
  for (const b of bucketList) {
    const isHit = (b.bodyClass && bodyClasses.includes(b.bodyClass)) ||
      await fieldHoldsValue(page, valueFieldName, formSelector, b.expectedValue) ||
      await cookieHoldsValue(page, b.expectedValue);
    if (isHit) return b;
  }
  return null;
}

/**
 * True when the current page is a Cloudflare/WAF challenge page (the site
 * returned HTTP 403 "Attention Required!"). These blocks are temporary
 * (typically clear in ~30-60s) — we just need to wait it out and retry.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>}
 */
async function isBlockedByWAF(page) {
  return page.evaluate(() => {
    const t   = document.title || '';
    const txt = document.body ? document.body.innerText : '';
    return /attention required/i.test(t) || /you have been blocked/i.test(txt);
  }).catch(() => true);
}

/**
 * Waits out a Cloudflare/WAF block with a short backoff. Returns once the site
 * serves a real page again (or after the backoff, whichever comes first).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} url
 * @returns {Promise<boolean>} true if the site recovered (not blocked anymore)
 */
async function rideOutWafBlock(page, url) {
  for (let i = 0; i < 3; i++) {
    if (!(await isBlockedByWAF(page))) return true;
    console.log(`  ⚠ Cloudflare/WAF challenge — backing off 15s (${i + 1}/3)…`);
    await page.waitForTimeout(15000);
    await page.goto(url, { waitUntil: 'load' }).catch(() => {});
  }
  return !(await isBlockedByWAF(page));
}

/**
 * Activates the A/B test session — injects the dev cookie script (prelaunch)
 * or simply observes live buckets (postlaunch, empty cookieScript) — and
 * returns whichever configured bucket the page lands on.
 *
 * Flow per attempt:
 *   1. Land on the page so document.cookie has a valid origin
 *   2. Clear cache + cookies + SPZ storage
 *   3. Inject the cookie script (prelaunch only)
 *   4. Navigate (fresh, not reload) so SPZ re-buckets
 *   5. Wait for ANY bucket to be observable, then return the detected one
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} url
 * @param {string} cookieScript      - dev snippet; empty = live/postlaunch
 * @param {object|Array} buckets     - all buckets of the test (see toBucketList)
 * @param {string} [valueFieldName]  - input[name] holding the experiment value
 * @param {string} [formSelector]    - scopes hidden-field lookup
 * @param {number} [maxAttempts=10]
 * @returns {Promise<{ bucket: string, bodyClasses: string }>}
 */
export async function activateVariant(page, url, cookieScript, buckets, valueFieldName, formSelector, maxAttempts = 10) {
  const bucketList = toBucketList(buckets);
  // Empty cookieScript → POSTLAUNCH: the test is already live, so there is no
  // activation snippet to inject. We just observe whatever bucket the live
  // site assigns — a fresh navigation re-buckets ~50/50, so the retry loop
  // below still converges on each bucket with real traffic.
  const live = !cookieScript.trim();

  // Parse cookie name from the script for logging
  const match = cookieScript.match(/setCookie\(\s*['"]([^'"]+)['"]/);
  const cookieName = match ? match[1] : '(unknown)';

  if (live) {
    console.log(`\n  POSTLAUNCH (live) — cookieScript is empty → observing LIVE buckets (no injection).`);
  } else {
    console.log(`\n  Cookie script targets: "${cookieName}"  |  URL: ${url}`);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\n  ── Attempt ${attempt}/${maxAttempts} ──`);

    // Step 1 — land on the page so document.cookie has a valid origin
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    // Step 2 — clear browser cache + cookies + SPZ storage so SPZ
    // re-evaluates the bucket on a fresh load instead of reusing
    // a cached variant/control assignment from a previous attempt.
    // Live mode: no cookieName to expire, but storage is still wiped so each
    // fresh navigation is a genuinely new visitor session.
    await clearCacheAndCookies(page);
    await clearSpzStorage(page, live ? '' : cookieName);

    // Step 3 — run the cookie script exactly as the dev team intended
    // (prelaunch only; live traffic gets no injection)
    if (!live) {
      await page.evaluate((script) => {
        // eslint-disable-next-line no-eval
        eval(script);
      }, cookieScript);

      const cookiesAfterInject = await page.evaluate(() => document.cookie);
      console.log(`  document.cookie after inject: "${cookiesAfterInject}"`);
    }

    // Step 4 — navigate so SPZ re-buckets on a clean page load.
    // Fresh navigation (not reload): on flowthrough pages SPZ keeps the bucket
    // sticky across reloads but re-randomises on a full navigation.
    await page.goto(url, { waitUntil: 'load' });

    // Accept the DataGrail cookie-consent banner if present — A/B scripts
    // often don't fire until the user consents. DataGrail reloads the page
    // after acceptance, so just wait for that reload instead of navigating.
    const accepted = await acceptCookies(page);
    if (accepted) {
      // DataGrail triggers a page reload after consent — wait for it
      await page.waitForLoadState('load').catch(() => {});
      await page.waitForTimeout(3000);
    }

    // Cloudflare occasionally challenges automated traffic (temporary 403 block
    // page). Ride it out with backoff instead of failing the attempt.
    if (!(await rideOutWafBlock(page, url))) {
      console.log(`  ⚠ Still blocked by Cloudflare/WAF — trying next attempt…`);
      continue;
    }

    // Wait until ANY bucket is observable via body class OR hidden-field value
    await page.waitForFunction(
      bucketDetectedInPage,
      { buckets: bucketList, valueField: valueFieldName || '' },
      { timeout: 15000 }
    ).catch(() => {});

    const bodyClasses   = await page.evaluate(() => document.body.className);
    const cookiesOnLoad = await page.evaluate(() => document.cookie);
    const fieldValue    = valueFieldName ? await getHiddenFieldValue(page, valueFieldName, formSelector) : null;

    console.log(`  document.cookie on reload  : "${cookiesOnLoad}"`);
    console.log(`  Body classes               : "${bodyClasses}"`);
    if (fieldValue !== null) console.log(`  ${valueFieldName} value      : "${fieldValue}"`);

    const detected = await detectBucket(page, bucketList, valueFieldName, formSelector, bodyClasses);
    if (detected) {
      console.log(`  ✅ Bucket detected: ${detected.label} (${detected.key})`);
      return { bucket: detected.key, bodyClasses };
    }

    console.log(`  ⟳ No bucket detected — clearing cache and retrying…`);
  }

  const finalClasses = await page.evaluate(() => document.body.className);
  const finalCookies = await page.evaluate(() => document.cookie);
  const liveHint = live
    ? `  ⚠ Live mode (cookieScript is empty): no bucket was observed in ${maxAttempts}\n` +
      `    fresh sessions. Either the test is NOT actually live yet, or the expected\n` +
      `    values / body classes in the config don't match the live site.`
    : `  ⚠ Verify the cookieScript works by pasting it in the browser console\n` +
      `    on this URL, then reloading and checking the body class manually.`;
  throw new Error(
    `activateVariant: no configured bucket appeared after ${maxAttempts} attempts.\n` +
    `  Cookie targeted : "${cookieName}"\n` +
    `  Expected buckets:\n` +
    bucketList.map(b => `    - ${b.key} (${b.label}): class="${b.bodyClass}" value="${b.expectedValue}"`).join('\n') + '\n' +
    `  Final classes   : "${finalClasses}"\n` +
    `  Final cookies   : "${finalCookies}"\n` +
    `  URL             : ${url}\n\n` +
    liveHint
  );
}

/**
 * Clears the browser cache and all cookies for the context.
 *
 * Uses the CDP session (Chromium) to disable caching for the session and
 * purge the browser cache, so every reload after this fetches fresh
 * resources — including the SPZ bundle — instead of stale cached ones.
 *
 * @param {import('@playwright/test').Page} page
 */
async function clearCacheAndCookies(page) {
  const context = page.context();

  const client = await context.newCDPSession(page).catch(() => null);
  if (client) {
    try {
      await client.send('Network.setCacheDisabled', { cacheDisabled: true });
      await client.send('Network.clearBrowserCache');
      console.log('  🧹 Browser cache cleared');
    } catch (err) {
      console.warn(`  ⚠ Could not clear browser cache via CDP: ${err.message}`);
    }
  }

  await context.clearCookies();
  console.log('  🧹 Cookies cleared');
}

/**
 * Removes SPZ bucket-assignment state on the current origin: expires
 * spz/intellimize/splitzilla cookies and the QA activation cookie, and
 * clears matching keys from localStorage and sessionStorage.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} cookieName  - the QA activation cookie name
 */
async function clearSpzStorage(page, cookieName) {
  await page.evaluate((name) => {
    document.cookie.split(';').forEach(c => {
      const key = c.split('=')[0].trim();
      if (/spz|intellimize|splitzilla/i.test(key) || key === name) {
        [`path=/`, `path=/;domain=${location.hostname}`, `path=/;domain=.${location.hostname.split('.').slice(-2).join('.')}`]
          .forEach(suffix => {
            document.cookie = `${key}=;${suffix};expires=Thu, 01 Jan 1970 00:00:01 GMT`;
          });
      }
    });
    Object.keys(localStorage).forEach(k => { if (/spz|intellimize|splitzilla/i.test(k)) localStorage.removeItem(k); });
    Object.keys(sessionStorage).forEach(k => { if (/spz|intellimize|splitzilla/i.test(k)) sessionStorage.removeItem(k); });
  }, cookieName);
}

/**
 * Loads a specific bucket by retrying until it is confirmed via its body class,
 * the CRO hidden-field value, or the SPZ value cookie. Control buckets (true
 * control) often add no body class, so the field/cookie value is the only signal.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} targetBucket       - bucket key, e.g. 'variantA', 'variantB', 'control'
 * @param {string} url
 * @param {string} cookieScript       - dev snippet; empty = live/postlaunch
 * @param {object|Array} buckets      - all buckets of the test (see toBucketList)
 * @param {string} [valueFieldName]   - input[name] holding the experiment value
 * @param {string} [formSelector]     - scopes hidden-field lookup
 * @param {number} [maxAttempts=10]
 * @returns {Promise<{ bucket: string, bodyClasses: string }>}  the confirmed
 *   bucket key and the bodyClasses string seen when it was confirmed
 */
export async function loadBucket(page, targetBucket, url, cookieScript, buckets, valueFieldName, formSelector, maxAttempts = 10) {
  const bucketList = toBucketList(buckets);
  const target     = bucketList.find(b => b.key === targetBucket);
  // Empty cookieScript → POSTLAUNCH (live). No injection — the live site
  // buckets each fresh navigation ~50/50, so the retry loop below converges
  // on the target bucket with real traffic.
  const live = !cookieScript.trim();
  if (live) {
    console.log(`\n  POSTLAUNCH (live) — cookieScript is empty → observing LIVE buckets (no injection).`);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\n  ── [${targetBucket.toUpperCase()}] Attempt ${attempt}/${maxAttempts} ──`);

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    // Clear cache + cookies + SPZ storage so SPZ re-buckets on a fresh load.
    // Live mode: no injection; storage is still wiped so each fresh navigation
    // is a genuinely new visitor session.
    await clearCacheAndCookies(page);
    if (live) {
      await clearSpzStorage(page, '');
    } else {
      await clearSpzStorage(page, cookieScript.match(/setCookie\(\s*['"]([^'"]+)['"]/)?.[1] ?? '');

      // Inject the QA cookie
      await page.evaluate((script) => { eval(script); }, cookieScript); // eslint-disable-line no-eval
    }

    // Navigate (fresh, not reload) so SPZ re-buckets — on flowthrough pages the
    // bucket is sticky across reloads but re-randomises on a full navigation.
    await page.goto(url, { waitUntil: 'load' });

    // Accept the DataGrail cookie-consent banner if present — A/B scripts
    // often don't fire until the user consents. DataGrail reloads the page
    // after acceptance, so just wait for that reload instead of navigating.
    const accepted = await acceptCookies(page);
    if (accepted) {
      // DataGrail triggers a page reload after consent — wait for it
      await page.waitForLoadState('load').catch(() => {});
      await page.waitForTimeout(3000);
    }

    // Cloudflare occasionally challenges automated traffic (temporary 403 block
    // page). Ride it out with backoff instead of failing the attempt.
    if (!(await rideOutWafBlock(page, url))) {
      console.log(`  ⚠ Still blocked by Cloudflare/WAF — trying next attempt…`);
      continue;
    }

    // Wait until ANY bucket is observable via body class OR hidden-field value
    await page.waitForFunction(
      bucketDetectedInPage,
      { buckets: bucketList, valueField: valueFieldName || '' },
      { timeout: 15000 }
    ).catch(() => {});

    const bodyClasses = await page.evaluate(() => document.body.className);
    const fieldValue  = valueFieldName ? await getHiddenFieldValue(page, valueFieldName, formSelector) : null;
    console.log(`  Body classes: "${bodyClasses}"`);
    if (fieldValue !== null) console.log(`  ${valueFieldName} value : "${fieldValue}"`);

    const detected = await detectBucket(page, bucketList, valueFieldName, formSelector, bodyClasses);
    if (detected && detected.key === targetBucket) {
      console.log(`  ✅ ${target.label} (${target.key}) loaded`);
      return { bucket: targetBucket, bodyClasses };
    }

    console.log(`  ⟳ Got wrong bucket — clearing cache and retrying…`);
  }

  const finalClasses = await page.evaluate(() => document.body.className);
  const finalValue   = valueFieldName ? await getHiddenFieldValue(page, valueFieldName, formSelector) : null;
  const liveHint = live
    ? `  ⚠ Live mode (cookieScript is empty): this bucket was never observed in ${maxAttempts}\n` +
      `    fresh sessions. Either the test is NOT actually live yet, or the expected\n` +
      `    values / body classes in the config don't match the live site.`
    : ``;
  throw new Error(
    `loadBucket: could not load "${targetBucket}" after ${maxAttempts} attempts.\n` +
    `  Expected bucket : "${target.label} (${target.key})" — class="${target.bodyClass}" value="${target.expectedValue}"\n` +
    `  Final classes  : "${finalClasses}"\n` +
    `  Final ${valueFieldName || 'field'}   : "${finalValue ?? '(n/a)'}"\n` +
    `  URL            : ${url}\n` +
    (liveHint ? `\n${liveHint}` : ``)
  );
}

/**
 * Sets a cookie directly on the browser context via addCookies(),
 * so it exists before the page ever loads.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} name
 * @param {string|boolean} value
 * @param {string} domain  e.g. 'www.sailpoint.com'
 */
export async function setCookieDirect(context, name, value, domain) {
  const expiresTimestamp = Math.floor(Date.now() / 1000) + 86400; // 1 day
  await context.addCookies([
    {
      name,
      value: String(value),
      domain,
      path: '/',
      expires: expiresTimestamp,
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

// ─── Cookie Screenshot ────────────────────────────────────────────────────────

/**
 * Takes a screenshot with a three-section DevTools-style panel overlaid:
 *
 *  1. 🔍 Elements  — shows the actual outerHTML of the hidden input fields,
 *                    with the value attribute highlighted in yellow, exactly
 *                    like searching for the field in DevTools Elements tab.
 *  2. 🧪 Experiment — CRO1 / CRO2 field name → current value summary row
 *  3. 🍪 Cookies   — all document.cookie values as a Name/Value table
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} label            - filename prefix
 * @param {object} [hiddenFields]   - { experimentName, experimentValue } field names
 * @param {string} [formSelector]   - scopes hidden field lookup to a form
 * @param {string} [screenshotsDir] - output folder (default: screenshots/cookies —
 *                                    NOT test-results/, which Playwright wipes at
 *                                    the start of every run and would silently
 *                                    delete the evidence)
 * @returns {Promise<string>}       absolute path of the saved screenshot
 */
export async function screenshotWithCookies(page, label, hiddenFields, formSelector, screenshotsDir) {
  const outDir   = screenshotsDir || path.resolve('screenshots', 'cookies');
  fs.mkdirSync(outDir, { recursive: true });

  const safeName  = label.replace(/[^a-z0-9_-]/gi, '_').replace(/_+/g, '_');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath  = path.join(outDir, `${safeName}_${timestamp}.png`);

  // ── Read hidden field values + outerHTML via Playwright locators ───────────
  const tryRead = async (fieldName) => {
    const selectors = formSelector
      ? [
          page.locator(formSelector).first().locator(`input[name="${fieldName}"]`).first(),
          page.locator(`input[name="${fieldName}"]`).first(),
        ]
      : [page.locator(`input[name="${fieldName}"]`).first()];

    for (const loc of selectors) {
      if (await loc.count() > 0) {
        const value   = await loc.evaluate(el => el.value)   || '(empty)';
        const outerHTML = await loc.evaluate(el => el.outerHTML) || '';
        return { value, outerHTML };
      }
    }
    return { value: '(not found)', outerHTML: '' };
  };

  let nameResult  = { value: '(not found)', outerHTML: '' };
  let valueResult = { value: '(not found)', outerHTML: '' };

  if (hiddenFields) {
    nameResult  = await tryRead(hiddenFields.experimentName);
    valueResult = await tryRead(hiddenFields.experimentValue);
  }

  // ── Inject overlay ─────────────────────────────────────────────────────────
  await page.evaluate(({
    expNameLabel, expNameVal, expNameHTML,
    expValueLabel, expValueVal, expValueHTML,
  }) => {
    const existing = document.getElementById('__qa_cookie_overlay__');
    if (existing) existing.remove();

    // ── Cookies ──────────────────────────────────────────────────────────────
    const cookies = document.cookie
      .split(';').map(c => c.trim()).filter(Boolean)
      .map(c => {
        const idx = c.indexOf('=');
        return { name: idx >= 0 ? c.slice(0, idx).trim() : c.trim(),
                 value: idx >= 0 ? c.slice(idx + 1).trim() : '' };
      });

    // ── DF cookies ────────────────────────────────────────────────────────────
    // The experiment cookies ARE the down-funnel evidence, but this site sets
    // ~60 cookies and the bottom panel is only 380px tall — so they used to sit
    // buried mid-table and never made it into the screenshot.
    //
    // They get their OWN card pinned top-left rather than living in the panel:
    // when a <dialog> popup is open it sits in the browser's top layer, which
    // paints over every z-index, so a centred modal would clip the value. The
    // top-left corner is outside the modal's box, so it stays readable.
    const DF_COOKIE = /experiment|spz|^lpv/i;
    const dfCookies = cookies.filter(c => DF_COOKIE.test(c.name));
    if (dfCookies.length) {
      const card = document.createElement('div');
      card.id = '__qa_df_cookies__';
      card.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;' +
        'background:#1e1e1e;border:2px solid #4ec9b0;border-radius:6px;' +
        'padding:8px 12px;font-family:monospace;max-width:46vw;' +
        'box-shadow:0 4px 20px rgba(0,0,0,.6)';
      card.innerHTML =
        `<div style="color:#cccccc;font-weight:600;font-size:11px;
                     font-family:'Segoe UI',system-ui,sans-serif;
                     text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">
           🎯 DF cookies — pinned
         </div>` +
        dfCookies.map(({ name, value }) => `
          <div style="margin:3px 0;font-size:12px;line-height:1.5;word-break:break-all">
            <span style="color:#858585">${name}</span><span style="color:#4ec9b0"> = ${value || '(empty)'}</span>
          </div>`).join('');
      document.body.appendChild(card);
      // Same !important guard as the panel — some client stylesheets hide
      // unknown body-level elements, which would drop the evidence silently.
      card.style.setProperty('display', 'block', 'important');
    }

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

    // ── Elements-style HTML renderer ─────────────────────────────────────────
    // Highlights the value="..." attribute in yellow, like DevTools does
    const renderElementsHTML = (fieldName, outerHtml, currentValue) => {
      if (!outerHtml) {
        return `<span style="color:#888;font-style:italic;font-size:12px">
                  &lt;input name="${fieldName}"&gt; not found on page</span>`;
      }
      // Escape HTML entities for display
      const escaped = outerHtml
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

      // Colour the attribute tokens like DevTools:
      // attribute name = #9cdcfe (blue), value = #ce9178 (orange), highlighted value = yellow bg
      let coloured = escaped
        // Highlight the value attribute with yellow background
        .replace(
          /(value=&quot;)([^&]*)(&quot;)/g,
          `<span style="color:#9cdcfe">value</span>=<span style="background:#3a3000;color:#ffd700;border-radius:2px;padding:0 2px">&quot;$2&quot;</span>`
        )
        // Colour remaining attribute names
        .replace(/(\w[\w-]*)=&quot;/g, '<span style="color:#9cdcfe">$1</span>=&quot;')
        // Colour tag name
        .replace(/^(&lt;\w+)/, '<span style="color:#4ec9b0">$1</span>')
        .replace(/(&gt;)$/, '<span style="color:#4ec9b0">$1</span>');

      return `<code style="font-family:monospace;font-size:12px;color:#d4d4d4;
                           white-space:pre-wrap;word-break:break-all;line-height:1.6">
                ${coloured}
              </code>`;
    };

    const panel = document.createElement('div');
    panel.id = '__qa_cookie_overlay__';
    panel.innerHTML = `
      <div style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;
                  background:#1e1e1e;border-top:2px solid #007acc;
                  font-family:'Segoe UI',system-ui,sans-serif;
                  max-height:380px;overflow-y:auto;
                  box-shadow:0 -4px 20px rgba(0,0,0,0.6)">

        <!-- ══ ELEMENTS SECTION ══════════════════════════════════════════════ -->
        <div style="display:flex;align-items:center;gap:8px;padding:5px 12px;
                    background:#1a1a2e;border-bottom:1px solid #3a3a3a;position:sticky;top:0">
          <span style="font-size:13px">🔍</span>
          <span style="color:#cccccc;font-weight:600;font-size:12px">Elements — Hidden Field Inspection</span>
          <span style="margin-left:auto;color:#858585;font-size:11px">${window.location.pathname}</span>
        </div>

        <!-- CRO1 -->
        <div style="padding:6px 12px 2px;background:#252526;
                    border-bottom:1px solid #2d2d2d">
          <span style="color:#858585;font-size:11px;font-weight:600;
                       text-transform:uppercase;letter-spacing:.05em">
            CRO1 — ${expNameLabel}
          </span>
          <span style="margin-left:8px;background:${expNameVal === '(not found)' ? '#4a1515' : '#1a3a1a'};
                       color:${expNameVal === '(not found)' ? '#f48771' : '#4ec9b0'};
                       border-radius:10px;padding:1px 8px;font-size:11px;font-family:monospace">
            ${expNameVal}
          </span>
        </div>
        <div style="padding:6px 12px 8px;background:#252526;border-bottom:1px solid #3a3a3a">
          ${renderElementsHTML(expNameLabel, expNameHTML, expNameVal)}
        </div>

        <!-- CRO2 -->
        <div style="padding:6px 12px 2px;background:#252526;
                    border-bottom:1px solid #2d2d2d">
          <span style="color:#858585;font-size:11px;font-weight:600;
                       text-transform:uppercase;letter-spacing:.05em">
            CRO2 — ${expValueLabel}
          </span>
          <span style="margin-left:8px;background:${expValueVal === '(not found)' ? '#4a1515' : '#1a3a1a'};
                       color:${expValueVal === '(not found)' ? '#f48771' : '#4ec9b0'};
                       border-radius:10px;padding:1px 8px;font-size:11px;font-family:monospace">
            ${expValueVal}
          </span>
        </div>
        <div style="padding:6px 12px 8px;background:#252526;border-bottom:1px solid #3a3a3a">
          ${renderElementsHTML(expValueLabel, expValueHTML, expValueVal)}
        </div>

        <!-- ══ COOKIES SECTION ═══════════════════════════════════════════════ -->
        <div style="display:flex;align-items:center;gap:8px;padding:5px 12px;
                    background:#252526;border-bottom:1px solid #3a3a3a;
                    border-top:2px solid #3a3a3a">
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
  }, {
    expNameLabel:  hiddenFields?.experimentName  ?? 'intellimize1',
    expNameVal:    nameResult.value,
    expNameHTML:   nameResult.outerHTML,
    expValueLabel: hiddenFields?.experimentValue ?? 'intellimize2',
    expValueVal:   valueResult.value,
    expValueHTML:  valueResult.outerHTML,
  });

  await page.waitForTimeout(300);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`  📸 Screenshot: ${filePath}`);

  await page.evaluate(() => {
    for (const id of ['__qa_cookie_overlay__', '__qa_df_cookies__']) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
  });

  return filePath;
}

// ─── Body-class Verification ─────────────────────────────────────────────────

/**
 * Asserts that <body> has the given class via classList.contains().
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} expectedClass
 */
export async function assertBodyClass(page, expectedClass) {
  const hasClass = await page.evaluate(
    (cls) => document.body.classList.contains(cls),
    expectedClass
  );
  expect(hasClass, `Body should have class "${expectedClass}"`).toBe(true);
}

/**
 * Returns the full className string from <body>.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>}
 */
export async function getBodyClasses(page) {
  return page.evaluate(() => document.body.className);
}

// ─── Hidden-field Helpers ─────────────────────────────────────────────────────

/**
 * Reads the value of a hidden input by its [name] attribute.
 *
 * Search order:
 *  1. input[name="fieldName"] anywhere on the page (covers Marketo hidden fields
 *     like intellimize1/intellimize2 which may sit outside the <form> element)
 *  2. Scoped to formSelector if provided (narrows to a specific form)
 *  3. [data-field-name="fieldName"] fallback for custom implementations
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} fieldName     e.g. 'intellimize1' or 'intellimize2'
 * @param {string} [formSelector]
 * @returns {Promise<string|null>}
 */
export async function getHiddenFieldValue(page, fieldName, formSelector) {
  // 1. Try scoped to form first (most precise)
  if (formSelector) {
    const scoped = page.locator(formSelector).first().locator(`input[name="${fieldName}"]`).first();
    if (await scoped.count() > 0) {
      return scoped.evaluate(el => el.value);
    }
  }

  // 2. Try anywhere on the page — Marketo sometimes places hidden inputs
  //    outside the <form> tag itself
  const anywhere = page.locator(`input[name="${fieldName}"]`).first();
  if (await anywhere.count() > 0) {
    return anywhere.evaluate(el => el.value);
  }

  // 3. data-field-name fallback
  const scope = formSelector ? page.locator(formSelector).first() : page;
  const byData = scope.locator(`[data-field-name="${fieldName}"]`).first();
  if (await byData.count() > 0) {
    return byData.evaluate(el => el.value || el.getAttribute('value') || el.textContent?.trim() || null);
  }

  return null;
}

/**
 * Waits (up to `timeout`) for a hidden field to actually hold a value, then
 * returns it.
 *
 * Marketo injects the DF values asynchronously — opening a popup or navigating
 * finds the input present but empty for a moment. A single immediate read
 * therefore races the injection and reports "", so poll until populated.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} formSelector
 * @param {string} fieldName
 * @param {{timeout?: number, scrollInterval?: number}} [options]
 * @returns {Promise<string|null>} the value once populated, else the last read
 */
export async function waitForFormField(page, formSelector, fieldName, options = {}) {
  const { timeout = 20000, scrollInterval = 1500 } = options;
  const started = Date.now();

  let value = await getHiddenFieldValue(page, fieldName, formSelector);
  while (Date.now() - started < timeout) {
    if (value !== null && String(value).trim().length > 0) return value;
    // Not populated yet — scroll to trigger the lazy render, then re-read.
    await page.mouse.wheel(0, 3000).catch(() => {});
    await page.waitForTimeout(scrollInterval);
    value = await getHiddenFieldValue(page, fieldName, formSelector);
  }

  return value;
}

/**
 * Whether any cookie in document.cookie holds exactly the given value.
 *
 * Cookie-name agnostic on purpose: SPZ's bucket cookie name varies per test
 * (ExperimentValue for 3016, HiddenFieldValue for 2023, …), so detection on
 * flowthrough pages (no form → no hidden field) matches on the distinctive
 * bucket VALUE instead, e.g. "SPZ_2023_variant".
 *
 * Values may be comma-joined when multiple tests run on the same page
 * (e.g. "SPZ_2023_variant,SPZ_2038_variant1"), so matching is token-based.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} [expectedValue]   e.g. 'SPZ_3016_variant'
 * @returns {Promise<boolean>}
 */
export async function cookieHoldsValue(page, expectedValue) {
  if (!expectedValue) return false;
  return page.evaluate(
    (expected) => {
      const tokens = (raw) => String(raw || '').split(',').map(s => s.trim());
      return document.cookie.split(';').some(c => {
        const eq = c.indexOf('=');
        return eq >= 0 && tokens(c.slice(eq + 1)).includes(expected);
      });
    },
    expectedValue
  );
}

/**
 * Whether the CRO hidden field holds the given value (token-aware).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} fieldName     e.g. 'intellimize1'
 * @param {string} [formSelector]
 * @param {string} [expectedValue]
 * @returns {Promise<boolean>}
 */
export async function fieldHoldsValue(page, fieldName, formSelector, expectedValue) {
  if (!fieldName || !expectedValue) return false;
  const raw = await getHiddenFieldValue(page, fieldName, formSelector);
  return String(raw || '').split(',').map(s => s.trim()).includes(expectedValue);
}

/**
 * Asserts ExperimentName (CRO1) and ExperimentValue (CRO2) match expected values.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ experimentName: string, experimentValue: string }} expected
 * @param {object} hiddenFields  from TEST_CONFIG.hiddenFields
 * @param {string} [formSelector]
 */
export async function assertHiddenFields(page, expected, hiddenFields, formSelector) {
  const tokens = (raw) => String(raw || '').split(',').map(s => s.trim());

  const nameVal  = await getHiddenFieldValue(page, hiddenFields.experimentName,  formSelector);
  const valueVal = await getHiddenFieldValue(page, hiddenFields.experimentValue, formSelector);

  expect(
    tokens(nameVal),
    `ExperimentName (CRO1) on "${await page.title()}" should contain "${expected.experimentName}"`
  ).toContain(expected.experimentName);

  expect(
    tokens(valueVal),
    `ExperimentValue (CRO2) on "${await page.title()}" should contain "${expected.experimentValue}"`
  ).toContain(expected.experimentValue);
}

// ─── Navigation ───────────────────────────────────────────────────────────────

/**
 * Navigates to a URL and waits for the page to settle.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} url
 */
export async function gotoAndWait(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
}

/**
 * Prints a clearly visible step header to the test output.
 *
 * @param {string} msg
 */
export function logStep(msg) {
  console.log(`\n${'─'.repeat(60)}\n  ${msg}\n${'─'.repeat(60)}`);
}
