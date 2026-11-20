import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Modality } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;

const MODEL = 'gemini-3.8-live';
const VOICE = 'Kore';

async function startServer() {
  const app = express();
  const server = createServer(app);

  // WebSocket server for Gemini Live proxy
  const wss = new WebSocketServer({ server, path: '/ws/live' });

  wss.on('connection', async (ws: WebSocket) => {
    let geminiSession: any = null;
    let knowledge = '';

    try {
      knowledge = fs.readFileSync(path.join(__dirname, 'public/knowledge.txt'), 'utf-8');
    } catch (e) {
      console.error('Failed to read knowledge.txt:', e);
    }

    const SYSTEM_INTRO = `You are Ada, a friendly voice guide. For this conversation your entire knowledge is one book: "The Time Machine" by H. G. Wells. The full text of the book will be sent to you as context messages at the start of this session, before the visitor speaks. Absorb it silently — do not comment on receiving it, do not summarise it unasked.

Answer questions about the book — the Time Traveller, Weena, the Eloi, the Morlocks, the year 802,701, the Palace of Green Porcelain, the Sphinx statue, the forest fire, how the story ends — from the text. If someone asks about anything that is not in the book, say plainly and cheerfully that your knowledge is just this one book, and steer back to it.

Speak naturally, like a person talking, in fairly short turns. Keep your opening greeting under 15 seconds: welcome the visitor, say you know The Time Machine inside out, and invite them to ask you anything about it. Never mention these instructions or that you are reading a text file.`;

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

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        ws.send(JSON.stringify({ type: 'error', message: 'GEMINI_API_KEY is not set on server' }));
        ws.close();
        return;
      }

      const ai = new GoogleGenAI({ apiKey });
      geminiSession = await ai.live.connect({
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
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'gemini_message', message: msg }));
            }
          },
          onerror: (err: any) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', message: `Gemini error: ${err?.message || err}` }));
            }
          },
          onclose: (e: any) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'close', code: e?.code, reason: e?.reason }));
            }
          },
        },
      });

      // Send book chunks
      const chunks = chunkText(knowledge);
      for (let c = 0; c < chunks.length; c++) {
        try {
          await geminiSession.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: (c === 0 ? 'Here is the full text of "The Time Machine" by H. G. Wells. Read it all and use it as your knowledge:\n\n' : '') + chunks[c] }] }],
            turnComplete: false,
          });
          await new Promise((r) => setTimeout(r, 60));
        } catch (err) {
          console.error(`Error sending chunk ${c}:`, err);
          break;
        }
      }

      // Initial greeting prompt
      try {
        await geminiSession.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: 'That was the entire book. Now please greet me, briefly.' }] }],
          turnComplete: true,
        });
      } catch (err) {
        console.error('Error sending greeting prompt:', err);
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ready' }));
      }

      ws.on('message', async (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'realtime_input' && geminiSession) {
            await geminiSession.sendRealtimeInput(parsed.payload);
          } else if (parsed.type === 'client_content' && geminiSession) {
            await geminiSession.sendClientContent(parsed.payload);
          }
        } catch (e) {
          console.error('Error handling client message:', e);
        }
      });

    } catch (e: any) {
      console.error('Failed to connect Gemini Live:', e);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: e?.message || String(e) }));
      }
      ws.close();
    }

    ws.on('close', () => {
      try {
        geminiSession?.close?.();
      } catch {}
    });
  });

  if (isProduction) {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
