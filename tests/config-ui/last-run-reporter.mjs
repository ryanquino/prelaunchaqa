/**
 * Playwright reporter — per-test Passed/Failed feed for the config UI.
 *
 * The config-UI server adds `--reporter=list,<this file>` to every run and sets
 *   PW_STATUS_JSON      absolute path of the JSON to write (per client)
 *   PW_STATUS_CLIENT /  client key + run kind, echoed into the payload so the
 *   PW_STATUS_KIND      UI can label the panel
 * Without PW_STATUS_JSON (a plain `npx playwright test` from a terminal) the
 * reporter is a no-op, so it is safe to keep wired up permanently.
 *
 * The file is rewritten after EVERY test (not just at the end), so the UI's
 * "Tests — last run" card can show a run in progress and still has results if
 * the run is killed halfway. Last result per test wins (retries overwrite).
 *
 * Shape written:
 *   { client, kind, project, phase: 'running'|'finished', overall,
 *     startedAt, finishedAt, counts: {passed, failed, skipped},
 *     tests: [{ title, file, status: 'passed'|'failed'|'skipped',
 *               duration, error, skipReason }] }
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';

const OUT = process.env.PW_STATUS_JSON || '';

// result.status ∈ passed | failed | timedOut | interrupted | skipped —
// everything that isn't passed/skipped reads as Failed in the UI.
const badgeStatus = (status) =>
  status === 'passed' ? 'passed' : status === 'skipped' ? 'skipped' : 'failed';

// Playwright error messages carry ANSI colour codes; strip the ESC[...m
// sequences so the panel shows plain text.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

// ...and keep only the first meaningful lines instead of huge stack tails.
const shortError = (err) => {
  if (!err?.message) return null;
  const clean = String(err.message).replace(ANSI, '').trim();
  const lines = clean.split(/\r?\n/).filter(Boolean);
  return lines.slice(0, 3).join('\n') + (lines.length > 3 ? ' …' : '');
};

class LastRunReporter {
  constructor() {
    this.startedAt = new Date().toISOString();
    this.tests = new Map(); // full title → entry (last result wins)
    this.project = '';
  }

  onBegin(config, suite) {
    this.startedAt = new Date().toISOString();
    this.project = suite.project()?.name ?? '';
    this.write('running', null);
  }

  onTestEnd(test, result) {
    // titlePath = [project (may be ''), file, ...describe titles, test title].
    // Everything before the file segment is the project — derive both from the
    // path itself, since the root suite's project() is not always populated.
    const parts = test.titlePath().filter(Boolean);
    const fileIdx = parts.findIndex((p) => /\.(spec|test)\.[cm]?[jt]s$/.test(p));
    const project = fileIdx > 0 ? parts.slice(0, fileIdx).join(' › ') : '';
    const file = fileIdx >= 0 ? parts[fileIdx] : (test.location?.file ?? '');
    const title = fileIdx >= 0 ? parts.slice(fileIdx + 1).join(' › ') : parts.join(' › ');
    if (!this.project && project) this.project = project;
    const skip = test.annotations?.find((a) => a.type === 'skip');

    this.tests.set(title, {
      title,
      file: file ? relative(process.cwd(), file) : (test.location?.file ?? ''),
      status: badgeStatus(result.status),
      duration: result.duration ?? 0,
      error: result.status === 'passed' || result.status === 'skipped' ? null : shortError(result.error),
      skipReason: result.status === 'skipped' ? (skip?.description ?? null) : null,
    });
    this.write('running', null);
  }

  onEnd(result) {
    this.write('finished', result.status); // 'passed' | 'failed' | 'interrupted' | 'timedout'
  }

  write(phase, overall) {
    if (!OUT) return;
    const tests = [...this.tests.values()];
    const counts = {
      passed: tests.filter((t) => t.status === 'passed').length,
      failed: tests.filter((t) => t.status === 'failed').length,
      skipped: tests.filter((t) => t.status === 'skipped').length,
    };
    const payload = {
      client: process.env.PW_STATUS_CLIENT || null,
      kind: process.env.PW_STATUS_KIND || null,
      project: this.project,
      phase,
      overall,
      startedAt: this.startedAt,
      finishedAt: phase === 'finished' ? new Date().toISOString() : null,
      counts,
      tests,
    };
    try {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify(payload, null, 2));
    } catch {
      // Never let status bookkeeping break an actual test run.
    }
  }
}

export default LastRunReporter;
