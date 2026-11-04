/**
 * InsightSoftware A/B Test — form submission QA (config-driven, multi-page)
 *
 * One REAL submission per run by default: `config.submitBucket` picks the
 * bucket and the config UI narrows the run to its first ticked target page, so
 * a click on "Run submission" fires exactly one lead. Each run asserts the
 * serialized payload carries the bucket signal and the agreed QA lead
 * end-to-end:
 *
 *   CRO1       must equal that bucket's expectedValue (the site's own rollout
 *              writes it into the form before submit — proof the bucket stuck)
 *   firstName/lastName/email/company/phone — the mandated QA data
 *
 * TARGETS come from `config.submitPages` (the config UI's "Form submission
 * targets" card) and can be overridden for a single run:
 *   SUBMIT_PAGES=pricing,demo
 * Every key must be a real squeeze page with a form — resolveSubmitPages()
 * throws at load time otherwise.
 *
 * A submission target must also be OWNED by a configured test — either its
 * `tests[].page` (the form sits on the tested page) or one of its
 * `tests[].flowthroughDestination` (a flowthrough test: force the bucket on the
 * tested page, walk the funnel, submit on the destination squeeze page). A
 * target page with no test behind it is reported as an explicit skip, never
 * submitted blind.
 *
 * CRO1 on Insight's squeeze pages is a COMMA-JOINED list of every experiment
 * the session carries (sibling experiments are live alongside this one), so the
 * assertion is contains, not equality.
 *
 * Endpoint: POST /api/submit-form (the form's action), captured OBSERVE-ONLY
 * via page.on('request') — the request is recorded and let through untouched.
 * It is an AJAX submission, so the page never navigates; success is the
 * "Form submitted successfully!" banner. The banner and the thank-you heading
 * are evidence, not requirements — the captured POST is the hard assertion.
 *
 * The page renders third-party widgets after submit (reCAPTCHA Enterprise,
 * the Qualified messenger, and a Consensus demo scheduler loaded from
 * consensus_demo_url). THEY ARE NEVER INTERACTED WITH — screenshot only.
 *
 * FLAGS
 *   SUBMIT_LIVE=1  fire the real leads (1 per target page per bucket)
 *   SUBMIT_DRY=1   fill + screenshot the form, then STOP — no click, no lead.
 *                  Wins over SUBMIT_LIVE when both are set.
 *   SUBMIT_PAGES   comma-separated target keys (default: config.submitPages)
 *   SUBMIT_BUCKETS comma-separated bucket keys (default: config.submitBucket,
 *                  i.e. exactly one bucket — set it explicitly to fire several)
 * Without SUBMIT_LIVE/SUBMIT_DRY the spec is discovered and reported as
 * skipped, so `npm run test:iso` and the config UI's "Run downfunnel" stay
 * read-only:
 *   PowerShell:  $env:SUBMIT_DRY = '1'; npx playwright test --project=iso tests/insightsoftware/insightsoftware.submit.spec.js
 *
 * Test data (mandatory, exact):
 *   firstName  test
 *   lastName   test
 *   email      ryan+test@spiralyze.com
 *   company    Spiralyze
 *   phone      123456789
 *
 * Fields the form marks required BEYOND this lead are satisfied before the
 * "no required field may be left empty" guard: jobTitle is filled with "test"
 * when the page renders it visible; when it's hidden the spec waits for the
 * site's own /api/enrich-email enrichment to populate it (forcing "test" only
 * as a fallback) — native validation blocks the submit while a hidden required
 * field is empty. Other required consent boxes, pickers and text inputs are
 * handled generically (same handling as the SailPoint submit spec) and are not
 * asserted on the payload.
 */

// @ts-check
import { test, expect } from '@playwright/test';
import { INSIGHT_CONFIG } from './config/insightsoftware.config.js';
import {
  loadBucket,
  acceptCookies,
  waitForFormField,
  logStep,
  resolveSubmitPages,
  resolveSubmitBuckets,
} from '../sailpoint/helpers/abtest.helpers.js';
import { resolveTestPlans, findOwningTest } from './helpers/abtest.helpers.js';
import { screenshotPayload, parsePayload } from '../sailpoint/helpers/payload-screenshot.js';

