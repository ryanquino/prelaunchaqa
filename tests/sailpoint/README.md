# SailPoint A/B Test – Down-Funnel QA

## Files

```
tests/sailpoint/
├── config/
│   ├── sailpoint.data.json        ← Config data (edit via `npm run config:ui`)
│   └── sailpoint.config.js        ← Loader — re-exports the JSON as TEST_CONFIG
├── helpers/
│   ├── abtest.helpers.js          ← Reusable utilities (don't need editing)
│   └── payload-screenshot.js
├── sailpoint.downfunnel.spec.js   ← Main journey tests
├── sailpoint.flowthrough.spec.js  ← Flowthrough waypoint tests
├── sailpoint.popup.spec.js        ← Sitewide popup tests
├── sailpoint.contactus.spec.js    ← #9012 Contact Us journey
├── sailpoint.submit.spec.js       ← Live form submission (opt-in flags)
├── sailpoint.config.spec.js       ← Config contract tests (fast, offline)
└── README.md
```

---

## How to run

```bash
# Down-funnel journeys only
npm run test:sailpoint

# Sitewide popup scenarios only
npm run test:sailpoint:popup

# Everything
npm run test:sailpoint:all

# Open HTML report after a run
npm run report
```

---

## Setting up a new test

Only `config/sailpoint.data.json` needs updating — edit it through
`npm run config:ui` (a `.bak` is written on every save) or by hand;`sailpoint.config.js` just loads the JSON as `TEST_CONFIG`:

| Field | What to change |
|---|---|
| `testId` | Test number (e.g. `1034`) |
| `testName` | Friendly label for the test |
| `cookieScript` | **Prelaunch:** paste the exact console snippet from dev. **Postlaunch (live): leave empty `''`** — nothing is injected, the suite observes whatever bucket live traffic gets |
| `buckets.*` | Every bucket of the test. Each entry has `label`, `bodyClass` ('' when none) and `expectedValue`. One test runs per bucket (variantA, variantB…, control) |
| `popupValues.*` | Only for the sitewide popup test — `popupOpen`, `popupOpenClosed`, `popupDidntOpen`. Leave blank to skip the popup spec |
| `pages.*` | Update URLs / form selectors as needed. Mark **one or more** pages `isUnderTest: true` |

---

## Prelaunch vs Postlaunch

The value of `cookieScript` switches the whole suite between the two phases:

| Phase | `cookieScript` | What the suite does |
|---|---|---|
| **Prelaunch** (test not yet live) | filled in with the dev snippet | Injects the snippet to activate the test, then forces **both** variant and control and verifies each bucket's carry-over |
| **Postlaunch** (live) | empty `''` | Injects nothing — each fresh navigation gets whatever bucket live traffic gets (~50/50). The retry loop still lands on both buckets, then verifies carry-over |

No other config changes needed to switch phases — just fill in or blank out `cookieScript`.

---

## QA activation cookies & the #2044 industry modal

The dev snippet sets one of the `spz-qa*` cookies; each activates a different
test on sailpoint.com:

| QA cookie | Observed effect |
|---|---|
| `spz-qa` | #9012 (plus #2040 / #3018) |
| `spz-qa1` | **#2044** — and the homepage **industry modal** |
| `spz-qa2` | nothing |
| `spz-qa4` | true-control buckets (#9012 / #2040) |

The **industry modal** (`.spz-industry-overlay` + `.spz-industry-modal`) is
part of test #2044 only and is still a candidate — we don't know yet whether
it wins — so the suite must never let it interfere with other tests:

- **Gated by the QA cookie, not storage.** Only `spz-qa1` shows it; a #2044
  visit's Kameleoon storage carried over to another QA cookie does *not*
  re-show it.
- **Homepage-only.** `/contact-us`, `/demo`, `/pricing` and
  `/platform/identity-security` render clean even under `spz-qa1`.
- **Auto-dismissed everywhere.** `dismissSpzIndustryModal(page)` runs on every
  landing (`activateVariant`, `loadBucket`) and every spec navigation
  (`gotoAndWait`). It clicks `.spz-industry-close` first, then strips the
  `spz-modal-open` scroll lock as a fallback — Escape does **not** close this
  modal. Without it the page sets `overflow: hidden` and collapses
  (~1246 px vs ~7990 px), hiding the footer CTA form and making every
  hidden-field read come back `null`.
- **Never submit inside it** — the modal carries
  `spz-industry-submit spz_2044v1 spz_modal_submit`.

---

## Field name reference (post Janak update)

| Old name | New name | CRO slot |
|---|---|---|
| `HiddenFieldName` | `ExperimentName` | CRO1 |
| `HiddenFieldValue` | `ExperimentValue` | CRO2 |

---

## Down-funnel carry-over rules (summary)

| Page type | Has form? | Value carries to next form? |
|---|---|---|
| Flowthrough (e.g. Homepage) | ❌ | ✅ Yes – via SPZ cookie |
| Form page (e.g. Demo) | ✅ | ❌ No – window.squeezePage cleared |
| Sitewide popup | ✅ | ❌ Never – popup stays isolated |

### Bucket stickiness

Kameleoon keeps the bucket in **storage**, not only in cookies — so
`clearSpzStorage` in the helpers wipes *all* `localStorage` / `sessionStorage`
on every landing attempt. With a cookie-only reset the retry loop re-rolled the
same bucket indefinitely (control stayed control across 10 attempts).

### Tabbed form pages (e.g. Contact Us Sales/Support/Locations)

If an under-test form page has `button[role="tab"]` elements, the suite automatically adds a
**tab-persistence** step: it reads the down-funnel value on the form tab, clicks every other tab
(the Marketo form unmounts), returns to the form tab, and asserts the value is still present after
the re-render. No config needed — the check activates by itself.

### Popup CRO2 values

| Scenario | CRO2 value |
|---|---|
| Conversion happened inside popup | `1034 popup open` |
| Popup opened then dismissed | `1034 popup opened & closed` |
| Popup never opened | `Popup didn't open` |
