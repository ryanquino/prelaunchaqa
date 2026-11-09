---
name: A/B QA Suite Testing
description: Run and maintain the config-driven A/B QA Playwright suite for SailPoint (sp), InsightSoftware (iso), BambooHR (bhr) and Goddard (goddard) — run commands, config edits, form-submission gating, per-client activation quirks, the downfunnel setup checklist (pre-launch / post-launch), and the hidden-value carry and popup rules.
---

# A/B QA Suite — Testing Clients

Config-driven Playwright suite at the repo root. A config JSON drives the specs;
`tests/config-ui/` is the single editor for it. Four clients are registered in
the config UI: **iso, sp, bhr, goddard**.

## Layout

```
playwright.config.js              testDir ./tests, workers 1, fullyParallel false
package.json                      npm run scripts (below)
tests/config-ui/server.mjs        CLIENTS registry + config UI (port 4173)
tests/<client>/config/*.data.json THE config (edited by the UI; .bak on every save)
tests/<client>/config/*.config.js reads the JSON, re-exports it for the specs
tests/<client>/helpers/abtest.helpers.js   per-client utilities
tests/<client>/*.spec.js          the tests
```

Playwright projects: `sp`, `bhr`, `iso`, `cw`, `goddard`.
`npx playwright test --list` baseline: **138 tests / 15 files**.

> ConnectWise (`--project=cw`, `npm run test:cw`) exists as a 5th project but has
> **no config-UI entry** — it is out of scope for the config-driven workflow.

---

## Hard rules

1. **Never run two Playwright processes at once.** A second run wipes
   `test-results/`. Always check first:
   ```powershell
   Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node' -and $_.CommandLine -match 'playwright' }
   ```
2. **Never submit a live form without explicit user approval.** Read-only runs
   and `SUBMIT_DRY` are always fine; `SUBMIT_LIVE` needs a yes.
3. **Evidence screenshots never go under `test-results/`** — Playwright wipes
   `outputDir` at the start of every run, deleting them. Use the client's
   `screenshotsDir` (table below).
4. **One-off probe scripts are read-only.** They write ONLY to
   `C:\Users\SkyeRaine\AppData\Local\Temp\opencode`, never to `test-results/`
   or `screenshots/`. Use plain `node probe-*.mjs` (the `playwright` package),
   not `@playwright/test`. **Delete every `probe-*.mjs` when done.**
5. **Don't clobber uncommitted user edits.** `git status` first; several config
   JSONs carry the user's own uncommitted changes.
6. **Commit/push only when asked**, and source only.
7. Config UI restart: kill the PID on 4173, then
   ```powershell
   Start-Process cmd "/c npm run config:ui > C:\Users\SkyeRaine\AppData\Local\Temp\opencode\configui.log 2>&1" -WindowStyle Hidden
   ```

---

## Shared workflow

```bash
# Config UI (single editor for all clients) — http://localhost:4173
npm run config:ui

# Validate the config contract, then run the journey suite
npx playwright test --project=<p> tests/<client>/<client>.config.spec.js
npm run test:<client>

# Full HTML report
npm run report
```

**Verify with `--list` before running** — it catches syntax/import errors without
touching the network:

```bash
npx playwright test --list
```

### Form submission gating

Every submit spec reads these env vars and **skips with an explanatory reason**
when neither is set:

| Flag | Effect |
|---|---|
| `SUBMIT_DRY=1` | Fill + screenshot the form, **never click submit**. Wins over `SUBMIT_LIVE` when both are set. |
| `SUBMIT_LIVE=1` | Fire one real lead per target page per bucket. |
| `SUBMIT_PAGES` | Comma-separated page keys (default: `config.submitPages`). |
| `SUBMIT_BUCKETS` | Comma-separated bucket keys (default: `config.submitBucket`). |

```powershell
# PowerShell
$env:SUBMIT_DRY='1'; npx playwright test --project=sp tests/sailpoint/sailpoint.submit.spec.js
Remove-Item Env:\SUBMIT_DRY
```
```bash
# cmd
set SUBMIT_DRY=1 && npx playwright test --project=sp tests/sailpoint/sailpoint.submit.spec.js
```

