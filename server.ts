/* =============================================================================
   server.ts — PRODUCTION server (serves the built app + the live /api backend)
   -----------------------------------------------------------------------------
   In dev, the /api/* endpoints live inside the Vite dev server (vite.config.ts,
   `configureServer`). Those DO NOT exist in a static `vite build` output — so a
   plain static host (SFTP-only shared hosting) can serve the UI but every live-AI
   feature dies. This file is the production equivalent: a small Node/Express
   server that serves `dist/` AND re-implements the same six endpoints, calling
   the SAME engine modules, with the API keys read from the server environment
   (never shipped to the browser).

   Run it on any host that can execute Node (a VPS, or a Node platform like
   Render/Railway/Fly). It is NOT usable on static-file-only hosting.

     npm run build       # produce dist/
     npm start           # node --env-file-if-exists=.env --import tsx server.ts

   The handlers here MIRROR vite.config.ts — keep the two in sync if you change
   request/response shapes. Same Node-cache caveat as dev: restart after editing
   engine/*.ts.
   ============================================================================= */

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateProfile, slugify } from "./engine/core.ts";
import { chatReply } from "./engine/chat.ts";
import { analyzeSms } from "./engine/analyze.ts";
import { geocodeZip } from "./engine/places.ts";
import { appEnv, isProduction } from "./engine/appEnv.ts";
import { synthesizePreview } from "./engine/voicePreview.ts";
import { livekitEnv, mintVoiceToken } from "./engine/livekitToken.ts";
import { askAssistant } from "./engine/assistant.ts";
import { installAuth, authEnabled, currentUser } from "./googleAuth.ts";
import { handleDemoApi, isAdmin } from "./engine/demoApi.ts";
import { handleFeedbackApi } from "./engine/feedbackApi.ts";
import { handleIngestApi } from "./engine/ingestApi.ts";
import { materializeIngestAgents } from "./engine/ingestAgentPaths.ts";
import { maybeDispatchScheduled, reconcileStaleRuns } from "./engine/ingestOrchestrator.ts";
import { mailConfigured } from "./engine/mailer.ts";
import { DATA_DIR, isPersistent } from "./engine/demoStore.ts";
import { alert, alertSummary, type AlertLevel } from "./engine/alerts.ts";
import { deployStatus } from "./engine/status.ts";
import { renderConfigured } from "./engine/renderService.ts";
import { runCanary, recordRun, toPublic as canaryPublic, BUDGET_SECONDS } from "./engine/canary.ts";
import { migrateDemoDashes } from "./engine/dashSweep.ts";
import { applyDemoPatches } from "./engine/demoPatches.ts";
import { importEventSeeds } from "./engine/eventSeeds.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");
const OUT_DIR = path.join(ROOT, "src/data/generated");
const PORT = Number(process.env.PORT) || 3000;

const apiKey = process.env.ANTHROPIC_API_KEY;

/* ---- ONE WAY FOR A ROUTE TO FAIL (9/16/2026) --------------------------------
   Every handler below used to end in a bare `console.error` and a JSON error. The
   destination existed once `engine/alerts.ts` landed and **none of them called it** —
   18 log lines, 5 alerts, and the ones that mattered were in the 13. They catch and
   respond, so they never reach the Express error handler either.

   ⚠️ **A HELPER RATHER THAN 13 PAIRED CALLS, deliberately.** Two statements that must
   always appear together will eventually appear apart, and the failure is invisible:
   the endpoint still answers, the log still has a line, and nobody is told. One
   function cannot log without alerting, and `audit:alerts` asserts no route handler
   keeps a bare `console.error`.

   ⚠️⚠️ **TRANSIENT THIRD-PARTY DEGRADATION IS `record`, NOT `page`.** An overloaded
   Anthropic (529) is expected, self-correcting, and already surfaced to the user as
   "briefly overloaded, please resend" — paging on it is exactly the noise that gets a
   channel muted. Same for a replicate failure, which is usually the TARGET site
   blocking a datacenter IP rather than anything of ours being broken. Those are
   counted and visible on `/api/status`; they do not interrupt anybody. */
function routeFailed(key: string, e: unknown, opts?: {
  title?: string; level?: AlertLevel;
  context?: Record<string, string | number | boolean | null | undefined>;
}): void {
  const err = e as any;
  console.error(`[${key}] ${opts?.title ?? "failed"}:`, err?.stack || err);
  void alert({
    key: `api:${key}`,
    title: opts?.title ?? `${key} failed`,
    detail: err?.message || String(e),
    level: opts?.level,
    context: opts?.context,
  });
}

// TTS provider resolution — mirrors vite.config.ts.


// TTS provider resolution — mirrors vite.config.ts.

const app = express();
/* Attachment uploads are RAW BYTES, so their parser is registered before the JSON
   one: express.json would otherwise reject a PNG as malformed JSON. Scoped to the
   upload path only, and capped, so nothing else changes. */
app.use("/api/feedback/:id/files", express.raw({ type: "*/*", limit: "12mb" }));
app.use(express.json({ limit: "2mb" }));

/* Health check for the host (Render etc.) — exempt from auth.
   503 once we are DRAINING, so the host stops routing new requests at us while the
   in-flight ones finish. See the shutdown handler at the bottom of this file. */
let draining = false;
app.get("/healthz", (_req, res) =>
  draining ? res.status(503).type("text").send("draining") : res.type("text").send("ok"));

