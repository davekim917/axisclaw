// agent-browser's own dashboard takes only mouse events and keys typed on a physical keyboard into a canvas, so a
// phone can neither tap nor type in it. This page speaks the same stream protocol: frames in; taps, drags and a real
// text field (which brings up the phone's keyboard) out.
/** A virtual key code names a key, not a character: only A-Z and 0-9 share their ASCII codes, and "." as 46 is Delete. */
export function virtualKeyCode(c: string): number {
  return /^[a-z0-9]$/i.test(c) ? c.toUpperCase().charCodeAt(0) : 0;
}

// Chromium's Backspace removes a whole emoji, flag, keycap or tag cluster but one code point of anything else (a
// combining accent, an Indic conjunct), so the diff counts in the same units.
export function textEdit(prev: string, cur: string): { deletes: number; inserts: string } {
  const cluster = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u20E3\uFE0E\uFE0F]|[\u{E0020}-\u{E007F}]/u;
  const seg = new Intl.Segmenter();
  // No named inner function: tsx's keep-names transform wraps one in a __name() helper the page does not define.
  const [p, c] = [prev, cur].map((text) =>
    Array.from(seg.segment(text), (g) => g.segment).flatMap((g) => (cluster.test(g) ? [g] : Array.from(g))),
  );
  let i = 0;
  while (i < p.length && i < c.length && p[i] === c[i]) i++;
  return { deletes: p.length - i, inserts: c.slice(i).join('') };
}

/**
 * The browser's own address for the streamed tab, null when a report names none, undefined when the message is not a
 * report. A tab's title is the page's to set, so it never counts.
 */
export function reportedAddress(message: { type?: string; url?: unknown; tabs?: unknown }): unknown {
  if (message.type === 'url') return message.url ?? null;
  if (message.type !== 'tabs') return undefined;
  return Array.isArray(message.tabs) ? (message.tabs.find((tab) => tab?.active === true)?.url ?? null) : null;
}

/** The whole host and no path, which the page can set. Only a plain-text sign-in is marked, by its scheme. */
export function addressLine(address: unknown): string {
  try {
    const { protocol, host } = new URL(String(address));
    if (protocol === 'https:') return `You are on ${host}`;
    if (protocol === 'http:') return `You are on http://${host}`;
  } catch {
    return 'Address unknown';
  }
  return 'This page has no address';
}

const HOST_ANSWER_MS = 2000;
const HOST_CHECK_MS = 1000;

/**
 * The stream gives no sign of a stalled host: frames stop, which a still page does too, and sent input waits in the
 * socket to land all at once when the host resumes. Only asking the host shows it. A late answer still clears the
 * stall, so a slow network costs a moment of ignored taps and not all of them.
 */
export async function watchHost(
  ping: () => Promise<unknown>,
  report: (stalled: boolean) => void,
  pause: (ms: number) => Promise<unknown>,
): Promise<void> {
  for (;;) {
    const answer = ping().then(
      () => true,
      () => false,
    );
    if (!(await Promise.race([answer, pause(HOST_ANSWER_MS).then(() => false)]))) report(true);
    report(!(await answer));
    await pause(HOST_CHECK_MS);
  }
}