const { hiddenFields } = INSIGHT_CONFIG;
const SUBMIT_PATH = /\/api\/submit-form/i;
const SHOTS = 'screenshots/insightsoftware-cookies';

const PLANS = resolveTestPlans(INSIGHT_CONFIG);

/**
 * A submission target is bound to the test that owns it — either the test runs
 * ON that page, or it flows through TO it (flowthroughDestination). A flowthrough
 * test has no form of its own: the bucket is forced on the tested page, the
 * funnel is walked to the destination squeeze page, and only there is the form
 * submitted. A target no test owns is reported as an explicit skip.
 *
 * @param {string} pageKey
 * @returns {object|null} the plan whose test owns pageKey
 */
const planFor = (pageKey) => {
  const owning = findOwningTest(INSIGHT_CONFIG, pageKey);
  return owning ? PLANS.find((p) => p.test.testId === owning.testId) ?? null : null;
};

const LEAD = {
  firstName: 'test',
  lastName: 'test',
  email: 'ryan+test@spiralyze.com',
  company: 'Spiralyze',
  phone: '123456789',
};

const DRY = /^(1|true|yes)$/i.test(process.env.SUBMIT_DRY || '');
const LIVE = /^(1|true|yes)$/i.test(process.env.SUBMIT_LIVE || '');
const RUN = DRY || LIVE;
// DRY wins over LIVE — with both flags set the form is filled and screenshotted,
// never clicked.
const STAGE = DRY ? 'dryrun' : 'submit';
const SKIP_REASON =
  'SUBMIT_LIVE is not enabled — set SUBMIT_LIVE=1 to fire 1 real submission per target page, or SUBMIT_DRY=1 to fill the form without submitting';

/** Page keys to exercise — config submitPages, overridden by SUBMIT_PAGES. */
const TARGETS = resolveSubmitPages(INSIGHT_CONFIG, process.env.SUBMIT_PAGES);

test.setTimeout(300_000);

/**
 * Picks the form this page actually posts: anything whose id ends in -inquiry,
 * the #inquiry-form used on the demo pages, or any form posting to
 * /api/submit-form. The config's generic `form` selector is deliberately NOT
 * used — it would happily match a newsletter box.
 *
 * @returns {Promise<string|null>} a concrete 'form#pricing-inquiry'-style selector
 */
async function resolveIsoForm(page, timeout = 20000) {
  const started = Date.now();
  let sel = null;
  do {
    sel = await page.evaluate(() => {
      const f = document.querySelector(
        'form[id$="-inquiry"], form#inquiry-form, form[action="/api/submit-form"]',
      );
      if (!f) return null;
      if (f.id) return `form#${f.id}`;
      return 'form[action="/api/submit-form"]';
    });
    if (sel) return sel;
    await page.mouse.wheel(0, 2000).catch(() => {});
    await page.waitForTimeout(1500);
  } while (Date.now() - started < timeout);
  return sel;
}

/** The form's submit control — a real submit input/button first, else button #1. */
async function resolveSubmitButton(page, formSel) {
  const typed = `${formSel} button[type="submit"]:visible, ${formSel} input[type="submit"]:visible`;
  if (await page.locator(typed).count()) return page.locator(typed).first();
  const any = `${formSel} button:visible`;
  if (await page.locator(any).count()) return page.locator(any).first();
  return page.locator(`${formSel} button`).first();
}

