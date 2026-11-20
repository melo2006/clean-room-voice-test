import { useRef, useState } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { SimliClient, LogLevel } from 'simli-client';
import { installWebSocketUrlStringShim } from './ensureWebSocketUrlString';

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

/** Split the book into ~24 KB context chunks (paragraph-safe where easy). */
function chunkText(text: string, size = 24000): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > i + size / 2) end = nl + 1;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

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

  const videoRef = useRef<HTMLVideoElement>(null);
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
    const ctx = playCtxRef.current;
    if (!ctx) return;
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
      const knowledge = await (await fetch('/knowledge.txt')).text();

      if (modeRef.current === 'video') {
        setStatus('Connecting the face…');
        const token = await mintSimliToken();
        if (!videoRef.current || !audioRef.current) throw new Error('Video elements not ready');
        const client = new SimliClient(token, videoRef.current, audioRef.current, null, LogLevel.ERROR, 'livekit' as any);
        simliRef.current = client;
        await (client as any).start();
        audioRef.current.muted = false;
        audioRef.current.volume = 1;
        await audioRef.current.play().catch(() => {});
      } else {
        playCtxRef.current = new AudioContext({ sampleRate: 24000 });
        nextTimeRef.current = playCtxRef.current.currentTime;
      }

      setStatus('Connecting to Gemini Live…');
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const session = await ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
          systemInstruction: SYSTEM_INTRO,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        } as any,
        callbacks: {
          onmessage: (msg: any) => {
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
              const data = part?.inlineData?.data;
              if (data) { if (modeRef.current === 'video') routeToSimli(data); else playChunk(data); }
            }
            if (sc.turnComplete) commitPartials();
          },
          onerror: (e: any) => setError(`Voice connection error: ${e?.message || e || 'unknown'}`),
          onclose: (e: any) => {
            if (sessionRef.current) {
              setStatus('Connection closed.');
              if (e?.code) setError(`Connection closed (code ${e.code})${e?.reason ? `: ${e.reason}` : ''}`);
            }
          },
        },
      });
      sessionRef.current = session;

      // Send the whole book as context AFTER setup completes — putting all
      // 182 KB inside the setup frame itself made Google close the socket
      // (1011) before setup finished. Chunks of ~24 KB, then the greeting.
      const chunks = chunkText(knowledge);
      for (let c = 0; c < chunks.length; c++) {
        setStatus(`Sending the book to Ada… (${c + 1}/${chunks.length})`);
        session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: (c === 0 ? 'Here is the full text of "The Time Machine" by H. G. Wells. Read it all and use it as your knowledge:\n\n' : '') + chunks[c] }] }],
          turnComplete: false,
        });
        await new Promise((r) => setTimeout(r, 60));
      }

      // Microphone: raw 16 kHz PCM straight to Gemini, nothing in between.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micStreamRef.current = stream;
      const micCtx = new AudioContext({ sampleRate: 16000 });
      micCtxRef.current = micCtx;
      const source = micCtx.createMediaStreamSource(stream);
      const processor = micCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const s = sessionRef.current;
        if (!s) return;
        const data = floatTo16kBase64(e.inputBuffer.getChannelData(0));
        try { s.sendRealtimeInput({ audio: { data, mimeType: 'audio/pcm;rate=16000' } }); }
        catch { try { s.sendRealtimeInput({ media: { data, mimeType: 'audio/pcm;rate=16000' } }); } catch { /* closed */ } }
      };
      source.connect(processor);
      processor.connect(micCtx.destination);

      setLive(true);
      setStatus('Live. Ada is greeting you — talk naturally, interrupt her any time.');
      try {
        session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'That was the entire book. Now please greet me, briefly.' }] }], turnComplete: true });
      } catch { /* she will answer as soon as you speak instead */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('Could not start.');
      await stop();
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
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
    setLive(false);
    setStatus('Stopped. Tap Start talking to go again.');
  }

  return (
    <div className="page">
      <h1>Clean-Room Voice Test</h1>
      <p className="sub">
        One tiny app. Gemini Live + a Simli face, and exactly one knowledge source:
        the full text of <i>The Time Machine</i> by H. G. Wells (32,306 words).
        Nothing else is in here — that is the point of the test.
      </p>

      <div className="panel">
        {mode === 'video' && (
          <div className="video-wrap">
            <div className="video-box">
              <video ref={videoRef} autoPlay playsInline muted />
            </div>
            <audio ref={audioRef} autoPlay />
          </div>
        )}
        {mode === 'voice' && (
          <>
            <video ref={videoRef} autoPlay playsInline muted style={{ display: 'none' }} />
            <audio ref={audioRef} autoPlay style={{ display: 'none' }} />
          </>
        )}

        <div className="toggle-row">
          <button className={mode === 'video' ? 'on' : ''} disabled={live || busy} onClick={() => setMode('video')}>Video + voice</button>
          <button className={mode === 'voice' ? 'on' : ''} disabled={live || busy} onClick={() => setMode('voice')}>Voice only</button>
        </div>

        <div className="start-row">
          <button className={`start-btn${live ? ' live' : ''}`} disabled={busy} onClick={() => (live ? stop() : start())}>
            {busy ? 'Connecting…' : live ? 'Stop' : 'Start talking'}
          </button>
        </div>

        <p className="status">{status}</p>
        {error && <p className="error">{error}</p>}

        <div className="transcript">
          {lines.length === 0 && !youPartial && !adaPartial && <p className="empty">The transcript will appear here as you talk.</p>}
          {lines.map((l, i) => <p key={i}><span className="who">{l.who}:</span> {l.text}</p>)}
          {youPartial && <p><span className="who">You:</span> {youPartial}</p>}
          {adaPartial && <p><span className="who">Ada:</span> {adaPartial}</p>}
        </div>
      </div>

      <div className="ideas">
        <b>Questions she should nail:</b> Who is Weena? · What year does the Time Traveller
        travel to? · What are the Eloi and the Morlocks? · What is the Palace of Green Porcelain? ·
        How does the book end? · What did he bring back as proof?
      </div>

      <p className="footer">
        Model: gemini-3.8-live · Voice: Kore (same as Aspen) · Face: same Simli face as the live site ·
        Knowledge: one book, loaded whole — no database, no retrieval, no other integrations.
      </p>
    </div>
  );
}