const SCRIPT =
  `${virtualKeyCode.toString()}\n${textEdit.toString()}\n${watchHost.toString()}\n` +
  `${reportedAddress.toString()}\n${addressLine.toString()}\n` +
  `const HOST_ANSWER_MS = ${HOST_ANSWER_MS}, HOST_CHECK_MS = ${HOST_CHECK_MS};\n` +
  String.raw`
const v = document.getElementById('v'), bar = document.getElementById('bar'), t = document.getElementById('t');
const at = document.getElementById('at');
let ws = null, vw = 0, vh = 0, prev = '', down = null, scrolling = false, stalled = false, status = 'Connecting…';
const say = (text) => { status = text; if (!stalled) bar.textContent = text; };
const SPECIAL = { Enter: { text: '\r', code: 13 }, Tab: { text: '\t', code: 9 }, Backspace: { text: '\b', code: 8 } };
const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const keyPair = (base, text) => {
  send({ type: 'input_keyboard', eventType: 'keyDown', text, modifiers: 0, ...base });
  send({ type: 'input_keyboard', eventType: 'keyUp', modifiers: 0, ...base });
};
const special = (k) => keyPair({ key: k, code: k, windowsVirtualKeyCode: SPECIAL[k].code }, SPECIAL[k].text);
const char = (c) => keyPair({ key: c, code: '', windowsVirtualKeyCode: virtualKeyCode(c) }, c);
const resetText = () => { t.value = ''; prev = ''; };

const size = () => [vw || v.naturalWidth, vh || v.naturalHeight];
const point = (e) => {
  const r = v.getBoundingClientRect(), [w, h] = size();
  return { x: Math.round(((e.clientX - r.left) * w) / r.width), y: Math.round(((e.clientY - r.top) * h) / r.height) };
};
const mouse = (eventType, p, extra = {}) =>
  send({ type: 'input_mouse', eventType, x: p.x, y: p.y, button: 'none', clickCount: 0, modifiers: 0, ...extra });

v.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  v.setPointerCapture(e.pointerId);
  down = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY };
  scrolling = false;
});
v.addEventListener('pointermove', (e) => {
  if (!down) return;
  if (!scrolling && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) scrolling = true;
  if (!scrolling) return;
  const scale = size()[1] / v.getBoundingClientRect().height;
  mouse('mouseWheel', point(e), { deltaX: (down.lastX - e.clientX) * scale, deltaY: (down.lastY - e.clientY) * scale });
  down.lastX = e.clientX;
  down.lastY = e.clientY;
});
v.addEventListener('pointerup', (e) => {
  if (down && !scrolling && !stalled) {
    const p = point(e);
    mouse('mouseMoved', p);
    mouse('mousePressed', p, { button: 'left', clickCount: 1 });
    mouse('mouseReleased', p, { button: 'left', clickCount: 1 });
    resetText();
  }
  down = null;
});
v.addEventListener('pointercancel', () => { down = null; });

// Phone keyboards report most keys as "Unidentified", so the field's value is mirrored by diffing it instead.
t.addEventListener('input', () => {
  const edit = textEdit(prev, t.value);
  for (let k = 0; k < edit.deletes; k++) special('Backspace');
  for (const c of edit.inserts) char(c);
  prev = t.value;
});
t.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); special(e.key); resetText(); }
  else if (e.key === 'Backspace' && t.value === '') special('Backspace');
});
for (const k of ['Tab', 'Enter']) {
  const b = document.getElementById(k.toLowerCase());
  b.addEventListener('pointerdown', (e) => e.preventDefault());
  b.addEventListener('click', () => { special(k); resetText(); });
}
document.getElementById('hide').addEventListener('click', (e) => {
  t.type = t.type === 'password' ? 'text' : 'password';
  e.target.textContent = t.type === 'password' ? 'Show' : 'Hide';
});

async function connect() {
  try {
    const r = await fetch('/api/sessions', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const sessions = await r.json();
    if (!sessions.length) throw new Error('no browser yet');
    const port = (sessions.find((s) => s.session === 'default') || sessions[0]).port;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/session/' + port + '/stream');
    ws.onopen = () => { send({ type: 'config', maxFps: 15 }); say('Tap the page to click. Type in the box below.'); };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'frame') v.src = 'data:image/jpeg;base64,' + m.data;
      else if (m.type === 'status') { if (m.viewportWidth) vw = m.viewportWidth; if (m.viewportHeight) vh = m.viewportHeight; }
      const address = reportedAddress(m);
      if (address !== undefined) at.textContent = addressLine(address);
    };
    ws.onclose = () => { at.textContent = addressLine(); say('Reconnecting…'); setTimeout(connect, 2000); };
  } catch (err) {
    say('Waiting for the browser (' + err.message + ')…');
    setTimeout(connect, 3000);
  }
}
connect();
watchHost(
  () => fetch('/alive', { cache: 'no-store' }),
  (now) => { stalled = now; bar.textContent = now ? 'Connection stalled. Taps ignored until this clears.' : status; },
  (ms) => new Promise((done) => setTimeout(done, ms)),
);
`;

export const VIEWER_PAGE =
  '<!doctype html><html lang="en"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
  '<title>Agent browser</title><style>' +
  'body{margin:0;font:15px system-ui;background:#111;color:#eee;display:flex;flex-direction:column;height:100dvh}' +
  '#at{padding:8px 12px 0;font-weight:600;overflow-wrap:anywhere}' +
  '#bar{padding:8px 12px;font-size:13px;opacity:.85}' +
  '#wrap{flex:1;min-height:0;display:flex;justify-content:center}' +
  '#v{max-width:100%;max-height:100%;object-fit:contain;touch-action:none;user-select:none;-webkit-user-select:none}' +
  '#keys{display:flex;gap:6px;padding:8px 8px max(8px,env(safe-area-inset-bottom));background:#1b1b1b}' +
  '#t{flex:1;min-width:0;font:16px system-ui;padding:10px;border-radius:8px;border:1px solid #444;background:#000;color:#fff}' +
  'button{font:15px system-ui;padding:10px 12px;border-radius:8px;border:1px solid #444;background:#2a2a2a;color:#eee}' +
  '</style><div id="at">Address unknown</div><div id="bar">Connecting…</div><div id="wrap"><img id="v" alt="The agent\'s browser"></div>' +
  '<div id="keys"><input id="t" type="password" placeholder="Tap a field above, then type here" autocomplete="off" ' +
  'autocorrect="off" autocapitalize="none" spellcheck="false"><button id="hide">Show</button>' +
  '<button id="tab">Tab</button><button id="enter">Enter</button></div>' +
  `<script>${SCRIPT}</script></html>`;
