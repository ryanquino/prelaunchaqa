/**
 * CONNECTWISE WEB ROLLOUT — Conversion Pages Identification
 *
 * Runs SITEWIDE (targeted to all pages listed in the VWO rollout config
 * "ConnectWise TF: Conversion Pages Identification").
 *
 * FUNCTIONALITY
 *   When a user lands on any targeted page, the page <title> is written to
 *   the hidden field CWS_Cr02__c on EVERY form that contains it:
 *
 *     • Regular form  →  hidden field value = <title>
 *     • Footer form   →  hidden field value = "Footer: " + <title>
 *
 * The title is passed WITHOUT any query param (document.title has none).
 *
 * The script polls every 1s for up to 15s because Marketo forms load
 * asynchronously (SPA) — the hidden fields may not exist on first run.
 */

/***********************************
 * CONFIG — change per rollout
 ***********************************/
var hiddenFieldSelector = 'input[name="CWS_Cr02__c"]';  // field the title goes into
var footerPrefix        = 'Footer: ';                   // prefix for footer forms

/***********************************
 ************************************
 DO NOT TOUCH
 BEYOND THIS LINE
 ******************************
 ******************************/

function setHiddenFields() {
  var pageTitle = document.title || '';
  var fields    = document.querySelectorAll(hiddenFieldSelector);

  for (var i = 0; i < fields.length; i++) {
    var el       = fields[i];
    var isFooter = !!el.closest('footer');
    el.value     = isFooter ? (footerPrefix + pageTitle) : pageTitle;
  }
}

var attempts = 0;
var setHiddenFieldInterval = setInterval(function () {
  if (document.querySelectorAll(hiddenFieldSelector).length > 0) {
    setHiddenFields();
  }

  if (attempts >= 14) {
    clearInterval(setHiddenFieldInterval);
  }
  attempts++;
}, 1000);