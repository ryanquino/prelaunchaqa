/**
 * BambooHR A/B Test — form submission QA (config-driven, multi-page)
 *
 * Submits every squeeze page listed in config `submitPages` once per bucket and
 * asserts the serialized Marketo payload carries the experiment value
 * end-to-end:
 *
 *   LPV1__c   carries the #5016 token for the bucket under test
 *             (it is a comma-joined list when sibling tests stamp the same
 *             field — so every assertion is a contains() on the token)
 *   firstName/lastName/email — the mandated QA lead
 *   formid    must match the Marketo form that was actually submitted
 *
 * BambooHR loads the test via `?spz-qa=true` on every page URL (the config's
 * cookieScript is only a PRELAUNCH phase marker, not a real snippet), so
 * loadBucket() converges on the target bucket by clearing the session and
 * re-bucketing until the body class / LPV1__c / cookie shows it.
 *
 * TARGETS come from `config.submitPages` (the config UI's "Form submission
 * targets" card) and can be overridden for a single run:
 *   SUBMIT_PAGES=pricing,demo
 * Every key must be a real squeeze page with a form — resolveSubmitPages()
 * throws at load time otherwise, so a typo never silently shrinks the run.
 *
 * A submission target must also be OWNED: the value reaches the form page
 * under test itself (Pricing — isUnderTest with an inline hero form that holds
 * LPV1__c directly) or a page listed in config `flowthroughDestination`
 * (Demo). Anything else is reported as an explicit skip, never submitted
 * blind. Same rule as the SailPoint/InsightSoftware specs — the resolvers are
 * imported from the shared SailPoint helpers.
 *
 * /demo keeps its Marketo form collapsed (width 0) behind the site's own bento
 * wizard: pick a visible bento tile -> click button.bento-next -> repeat until
 * the form lays out (width > 100). Pricing's hero form is visible immediately,
 * so the wizard loop exits on its first width check.
 *
 * Capture is OBSERVABLE ONLY: page.on('request') records the POST body and lets
 * it through untouched. The endpoint is /index.php/leadCapture/save2 (Marketo's
 * formSubmitPath) — NOT /index.php/form/save2.
 *
 * ONE lead per run by default: `config.submitBucket` picks the bucket
 * (variantA = #5016_variant or control = #5016_true_control), and the config
 * UI narrows the run to its first ticked target page. SUBMIT_BUCKETS /
 * SUBMIT_PAGES widen it again for a deliberate multi-lead run.
 *
 * FLAGS
 *   SUBMIT_LIVE=1  fire the real leads
 *   SUBMIT_DRY=1   fill + screenshot the form, then STOP — no click, no lead.
 *                  Wins over SUBMIT_LIVE when both are set.
 *   SUBMIT_PAGES   comma-separated target keys (default: config.submitPages)
 *   SUBMIT_BUCKETS comma-separated bucket keys (default: config.submitBucket)
 * Without either flag the spec is discovered and reported as skipped — safe
 * under `npm run test:bamboohr:all`.
 *
 *   PowerShell:  $env:SUBMIT_DRY = '1'; npx playwright test --project=bhr tests/bamboohr/bamboohr.submit.spec.js
 *   cmd:         set SUBMIT_DRY=1 && npx playwright test --project=bhr tests/bamboohr/bamboohr.submit.spec.js
 *
 * Evidence written to screenshots/cookies:
 *   5016-{dryrun|submit}-form-filled-<page>-<bucket>.png   the filled form
 *   5016-{dryrun|submit}-lpv1-preview-<page>-<bucket>.png  the LPV1 record, pinned
 *   5016-submit-payload-<page>-<bucket>.png                the save2 payload (live only)
 */

// @ts-check
import { test, expect } from '@playwright/test';
import { TEST_CONFIG } from './config/bamboohr.config.js';
import {
  loadBucket,
  acceptCookies,
  waitForFormField,
  cookieHoldsValue,
  logStep,
} from './helpers/abtest.helpers.js';
// Submission machinery is shared with SailPoint (target/bucket resolution and
// the ownership rule live in one place — same cross-import the InsightSoftware
// submit spec uses), and the payload evidence reuses the pinned-row screenshot.
import {
  resolveSubmitPages,
  resolveSubmitBuckets,
  findOwningTarget,
} from '../sailpoint/helpers/abtest.helpers.js';
import { screenshotPayload, parsePayload } from '../sailpoint/helpers/payload-screenshot.js';

