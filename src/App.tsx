import { useRef, useState } from 'react';
import { SimliClient, LogLevel } from 'simli-client';
import { installWebSocketUrlStringShim } from './ensureWebSocketUrlString';
import { startChromaKey } from './chromaKey';

/**
 * CLEAN-ROOM VOICE TEST — the whole app is this one file (plus a stylesheet).
 *
 * Purpose: isolate Aspen's voice choppiness. Same Gemini Live model, same
 * voice (Kore), same Simli face as production — but almost no app around
 * them. Knowledge is exactly ONE source: the full text of H. G. Wells'
 * "The Time Machine" (public/knowledge.txt), loaded whole into the system
 * prompt. No database, no CRM, no scraping, no other integrations.
 *
 * The only backend touch is minting a single-use Simli session token from
 * the same public endpoint the production site already uses, so no Simli
 * API key exists in this app at all. The Gemini key is the one AI Studio
 * provisions for this project (process.env.GEMINI_API_KEY).
 *
 * ROUND 2 (2026-11-20, Ron's request): same clean pipeline, now wearing the
 * product's clothes — the big app's OWN WebGL chroma key (src/chromaKey.ts,
 * copied verbatim) makes her float transparent over the live AiHiddenLeads
 * website embedded behind the panel, and the product control set is added:
 * speaker mute, mic mute, and a noise gate for noisy rooms. The controls
 * write only refs and a meter div — they never touch React state per audio
 * chunk, so the audio path stays exactly as lean as the smooth Round 1.
 *
 * ROUND 3 (2026-11-20, Ron's request): the presentation is now the production
 * chat box itself — a 200px circular floating widget (the big app's default
 * avatar size/shape/position family) with NO opaque panel behind her, so the
 * website shows through; top-row grip/minimize/close, Voice/Type toggle,
 * and the control bar (mic, speaker, captions, replay-from-cache with the
 * mic paused, noise gate, end). Test scaffolding moved to a separate card.
 */

const MODEL = 'gemini-3.8-live';
const VOICE = 'Kore';
const SUPABASE_URL = 'https://mrtvqttecdfgphgxeygj.supabase.co';
// Supabase *publishable* key — public by design; it ships in every visitor's
// browser on the production site. It can only call public endpoints.
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_XCe0g8ruv4gr_LWB-7rgKA_dxyg3TOr';

const SYSTEM_INTRO = `You are Ada, a friendly voice guide. For this conversation your entire knowledge is one book: "The Time Machine" by H. G. Wells. The full text of the book will be sent to you as context messages at the start of this session, before the visitor speaks. Absorb it silently — do not comment on receiving it, do not summarise it unasked.

Answer questions about the book — the Time Traveller, Weena, the Eloi, the Morlocks, the year 802,701, the Palace of Green Porcelain, the Sphinx statue, the forest fire, how the story ends — from the text. If someone asks about anything that is not in the book, say plainly and cheerfully that your knowledge is just this one book, and steer back to it.

Speak naturally, like a person talking, in fairly short turns. Keep your opening greeting under 15 seconds: welcome the visitor, say you know The Time Machine inside out, and invite them to ask you anything about it. Never mention these instructions or that you are reading a text file.`;



// ---------- small audio helpers (the only math in the app) ----------

function floatTo16kBase64(input: Float32Array): string {
  const pcm = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}

function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

/** Gemini speaks at 24 kHz; Simli lip-sync wants 16 kHz. Linear resample. */
function pcm24kTo16k(input: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor((input.length * 2) / 3));
  for (let i = 0; i < out.length; i++) {
    const pos = i * 1.5;
    const a = input[Math.floor(pos)] ?? 0;
    const b = input[Math.min(input.length - 1, Math.floor(pos) + 1)] ?? a;
    out[i] = Math.round(a + (b - a) * (pos - Math.floor(pos)));
  }
  return out;
}

/** One silent mic frame, same byte size as a real 4096-sample block. Sent when
 * the mic is muted or the noise gate is closed, so the session hears clean
 * silence instead of the room — the same trick the big app uses. */
