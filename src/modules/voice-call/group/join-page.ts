import { micReportPageScript } from '../mic-report.js';

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function keepPinned(
  box: { scrollTop: number; scrollHeight: number; clientHeight: number },
  change: () => void,
): void {
  const pinned = box.scrollHeight - box.scrollTop - box.clientHeight <= 40;
  change();
  if (pinned) box.scrollTop = box.scrollHeight;
}

interface MicTrack {
  stop(): void;
}

// On Android Chrome the echo canceller misses audio that began playing before the mic opened, so a
// phone on speaker sent the whole call back into it. The room starts its audio when it connects.
export async function joinMicFirst<T extends MicTrack>(
  L: { createLocalAudioTrack(options: object): Promise<T>; Track: { Source: { Microphone: unknown } } },
  room: {
    connect(url: string, token: string, options: object): Promise<void>;
    startAudio(): Promise<void>;
    localParticipant: { publishTrack(track: T, options: object): Promise<unknown> };
  },
  claim: { url: string; token: string },
): Promise<T> {
  const mic = await L.createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  try {
    await room.connect(claim.url, claim.token, { autoSubscribe: true });
    await room.startAudio();
    await room.localParticipant.publishTrack(mic, { source: L.Track.Source.Microphone });
  } catch (e) {
    mic.stop();
    throw e;
  }
  return mic;
}

export function joinPageHtml(agentName: string, personName: string, platform: string): string {
  const agent = escapeHtml(agentName);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Call</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#15181d;--muted:#5d6570;--chip:#e7eaee;--accent:#1f8a5b;--danger:#c23b32}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#eceff3;--muted:#a3abb6;--chip:#1d2128;--accent:#2f9e6b;--danger:#c9463d}}
body{box-sizing:border-box;height:100vh;height:100dvh;margin:0;padding:max(12px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));font:17px/1.45 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
body>*{flex:none}
h1{font-size:22px;margin:0}#status{color:var(--muted);min-height:1.45em}
button{font:inherit;font-size:19px;padding:12px 30px;border-radius:999px;border:0;color:#fff;cursor:pointer}
#join{background:var(--accent)}#mute{background:#4a515b}#leave{background:var(--danger)}button:disabled{opacity:.5}
#people{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;max-width:440px}
.p{padding:4px 12px;border-radius:999px;background:var(--chip);border:2px solid transparent}.p.on{border-color:var(--accent)}
#log{flex:1 1 0;min-height:0;overflow-y:auto;overscroll-behavior:contain;width:100%;max-width:440px;text-align:left;display:flex;flex-direction:column;gap:8px}
.line{padding:10px 12px;border-radius:12px;background:var(--chip)}.who{font-weight:600}
.note{margin:0;font-size:13px;line-height:1.35;color:var(--muted);max-width:440px}
</style></head><body>
<h1 id="title" data-agent="${agent}">Call with ${agent}</h1>
<div>You are joining as <b>${escapeHtml(personName)}</b></div>
<div id="status">Tap Join, then allow the microphone.</div>
<button id="join">Join</button>
<div id="ctl" hidden><button id="mute">Mute</button> <button id="leave">Leave</button></div>
<div id="people"></div>
<div id="log"></div>
<p class="note">Say "${agent}" when you want it. Everyone on the call hears the conversation, and requests to ${agent} appear in the ${escapeHtml(platform)} thread with a best guess at who asked. Keep this page open with the screen on.</p>
<script src="/lk.js"></script>
<script>
${keepPinned.toString()}
${joinMicFirst.toString()}
${micReportPageScript()}
const $ = (id) => document.getElementById(id);
const agent = $('title').dataset.agent;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
let room = null, wake = null, pageToken = null, events = null, voiceLine = null;
const lock = async () => { try { wake = await navigator.wakeLock.request('screen'); } catch {} };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && room) lock(); });
const line = (who, text) => {
  const el = document.createElement('div');
  el.className = 'line';
  el.innerHTML = '<span class="who">' + esc(who) + ':</span> <span class="text"></span>';
  el.querySelector('.text').textContent = text;
  keepPinned($('log'), () => {
    $('log').appendChild(el);
    while ($('log').children.length > 12) $('log').firstChild.remove();
  });
  return el;
};
const render = () => {
  if (!room) return;
  const talking = new Set(room.activeSpeakers.map((p) => p.identity));
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  $('people').innerHTML = all.map((p) => '<span class="p' + (talking.has(p.identity) ? ' on' : '') + '">' + esc(p.name || 'Someone') + (p === room.localParticipant ? ' (you)' : '') + '</span>').join('');
};
const end = (text) => {
  $('status').textContent = text;
  $('ctl').hidden = true;
  if (events) events.close();
  if (room) room.disconnect();
  room = null;
};
const listen = () => {
  events = new EventSource('/events?t=' + pageToken);
  events.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'status') $('status').textContent = e.text;
    else if (e.type === 'request') line(e.speaker + ' to ' + agent, e.text);
    else if (e.type === 'shared') line(e.speaker, 'Shared ' + e.file);
    else if (e.type === 'caption') {
      if (!voiceLine) voiceLine = line(agent, '');
      keepPinned($('log'), () => (voiceLine.querySelector('.text').textContent += e.text));
      if (e.done) voiceLine = null;
    } else if (e.type === 'ended') end(e.text);
  };
};
$('join').onclick = async () => {
  $('join').disabled = true;
  $('status').textContent = 'Connecting…';
  try {
    const r = await fetch('/claim', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'This link no longer works.');
    const claim = await r.json();
    pageToken = claim.pageToken;
    const L = window.LivekitClient;
    room = new L.Room({ adaptiveStream: false, dynacast: false });
    room.on('trackSubscribed', (track) => { if (track.kind === 'audio') document.body.appendChild(track.attach()); render(); });
    room.on('trackUnsubscribed', (track) => { track.detach().forEach((el) => el.remove()); render(); });
    for (const ev of ['participantConnected', 'participantDisconnected', 'activeSpeakersChanged']) room.on(ev, render);
    room.on('reconnecting', () => ($('status').textContent = 'Reconnecting…'));
    room.on('reconnected', () => ($('status').textContent = 'In the call'));
    room.on('disconnected', (reason) => {
      if (room) end(reason === L.DisconnectReason.PARTICIPANT_REMOVED ? 'You were removed from the call.' : 'The call ended for you.');
    });
    const mic = await joinMicFirst(L, room, claim);
    listen();
    lock();
    $('status').textContent = 'In the call';
    $('ctl').hidden = false;
    $('join').hidden = true;
    render();
    try {
      const report = pageMicReport(mic.mediaStreamTrack, navigator.userAgent, MIC_SETTINGS);
      fetch('/mic?t=' + pageToken, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) }).catch(() => {});
    } catch {}
  } catch (e) {
    $('status').textContent = 'Could not join: ' + (e && e.message ? e.message : e);
    if (room) room.disconnect();
    room = null;
  }
};
$('mute').onclick = async () => {
  const on = room.localParticipant.isMicrophoneEnabled;
  await room.localParticipant.setMicrophoneEnabled(!on);
  $('mute').textContent = on ? 'Unmute' : 'Mute';
};
$('leave').onclick = () => {
  fetch('/leave?t=' + pageToken, { method: 'POST' }).catch(() => {});
  end('You left the call.');
};
</script></body></html>`;
}
