// One-time: extract serialisable config data into *.data.json for the config UI.
// Run: node tests/config-ui/extract-data.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const load = (p) => import(pathToFileURL(join(root, p)).href);

// ── InsightSoftware ──────────────────────────────────────────────────────────
// cookieScriptExp (the VWO experiment number) already lives in the data file;
// the config renders the snippet from it, so there is no mapping to reverse.
const { INSIGHT_CONFIG } = await load('tests/insightsoftware/config/insightsoftware.config.js');
const isoData = JSON.parse(readFileSync(join(root, 'tests/insightsoftware/config/insightsoftware.data.json'), 'utf8'));
const expByKey = new Map(isoData.tests.map((t) => [t.testId, t.cookieScriptExp ?? '']));

const iso = {
  clientDomain: INSIGHT_CONFIG.clientDomain,
  hiddenFields: INSIGHT_CONFIG.hiddenFields,
  pages: INSIGHT_CONFIG.pages,
  tests: INSIGHT_CONFIG.tests.map((t) => {
    const { cookieScript, ...rest } = t; // drop the rendered snippet — cookieScriptExp is the source
    return {
      ...rest,
      cookieScriptExp: expByKey.get(t.testId) ?? '',
      bucketActivation: t.bucketActivation ?? {},
    };
  }),
};
writeFileSync(join(root, 'tests/insightsoftware/config/insightsoftware.data.json'), JSON.stringify(iso, null, 2) + '\n');

// ── SailPoint / BambooHR (single-test TEST_CONFIG shape) ─────────────────────
for (const [name, p] of [['sailpoint', 'tests/sailpoint/config/sailpoint.config.js'],
                         ['bamboohr', 'tests/bamboohr/config/bamboohr.config.js']]) {
  const { TEST_CONFIG } = await load(p);
  const out = {
    testId: TEST_CONFIG.testId,
    testName: TEST_CONFIG.testName,
    cookieScript: TEST_CONFIG.cookieScript,
    buckets: TEST_CONFIG.buckets,
    hiddenFields: TEST_CONFIG.hiddenFields,
    popupValues: TEST_CONFIG.popupValues ?? {},
    flowthroughDestination: TEST_CONFIG.flowthroughDestination ?? [],
    interruptionPages: TEST_CONFIG.interruptionPages ?? [],
    pages: TEST_CONFIG.pages,
  };
  writeFileSync(join(root, 'tests', name, 'config', `${name}.data.json`), JSON.stringify(out, null, 2) + '\n');
}

console.log('wrote insightsoftware.data.json, sailpoint.data.json, bamboohr.data.json');