async function submitTarget(page, plan, pageKey, bucketKey, expected) {
  const t = plan.test;
  const FORM_PREF = plan.tested.formSelector;

  /** @type {{ url: string, body: string | null }[]} */
  const captured = [];
  /** @type {string[]} */
  const postUrls = [];
  let seenPost = () => {};

  // Observe-only: records the body, never blocks or alters the request.
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    postUrls.push(req.url());
    if (!SUBMIT_PATH.test(req.url())) return;
    captured.push({ url: req.url(), body: req.postData() });
    logStep(`captured POST ${req.url()} (${(req.postData() || '').length} bytes)`);
    seenPost();
  });

  // ── 1. force the bucket on the page this test owns ─────────────────────────
  logStep(`Loading ${bucketKey} for target "${pageKey}"…`);
  const script = t.cookieScript.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) =>
    String(t.bucketActivation?.[bucketKey]?.[k] ?? m));
  const target = t.buckets[bucketKey];

  if (target.bodyClass) {
    await loadBucket(page, bucketKey, plan.tested.url, script, t.buckets, hiddenFields.cro1, FORM_PREF, 15);
  } else {
    // True control has no body class — force activation, prove it by CRO1.
    await page.addInitScript(script);
    await page.goto(plan.tested.url, { waitUntil: 'domcontentloaded' });
    await acceptCookies(page);
    await page.waitForTimeout(5000);
  }
  await acceptCookies(page);
  await page.waitForTimeout(2000);

  // ── 1b. flowthrough: carry the bucket to the destination squeeze page ──────
  // A flowthrough test's own page has no form. The value must survive the
  // funnel — step 3 asserts it in CRO1 on the destination — and only there is
  // the form filled and submitted.
  const targetUrl = INSIGHT_CONFIG.pages[pageKey]?.url;
  if (!targetUrl) throw new Error(`submission target "${pageKey}" has no pages[].url`);
  const norm = (u) => u.split('?')[0].replace(/\/$/, '');
  if (norm(page.url()) !== norm(targetUrl)) {
    logStep(`flowthrough ${plan.tested.url} → ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await acceptCookies(page);
    await page.waitForTimeout(5000);
  }

  // ── 2. resolve the concrete form this page posts ───────────────────────────
  const FORM = await resolveIsoForm(page);
  expect(FORM, `${pageKey} (${plan.tested.url}) rendered no /api/submit-form form to submit`).toBeTruthy();
  logStep(`form → ${FORM}`);

  // ── 3. the bucket signal must already be in the form's CRO1 ────────────────
  // CRO1 is comma-joined with every experiment this session carries, so the
  // bucket must be one token of the list — never the whole field.
  const cro1 = await waitForFormField(page, FORM, hiddenFields.cro1, { timeout: 25000, scrollInterval: 1500 });
  logStep(`${hiddenFields.cro1} (pre) = ${JSON.stringify(cro1)}`);
  expect(cro1, `${hiddenFields.cro1} must be set before submit`).toBeTruthy();
  const cro1Tokens = String(cro1).split(',').map((s) => s.trim()).filter(Boolean);
  expect(
    cro1Tokens,
    `${hiddenFields.cro1} must carry ${expected} — saw ${JSON.stringify(cro1Tokens)} (sibling experiments share the field)`,
  ).toContain(expected);

  // ── 4. fill the mandated QA lead + marketing consent ───────────────────────
  for (const [name, value] of Object.entries(LEAD)) {
    const field = page.locator(`${FORM} [name="${name}"]`);
    await expect(field.first(), `${name} must be rendered on ${pageKey}`).toBeVisible({ timeout: 10000 });
    await field.first().fill(value);
    await expect(field.first()).toHaveValue(value);
  }

  const consent = page.locator(`${FORM} [name="gdprConsent"]`);
  if (await consent.count()) {
    await consent.first().check({ force: true });
    await expect(consent.first()).toBeChecked();
    logStep('consent checkbox gdprConsent ticked');
  }

  // jobTitle (the inquiry forms' extra required field): fill it ONLY when the
  // page actually renders it visible — some pages keep it hidden.
  const jobTitle = page.locator(`${FORM} [name="jobTitle"]`);
  if (await jobTitle.count()) {
    if (await jobTitle.first().isVisible()) {
      await jobTitle.first().fill('test');
      await expect(jobTitle.first()).toHaveValue('test');
      logStep('jobTitle visible — filled "test"');
    } else {
      // Hidden (div.hidden) on the inquiry forms: the site populates it via
      // its own /api/enrich-email lookup keyed on the email above. Native
      // validation BLOCKS the submit while a hidden required field is empty —
      // Chrome logs "An invalid form control with name='jobTitle' is not
      // focusable." and no POST is ever issued — so wait for the enrichment
      // to land (~1s) and force the QA value only as a fallback.
      const enriched = await page.waitForFunction((sel) => {
        const el = document.querySelector(sel);
        return Boolean(el && (el.value || '').trim());
      }, `${FORM} [name="jobTitle"]`, { timeout: 15000 }).then(() => true).catch(() => false);
      if (enriched) {
        logStep(`jobTitle hidden — enrichment populated it = ${JSON.stringify(await jobTitle.first().inputValue())}`);
      } else {
        await jobTitle.first().evaluate((el) => {
          el.value = 'test';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        logStep('jobTitle hidden and enrichment never landed — forced "test"');
      }
    }
  }

  // Anything else the form marks required-and-unchecked (other pages' consent
  // fields differ) must be ticked too, or the site's validation blocks the POST.
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

  // Pages add their own required pickers — choose a real option, skipping the
  // "Please select…" placeholder (same handling as the SailPoint spec).
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

  // Required TEXT inputs beyond the mandated lead (the inquiry forms ask for
  // jobTitle) — fill them so the guard below passes. Mandated LEAD values are
  // never overwritten: this only touches fields LEAD left empty.
  const requiredTexts = await page.evaluate((sel) => {
    const form = document.querySelector(sel);
    if (!form) return [];
    return [...form.querySelectorAll('input, textarea')]
      .filter((el) => el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'hidden'
        && (el.required || el.getAttribute('aria-required') === 'true')
        && !el.disabled
        && el.getClientRects().length > 0
        && !(el.value || '').trim())
      .map((el) => ({ name: el.name, type: (el.type || '').toLowerCase() }))
      .filter((f) => f.name);
  }, FORM);
  for (const f of requiredTexts) {
    const value = f.type === 'email' ? LEAD.email : f.type === 'tel' ? LEAD.phone : 'QA Test';
    await page.locator(`${FORM} [name="${f.name}"]`).first().fill(value);
    logStep(`required ${f.type || 'text'} field ${f.name} = ${JSON.stringify(value)}`);
  }

  // Only VISIBLE required fields count: a field the page doesn't render can't
  // be filled by a user either, and the site never demands what it hides.
  const emptyRequired = await page.evaluate((sel) => {
    const form = document.querySelector(sel);
    if (!form) return ['form not found'];
    return [...form.querySelectorAll('input, select, textarea')]
      .filter((el) => (el.required || el.getAttribute('aria-required') === 'true')
        && (el.type === 'checkbox' ? !el.checked : !(el.value || '').trim())
        && !el.disabled
        && el.getClientRects().length > 0)
      .map((el) => el.name);
  }, FORM);
  expect(emptyRequired, 'no required field may be left empty').toEqual([]);

  await page.locator(FORM).scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: `${SHOTS}/${t.testId}-${STAGE}-form-filled-${pageKey}-${bucketKey}.png` });

  // ── 5. DRY RUN stops here: the form is filled and evidenced, never fired ───
  if (DRY) {
    logStep(`SUBMIT_DRY — ${pageKey}/${bucketKey} filled and screenshotted, submit click SKIPPED`);
    return;
  }

  // ── 6. submit (exactly one real lead for this bucket) ──────────────────────
  logStep(`clicking Submit for ${pageKey}/${bucketKey} — one real submission, payload captured observe-only`);
  const submitted = new Promise((resolve) => { seenPost = resolve; });
  const submit = await resolveSubmitButton(page, FORM);
  await submit.scrollIntoViewIfNeeded().catch(() => {});
  await submit.click({ timeout: 15000 }).catch(async () => {
    logStep('hit-target was covered — dispatching a direct DOM click');
    await submit.evaluate((el) => el.click());
  });

  await Promise.race([
    submitted,
    page.waitForTimeout(30000).then(() => { throw new Error(`no POST /api/submit-form from ${pageKey} within 30s`); }),
  ]);

  // The banner / thank-you heading are evidence, not requirements — the POST
  // captured above is what proves the submission happened.
  logStep('success banner wait…');
  const bannerSeen = await page.getByText('Form submitted successfully!').first()
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  logStep(bannerSeen ? 'success banner shown' : `no success banner on ${pageKey} — relying on the captured payload`);

  // ── 7. NEVER touch what renders next (reCAPTCHA / Qualified / Consensus
  //       scheduler) — settle on the thank-you state, then screenshot. ────────
  await page.getByRole('heading', { name: /thank you/i }).first()
    .waitFor({ timeout: 30000 })
    .catch((e) => logStep(`thank-you heading not seen: ${e.message.split('\n')[0]}`));
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${SHOTS}/${t.testId}-submit-post-${pageKey}-${bucketKey}.png` });
  logStep('post-submit screenshot captured (widgets untouched)');

  // ── 8. assertions on the captured payload ──────────────────────────────────
  console.log(`\nPOST urls seen: ${JSON.stringify(postUrls, null, 1)}`);
  console.log(`submit-form payloads captured: ${captured.length}`);
  for (const c of captured) console.log(`--- ${c.url} ---\n${c.body}\n`);

  expect(captured.length, 'exactly one /api/submit-form POST must be captured').toBe(1);

  // urlencoded, multipart or JSON — parsePayload handles all three.
  const payload = parsePayload(captured[0].body || '');
  const cro1InPayload = payload[hiddenFields.cro1];
  for (const [name, value] of Object.entries(LEAD)) {
    expect(payload[name], `payload ${name}`).toBe(value);
  }
  const payloadTokens = String(cro1InPayload ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  expect(
    payloadTokens,
    `payload ${hiddenFields.cro1} must carry ${expected} — saw ${JSON.stringify(payloadTokens)}`,
  ).toContain(expected);

  // ── 9. evidence: pinned payload header + full body ─────────────────────────
  const shot = await screenshotPayload(page, {
    payload: captured[0].body || '',
    fields: payload,
    endpoint: '/api/submit-form',
    tag: `${pageKey} · ${bucketKey} → ${expected}`,
    stage: 'SUBMITTED',
    rows: [
      { label: hiddenFields.cro1, value: cro1InPayload ?? '(absent)', ok: payloadTokens.includes(expected) },
      { label: 'firstName / lastName', value: `${payload.firstName} ${payload.lastName}` },
      { label: 'email', value: payload.email },
      { label: 'company / phone', value: `${payload.company} / ${payload.phone}` },
    ],
    screenshotPath: `${SHOTS}/${t.testId}-submit-payload-${pageKey}-${bucketKey}.png`,
  });
  logStep(`payload screenshot → ${shot}`);
}

