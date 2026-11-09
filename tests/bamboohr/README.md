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
├── bamboohr.submit.spec.js       ← Live form submission (opt-in flags)
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
| `cookieScript` | **Phase marker, not a snippet** — keep `/* prelaunch — test loads via ?spz-qa=true on page URLs */` while the test is prelaunch (runs are labelled PRELAUNCH); blank it to `''` once the test is live (labelled LIVE/postlaunch). The test itself always loads from the `?spz-qa=true` param on **every page URL** (it buckets variant or true control at random; the suite observes and retries until each is seen) |
| `buckets.*` | Every bucket of the test. Each entry has `label`, `bodyClass` ('' when none) and `expectedValue`. One test runs per bucket (variantA, variantB…, control) |
| `hiddenFields` | Names of the CRO hidden inputs your test fills |
| `popupValues.*` | Only for the sitewide popup test — `popupOpen`, `popupOpenClosed`, `popupDidntOpen`. Leave blank to skip the popup spec |
| `pages.*` | Update URLs / form selectors to BambooHR's real pages. Mark **one or more** pages `isUnderTest: true` |

---

## Prelaunch vs Postlaunch

BambooHR has **no activation cookie script** — what activates the test is the
**`?spz-qa=true` query param on every page URL**: the site loads the experiment
and buckets the session either variant or true control at random. Since the
suite derives the phase from `cookieScript`, that field doubles as a **phase
marker** (a JS comment — valid no-op code, so the prelaunch branch can eval it
without a syntax error):

| Phase | `cookieScript` | What the suite does |
|---|---|---|
| **Prelaunch** (test not yet live) | `/* prelaunch — test loads via ?spz-qa=true on page URLs */` | Labels runs **PRELAUNCH**; the param activates the test, each fresh navigation re-buckets ~50/50, and the retry loop converges on **both** buckets before verifying each bucket's carry-over |
| **Postlaunch** (live) | empty `''` | Labels runs **LIVE (postlaunch)**; same observe mode — live traffic buckets the session; the param is harmless and can stay on the URLs permanently |

Blank the marker to switch phases — no other config changes needed. Keep
`?spz-qa=true` on every `pages.*.url`.

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
