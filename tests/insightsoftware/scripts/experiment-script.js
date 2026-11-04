/**
 * EXPERIMENT-SPECIFIC SCRIPT — Template for all Insightsoftware A/A tests
 *
 * Deployed via VWO as a test-specific script on BOTH the True Control (0%
 * traffic) and Variant of every test.  Sets two cookies:
 *
 *   ExperimentName  — comma-separated test IDs  (e.g. "3000,1000")
 *   ExperimentValue — comma-separated variant values (e.g. "spz_3000_variant,spz_1000_variant")
 *
 * USAGE — copy this file and replace ONLY the three variables below:
 *   • squeezePage  — false (non-form page) or 'both' (form page)
 *   • expName      — the test ID string (e.g. '1000', '2000')
 *   • clientDomain — '.insightsoftware.com'
 *
 * On form pages (squeezePage = 'both'), the script also sets
 * window.squeezePageValue so the Web Rollout can distinguish the
 * current page's test from carried-over values.
 */
(function() {
    // ════════════════════════════════════════════════════════════════════════
    // CONFIGURE THESE THREE VARIABLES FOR EACH TEST
    // ════════════════════════════════════════════════════════════════════════

    // true  – squeeze page (page contains a form; sets window.squeezePageValue)
    // false – non-form page (cookies only)
    // 'both'– form page AND you want both cookie + window.squeezePageValue
    const squeezePage = false;

    // Experiment / test ID — must match the VWO test name suffix
    // e.g. '1000' for test #1000, '2000' for test #2000, etc.
    const expName = '0000';

    // Variant value written to cookies
    // Format: SPZ_#<expName>_variant  or  SPZ_#<expName>_true_control
    const variantName = 'SPZ_#' + expName + '_variant';

    // Domain cookie is written to
    const clientDomain = '.insightsoftware.com';

    // ════════════════════════════════════════════════════════════════════════
    // DO NOT TOUCH BEYOND THIS LINE
    // ════════════════════════════════════════════════════════════════════════

    const formHiddenValue = variantName;
    if (squeezePage === true) {
        window.squeezePageValue = formHiddenValue;
    } else if (squeezePage === false) {
        hiddenValue(expName, variantName);
    } else if (squeezePage === 'both') {
        hiddenValue(expName, variantName);
        window.squeezePageValue = formHiddenValue;
    }

    function hiddenValue(currentExperimentName, currentExperimentValue) {
        function setCookie(name, value, days) {
            var expires = "";
            if (days) {
                var date = new Date();
                date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
                expires = "; expires=" + date.toUTCString();
            }
            document.cookie = name + "=" + (value || "") + expires + ";domain=" + clientDomain + ";path=/";
        }

        function getCookie(name) {
            var nameEQ = name + "=";
            var ca = document.cookie.split(';');
            for (var i = 0; i < ca.length; i++) {
                var c = ca[i];
                while (c.charAt(0) == ' ') c = c.substring(1, c.length);
                if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
            }
            return null;
        }

        var ExistingExperimentName = getCookie('ExperimentName');
        var ExistingExperimentValue = getCookie('ExperimentValue');
        var ExistingExperimentNameList = ExistingExperimentName ? ExistingExperimentName.split(',') : [];

        if (!ExistingExperimentName) {
            setCookie('ExperimentName', currentExperimentName, 1);
            setCookie('ExperimentValue', currentExperimentValue, 1);
        } else if (ExistingExperimentNameList.length > 0 && ExistingExperimentNameList.indexOf(currentExperimentName) == -1) {
            setCookie('ExperimentName', ExistingExperimentName + ',' + currentExperimentName, 1);
            setCookie('ExperimentValue', ExistingExperimentValue + ',' + currentExperimentValue, 1);
        } else if (ExistingExperimentNameList.length > 0 && ExistingExperimentNameList.indexOf(currentExperimentName) > -1) {
            var existingNames = ExistingExperimentName.split(',');
            var existingValues = ExistingExperimentValue.split(',');
            var index = existingNames.indexOf(currentExperimentName);
            existingValues[index] = currentExperimentValue;
            setCookie('ExperimentName', existingNames.join(','), 1);
            setCookie('ExperimentValue', existingValues.join(','), 1);
        }
    }
}());
