/**
 * SailPoint A/B Test — Contact Us #9012 down-funnel regression (config-driven)
 *
 * Reproduces the reported bug: the #9012 value written into the Contact Us
 * form's `intellimize1` hidden field is LOST after the user switches tabs
 * (Sales → Locations → Sales) once they have travelled the full header
 * journey. Reported steps:
 *
 *   1. open /contact-us with the Variant (#9012) displayed
 *   2. submit the form                       ← the trigger (see NOTE below)
 *   3. go back to the contact-us page
 *   4. click the header logo      → home
 *   5. click "Get a demo"         → /demo
 *   6. browser back               → home
 *   7. open Agentic Fabric via the header CTA
 *   8. open Contact Us via the header CTA
 *   9.  intellimize1 must hold #9012 AND the other pages' values (#2040, #3018)
 *  10. open the "Locations" tab (form unmounts)
 *  11. open the "Sales" tab      (form re-mounts)
 *  12. intellimize1 must STILL hold #9012   ← currently fails = bug reproduced
 *
 * NOTE ON STEP 2 — probe evidence (Temp/opencode/spz-journey-nosubmit.txt):
 * running this whole journey WITHOUT submitting does NOT reproduce the bug:
 * all three tokens survive the tab switch. The submission is the trigger, so
 * the submit step is gated exactly like sailpoint.submit.spec.js:
 *
 *   SUBMIT_LIVE=1  fill AND submit (1 real lead) — the only mode that can
 *                  reproduce the reported bug
 *   SUBMIT_DRY=1   fill + screenshot, never click submit (wins over LIVE)
 *   neither        the test is skipped — the journey alone cannot catch this
 *
 *   PowerShell:  $env:SUBMIT_LIVE = '1'; npx playwright test --project=sp tests/sailpoint/sailpoint.contactus.spec.js
 *   cmd:         set SUBMIT_LIVE=1 && npx playwright test --project=sp tests/sailpoint/sailpoint.contactus.spec.js
 *
 * ACTIVATION — the config's `cookieScript` (spz-qa3) activates a DIFFERENT
 * test (#9014); #9012 activates on the `spz-qa=true` cookie. Bucketing is
 * sticky per Kameleoon visitor cookie, so every attempt wipes cookies and
 * storage first (same mechanic as loadBucket).
 *
 * Assertions (all token-aware — intellimize1 is a comma-joined list and
 * sibling tests such as #2040/#3018 append to it):
 *   step  9 → contains SPZ_9012_variant, a SPZ_2040_* and a SPZ_3018_* token
 *   step 12 → still contains SPZ_9012_variant (fails when the bug is present)
 */

// @ts-nocheck
import { test, expect } from '@playwright/test';
import { TEST_CONFIG } from './config/sailpoint.config.js';
import {
  getBodyClasses,
  getHiddenFieldValue,
  waitForFormField,
  screenshotWithCookies,
  logStep,
} from './helpers/abtest.helpers.js';

const { pages, hiddenFields } = TEST_CONFIG;
const CONTACT = pages.contact;
const FORM_SEL = CONTACT.formSelector;
const VALUE_FIELD = hiddenFields.experimentValue; // intellimize1

// ── #9012 activation ─────────────────────────────────────────────────────────
const QA_COOKIE = { name: 'spz-qa', value: 'true', domain: 'www.sailpoint.com', path: '/' };
const BUCKET_BODY_CLASS = 'spz_9012_v';
const BUCKET_VALUE = 'SPZ_9012_variant';

// ── Submission gate (same convention as sailpoint.submit.spec.js) ────────────
const DRY = /^(1|true|yes)$/i.test(process.env.SUBMIT_DRY || '');
const LIVE = /^(1|true|yes)$/i.test(process.env.SUBMIT_LIVE || '');
// DRY wins over LIVE — with both set the form is filled, never clicked.
const STAGE = DRY ? 'dryrun' : 'submit';

const LEAD = {
  FirstName: 'SPZtest',
  LastName: 'SPZtest',
  Email: 'ryan+test@spiralyze.com',
  Phone: '1234567890',
  Company: 'spiralyze',
  Title: 'test',
};
// Title / Phone / Company may be absent on some layouts — only these three
// must exist or no real lead can be posted.
const LEAD_REQUIRED = ['FirstName', 'LastName', 'Email'];

const tokens = (raw) => String(raw || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);

