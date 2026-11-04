/**
 * SailPoint A/B Test Configuration.
 *
 * The DATA lives in sailpoint.data.json (edited by the config UI or by hand).
 * This module reads that JSON and re-exports TEST_CONFIG in the shape the
 * specs already expect. See the SETUP CHECKLIST in config-ui/README.md.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Playwright loads these .js files as CJS (no "type": "module"), so import.meta
// is unavailable. Tests always run with cwd = repo root.
export const TEST_CONFIG = JSON.parse(readFileSync(join(process.cwd(), 'tests/sailpoint/config/sailpoint.data.json'), 'utf8'));
