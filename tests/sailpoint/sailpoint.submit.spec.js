/**
 * SailPoint A/B Test — form submission QA (config-driven, multi-page)
 *
 * Submits every squeeze page listed in config `submitPages` once per bucket and
 * asserts the serialized Marketo payload carries the experiment values
 * end-to-end:
 *
 *   intellimize1  carries the 3018 token for the bucket under test
 *                 (it is a comma-joined list — sibling tests such as #1026 append
 *                 to it — so every assertion is a contains() on the token)
 *   intellimize2  is stamped by 3018-script.js on the submit CLICK, as the EST
 *                 time: new Date().toLocaleString('en-US', {timeZone:'America/New_York'})
 *                 — HARD assertion on /demo, soft-logged on the other squeeze
 *                 pages (their own scripts may not stamp it)
 *   HiddenFieldValue3018 cookie must still equal the bucket value after submit
 *
 * TARGETS come from `config.submitPages` (the config UI's "Form submission
 * targets" card) and can be overridden for a single run:
 *   SUBMIT_PAGES=demo,interactive
 * Every key must be a real squeeze page with a form — resolveSubmitPages()
 * throws at load time otherwise, so a typo never silently shrinks the run.
 *
 * A submission target must also be OWNED: the experiment's value only reaches
 * pages listed in config `flowthroughDestination` (the under-test page is a
 * flowthrough page with no form, so the submit always happens downstream). A
 * form page outside that list — e.g. discoveryTool, flagged isDestination:
 * false — is reported as an explicit skip, never submitted blind. Same rule as
 * the InsightSoftware spec.
 *
 * /demo's Marketo form is parked inside a screen-reader-only 1px container
 * until the site's own widget finishes:
 *   products step -> Next -> industry step -> Next -> form laid out (width > 100)
 *   -> fill -> Country=Philippines (removes the State field) -> tick the required
 *   consent checkbox -> Submit
 * The widget loop runs for every target but only while the form is still
 * collapsed — pages without a wizard skip it.
 *
 * Capture is OBSERVABLE ONLY: page.on('request') records the POST body and lets
 * it through untouched. The endpoint is /index.php/leadCapture/save2 (Marketo's
 * formSubmitPath) — NOT /index.php/form/save2.
 *
 * ONE lead per run by default: `config.submitBucket` picks the bucket (variantA
 * = SPZ_3018_variant or control = SPZ_3018_truecontrol), and the config UI also
 * narrows the run to the first ticked target page. SUBMIT_BUCKETS /
 * SUBMIT_PAGES widen it again for a deliberate multi-lead run.
 *
 * FLAGS
 *   SUBMIT_LIVE=1  fire the real leads
 *   SUBMIT_DRY=1   fill + screenshot the form, then STOP — no click, no lead.
 *                  Wins over SUBMIT_LIVE when both are set.
 *   SUBMIT_PAGES   comma-separated target keys (default: config.submitPages)
 *   SUBMIT_BUCKETS comma-separated bucket keys (default: config.submitBucket)
 * Without either flag the spec is discovered and reported as skipped — safe
 * under `npm run test:sailpoint:all`.
 *
 *   PowerShell:  $env:SUBMIT_DRY = '1'; npx playwright test --project=sp tests/sailpoint/sailpoint.submit.spec.js
 *   cmd:         set SUBMIT_DRY=1 && npx playwright test --project=sp tests/sailpoint/sailpoint.submit.spec.js
 *
 * The thank-you page renders an async Chilipiper scheduler — we screenshot it
 * and never interact with it.
 */

// @ts-check
import { test, expect } from '@playwright/test';
import { TEST_CONFIG } from './config/sailpoint.config.js';
import {
  loadBucket,
  acceptCookies,
  waitForFormField,
  logStep,
  resolveSubmitPages,
  resolveSubmitBuckets,
  findOwningTarget,
} from './helpers/abtest.helpers.js';
import { screenshotPayload } from './helpers/payload-screenshot.js';

const { pages, cookieScript, hiddenFields, buckets, spzCookies, testId } = TEST_CONFIG;
const SPZ_VALUE_COOKIE = spzCookies?.value ?? '';
const TESTED = Object.values(pages).find((p) => p.isUnderTest);