const { pages, cookieScript, hiddenFields, buckets, flowthroughDestination, testId } = TEST_CONFIG;
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
  Email: 'ryan+test@bamboohr.com',
  Phone: '1234567890',
  Company: 'spiralyze',
  Title: 'test',
};
// Title / Phone / Company are not on every form — only these three may be
// missing or the POST is not a real lead.
const LEAD_REQUIRED = ['FirstName', 'LastName', 'Email'];

// Required text inputs a page adds beyond the shared LEAD. Applied only to
// TEXT controls — when the same name renders as a <select>, the required-
// selects sweep below picks a real option instead.
const EXTRA_TEXT = { Employees_Text__c: '1-50' };

const SHOTS = 'screenshots/cookies';
const SAVE2 = '/index.php/leadCapture/save2';

/** Page keys to exercise — config submitPages, overridden by SUBMIT_PAGES. */
const TARGETS = resolveSubmitPages(TEST_CONFIG, process.env.SUBMIT_PAGES);

/**
 * Buckets to fire. config.submitBucket (the UI's "Bucket to submit" radio)
 * makes a normal run fire EXACTLY ONE lead; SUBMIT_BUCKETS overrides it, and
 * only an unset config falls back to every bucket.
 */
const RUN_BUCKETS = resolveSubmitBuckets(TEST_CONFIG, process.env.SUBMIT_BUCKETS, Object.keys(buckets));

/** Split a (possibly comma-joined) hidden-field / cookie / payload value. */
const tokens = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);

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
 * @returns {Promise<string|null>} a concrete '#mktoForm_1767'-style selector
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

/**
 * Walks BambooHR's own bento wizard until the Marketo form lays out:
 *   scroll the step into view ("appear" keeps below-fold tiles display:none)
 *   -> pick the first visible tile (label.bento-tile-label)
 *   -> click button.bento-next
 *   -> repeat. Pages whose form is already visible exit on the first width
 *   check, and FORM may be null while the form is not yet discoverable (the
 *   wizard steps are driven blind in that case).
 */