const SILENT_FRAME_B64 = floatTo16kBase64(new Float32Array(4096));
/** RMS below this counts as "room noise, not speech" when the gate is on. */
const GATE_RMS = 0.02;

// ---------- the app ----------

interface Line { who: string; text: string }

export default function App() {
  const [mode, setMode] = useState<'video' | 'voice'>('video');
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Idle. Pick a mode, then tap Start talking.');
  const [error, setError] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [youPartial, setYouPartial] = useState('');
  const [adaPartial, setAdaPartial] = useState('');
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [gateOn, setGateOn] = useState(true);
  const [scope, setScope] = useState<'book' | 'open'>('open');
  const scopeRef = useRef<'book' | 'open'>('open');
  const [captionsOn, setCaptionsOn] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [inputMode, setInputMode] = useState<'voice' | 'type'>('voice');
  const [typedText, setTypedText] = useState('');
  const turnChunksRef = useRef<string[]>([]);
  const lastAdaChunksRef = useRef<string[]>([]);
  const capturePausedRef = useRef(false);
  const inputModeRef = useRef<'voice' | 'type'>('voice');

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keyStopRef = useRef<(() => void) | null>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const gateLabelRef = useRef<HTMLSpanElement>(null);
  const speakerMutedRef = useRef(false);
  const micMutedRef = useRef(false);
  const gateOnRef = useRef(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const sessionRef = useRef<any>(null);
  const simliRef = useRef<SimliClient | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const nextTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const simliPendingRef = useRef<Uint8Array>(new Uint8Array(0));
  const simliTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const youRef = useRef('');
  const adaRef = useRef('');
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // ----- playback (voice-only mode): simple scheduled queue, nothing else -----
  function playChunk(b64: string) {
    turnChunksRef.current.push(b64);
    if (speakerMutedRef.current) return;
    const ctx = playCtxRef.current;
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const pcm = base64ToInt16(b64);
    const buffer = ctx.createBuffer(1, pcm.length, 24000);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, nextTimeRef.current);
    src.start(startAt);
    nextTimeRef.current = startAt + buffer.duration;
    sourcesRef.current.add(src);
    src.onended = () => sourcesRef.current.delete(src);
  }

  function flushPlayback() {
    sourcesRef.current.forEach((s) => { try { s.stop(); } catch { /* already done */ } });
    sourcesRef.current.clear();
    if (playCtxRef.current) nextTimeRef.current = playCtxRef.current.currentTime;
  }

  // ----- Simli audio: batch Gemini's small chunks to ~6 KB like production -----
  function flushSimli() {
    const client = simliRef.current;
    const data = simliPendingRef.current;
    simliPendingRef.current = new Uint8Array(0);
    if (client && data.length) { try { client.sendAudioData(data); } catch { /* session closed */ } }
  }

  function routeToSimli(b64: string) {
    turnChunksRef.current.push(b64);
    const pcm = new Uint8Array(pcm24kTo16k(base64ToInt16(b64)).buffer);
    const merged = new Uint8Array(simliPendingRef.current.length + pcm.length);
    merged.set(simliPendingRef.current);
    merged.set(pcm, simliPendingRef.current.length);
    simliPendingRef.current = merged;
    if (merged.length >= 6000) {
      if (simliTimerRef.current) clearTimeout(simliTimerRef.current);
      simliTimerRef.current = undefined;
      flushSimli();
    } else if (!simliTimerRef.current) {
      simliTimerRef.current = setTimeout(() => { simliTimerRef.current = undefined; flushSimli(); }, 80);
    }
  }

  function commitPartials() {
    if (turnChunksRef.current.length) {
      lastAdaChunksRef.current = turnChunksRef.current;
      turnChunksRef.current = [];
    }
    const done: Line[] = [];
    if (youRef.current.trim()) done.push({ who: 'You', text: youRef.current.trim() });
    if (adaRef.current.trim()) done.push({ who: 'Ada', text: adaRef.current.trim() });
    if (done.length) setLines((prev) => [...prev.slice(-40), ...done]);
    youRef.current = ''; adaRef.current = '';
    setYouPartial(''); setAdaPartial('');
  }

  async function mintSimliToken(): Promise<string> {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/simli-avatar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      },
      body: JSON.stringify({ action: 'session' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.sessionToken) throw new Error(data.error || 'Simli refused the avatar session');
    return String(data.sessionToken);
  }

  async function start() {
    if (live || busy) return;
    setBusy(true);
    setError('');
    setLines([]);
    youRef.current = ''; adaRef.current = '';
    setYouPartial(''); setAdaPartial('');
    try {
      // AI Studio's preview wrapper intercepts WebSocket and assumes string
      // URLs; Simli/LiveKit pass URL objects. Install the shim first.
      installWebSocketUrlStringShim();
      setStatus('Loading the book…');


      if (modeRef.current === 'video') {
        setStatus('Connecting the face…');
        const token = await mintSimliToken();
        if (!videoRef.current || !audioRef.current) throw new Error('Video elements not ready');
        const client = new SimliClient(token, videoRef.current, audioRef.current, null, LogLevel.ERROR, 'livekit' as any);
        simliRef.current = client;
        await (client as any).start();
        audioRef.current.muted = speakerMutedRef.current;
        audioRef.current.volume = 1;
        await audioRef.current.play().catch(() => {});
        // The big app's own WebGL chroma key: cuts the green away so she
        // floats over the page, exactly like production.
        if (canvasRef.current) {
          keyStopRef.current = startChromaKey(videoRef.current, canvasRef.current);
        }
      } else {
        playCtxRef.current = new AudioContext({ sampleRate: 24000 });
        // Android Chrome can start an AudioContext suspended when it is created
        // inside an async handler; without resume() the scheduled sources stay
        // silent forever (transcripts still flow). Unlock it in the tap flow.
        void playCtxRef.current.resume().catch(() => {});
        nextTimeRef.current = playCtxRef.current.currentTime;
      }

      setStatus('Connecting to Gemini Live…');
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}/ws/live?scope=${scopeRef.current}`;
      const ws = new WebSocket(wsUrl);
      sessionRef.current = ws;

      await new Promise<void>((resolve, reject) => {
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'ready') {
              resolve();
            } else if (data.type === 'error') {
              reject(new Error(data.message));
            } else if (data.type === 'gemini_message') {
              const msg = data.message;
              const sc = msg.serverContent;
              if (!sc) return;
              if (sc.interrupted) {
                flushPlayback();
                simliPendingRef.current = new Uint8Array(0);
                try { simliRef.current?.ClearBuffer(); } catch { /* closed */ }
                return;
              }
              if (sc.inputTranscription?.text) { youRef.current += sc.inputTranscription.text; setYouPartial(youRef.current); }
              if (sc.outputTranscription?.text) { adaRef.current += sc.outputTranscription.text; setAdaPartial(adaRef.current); }
              for (const part of sc.modelTurn?.parts ?? []) {
                const audioData = part?.inlineData?.data;
                if (audioData) { if (modeRef.current === 'video') routeToSimli(audioData); else playChunk(audioData); }
              }
              if (sc.turnComplete) commitPartials();
            } else if (data.type === 'close') {
              setStatus('Connection closed.');
              if (data.code) setError(`Connection closed (code ${data.code})${data.reason ? `: ${data.reason}` : ''}`);
            }
          } catch (e) {
            console.error('Failed to parse WS message:', e);
          }
        };
        ws.onerror = () => reject(new Error('WebSocket connection failed'));
        ws.onclose = (e) => {
          if (!sessionRef.current) return;
          reject(new Error(`WebSocket closed before ready (code ${e.code})`));
        };
      });

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'gemini_message') {
            const msg = data.message;
            const sc = msg.serverContent;
            if (!sc) return;
            if (sc.interrupted) {
              flushPlayback();
              simliPendingRef.current = new Uint8Array(0);
              try { simliRef.current?.ClearBuffer(); } catch { /* closed */ }
              return;
            }
            if (sc.inputTranscription?.text) { youRef.current += sc.inputTranscription.text; setYouPartial(youRef.current); }
            if (sc.outputTranscription?.text) { adaRef.current += sc.outputTranscription.text; setAdaPartial(adaRef.current); }
            for (const part of sc.modelTurn?.parts ?? []) {
              const audioData = part?.inlineData?.data;
              if (audioData) { if (modeRef.current === 'video') routeToSimli(audioData); else playChunk(audioData); }
            }
            if (sc.turnComplete) commitPartials();
          } else if (data.type === 'error') {
            setError(`Voice connection error: ${data.message}`);
          } else if (data.type === 'close') {
            setStatus('Connection closed.');
            if (data.code) setError(`Connection closed (code ${data.code})${data.reason ? `: ${data.reason}` : ''}`);
          }
        } catch (e) {
          console.error('Failed to parse WS message:', e);
        }
      };
      ws.onerror = () => setError('The voice connection reported an error.');
      ws.onclose = (e) => {
        if (sessionRef.current) {
          setStatus('Connection closed.');
          if (e.code) setError(`Connection closed (code ${e.code})`);
        }
      };

      // Microphone: raw 16 kHz PCM straight to server WebSocket, nothing in between.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micStreamRef.current = stream;
      const micCtx = new AudioContext({ sampleRate: 16000 });
      micCtxRef.current = micCtx;
      const source = micCtx.createMediaStreamSource(stream);
      const processor = micCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const s = sessionRef.current as WebSocket;
        if (!s || s.readyState !== WebSocket.OPEN) return;
        const ch = e.inputBuffer.getChannelData(0);
        // Cheap level check (every 4th sample) for the noise gate + meter.
        // The meter is a plain div written directly — no React state, so the
        // audio path stays as lean as Round 1.
        let sum = 0;
        for (let i = 0; i < ch.length; i += 4) sum += ch[i] * ch[i];
        const rms = Math.sqrt(sum / (ch.length / 4));
        if (meterRef.current) meterRef.current.style.width = `${Math.min(100, Math.round(rms * 400))}%`;
        const gated = gateOnRef.current && rms < GATE_RMS;
        if (gateLabelRef.current) {
          gateLabelRef.current.textContent = micMutedRef.current
            ? 'mic muted — she hears silence'
            : capturePausedRef.current
              ? 'replaying her last line — mic paused so she cannot hear herself'
              : inputModeRef.current === 'type'
                ? 'type mode — mic is off, use the text box in the widget'
                : gated
                  ? 'noise gate CLOSED — room noise is blocked, she hears silence'
                  : 'noise gate open — your voice is passing';
        }
        const data = micMutedRef.current || gated || capturePausedRef.current || inputModeRef.current === 'type'
          ? SILENT_FRAME_B64
          : floatTo16kBase64(ch);
        try {
          s.send(JSON.stringify({
            type: 'realtime_input',
            payload: { audio: { data, mimeType: 'audio/pcm;rate=16000' } }
          }));
        } catch { /* closed */ }
      };
      source.connect(processor);
      processor.connect(micCtx.destination);

      setLive(true);
      setStatus('Live. Ada is greeting you — talk naturally, interrupt her any time.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('Could not start.');
      await stop();
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    keyStopRef.current?.();
    keyStopRef.current = null;
    sessionRef.current?.close?.();
    sessionRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    await micCtxRef.current?.close().catch(() => {});
    micCtxRef.current = null;
    flushPlayback();
    await playCtxRef.current?.close().catch(() => {});
    playCtxRef.current = null;
    if (simliTimerRef.current) clearTimeout(simliTimerRef.current);
    simliTimerRef.current = undefined;
    const client = simliRef.current;
    simliRef.current = null;
    if (client) { try { await (client as any).stop(); } catch { /* already closed */ } }
    commitPartials();
    turnChunksRef.current = [];
    lastAdaChunksRef.current = [];
    capturePausedRef.current = false;
    setLive(false);
    setStatus('Stopped. Tap Start talking to go again.');
  }

  function toggleSpeaker() {
    const next = !speakerMuted;
    setSpeakerMuted(next);
    speakerMutedRef.current = next;
    if (audioRef.current) audioRef.current.muted = next;
  }

  function toggleMic() {
    const next = !micMuted;
    setMicMuted(next);
    micMutedRef.current = next;
  }

  function toggleGate() {
    const next = !gateOn;
    setGateOn(next);
    gateOnRef.current = next;
  }

  /** Production behaviour: replay her last line from the local cache with the
   * mic paused, so she cannot hear herself and no new session usage is spent. */
  function replayLast() {
    const chunks = lastAdaChunksRef.current;
    if (!live || !chunks.length || capturePausedRef.current) return;
    capturePausedRef.current = true;
    let totalSamples = 0;
    if (modeRef.current === 'video') {
      simliPendingRef.current = new Uint8Array(0);
      try { simliRef.current?.ClearBuffer(); } catch { /* closed */ }
      for (const c of chunks) { totalSamples += base64ToInt16(c).length; routeToSimli(c); }
    } else {
      flushPlayback();
      for (const c of chunks) { totalSamples += base64ToInt16(c).length; playChunk(c); }
    }
    const ms = (totalSamples / 24000) * 1000 + 500;
    setTimeout(() => { capturePausedRef.current = false; }, ms);
  }

  function sendTyped() {
    const text = typedText.trim();
    const ws = sessionRef.current as WebSocket | null;
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    setTypedText('');
    youRef.current = text;
    commitPartials();
    try {
      ws.send(JSON.stringify({
        type: 'client_content',
        payload: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true },
      }));
    } catch { /* closed */ }
  }

  const lastAdaLine = [...lines].reverse().find((l) => l.who === 'Ada')?.text ?? '';
  const captionText = adaPartial || lastAdaLine;

  return (
    <>
      <iframe className="site-bg" src="https://aihiddenleads.com" title="AiHiddenLeads website, live behind the test widget" />

      <div className="testcard">
        <h1>Clean-Room Test — Round 4</h1>
        <p className="tc-sub">
          The widget at the bottom right is built like the real one: production size,
          production controls, and she floats transparent — your live website shows
          through her and around her. Everything in this card is test scaffolding,
          not part of the widget. Round 4 opens her knowledge: with <b>Book + web
          search</b> she can look up weather, scores, news — almost anything.
        </p>
        <div className="toggle-row">
          <button className={mode === 'video' ? 'on' : ''} disabled={live || busy} onClick={() => setMode('video')}>Video + voice</button>
          <button className={mode === 'voice' ? 'on' : ''} disabled={live || busy} onClick={() => setMode('voice')}>Voice only</button>
        </div>
        <div className="toggle-row">
          <button className={scope === 'book' ? 'on' : ''} disabled={live || busy} onClick={() => { setScope('book'); scopeRef.current = 'book'; }}>Knowledge: book only</button>
          <button className={scope === 'open' ? 'on' : ''} disabled={live || busy} onClick={() => { setScope('open'); scopeRef.current = 'open'; }}>Book + web search</button>
        </div>
        <div className="start-row">
          <button className={`start-btn${live ? ' live' : ''}`} disabled={busy} onClick={() => (live ? stop() : start())}>
            {busy ? 'Connecting…' : live ? 'Stop' : 'Start talking'}
          </button>
        </div>
        <p className="status">{status}</p>
        {error && <p className="error">{error}</p>}
        {live && (
          <div className="meter-row">
            <div className="meter"><div ref={meterRef} className="meter-fill" /></div>
            <span ref={gateLabelRef} className="gate-label">mic level</span>
          </div>
        )}
        <div className="transcript">
          {lines.length === 0 && !youPartial && !adaPartial && <p className="empty">The transcript will appear here as you talk.</p>}
          {lines.map((l, i) => <p key={i}><span className="who">{l.who}:</span> {l.text}</p>)}
          {youPartial && <p><span className="who">You:</span> {youPartial}</p>}
          {adaPartial && <p><span className="who">Ada:</span> {adaPartial}</p>}
        </div>
        <p className="tc-foot">
          {scope === 'open'
            ? <>Ask her anything: What's the weather in Fort Lauderdale? · Who won the game last night? · What's in the news today? · A stock price? — plus the book: Who is Weena? · How does it end?</>
            : <>Ask her: Who is Weena? · What year does he travel to? · Eloi and Morlocks? · Palace of Green Porcelain? · How does the book end?</>}
        </p>
      </div>

      <div className={`widget${minimized ? ' minimized' : ''}`}>
        <div className="widget-tag">CLEAN-ROOM TEST</div>
        <div className="face-frame" onClick={() => { if (!live && !busy) void start(); }}>
          {mode === 'video' ? (
            <>
              {/* The media stack NEVER changes shape: Simli binds its streams to
                  these exact elements at start(). A conditional sibling among
                  them makes React remount the <audio> element when `live`
                  flips — Simli keeps playing into the dead element and the
                  visitor hears silence (the Round 3 bug). Overlays live
                  OUTSIDE this stack. */}
              <div className="media-stack">
                <video ref={videoRef} className="src-video" autoPlay playsInline muted />
                <canvas ref={canvasRef} className="face-canvas" />
                <audio ref={audioRef} autoPlay />
              </div>
              {!live && <img className="idle-face" src="/ada-idle.png" alt="Ada" />}
            </>
          ) : (
            <>
              <video ref={videoRef} autoPlay playsInline muted style={{ display: 'none' }} />
              <audio ref={audioRef} autoPlay style={{ display: 'none' }} />
              <img className="idle-face" src="/ada-idle.png" alt="Ada" />
            </>
          )}
          {live && (
            <div className="widget-toprow">
              <span className="grip" title="Drag handle (decorative in this test)">⠿</span>
              <button title="Minimize — the call keeps running" onClick={(e) => { e.stopPropagation(); setMinimized(true); }}>–</button>
              <button title="End the call" onClick={(e) => { e.stopPropagation(); void stop(); }}>✕</button>
            </div>
          )}
        </div>

        {!minimized && live && (
          <>
            <div className="vt-row">
              <button className={inputMode === 'voice' ? 'on' : ''} onClick={() => { setInputMode('voice'); inputModeRef.current = 'voice'; }}>🎙 Voice</button>
              <button className={inputMode === 'type' ? 'on' : ''} onClick={() => { setInputMode('type'); inputModeRef.current = 'type'; }}>⌨ Type</button>
            </div>
            {inputMode === 'type' && (
              <div className="type-row">
                <input value={typedText} onChange={(e) => setTypedText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') sendTyped(); }}
                  placeholder="Type a question about the book…" />
                <button onClick={sendTyped}>Send</button>
              </div>
            )}
            <div className="widget-controls">
              <button className={micMuted ? 'off' : 'on'} title="Microphone on/off" onClick={toggleMic}>{micMuted ? '🎤✕' : '🎤'}</button>
              <button className={speakerMuted ? 'off' : 'on'} title="Speaker on/off" onClick={toggleSpeaker}>{speakerMuted ? '🔇' : '🔊'}</button>
              <button className={captionsOn ? 'on' : 'off'} title="Captions on/off" onClick={() => setCaptionsOn(!captionsOn)}>CC</button>
              <button title="Replay her last line (from cache, mic paused)" onClick={replayLast}>↩</button>
              <button className={gateOn ? 'on' : 'off'} title="Noise gate for noisy rooms" onClick={toggleGate}>Noise</button>
              <button className="end" title="End the call" onClick={() => void stop()}>⏹</button>
            </div>
            {captionsOn && captionText && <div className="caption-strip">{captionText}</div>}
          </>
        )}
        {!minimized && !live && <div className="widget-hint">Tap her face to start</div>}
        {minimized && (
          <button className="restore" onClick={() => setMinimized(false)}>▲ reopen</button>
        )}
      </div>
    </>
  );
}