/* PUBLIC DEPLOY STATUS — "did my push actually reach the live site?"

   Registered BEFORE installAuth so it answers without a session, exactly like
   /healthz. That is the point: the app is behind a Google gate, so there was no
   way to confirm from outside that a deploy landed. The payload deliberately
   carries no customer data and no secrets — see engine/status.ts. */
app.get("/api/status", (_req, res) => res.json(deployStatus({
  livekitConfigured: !!livekitEnv(),
  anthropicKey: !!apiKey,
  googlePlacesKey: !!process.env.GOOGLE_PLACES_API_KEY,
  mapboxTokenInServerEnv: !!process.env.VITE_MAPBOX_TOKEN,
  authGate: authEnabled,
  emailConfigured: mailConfigured(),
  renderConfigured: renderConfigured(),
  /* What has been going wrong lately, as counts and signatures. Safe here because
     `alertSummary()` is built for this endpoint and carries no message text — see the
     note on StatusInput.alerts. */
  alerts: alertSummary(),
})));

/* ---- A BROKEN SCREEN REPORTS ITSELF (9/16/2026) -----------------------------
   `POST /api/client-error`. The browser was completely dark before this: no
   `window.onerror`, no `unhandledrejection`, and `DashboardBoundary` caught render
   errors and told NOBODY. A feature failing mid-demo reached us only if the SE
   happened to mention it.

   ⚠️⚠️ **REGISTERED BEFORE `installAuth`, WHICH IS A DELIBERATE TRADE.** Behind the
   gate, an expired session turns the report into a 302 to Google and the error is
   lost — and a session expiring mid-demo is exactly when things break. So this is
   reachable without a session, and every consequence of that is handled rather than
   hoped about: the body is capped, every field is truncated, the signature is
   NAMESPACED `client:` so a caller cannot forge a server-side signature, and the
   funnel's own hourly ceiling means the worst an abuser achieves is a handful of
   messages followed by suppression. It writes nothing but bounded alert state.
   ⚠️ It answers 204 whatever happens. A reporter that can fail gives the page a
   second error to handle, on a path that only runs when something is already wrong. */
app.post("/api/client-error", (req, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
    const route = str(b.route, 120) || "unknown";
    const name = str(b.name, 80) || "Error";
    const message = str(b.message, 300);
    const where = str(b.where, 40) || "window";
    /* ⚠️ THE SIGNATURE IS THE ROUTE PLUS THE ERROR TYPE, NOT THE MESSAGE. A message
       interpolates ids and numbers ("Cannot read properties of undefined (reading
       'rows')" is stable, but plenty are not), and a signature that varies per
       occurrence defeats the dedupe — the trap `alert()`'s own doc warns about. */
    void alert({
      key: `client:${route}:${name}`,
      title: `Client error on ${route}`,
      detail: `${name}: ${message}`,
      context: {
        route, caught: where,
        prospect: str(b.prospect, 60) || undefined,
        stack: str(b.stack, 600) || undefined,
        userAgent: str(req.get("user-agent"), 160) || undefined,
      },
    });
  } catch { /* a reporter must never throw — see above */ }
  res.status(204).end();
});


/* PUBLIC NIGHTLY CANARY RESULT — timings + audit for the last generation run.

   Registered BEFORE installAuth for the same reason /api/status is: the point is
   to be readable without a session. That is what lets the scheduled cloud agent
   react to a regression WITHOUT being handed any credential — the alternative
   would have been a shared secret pasted into a routine prompt.

   ⚠️ PUBLIC. engine/canary.ts::toPublic() decides what is safe to expose, and it
   deliberately omits the target company names and URLs. Do not add them here. */
app.get("/api/canary", (_req, res) => res.json(canaryPublic()));

installAuth(app);

/* Feedback and feature requests (/api/feedback*). Registered BEFORE the demo
   library only because both return null for a path they do not own; the order
   between them is arbitrary. Behind the auth gate, so `currentUser` is a real
   person and the completion email has somewhere honest to go. */
app.use(async (req, res, next) => {
  if (!req.path.startsWith("/api/feedback")) return next();
  try {
    const user = currentUser(req);
    const base = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
    const result = await handleFeedbackApi(req.method, req.originalUrl, req.body, user, isAdmin(user), base);
    if (!result) return next();
    if (result.binary) {
      res.status(result.status).set(result.binary.headers).send(result.binary.buffer);
      return;
    }
    res.status(result.status).json(result.body);
  } catch (e: any) {
    routeFailed("feedback", e);
    res.status(500).json({ error: e?.message || "Feedback request failed." });
  }
});

/* Demo Call Ingest-O-Matic (/api/ingest*). Admin-only — enforced inside the
   handler, but computed here from the same isAdmin() every other admin-gated
   route already uses. */
app.use(async (req, res, next) => {
  if (!req.path.startsWith("/api/ingest")) return next();
  try {
    const user = currentUser(req);
    const result = await handleIngestApi(req.method, req.originalUrl, req.body, user, isAdmin(user));
    if (!result) return next();
    if (result.binary) {
      res.status(result.status).set(result.binary.headers).send(result.binary.buffer);
      return;
    }
    res.status(result.status).json(result.body);
  } catch (e: any) {
    routeFailed("ingest", e);
    res.status(500).json({ error: e?.message || "Ingest-O-Matic request failed." });
  }
});

/* Shared demo library (/api/me, /api/demos*). Returns null for any other route,
   so the AI endpoints below still get their turn. Same handler as the dev server. */
app.use(async (req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  try {
    const result = await handleDemoApi(req.method, req.path, req.body, currentUser(req));
    if (!result) return next();
    res.status(result.status).json(result.body);
  } catch (e: any) {
    routeFailed("demos", e);
    res.status(500).json({ error: e?.message || "Demo library request failed." });
  }
});