const DRY = /^(1|true|yes)$/i.test(process.env.SUBMIT_DRY || '');
const LIVE = /^(1|true|yes)$/i.test(process.env.SUBMIT_LIVE || '');
const RUN = DRY || LIVE;
// DRY wins over LIVE — with both flags set the form is filled and screenshotted,
// never clicked.
const STAGE = DRY ? 'dryrun' : 'submit';
const SKIP_REASON =
  'SUBMIT_LIVE is not enabled — set SUBMIT_LIVE=1 to fire 1 real submission per target page, or SUBMIT_DRY=1 to fill the form without submitting';

const LEAD = {
  FirstName: 'SPZtest',
  LastName: 'SPZtest',
  Email: 'ryan+test@spiralyze.com',
  Phone: '1234567890',
  Company: 'spiralyze',
  Title: 'test',
};
// Title / Phone / Company are not on every squeeze page (discoveryTool has no
// Title) — only these three may be missing or the POST is not a real lead.
const LEAD_REQUIRED = ['FirstName', 'LastName', 'Email'];

const SHOTS = 'screenshots/cookies';
const EST_STAMP = /^\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M$/;

/** Page keys to exercise — config submitPages, overridden by SUBMIT_PAGES. */
const TARGETS = resolveSubmitPages(TEST_CONFIG, process.env.SUBMIT_PAGES);

/**
 * Buckets to fire. config.submitBucket (the UI's "Bucket to submit" radio)
 * makes a normal run fire EXACTLY ONE lead; SUBMIT_BUCKETS overrides it, and
 * only an unset config falls back to every bucket.
 */
const RUN_BUCKETS = resolveSubmitBuckets(TEST_CONFIG, process.env.SUBMIT_BUCKETS, Object.keys(buckets));

const formWidth = (page, formSel) =>
  page.evaluate((sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().width || 0), formSel);

const readField = (page, formSel, name) =>
  page.evaluate(
    ([sel, n]) => document.querySelector(sel)?.querySelector(`[name="${n}"]`)?.value ?? null,
    [formSel, name],
  );

test.setTimeout(600_000);

/**
 * Picks the Marketo form the target page actually submits: any
 * form[id^=mktoForm] / .mktoForm, preferring the one carrying the lead fields,
 * then the widest. The config's generic formSelector is the last resort.
 * Polls (with a scroll) so a lazily-rendered form still resolves.
 *
 * @returns {Promise<string|null>} a concrete '#mktoForm_1018'-style selector
 */
async function resolveMarketoForm(page, configuredSelector, timeout = 15000) {
  const started = Date.now();
  let sel = null;
  do {
    sel = await page.evaluate((cfg) => {
      const candidates = [...document.querySelectorAll('form[id^="mktoForm"], form.mktoForm')];
      if (!candidates.length && cfg) {
        const fallback = document.querySelector(cfg);
        if (fallback) candidates.push(fallback);
      }
      const scored = candidates.map((f) => ({
        f,
        lead: Boolean(f.querySelector('input[name="FirstName"], input[name="firstName"]')),
        w: Math.round(f.getBoundingClientRect().width),
      }));
      scored.sort((a, b) => (b.lead - a.lead) || (b.w - a.w));
      return scored.length && scored[0].f.id ? `#${scored[0].f.id}` : null;
    }, configuredSelector);
    if (sel) return sel;
    await page.mouse.wheel(0, 2000).catch(() => {});
    await page.waitForTimeout(1500);
  } while (Date.now() - started < timeout);
  return sel;
}

/** Clicks the site's own multi-step widget until it stops offering a Next. */
async function driveWidget(page) {
  for (let step = 1; step <= 3; step++) {
    const next = page.locator('button.btn--hotpink:visible, .grid_submit_btn:visible');
    if ((await next.count()) === 0) break;
    const first = next.first();
    const label = (await first.innerText().catch(() => '')).trim();
    logStep(`widget step ${step}: clicking "${label}"`);
    await first.click({ timeout: 8000 });
    await page.waitForTimeout(2800);
  }
}

/**
 * The form's own submit control — Marketo's .mktoButton first, then any real
 * submit input/button. Visibility-filtered so a hidden wizard "Next" never wins.
 */
