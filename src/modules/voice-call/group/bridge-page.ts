import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let livekitScript: string | null = null;

export function livekitClientScript(): string {
  livekitScript ??= readFileSync(require.resolve('livekit-client'), 'utf8');
  return livekitScript;
}

/** Mixes each person's track for the voice and meters it per person, on one audio clock (20 ms frames). */
const METER_WORKLET = String.raw`
class Meter extends AudioWorkletProcessor {
  constructor() { super(); this.F = 960; this.sum = new Float64Array(8); this.cur = -1; this.buf = []; this.first = -1; }
  process(inputs) {
    const ch = inputs[0];
    const n = ch.length ? ch[0].length : 128;
    for (let j = 0; j < n; j++) {
      const f = Math.floor((currentFrame + j) / this.F);
      if (f !== this.cur) {
        if (this.cur >= 0) {
          const row = new Array(8);
          for (let c = 0; c < 8; c++) { const x = Math.sqrt(this.sum[c] / this.F); row[c] = x > 0 ? Math.round(200 * Math.log10(x)) : -1200; }
          this.buf.push(row);
          if (this.first < 0) this.first = this.cur;
        }
        this.cur = f; this.sum.fill(0);
      }
      for (let c = 0; c < ch.length && c < 8; c++) { const x = ch[c][j]; this.sum[c] += x * x; }
    }
    if (this.buf.length >= 25) { this.port.postMessage({ first: this.first, rows: this.buf }); this.buf = []; this.first = -1; }
    return true;
  }
}
registerProcessor('meter', Meter);`;

/**
 * Runs in the bridge's Chromium after the LiveKit client: joins the room, mixes every person into one track for the
 * voice service, publishes the voice back into the room, and keeps per-person loudness and the service's transcript
 * pieces on the same audio clock so the host can tell who spoke a request.
 */
export const BRIDGE_SCRIPT = String.raw`
(async () => {
  const L = window.LivekitClient;
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
  await ctx.resume();
  const SLOTS = 8;
  const merger = ctx.createChannelMerger(SLOTS);
  const mixBus = ctx.createGain();
  const mixOut = ctx.createMediaStreamDestination();
  mixBus.connect(mixOut);
  const silent = ctx.createGain(); silent.gain.value = 0; silent.connect(ctx.destination);
  const url = URL.createObjectURL(new Blob([${JSON.stringify(METER_WORKLET)}], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const meter = new AudioWorkletNode(ctx, 'meter', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: SLOTS, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
  let frames = [];
  meter.port.onmessage = (e) => { e.data.rows.forEach((row, i) => frames.push([e.data.first + i, ...row])); if (frames.length > 6000) frames = frames.slice(-6000); };
  merger.connect(meter); meter.connect(silent);
  const slots = {};
  const sources = {};
  const keep = [];
  let room = null, live = null, pieces = [], delegations = [], voice = null;
  // Chrome feeds a remote WebRTC stream into Web Audio only while a media element is playing it, muted or not.
  const play = (stream) => { const el = new Audio(); el.muted = true; el.srcObject = stream; el.play().catch(() => {}); keep.push(el); };
  const freeSlot = () => { const used = new Set(Object.values(slots)); for (let s = 0; s < SLOTS - 1; s++) if (!used.has(s)) return s; return -1; };
  const detach = (id) => { const s = sources[id]; if (!s) return; try { s.disconnect(); } catch {} delete sources[id]; delete slots[id]; };
  window.B = {
    async join(roomUrl, token) {
      room = new L.Room({ adaptiveStream: false, dynacast: false, disconnectOnPageLeave: false });
      room.on('trackSubscribed', (track, pub, participant) => {
        if (track.kind !== 'audio') return;
        const id = participant.identity;
        detach(id);
        const slot = freeSlot();
        if (slot < 0) return;
        const stream = new MediaStream([track.mediaStreamTrack]);
        play(stream);
        const source = ctx.createMediaStreamSource(stream);
        source.connect(mixBus); source.connect(merger, 0, slot);
        sources[id] = source; slots[id] = slot;
      });
      room.on('trackUnsubscribed', (t, p, participant) => detach(participant.identity));
      room.on('participantDisconnected', (participant) => detach(participant.identity));
      // LiveKit sends this once a person's copy of the track is connected, so what the voice says from then on is heard.
      room.on(L.RoomEvent.LocalTrackSubscribed, (pub) => { if (pub.trackName === 'voice') voice = 'heard'; });
      await room.connect(roomUrl, token, { autoSubscribe: true });
      return true;
    },
    async liveOffer() {
      const pc = new RTCPeerConnection();
      live = pc;
      pc.addTrack(mixOut.stream.getAudioTracks()[0], mixOut.stream);
      const dc = pc.createDataChannel('oai-events');
      dc.onmessage = (e) => {
        let ev; try { ev = JSON.parse(e.data); } catch { return; }
        if (ev.type === 'input_transcript.added' && ev.item && typeof ev.item.text === 'string')
          pieces.push({ at: ctx.currentTime, startMs: ev.start_ms, endMs: ev.end_ms, text: ev.item.text });
        if (ev.type === 'delegation.created' && ev.item && typeof ev.item.id === 'string') delegations.push({ id: ev.item.id, at: ctx.currentTime });
      };
      pc.ontrack = async (e) => {
        play(e.streams[0]);
        const out = ctx.createMediaStreamDestination();
        ctx.createMediaStreamSource(e.streams[0]).connect(out);
        await room.localParticipant.publishTrack(out.stream.getAudioTracks()[0], { source: L.Track.Source.Microphone, name: 'voice', dtx: false });
        voice ??= 'published';
      };
      await pc.setLocalDescription(await pc.createOffer());
      return pc.localDescription.sdp;
    },
    async liveAnswer(sdp) { await live.setRemoteDescription({ type: 'answer', sdp }); return true; },
    collect() {
      const out = { frames, pieces, delegations, slots: { ...slots }, live: live ? live.connectionState : null, voice, room: room ? room.state : null, people: Object.keys(sources) };
      frames = []; pieces = []; delegations = [];
      return out;
    },
    leave() { try { live && live.close(); } catch {} try { room && room.disconnect(); } catch {} return true; },
  };
  return true;
})()`;
