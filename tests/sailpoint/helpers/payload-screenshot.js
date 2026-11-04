/**
 * Renders a fixed, always-visible payload header on the page and returns the
 * screenshot path. The header pins the key assertions (intellimize1 /
 * intellimize2 / the 3018 cookie for SailPoint, or custom `rows` for other
 * clients) ABOVE the scrollable payload body so they are never clipped out of
 * frame, then the full body follows underneath.
 */

// @ts-check

/** Parses a multipart/form-data body (fetch + FormData submissions). */
function parseMultipart(text) {
  const out = {};
  const re = /name="([^"]+)"[^\r\n]*\r?\n\r?\n([\s\S]*?)(?=\r?\n--|$)/g;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(text))) {
    const [, name, value] = m;
    if (!(name in out)) out[name] = value.replace(/\r?\n$/, '');
  }
  return out;
}

/** Parse a form-urlencoded, multipart or JSON payload into a flat record. */
export function parsePayload(raw) {
  if (!raw) return {};
  const trimmed = String(raw).trim();
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  if (/^\s*--/.test(trimmed) || /Content-Disposition:\s*form-data/i.test(trimmed)) {
    const parsed = parseMultipart(trimmed);
    if (Object.keys(parsed).length) return parsed;
  }
  const out = {};
  try {
    for (const [k, v] of new URLSearchParams(trimmed.replace(/\+/g, '%20'))) {
      if (!(k in out)) out[k] = v;
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{
 *   payload?: string,          // raw POST body (form-urlencoded, multipart or JSON)
 *   fields?: Record<string, any>, // optional pre-parsed override
 *   intellimize1?: string,     // fallback values from the DOM, used when no POST was captured
 *   intellimize2?: string,
 *   tag?: string,              // e.g. 'variantA' / 'control'
 *   stage?: string,            // e.g. 'PREVIEW (not submitted)' / 'SUBMITTED'
 *   endpoint?: string,         // shown in the header, defaults to Marketo's save2
 *   rows?: { label: string, value: any, color?: string, ok?: boolean }[],
 *                             // custom pinned header rows; replaces the intellimize rows
 *   cookieName?: string,
 *   cookieValue?: string,
 *   screenshotPath: string,
 * }} opts
 */
export async function screenshotPayload(page, opts) {
  const fields = opts.fields || parsePayload(opts.payload);
  const rows = opts.rows || null;
  const il1 = opts.intellimize1 ?? fields.intellimize1 ?? '';
  const il2 = opts.intellimize2 ?? fields.intellimize2 ?? '';
  const showIl1 = String(il1).trim() === '' ? '(empty)' : String(il1);
  const showIl2 = String(il2).trim() === ''
    ? '(empty — stamped only on the submit click)'
    : String(il2);
  const stamped = /\d{1,2}\/\d{1,2}\/\d{4}/.test(String(il2));
  const tagged = String(il1).includes('SPZ_3018');
  const body = opts.payload
    ? String(opts.payload)
    : Object.keys(fields).length
      ? JSON.stringify(fields, null, 2)
      : '(no POST body captured — nothing was sent)';

  await page.evaluate(
    ({ showIl1, showIl2, stamped, tagged, rows, endpoint, body, cookieName, cookieValue, tag, stage }) => {
      const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      document.getElementById('__payload_overlay')?.remove();
      const box = document.createElement('div');
      box.id = '__payload_overlay';
      box.style.cssText =
        'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#141414;' +
        'font:13px/1.5 Consolas,"Courier New",monospace;color:#d4d4d4;padding:0;max-height:56vh;display:flex;flex-direction:column;' +
        'box-shadow:0 -6px 22px rgba(0,0,0,.6);border-top:3px solid #2a7ade';

      const header = document.createElement('div');
      header.style.cssText = 'padding:10px 16px 8px;background:#1b1b1b;border-bottom:1px solid #333;flex:0 0 auto';
      const line = (label, value, color) =>
        `<div style="display:flex;gap:10px;align-items:baseline;margin:3px 0">`
        + `<span style="color:#9cdcfe;min-width:170px;font-weight:700">${label}</span>`
        + `<span style="color:${color};font-weight:700;font-size:15px;word-break:break-all">${esc(value)}</span></div>`;

      const pinned = rows
        ? rows.map((r) => line(r.label, r.value, r.color || (r.ok === false ? '#f48771' : '#b5cea8'))).join('')
        : line('intellimize1', showIl1, tagged ? '#b5cea8' : '#f48771')
          + line('intellimize2', showIl2, stamped ? '#b5cea8' : '#dcdcaa');

      header.innerHTML =
        `<div style="color:#569cd6;font-weight:700;letter-spacing:.4px">`
        + `PAYLOAD ${esc(stage || '')} — POST ${esc(endpoint || '/index.php/form/save2')}`
        + ` <span style="color:#808080">|</span> bucket: <span style="color:#dcdcaa">${esc(tag || '')}</span>`
        + `</div>`
        + pinned
        + (cookieName
            ? `<div style="display:flex;gap:10px;align-items:baseline;margin:3px 0">`
              + `<span style="color:#c586c0;min-width:170px;font-weight:700">${esc(cookieName)}</span>`
              + `<span style="color:#b5cea8;font-weight:700;font-size:15px">${esc(cookieValue || '(absent)')}</span></div>`
            : '');

      const pre = document.createElement('pre');
      pre.style.cssText =
        'margin:0;padding:12px 16px;overflow:auto;flex:1 1 auto;white-space:pre-wrap;word-break:break-all;font-size:12px;color:#d4d4d4';
      pre.textContent = body;

      box.append(header, pre);
      document.body.appendChild(box);
    },
    {
      showIl1,
      showIl2,
      stamped,
      tagged,
      rows,
      endpoint: opts.endpoint || '',
      body,
      cookieName: opts.cookieName || '',
      cookieValue: opts.cookieValue || '',
      tag: opts.tag || '',
      stage: opts.stage || '',
    },
  );

  await page.screenshot({ path: opts.screenshotPath });
  return opts.screenshotPath;
}
