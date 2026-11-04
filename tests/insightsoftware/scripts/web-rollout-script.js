/**
 * WEB ROLLOUT — Reads experiment cookies and populates CRO1 hidden field
 *
 * Runs on ALL high-intent form pages (squeeze pages) across every product
 * line — not just pages where we have an active test.
 *
 * How it works:
 *   1. Polls every 1 s for up to 15 s (15 attempts) for the hidden field
 *      to appear (handles late-loading SPAs).
 *   2. Reads window.squeezePageValue (set by the experiment script on form
 *      pages with squeezePage = 'both' or true).
 *   3. Reads the ExperimentValue cookie (set by the experiment script on
 *      any page — carries from non-form pages).
 *   4. Merges the two: cookie values form the base list; squeezePageValue
 *      is appended / replaces its own slot so the current page's test
 *      always appears last.
 *   5. Writes the comma-separated result into the CRO1 hidden field.
 *
 * Carry-over rules (handled by the cookie + squeezePageValue interplay):
 *   • Non-form → form:  cookie values carry forward into CRO1.
 *   • Form → form:     only the NEW form's squeezePageValue is set;
 *                       stale cookie values from the prior form are
 *                       overwritten when the new experiment script fires.
 *   • Form (no test) → form (no test):  no cookies, CRO1 stays empty.
 */
var inputFieldSelector = 'input[name="cro1"]';

/***********************************
************************************
DO NOT TOUCH
BEYOND THIS LINE
******************************
******************************/

var hiddenFieldEl = document.querySelector(inputFieldSelector);

function getCookieForHiddenValue(name) {
    var nameEQ = name + "=";
    var cookies = document.cookie.split(';');

    for (var i = 0; i < cookies.length; i++) {
        var c = cookies[i].trim();
        if (c.indexOf(nameEQ) === 0) {
            return c.substring(nameEQ.length);
        }
    }
    return null;
}

function setHiddenField() {
    if (!hiddenFieldEl) return;

    var squeezePageValue = (window.squeezePageValue !== undefined) ? window.squeezePageValue : "";
    var landingPageValue = getCookieForHiddenValue("ExperimentValue") || "";
    var finalList = landingPageValue ? landingPageValue.split(",") : [];

    if (squeezePageValue) {
        finalList = finalList.filter(v => v !== squeezePageValue);
        finalList.push(squeezePageValue);
    }

    var finalValue = finalList.join(",");

    if (finalValue) {
        hiddenFieldEl.value = finalValue;
    }
}

var attempts = 0;
var setHiddenFieldInterval = setInterval(() => {
    if (!hiddenFieldEl) {
        hiddenFieldEl = document.querySelector(inputFieldSelector);
    }

    if (hiddenFieldEl) {
        setHiddenField();
    }

    if (attempts >= 14) {
        clearInterval(setHiddenFieldInterval);
    }
    attempts++;
}, 1000);
