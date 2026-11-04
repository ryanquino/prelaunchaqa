/**
 * Config UI — local HTTP server (no dependencies).
 *
 *   npm run config:ui        → http://localhost:4173
 *
 * Serves a form-based editor for the A/B test configs of iso / sp / bhr, plus
 * Validate (config contract spec) and Run (downfunnel spec) buttons that shell
 * out to Playwright and stream the output back.
 *
 * Config data lives in tests/<client>/config/<client>.data.json. The
 * <client>.config.js modules read that JSON and re-export the same shapes the
 * specs already import, so nothing outside these two files changes.
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COOKIE_EXP_OPTIONS } from '../insightsoftware/config/cookie-scripts.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const PUBLIC = join(here, 'public');
const PORT = Number(process.env.PORT) || 4173;

// ── Client registry ──────────────────────────────────────────────────────────
// `multiTest: true` clients store tests in a `tests[]` array (iso); the others
// hold a single flat TEST_CONFIG. The UI reads/writes the raw JSON either way.
const CLIENTS = {
  iso: {
    name: 'InsightSoftware',
    dataFile: 'tests/insightsoftware/config/insightsoftware.data.json',
    // Evidence screenshots. NEVER under test-results/ — Playwright wipes that
    // folder at the start of every run, silently deleting what you want to look at.
    screenshotsDir: 'screenshots/insightsoftware-cookies',
    // VWO experiment numbers offered for `cookieScriptExp` (a '' value = postlaunch).
    cookieScriptOptions: COOKIE_EXP_OPTIONS,
    cookieScriptField: 'cookieScriptExp',
    cookieScriptHint:
      "VWO experiment number. The snippet is generated from it — the exp number is the only thing that differs per test. Empty = postlaunch / live (nothing injected).",
    hasBucketActivation: true,
    hasInterruptionPages: false,
    hasPopupFields: false,
    multiTest: true,
    // iso: per-test intermediate no-form pages walked in order (resolveTestPlans
    // resolves flowthroughPages → flowthroughWaypoints + waypointTerminal).
    hasFlowthroughPages: true,
    // iso: resolveTestPlans only requires a formSelector on a destination.
    destRule: 'formOnly',
    validateSpec: 'tests/insightsoftware/insightsoftware.config.spec.js',
    runSpec: 'tests/insightsoftware/insightsoftware.downfunnel.spec.js',
    // Live form-submission spec: 1 real lead per bucket (#1002 ships three).
    // Only runs when the UI's opt-in checkbox is ticked (SUBMIT_LIVE=1).
    submitSpec: 'tests/insightsoftware/insightsoftware.submit.spec.js',
    submitEnv: 'SUBMIT_LIVE',
    project: 'iso',
  },
  sp: {
    name: 'SailPoint',
    dataFile: 'tests/sailpoint/config/sailpoint.data.json',
    screenshotsDir: 'screenshots/cookies',
    cookieScriptOptions: [],
    hasBucketActivation: false,
    hasInterruptionPages: true,
    hasPopupFields: false,
    multiTest: false,
    // sp: destGuard also excludes under-test / flowthrough / isDestination:false.
    destRule: 'destGuard',
    // intermediate no-form pages walked in order, asserted + screenshotted (sp).
    hasFlowthroughPages: true,
    validateSpec: 'tests/sailpoint/sailpoint.config.spec.js',
    runSpec: 'tests/sailpoint/sailpoint.downfunnel.spec.js',
    // Live form-submission spec: fires 1 real lead per bucket, so it only runs
    // when the UI's opt-in checkbox is ticked (SUBMIT_LIVE=1 is passed to the run).
    submitSpec: 'tests/sailpoint/sailpoint.submit.spec.js',
    submitEnv: 'SUBMIT_LIVE',
    project: 'sp',
  },
  bhr: {
    name: 'BambooHR',
    dataFile: 'tests/bamboohr/config/bamboohr.data.json',
    screenshotsDir: 'screenshots/cookies',
    cookieScriptOptions: [],
    hasBucketActivation: false,
    hasInterruptionPages: false,
    hasPopupFields: true,
    // bhr pages carry either an inline hero form or a modal popup — hasHeroForm
    // picks which one holds the DF value.
    hasHeroForm: true,
    multiTest: false,
    // bhr derives destinations from the same guard as sp.
    destRule: 'destGuard',
    validateSpec: null,
    runSpec: 'tests/bamboohr/bamboohr.downfunnel.spec.js',
    project: 'bhr',
  },
  goddard: {
    name: 'Goddard',
    dataFile: 'tests/goddard/config/goddard.data.json',
    screenshotsDir: 'screenshots/goddard-cookies',
    // Goddard is read-only and postlaunch: buckets are OBSERVED live from
    // cookies, so there is no script to inject and nothing to declare per bucket.
    shape: 'goddard',
    cookieScriptOptions: [],
    hasBucketActivation: false,
    hasInterruptionPages: false,
    hasPopupFields: false,
    hasHeroForm: false,
    hasFlowthroughPages: false,
    hasBuckets: false,
    hasHiddenFields: false,
    hasExpectedExperiments: true,
    // flowthroughDestination is ONE page key (the HubSpot form), not a list.
    destRule: 'single',
    multiTest: false,
    validateSpec: null,
    runSpec: 'tests/goddard/goddard.downfunnel.spec.js',
    project: 'goddard',
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const dataPath = (key) => join(ROOT, CLIENTS[key].dataFile);

const readData = (key) => JSON.parse(readFileSync(dataPath(key), 'utf8'));

const writeData = (key, body) => {
  const file = dataPath(key);
  mkdirSync(dirname(file), { recursive: true });
  // Keep a .bak of the previous version so a bad save is always recoverable.
  if (existsSync(file)) writeFileSync(file + '.bak', readFileSync(file));
  writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
};

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
};

// Resolves a client's screenshot folder, creating it first so the button never
// opens a path that doesn't exist yet.
const screenshotDirFor = (key) => {
  const dir = join(ROOT, CLIENTS[key].screenshotsDir);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// Opens a folder in the OS file manager. The path always comes from CLIENTS
// (never from the request body), so this can't be pointed at an arbitrary path.
const openFolder = (dir) => {
  const [cmd, args] =
    process.platform === 'win32'  ? ['explorer', [dir.replace(/\//g, '\\')]]
  : process.platform === 'darwin' ? ['open', [dir]]
  : ['xdg-open', [dir]];
  // explorer exits 1 on success in some Windows versions — don't treat that as
  // an error, just make sure the spawn itself didn't throw.
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
};

// Runs a Playwright command, streaming stdout+stderr line by line to `onLine`.
// `extraEnv` is merged over process.env — used to switch on live-submission
// flags (SUBMIT_LIVE) that the specs check before firing real leads.
const runPlaywright = (args, onLine, extraEnv = {}) =>
  new Promise((resolvePromise) => {
    const child = spawn('npx', ['playwright', 'test', ...args], {
      cwd: ROOT,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0', ...extraEnv },
    });
    let buf = '';
    const pump = (chunk) => {
      buf += chunk.toString();
      let i;
      // eslint-disable-next-line no-cond-assign
      while ((i = buf.search(/\r?\n/)) !== -1) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + buf.match(/\r?\n/)[0].length);
      }
    };
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf);
      resolvePromise(code);
    });
  });

// Parse the "N passed / M failed" summary Playwright prints at the end.
const parseSummary = (lines) => {
  const text = lines.join('\n');
  const passed = Number(text.match(/(\d+)\s+passed/)?.[1] ?? 0);
  const failed = Number(text.match(/(\d+)\s+failed/)?.[1] ?? 0);
  const skipped = Number(text.match(/(\d+)\s+skipped/)?.[1] ?? 0);
  const failures = [];
  const re = /\d+\)\s+\[.*?\]\s+›\s+(.+?)\n\s+(?:Error|expect)/g;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(text))) failures.push(m[1].trim());
  return { passed, failed, skipped, failures };
};

// ── In-flight run registry ───────────────────────────────────────────────────
// jobId → { lines, done, code }. The UI polls /api/run/:id.
const runs = new Map();
let runSeq = 0;

const startRun = (kind, clientKey, extra = {}) => {
  const cfg = CLIENTS[clientKey];
  // NB: --project is a repeatable flag, so it greedily swallows the next arg
  // when written as "--project iso <spec>". Use the --project=iso form.
  const args = [`--project=${cfg.project}`];
  /** @type {Record<string, string>} */
  const env = {};
  if (kind === 'validate') {
    if (!cfg.validateSpec) throw new Error(`${clientKey} has no config-contract spec`);
    args.push(cfg.validateSpec);
  } else if (kind === 'submit') {
    // Live submission: the UI only offers this for clients with a submitSpec,
    // and only after the "fires real leads" checkbox is ticked (extra.live).
    if (!cfg.submitSpec) throw new Error(`${clientKey} has no submission spec`);
    if (!extra.live) throw new Error('live submission was not confirmed');
    // Belt and braces: an empty submitPages must never be read as "all pages",
    // and a run fires ONE bucket on ONE page — the first ticked target.
    const data = readData(clientKey);
    const targets = (Array.isArray(data.submitPages) ? data.submitPages : []).filter(Boolean);
    if (!targets.length) {
      throw new Error(
        `${clientKey} has no submitPages configured — tick at least one page under "Form submission targets"`,
      );
    }
    if (!data.submitBucket) {
      throw new Error(
        `${clientKey} has no submitBucket configured — pick a bucket under "Form submission targets"`,
      );
    }
    const first = targets[0];
    // Owning test = the experiment runs ON that page, or flows THROUGH to it
    // (flowthroughDestination). Mirrors findOwningTest() in the iso helpers.
    const owned = Array.isArray(data.tests)
      ? data.tests.find((t) => t.page === first
        || (Array.isArray(t.flowthroughDestination) && t.flowthroughDestination.includes(first)))
      : null;
    if (Array.isArray(data.tests) && !owned) {
      throw new Error(
        `${clientKey}: no test owns submission target "${first}" (tests[].page or flowthroughDestination) — pick another page or give a test that page`,
      );
    }
    // Single-test clients (sp): the experiment's value reaches the form page
    // under test itself (value stays there) or the pages listed in
    // flowthroughDestination. An EMPTY list auto-derives every eligible form
    // page — resolvePlan()/findOwningTarget() treat under-test, flowthrough,
    // isDestination:false and no-form pages as never seeing the value, so this
    // guard must refuse them too (otherwise an empty list would read as "any
    // page may be submitted live").
    if (!Array.isArray(data.tests)) {
      const dests = Array.isArray(data.flowthroughDestination) ? data.flowthroughDestination : [];
      const p = data.pages?.[first];
      const selfOwned = Boolean(p && p.isUnderTest && !p.isFlowthrough);
      const eligible = Boolean(p && !p.isUnderTest && !p.isFlowthrough
        && p.isDestination !== false && p.formSelector);
      if (!selfOwned && (dests.length ? !dests.includes(first) : !eligible)) {
        throw new Error(dests.length
          ? `${clientKey}: submission target "${first}" is not in flowthroughDestination (${dests.join(', ')}) and is not the form page under test — the experiment's value never reaches it`
          : `${clientKey}: submission target "${first}" is not an eligible form page — with an empty flowthroughDestination every eligible form page is auto-derived (under-test, flowthrough, isDestination:false and no-form pages never see the value)`);
      }
    }
    const bucketKeys = Object.keys((owned ?? data).buckets || {});
    if (!bucketKeys.includes(String(data.submitBucket))) {
      throw new Error(
        `submitBucket "${data.submitBucket}" is not a bucket of the test on "${first}" (available: ${bucketKeys.join(', ') || 'none'})`,
      );
    }
    args.push(cfg.submitSpec);
    env[cfg.submitEnv ?? 'SUBMIT_LIVE'] = '1';
    env.SUBMIT_PAGES = first;
    env.SUBMIT_BUCKETS = String(data.submitBucket);
  } else {
    args.push(cfg.runSpec);
    if (extra.grep) args.push('-g', extra.grep);
    if (extra.workers) args.push('--workers', String(extra.workers));
  }

  // Per-test Passed/Failed file the UI's "Tests — last run" card reads. The
  // custom reporter rewrites it after every test, so the panel shows progress
  // mid-run and still has the results if a run is killed. Survives restarts.
  const statusFile = join(here, 'runs', `${clientKey}.json`);
  mkdirSync(join(here, 'runs'), { recursive: true });
  // Windows path separators are fine for Playwright's reporter loader, but
  // forward slashes keep the shell-escaped arg unambiguous.
  args.push(`--reporter=list,${join(here, 'last-run-reporter.mjs').replace(/\\/g, '/')}`);
  env.PW_STATUS_JSON = statusFile;
  env.PW_STATUS_CLIENT = clientKey;
  env.PW_STATUS_KIND = kind;

  const id = String(++runSeq);
  const job = { id, kind, client: clientKey, args, env, lines: [], done: false, code: null, startedAt: Date.now() };
  runs.set(id, job);

  runPlaywright(args, (line) => {
    job.lines.push(line);
    if (job.lines.length > 5000) job.lines.splice(0, job.lines.length - 5000);
  }, env).then((code) => {
    job.code = code;
    job.done = true;
    job.summary = parseSummary(job.lines);
  });

  return job;
};