async function driveWizard(page, FORM) {
  const laidOut = async () => (FORM ? (await formWidth(page, FORM)) > 100 : false);
  for (let step = 1; step <= 6 && !(await laidOut()); step++) {
    await page.locator('.form-wrapper').first().scrollIntoViewIfNeeded().catch(() => {});
    await page.locator(FORM || 'form[id^="mktoForm_"]').first().scrollIntoViewIfNeeded().catch(() => {});

    const tile = page.locator('label.bento-tile-label:visible').first();
    if (await tile.count()) {
      const text = (await tile.innerText().catch(() => '')).trim().slice(0, 40);
      logStep(`wizard step ${step}: picking bento tile "${text}"`);
      await tile.click({ timeout: 6000 }).catch((e) => logStep(`tile click skipped — ${String(e).split('\n')[0]}`));
      await page.waitForTimeout(1500);
      if (await laidOut()) break;
    }

    const next = page.locator('button.bento-next:visible').first();
    if ((await next.count()) === 0) break;
    const label = (await next.innerText().catch(() => '')).trim();
    logStep(`wizard step ${step}: clicking "${label}"`);
    await next.click({ timeout: 8000 }).catch((e) => logStep(`next click skipped — ${String(e).split('\n')[0]}`));
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

/** The context cookie currently holding the bucket value (name varies per test). */
async function findValueCookie(page, expected) {
  const jars = await page.context().cookies();
  return jars.find((c) => tokens(c.value).includes(expected)) || null;
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
    // The demo page parks the form behind its own wizard — drive it, then look again.
    logStep(`no form yet on ${pageKey} — driving the page wizard first`);
    await driveWizard(page, null);
    FORM = await resolveMarketoForm(page, target.formSelector, 10000);
  }
  expect(FORM, `${pageKey} (${target.url}) rendered no Marketo form to submit`).toBeTruthy();
  logStep(`form → ${FORM}`);
  const FORM_ID = FORM.match(/^#mktoForm_(\d+)/)?.[1] ?? null;

  // ── 3. lay the form out (pricing's hero form is visible; demo needs the wizard)
  await driveWizard(page, FORM);
  const width = await formWidth(page, FORM);
  expect(width, `the ${pageKey} form must be laid out before filling (rendered width ${width}px — the wizard never revealed it)`).toBeGreaterThan(100);

  // ── 4. pre-submit value evidence: LPV1__c must hold this bucket's token ────
  const preLPV1 = await waitForFormField(page, FORM, hiddenFields.experimentValue, { timeout: 25000, scrollInterval: 2000 });
  logStep(`LPV1__c (pre) = ${JSON.stringify(preLPV1)}`);

  const preCookieOk = await cookieHoldsValue(page, EXPECTED);
  logStep(`bucket value ${JSON.stringify(EXPECTED)} in a page cookie: ${preCookieOk ? 'yes' : 'NO (the hidden field is the primary evidence)'}`);

  expect(
    tokens(preLPV1),
    `LPV1__c on ${pageKey} is ${JSON.stringify(preLPV1)} — the #${testId} rollout does not stamp it on this form, `
      + `so a submission from here cannot prove the experiment`
      + (preCookieOk ? ` (a page cookie does hold ${JSON.stringify(EXPECTED)})` : ''),
  ).toContain(EXPECTED);

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

  // Required text extras (company size and friends) — text controls only; a
  // <select> of the same name is owned by the required-selects sweep below.
  for (const [name, value] of Object.entries(EXTRA_TEXT)) {
    const el = page.locator(`${FORM} [name="${name}"]`);
    if ((await el.count()) === 0) continue;
    const info = await el.first().evaluate((e) => ({ tag: e.tagName, value: e.value || '' }));
    if (info.tag === 'SELECT' || info.value) continue;
    await el.first().fill(value);
    logStep(`${name} (required text) filled with ${JSON.stringify(value)}`);
  }

  // Country=Philippines removes any State/Region field entirely (and is a real
  // option on every Marketo country list — guarded, never blind).
  const country = page.locator(`${FORM} [name="Country"]`);
  if (await country.count()) {
    const ph = await country.first().evaluate((el) => {
      const opt = [...el.options].find((o) => /philippines/i.test(o.value) || /philippines/i.test(o.textContent || ''));
      return opt ? opt.value : null;
    });
    if (ph) {
      await country.first().selectOption(ph);
      await page.waitForTimeout(1200);
      logStep('Country = Philippines (drops any State/Region field)');
    } else {
      logStep('Country offers no Philippines option — left to the required-selects sweep');
    }
  }

  // Anything else the form marks required-and-unchecked (consent boxes differ
  // per page) must be ticked too, or Marketo blocks the POST silently.
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

  // Pages add their own required pickers (Pricing asks employee count, country)
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

  // ── 6. the LPV1 record, pinned — the form's own hidden field, pre-submit ───
  const lpv1Value = (await readField(page, FORM, hiddenFields.experimentValue)) ?? preLPV1;
  const preHolder = await findValueCookie(page, EXPECTED);
  const filled = {};
  for (const name of Object.keys(LEAD)) filled[name] = await readField(page, FORM, name);
  filled.LPV1__c = lpv1Value;

  const previewShot = await screenshotPayload(page, {
    fields: filled,
    rows: [
      { label: 'LPV1__c', value: lpv1Value ?? '(empty)', ok: tokens(lpv1Value).includes(EXPECTED) },
      { label: 'expected', value: EXPECTED, ok: true },
      { label: 'form', value: FORM_ID ? `${FORM} (formid ${FORM_ID})` : FORM },
      { label: 'LEAD', value: `${filled.FirstName ?? '?'} ${filled.LastName ?? '?'} <${filled.Email ?? '?'}>` },
    ],
    tag: `${pageKey} · ${BUCKET_KEY}`,
    stage: DRY ? 'PREVIEW (not submitted — SUBMIT_DRY)' : 'PREVIEW (not submitted)',
    endpoint: DRY ? '(no POST — SUBMIT_DRY stops before submit)' : SAVE2,
    cookieName: preHolder?.name || '',
    cookieValue: preHolder?.value || '(absent)',
    screenshotPath: `${SHOTS}/${testId}-${STAGE}-lpv1-preview-${pageKey}-${BUCKET_KEY}.png`,
  });
  logStep(`LPV1 record screenshot → ${previewShot}`);

  // ── 7. DRY RUN stops here: the form is filled and evidenced, never fired ───
  if (DRY) {
    logStep(`SUBMIT_DRY — ${pageKey}/${BUCKET_KEY} filled and screenshotted, submit click SKIPPED`);
    return;
  }

  // ── 8. submit (exactly one) ────────────────────────────────────────────────
  logStep(`clicking Submit for ${pageKey}/${BUCKET_KEY} — one real submission, payload is captured observe-only`);
  const submit = await resolveSubmitButton(page, FORM);
  await submit.scrollIntoViewIfNeeded().catch(() => {});
  await submit.click({ timeout: 15000 }).catch(async () => {
    // Marketo's .mktoButtonWrap can transiently cover the button mid-animation;
    // .click() still dispatches a genuine DOM click.
    logStep('hit-target was covered — dispatching a direct DOM click');
    await submit.evaluate((el) => el.click());
  });
  await page.waitForTimeout(1500);

  // BambooHR's redirect path varies per target — landing somewhere real is
  // evidence, not a requirement; the captured payload is the proof.
  const landed = await page.waitForURL(/thank|success|demo|request/i, { timeout: 15000 })
    .then(() => true).catch(() => false);
  await page.waitForLoadState('load').catch(() => {});
  logStep(landed
    ? `landed on ${page.url()}`
    : `no redirect on ${pageKey} (now at ${page.url()}) — the captured payload is the proof`);

  // ── 9. assertions on the captured payload ──────────────────────────────────
  console.log(`\nPOST urls seen: ${JSON.stringify(postUrls, null, 1)}`);
  console.log(`save2 payloads captured: ${captured.length}`);
  for (const c of captured) console.log(`--- ${c.url} ---\n${decodeURIComponent((c.body || '').replace(/\+/g, ' '))}\n`);

  expect(captured.length, 'exactly one leadCapture/save2 POST must be captured').toBe(1);

  const payload = parsePayload(captured[0].body || '');
  expect(
    tokens(payload.get('LPV1__c')),
    `payload LPV1__c is ${JSON.stringify(payload.get('LPV1__c'))} — it must carry the #${testId} token for ${BUCKET_KEY}`,
  ).toContain(EXPECTED);
  expect(payload.get('FirstName')).toBe(LEAD.FirstName);
  expect(payload.get('LastName')).toBe(LEAD.LastName);
  expect(payload.get('Email')).toBe(LEAD.Email);
  if (FORM_ID) expect(payload.get('formid'), 'payload formid matches the form that was submitted').toBe(FORM_ID);

  // ── 10. the cookie must survive the submit (soft — the payload is primary) ─
  const postHolder = await findValueCookie(page, EXPECTED);
  if (postHolder) {
    expect(tokens(postHolder.value), `${postHolder.name} must survive the submit`).toContain(EXPECTED);
  } else {
    logStep(`⚠ no cookie holds ${JSON.stringify(EXPECTED)} after submit — the payload LPV1__c value is the primary evidence`);
  }

  // ── 11. evidence: save2 payload with the LPV1 record pinned ────────────────
  const shot = await screenshotPayload(page, {
    payload: captured[0].body || '',
    rows: [
      { label: 'LPV1__c', value: payload.get('LPV1__c') ?? '(absent)', ok: tokens(payload.get('LPV1__c')).includes(EXPECTED) },
      { label: 'expected', value: EXPECTED, ok: true },
      { label: 'formid', value: payload.get('formid') ?? '(none)', ok: !FORM_ID || String(payload.get('formid')) === FORM_ID },
      { label: 'Email', value: payload.get('Email') ?? '(none)', ok: payload.get('Email') === LEAD.Email },
    ],
    tag: `${pageKey} · ${BUCKET_KEY}`,
    stage: 'SUBMITTED',
    endpoint: SAVE2,
    cookieName: postHolder?.name || '',
    cookieValue: postHolder?.value || '(absent)',
    screenshotPath: `${SHOTS}/${testId}-submit-payload-${pageKey}-${BUCKET_KEY}.png`,
  });
  logStep(`payload screenshot → ${shot}`);

  await page.screenshot({ path: `${SHOTS}/${testId}-submit-thankyou-${pageKey}-${BUCKET_KEY}.png` });
  logStep('thank-you screenshot captured');
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
      const dests = (flowthroughDestination || []).join(', ');
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
    test(`#${testId} ${pageKey} form submission carries LPV1__c (${BUCKET_KEY} → ${EXPECTED})`, async ({ page }) => {
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
