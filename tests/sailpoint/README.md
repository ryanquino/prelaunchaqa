# SailPoint A/B Test – Down-Funnel QA

## Files

```
tests/sailpoint/
├── config/
│   └── sailpoint.config.js        ← Edit this for each new test
├── helpers/
│   └── abtest.helpers.js          ← Reusable utilities (don't need editing)
├── sailpoint.downfunnel.spec.js   ← Main journey tests
├── sailpoint.popup.spec.js        ← Sitewide popup tests
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

Only `config/sailpoint.config.js` needs updating:

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