const isOverloaded = (e: any) => e?.status === 529 || e?.status === 429 || /overload/i.test(String(e?.message || ""));

/* POST /api/generate → SSE stream of progress, then the finished profile. */
app.post("/api/generate", async (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
    const { name, url } = req.body || {};
    if (!name || !url) { sse({ type: "error", error: "Both a prospect name and a website URL are required." }); return res.end(); }
    if (!apiKey) { sse({ type: "error", error: "ANTHROPIC_API_KEY is not set on the server." }); return res.end(); }
    const profile = await generateProfile(name, url, {
      apiKey,
      onProgress: (e: { phase: string; status: "start" | "done" }) => sse({ type: "progress", phase: e.phase, status: e.status }),
    });
    sse({ type: "done", profile });
    res.end();
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, `${slugify(name)}.json`), JSON.stringify(profile, null, 2));
    } catch (writeErr) {
      /* ⚠️ THE PROSPECT WAS DELIVERED AND THEN LOST. The SE sees a working demo and
         it is gone on the next load — worth interrupting somebody over. */
      routeFailed("generate-persist", writeErr,
        { title: "Generation succeeded but the profile could not be written to disk" });
    }
  } catch (e: any) {
    routeFailed("generate", e, { title: "Generation failed" });
    sse({ type: "error", error: e?.message || "Generation failed." });
    res.end();
  }
});

/* POST /api/chat → the live SMS/Voice agent's next reply. */
app.post("/api/chat", async (req, res) => {
  try {
    const { brain, messages, voice } = req.body || {};
    if (!brain?.customerName) return res.status(400).json({ error: "brain.customerName is required." });
    if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server." });
    const reply = await chatReply(brain, Array.isArray(messages) ? messages : [], apiKey, { voice: !!voice });
    res.json({ reply });
  } catch (e: any) {
    routeFailed("chat", e, { level: isOverloaded(e) ? "record" : "page" });
    res.status(isOverloaded(e) ? 503 : 500).json({ error: isOverloaded(e) ? "The AI is briefly overloaded — one moment, please resend." : e?.message || "Chat failed." });
  }
});

/* POST /api/ai-assistant → the dashboard "Ask AI" answer / tile / edit. */
app.post("/api/ai-assistant", async (req, res) => {
  try {
    const input = req.body || {};
    if (!input?.customerName || !input?.question) return res.status(400).json({ error: "customerName and question are required." });
    if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server." });

    /* ⚠️ SSE ONLY WHEN THE CLIENT ASKS — see the twin in vite.config.ts. Both must stay in
       sync, per the standing rule for these endpoint pairs. */
    if (input?.stream) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      const evt = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      try {
        const result = await askAssistant(input, apiKey, (p) => evt({ type: "progress", ...p }));
        evt({ type: "done", result });
      } catch (e: any) {
        routeFailed("ai-assistant", e, { level: isOverloaded(e) ? "record" : "page", context: { transport: "stream" } });
        evt({ type: "error", error: isOverloaded(e) ? "The AI is briefly overloaded — one moment, please resend." : e?.message || "Assistant failed." });
      }
      return res.end();
    }

    const result = await askAssistant(input, apiKey);
    res.json({ result });
  } catch (e: any) {
    routeFailed("ai-assistant", e, { level: isOverloaded(e) ? "record" : "page" });
    res.status(isOverloaded(e) ? 503 : 500).json({ error: isOverloaded(e) ? "The AI is briefly overloaded — one moment, please resend." : e?.message || "Assistant failed." });
  }
});

/* GET /api/zip?zip=85001 → { label, city, st, zip, ll } for the search screen's
   "Use precise location". Behind the auth gate like every other /api route; the Places key
   stays server-side. Unresolvable is a 404 the SE can see, never an approximation — see
   geocodeZip in engine/places.ts for why a guess is refused. */
app.get("/api/zip", async (req, res) => {
  try {
    const zip = String(req.query.zip ?? "");
    if (!/^\d{5}$/.test(zip)) return res.status(400).json({ error: "Enter a 5-digit US ZIP code." });
    if (!apiKey && !process.env.GOOGLE_PLACES_API_KEY) return res.status(501).json({ error: "Location lookup is not configured on this server." });
    const place = await geocodeZip(zip);
    if (!place) return res.status(404).json({ error: `We could not find ZIP ${zip}.` });
    res.json({ place });
  } catch (e: any) {
    /* One location pill degrades. Counted. */
    routeFailed("zip", e, { level: "record" });
    res.status(500).json({ error: e?.message || "Location lookup failed." });
  }
});

/* POST /api/analyze → fast signal extraction for a captured conversation. */
app.post("/api/analyze", async (req, res) => {
  try {
    const input = req.body || {};
    if (!input?.customerName || !Array.isArray(input?.transcript)) return res.status(400).json({ error: "customerName and transcript are required." });
    if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server." });
    const { signals, outcome } = await analyzeSms(input, apiKey);
    /* `outcome` is voice-only and absent for SMS; the client ignores what it does not use. */
    res.json({ signals, outcome });
  } catch (e: any) {
    /* Signals go MISSING from a report rather than wrong, which is the kind of
       failure nobody notices until a prospect asks what the blank tab means. */
    routeFailed("analyze", e);
    res.status(500).json({ error: e?.message || "Analyze failed." });
  }
});

