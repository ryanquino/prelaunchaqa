# BambooHR A/B Test – Down-Funnel QA

> **Template client.** Every URL / value / class in `config/bamboohr.config.js`
> is a placeholder — fill them in for your test and the specs run as-is.

## Files

```
tests/bamboohr/
├── config/
│   └── bamboohr.config.js        ← Edit this for each new test
├── helpers/
│   └── abtest.helpers.js         ← Reusable utilities (copy of the SailPoint
│                                   helpers — clients are self-contained)
├── bamboohr.downfunnel.spec.js   ← Main journey tests
├── bamboohr.popup.spec.js        ← Sitewide popup tests
├── bamboohr.flowthrough.spec.js  ← Flowthrough bucket diagnostic
└── README.md
```

---

## How to run

```bash
# Down-funnel journeys only
npm run test:bamboohr

# Sitewide popup scenarios only
npm run test:bamboohr:popup

# Everything
npm run test:bamboohr:all

# Open HTML report after a run
npm run report
```

---

## Setting up a new test

Only `config/bamboohr.config.js` needs updating:

| Field | What to change |
|---|---|
| `testId` / `testName` | Test identity (e.g. `BHR_1034`) |
| `cookieScript` | **Prelaunch:** paste the exact console snippet from dev. **Postlaunch (live): leave empty `''`** — nothing is injected, the suite observes whatever bucket live traffic gets |
| `buckets.*` | Every bucket of the test. Each entry has `label`, `bodyClass` ('' when none) and `expectedValue`. One test runs per bucket (variantA, variantB…, control) |
| `hiddenFields` | Names of the CRO hidden inputs your test fills |
| `popupValues.*` | Only for the sitewide popup test — `popupOpen`, `popupOpenClosed`, `popupDidntOpen`. Leave blank to skip the popup spec |
| `pages.*` | Update URLs / form selectors to BambooHR's real pages. Mark **one or more** pages `isUnderTest: true` |

---

## Prelaunch vs Postlaunch

The value of `cookieScript` switches the whole suite between the two phases:

| Phase | `cookieScript` | What the suite does |
|---|---|---|
| **Prelaunch** (test not yet live) | filled in with the dev snippet | Injects the snippet to activate the test, then forces **both** variant and control and verifies each bucket's carry-over |
| **Postlaunch** (live) | empty `''` | Injects nothing — each fresh navigation gets whatever bucket live traffic gets (~50/50). The retry loop still lands on both buckets, then verifies carry-over |

No other config changes needed to switch phases — just fill in or blank out `cookieScript`.

---

## Down-funnel carry-over rules (summary)

| Page type | Has form? | Value carries to next form? |
|---|---|---|
| Flowthrough (e.g. Homepage) | ❌ | ✅ Yes – via the SPZ value cookie |
| Form page (e.g. Demo) | ✅ | ❌ No |
| Sitewide popup | ✅ | ❌ Never – popup stays isolated |

### Popup CRO2 values (template)

| Scenario | CRO2 value |
|---|---|
| Conversion happened inside popup | `… popup open` |
| Popup opened then dismissed | `… popup opened & closed` |
| Popup never opened | `Popup didn't open` |