// The journey is long (bucket landing can take several attempts) — give it room.
test.setTimeout(600_000);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Dismisses SailPoint's OneTrust banner (the suite's acceptCookies targets DataGrail). */
async function dismissOneTrust(page) {
  const btn = page.locator('#onetrust-accept-btn-handler').first();
  if (await btn.count().catch(() => 0)) {
    await btn.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    logStep('OneTrust consent dismissed');
    return true;
  }
  return false;
}

/**
 * Lands the #9012 VARIANT bucket on /contact-us. Bucketing is sticky per
 * Kameleoon visitor cookie, so each attempt wipes cookies + storage before
 * re-navigating (without the wipe a control session stays control forever).
 *
 * @returns {Promise<string>} the body classes seen when the variant landed
 */
async function landVariant(page, maxAttempts = 10) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 1. land so we have the sailpoint.com origin (needed to clear its storage)
    await page.goto(CONTACT.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).catch(() => {});
    // 2. wipe the sticky bucketing, then (re)apply the #9012 activation cookie
    await page.context().clearCookies().catch(() => {});
    await page.context().addCookies([QA_COOKIE]);
    await dismissOneTrust(page);
    // 3. fresh navigation so SPZ re-buckets
    await page.goto(CONTACT.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // The body class and intellimize1 do NOT land together — a run observed
    // body=spz_9012_v while the field still read SPZ_9012_truecontrol. Require
    // BOTH signals, polling, before accepting the attempt.
    const landed = await page
      .waitForFunction(
        ({ cls, val }) => document.body.className.includes(cls)
          && String(document.querySelector('input[name="intellimize1"]')?.value || '')
            .split(/[,;]/).map((s) => s.trim()).includes(val),
        { cls: BUCKET_BODY_CLASS, val: BUCKET_VALUE },
        { timeout: 30000 },
      )
      .then(() => true)
      .catch(() => false);

    const bodyClasses = await getBodyClasses(page);
    if (landed) {
      logStep(`attempt ${attempt}: landed ${BUCKET_BODY_CLASS} ✅ ("${bodyClasses}")`);
      return bodyClasses;
    }
    console.log(`  attempt ${attempt}: wrong/partial bucket — "${bodyClasses}" — retrying…`);
  }
  throw new Error(
    `could not land ${BUCKET_BODY_CLASS} in ${maxAttempts} attempts. ` +
    `#9012 buckets ~50/50 per fresh Kameleoon session — check the spz-qa cookie still activates it.`,
  );
}

/** The concrete Marketo form this page submits (same picker as the submit spec). */
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

const readField = (page, formSel, name) =>
  page.evaluate(
    ([sel, n]) => document.querySelector(sel)?.querySelector(`[name="${n}"]`)?.value ?? null,
    [formSel, name],
  );

/** Waits for a tab to become active and, optionally, for the Marketo form to be mounted. */
function waitForTab(page, wantsFormTab, label) {
  return page.waitForFunction(
    ({ wantsFormTab, label }) => {
      const active = [...document.querySelectorAll('button[role="tab"]')]
        .find((t) => t.getAttribute('aria-selected') === 'true');
      const hasForm = [...document.querySelectorAll('form.mktoForm, form[id^="mktoForm"]')].some((f) => f.id);
      const labelOk = !label || active?.innerText?.trim() === label;
      return wantsFormTab ? (hasForm && labelOk) : (!hasForm && labelOk);
    },
    { wantsFormTab, label },
    { timeout: 30000 },
  ).catch(() => {});
}

/**
 * Clicks a header/nav CTA and asserts it navigated. Falls back to an in-page
 * element.click() because SailPoint's mega-menu links are covered by the
 * <main> subtree for Playwright's pointer-event hit test.
 */
async function clickHeaderCta(page, selector, expectPath, label) {
  const before = page.url();
  let clicked = false;
  try {
    await page.locator(selector).first().click({ timeout: 8000 });
    clicked = true;
  } catch (e) {
    console.log(`  ${label}: pointer click blocked (${e.message.split('\n')[0]}) — using element.click()`);
    // :visible is Playwright-only — querySelectorAll rejects it, so strip it
    // and filter on real geometry/visibility inside the page instead.
    const css = selector.replace(/:visible/g, '');
    const dispatched = await page.evaluate((sel) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) >= 0.1;
      };
      const all = [...document.querySelectorAll(sel)];
      const el = all.find(visible) || all[0];
      if (!el) return false;
      el.click();
      return true;
    }, css);
    clicked = dispatched;
  }
  expect(clicked, `${label}: no matching link found (${selector})`).toBe(true);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForURL((u) => u.href !== before, { timeout: 20000 })
    .catch(() => { /* asserted below */ });
  // Normalise BOTH sides — "/" and "" both mean the homepage.
  const landed = new URL(page.url()).pathname.replace(/\/$/, '');
  expect(landed, `${label} must navigate`).toBe(expectPath.replace(/\/$/, ''));
}

