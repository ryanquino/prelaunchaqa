# SPZ #3021 — Down-funnel carry evidence (QA → Dev)

**Date:** 2026-11-23
**Test:** SPZ_3021 (identitySecurity is the under-test squeeze page; destinations: Demo, Contact Us)
**Activation:** `spz-qa2` (prelaunch snippet) — same cookie QA uses manually
**Verdict in one line:** the down-funnel value lands on Demo/Contact Us in the **variant** bucket but **never** in the **true-control** bucket — even though the control cookie is set correctly.

---

## 1. What the suite reported

Two runs, one per bucket (fresh browser context each, `spz-qa2` set, storage wiped, bucket forced):

| Run | Terminal (Demo waypoint) | Destination: Contact Us | Destination: Demo |
|---|---|---|---|
| **variantA** | ❌ `must contain "SPZ_3021_variant" — got "null"` (field not mounted at read time) | ✅ value present | ❌ field empty/absent |
| **control** | ❌ `must contain "SPZ_3021_truecontrol" — got "SPZ_#2000_TrueControl,SPZ_2025_variant,SPZ_#1000_TrueControl,SPZ_1026_truecontrol"` | ❌ `cookie carried but field was empty/absent` | ❌ `cookie carried but field was empty/absent` |

Failure artifacts: `test-results/sailpoint.downfunnel-CONTR-…` and `test-results/sailpoint.downfunnel-VARIA-…` (trace.zip + video.webm + error-context.md each).

## 2. Screenshots from the runs (bucket-at-a-glance)

`intellimize1` on **/contact-us** at assertion time:

| Bucket | `intellimize1` value | Screenshot |
|---|---|---|
| **variantA** | `SPZ_#2000_TrueControl,SPZ_2025_truecontrol,SPZ_#1000_Variant,SPZ_#9000_TrueControl,SPZ_9012_truecontrol,`**`SPZ_3021_variant`** | `screenshots/cookies/8_contact_us_variantA_2026-11-23T02-57-29-463Z.png` |
| **control** | `SPZ_#2000_TrueControl,SPZ_2025_variant,SPZ_#1000_TrueControl,SPZ_#9000_Variant,SPZ_9012_truecontrol` — **no 3021 token** | `screenshots/cookies/8_contact_us_control_2026-11-23T02-58-29-244Z.png` |

Note the field is **not empty** in the control run — it holds 5 other tests' values. Ours is the only token missing.

## 3. Why manual testing shows it (and the run doesn't)

The manual browser session that "shows it" is in the **variant** bucket
(`…SPZ_3021_variant` in the screenshots taken by hand). The failing assertion
asks for `SPZ_3021_truecontrol`. Bucket-for-bucket, manual and automated agree:
**variant carries, control doesn't.**

## 4. Reproduction probes (read-only, fresh headless contexts, `spz-qa2` injected exactly like the suite)

| # | Experiment | Result |
|---|---|---|
| P1 | Control bucket → open /contact-us and /demo, poll `intellimize1` every 1 s for 45–60 s | Field populates within 1 s with other tests' values. `ExperimentValue=SPZ_3021_truecontrol` cookie present. **Our token never appears** (0/60 s). |
| P2 | Variant bucket → same journey | Token appended within **2–4 s** on both /demo and /contact-us. |
| P3 | Variant bucket → **delete** `ExperimentValue` (and `HiddenFieldValue*`) cookies before opening /contact-us | Token **does not appear** → the destination reads the carried value from the `ExperimentValue` cookie. |
| P4 | Control bucket → **rewrite** `ExperimentValue` to `SPZ_3021_variant` before opening /contact-us | Token **still does not appear** → the append is not driven by the cookie value alone; it is gated on the session being in the **variant** arm. |

Conclusion: the destination-side append only fires for the variant arm.
A true-control session has `spz-qa2`, has the correct `ExperimentValue` cookie,
renders the form with everyone else's values — and is never appended.

## 5. Two separate issues found

1. **Site behavior (needs a dev decision):** true control never gets its token
   into the destination `intellimize1`. Per the down-funnel rule *"Control must
   land on Demo, Contact and Signup"*, control is expected to land too. Either
   the destination script intentionally skips true control (then the QA
   expectation should be relaxed and documented), or control carry is broken.
2. **Suite observation flakiness (our side, fixable):** in the variant run the
   **/demo** form field read came back `null` — the Marketo form on /demo mounts
   late/lazily and the read happened before it existed. That failure is a
   timing issue, independent of the control-carry gap.

## 6. Side finding (failure-message accuracy)

The destination failure text says *"field was empty/absent"* even when the
field is populated with other tests' values. The message should echo the actual
field value so reports like this one don't have to reconstruct it from
screenshots.

## 7. Questions for the dev team

1. Should `SPZ_3021_truecontrol` appear in the destination `intellimize1`
   fields (Demo / Contact Us), the way `SPZ_3021_variant` does?
2. If yes: what carries it? Probe P4 shows rewriting the `ExperimentValue`
   cookie to the variant token in a control session still doesn't append — so
   the gate is bucket-based, not cookie-value-based. Where does that gate live
   (destination script / Kameleoon / Intellimize)?
3. If no (control is cookie-only by design): please confirm, and QA will relax
   the destination/terminal field assertions for buckets with no body class.

## 8. Artifacts

- Run screenshots: `screenshots/cookies/` (7–8 Nov-23 files, both buckets)
- Playwright traces + videos: `test-results/sailpoint.downfunnel-{CONTR,VARIA}-*/`
- Config under test: `tests/sailpoint/config/sailpoint.data.json` (testId 3021)