/* POST /api/voice-preview → audio/wav for the Details tab's play button.

   ⚠️ 100% LiveKit: the voice is synthesized through the SAME gateway and the SAME model
   string the live call uses, on LiveKit credentials. This replaced /api/tts, which called
   Deepgram and ElevenLabs directly with their own keys. */
app.post("/api/voice-preview", async (req, res) => {
  try {
    const cfg = livekitEnv();
    if (!cfg) return res.status(501).json({ error: "LiveKit is not configured on the server." });
    const { voice, text } = req.body || {};
    const wav = await synthesizePreview({ voice: String(voice ?? ""), text: String(text ?? "") }, cfg);
    res.status(200);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    res.end(Buffer.from(wav));
  } catch (e: any) {
    /* Also the path an unoffered voice takes, which is rejected input rather than a
       fault, so this one is counted rather than paged. */
    routeFailed("voice-preview", e, { level: "record" });
    res.status(400).json({ error: e?.message || "Preview failed." });
  }
});

/* POST /api/livekit-token → { url, token, room } for the LiveKit voice call.
   The API SECRET stays here; the browser only gets a short-lived join token.
   501 when unconfigured, so the client falls back rather than dying mid-demo. */
app.post("/api/livekit-token", async (req, res) => {
  try {
    /* ⚠️⚠️ **CONFIG IS CHECKED BEFORE THE BODY, AND THE ORDER IS THE WHOLE POINT.** This
       validated `brain` first and answered 400 to a body-less request — which is exactly what
       `useLiveKitReady()` sends to ask "is LiveKit available here?", and it reads 400 as YES.
       So on a server with no LiveKit keys the probe said yes, the app chose the LiveKit
       engine, and the real token request then fell through to the 501 below: Start Call did
       nothing, on production, with the fallback engine sitting right there unused. An
       unconfigured server must answer 501 whatever the body says. */
    const cfg = livekitEnv();
    if (!cfg) return res.status(501).json({ error: "LiveKit is not configured on the server." });
    const { brain, profileId, greeting, voice } = req.body || {};
    if (!brain) return res.status(400).json({ error: "brain is required." });
    res.json(await mintVoiceToken({ brain, profileId: profileId || "demo", greeting, voice }, cfg));
  } catch (e: any) {
    /* No token means no voice call at all, for everybody. */
    routeFailed("livekit-token", e, { title: "LiveKit token mint failed" });
    res.status(500).json({ error: e?.message || "Could not mint a LiveKit token." });
  }
});

/* POST /api/delete-profile → remove a generated prospect's on-disk JSON. */
/* Mirrors the placeApi() plugin in vite.config.ts — keep the two in sync. */
app.get("/api/place", async (req, res) => {
  try {
    const { fetchPlace } = await import("./engine/places.ts");
    res.json({
      place: await fetchPlace(String(req.query.name ?? ""), String(req.query.city ?? "")),
    });
  } catch {
    res.json({ place: null });
  }
});

/* Mirrors the ogImageApi() plugin in vite.config.ts — keep the two in sync. */
/* GET /api/replicate?url=… → the page itself as text/html (same-origin, so the Replicate
   screen can wire its form); /api/replicate/probe?url=… → JSON metadata. engine/replicate.ts
   does the work. Twin of the plugin in vite.config.ts — keep the two in sync. */
async function replicateHandler(req: express.Request, res: express.Response, probe: boolean) {
  const target = String(req.query.url || "");
  const { fetchReplica } = await import("./engine/replicate.ts");
  try {
    const r = await fetchReplica(target);
    if (probe) {
      return res.json({ ok: true, finalUrl: r.finalUrl, title: r.title, forms: r.forms, formFields: r.formFields, bytes: r.bytes, ms: r.ms, via: r.via, fallbackReason: r.fallbackReason });
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.send(r.html);
  } catch (e: any) {
    const msg = e?.message || "Could not replicate that page.";
    /* ⚠️ THIS PATH LOGGED NOTHING AT ALL before 9/16/2026 — worse than the bare
       `console.error`s, because there was not even a line to find afterwards.
       `record`, not `page`: a replicate failure is usually the TARGET site blocking a
       datacenter IP (AutoNation and Orlando Health both do), which is not our fault and
       not actionable at 2am. The count on /api/status is what makes a pattern visible. */
    routeFailed("replicate", e, { level: "record", context: { url: target.slice(0, 120) } });
    if (probe) return res.status(400).json({ ok: false, error: msg });
    return res.status(400).type("html")
      .send(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:40px;color:#333">${msg}</body>`);
  }
}
app.get("/api/replicate/probe", (req, res) => { void replicateHandler(req, res, true); });
app.get("/api/replicate", (req, res) => { void replicateHandler(req, res, false); });

/* ⚠️⚠️ **THE REPLICATE BUTTON'S REAL PATH: download a standalone HTML file, save it, open it.**
   POST /api/replicate/capture {url} → checks the persistent store first (instant if this
   domain was already captured, even after a restart — that IS the point of the store), else
   runs the full browser capture and saves the result. GET /api/replicate/lookup?url=|slug=
   resolves what `/replica` should show, checking the two built-in library captures
   (`replicaFor`/`replicaBySlug`, shipped in the repo) before the dynamic store. GET
   /api/replicas/dyn/:file streams a stored capture's bytes — distinct from the static
   `/replicas/*` names served out of `public/`, so the two can never collide.
   Twin of the plugin in vite.config.ts — keep the two in sync. */
app.post("/api/replicate/capture", async (req, res) => {
  const target = String(req.body?.url || "");
  const { assertPublicUrl } = await import("./engine/replicate.ts");
  const { captureReplica } = await import("./engine/replicaCapture.ts");
  const { getReplicaForDomain, saveReplica } = await import("./engine/replicaStore.ts");
  let host: string;
  try { host = assertPublicUrl(target).hostname; } catch (e: any) {
    return res.status(400).json({ ok: false, error: e?.message || "That is not a usable URL." });
  }
  const existing = getReplicaForDomain(host);
  if (existing) return res.json({ ok: true, slug: existing.slug, domain: existing.domain, sourceUrl: existing.sourceUrl, capturedAt: existing.capturedAt, label: existing.label, cached: true });
  try {
    const r = await captureReplica(target);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.reasons.join("; ") });
    const slug = new URL(r.finalUrl).hostname.replace(/^www\./, "").split(".")[0].replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    const domain = new URL(r.finalUrl).hostname.replace(/^www\./, "");
    const rec = saveReplica(
      { slug, file: `${slug}.html`, domain, sourceUrl: r.finalUrl, capturedAt: new Date().toISOString().slice(0, 10), label: r.title.replace(/\s*[-|·].*$/, "").trim() || slug, fields: r.map },
      r.html,
    );
    return res.json({ ok: true, slug: rec.slug, domain: rec.domain, sourceUrl: rec.sourceUrl, capturedAt: rec.capturedAt, label: rec.label, cached: false });
  } catch (e: any) {
    /* Same reasoning as the fetch path above: counted, not paged. */
    routeFailed("replicate-capture", e, { level: "record", context: { url: target.slice(0, 120) } });
    return res.status(400).json({ ok: false, error: e?.message || "Could not replicate that page." });
  }
});

