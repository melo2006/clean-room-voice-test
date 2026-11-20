# Clean-Room Voice Test — Gemini Live + Simli

A deliberately tiny app built to isolate one question: **is Aspen's voice
choppiness caused by the weight of the big AiHiddenLeads app, or by the
underlying Gemini Live / Simli path itself?**

## What's in it

- One page, one component (`src/App.tsx`, ~330 lines), one stylesheet.
- **Gemini Live** (`gemini-3.8-live`, voice **Kore** — the same model and
  voice as production Aspen), connected directly from the browser using the
  `@google/genai` SDK.
- **Simli** avatar (the same face as the live site) via `simli-client`,
  with a Video + voice / Voice-only toggle.
- **Exactly one knowledge source:** the full text of *The Time Machine* by
  H. G. Wells (Project Gutenberg #35, public domain, 32,306 words), in
  `public/knowledge.txt`, loaded whole into the system prompt at session
  start. No database, no retrieval/RAG, no scraping, no other integrations.

## Credentials (no keys in this repo)

- **Gemini:** AI Studio provisions `GEMINI_API_KEY` for this project
  automatically; `vite.config.ts` exposes it to the app the standard
  AI Studio way.
- **Simli:** there is no Simli key in this app. A single-use session token
  is minted by the same public `simli-avatar` endpoint the production site
  already uses (called with the Supabase *publishable* key, which is public
  by design). The real Simli key never leaves the existing server.

## How to run the A/B test

1. **Voice only**, ~2 minutes of natural conversation.
2. **Video + voice**, ~2 minutes.
3. A longer ~5 minute conversation asking real questions from the book
   (suggestions are printed on the page).

Reading the result:

- Voice smooth + video choppy → Simli / video rendering path.
- Both choppy → the Gemini Live path itself (or the connection to it).
- Both smooth → the big app's weight is the likely cause, and the hunt
  moves back to AiHiddenLeads.

One honest difference from production: production routes Gemini through
the AiHiddenLeads voice proxy; this test connects directly, which is
Google's standard sample path. If this test is smooth, a second variant
through the proxy can separate "proxy" from "app weight" next.