// ── Routes ───────────────────────────────────────────────────────────────────
// Keyed by extension WITHOUT the leading dot — file.split('.').pop() matches.
const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  ico: 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    // ── API ────────────────────────────────────────────────────────────────
    if (path === '/api/clients') {
      return json(res, 200, Object.entries(CLIENTS).map(([key, c]) => ({
        key,
        name: c.name,
        shape: c.shape ?? 'flat',
        screenshotsDir: c.screenshotsDir,
        multiTest: c.multiTest,
        hasBucketActivation: c.hasBucketActivation,
        hasInterruptionPages: c.hasInterruptionPages,
        hasFlowthroughPages: Boolean(c.hasFlowthroughPages),
        hasHeroForm: Boolean(c.hasHeroForm),
        hasPopupFields: c.hasPopupFields,
        hasBuckets: c.hasBuckets !== false,
        hasHiddenFields: c.hasHiddenFields !== false,
        hasExpectedExperiments: Boolean(c.hasExpectedExperiments),
        destRule: c.destRule ?? 'formOnly',
        cookieScriptOptions: c.cookieScriptOptions,
        cookieScriptField: c.cookieScriptField ?? 'cookieScript',
        cookieScriptHint: c.cookieScriptHint ?? null,
        canValidate: Boolean(c.validateSpec),
        hasSubmitSpec: Boolean(c.submitSpec),
      })));
    }

    if (path.startsWith('/api/config/')) {
      const key = path.split('/')[3];
      if (!CLIENTS[key]) return json(res, 404, { error: `unknown client "${key}"` });

      if (req.method === 'GET') return json(res, 200, readData(key));

      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: 'body is not valid JSON' });
        }
        writeData(key, body);
        return json(res, 200, { ok: true, savedTo: CLIENTS[key].dataFile });
      }
    }

    if (path === '/api/screenshots/open' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let client;
      try {
        ({ client } = JSON.parse(raw || '{}'));
      } catch {
        return json(res, 400, { error: 'body is not valid JSON' });
      }
      if (!CLIENTS[client]) return json(res, 404, { error: `unknown client "${client}"` });
      try {
        const dir = screenshotDirFor(client);
        openFolder(dir);
        return json(res, 200, { ok: true, dir });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    if (path.startsWith('/api/run/') && req.method === 'POST') {
      const [, , , id, action] = path.split('/');
      if (action === 'start') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const { client, kind, grep, workers, live } = JSON.parse(raw || '{}');
        if (!CLIENTS[client]) return json(res, 404, { error: `unknown client "${client}"` });
        try {
          const job = startRun(kind, client, { grep, workers, live: Boolean(live) });
          return json(res, 200, { id: job.id, args: job.args });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
    }

    if (path.startsWith('/api/run/') && req.method === 'GET') {
      const id = path.split('/')[3];
      const job = runs.get(id);
      if (!job) return json(res, 404, { error: 'no such run' });
      const since = Number(url.searchParams.get('since') || 0);
      return json(res, 200, {
        id: job.id,
        done: job.done,
        code: job.code,
        args: job.args,
        lines: job.lines.slice(since),
        total: job.lines.length,
        summary: job.summary ?? null,
      });
    }

    // Most recent run's per-test statuses for one client (last-run-reporter.mjs
    // wrote it). Missing file = this client never ran here yet.
    if (path.startsWith('/api/lastRun/')) {
      const key = path.split('/')[3];
      if (!CLIENTS[key]) return json(res, 404, { error: `unknown client "${key}"` });
      const file = join(here, 'runs', `${key}.json`);
      if (!existsSync(file)) {
        return json(res, 200, { client: key, kind: null, phase: 'never', counts: null, tests: [] });
      }
      return json(res, 200, JSON.parse(readFileSync(file, 'utf8')));
    }

    // ── Static ─────────────────────────────────────────────────────────────
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
    if (!existsSync(file)) return json(res, 404, { error: 'not found' });
    const ext = file.split('.').pop().toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    return res.end(readFileSync(file));
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — the config UI is probably already running.`);
    console.error(`  Open http://localhost:${PORT} in a browser, or pick another port:`);
    console.error(`\n      PORT=4174 npm run config:ui\n`);
    // Find the occupant where we can (Windows) so the user knows what to stop.
    try {
      const out = execSync(
        `netstat -ano -p tcp | findstr :${PORT} | findstr LISTENING`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (out) {
        console.error('  Listening process:');
        for (const line of out.split(/\r?\n/)) console.error(`    ${line.trim()}`);
        const pid = out.match(/\s(\d+)\s*$/)?.[1];
        if (pid) console.error(`\n      Stop it with:  taskkill /PID ${pid} /F\n`);
      }
    } catch { /* netstat/findstr unavailable — the message above is enough */ }
    process.exit(1);
  }
  console.error(`\n  Config UI failed to start: ${err.message}\n`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\n  A/B config UI  →  http://localhost:${PORT}\n`);
  console.log('  Editing:');
  for (const [k, c] of Object.entries(CLIENTS)) console.log(`    ${k.padEnd(4)} ${c.name.padEnd(16)} ${c.dataFile}`);
  console.log('\n  Ctrl+C to stop.\n');
});

// Graceful shutdown so the port is released cleanly (no lingering EADDRINUSE).
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000); });
}