The config UI's **Run submission** button requires `chkSubmitLive` to be ticked.
It passes `submitEnv` from the registry — for **bhr that is `SUBMIT_DRY`**, so a
ticked run is still dry until the registry is flipped to `SUBMIT_LIVE`.

---

## Client reference

| | SailPoint | InsightSoftware | BambooHR | Goddard |
|---|---|---|---|---|
| project | `sp` | `iso` | `bhr` | `goddard` |
| config UI key | `sp` | `iso` | `bhr` | `goddard` |
| domain | www.sailpoint.com | insightsoftware.com | bamboohr.com | goddardschoolfranchise.com |
| experiment platform | Kameleoon | VWO | SPZ / `?spz-qa=true` | SPZ (live) |
| CRO field | `intellimize1` | `ExperimentName` / `ExperimentValue` / `CRO1` | config `hiddenFields` | `0-1/cr01` (HubSpot) |
| submit endpoint | `/index.php/leadCapture/save2` | `/api/submit-form` | Marketo save2 | **none — read-only** |
| config contract spec | ✅ | ✅ | ❌ | ❌ |
| popup spec | ✅ | ❌ | ✅ | ❌ |
| submit spec | ✅ | ✅ | ✅ (UI defaults to DRY) | ❌ |
| evidence dir | `screenshots/cookies` | `screenshots/insightsoftware-cookies` | `screenshots/cookies` | `screenshots/goddard-cookies` |

### npm scripts

```bash
npm run test:sailpoint        # sp downfunnel
npm run test:sailpoint:popup  # sp popup
npm run test:sailpoint:all    # whole sp dir

npm run test:iso              # iso downfunnel + config contract
npm run test:iso:all          # whole iso dir

npm run test:bamboohr         # bhr downfunnel
npm run test:bamboohr:popup   # bhr popup
npm run test:bamboohr:all     # whole bhr dir

npm run test:goddard          # goddard downfunnel
```

---

## sp — SailPoint

**Activation.** `cookieScript` in the config sets the `spz-qa3` cookie, which
activates **#9014**, not #9012. Probe-proven QA cookie matrix on `/contact-us`:

| cookie | activates |
|---|---|
| `spz-qa` | **#9012** (plus #2040, #3018) |
| `spz-qa1` | #2044 only |
| `spz-qa2` | nothing |
| `spz-qa3` | #9014 |
| `spz-qa4` | #9012 true-control |

Buckets are **sticky per Kameleoon visitor cookie** — a control session stays
control forever. To re-bucket, wipe cookies + `localStorage`/`sessionStorage`
before each attempt (this is what `loadBucket` does).

**Bucket signals.** Body class `spz_<id>_v` / `spz_<id>_tc`; value
`SPZ_<id>_variant` / `SPZ_<id>_truecontrol`. The two do **not** land together —
a run showed body `spz_9012_v` while `intellimize1` still read
`SPZ_9012_truecontrol`. **Require both, and poll** (`page.waitForFunction`)
before accepting a landing.

**Values are comma-joined.** `intellimize1` accumulates tokens from sibling
tests (`SPZ_2040_variant,SPZ_3018_truecontrol,SPZ_9012_variant`), so assert with
token-aware `includes`, never string equality. `intellimize2` is stamped on the
submit click as US/Eastern time.

**Consent is OneTrust** (`#onetrust-accept-btn-handler`). The suite's
`acceptCookies` targets DataGrail and will **not** match — dismiss OneTrust
yourself in a new spec.

**Gotchas.**
- Header nav buttons (Platform/Solutions/…) and mega-menu links are covered by
  `<main>`; Playwright pointer clicks time out. Fall back to in-page
  `element.click()`, and **strip `:visible` first** — it is a Playwright-only
  pseudo-class and `querySelectorAll` throws on it.
- The contact-us variant page shows only the logo (no nav CTAs); "Get a demo" /
  "Contact us" live in the home and product page headers.
- Contact-us form: required `FirstName, LastName, Email, Phone, Title, Company`,
  selects `Country, State, reasonforInquiry`, and the consent checkbox is
  **`Global_Opt_out__c`** (not `Global_Opt_in__c`).
