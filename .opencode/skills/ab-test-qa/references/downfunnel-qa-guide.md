# Downfunnel QA Guide — Setup Checklist + Hidden-Value Rules

Two sources, one guide:

- **Part A — the setup checklist.** Google Sheet **"STATUS OF DOWNFUNNEL SET UP
  – AQA HIDDEN FIELDS"** (`gid=854885424`). The *process* the team runs when
  QAing a test's downfunnel setup — broader than this suite: prerequisites, the
  A/B platform, GA and Asana are all human steps. Each step is ticked `FALSE` →
  `TRUE` in the sheet, with the answer written into **QA Remarks**.
- **Part B — the hidden-value rules.** The dev guidelines for **rolling out new
  Down Funnel updates across all current and upcoming task builds**. The
  *behavioural spec* — what the hidden values are actually supposed to do.

**Read Part B before judging a carry or popup failure as a bug** — it defines
what "correct" means; Part A is how you verify it.

> **Scope note.** Steps 4–10 of Part A are the technical core. This suite
> automates most of them; the "Suite" annotation under each step says where.

---

# PART A — Setup checklist

## Stage 1 — PRE-LAUNCH

### 1. Prerequisites

Confirm these before starting:

1. You know the **method(s) of tracking** used in the test and have confirmed
   it with the AD / PM / Project Analyst.
2. **Access to the testing tool** and links to the experiments you're QAing.
3. **Access to GA** (or any TF analytics tool).
4. A **working VPN**, in case the test runs only for US traffic.

> For other downfunnel tracking methods, ask the AD, Project Analyst & FE for
> the checklist.

**Suite:** nothing automated — this is human setup.

### 2. Soft-launch

- **2.** Confirm the test is in **Soft-Launch mode** — either through a UTM
  param or limited to QA countries.
- **2.1** Ensure the **AQA prefix** is added to the test name on the A/B
  testing platform:

  ```
  [AQA] - #XXXX | Client | Page | Test Name
  ```

**Suite:** nothing automated. The `?spz-qa=true` / `spz-qa` activation this
suite uses *is* the QA-country equivalent for sp/bhr.

### 3. Pre-flight questions — write the answers in QA Remarks

1. **How many variants** in the test, and the **name of each variant**?
2. **Is true control a copy of the original, or a winner of a previous test?**
   — *IMPORTANT.* Often this shows in test updates: the true control is updated
   in the test.
3. **What's the name of the experiment cookies** we're using to capture
   experiment data?
4. **Where is the test running**, so that you know where to check?

> **For flowthrough pages, confirm:** *(the sheet breaks out into step 4–7
> below)*

**Suite:** steps 1–3 map to the config — `buckets[].label`,
`buckets[].bodyClass` (`''` = a true control that adds no class), and
`hiddenFields` / `cookieNames`. The config-contract spec
(`*.config.spec.js`) enforces that every bucket carries an `expectedValue`.

### 4. Experiment loaded

Check that the experiment **loaded** — you should see it in the **Elements
tab** of Chrome DevTools.

> Alternatively navigate to **Application »» Cookies »» Website »»** and look
> for **VWO cookies**. **Take a screenshot.**