app.get("/api/replicate/lookup", async (req, res) => {
  const url = req.query.url ? String(req.query.url) : "";
  const slugQ = req.query.slug ? String(req.query.slug) : "";
  /* ⚠️ `replicaRegistry.ts`, NOT `replicaPages.ts` — that module is full of
     `HTMLInputElement` and `Document`, and importing it here is what kept this whole
     file out of `tsconfig.node.json` (and therefore out of every type check). */
  const { replicaFor, replicaBySlug } = await import("./src/data/replicaRegistry.ts");
  const { getReplicaForDomain, getReplicaBySlug } = await import("./engine/replicaStore.ts");
  /* ⚠⚠ **A STATIC ENTRY IS ONLY REAL IF ITS CAPTURE IS ON THIS MACHINE, and trusting the
     registry blindly is what produced a BLANK SCREEN on production.** `public/replicas/*.html`
     is git-ignored on purpose (megabytes, pruned after 10 days), so a deploy has the registry
     but NOT the files. Lookup answered `source: "static", file: "aptive.html"`, the page framed
     `/replicas/aptive.html`, express.static missed, and the SPA catch-all below served
     `index.html` INTO THE IFRAME — the app rendering itself with no route, i.e. blank. Worse
     than a 404, because nothing anywhere reported a failure: Replicate had genuinely captured
     the page and its bytes were sitting unused in the dynamic store.
     Checking the file makes the registry fail CLOSED, falling through to that store. */
  const staticReady = (file: string) => fs.existsSync(path.join(DIST, "replicas", file));
  if (slugQ) {
    const st = replicaBySlug(slugQ);
    if (st && staticReady(st.file)) return res.json({ ok: true, source: "static", file: st.file, sourceUrl: st.sourceUrl, capturedAt: st.capturedAt, label: st.label, fields: st.fields ?? null });
    const dyn = getReplicaBySlug(slugQ);
    if (dyn) return res.json({ ok: true, source: "dynamic", file: dyn.file, sourceUrl: dyn.sourceUrl, capturedAt: dyn.capturedAt, label: dyn.label, fields: dyn.fields });
    return res.json({ ok: false });
  }
  let host = "";
  try { host = new URL(url).hostname; } catch { return res.json({ ok: false }); }
  const st = replicaFor(host);
  if (st && staticReady(st.file)) return res.json({ ok: true, source: "static", file: st.file, sourceUrl: st.sourceUrl, capturedAt: st.capturedAt, label: st.label, fields: st.fields ?? null });
  const dyn = getReplicaForDomain(host);
  if (dyn) return res.json({ ok: true, source: "dynamic", file: dyn.file, sourceUrl: dyn.sourceUrl, capturedAt: dyn.capturedAt, label: dyn.label, fields: dyn.fields });
  return res.json({ ok: false });
});

app.get("/api/replicas/dyn/:file", async (req, res) => {
  const { REPLICAS_DIR } = await import("./engine/replicaStore.ts");
  const file = path.basename(String(req.params.file || ""));   // strip any path traversal
  const full = path.join(REPLICAS_DIR, file);
  if (!full.startsWith(REPLICAS_DIR + path.sep) || !fs.existsSync(full)) return res.status(404).end();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(full).pipe(res);
});

app.get("/api/og-image", async (req, res) => {
  try {
    const { fetchOgImage } = await import("./engine/ogImage.ts");
    res.json({ url: await fetchOgImage(String(req.query.domain ?? "")) });
  } catch {
    res.json({ url: null });
  }
});

app.post("/api/delete-profile", (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id || !/^[a-z0-9-]+$/.test(id)) return res.status(400).json({ error: "A valid profile id is required." });
    const file = path.join(OUT_DIR, `${id}.json`);
    if (!file.startsWith(OUT_DIR + path.sep)) return res.status(400).json({ error: "Invalid id." });
    if (fs.existsSync(file)) { fs.rmSync(file); return res.json({ ok: true, deleted: true }); }
    return res.json({ ok: true, deleted: false });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Delete failed." });
  }
});

