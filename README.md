# prelaunchaqa

Config-driven pre-launch A/B test QA suite built on [Playwright](https://playwright.dev).
One repo verifies the full funnel for every client: bucket activation → value carry
through the page journey → CRO hidden-field population → (optionally) a real form
submission — all driven by a JSON config per client and a small local web UI for
editing it.

## Clients

| Client | Playwright project | Config | Specs |
|---|---|---|---|
| SailPoint | `sp` | `tests/sailpoint/config/sailpoint.data.json` | downfunnel, flowthrough, popup, config contracts, submit |
| InsightSoftware | `iso` | `tests/insightsoftware/config/insightsoftware.data.json` | downfunnel, config contracts, submit |
| BambooHR | `bhr` | `tests/bamboohr/config/bamboohr.data.json` | downfunnel, popup |
| ConnectWise | `cw` | `tests/connectwise/` | conversion |
| Goddard | `goddard` | `tests/goddard/config/goddard.data.json` | downfunnel (postlaunch, observed buckets) |

## Setup

```bash
npm install
npx playwright install chromium
```

## Config UI (the single editor for all configs)

```bash
npm run config:ui        # → http://localhost:4173
```

The UI edits each client's `.data.json` directly (a `.bak` is written on every
save) and offers:

- **Validate** — runs the client's config-contract spec (fast, read-only).
- **Run downfunnel** — runs the funnel journey spec read-only.
- **Run submission** — live submit, opt-in only (see [Submission safety](#submission-safety)).
- **Tests — last run** panel — pass/fail/skip status of the most recent run.

Unsaved edits are persisted automatically before Validate/Run, because the specs
always read the config **from disk**.

> Note: `index.html` changes are picked up on reload; changes to `server.mjs`
> need the server restarted (kill the listener on port 4173, then start it again).

## Running tests

```bash
npm run test:sailpoint        # SailPoint downfunnel
npm run test:sailpoint:popup  # SailPoint sitewide popups
npm run test:sailpoint:all    # everything in tests/sailpoint/
npm run test:bamboohr         # BambooHR downfunnel (headed)
npm run test:bamboohr:popup
npm run test:bamboohr:all
npm run test:iso              # InsightSoftware downfunnel + config contracts
npm run test:iso:all          # everything in tests/insightsoftware/
npm run test:cw               # ConnectWise conversion
npm run test:cw:all
npm run test:goddard          # Goddard downfunnel
npm run test:config-ui        # config-UI smoke test
npm run report                # open the Playwright HTML report
```

Direct invocation (any project/spec/flag combination):

```bash
npx playwright test --project=iso --list          # dry discovery, no run
npx playwright test --project=iso tests/insightsoftware/insightsoftware.downfunnel.spec.js
```

Runs are **sequential** (`workers: 1`, `fullyParallel: false`) so funnel journeys
and session cookies stay isolated. Never run two Playwright processes at once —
each run wipes `test-results/`.

## How a downfunnel run works

Every client config declares **pages** (flags: `isUnderTest`, `isFlowthrough`,
`isSqueezePage`, `formSelector`) and **tests** (experiment, buckets, destinations).
`resolvePlan` / `resolveTestPlans` turn that into concrete page sets; the spec then:

1. **Forces the bucket** on the page under test (prelaunch cookie script /
   VWO combi) and asserts the bucket signal (body class, hidden-field value,
   or value cookie — whichever the client uses).
2. **Walks the form pages** the config lists, asserting the df/CRO value is in
   the hidden field on each (comma-aware contains — sibling experiments share
   the field).
3. **Walks `flowthroughPages` waypoints** (optional): intermediate *no-form*
   pages visited **in the configured order**, asserting the value survives each
   hop via the value cookie, with evidence screenshots.
4. **Lands on the waypoint terminal** — a squeeze page under test if one
   exists, otherwise the **first selected `flowthroughDestination`** — and
   asserts the value is appended in the hidden field after the full journey.
5. **Sweeps the selected `flowthroughDestination` form pages** — exactly the
   ticked pages, asserting cookie + hidden-field carry (flowthrough tests) or
   asserting the value does *not* carry (form-page tests).

Unknown/ineligible `flowthroughPages` keys are **warned and skipped**, so a
stale waypoint can never fail a run.

## Submission safety

The submit specs fire **real leads** and are strictly opt-in:

| Flag | Effect |
|---|---|
| *(none)* | Spec is discovered but **skipped** — read-only by default |
| `SUBMIT_DRY=1` | Fill the form + screenshot, **never click submit** (wins over LIVE) |
| `SUBMIT_LIVE=1` | Fire real submissions |
| `SUBMIT_PAGES=demo,pricing` | Override the config's submit target pages |
| `SUBMIT_BUCKETS=variant` | Override the config's submit bucket |

A run fires **exactly one lead** (the configured bucket on the first ticked
target page). The UI's "Run submission" button passes these flags for you and
requires ticking the "fires real leads" checkbox.

```powershell
# PowerShell — safe dry run, no lead
$env:SUBMIT_DRY = '1'; npx playwright test --project=iso tests/insightsoftware/insightsoftware.submit.spec.js
```

Test data is the mandated QA lead (see each submit spec's header) —
`ryan+test@spiralyze.com` and friends, never a real customer.

## Artifacts

| Path | Contents |
|---|---|
| `screenshots/cookies`, `screenshots/insightsoftware-cookies`, `screenshots/goddard-cookies` | Persistent per-step evidence (never wiped) |
| `test-results/` | Playwright traces/videos/failure shots — **wiped every run** |
| `playwright-report/` | HTML report (`npm run report`) |
| `tests/config-ui/runs/<client>.json` | Last-run status for the UI panel |

Failures always keep a trace — open it with the `npx playwright show-trace …`
hint Playwright prints on failure.

## Client-specific docs

- [tests/sailpoint/README.md](tests/sailpoint/README.md) — SailPoint test setup

## Notes

- **Cloudflare**: default headless Chromium is blocked (HTTP 403); the config
  disables the automation fingerprint and sends a real Chrome UA.
- **ConnectWise**: set `CW_PROXY` to a US-exiting proxy when the rollout is
  geo-gated and the machine's IP is non-US.
- **Goddard** is postlaunch: buckets are *observed* live from cookies, nothing
  is injected.
- Config contract tests (`*.config.spec.js`) are the fast safety net — they
  validate ownership, waypoint, destination and bucket rules without touching
  the network.