// ─── The test ────────────────────────────────────────────────────────────────

test('Contact Us #9012 — hidden value survives header journey + tab switch', async ({ page }) => {
  test.skip(
    !DRY && !LIVE,
    'the reported bug only reproduces after a real submission — set SUBMIT_LIVE=1 (repro) or SUBMIT_DRY=1 (fill-only mechanics run)',
  );

  let capturedSave2 = 0;
  // Observe-only: records the payload, never blocks or alters the request.
  page.on('request', (req) => {
    if (req.method() !== 'POST' && req.method() !== 'post') return;
    if (!/index\.php\/leadCapture\/save2/i.test(req.url())) return;
    capturedSave2++;
    logStep(`captured POST ${req.url()} (${(req.postData() || '').length} bytes)`);
  });

  // ── 1. land the #9012 variant on Contact Us ────────────────────────────────
  logStep('Step 1: land the #9012 Variant on Contact Us');
  const bodyClasses = await landVariant(page);
  // Poll for the EXPECTED token (not just any non-empty value) — the field can
  // briefly hold the control value right after the variant body class lands.
  let step1Value = null;
  for (let i = 0; i < 20 && !tokens(step1Value).includes(BUCKET_VALUE); i++) {
    step1Value = await waitForFormField(page, FORM_SEL, VALUE_FIELD, { timeout: 3000, scrollInterval: 500 });
    if (!tokens(step1Value).includes(BUCKET_VALUE)) await page.waitForTimeout(1000);
  }
  console.log(`  ${VALUE_FIELD} = ${JSON.stringify(step1Value)}`);
  expect(
    tokens(step1Value),
    `step 1: Contact Us must display the #9012 Variant (${BUCKET_VALUE})`,
  ).toContain(BUCKET_VALUE);
  expect(bodyClasses, 'step 1: body must carry the #9012 variant class').toContain(BUCKET_BODY_CLASS);
  await screenshotWithCookies(page, `contactus_9012_${STAGE}_1_variant`, hiddenFields, FORM_SEL, undefined, {
    stepLabel: 'Step 1: #9012 Variant on Contact Us',
    bucketLabel: 'Variant',
    bucketValue: BUCKET_VALUE,
  });

  // ── 2. fill (and, when LIVE, submit) the form ───────────────────────────────
  logStep(`Step 2: fill the Contact Us form (${LIVE && !DRY ? 'LIVE submit' : 'DRY — no submit'})`);
  const FORM = await resolveMarketoForm(page, FORM_SEL);
  expect(FORM, `${CONTACT.url} rendered no Marketo form to submit`).toBeTruthy();
  logStep(`form → ${FORM}`);

  for (const [name, value] of Object.entries(LEAD)) {
    const field = page.locator(`${FORM} [name="${name}"]`);
    if ((await field.count()) === 0) {
      expect(LEAD_REQUIRED.includes(name), `${name} is missing — a lead cannot be submitted`).toBe(false);
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

  // Required pickers this page adds (e.g. reasonforInquiry) — pick a real
  // option, skipping the "Please select…" placeholder.
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
      const opt = [...el.options].find((o) => o.value && !re.test(o.value.trim())
        && !re.test((o.textContent || '').trim()));
      return opt ? opt.value : null;
    }, PLACEHOLDER.source);
    expect(value, `required select ${name} offers no usable option`).toBeTruthy();
    await select.selectOption(value);
    logStep(`required select ${name} = ${JSON.stringify(value)}`);
  }

  // Any required checkbox left unticked blocks the POST silently. Contact Us
  // ships Global_Opt_out__c (NOT Global_Opt_in__c) — tick whatever is required.
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

  // No required field may be left empty, or Marketo blocks the POST.
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
  await screenshotWithCookies(page, `contactus_9012_${STAGE}_2_form_filled`, hiddenFields, FORM_SEL, undefined, {
    stepLabel: `Step 2: form filled (${STAGE})`,
    bucketLabel: 'Variant',
    bucketValue: BUCKET_VALUE,
  });

  // DRY stops here: filled and evidenced, never fired.
  if (DRY) {
    logStep('SUBMIT_DRY — filled and screenshotted, submit click SKIPPED');
  } else {
    logStep('clicking Submit — one real submission, payload captured observe-only');
    const submit = page.locator(`${FORM} .mktoButton:visible, ${FORM} button[type="submit"]:visible, ${FORM} input[type="submit"]:visible`).first();
    await submit.scrollIntoViewIfNeeded().catch(() => {});
    await submit.click({ timeout: 15000 }).catch(async () => {
      logStep('hit-target was covered — dispatching a direct DOM click');
      await submit.evaluate((el) => el.click());
    });
    await page.waitForTimeout(2000);
    expect(capturedSave2, 'a leadCapture/save2 POST must be captured').toBeGreaterThan(0);
  }

  // ── 3. go back to the contact-us page ──────────────────────────────────────
  logStep('Step 3: back to Contact Us');
  const afterSubmitUrl = page.url();
  if (DRY) {
    // No navigation happened, so there is no history entry to go back to —
    // land on Contact Us directly (the journey below is identical from here).
    console.log('  DRY: no redirect occurred — navigating to Contact Us instead of goBack()');
    await page.goto(CONTACT.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } else if (afterSubmitUrl !== CONTACT.url && new URL(afterSubmitUrl).pathname !== new URL(CONTACT.url).pathname) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
  } else {
    await page.goto(CONTACT.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await page.waitForFunction(
    () => document.querySelector('input[name="intellimize1"]')?.value,
    null,
    { timeout: 30000 },
  ).catch(() => {});
  await dismissOneTrust(page);
  const backValue = await waitForFormField(page, FORM_SEL, VALUE_FIELD, { timeout: 20000, scrollInterval: 1500 });
  console.log(`  after step 3 ${VALUE_FIELD} = ${JSON.stringify(backValue)}`);
  expect(tokens(backValue), 'step 3: #9012 must still be on Contact Us after going back').toContain(BUCKET_VALUE);

  // ── 4. header logo → home ──────────────────────────────────────────────────
  logStep('Step 4: header logo → home');
  await clickHeaderCta(page, 'a[href="/"]:visible', '/', 'logo');
  await page.waitForTimeout(4000);
  await dismissOneTrust(page);

  // ── 5. "Get a demo" → /demo ────────────────────────────────────────────────
  logStep('Step 5: header "Get a demo" → demo');
  await clickHeaderCta(page, 'a[href="/demo"]:visible', '/demo', 'Get a demo');
  await page.waitForTimeout(4000);
  await dismissOneTrust(page);

  // ── 6. browser back → home ─────────────────────────────────────────────────
  logStep('Step 6: browser back → home');
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  await dismissOneTrust(page);
  expect(new URL(page.url()).pathname.replace(/\/$/, ''), 'step 6: back must land on home').toBe('');

  // ── 7. Agentic Fabric via the header CTA ───────────────────────────────────
  logStep('Step 7: header CTA → Agentic Fabric');
  // The mega menu must be open for the link to exist in the DOM at all.
  for (const menu of ['Platform', 'Solutions', 'Services', 'Resources', 'Company']) {
    const found = await page.evaluate((name) => {
      const b = [...document.querySelectorAll('nav button, header button')]
        .find((x) => (x.innerText || '').trim() === name);
      if (!b) return 0;
      b.click();
      return [...document.querySelectorAll('a[href="/products/agentic-fabric"]')].length;
    }, menu);
    if (found > 0) { logStep(`mega menu opened via "${menu}"`); break; }
    await page.waitForTimeout(800);
  }
  await clickHeaderCta(page, 'a[href="/products/agentic-fabric"]', '/products/agentic-fabric', 'Agentic Fabric');
  await page.waitForTimeout(4000);
  await dismissOneTrust(page);

  // ── 8. Contact Us via the header CTA ───────────────────────────────────────
  logStep('Step 8: header CTA → Contact Us');
  await clickHeaderCta(page, 'a[href="/contact-us"]:visible', '/contact-us', 'Contact us');
  await page.waitForFunction(
    () => document.querySelector('input[name="intellimize1"]')?.value,
    null,
    { timeout: 30000 },
  ).catch(() => {});
  await dismissOneTrust(page);

  // ── 9. the hidden value must hold #9012 AND the other pages' values ────────
  logStep('Step 9: intellimize1 must hold #9012 + #2040 + #3018');
  const journeyValue = await waitForFormField(page, FORM_SEL, VALUE_FIELD, { timeout: 25000, scrollInterval: 1500 });
  const journeyTokens = tokens(journeyValue);
  console.log(`  ${VALUE_FIELD} = ${JSON.stringify(journeyValue)}`);
  console.log(`  tokens: ${JSON.stringify(journeyTokens)}`);
  expect(journeyTokens, `step 9: must still contain the #9012 value (${BUCKET_VALUE})`).toContain(BUCKET_VALUE);
  expect(
    journeyTokens.some((t) => t.startsWith('SPZ_2040_')),
    `step 9: must also carry the #2040 page's value (got ${JSON.stringify(journeyValue)})`,
  ).toBe(true);
  expect(
    journeyTokens.some((t) => t.startsWith('SPZ_3018_')),
    `step 9: must also carry the #3018 page's value (got ${JSON.stringify(journeyValue)})`,
  ).toBe(true);
  await screenshotWithCookies(page, `contactus_9012_${STAGE}_9_journey_value`, hiddenFields, FORM_SEL, undefined, {
    stepLabel: 'Step 9: #9012 + #2040 + #3018 present after the header journey',
    bucketLabel: 'Variant',
    bucketValue: BUCKET_VALUE,
  });

  // ── 10. Locations tab (form unmounts) ──────────────────────────────────────
  logStep('Step 10: open the Locations tab (form unmounts)');
  await page.locator('button[role="tab"]').filter({ hasText: 'Locations' }).first().click({ timeout: 15000 });
  await waitForTab(page, false, 'Locations');
  const onLocations = await getHiddenFieldValue(page, VALUE_FIELD, FORM_SEL);
  console.log(`  Locations tab ${VALUE_FIELD} = ${JSON.stringify(onLocations)} (form unmounted)`);
  await screenshotWithCookies(page, `contactus_9012_${STAGE}_10_locations_tab`, hiddenFields, undefined, undefined, {
    stepLabel: 'Step 10: Locations tab — form unmounted',
    bucketLabel: 'Variant',
    bucketValue: BUCKET_VALUE,
  });

  // ── 11/12. Sales tab → the value must survive the re-mount ─────────────────
  logStep('Step 11: back to the Sales tab — the #9012 value must survive');
  await page.locator('button[role="tab"]').filter({ hasText: 'Sales' }).first().click({ timeout: 15000 });
  await waitForTab(page, true, 'Sales');
  const afterValue = await waitForFormField(page, FORM_SEL, VALUE_FIELD, { timeout: 25000, scrollInterval: 2000 });
  const afterTokens = tokens(afterValue);
  console.log(`  Sales tab ${VALUE_FIELD} = ${JSON.stringify(afterValue)}`);
  console.log(`  tokens: ${JSON.stringify(afterTokens)}`);

  // THE BUG ASSERTION — this is the reported failure: #9012 vanishes here.
  expect(
    afterTokens,
    `BUG REPRODUCED: after Sales → Locations → Sales the #9012 value is gone ` +
    `(${VALUE_FIELD} went from ${JSON.stringify(journeyValue)} to ${JSON.stringify(afterValue)})`,
  ).toContain(BUCKET_VALUE);

  // Every token seen before the tab switch must still be there.
  for (const token of journeyTokens) {
    expect(
      afterTokens,
      `After tab switching, ${VALUE_FIELD} must still contain "${token}" (value lost on form re-render)`,
    ).toContain(token);
  }

  const bodyAfter = await getBodyClasses(page);
  console.log(`  body classes after tab cycle: "${bodyAfter}"`);
  expect(bodyAfter, '#9012 body class must persist after the tab re-render').toContain(BUCKET_BODY_CLASS);

  await screenshotWithCookies(page, `contactus_9012_${STAGE}_12_after_tabs`, hiddenFields, FORM_SEL, undefined, {
    stepLabel: 'Step 12: Sales tab after the cycle — #9012 value persisted',
    bucketLabel: 'Variant',
    bucketValue: BUCKET_VALUE,
  });

  logStep('PASS — the #9012 value survived the header journey and the tab switch');
});