// With nothing selected the spec still reports one clearly-named skip instead
// of an empty file Playwright would reject with "No tests found".
let registered = 0;

for (const pageKey of TARGETS) {
  const plan = planFor(pageKey);

  // A squeeze page no test owns has no experiment to force and no known CRO1 —
  // submitting it would prove nothing. Report it, never fire it.
  if (!plan) {
    registered++;
    test(`submit ${pageKey} — no configured test`, () => {
      test.skip(true, `page "${pageKey}" is neither a tests[].page nor a flowthroughDestination of any test — give the owning test that page (or drop it from submitPages) so its CRO1 can be forced and asserted`);
    });
    continue;
  }

  const t = plan.test;
  // ONE bucket by default (config.submitBucket — the UI's "Bucket to submit"
  // radio), so a run fires exactly one lead per target page.
  const runBuckets = resolveSubmitBuckets(
    INSIGHT_CONFIG, process.env.SUBMIT_BUCKETS, Object.keys(t.buckets), pageKey,
  );
  for (const bucketKey of runBuckets) {
    registered++;
    const bucket = t.buckets[bucketKey];
    test(`#${t.testId} ${pageKey} form submission carries ${hiddenFields.cro1} + lead data (${bucketKey} → ${bucket.expectedValue})`, async ({ page }) => {
      test.skip(!plan.prelaunch, 'test is live (no cookieScriptExp) — the bucket cannot be forced');
      test.skip(!RUN, SKIP_REASON);
      await submitTarget(page, plan, pageKey, bucketKey, bucket.expectedValue);
    });
  }
}

if (!registered) {
  test('form submission — nothing to run', () => {
    test.skip(true, TARGETS.length
      ? 'no submission bucket resolved from submitBucket/SUBMIT_BUCKETS'
      : 'submitPages is empty — tick at least one squeeze page in the config UI');
  });
}