- `Country=Philippines` removes the State field.
- Tabbed contact-us form: `Sales` (default), `Support`, `Locations` —
  `button[role="tab"]`. Non-form tabs unmount the Marketo form
  (`intellimize1` → `null`).

**Specs:** `config`, `downfunnel`, `popup`, `flowthrough`, `submit`,
`contactus` (the #9012 tab-switch regression — requires `SUBMIT_LIVE=1` to
reproduce, since submitting the form is the trigger).

---

## iso — InsightSoftware

**`multiTest: true`** — `insightsoftware.data.json` stores tests in a `tests[]`
array, not one flat config. Each test has its own `page`, `cookieScript`,
`buckets` and `flowthroughDestination`.

**Activation.** VWO. `cookieScriptExp` holds the experiment number; the snippet
is generated from it, so the exp number is the only per-test difference. Empty
`''` = postlaunch (nothing injected).

**Hidden fields:** `ExperimentName`, `ExperimentValue`, `CRO1`.

**Submission** posts to `/api/submit-form` (regex `SUBMIT_PATH`). A target must
be owned by a test — either the test runs on that page or it is a
`flowthroughDestination` of one — otherwise it is reported as an explicit skip.
Prelaunch-only targets skip when the test is live.

**Helpers are shared with SailPoint:** iso imports `../sailpoint/helpers/
abtest.helpers.js` alongside its own `./helpers/abtest.helpers.js`. Changing the
SailPoint helpers affects iso.

No popup spec.

---

## bhr — BambooHR

**No cookieScript activation.** The test loads from the **`?spz-qa=true` query
param on every page URL**. `cookieScript` is only a *phase marker* — a JS
comment (`/* prelaunch — test loads via ?spz-qa=true on page URLs */`) that the
prelaunch branch evals as a no-op; blank it to `''` to switch to postlaunch. Keep
`?spz-qa=true` on every `pages.*.url`.

**No config-contract spec** (`validateSpec: null`) — validate by running the
downfunnel suite.

**`hasHeroForm: true`** — pages carry either an inline hero form or a modal
popup, and the config picks which one holds the down-funnel value. `popupValues`
is populated, so the popup spec runs.

**Consent is DataGrail** — the suite's `acceptCookies` works here (unlike sp).

**Submission** is wired DRY in the config UI (`submitEnv: 'SUBMIT_DRY'`).

**Known issue — #5016:** the `?spz-qa=true` consumer no longer exists anywhere
on bamboohr.com (site-side state change). The suite cannot activate the test and
fails until the site restores it. Diagnose by comparing page HTML with and
without the param before suspecting the suite.

**Template client** — config values are placeholders until filled in for a real
test.

---

## goddard — Goddard

**Read-only. No form is ever submitted and there is no submit spec.**

HubSpot form. The CRO field is `crFieldName: "0-1/cr01"` (not intellimize1).

**No `buckets` and no `hiddenFields`.** Instead each page declares
`expectedExperiments` (e.g. `["1010"]`, `["4000"]`, `["2011"]`), and the config
lists the cookies to read: `ExperimentName`, `ExperimentValue`,
`HiddenFieldValue`, `Experiment`.

**`flowthroughDestination` is ONE page key**, not a list (currently
`infoRequest`).

**Live rollout, 50/50, no injection** — the spec loops fresh sessions
(`SESSION_ATTEMPTS = 6`, ~98% chance of seeing both) until both buckets are
observed, screenshotting each. Bucket tokens look like `spz_<expId>_variant` /
`spz_<expId>_control`. `freshSession()` is just `page.context().clearCookies()`.

Only one spec: `goddard.downfunnel.spec.js`.

---

## Downfunnel QA guide

One reference file —
[`references/downfunnel-qa-guide.md`](references/downfunnel-qa-guide.md) —
merges two sources: **Part A**, the team's setup checklist (Google Sheet
**"STATUS OF DOWNFUNNEL SET UP – AQA HIDDEN FIELDS"**), and **Part B**, the
dev's hidden-value rules. Run it when QAing a test's **downfunnel setup**, not
just the suite — both parts are broader than Playwright: prerequisites, the A/B
platform, GA, Asana and the post-launch handoff are human steps.

