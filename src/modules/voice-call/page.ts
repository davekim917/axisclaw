import { micReportPageScript } from './mic-report.js';

const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function callPageHtml(agentName: string): string {
  const name = escapeHtml(agentName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Call ${name}</title>
<style>
  :root { --bg: #f6f5f2; --fg: #1d1c1a; --muted: #6d6a64; --accent: #1f7a4d; --danger: #b3261e; --card: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151513; --fg: #f1efea; --muted: #a29e96; --accent: #45b27c; --danger: #f07167; --card: #1f1e1b; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 28px; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 16px/1.4 -apple-system, system-ui, sans-serif; }
  h1 { margin: 0; font-size: 28px; font-weight: 650; }
  #status { color: var(--muted); min-height: 1.4em; text-align: center; max-width: 32ch; }
  #caption { color: var(--muted); text-align: center; max-width: 40ch; min-height: 4.2em; display: -webkit-box;
    -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
  #orb { width: 132px; height: 132px; border-radius: 50%; background: var(--card); box-shadow: 0 0 0 0 var(--accent);
    display: grid; place-items: center; font-size: 44px; transition: box-shadow .25s; }
  #orb.live { box-shadow: 0 0 0 10px color-mix(in srgb, var(--accent) 25%, transparent); }
  .row { display: flex; gap: 16px; }
  button { font: inherit; border: 0; border-radius: 999px; padding: 14px 26px; min-width: 120px; cursor: pointer; }
  #start { background: var(--accent); color: #fff; }
  #mute { background: var(--card); color: var(--fg); }
  #hangup { background: var(--danger); color: #fff; }
  #hear { background: var(--accent); color: #fff; }
  button[hidden] { display: none; }
</style>
</head>
<body>
  <h1>${name}</h1>
  <div id="orb" aria-hidden="true">☎</div>
  <div id="status">Tap Call to start. Use headphones for the best audio.</div>
  <div class="row">
    <button id="start">Call</button>
    <button id="mute" hidden>Mute</button>
    <button id="hangup" hidden>Hang up</button>
  </div>
  <button id="hear" hidden>Tap to hear</button>
  <div id="caption" aria-live="polite"></div>
  <audio id="out" autoplay playsinline></audio>
<script>
${micReportPageScript()}
(() => {
  const $ = (id) => document.getElementById(id);
  const status = (text) => { $('status').textContent = text; };
  const TAP_TO_HEAR = 'Tap "Tap to hear" to hear the voice.';
  let pc, mic, wake, events, connecting, sampler, connectedAt = 0, token = '', ended = false, leaving = false, silent = false;
  let playback = 'none', report = null, micReported = false;
  const withToken = (path) => path + '?t=' + encodeURIComponent(token);
  const post = (path, body) => fetch(withToken(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const finish = (text) => {
    if (ended) return;
    ended = true;
    status(text);
    $('orb').classList.remove('live');
    $('mute').hidden = $('hangup').hidden = true;
    clearTimeout(connecting);
    clearInterval(sampler);
    $('hear').hidden = true;
    try { events && events.close(); } catch {}
    try { pc && pc.close(); } catch {}
    try { mic && mic.getTracks().forEach((t) => t.stop()); } catch {}
    try { wake && wake.release(); } catch {}
  };
  const sample = async () => {
    if (!pc) return report;
    try {
      const stats = await pc.getStats();
      const r = { inBytes: 0, inPackets: 0, inLost: 0, inEnergy: 0, outBytes: 0, outPackets: 0, rttMs: null, path: null, protocol: null };
      let pairId = null;
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') {
          r.inBytes += s.bytesReceived || 0; r.inPackets += s.packetsReceived || 0;
          r.inLost += s.packetsLost || 0; r.inEnergy += s.totalAudioEnergy || 0;
        }
        if (s.type === 'outbound-rtp' && s.kind === 'audio') { r.outBytes += s.bytesSent || 0; r.outPackets += s.packetsSent || 0; }
        if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
      });
      const pair = pairId && stats.get(pairId);
      const local = pair && stats.get(pair.localCandidateId);
      if (pair && typeof pair.currentRoundTripTime === 'number') r.rttMs = Math.round(pair.currentRoundTripTime * 1000);
      if (local) { r.path = local.candidateType || null; r.protocol = local.protocol || null; }
      report = { ...r, playback, outPaused: $('out').paused };
      if (!silent && !ended && connectedAt && Date.now() - connectedAt > 10000 && r.inPackets === 0) {
        silent = true;
        status('No sound is reaching this phone. This network may be blocking call audio.');
      }
    } catch {}
    return report;
  };
  const leave = async (text, dropped) => {
    if (ended || leaving) return;
    leaving = true;
    $('mute').hidden = $('hangup').hidden = true;
    if (token) post('hangup', { dropped, stats: await sample() });
    finish(text);
  };
  const drop = (text) => leave(text, true);
  const play = () => $('out').play().then(
    () => {
      playback = 'playing';
      $('hear').hidden = true;
      if (connectedAt && $('status').textContent === TAP_TO_HEAR) status('Live');
    },
    (err) => {
      if (!err || err.name !== 'NotAllowedError') return;
      playback = 'blocked';
      $('hear').hidden = false;
      status(TAP_TO_HEAR);
    },
  );
  const caption = (() => {
    const lines = { caller: '', voice: '' };
    const open = { caller: false, voice: false };
    const NAMES = { caller: 'You', voice: document.querySelector('h1').textContent };
    return ({ role, text, done }) => {
      if (!(role in lines)) return;
      if (done) { open[role] = false; return; }
      if (!open[role]) { lines[role] = ''; open[role] = true; }
      lines[role] += text;
      const shown = lines[role].trim();
      if (shown) $('caption').textContent = NAMES[role] + ': ' + (shown.length > 240 ? '…' + shown.slice(-240) : shown);
    };
  })();
  const micNote = () => {
    try { return pageMicReport(mic.getAudioTracks()[0], navigator.userAgent, MIC_SETTINGS); } catch { return {}; }
  };
  const keepAwake = async () => { try { wake = await navigator.wakeLock.request('screen'); } catch {} };
  document.addEventListener('visibilitychange', () => { if (!ended && document.visibilityState === 'visible') keepAwake(); });
  $('start').onclick = async () => {
    $('start').hidden = true;
    status('Connecting…');
    $('out').play().catch(() => {});
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      pc = new RTCPeerConnection();
      pc.ontrack = (e) => { $('out').srcObject = e.streams[0]; play(); };
      mic.getAudioTracks().forEach((t) => pc.addTrack(t, mic));
      pc.createDataChannel('oai-events');
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          clearTimeout(connecting);
          connectedAt = Date.now();
          $('orb').classList.add('live');
          status(playback === 'blocked' ? TAP_TO_HEAR : 'Live');
          post('connected', micReported ? {} : micNote());
          micReported = true;
        }
        if (pc.connectionState === 'failed') drop('The call dropped.');
      };
      await pc.setLocalDescription(await pc.createOffer());
      const res = await post('offer', { sdp: pc.localDescription.sdp });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'The call could not start.');
      token = body.token;
      await pc.setRemoteDescription({ type: 'answer', sdp: body.answer });
      events = new EventSource(withToken('events'));
      events.onerror = () => { if (events.readyState === EventSource.CLOSED) drop('The call was cut off.'); };
      events.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'status') status(msg.text);
        if (msg.type === 'caption') caption(msg);
        if (msg.type === 'ended') finish(msg.text);
      };
      keepAwake();
      $('mute').hidden = $('hangup').hidden = false;
      sampler = setInterval(sample, 5000);
      if (pc.connectionState !== 'connected') {
        status('Connecting audio…');
        connecting = setTimeout(() => drop("Audio couldn't connect on this network."), 30000);
      }
    } catch (err) {
      drop(err && err.message ? err.message : 'The call could not start.');
    }
  };
  $('mute').onclick = () => {
    const track = mic && mic.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    $('mute').textContent = track.enabled ? 'Mute' : 'Unmute';
  };
  $('hear').onclick = () => play();
  $('hangup').onclick = () => leave('Call ended.', false);
  window.addEventListener('pagehide', () => {
    if (!ended && token) navigator.sendBeacon(withToken('hangup'), JSON.stringify({ stats: report }));
  });
})();
</script>
</body>
</html>`;
}