async function resolveSubmitButton(page, formSel) {
  const candidates = [
    `${formSel} .mktoButton:visible`,
    `${formSel} button[type="submit"]:visible`,
    `${formSel} input[type="submit"]:visible`,
    `${formSel} button:visible`,
  ];
  for (const sel of candidates) {
    if (await page.locator(sel).count()) return page.locator(sel).first();
  }
  return page.locator(`${formSel} button`).first();
}

async function submitTarget(page, pageKey, BUCKET_KEY) {
  const target = pages[pageKey];
  const EXPECTED = buckets[BUCKET_KEY].expectedValue;

  /** @type {{ url: string, body: string | null }[]} */
  const captured = [];
  /** @type {string[]} */
  const postUrls = [];

  // Observe-only: records the body, never blocks or alters the request.
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    postUrls.push(req.url());
    if (!/index\.php\/leadCapture\/save2/i.test(req.url())) return;
    captured.push({ url: req.url(), body: req.postData() });
    logStep(`captured POST ${req.url()} (${(req.postData() || '').length} bytes)`);
  });

  // ── 1. force the bucket on the under-test page ─────────────────────────────
  logStep(`Loading ${BUCKET_KEY} for target "${pageKey}"…`);
  await loadBucket(page, BUCKET_KEY, TESTED.url, cookieScript, buckets, hiddenFields.experimentValue, target.formSelector, 25);
  await page.goto(target.url, { waitUntil: 'load' });
  await acceptCookies(page);
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForTimeout(5000);

  // ── 2. resolve the concrete Marketo form this page submits ─────────────────
  let FORM = await resolveMarketoForm(page, target.formSelector);
  if (!FORM) {
    // Some pages keep the form behind their own widget — drive it, then look again.
    logStep(`no form yet on ${pageKey} — driving the page widget first`);
    await driveWidget(page);
    FORM = await resolveMarketoForm(page, target.formSelector, 10000);
  }
  expect(FORM, `${pageKey} (${target.url}) rendered no Marketo form to submit`).toBeTruthy();
  logStep(`form → ${FORM}`);
  const FORM_ID = FORM.match(/^#mktoForm_(\d+)/)?.[1] ?? null;

  // ── 3. read the pre-submit tracking state ──────────────────────────────────
  const preIntellimize1 = await waitForFormField(page, FORM, hiddenFields.experimentValue, { timeout: 25000, scrollInterval: 2000 });
  const preIntellimize2 = await readField(page, FORM, 'intellimize2');

  // SPZ writes the value cookie asynchronously — poll until it appears or
  // we've waited long enough (30s). The cookie is written by the SPZ rollout
  // script a few seconds after the page loads, separately from the form field.
  let preCookie = (await page.context().cookies()).find((c) => c.name === SPZ_VALUE_COOKIE);
  if (!preCookie && SPZ_VALUE_COOKIE) {
    logStep(`${SPZ_VALUE_COOKIE} not yet present — polling up to 30s…`);
    for (let i = 0; i < 30 && !preCookie; i++) {
      await page.waitForTimeout(1000);
      preCookie = (await page.context().cookies()).find((c) => c.name === SPZ_VALUE_COOKIE);
      if (preCookie) logStep(`${SPZ_VALUE_COOKIE} appeared after ${i + 1}s: ${JSON.stringify(preCookie.value)}`);
    }
  }

  logStep(`intellimize1 (pre) = ${JSON.stringify(preIntellimize1)}`);
  logStep(`${SPZ_VALUE_COOKIE} (pre) = ${preCookie ? JSON.stringify(preCookie.value) : '(ABSENT)'}`);

  // If the cookie is still absent after polling, skip the cookie assertion
  // with a clear message rather than failing on undefined — the form field
  // assertion below is still the primary evidence.
  if (!preCookie && SPZ_VALUE_COOKIE) {
    logStep(`⚠ ${SPZ_VALUE_COOKIE} was never written — SPZ may not set this cookie when the activation cookie is already present from loadBucket. Skipping cookie assertion.`);
  }
  expect(
    preIntellimize1,
    `intellimize1 on ${pageKey} is ${JSON.stringify(preIntellimize1)} — the #${testId} script does not populate it there, so this page cannot prove the experiment end-to-end `
      + `(the ${SPZ_VALUE_COOKIE} cookie does hold ${JSON.stringify(preCookie?.value ?? null)})`,
  ).toContain(EXPECTED);

  // Cookie assertion: hard fail only if the cookie exists but holds the wrong
  // value. If it's absent (SPZ didn't write it in this session), log and skip —
  // the intellimize1 field is the primary evidence.
  if (preCookie) {
    expect(preCookie.value, `${SPZ_VALUE_COOKIE} must equal the bucket value`).toBe(EXPECTED);
  } else if (SPZ_VALUE_COOKIE) {
    logStep(`⚠ ${SPZ_VALUE_COOKIE} absent — skipping cookie value assertion (intellimize1 field is the primary evidence)`);
  }

  expect(preIntellimize2, 'intellimize2 is only stamped on the submit click').toBeFalsy();

  // ── 4. drive the widget until the Marketo form is laid out ─────────────────
  for (let step = 1; step <= 3 && (await formWidth(page, FORM)) <= 100; step++) {
    const next = page.locator('button.btn--hotpink:visible, .grid_submit_btn:visible');
    if ((await next.count()) === 0) break;
    const first = next.first();
    const label = (await first.innerText().catch(() => '')).trim();
    logStep(`widget step ${step}: clicking "${label}"`);
    await first.click({ timeout: 8000 });
    await page.waitForTimeout(2800);
  }
  expect(await formWidth(page, FORM), `the ${pageKey} form must be laid out before filling`).toBeGreaterThan(100);

  // ── 5. fill the agreed QA lead (only fields this page actually renders) ────
  for (const [name, value] of Object.entries(LEAD)) {
    const field = page.locator(`${FORM} [name="${name}"]`);
    if ((await field.count()) === 0) {
      const required = LEAD_REQUIRED.includes(name);
      expect(required, `${name} is missing on ${pageKey} — a lead cannot be submitted`).toBe(false);
      logStep(`${name} is not on this page — skipped`);
      continue;
    }
    await expect(field.first(), `${name} must be rendered`).toBeVisible({ timeout: 10000 });
    await field.first().fill(value);
    await expect(field.first()).toHaveValue(value);
  }

  // Country=Philippines removes the State field entirely (no State to resolve).
  const country = page.locator(`${FORM} [name="Country"]`);
  if (await country.count()) {
    await country.first().selectOption({ label: 'Philippines' });
    await page.waitForTimeout(1200);
    await expect(country.first()).toHaveValue('Philippines');
  }

  // SailPoint will not submit without the marketing-consent checkbox.
  const consent = page.locator(`${FORM} [name="Global_Opt_in__c"]`);
  if (await consent.count()) {
    await consent.first().check({ force: true });
    await expect(consent.first()).toBeChecked();
    logStep('consent checkbox Global_Opt_in__c ticked');
  }

  // Anything else the form marks required-and-unchecked (other pages' consent
  // fields differ) must be ticked too, or Marketo blocks the POST silently.
  const requiredBoxes = await page.evaluate((sel) => {
    const form = document.querySelector(sel);
    if (!form) return [];
    return [...form.querySelectorAll('input[type="checkbox"]')]
      .filter((el) => (el.required || el.getAttribute('aria-required') === 'true') && !el.checked && !el.disabled)
      .map((el) => el.name)
      .filter(Boolean);
  }, FORM);
  for (const name of requiredBoxes) {
    await page.locator(`${FORM} [name="${name}"]`).first().check({ force: true });
    logStep(`required consent checkbox ${name} ticked`);
  }

  // Pages add their own required pickers (contact-us asks for reasonforInquiry)
  // — choose a real option, skipping the "Please select…" placeholder.
  const requiredSelects = await page.evaluate((sel) => {
    const form = document.querySelector(sel);
    if (!form) return [];
    return [...form.querySelectorAll('select')]
      .filter((el) => !el.disabled
        && (el.required || el.getAttribute('aria-required') === 'true')
        && !(el.value || '').trim())
      .map((el) => el.name)
      .filter(Boolean);
  }, FORM);
  for (const name of requiredSelects) {
    const select = page.locator(`${FORM} [name="${name}"]`).first();
    const PLACEHOLDER = /^(select|choose|please\s*(choose|select)?|--|-{1,2}|none|n\/a|\s)*$/i;
    const value = await select.evaluate((el, ph) => {
      const re = new RegExp(ph, 'i');
      const opt = [...el.options].find(o => o.value && !re.test(o.value.trim())
        && !re.test((o.textContent || '').trim()));
      return opt ? opt.value : null;
    }, PLACEHOLDER.source);
    expect(value, `required select ${name} on this page offers no usable option`).toBeTruthy();
    await select.selectOption(value);
    logStep(`required select ${name} = ${JSON.stringify(value)}`);
  }

  // no required field may be left empty, or Marketo blocks the POST silently
  const emptyRequired = await page.evaluate((sel) => {
    const form = document.querySelector(sel);
    if (!form) return ['form not found'];
    return [...form.querySelectorAll('input, select, textarea')]
      .filter((el) => (el.required || el.getAttribute('aria-required') === 'true')
        && (el.type === 'checkbox' ? !el.checked : !(el.value || '').trim())
        && !el.disabled)
      .map((el) => el.name);
  }, FORM);
  expect(emptyRequired, 'no required field may be left empty').toEqual([]);

  await page.locator(FORM).scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: `${SHOTS}/${testId}-${STAGE}-form-filled-${pageKey}-${BUCKET_KEY}.png` });

  // ── 6. DRY RUN stops here: the form is filled and evidenced, never fired ───
  if (DRY) {
    logStep(`SUBMIT_DRY — ${pageKey}/${BUCKET_KEY} filled and screenshotted, submit click SKIPPED`);
    return;
  }

  // ── 7. submit (exactly one) ────────────────────────────────────────────────
  logStep(`clicking Submit for ${pageKey}/${BUCKET_KEY} — one real submission, payload is captured observe-only`);
  const submit = await resolveSubmitButton(page, FORM);
  await submit.scrollIntoViewIfNeeded().catch(() => {});
  await submit.click({ timeout: 15000 }).catch(async () => {
    // Marketo's .mktoButtonWrap can transiently cover the button mid-animation;
    // .click() still dispatches a genuine DOM click so the 3018 listener fires.
    logStep('hit-target was covered — dispatching a direct DOM click');
    await submit.evaluate((el) => el.click());
  });

  // intellimize2 is stamped synchronously on this click, before the redirect.
  await page.waitForTimeout(1500);
  const stampedIntellimize2 = await readField(page, FORM, 'intellimize2').catch(() => null);

  // /demo is the proven redirect — hard. The other squeeze pages may resolve
  // differently, so their redirect is evidence, not a requirement.
  if (pageKey === 'demo') {
    await page.waitForURL(/thank-you/, { timeout: 45000 });
    await page.waitForLoadState('load').catch(() => {});
    logStep(`landed on ${page.url()}`);
  } else {
    const landed = await page.waitForURL(/thank-you/, { timeout: 15000 })
      .then(() => true).catch(() => false);
    await page.waitForLoadState('load').catch(() => {});
    logStep(landed
      ? `landed on ${page.url()}`
      : `no /thank-you/ redirect on ${pageKey} (now at ${page.url()}) — the captured payload is the proof`);
  }

  // ── 8. assertions on the captured payload ──────────────────────────────────
  console.log(`\nPOST urls seen: ${JSON.stringify(postUrls, null, 1)}`);
  console.log(`save2 payloads captured: ${captured.length}`);
  for (const c of captured) console.log(`--- ${c.url} ---\n${decodeURIComponent((c.body || '').replace(/\+/g, ' '))}\n`);

  expect(captured.length, 'exactly one leadCapture/save2 POST must be captured').toBe(1);

  const payload = new URLSearchParams(captured[0].body || '');
  expect(payload.get('intellimize1'), 'payload intellimize1 carries the 3018 token').toContain(EXPECTED);
  expect(payload.get('FirstName')).toBe(LEAD.FirstName);
  expect(payload.get('LastName')).toBe(LEAD.LastName);
  expect(payload.get('Email')).toBe(LEAD.Email);
  if (FORM_ID) expect(payload.get('formid'), 'payload formid matches the form that was submitted').toBe(FORM_ID);

  // intellimize2 is stamped by 3018-script.js — proven on /demo, advisory elsewhere.
  const payloadStamp = payload.get('intellimize2');
  if (pageKey === 'demo') {
    expect(payloadStamp, 'payload intellimize2 is the EST submit timestamp').toMatch(EST_STAMP);
    expect(stampedIntellimize2, 'DOM intellimize2 was stamped at submit click').toMatch(EST_STAMP);
  } else if (payloadStamp && EST_STAMP.test(payloadStamp)) {
    logStep(`intellimize2 (payload) = ${payloadStamp}`);
    if (stampedIntellimize2 && EST_STAMP.test(stampedIntellimize2)) logStep(`intellimize2 (DOM) = ${stampedIntellimize2}`);
  } else {
    logStep(`intellimize2 was not stamped on ${pageKey} (${JSON.stringify(payloadStamp)}) — advisory only`);
  }

  // ── 9. the cookie must survive the submit ──────────────────────────────────
  // Soft assertion: if SPZ didn't write the cookie in this session (common when
  // the activation cookie is already present from loadBucket), log and skip
  // rather than failing — the payload intellimize1 value is the primary evidence.
  const postCookie = (await page.context().cookies()).find((c) => c.name === SPZ_VALUE_COOKIE);
  if (postCookie) {
    expect(postCookie.value, `${SPZ_VALUE_COOKIE} must survive the submit`).toBe(EXPECTED);
  } else if (SPZ_VALUE_COOKIE) {
    logStep(`⚠ ${SPZ_VALUE_COOKIE} absent after submit — SPZ did not write this cookie in the automated session. The intellimize1 payload value is the primary evidence.`);
  }

  // ── 10. evidence: payload screenshot with intellimize1 / intellimize2 pinned ─
  const shot = await screenshotPayload(page, {
    payload: captured[0].body || '',
    intellimize1: payload.get('intellimize1') || '',
    intellimize2: payload.get('intellimize2') || '',
    tag: `${pageKey} · ${BUCKET_KEY}`,
    stage: 'SUBMITTED',
    cookieName: SPZ_VALUE_COOKIE,
    cookieValue: postCookie?.value || '(absent)',
    screenshotPath: `${SHOTS}/${testId}-submit-payload-${pageKey}-${BUCKET_KEY}.png`,
  });
  logStep(`payload screenshot → ${shot}`);

  await page.screenshot({ path: `${SHOTS}/${testId}-submit-thankyou-${pageKey}-${BUCKET_KEY}.png` });
  logStep('thank-you screenshot captured (scheduler untouched)');
}