// Static built app + SPA deep-link fallback (so /dashboards/marketing etc. work).
app.use(express.static(DIST));
/* ⚠⚠ **A MISSING CAPTURE 404s RATHER THAN BECOMING THE APP.** Reaching here means
   express.static above did not find the file, and the SPA catch-all would otherwise hand back
   `index.html` — which, framed by the replica screen, renders as a silent blank page instead of
   a failure anyone can see. Registered before the catch-all and scoped to this one prefix, so
   every real route still falls through to the SPA exactly as before. */
app.get("/replicas/*", (_req, res) => res.status(404).type("text/plain").send("No such capture on this server."));
app.get("*", (_req, res) => res.sendFile(path.join(DIST, "index.html")));

/* ---- THE ERROR HANDLER, AND IT HAS TO BE LAST ------------------------------
   There was none at all before 9/16/2026. An exception thrown inside a route
   reached Express's default handler, which sends a bare 500 (the stack, in dev)
   and logs nothing anybody sees — so a broken endpoint looked, from the browser,
   exactly like a broken network.

   ⚠️ **FOUR ARGUMENTS OR IT IS NOT AN ERROR HANDLER.** Express decides by arity:
   a three-argument function registered here is treated as ordinary middleware and
   silently never runs on an error. `_next` is therefore required even though it is
   unused, and `audit:alerts` checks the signature for exactly that reason.
   ⚠️ **AFTER the catch-all**, because Express runs middleware in registration
   order and an error handler registered before the routes it protects sees
   nothing. */
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  /* The route, not the message, so one broken endpoint is one signature however
     many different ways it manages to fail. */
  void alert({
    key: `route:${req.method}:${req.path.slice(0, 80)}`,
    title: `Unhandled error in ${req.method} ${req.path.slice(0, 80)}`,
    detail: err?.message || String(err),
    context: { stack: String(err?.stack ?? "").slice(0, 600) },
  });
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong on the server." });
});

const server = app.listen(PORT, () => {
  console.log(`Invoca demo running on http://localhost:${PORT}`);
  console.log(authEnabled ? "🔒 Google sign-in gate is ON (restricted by email domain)." : "🔓 Auth gate OFF — set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET to require sign-in.");
  console.log(`📁 Demo library: ${DATA_DIR}${isPersistent(DATA_DIR) ? "" : "  (⚠ not a persistent disk — demos are lost on redeploy)"}`);
  /* One-time content migration. PATCH is creator-only, so a user sweeping from
     their browser cannot fix a teammate's demo; the server can. Guarded by a
     marker file, so this is a no-op on every boot after the first. */
  migrateDemoDashes(DATA_DIR);
  /* Agreed one-off content patches (engine/migrations/*.json). Server-side for
     the same reason as the sweep: PATCH is creator-only, so a demo owned by
     someone else cannot be updated from the browser. Content only, never
     ownership. */
  applyDemoPatches(DATA_DIR);
  /* Event rosters committed under engine/event-seeds/ (see eventSeeds.ts for why
     they cannot live in src/data/generated). Never overwrites an existing demo,
     so this is a no-op on every boot after the first. */
  const seeded = importEventSeeds();
  if (seeded.added.length || seeded.failed.length) {
    console.log(`🎟  Event seeds: ${seeded.added.length} added, ${seeded.skipped} already present`);
    for (const f of seeded.failed) console.error(`   ⚠ skipped ${f}`);
  }
  if (!apiKey) console.warn("⚠  ANTHROPIC_API_KEY not set — the AI features will return errors. Set it in the server environment (.env or host config).");
  scheduleCanary();

  /* Demo Call Ingest-O-Matic: materialize each subagent's network_config.env
     from server env vars and point its state/ at the persistent disk (see
     ingestAgentPaths.ts — this cannot be done at import time because it needs
     process.env already loaded). Then sweep any run left "running" by a prior
     restart/deploy, so the dashboard doesn't show a stuck spinner forever. */
  const { ready, notConfigured } = materializeIngestAgents();
  if (ready.length) console.log(`📞 Ingest-O-Matic: credentials configured for ${ready.join(", ")}.`);
  if (notConfigured.length) console.log(`📞 Ingest-O-Matic: no credentials set for ${notConfigured.join(", ")} yet — ad-hoc/scheduled requests for that network will fail until INVOCA_*_${notConfigured[0]?.toUpperCase()} env vars are set.`);
  const staleCount = reconcileStaleRuns();
  if (staleCount) console.log(`📞 Ingest-O-Matic: marked ${staleCount} stuck "running" run(s) as failed (left over from a restart).`);
  scheduleIngest();
});

/* ---- graceful shutdown -----------------------------------------------------
   Render stops an instance by sending SIGTERM and waiting before SIGKILL. With no
   handler, the default SIGTERM behaviour kills the process immediately and every
   in-flight request dies with it — a generation stream, a PATCH being saved, an
   artifact being fetched — which is the sharp edge of a deploy for anyone actually
   using the site at that moment.

   ⚠️ THIS DOES NOT SHORTEN THE DEPLOY WINDOW and is not meant to. The window exists
   because a Render disk attaches to one instance at a time (see CLAUDE.md TODO 0);
   this only makes the START of the window clean instead of abrupt.

   `closeIdleConnections()` matters: `server.close()` alone waits for keep-alive
   sockets that are sitting idle between requests, so a browser with an open
   connection and nothing in flight would hold the drain open for the full timeout.
   Idle sockets are dropped at once; only real in-flight requests hold us. */
