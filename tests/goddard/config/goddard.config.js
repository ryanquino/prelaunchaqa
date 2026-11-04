/**
 * Goddard School Franchise — Down-Funnel QA config
 *
 * The DATA lives in goddard.data.json (edited by the config UI or by hand).
 * This module reads that JSON and re-exports GODDARD_CONFIG in the shape the
 * spec already expects, so nothing outside these two files changes.
 *
 * Read-only down-funnel values check (NO form submissions). The live SPZ
 * experiments assign the visitor a bucket via cookies, and pages with a HubSpot
 * form carry those values into the hidden field:
 *
 *   <input id="hs_form_target_form_…" type="hidden"
 *          name="0-1/cr01" data-hsfc-id="HiddenField"
 *          value="spz_1010_control,spz_2011_variant">
 *
 * FLOWTHROUGH semantics (same rule as the other suites):
 *   • isFlowthrough: true  → this is a START page (homepage). It assigns the
 *                            bucket in the session cookie; the suite then
 *                            navigates to `flowthroughDestination` and verifies
 *                            the value CARRIED into 0-1/cr01 there.
 *   • isFlowthrough: false → this IS the destination form page (demo/info
 *                            request). The test lands on it directly and just
 *                            checks 0-1/cr01 is populated with a bucket token
 *                            per `expectedExperiments` — no source page needed.
 *
 * Observed live signal (no injection needed — POSTLAUNCH):
 *   • bucket signal → cookies: ExperimentName, ExperimentValue (spz_*)
 *   • no <body> class (unlike SailPoint)
 *   • homepage        → assigns spz_1010_<bucket>; the value flows through to
 *                       the form page 0-1/cr01
 *   • info request    → itself assigns spz_2011_<bucket> into 0-1/cr01
 *
 * Not carried in the JSON (nothing injects a script, so there is no bucket
 * config to edit): buckets are observed live from cookies, not declared here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Playwright loads these .js files as CJS (no "type": "module"), so import.meta
// is unavailable. Tests always run with cwd = repo root.
export const GODDARD_CONFIG = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/goddard/config/goddard.data.json'), 'utf8')
);