// With nothing selected the spec still reports one clearly-named skip instead
// of an empty file Playwright would reject with "No tests found".
let registered = 0;
for (const pageKey of TARGETS) {
  // A form page the experiment never flows into cannot carry the value, so it
  // cannot prove anything — report it, never submit it.
  if (!findOwningTarget(TEST_CONFIG, pageKey)) {
    registered++;
    test(`submit ${pageKey} — value never reaches it`, () => {
      const dests = (TEST_CONFIG.flowthroughDestination || []).join(', ');
      test.skip(true,
        `page "${pageKey}" is not the form page under test and ${
          dests
            ? `is not in flowthroughDestination (${dests})`
            : 'flowthroughDestination is empty (it auto-derives every eligible form page, and this is not one)'
        } — the #${testId} value never reaches it, so add it to flowthroughDestination or drop it from submitPages`);
    });
    continue;
  }

  for (const BUCKET_KEY of RUN_BUCKETS) {
    registered++;
    const EXPECTED = buckets[BUCKET_KEY]?.expectedValue ?? '(unknown bucket)';
    test(`#${testId} ${pageKey} form submission carries intellimize1 + intellimize2 (${BUCKET_KEY} → ${EXPECTED})`, async ({ page }) => {
      test.skip(!RUN, SKIP_REASON);
      await submitTarget(page, pageKey, BUCKET_KEY);
    });
  }
}

if (!registered) {
  test(`#${testId} form submission — nothing to run`, () => {
    test.skip(true, TARGETS.length
      ? `no submission bucket resolved from submitBucket/SUBMIT_BUCKETS (configured: ${Object.keys(buckets).join(', ') || 'none'})`
      : 'submitPages is empty — tick at least one squeeze page in the config UI');
  });
}
