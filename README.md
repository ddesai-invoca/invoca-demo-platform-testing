# Invoca Demo Platform

A re-skinnable clone of the Invoca product (dashboards, Call Review, Conversation
Intelligence reports, Agent Studio, live SMS/Voice preview agents) that generates a
tailored demo per prospect from a `CustomerProfile`, plus an in-app **Ask AI**
assistant that can answer questions about and live-edit the dashboards.

Built with Vite + React + TypeScript. The AI features (chat, Ask AI, signal
analysis, prospect generation, voice) run through a small Node backend that holds
the API keys server-side — so this is **not** a static site.

## Live deployment

- **URL:** https://invoca-demo-platform-testing.onrender.com/
- **Access:** Google sign-in, restricted to **@invoca.com** accounts.
- **Host:** Render (Starter web service, auto-deploys on push to `main`).

## Run locally

```bash
npm install
cp .env.example .env      # fill in ANTHROPIC_API_KEY (+ optional voice keys)
npm run dev               # http://localhost:5173  (Vite dev server + /api endpoints)
```

Generate a prospect from the CLI: `npm run generate` (see `engine/`).

## Deploying updates

The app auto-redeploys when you push to `main`:

```bash
git add -A && git commit -m "…" && git push
```

Render rebuilds (`npm install && npm run build`) and restarts (`npm start`). Watch
progress in the Render dashboard → **Logs**.

## Production server & hosting

`server.ts` serves the built app **and** the `/api/*` backend, gated by
`googleAuth.ts` (Google sign-in, `@invoca.com` only). Everything is driven by
environment variables set in Render (never committed):

| Var | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required — all AI features |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | The voice agent — all three, or live test calls are refused |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Enables the sign-in gate |
| `ALLOWED_EMAIL_DOMAIN` | Who may sign in (default `invoca.com`) |
| `SESSION_SECRET` | Signs the login cookie |
| `BASE_URL` | Public URL, e.g. `https://invoca-demo-platform.onrender.com` (must match the Google OAuth redirect URI, no trailing slash) |

**Full deploy guide (Render + Google OAuth, step by step):** see [`DEPLOY.md`](DEPLOY.md).

## Cost note

Hosting is a few dollars a month; the real spend is **API token usage** (each
prospect generation is a chunk of Anthropic tokens). Keep an eye on the Anthropic
usage dashboard as the team uses it.
