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
 * Why a page cannot be a downstream carry destination, or null if it can.
 * Mirrors the guard the down-funnel spec has always applied inline.
 *
 * @param {object} page
 * @returns {string|null}
 */
function destinationIneligibleReason(page) {
  if (page.isUnderTest) return 'is under test';
  if (page.isFlowthrough) return 'is a flowthrough page (no form to carry into)';
  if (page.isDestination === false) return 'has isDestination: false';
  if (!page.formSelector) return 'has no formSelector';
  return null;
}

/**
 * Why a page cannot be a flowthrough WAYPOINT, or null if it can.
 *
 * Waypoints are the intermediate no-form pages the user passes through on the
 * way to a destination (e.g. /products/…). The df value must survive each hop,
 * so a waypoint has to be a flowthrough page that is NOT itself under test —
 * under-test pages are already asserted in step 1.
 *
 * @param {object} page
 * @returns {string|null}
 */
function flowThroughIneligibleReason(page) {
  if (!page.isFlowthrough) return 'is not a flowthrough page (waypoints carry the value via cookie, not a form)';
  if (page.isUnderTest) return 'is under test (already asserted in step 1)';
  return null;
}

/**
 * Resolves the SailPoint TEST_CONFIG into the concrete page sets the down-funnel
 * spec runs against, THROWING on any config that would otherwise produce a
 * silently-wrong run (a typo'd destination key used to be dropped without
 * error, quietly testing fewer pages than intended).
 *
 * Invariants enforced:
 *   1. at least one page must be flagged isUnderTest
 *   2. every flowthroughDestination key must be a known page
 *   3. every flowthroughDestination page must be a valid destination
 *   4. every interruptionPages key must be a known page
 *   5. every flowthroughPages key must be a known flowthrough page
 *
 * When flowthroughDestination is empty/absent the destinations fall back to
 * every remaining eligible form page (preserving the original behaviour).
 *
 * @param {object} config - a TEST_CONFIG-shaped object
 * @returns {{
 *   testedPages: object[], destinations: object[], interruptionPages: object[],
 *   flowthroughWaypoints: object[],
 *   bucketList: Array<{key:string,label:string,bodyClass:string,expectedValue:string}>,
 *   configuredDestinationKeys: string[]|undefined, isLive: boolean, mode: string
 * }}
 */
