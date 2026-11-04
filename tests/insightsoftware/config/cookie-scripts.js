/**
 * VWO cookie snippets for InsightSoftware QA runs.
 *
 * Every snippet is the same shape — only the VWO experiment number differs —
 * so the config stores that NUMBER (e.g. `cookieScriptExp: "68"`) instead of a
 * copy of the script. `buildCookieScript()` renders the real snippet from it.
 *
 *   setCookie('_vis_opt_exp_<N>_exclude', '', '', true);
 *   setCookie('_vis_opt_exp_<N>_combi', {{combi}}, 1);
 *
 * `{{combi}}` is left in place for the downfunnel spec to substitute per bucket.
 *
 * Every snippet also pins the held experiment (HELD_EXP) at combi 1, and any
 * per-test `excludeExps` entries — sibling experiments pinned at combi 1 so they
 * can never bucket this session, e.g. `48=Disabling 1000`.
 *
 * `excludeExps` grammar (comma-separated): `<exp>` or `<exp>=<note>`.
 * An empty `cookieScriptExp` means POSTLAUNCH (live): nothing is injected.
 */

/** Held at combi 1 in every snippet, so the sibling campaign cannot bucket us. */
export const HELD_EXP = '49';

/** Shown as dropdown suggestions. Any positive integer is accepted. */
export const COOKIE_EXP_OPTIONS = ['64', '68', HELD_EXP];

const expPattern = /^\d+$/;

/**
 * Parses a test's `excludeExps` string into `{ exp, note }` entries.
 * Throws on anything that isn't a VWO experiment number — a typo would
 * otherwise ship as a broken setCookie() call into the page.
 */
export function parseExcludeExps(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const seen = new Set();
  const out = [];
  for (const entry of text.split(',')) {
    const e = entry.trim();
    if (!e) continue;
    const idx = e.indexOf('=');
    const exp = (idx === -1 ? e : e.slice(0, idx)).trim();
    if (!expPattern.test(exp)) {
      throw new Error(
        `Invalid excludeExps entry "${e}" — expected a VWO experiment number (digits), e.g. 48, or "<exp>=<note>", e.g. 48=Disabling 1000`
      );
    }
    if (seen.has(exp)) continue;
    seen.add(exp);
    // The note is a trailing // comment: it must stay on one line.
    const note = idx === -1 ? '' : e.slice(idx + 1).replace(/\s*[\r\n]+/g, ' ').trim();
    out.push({ exp, note });
  }
  return out;
}

export function buildCookieScript(exp, excludeExps = '') {
  const n = String(exp ?? '').trim();
  if (!n) return '';
  if (!expPattern.test(n)) {
    throw new Error(
      `Invalid cookieScriptExp "${exp}" — expected a VWO experiment number (digits), e.g. 68`
    );
  }

  const lines = [
    `    setCookie('_vis_opt_exp_${HELD_EXP}_combi', 1, 1);`,
    ...parseExcludeExps(excludeExps).map(({ exp: x, note }) =>
      `    setCookie('_vis_opt_exp_${x}_combi', 1, 1);${note ? ` // ${note}` : ''}`
    ),
    `    setCookie('_vis_opt_exp_${n}_exclude', '', '', true);`,
    `    setCookie('_vis_opt_exp_${n}_combi', {{combi}}, 1);`,
  ];

  return `
    function setCookie(name, value, days, remove) {
      const expires = remove
        ? 'Thu, 01 Jan 1970 00:00:01 GMT'
        : new Date(Date.now() + days * 864e5).toUTCString();
      document.cookie = \`\${name}=\${remove ? '' : value};domain=.insightsoftware.com;path=/;expires=\${expires}\`;
    }

${lines.join('\n')}
  `;
}