const DRAIN_TIMEOUT_MS = Number(process.env.DRAIN_TIMEOUT_MS ?? 10_000);

function shutdown(signal: string): void {
  if (draining) return;                       // SIGTERM then SIGINT must not double-run
  draining = true;
  console.log(`↩  ${signal} — draining (health check now 503, ${DRAIN_TIMEOUT_MS}ms budget).`);
  server.closeIdleConnections?.();
  server.close(() => {
    console.log("✓  in-flight requests finished — exiting cleanly.");
    process.exit(0);
  });
  /* A request that never ends (an open SSE generation stream) must not hold the
     process past the host's patience, or SIGKILL lands anyway and we gained nothing. */
  setTimeout(() => {
    console.warn("⚠  drain timed out — forcing exit.");
    process.exit(0);
  }, DRAIN_TIMEOUT_MS).unref?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/* ---- THE TWO THAT TAKE THE WHOLE SERVICE DOWN -------------------------------
   ⚠️⚠️ **AWAITED, THEN EXIT — the one place in this codebase where an alert is
   not fire-and-forget.** A floating promise dies with the process, so the single
   most important notification this app can send is precisely the one that would
   never leave. `alert()` cannot throw, so awaiting it cannot make the crash worse,
   and the 3s cap means a dead channel delays the exit rather than hanging it.

   ⚠️ **IT STILL EXITS.** Node's own guidance is that the process state is
   undefined after an uncaught exception, and Render restarts it — which is the
   right outcome. What was missing was anybody being told. The alert funnel's
   cooldown is PERSISTED for exactly this path: a crash loop notifies once, not
   once per boot. */
async function crashed(kind: string, e: unknown): Promise<void> {
  const err = e as any;
  console.error(`✗  ${kind}:`, err?.stack || err);
  await Promise.race([
    alert({
      key: `crash:${kind}:${String(err?.message ?? err).slice(0, 80)}`,
      title: `${kind} — the service is restarting`,
      detail: String(err?.stack ?? err).slice(0, 900),
      context: { uptimeSeconds: Math.round(process.uptime()) },
    }),
    new Promise((r) => setTimeout(r, 3_000)),
  ]);
  process.exit(1);
}

process.on("uncaughtException", (e) => { void crashed("uncaughtException", e); });
/* An unhandled rejection is NOT fatal in Node by default, and this deliberately
   does not make it one: half the async paths here are third-party calls whose
   rejection is a degraded feature, not a dead process. It is reported and the
   service keeps serving. */
process.on("unhandledRejection", (e) => {
  console.error("✗  unhandledRejection:", e);
  void alert({
    key: `unhandledRejection:${String((e as any)?.message ?? e).slice(0, 80)}`,
    title: "Unhandled promise rejection",
    detail: String((e as any)?.stack ?? e).slice(0, 900),
  });
});

/* ---- the nightly canary ----------------------------------------------------
   Runs one full generation at ~2am Eastern, times it, audits it, and throws the
   profile away (engine/canary.ts). It lives IN THE WEB PROCESS because this is
   the only place ANTHROPIC_API_KEY already exists — no extra Render service, no
   endpoint that bypasses the sign-in gate, and no secret handed to a cloud agent.

   Why a 10-minute tick rather than a cron expression: the target is 2am EASTERN,
   and Eastern is UTC-4 or UTC-5 depending on the season, so a fixed UTC cron
   would drift by an hour twice a year. Asking the clock what hour it is in
   America/New_York is DST-correct by construction. The ET DATE is the run key, so
   the "did I already run today" check can't fire twice within one 2am hour.

   ⚠️ Every failure path is swallowed. A canary that can take down the web service
   the whole team demos on is far worse than no canary. */
/* ⚠️ HOISTED OUT OF `scheduleCanary` (9/16/2026) so the attention check below can
   use it too. Asking the clock what hour it is in America/New_York is DST-correct by
   construction, which is why this exists rather than a UTC cron — see the block on
   the scheduler. Two copies would be two answers to "what ET day is it". */
const etParts = () => {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
};

/* One notification per ET day, however many times the tick evaluates it. The alert
   funnel's own 30-minute cooldown would otherwise allow ~48 a day for a signal that
   only changes once a night, and a daily signal that pages twice an hour is a daily
   signal you mute. */
let lastAttentionDate = "";
function alertOnCanary(): void {
  try {
    const pub = canaryPublic() as { needsAttention?: boolean; reason?: string | null };
    if (!pub.needsAttention) return;
    const { date } = etParts();
    if (date === lastAttentionDate) return;
    lastAttentionDate = date;
    void alert({
      key: "canary-needs-attention",
      title: "Nightly generation check needs attention",
      detail: pub.reason ?? "unknown",
      context: { see: "/api/canary" },
    });
  } catch (e) {
    console.error("🐤 canary attention check failed (ignored):", e);
  }
}

function scheduleCanary(): void {
  const flag = (process.env.CANARY ?? "").toLowerCase();
  if (flag === "off") {
    console.log("🐤 Nightly canary disabled (CANARY=off).");
    return;
  }
  /* ⚠️⚠️ **OFF OUTSIDE PRODUCTION BY DEFAULT, BECAUSE THE COST IS SILENT AND RECURRING.** The
     canary runs a FULL `generateProfile()` every night — ~2.5 minutes of Opus across 20 phases
     — and a staging service created by copying production's environment variables would run a
     second one forever, at real expense, with nobody looking at the result. It also publishes
     to `/api/canary`, which two claude.ai routines read: a second service answering that route
     is a second source of truth for "did last night's generation pass".
     Set `CANARY=on` to arm it anywhere (the wiring check `CANARY_ON_BOOT=1` still works). */
  if (!isProduction() && flag !== "on") {
    console.log(`🐤 Nightly canary not armed — this is ${appEnv()}, not production (CANARY=on to force).`);
    return;
  }
  if (!apiKey) {
    console.log("🐤 Nightly canary not armed — no ANTHROPIC_API_KEY.");
    return;
  }
  /* 5am Eastern. Override with CANARY_HOUR_ET. ⚠️ The two claude.ai routines that
     read /api/canary are scheduled to fire AFTER this (6:00 and 6:30 ET); moving
     this hour without moving them means they report on the PREVIOUS night's run
     and a real failure goes unnoticed for a day. */
  const HOUR = Number(process.env.CANARY_HOUR_ET ?? 5);
  const TICK_MS = 10 * 60 * 1000;
  let running = false;
  let lastRunDate = "";                     // ET calendar date of the last run

  const tick = async () => {
    try {
      const { date, hour } = etParts();
      if (running || hour !== HOUR || date === lastRunDate) return;
      running = true;
      lastRunDate = date;                    // claim the slot BEFORE the await
      console.log(`🐤 Canary starting (${date} ~${HOUR}:00 ET)…`);
      const run = await runCanary(apiKey);
      recordRun(run);
      const verdict = !run.ok ? `FAILED: ${run.error}`
        : run.overBudget ? `OVER BUDGET ${run.totalSeconds}s > ${BUDGET_SECONDS}s`
        : run.audit.failures.length ? `${run.audit.failures.length} audit failure(s) in ${run.totalSeconds}s`
        : `ok ${run.totalSeconds}s`;
      console.log(`🐤 Canary done — ${verdict} (slowest: ${run.slowestPhase})`);
      /* ⚠️ THE VERDICT IS READ BACK OUT OF `toPublic()`, NOT RE-DERIVED HERE. That
         function already decides what counts as needing attention — including
         *missing* and *stale*, which a freshly-finished run cannot be — and two
         copies of "is the canary unhappy" is how the Slack message and
         `/api/canary` end up disagreeing about the same night. */
      alertOnCanary();
    } catch (e) {
      /* ⚠️ THE CANARY FAILING TO RUN IS THE "SILENCE IS NOT SUCCESS" CASE, and it was
         only caught indirectly: no run recorded means `toPublic()` reports *stale* the
         NEXT day, and `alertOnCanary` reports that. True, but a day late. One line makes
         it immediate, and the funnel's cooldown keeps a repeatedly-failing tick quiet. */
      routeFailed("canary-tick", e, { title: "Nightly canary tick failed to run" });
    } finally {
      running = false;
    }
  };

  setInterval(tick, TICK_MS).unref?.();
  /* ⚠️⚠️ **THE CANARY NOT RUNNING IS ITSELF A FAILURE, AND NOTHING WAS CHECKING.**
     `toPublic()` has always treated *missing* and *stale* as needing attention —
     "a monitor whose 'nothing wrong' and 'not working' look identical is worse
     than no monitor" — but that verdict was only ever computed when somebody
     READ the endpoint. If the tick died, or generation quietly broke, the
     endpoint sat there saying so and nobody was told. This evaluates it on the
     same tick and reports at most once per ET day. */
  setInterval(alertOnCanary, TICK_MS).unref?.();
  console.log(`🐤 Nightly canary armed for ~${HOUR}:00 America/New_York (budget ${BUDGET_SECONDS}s).`);
  /* Opt-in immediate run, for verifying the wiring without waiting for 2am. */
  if ((process.env.CANARY_ON_BOOT ?? "") === "1") {
    console.log("🐤 CANARY_ON_BOOT=1 — running once now.");
    (async () => {
      try {
        const run = await runCanary(apiKey);
        recordRun(run);
        console.log(`🐤 Boot canary: ok=${run.ok} total=${run.totalSeconds}s audit_failures=${run.audit.failures.length}`);
      } catch (e) { console.error("🐤 Boot canary failed (ignored):", e); }
    })();
  }
}

/* ---- the ingest scheduler --------------------------------------------------
   Sibling to scheduleCanary() above, same shape: a 10-minute tick, gated to
   production by default (INGEST_SCHEDULE=on to force elsewhere — the same
   reasoning as CANARY: a staging copy of production's env vars should not
   silently start dispatching real Claude agent runs against real Invoca
   networks on a timer nobody is watching). computeScheduledRange() already
   returns null on a non-firing tick, and maybeDispatchScheduled() persists its
   own "already fired for this exact range" guard, so this tick body is just:
   ask, and let the orchestrator decide. */
function scheduleIngest(): void {
  const flag = (process.env.INGEST_SCHEDULE ?? "").toLowerCase();
  if (flag === "off") {
    console.log("📞 Ingest-O-Matic scheduler disabled (INGEST_SCHEDULE=off).");
    return;
  }
  if (!isProduction() && flag !== "on") {
    console.log(`📞 Ingest-O-Matic scheduler not armed — this is ${appEnv()}, not production (INGEST_SCHEDULE=on to force).`);
    return;
  }
  const TICK_MS = 10 * 60 * 1000;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      maybeDispatchScheduled(new Date());
    } catch (e) {
      routeFailed("ingest-schedule-tick", e, { title: "Scheduled ingest tick failed" });
    } finally {
      running = false;
    }
  };
  setInterval(tick, TICK_MS).unref?.();
  console.log("📞 Ingest-O-Matic scheduler armed (checks every 10 minutes).");
}