**Suite:** `getBodyClasses` / `assertBodyClass` + `screenshotWithCookies`
(evidence lands in the client's `screenshotsDir`, never `test-results/`).

### 5. Experiment Name & Experiment Value cookies

**Experiment Name** and **Experiment Value** cookies are present and populated
with the correct test values »» **Application »» Cookies »» Website url**.

> **Take a screenshot.**

**Suite:** `cookieHoldsValue` / `readSpzCookie`. The config's `cookieNames`
(goddard: `ExperimentName`, `ExperimentValue`, `HiddenFieldValue`,
`Experiment`) lists what to read.

### 6. Experiment # & variant name match

Experiment # and variant name **match with the testing tool and Asana**.

**Suite:** the assertions use the platform's real value strings
(`SPZ_<id>_variant`, `spz_<id>_control`, …), so a mismatch fails the spec — but
the *Asana* half is a human check.

### 7. Hidden field captures values from the cookie — both entry paths

The **hidden field of all squeeze pages in scope** is capturing experiment
values from the cookie »» check **BOTH** cases:

- going to the squeeze page **DIRECTLY**, and
- **after visiting other pages**.

> This means: confirm the squeeze pages a user visits and could convert on
> capture the values of the **flowthrough** pages from the stored cookies.
> e.g. a flowthrough page like **Home** should be tracked in **all** squeeze
> pages like Demo, Trial, Pricing… — every High Value Squeeze user could
> convert on.

**Suite:** this is exactly what `sailpoint.downfunnel.spec.js`,
`insightsoftware.downfunnel.spec.js` and `bamboohr.downfunnel.spec.js` assert
via `flowthroughDestination` + `fieldHoldsValue`.

---

### For SQUEEZE pages, confirm

#### 4.1 Experiment loaded — two experiments

You should see **two** experiments: one for the **page-specific test**, and
another for the **web rollout**.

> **Web Rollout is always running on squeeze pages**, to inject values of other
> experiments into the same hidden field.

**Suite:** `insightsoftware/scripts/web-rollout-script.js` (writes `CRO1`) and
`experiment-script.js` are the two scripts; `generateWebRolloutScript()` in the
iso helpers injects the rollout during A/A runs.

#### 5.1 Only FLOWTHROUGH values persist in the cookie

Check that **ONLY flowthrough experiment values** persist in the cookie upon
navigating to other pages:

> Navigate to another **squeeze page** »» check the cookie and the hidden field
> value »» confirm **ONLY the flowthrough page's experiment exists**.
>
> - A **squeeze page's value should NOT transfer to another squeeze page**.
> - **Take a screenshot.**

**Suite:** the carry-over rules are implemented in the web rollout — *form →
form: only the new form's `squeezePageValue` is set; stale cookie values from
the prior form are overwritten.* The flowthrough specs assert this.

---

### For ALL pages, confirm

#### 8. Order of values matches

The **order** of the experiment values in the cookie matches the order of the
experiments you were exposed to, **and the same order in the hidden field**.

> **Take a screenshot.**

**Suite:** the web rollout merges *cookie values as the base list*, appending
the current page's own slot **last**. Note the distinction:

- **Setup QA (this checklist):** order matters — assert exact ordering.
- **Regression assertions in this suite:** token-aware `includes`, never string
  equality, because sibling tests append tokens.

#### 9. Flowthrough page with its own form

If the flowthrough page also has a **form**, the flowthrough's values should be
placed in a hidden field **in this form**, and **another** in the other form
the user navigates to.

> Example: `https://candelamedical.com/` — test values for the homepage belong
> in the homepage form's hidden field **and** the product page form too.

**Suite:** `isFlowthrough: true` pages carry the value to their
`flowthroughDestination`; the specs assert the destination's hidden field.

#### 10. Submit and verify the payload

**Submit the form** and confirm the hidden field values pass in the form
**PAYLOAD**, in the same order, before submission:

> Inspect the form »» confirm the hidden field has the right experiment values
> »» open the **Network tab** »» submit the form with **test data** »» check the
> form payload and confirm the hidden field is filled as expected.
>
> **Take a screenshot.**

**Suite:** the submit specs. **Gated — see the rules in `SKILL.md`:**
`SUBMIT_DRY=1` fills + screenshots and never clicks;
`SUBMIT_LIVE=1` fires one real lead and captures the `save2` payload
observe-only. Never run live without explicit user approval.

---

## Stage 2 — POST-LAUNCH

### 1. Launched for all traffic

Confirm the test is launched for **all traffic** — i.e. the soft-launch
limitation is removed (no longer running only for India, etc.).

### 2. Pre-flight questions — write the answers in QA Remarks

1. **How many variants** in the test, and the **name of each variant**?
2. **Confirm whether true control has been updated?** — *ASK THE PM/AD.*

### 3. Repeat steps 4–10

Run the whole technical block again against the live test.

### 4. Handoff

Once done with Post-Launch AQA:

1. Mention the **checklist link** in the comments section.
2. **Assign the Live QA task to Honeyfer Amancio.**

---

## Prepared By / Date

Fill in at the bottom of the sheet when the pass is complete.

---
---

# PART B — Hidden-value rules (dev guide)

## B1. Field name updates (renames)

| Legacy name | Renamed to |
|---|---|
| `HiddenFieldValue` | **`ExperimentValue`** |
| `HiddenFieldName` | **`ExperimentName`** |

**QA should always validate using the updated field names going forward.**

**Suite:** iso already uses the new names
(`hiddenFields.experimentName` / `experimentValue`).
**Open item:** `tests/goddard/config/goddard.data.json` still lists the legacy
`HiddenFieldValue` in `cookieNames` alongside the new names — worth raising
with the team, but do **not** edit it unilaterally (config JSONs carry the
user's uncommitted changes).

---

## B2. Preview vs Live testing

**When the test is NOT live:**
- QA can verify **cookie values only in the preview links**.
- This applies to **all non-form test pages**.

**When the test IS live:**
- QA needs to verify that the correct values are properly **appended to hidden
  fields in the form**.
- Ensure the values **match the expected configuration for that specific test**.

**Suite:** this is the prelaunch/postlaunch split already in the config —
a filled `cookieScript` = prelaunch (observe the assigned bucket), empty `''`
= postlaunch/live.

---

## B3. Carry rules

### Rule 4 — the exception

> A **squeeze page** can't be stored in CRO1 or the hidden field if it has **no
> CTA direct link** to form pages. **Navigational links and footer links can't
> carry hidden values to the next form** — this is the exception rule.

### Conclusion — the general rules

1. **Page has a form AND we're testing on it → don't carry its test name to
   another page.**
   - e.g. user goes from **Demo [form]** to **Trial [another form]** → the
     hidden field should have **only the trial page test name**.
2. **Page has NO form AND we're testing on it → carry over the test name to
   ALL FORMS**, irrespective of whether we're testing on them or not.
   - Home → Demo, testing on **both** → hidden field has **HOME & DEMO**, in
     order.
   - Home (tested) → Trial (**not** tested) → still put the **homepage** test
     value in the trial hidden field.
   - Home (tested) → Demo (tested) → Trial (**not** tested) → the Trial hidden
     field captures **only the HOME value**.
     - *From the dev's point of view:* on Home the test value is added to the
       **SPZ cookie**; on Demo the cookie is added to the **window variable**
       (`window.squeezePage`); on Trial no test runs, so the window variable is
       cleared and empty. Submitting the Trial form therefore carries **only
       the SPZ cookie value** = the homepage value.
3. **Page has 2 buttons — one opens a form on-page, one goes to Demo** (e.g.
   pricing) → the **Demo form should track both pricing & demo**.

### Restated

- **Squeeze pages with forms** retain their test names and **don't** get
  carried over.
- **Pages without forms** get their values carried over to the next form.
- **Long flowthrough pages** are always tracked on their own forms, **and** on
  the form of a squeeze page **if there is a path to get there from that
  page**.

**Suite:** `isFlowthrough: true` (carry) vs `isSqueezePage: true` (retain,
don't carry) are the config flags; the `flowthroughDestination` assertions in
the downfunnel specs are the automated form of these rules.

---

## B4. How the mechanism works — 2 ways

1. **Add the value to the cookie, or to the `window.squeezepage` variable** —
   this is done in **every** test.
2. **The web rollout** picks up these values and **appends them to the CRO
   field**.

**Both of the above require the control URLs to be added** (home, demo, trial,
etc.). If the trial page never had a test, it would **not** be added to the web
rollout, and then it **won't pick up any CRO values**.

**Suite:** `tests/insightsoftware/scripts/web-rollout-script.js` is mechanism 2
— it reads `window.squeezePageValue` + the `ExperimentValue` cookie and writes
the comma-joined result into `CRO1`. Note the naming difference: the guide says
`window.squeezePage`, the deployed script reads **`window.squeezePageValue`**.

---

## B5. Order rules

> If all pages are flowthrough, the **order will not change** if the target
> pages are the same. The order **would change once the target page (squeeze
> page) changes**.

*(reference screenshot: https://prnt.sc/17e2Ziwcoj9K)*

**Suite:** see the order-vs-inclusion note in Part A step 8 — setup QA asserts
exact ordering; regression assertions use token-aware `includes`.

---

## B6. UPDATE — sitewide popup is a squeeze page only

> The **sitewide popup remains squeeze-page-only** and should **not** carry to
> other forms. Sitewide popup forms should get the test values added **ONLY to
> their own hidden fields, only when the popup form is open.**
>
> *(let's imagine the popup form is **Demo**)*
>
> - User goes to **Quote** and fills a form → the Quote form **shouldn't** have
>   the popup form's test.
> - User lands on **home**, opens the **popup**, then goes to **Quote** and
>   fills a form → the Quote form **shouldn't** have the popup form's test.

**Suite:** `sailpoint.popup.spec.js` / `bamboohr.popup.spec.js`.

---

## B7. Winner math — net-new conversions

> The goal of the test is to add **new** conversions, **not** to convert users
> who would have converted anyway. To measure that accurately we need to track:
>
> - **Control conversions** = every **Demo, Contact & Signup** form fill
> - **Variant conversions** = every Demo, Contact & Signup form fill **+
>   additional conversions from the popup**
>
> **Winner** = variant conversions in total **bigger than** control's.

**Example — a variant that is NOT a winner:**

| | Demo | Contact | Signup | Popup | Total |
|---|---|---|---|---|---|
| Control | 20 | 50 | 100 | — | **170** |
| Variant | 15 | 40 | 90 | 25 | **170** |

**VARIANT IS NOT A WINNER** — even though it got conversions, it didn't add net
new; it just took them away from the other forms.

---

## B8. Popup tracking — the exact CRO2 states

### Variant

| Scenario | Where the value is captured | Expected **CRO2** value |
|---|---|---|
| Popup **open** and the conversion happens **in the popup** | The **popup's** hidden field only — **not any other form** | `1034 popup open` (confirms the conversion came from the popup, not a form) |
| Popup **opened then closed** | **Every other form** — Demo, Contact, Signup | `1034 popup opened & closed` |
| Popup **didn't open at all** | **Every other form** — Demo, Contact, Signup | `Popup didn't open` |

*(in all three rows the Test Value is `1034 variant`.)*

### Control

> Control in this experiment is **not just the contact us page** — it's
> **demo, contact and signup**. The test value `[1034 Control]` should be
> captured by **Demo, Contact us page and signup**.

**Suite:** `bamboohr.popup.spec.js` already implements these three states via
the config's `popupValues`:

| Config field | Scenario |
|---|---|
| `popupValues.popupOpen` | conversion inside the open popup |
| `popupValues.popupOpenClosed` | popup opened, then closed |
| `popupValues.popupDidntOpen` | popup never opened |

and it asserts CRO2 → `ExperimentValue`. The hero-form scenario (no popup at
all) asserts CRO2 holds the plain bucket value.