**Read Part B before judging a carry or popup failure as a bug** — it defines
what "correct" means; Part A is how you verify it.

### Part A — setup checklist

**Stage 1 — PRE-LAUNCH (steps 1–10)**

| # | Check | Suite coverage |
|---|---|---|
| 1 | Prerequisites: tracking method known, testing-tool + GA access, VPN for US-only tests | human |
| 2 | Test in **soft-launch** (UTM param / QA countries); **2.1** test name carries the **`[AQA] - #XXXX \| Client \| Page \| Test Name`** prefix | human (`?spz-qa=true` / `spz-qa` is this suite's QA gate) |
| 3 | Write answers in **QA Remarks**: variant count + names; is true control a copy or a previous winner; experiment cookie names; where the test runs | config `buckets[].label`, `bodyClass: ''` = true control, `cookieNames` / `hiddenFields` |
| 4 | Experiment loaded — DevTools Elements, or **Application »» Cookies »» VWO cookies** + screenshot | `getBodyClasses`, `screenshotWithCookies` |
| 5 | **Experiment Name** & **Experiment Value** cookies present and correct + screenshot | `cookieHoldsValue`, `readSpzCookie` |
| 6 | Experiment # and variant name match the testing tool **and Asana** | assertions use real platform values; Asana is human |
| 7 | Every in-scope squeeze page's hidden field captures the flowthrough cookie — **both** direct entry **and** after visiting other pages | the `flowthroughDestination` assertions in the downfunnel specs |
| 4.1 | On squeeze pages, **two** experiments: the page-specific test **and** the always-on **Web Rollout** | `web-rollout-script.js` + `experiment-script.js`; `generateWebRolloutScript()` |
| 5.1 | **Only** flowthrough values persist in the cookie across squeeze pages — a squeeze page's value must **not** transfer to another squeeze page | web-rollout carry rules; flowthrough specs |
| 8 | **Order** of values in the cookie matches the order exposed, **and** the same order in the hidden field | rollout merges cookie values as the base list, current page last |
| 9 | A flowthrough page that also has a form must carry its value into that form **and** the next form | `isFlowthrough: true` → destination hidden field |
| 10 | **Submit** and verify the hidden field values pass in the form **payload**, in order + screenshot | submit specs — **gated** (`SUBMIT_DRY` / `SUBMIT_LIVE`) |

**Stage 2 — POST-LAUNCH:** confirm launched for **all traffic** (soft-launch
limitation removed), re-answer the pre-flight questions (has true control been
updated? — ask PM/AD), **repeat steps 4–10**, then post the checklist link in
the comments and **assign the Live QA task to Honeyfer Amancio**.

> **Order vs inclusion.** Step 8 of this checklist cares about exact token
> *ordering* (setup QA). The suite's regression assertions deliberately use
> token-aware `includes` instead, because sibling tests append tokens to the
> same comma-joined field. Don't "fix" one with the other.

### Part B — hidden-value rules (dev guide)

The dev's behavioural spec for downfunnel values — condensed here, full detail
in Part B of the reference. Highlights:

**Field renames.** `HiddenFieldValue` → **`ExperimentValue`**, and
`HiddenFieldName` → **`ExperimentName`**. Always validate with the **new**
names. iso already does; `goddard.data.json` still lists the legacy
`HiddenFieldValue` in `cookieNames` (raise it, don't edit unilaterally).

**Preview vs live.** Not live → verify **cookie values only, in preview links**,
on all non-form test pages. Live → verify the values are **appended to the
form's hidden fields** and match that test's expected configuration.

**Carry rules.**

| Page state | Rule |
|---|---|
| Has a form **and** we're testing on it | **Don't** carry its test name onward — Demo → Trial means Trial's field holds **only** Trial's test |
| **No** form **and** we're testing on it | Carry to **all** forms, tested there or not — in order |
| Has a form but **no CTA direct link** to a form page (**Rule 4**) | **Exception:** nav and footer links **can't** carry hidden values |
| Squeeze page with a form | Retains its own test name, **doesn't** get carried over |
| Long flowthrough page | Tracked on its own form, **and** on a squeeze page's form **only if a path exists** from that page |

**Mechanism — two halves.** (1) every test writes its value to the **cookie**
or to the **`window.squeezePageValue`** variable (the dev guide calls it
`window.squeezePage`); (2) the **web rollout** reads those and appends them to
the CRO field. **Both need the control URLs registered** — a page that never had
a test isn't in the web rollout, so it picks up **no** CRO values.

**Order.** Order holds while the target (squeeze) page stays the same; it
changes when the target page changes.

**Squeeze pages never leak.** Demo → Trial (both forms) → Trial's field has
**only** Trial. Home → Demo (both tested) → **HOME & DEMO, in order**. Home →
Demo → Trial (no test) → Trial's field has **only HOME**: on Home the value
goes to the SPZ cookie, on Demo to the window variable, on Trial the window
variable is empty, so the submit carries just the cookie value.

**Sitewide popup = squeeze page only.** Its test values go **only into its own
hidden field, only while the popup is open**. Opening the popup and then
filling **Quote** must **not** put the popup test into Quote's field.

**Winner = net new.** Variant must beat control on *total* conversions, not
just add popup conversions:

| | Demo | Contact | Signup | Popup | Total |
|---|---|---|---|---|---|
| Control | 20 | 50 | 100 | — | 170 |
| Variant | 15 | 40 | 90 | 25 | **170 → NOT a winner** |

The variant only cannibalised its own forms.

**Popup CRO2 states** (Test Value `1034 variant`) — implemented by
`bamboohr.popup.spec.js` via `popupValues`:

| Scenario | Captured in | CRO2 |
|---|---|---|
| Popup open, conversion **in the popup** | popup's field **only** | `1034 popup open` |
| Popup opened **then closed** | every other form | `1034 popup opened & closed` |
| Popup **never opened** | every other form | `Popup didn't open` |

Control is **not just Contact Us** — `[1034 Control]` must land on **Demo,
Contact and Signup**.

---

## Adding a new test case

1. Confirm the real activation (cookie / query param / exp number) and the real
   CRO field with a **read-only probe** first — never assume the config is right.
   Write it to Temp, delete it after.
2. Edit the client's `.data.json` via the config UI (keeps a `.bak`), or by hand.
3. Write the spec in `tests/<client>/`, reusing that client's
   `abtest.helpers.js`. Gate any submission behind `SUBMIT_DRY`/`SUBMIT_LIVE`
   and `test.skip` when neither is set.
4. `npx playwright test --list` to verify it is discovered and parses.
5. Run `SUBMIT_DRY` to validate mechanics end-to-end (no submission).
6. Ask before any `SUBMIT_LIVE` run.

### Reusable helpers (`abtest.helpers.js`)

`loadBucket` (retry until the target bucket lands), `activateVariant`,
`setCookieDirect`, `acceptCookies`, `gotoAndWait`, `logStep`,
`getHiddenFieldValue`, `waitForFormField`, `fieldHoldsValue`, `cookieHoldsValue`,
`assertHiddenFields`, `getBodyClasses`, `assertBodyClass`, `waitForBucketSignal`,
`screenshotWithCookies`, `resolveSubmitPages`, `resolveSubmitBuckets`,
`findOwningTarget`.

Signatures worth remembering:

```js
loadBucket(page, targetBucket, url, cookieScript, buckets, valueFieldName, formSelector, maxAttempts = 10)
waitForFormField(page, formSelector, fieldName, { timeout = 30000, scrollInterval = 2000 })
getHiddenFieldValue(page, fieldName, formSelector)
screenshotWithCookies(page, label, hiddenFields, formSelector, screenshotsDir, overlay)
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Bucket never lands | Sticky session — wipe cookies *and* storage each attempt |
| Body class right, value wrong (or vice versa) | The two signals land at different times — poll for both |
| Click times out on a visible element | Covered by `<main>` / mega menu → `element.click()` |
| `querySelectorAll` SyntaxError | `:visible` leaked into `evaluate` — strip it first |
| Evidence screenshots vanished | They were under `test-results/` — use the client's `screenshotsDir` |
| Second run reports weird empty results | Two Playwright processes ran at once and wiped `test-results/` |
| `--list` fails | Syntax/import error in a spec — fix before any network run |