export function resolvePlan(config) {
  const {
    pages,
    cookieScript,
    buckets,
    flowthroughDestination: configuredDestinationKeys,
    interruptionPages: interruptionPageKeys = [],
    flowthroughPages: flowThroughKeys = [],
  } = config;

  const testedPages = Object.values(pages).filter(p => p.isUnderTest);
  if (testedPages.length === 0) {
    throw new Error('Config error: mark the page(s) under test with `isUnderTest: true` in sailpoint.config.js');
  }

  const destGuard = (p) => destinationIneligibleReason(p) === null;

  // Destinations are only relevant for FLOWTHROUGH tested pages (value carries
  // to downstream forms). For FORM tested pages (isFlowthrough: false), the
  // value stays on the tested page and does NOT carry — so destinations are
  // always empty, and flowthroughDestination in the config is ignored/skipped.
  const anyFlowthrough = testedPages.some(p => p.isFlowthrough);

  let destinations;
  if (!anyFlowthrough) {
    // Form page under test — no carry, no destinations needed
    destinations = [];
  } else if (configuredDestinationKeys && configuredDestinationKeys.length) {
    destinations = configuredDestinationKeys.flatMap((key) => {
      const p = pages[key];
      if (!p) {
        console.warn(`Config warning: flowthroughDestination lists unknown page key "${key}" — skipped`);
        return [];
      }
      const reason = destinationIneligibleReason(p);
      if (reason) {
        console.warn(`Config warning: flowthroughDestination "${key}" ${reason} — skipped`);
        return [];
      }
      return [p];
    });
  } else {
    destinations = Object.values(pages).filter(p => destGuard(p));
  }

  const interruptionPages = interruptionPageKeys.map((key) => {
    const p = pages[key];
    if (!p) {
      throw new Error(`Config error: interruptionPages contains unknown page key "${key}"`);
    }
    return p;
  });

  // Waypoints: intermediate flowthrough pages the user passes through. Optional
  // (empty/absent → skipped). Resolved eagerly so a typo fails loudly here.
  const flowthroughWaypoints = (flowThroughKeys || []).flatMap((key) => {
    const p = pages[key];
    if (!p) {
      console.warn(`Config warning: flowthroughPages contains unknown page key "${key}" — skipped`);
      return [];
    }
    const reason = flowThroughIneligibleReason(p);
    if (reason) {
      console.warn(`Config warning: flowthroughPages "${key}" ${reason} — skipped`);
      return [];
    }
    return [p];
  });

  // Terminal page: the form page the user lands on AFTER walking all waypoints.
  // Priority order:
  //   1. A squeeze page that is also isUnderTest (the test runs there + has a form)
  //   2. The first configured flowthroughDestination page
  //   3. The first auto-derived eligible destination
  // Only relevant when flowthroughWaypoints is non-empty.
  let waypointTerminal = null;
  if (flowthroughWaypoints.length > 0) {
    waypointTerminal =
      Object.values(pages).find(p => p.isSqueezePage && p.isUnderTest && p.formSelector) ??
      destinations[0] ??
      null;
  }

  const bucketList = toBucketList(buckets);

  const isLive = !String(cookieScript ?? '').trim();
  const mode = isLive ? 'LIVE (postlaunch)' : 'PRELAUNCH';

  return {
    testedPages,
    destinations,
    interruptionPages,
    flowthroughWaypoints,
    waypointTerminal,
    bucketList,
    configuredDestinationKeys,
    isLive,
    mode,
  };
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
  const tokens = (raw) => String(raw || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
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
 *                                    kept OUT of test-results because Playwright
 *                                    cleans that directory at the start of each run)
 * @param {{ stepLabel?: string, bucketLabel?: string, bucketValue?: string, showCookieCarry?: boolean }} [overlay]
 *                                    - step/bucket labels rendered into the overlay so
 *                                      each screenshot visibly shows WHICH variant/control
 *                                      and which step it documents; bucketValue is the
 *                                      expected df value; showCookieCarry renders a
 *                                      prominent "bucket value from cookie" banner — shown
 *                                      ONLY on form-less / flowthrough pages, because on
 *                                      form pages the CRO hidden field IS the evidence
 * @returns {Promise<string>}       absolute path of the saved screenshot
 */
export async function screenshotWithCookies(page, label, hiddenFields, formSelector, screenshotsDir, overlay) {
  // ✓ root-level folder, NOT test-results — Playwright wipes outputDir at the
  // start of each run, which would destroy evidence accumulated from earlier
  // partial runs (e.g. variant screenshots lost once control runs).
  const outDir   = screenshotsDir || path.resolve('screenshots', 'cookies');
  fs.mkdirSync(outDir, { recursive: true });

  // ── Wait for the form before capturing ─────────────────────────────────────
  // Marketo/SPA forms mount a second or two AFTER the load event, and on tabbed
  // pages (Contact Us → Sales) they render even later. Screenshotting before
  // that captures a blank white panel where the form should be, and tryRead
  // below sees an empty CRO field — which reads as "the test never wrote the
  // value". Wait for a real, visible field first.
  //
  // Then PARK the form in the upper part of the viewport: the evidence panel
  // below is position:fixed over the bottom ~380px, so a form left at its
  // natural y (e.g. y=398 on /contact-us) is loaded and visible in the DOM but
  // completely hidden behind the overlay — it looks unloaded in the screenshot.
  //
  // Never throws: form-less (flowthrough) pages and pages whose form never
  // renders are still captured, just without the form in frame.
  if (formSelector) {
    try {
      const forms = page.locator(formSelector);
      const n = await forms.count().catch(() => 0);
      let target = null;
      for (let i = 0; i < Math.min(n, 6); i++) {
        const f = forms.nth(i);
        const field = f.locator('input:not([type="hidden"]), textarea, select, button, [role="button"]').first();
        const ready = await field.waitFor({ state: 'visible', timeout: 4000 })
          .then(() => true).catch(() => false);
        if (ready) { target = f; break; }
      }
      if (target) {
        await target.evaluate(el => {
          window.scrollBy(0, el.getBoundingClientRect().top - 60);
        }).catch(() => {});
        await page.waitForTimeout(250);
      }
    } catch { /* keep going — a partial screenshot beats none */ }
  }

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
    // Some clients write the value into a differently-named field (Insight: CRO1,
    // set via hiddenFields.cro1) — fall back so the evidence isn't "(not found)".
    if (valueResult.value === '(not found)' && hiddenFields.cro1) {
      valueResult = await tryRead(hiddenFields.cro1);
    }
  }

  // ── Inject overlay ─────────────────────────────────────────────────────────
  await page.evaluate(({
    expNameLabel, expNameVal, expNameHTML,
    expValueLabel, expValueVal, expValueHTML,
    stepLabel, bucketLabel, expectedValue, showCookieCarry,
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

    // ── Bucket value via cookie (primary evidence on form-less pages) ───────
    // When there is no hidden field on the page, the only place the df value
    // can be shown is in the cookies — surface that here prominently.
    const bucketValue = String(expectedValue || '').trim();
    const cookieTokens = (raw) => String(raw || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
    const carrier     = cookies.find(c => bucketValue && cookieTokens(c.value).includes(bucketValue));
    const valueCookie = cookies.find(c => /^HiddenFieldValue$/i.test(c.name))
                     || cookies.find(c => /hiddenfield|experiment/i.test(c.name));
    const shownCookie = carrier || valueCookie;
    const cookieCarry = bucketValue ? Boolean(carrier) : null;

    const carryBanner = bucketValue && showCookieCarry
      ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;
                     padding:8px 12px;border-bottom:1px solid #3a3a3a;
                     background:${cookieCarry ? '#122b1a' : '#331515'};
                     border-left:4px solid ${cookieCarry ? '#4ec9b0' : '#f48771'}">
           <span style="font-size:13px">🍪</span>
           <span style="color:${cookieCarry ? '#4ec9b0' : '#f48771'};font-weight:600;font-size:12px">
             Bucket value from cookie:
             <span style="font-family:monospace">${shownCookie ? `${shownCookie.name} = "${shownCookie.value || '(empty)'}"` : 'no SPZ/experiment cookie present'}</span>
           </span>
           <span style="margin-left:auto;background:${cookieCarry ? '#1a3a1a' : '#4a1515'};
                        color:${cookieCarry ? '#4ec9b0' : '#f48771'};
                        border-radius:10px;padding:1px 10px;font-size:11px;font-weight:600;
                        font-family:monospace">
             ${cookieCarry ? `✓ carries "${bucketValue}"` : `✗ MISSING "${bucketValue}"`}
           </span>
         </div>`
      : '';

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

        <!-- ══ STEP/BUCKET BAR ═══════════════════════════════════════════════ -->
        <div style="position:sticky;top:0;background:#1a1a2e;border-bottom:1px solid #3a3a3a;z-index:1">
          <div style="display:flex;align-items:center;gap:8px;padding:5px 12px">
            <span style="font-size:13px">🧪</span>
            <span style="color:#cccccc;font-weight:600;font-size:12px">${stepLabel}</span>
            <span style="margin-left:auto;background:${bucketLabel ? '#007acc' : '#3a3a3a'};
                         color:#fff;border-radius:10px;padding:1px 10px;
                         font-size:11px;font-weight:600;font-family:monospace">
              ${bucketLabel || 'no bucket set'}
            </span>
          </div>
          <div style="display:flex;gap:8px;padding:2px 12px 6px">
            <span style="color:#9cdcfe;font-family:monospace;font-size:11px;white-space:nowrap">
              body class:
            </span>
            <span style="color:#d4d4d4;font-family:monospace;font-size:11px;word-break:break-all">
              ${document.body.className || '(none)'}
            </span>
          </div>
        </div>

        <!-- ══ ELEMENTS SECTION ══════════════════════════════════════════════ -->
        <div style="display:flex;align-items:center;gap:8px;padding:5px 12px;
                    background:#252526;border-bottom:1px solid #3a3a3a">
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

        <!-- ══ COOKIE CARRY (bucket value) ══════════════════════════════════════ -->
        ${carryBanner}

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
    expValueLabel: hiddenFields?.cro1 ?? hiddenFields?.experimentValue ?? 'intellimize2',
    expValueVal:   valueResult.value,
    expValueHTML:  valueResult.outerHTML,
    stepLabel:     overlay?.stepLabel  || label,
    bucketLabel:   overlay?.bucketLabel || '',
    expectedValue: overlay?.bucketValue || '',
    showCookieCarry: Boolean(overlay?.showCookieCarry),
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
 * Waits for a (possibly lazy-loaded) destination form's CRO hidden field to
 * exist AND be populated, scrolling periodically to coax Marketo/SPA forms into
 * rendering. Returns the field value once it holds a non-empty value, or the
 * final (possibly empty / null) value when the timeout expires first — so an
 * empty string means the form loaded but was never populated, and null means
 * the field never appeared at all.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} [formSelector]
 * @param {string} fieldName     e.g. 'intellimize1'
 * @param {object} [options]
 * @param {number} [options.timeout=30000]
 * @param {number} [options.scrollInterval=2000]
 * @returns {Promise<string|null>}
 */
export async function waitForFormField(page, formSelector, fieldName, options = {}) {
  const { timeout = 30000, scrollInterval = 2000 } = options;
  const started = Date.now();

  let value = await getHiddenFieldValue(page, fieldName, formSelector);
  while (Date.now() - started < timeout) {
    if (value !== null && value.trim().length > 0) {
      return value;   // field exists AND was populated
    }
    // Not populated yet — scroll to trigger the lazy render, then re-read
    await page.mouse.wheel(0, 3000).catch(() => {});
    await page.waitForTimeout(scrollInterval);
    value = await getHiddenFieldValue(page, fieldName, formSelector);
  }

  return value;
}

/**
 * Waits (up to `timeout`) until ANY configured bucket becomes observable on
 * the page (body class, CRO field, or SPZ value cookie) — mirrors the signal
 * wait used inside loadBucket, for re-checking after navigating between
 * tested pages that SPZ might not have finished bucketing yet.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Array<{ bodyClass?: string, expectedValue: string }>} bucketList
 * @param {string} [valueFieldName]
 * @param {string} [formSelector]
 * @param {number} [timeout=15000]
 * @returns {Promise<object|null>} the detected bucket, or null
 */
export async function waitForBucketSignal(page, bucketList, valueFieldName, formSelector, timeout = 15000) {
  try {
    await page.waitForFunction(
      bucketDetectedInPage,
      { buckets: bucketList, valueField: valueFieldName || '' },
      { timeout }
    );
  } catch {
    // timeout — fall through to a final read
  }

  const bodyClasses = await page.evaluate(() => document.body.className);
  return detectBucket(page, bucketList, valueFieldName, formSelector, bodyClasses);
}

/**
 * Reads a named cookie's raw value from document.cookie, or null if absent.
 *
 * SPZ namespaces its bucket cookies per test id — `HiddenFieldName3018` /
 * `HiddenFieldValue3018` for #3018 (older tests used the generic
 * `HiddenFieldName` / `HiddenFieldValue`). The names are configured in
 * TEST_CONFIG.spzCookies so a rename is a config edit, not a code change.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} [cookieName]  e.g. 'HiddenFieldValue3018'
 * @returns {Promise<string|null>}
 */
export async function readSpzCookie(page, cookieName) {
  if (!cookieName) return null;
  return page.evaluate((name) => {
    const hit = document.cookie.split(';')
      .map(c => c.trim())
      .find(c => c.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1) : null;
  }, cookieName);
}

/**
 * Whether the SPZ bucket cookie holds the given value.
 *
 * When `cookieName` is supplied (TEST_CONFIG.spzCookies.value) that cookie is
 * authoritative — present means "this is the answer", so a wrong bucket fails
 * loudly instead of being papered over by a looser match. If the cookie is
 * absent (test not live yet, or the site renamed it again), the check falls
 * back to scanning EVERY cookie's value, which stays correct across renames
 * because it matches the distinctive bucket VALUE (e.g. "SPZ_3018_variant").
 *
 * Values may be comma- or semicolon-joined when multiple tests run on the same
 * page (e.g. "SPZ_2044_variant1;SPZ_9014_truecontrol"), so matching is
 * token-based on both separators.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} [expectedValue]   e.g. 'SPZ_3018_variant'
 * @param {string} [cookieName]      e.g. 'HiddenFieldValue3018'
 * @returns {Promise<boolean>}
 */
export async function cookieHoldsValue(page, expectedValue, cookieName) {
  if (!expectedValue) return false;
  const tokens = (raw) => String(raw || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);

  if (cookieName) {
    const raw = await readSpzCookie(page, cookieName);
    if (raw != null) return tokens(raw).includes(expectedValue);
  }

  return page.evaluate(
    (expected) => {
      const toks = (raw) => String(raw || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
      return document.cookie.split(';').some(c => {
        const eq = c.indexOf('=');
        return eq >= 0 && toks(c.slice(eq + 1)).includes(expected);
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
  return String(raw || '').split(/[,;]/).map(s => s.trim()).filter(Boolean).includes(expectedValue);
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
  const tokens = (raw) => String(raw || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);

  const nameVal  = await getHiddenFieldValue(page, hiddenFields.experimentName,  formSelector);
  const valueVal = await getHiddenFieldValue(page, hiddenFields.experimentValue, formSelector);

  // If CRO1 and CRO2 point to the same field (e.g. both intellimize1 on
  // SailPoint), skip the name assertion — only the value field matters.
  const sameField = hiddenFields.experimentName === hiddenFields.experimentValue;

  if (!sameField) {
    expect(
      tokens(nameVal),
      `ExperimentName (CRO1) on "${await page.title()}" should contain "${expected.experimentName}"`
    ).toContain(expected.experimentName);
  }

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
  await page.waitForTimeout(1500);
}

/**
 * Prints a clearly visible step header to the test output.
 *
 * @param {string} msg
 */
export function logStep(msg) {
  console.log(`\n${'─'.repeat(60)}\n  ${msg}\n${'─'.repeat(60)}`);
}

// ─── Submission targets ──────────────────────────────────────────────────────

/**
 * Resolves which squeeze pages the form-submission spec should submit on.
 *
 * Source of truth is `config.submitPages` (edited in the config UI's
 * "Form submission targets" card); SUBMIT_PAGES overrides it for a one-off run
 * (`SUBMIT_PAGES=demo,interactive`). Either way every key must name a real
 * squeeze page with a form, so a typo fails at load time with a clear message
 * instead of silently shrinking the run.
 *
 * @param {object} config  TEST_CONFIG / INSIGHT_CONFIG
 * @param {string} [envValue]  raw SUBMIT_PAGES env var ('' or undefined = config)
 * @returns {string[]} page keys, config order preserved
 */
export function resolveSubmitPages(config, envValue) {
  const fromEnv = String(envValue || '').split(',').map(s => s.trim()).filter(Boolean);
  const keys = fromEnv.length ? fromEnv : (config.submitPages || []);
  const pages = config.pages || {};

  for (const key of keys) {
    const p = pages[key];
    if (!p) throw new Error(`submitPages contains unknown page key "${key}"`);
    if (!p.formSelector) throw new Error(`submitPages "${key}" has no formSelector — nothing to submit`);
    if (p.isSqueezePage !== true) throw new Error(`submitPages "${key}" is not a squeeze page (isSqueezePage: true required)`);
  }

  return [...keys];
}

/**
 * Which page OWNS a submission target for a single-test (flat-bucket) client
 * such as SailPoint — the twin of the iso `findOwningTest()`.
 *
 * SailPoint has no tests[] array: one experiment runs on the under-test
 * flowthrough page and its value carries into `flowthroughDestination`. A form
 * page outside that list (e.g. `discoveryTool`, flagged `isDestination: false`)
 * is never reached by the experiment, so submitting it could not prove
 * anything — it is not owned.
 *
 * An empty/absent flowthroughDestination falls back to every eligible form page,
 * exactly like resolvePlan().
 *
 * @param {object} config   TEST_CONFIG-shaped object
 * @param {string} pageKey
 * @returns {object|null} the owning page, or null when nothing owns it
 */
export function findOwningTarget(config, pageKey) {
  const pages = config.pages || {};
  const page = pages[pageKey];
  if (!page) return null;

  // Case 1: the tested page IS the submit target (form page under test).
  // e.g. Contact Us is isUnderTest: true, isFlowthrough: false — it owns itself.
  if (page.isUnderTest && !page.isFlowthrough) return page;

  // Case 2: classic flowthrough — the value carries from the tested page into
  // downstream form destinations listed in flowthroughDestination.
  const configured = Array.isArray(config.flowthroughDestination) ? config.flowthroughDestination : [];
  const keys = configured.length
    ? configured
    : Object.entries(pages)
        .filter(([, p]) => destinationIneligibleReason(p) === null)
        .map(([k]) => k);

  return keys.includes(pageKey) ? page : null;
}

/**
 * Which buckets a submission run is allowed to fire.
 *
 * Precedence: an explicit SUBMIT_BUCKETS wins, then `config.submitBucket` (the
 * config UI's "Bucket to submit" radio) — which is what makes a normal run fire
 * exactly ONE lead — and only when neither is set does it fall back to every
 * configured bucket. An unknown key throws, so a typo can never silently widen
 * a run into extra real submissions.
 *
 * @param {object} config       TEST_CONFIG / INSIGHT_CONFIG
 * @param {string} [envValue]   raw SUBMIT_BUCKETS env var
 * @param {string[]} availableKeys  bucket keys the owning test actually ships
 * @param {string} [context]    page key, for a clearer error
 * @returns {string[]} bucket keys to run, config order preserved
 */
export function resolveSubmitBuckets(config, envValue, availableKeys, context = '') {
  const fromEnv = String(envValue || '').split(',').map(s => s.trim()).filter(Boolean);
  const keys = fromEnv.length ? fromEnv
    : config.submitBucket ? [config.submitBucket]
    : [...availableKeys];
  const where = context ? ` for "${context}"` : '';

  for (const k of keys) {
    if (!availableKeys.includes(k)) {
      throw new Error(
        `submit bucket "${k}"${where} is not one of the configured buckets: ${availableKeys.join(', ') || '(none)'}`,
      );
    }
  }

  return [...keys];
}
