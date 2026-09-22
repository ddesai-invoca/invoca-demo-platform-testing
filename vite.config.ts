import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/* Dev-only endpoint: POST /api/generate { name, url } runs the same generation
   pipeline as `npm run generate`, writes src/data/generated/<slug>.json, and
   returns the validated profile. This powers the in-app Launch screen. */
function generateApi(apiKey: string | undefined): Plugin {
  const OUT_DIR = path.resolve(process.cwd(), 'src/data/generated')
  return {
    name: 'invoca-generate-api',
    configureServer(server) {
      // Don't let writing a generated file trigger a full page reload mid-demo.
      server.watcher.options = { ...server.watcher.options }
      server.watcher.unwatch(OUT_DIR)

      server.middlewares.use('/api/generate', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        // Stream progress as Server-Sent Events so the Launch screen can show each
        // build phase (start/done) + an overall % while the ~4-min generation runs.
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')  // don't let any proxy buffer the stream
        const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
        try {
          let raw = ''
          for await (const chunk of req) raw += chunk
          const body = JSON.parse(raw || '{}')
          const { name, url } = body
          if (!name || !url) { sse({ type: 'error', error: 'Both a prospect name and a website URL are required.' }); return res.end() }
          if (!apiKey) { sse({ type: 'error', error: 'ANTHROPIC_API_KEY is not set. Add it to .env or export it before `npm run dev`.' }); return res.end() }

          const { generateProfile, slugify } = await import(
            pathToFileURL(path.resolve(process.cwd(), 'engine/core.ts')).href
          )
          const profile = await generateProfile(name, url, {
            apiKey,
            onProgress: (e: { phase: string; status: 'start' | 'done' }) => sse({ type: 'progress', phase: e.phase, status: e.status }),
          })

          // Send the finished profile to the client FIRST — a disk-write failure must
          // never discard a valid profile the user just waited minutes for (the client
          // adds it to its registry + localStorage regardless of the on-disk cache).
          sse({ type: 'done', profile })
          res.end()
          try {
            fs.mkdirSync(OUT_DIR, { recursive: true })
            fs.writeFileSync(path.join(OUT_DIR, `${slugify(name)}.json`), JSON.stringify(profile, null, 2))
          } catch (writeErr) {
            console.error('[generate] profile delivered but failed to persist to disk:', writeErr)
          }
        } catch (e: any) {
          console.error('[generate] failed:', e)
          sse({ type: 'error', error: e?.message || 'Generation failed.' })
          res.end()
        }
      })
    },
  }
}

/* Dev-only endpoint: POST /api/delete-profile { id } removes a generated
   prospect's src/data/generated/<id>.json so it doesn't reappear on the next
   dev-server start. Seeds have no file (nothing to delete). */
function deleteProfileApi(): Plugin {
  const OUT_DIR = path.resolve(process.cwd(), 'src/data/generated')
  return {
    name: 'invoca-delete-profile-api',
    configureServer(server) {
      server.middlewares.use('/api/delete-profile', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        const send = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        try {
          let raw = ''
          for await (const chunk of req) raw += chunk
          const { id } = JSON.parse(raw || '{}')
          if (!id || !/^[a-z0-9-]+$/.test(id)) return send(400, { error: 'A valid profile id is required.' })
          const file = path.join(OUT_DIR, `${id}.json`)
          if (!file.startsWith(OUT_DIR + path.sep)) return send(400, { error: 'Invalid id.' })  // no traversal
          if (fs.existsSync(file)) { fs.rmSync(file); return send(200, { ok: true, deleted: true }) }
          return send(200, { ok: true, deleted: false })  // seed or already gone
        } catch (e: any) {
          send(500, { error: e?.message || 'Delete failed.' })
        }
      })
    },
  }
}

/* GET /api/replicate?url=… → the page itself as text/html (served same-origin so the
   Replicate screen can wire its form), and /api/replicate/probe?url=… → JSON metadata.
   engine/replicate.ts does the work; this is the transport. Mirrored in server.ts. */
/* ⚠️ MIRRORS server.ts — keep the two in sync. Same three routes: POST capture, GET lookup,
   GET the stored file's bytes. */
function replicateCaptureApi(): Plugin {
  return {
    name: 'invoca-replicate-capture-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const u = new URL(req.url || '', 'http://x')

        if (req.method === 'POST' && u.pathname === '/api/replicate/capture') {
          let raw = ''
          for await (const chunk of req) raw += chunk
          const { url: target } = JSON.parse(raw || '{}')
          const send = (code: number, body: unknown) => {
            res.statusCode = code
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(body))
          }
          const { assertPublicUrl } = await import(pathToFileURL(path.resolve(process.cwd(), 'engine/replicate.ts')).href)
          let host: string
          try { host = assertPublicUrl(target).hostname } catch (e: any) { return send(400, { ok: false, error: e?.message || 'That is not a usable URL.' }) }
          const { getReplicaForDomain, saveReplica } = await import(pathToFileURL(path.resolve(process.cwd(), 'engine/replicaStore.ts')).href)
          const existing = getReplicaForDomain(host)
          if (existing) return send(200, { ok: true, slug: existing.slug, domain: existing.domain, sourceUrl: existing.sourceUrl, capturedAt: existing.capturedAt, label: existing.label, cached: true })
          try {
            const { captureReplica } = await import(pathToFileURL(path.resolve(process.cwd(), 'engine/replicaCapture.ts')).href)
            const r = await captureReplica(target)
            if (!r.ok) return send(400, { ok: false, error: r.reasons.join('; ') })
            const slug = new URL(r.finalUrl).hostname.replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
            const domain = new URL(r.finalUrl).hostname.replace(/^www\./, '')
            const rec = saveReplica({ slug, file: `${slug}.html`, domain, sourceUrl: r.finalUrl, capturedAt: new Date().toISOString().slice(0, 10), label: r.title.replace(/\s*[-|·].*$/, '').trim() || slug, fields: r.map }, r.html)
            return send(200, { ok: true, slug: rec.slug, domain: rec.domain, sourceUrl: rec.sourceUrl, capturedAt: rec.capturedAt, label: rec.label, cached: false })
          } catch (e: any) {
            return send(400, { ok: false, error: e?.message || 'Could not replicate that page.' })
          }
        }

        if (req.method === 'GET' && u.pathname === '/api/replicate/lookup') {
          const url = u.searchParams.get('url') || ''
          const slugQ = u.searchParams.get('slug') || ''
          const send = (body: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
          const { replicaFor, replicaBySlug } = await import(pathToFileURL(path.resolve(process.cwd(), 'src/data/replicaRegistry.ts')).href)
          const { getReplicaForDomain, getReplicaBySlug } = await import(pathToFileURL(path.resolve(process.cwd(), 'engine/replicaStore.ts')).href)
          /* ⚠️ SAME FAIL-CLOSED RULE AS server.ts — see the long note there. A registry entry
             whose capture is not on this machine must fall through to the dynamic store, or the
             page frames a path that does not exist. Dev serves them from public/. */
          const staticReady = (file: string) => fs.existsSync(path.resolve(process.cwd(), 'public/replicas', file))
          if (slugQ) {
            const st = replicaBySlug(slugQ)
            if (st && staticReady(st.file)) return send({ ok: true, source: 'static', file: st.file, sourceUrl: st.sourceUrl, capturedAt: st.capturedAt, label: st.label, fields: st.fields ?? null })
            const dyn = getReplicaBySlug(slugQ)
            if (dyn) return send({ ok: true, source: 'dynamic', file: dyn.file, sourceUrl: dyn.sourceUrl, capturedAt: dyn.capturedAt, label: dyn.label, fields: dyn.fields })
            return send({ ok: false })
          }
          let host = ''
          try { host = new URL(url).hostname } catch { return send({ ok: false }) }
          const st = replicaFor(host)
          if (st && staticReady(st.file)) return send({ ok: true, source: 'static', file: st.file, sourceUrl: st.sourceUrl, capturedAt: st.capturedAt, label: st.label, fields: st.fields ?? null })
          const dyn = getReplicaForDomain(host)
          if (dyn) return send({ ok: true, source: 'dynamic', file: dyn.file, sourceUrl: dyn.sourceUrl, capturedAt: dyn.capturedAt, label: dyn.label, fields: dyn.fields })
          return send({ ok: false })
        }

        const m = u.pathname.match(/^\/api\/replicas\/dyn\/(.+)$/)
        if (req.method === 'GET' && m) {
          const { REPLICAS_DIR } = await import(pathToFileURL(path.resolve(process.cwd(), 'engine/replicaStore.ts')).href)
          const file = path.basename(m[1])
          const full = path.join(REPLICAS_DIR, file)
          if (!full.startsWith(REPLICAS_DIR + path.sep) || !fs.existsSync(full)) { res.statusCode = 404; return res.end() }
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          return fs.createReadStream(full).pipe(res)
        }

        next()
      })
    },
  }
}

function replicateApi(): Plugin {
  return {
    name: 'invoca-replicate-api',
    configureServer(server) {
      server.middlewares.use('/api/replicate', async (req, res) => {
        const u = new URL(req.url || '', 'http://x')
        const target = u.searchParams.get('url') || ''
        const probe = u.pathname.startsWith('/probe')
        const mod = await import(pathToFileURL(path.resolve(process.cwd(), 'engine/replicate.ts')).href)
        try {
          const r = await mod.fetchReplica(target)
          if (probe) {
            res.setHeader('Content-Type', 'application/json')
            return res.end(JSON.stringify({ ok: true, finalUrl: r.finalUrl, title: r.title, forms: r.forms, formFields: r.formFields, bytes: r.bytes, ms: r.ms, via: r.via, fallbackReason: r.fallbackReason }))
          }
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          return res.end(r.html)
        } catch (e: any) {
          const msg = e?.message || 'Could not replicate that page.'
          if (probe) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            return res.end(JSON.stringify({ ok: false, error: msg }))
          }
          res.statusCode = 400
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          return res.end(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:40px;color:#333">${msg}</body>`)
        }
      })
    },
  }
}

/* Dev-only endpoint: POST /api/chat { brain, messages, voice? } returns the
   agent's next reply (fast Haiku model). Powers the iPhone "Preview Agent" SMS
   chat and, with voice:true, the live Voice-agent phone call. */
function chatApi(apiKey: string | undefined): Plugin {
  return {
    name: 'invoca-chat-api',
    configureServer(server) {
      server.middlewares.use('/api/chat', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        const send = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        try {
          let raw = ''
          for await (const chunk of req) raw += chunk
          const { brain, messages, voice } = JSON.parse(raw || '{}')
          if (!brain?.customerName) return send(400, { error: 'brain.customerName is required.' })
          if (!apiKey) return send(500, { error: 'ANTHROPIC_API_KEY is not set. Add it to .env or export it before `npm run dev`.' })

          const { chatReply } = await import(
            pathToFileURL(path.resolve(process.cwd(), 'engine/chat.ts')).href
          )
          const reply = await chatReply(brain, Array.isArray(messages) ? messages : [], apiKey, { voice: !!voice })
          send(200, { reply })
        } catch (e: any) {
          console.error('[chat] failed:', e)
          // "Overloaded" (529) / rate-limit (429) are transient — return a clean,
          // friendly message (never the raw SDK JSON) and a 503 so the client retries.
          const overloaded = e?.status === 529 || e?.status === 429 || /overload/i.test(String(e?.message || ''))
          send(overloaded ? 503 : 500, { error: overloaded ? 'The AI is briefly overloaded — one moment, please resend.' : (e?.message || 'Chat failed.') })
        }
      })
    },
  }
}

/* Dev mount for the shared demo library (/api/me, /api/demos*). Uses the SAME
   handler as the production server (engine/demoApi.ts) so the two can't drift.
   Locally there's no sign-in, so everything is attributed to the "Local Dev"
   identity that googleAuth.currentUser() falls back to. */
/* Resolves a prospect's og:image for the ChatGPT flyout hero. Lazy + cached in
   engine/ogImage.ts, so it adds NOTHING to profile-generation time. Mirrored in
   server.ts — keep the two in sync. */
/* Real business photo/rating for the ChatGPT flyout. Lazy + cached in
   engine/places.ts, so it adds nothing to generation time. Mirrored in
   server.ts — keep the two in sync. Key stays server-side. */
function placeApi(): Plugin {
  return {
    name: 'invoca-place-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!(req.url || '').startsWith('/api/place')) return next()
        res.setHeader('content-type', 'application/json')
        try {
          const q = new URL(req.url!, 'http://x').searchParams
          const { fetchPlace } = await import(
            pathToFileURL(path.resolve(process.cwd(), 'engine/places.ts')).href)
          const env = loadEnv('development', process.cwd(), '')
          const info = await fetchPlace(q.get('name') || '', q.get('city') || undefined,
            env.GOOGLE_PLACES_API_KEY)
          res.end(JSON.stringify({ place: info }))
        } catch {
          res.end(JSON.stringify({ place: null }))
        }
      })
    },
  }
}

function ogImageApi(): Plugin {
  return {
    name: 'invoca-og-image-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!(req.url || '').startsWith('/api/og-image')) return next()
        try {
          const domain = new URL(req.url!, 'http://x').searchParams.get('domain') || ''
          const { fetchOgImage } = await import(
            pathToFileURL(path.resolve(process.cwd(), 'engine/ogImage.ts')).href)
          const url = await fetchOgImage(domain)
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ url }))
        } catch {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ url: null }))
        }
      })
    },
  }
}

/* Dev twin of POST /api/client-error — see the long note in server.ts for why the
   endpoint exists, why it sits outside the auth gate and why every field is capped.

   ⚠️ IT HAS TO EXIST HERE TOO, even though nobody watches alerts on a laptop: the
   client hook posts unconditionally, and a dev server with no such route answers the
   SPA's index.html with a 200, so the browser would report "sent" for a report that
   went nowhere. Locally the funnel logs rather than sending (non-production), which
   is exactly what makes the wiring testable without a channel. */
function clientErrorApi(): Plugin {
  return {
    name: 'invoca-client-error-api',
    configureServer(server) {
      server.middlewares.use('/api/client-error', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        try {
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const raw = Buffer.concat(chunks).toString('utf8').slice(0, 8192)
          const b = JSON.parse(raw || '{}') as Record<string, unknown>
          const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '')
          const route = str(b.route, 120) || 'unknown'
          const name = str(b.name, 80) || 'Error'
          const { alert } = await import(pathToFileURL(path.resolve(process.cwd(), 'engine/alerts.ts')).href)
          void alert({
            key: `client:${route}:${name}`,
            title: `Client error on ${route}`,
            detail: `${name}: ${str(b.message, 300)}`,
            context: {
              route,
              caught: str(b.where, 40) || 'window',
              prospect: str(b.prospect, 60) || undefined,
              stack: str(b.stack, 600) || undefined,
            },
          })
        } catch { /* a reporter must never throw */ }
        res.statusCode = 204
        res.end()
      })
    },
  }
}

/* GET /api/status — the same public deploy-status payload the prod server serves,
   from the same module, so the two can't drift. Locally the RENDER_* fields come
   back null, which is exactly how you tell a dev server from the real deploy. */
function statusApi(): Plugin {
  return {
    name: 'invoca-status-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if ((req.url || '').split('?')[0] !== '/api/status') return next()
        try {
          const { deployStatus } = await import(pathToFileURL(path.resolve(process.cwd(), 'engine/status.ts')).href)
          const { authEnabled } = await import(pathToFileURL(path.resolve(process.cwd(), 'googleAuth.ts')).href)
          const { alertSummary } = await import(pathToFileURL(path.resolve(process.cwd(), 'engine/alerts.ts')).href)
          const env = loadEnv('development', process.cwd(), '')
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(deployStatus({
            livekitConfigured: !!(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET),
            anthropicKey: !!env.ANTHROPIC_API_KEY,
            googlePlacesKey: !!env.GOOGLE_PLACES_API_KEY,
            mapboxTokenInServerEnv: !!env.VITE_MAPBOX_TOKEN,
            emailConfigured: !!(env.SMTP_USER && env.SMTP_APP_PASSWORD),
            renderConfigured: Boolean(env.BROWSERLESS_TOKEN || process.env.BROWSERLESS_TOKEN),
            authGate: authEnabled,
            alerts: alertSummary(),
          })))
        } catch (e: any) {
          console.error('[status] failed:', e)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: e?.message || 'status failed' }))
        }
      })
    },
  }
}

/* Dev-side twin of the production feedback mount, so the board and the form work
   against `npm run dev` exactly as they do live. Email is unconfigured locally
   unless SMTP_* is in .env, in which case a would-be send is logged. */
function feedbackApi(): Plugin {
  return {
    name: 'invoca-feedback-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || ''
        if (!url.startsWith('/api/feedback')) return next()
        try {
          /* Uploads are binary: collect Buffers and concat, never string-concat,
             which would corrupt every byte above 0x7F. */
          const chunks: Buffer[] = []
          if (req.method !== 'GET' && req.method !== 'DELETE') for await (const c of req) chunks.push(Buffer.from(c))
          const rawBuf = Buffer.concat(chunks)
          const isUpload = /\/api\/feedback\/[^/]+\/files/.test(url)
          const [{ handleFeedbackApi }, { currentUser }, { isAdmin }] = await Promise.all([
            import(pathToFileURL(path.resolve(process.cwd(), 'engine/feedbackApi.ts')).href),
            import(pathToFileURL(path.resolve(process.cwd(), 'googleAuth.ts')).href),
            import(pathToFileURL(path.resolve(process.cwd(), 'engine/demoApi.ts')).href),
          ])
          const user = currentUser(req)
          const base = process.env.BASE_URL || 'http://localhost:5173'
          const parsed = isUpload ? rawBuf : (rawBuf.length ? JSON.parse(rawBuf.toString('utf8')) : undefined)
          const result = await handleFeedbackApi(req.method || 'GET', url, parsed, user, isAdmin(user), base)
          if (!result) return next()
          if (result.binary) {
            res.statusCode = result.status
            for (const [k, v] of Object.entries(result.binary.headers)) res.setHeader(k, v as string)
            res.end(result.binary.buffer)
            return
          }
          res.statusCode = result.status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(result.body))
        } catch (e: any) {
          console.error('[feedback] failed:', e)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: e?.message || 'Feedback request failed.' }))
        }
      })
    },
  }
}

/* Dev-side twin of the production Ingest-O-Matic mount. Materializes each
   subagent's network_config.env + state/ symlink once when the dev server
   starts (mirrors the one-time boot step in server.ts's app.listen callback —
   Vite's dev server has no equivalent "boot" hook, so configureServer is it). */
function ingestApi(): Plugin {
  return {
    name: 'invoca-ingest-api',
    async configureServer(server) {
      try {
        const { materializeIngestAgents } = await import(pathToFileURL(path.resolve(process.cwd(), 'engine/ingestAgentPaths.ts')).href)
        const { ready, notConfigured } = materializeIngestAgents()
        if (ready.length) console.log(`📞 Ingest-O-Matic: credentials configured for ${ready.join(', ')}.`)
        if (notConfigured.length) console.log(`📞 Ingest-O-Matic: no credentials set for ${notConfigured.join(', ')} yet.`)
      } catch (e) {
        console.error('[ingest] could not materialize subagent folders:', e)
      }

      server.middlewares.use(async (req, res, next) => {
        const url = req.url || ''
        if (!url.startsWith('/api/ingest')) return next()
        try {
          let raw = ''
          if (req.method !== 'GET' && req.method !== 'DELETE') for await (const chunk of req) raw += chunk
          const [{ handleIngestApi }, { currentUser }, { isAdmin }] = await Promise.all([
            import(pathToFileURL(path.resolve(process.cwd(), 'engine/ingestApi.ts')).href),
            import(pathToFileURL(path.resolve(process.cwd(), 'googleAuth.ts')).href),
            import(pathToFileURL(path.resolve(process.cwd(), 'engine/demoApi.ts')).href),
          ])
          const user = currentUser(req)
          const result = await handleIngestApi(req.method || 'GET', url, raw ? JSON.parse(raw) : undefined, user, isAdmin(user))
          if (!result) return next()
          if (result.binary) {
            res.statusCode = result.status
            for (const [k, v] of Object.entries(result.binary.headers)) res.setHeader(k, v as string)
            res.end(result.binary.buffer)
            return
          }
          res.statusCode = result.status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(result.body))
        } catch (e: any) {
          console.error('[ingest] failed:', e)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: e?.message || 'Ingest-O-Matic request failed.' }))
        }
      })
    },
  }
}

function demoLibraryApi(): Plugin {
  return {
    name: 'invoca-demo-library-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || ''
        /* ⚠️ WIDENED 9/21/2026 to admit /api/admin-notice/ack alongside /api/me
           and /api/demos — handleDemoApi owns all three, and a narrower prefix
           here silently 404s a route the production twin already serves (that
           one forwards every /api/* path and lets handleDemoApi return null). */
        if (!url.startsWith('/api/me') && !url.startsWith('/api/demos')
          && !url.startsWith('/api/admin-notice')) return next()
        try {
          let raw = ''
          if (req.method !== 'GET' && req.method !== 'DELETE') for await (const chunk of req) raw += chunk
          const [{ handleDemoApi }, { currentUser }] = await Promise.all([
            import(pathToFileURL(path.resolve(process.cwd(), 'engine/demoApi.ts')).href),
            import(pathToFileURL(path.resolve(process.cwd(), 'googleAuth.ts')).href),
          ])
          const result = await handleDemoApi(req.method || 'GET', url, raw ? JSON.parse(raw) : undefined, currentUser(req))
          if (!result) return next()
          res.statusCode = result.status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(result.body))
        } catch (e: any) {
          console.error('[demos] failed:', e)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: e?.message || 'Demo library request failed.' }))
        }
      })
    },
  }
}

/* Dev-only endpoint: POST /api/ai-assistant { customerName, dashboardTitle,
   dataContext, question, history } → the "Ask AI" dashboard assistant's reply:
   either a text answer about the data, or a generated tile spec (kpi/line/bar/
   pie). Fast Haiku model; key stays server-side. */
function assistantApi(apiKey: string | undefined): Plugin {
  return {
    name: 'invoca-assistant-api',
    configureServer(server) {
      server.middlewares.use('/api/ai-assistant', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        const send = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        try {
          let raw = ''
          for await (const chunk of req) raw += chunk
          const input = JSON.parse(raw || '{}')
          if (!input?.customerName || !input?.question) return send(400, { error: 'customerName and question are required.' })
          if (!apiKey) return send(500, { error: 'ANTHROPIC_API_KEY is not set. Add it to .env or export it before `npm run dev`.' })

          const { askAssistant } = await import(
            pathToFileURL(path.resolve(process.cwd(), 'engine/assistant.ts')).href
          )

          /* ⚠️ SSE ONLY WHEN THE CLIENT ASKS. The voice workflow's drawer opts in because its
             answer runs on Opus with adaptive thinking and takes real seconds; every other
             screen still gets one JSON body, so nothing else changed shape. Same
             `text/event-stream` framing the Launch screen's build checklist already reads. */
          if (input?.stream) {
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/event-stream')
            res.setHeader('Cache-Control', 'no-cache, no-transform')
            res.setHeader('Connection', 'keep-alive')
            /* Proxies buffer SSE without this, which turns a live progress bar into one jump
               at the end — the exact thing it exists to prevent. */
            res.setHeader('X-Accel-Buffering', 'no')
            const evt = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
            try {
              const result = await askAssistant(input, apiKey, (p: unknown) => evt({ type: 'progress', ...(p as object) }))
              evt({ type: 'done', result })
            } catch (e: any) {
              console.error('[ai-assistant] failed:', e)
              const over = e?.status === 529 || e?.status === 429 || /overload/i.test(String(e?.message || ''))
              evt({ type: 'error', error: over ? 'The AI is briefly overloaded — one moment, please resend.' : (e?.message || 'Assistant failed.') })
            }
            return res.end()
          }

          const result = await askAssistant(input, apiKey)
          send(200, { result })
        } catch (e: any) {
          console.error('[ai-assistant] failed:', e)
          const overloaded = e?.status === 529 || e?.status === 429 || /overload/i.test(String(e?.message || ''))
          send(overloaded ? 503 : 500, { error: overloaded ? 'The AI is briefly overloaded — one moment, please resend.' : (e?.message || 'Assistant failed.') })
        }
      })
    },
  }
}

/* Dev twin of GET /api/zip — see server.ts. Kept in sync per the standing rule for
   these endpoint pairs. */
function zipApi(placesKey: string | undefined): Plugin {
  return {
    name: 'invoca-zip-api',
    configureServer(server) {
      server.middlewares.use('/api/zip', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        const send = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        try {
          const zip = new URL(req.url ?? '', 'http://x').searchParams.get('zip') ?? ''
          if (!/^\d{5}$/.test(zip)) return send(400, { error: 'Enter a 5-digit US ZIP code.' })
          if (!placesKey) return send(501, { error: 'Location lookup is not configured on this server.' })
          const { geocodeZip } = await import(
            pathToFileURL(path.resolve(process.cwd(), 'engine/places.ts')).href
          )
          const place = await geocodeZip(zip, placesKey)
          if (!place) return send(404, { error: `We could not find ZIP ${zip}.` })
          send(200, { place })
        } catch (e: any) {
          console.error('[zip] failed:', e)
          send(500, { error: e?.message || 'Location lookup failed.' })
        }
      })
    },
  }
}

/* Dev-only endpoint: POST /api/analyze { customerName, bookingTerm, customerNoun,
   transcript } → extracted SMS signals (fast Haiku). Powers the live-captured
   conversation's Analysis tab in the AI SMS Conversation Intelligence report. */
function analyzeApi(apiKey: string | undefined): Plugin {
  return {
    name: 'invoca-analyze-api',
    configureServer(server) {
      server.middlewares.use('/api/analyze', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        const send = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        try {
          let raw = ''
          for await (const chunk of req) raw += chunk
          const input = JSON.parse(raw || '{}')
          if (!input?.customerName || !Array.isArray(input?.transcript)) return send(400, { error: 'customerName and transcript are required.' })
          if (!apiKey) return send(500, { error: 'ANTHROPIC_API_KEY is not set.' })

          const { analyzeSms } = await import(
            pathToFileURL(path.resolve(process.cwd(), 'engine/analyze.ts')).href
          )
          const { signals, outcome } = await analyzeSms(input, apiKey)
          /* `outcome` is voice-only and absent for SMS; the client ignores what it does not use. */
          send(200, { signals, outcome })
        } catch (e: any) {
          console.error('[analyze] failed:', e)
          send(500, { error: e?.message || 'Analyze failed.' })
        }
      })
    },
  }
}

/* Dev endpoint: POST /api/livekit-token { brain, profileId, greeting?, voice? } →
   { url, token, room } for the LiveKit voice call. The API SECRET never leaves the
   server; the browser only ever gets a 10-minute join token. Answers 501 when
   LiveKit is not configured, so the client can fall back to the old pipeline
   instead of failing mid-demo. */
function livekitApi(env: Record<string, string>): Plugin {
  return {
    name: 'invoca-livekit-api',
    configureServer(server) {
      server.middlewares.use('/api/livekit-token', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        const send = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify(body))
        }
        try {
          let raw = ''
          for await (const chunk of req) raw += chunk
          const mod = await import(
            pathToFileURL(path.resolve(process.cwd(), 'engine/livekitToken.ts')).href
          )
          const cfg = mod.livekitEnv(env)
          if (!cfg) return send(501, { error: 'LiveKit is not configured. Add LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET to .env.' })

          /* ⚠️ CONFIG BEFORE BODY — see the note in server.ts. The readiness probe sends an
             empty body, so validating `brain` first makes an unconfigured server answer 400,
             which the client reads as "LiveKit is available" and the fallback never engages. */
          const { brain, profileId, greeting, voice } = JSON.parse(raw || '{}')
          if (!brain) return send(400, { error: 'brain is required.' })
          send(200, await mod.mintVoiceToken({ brain, profileId: profileId || 'demo', greeting, voice }, cfg))
        } catch (e) {
          send(500, { error: e instanceof Error ? e.message : String(e) })
        }
      })
    },
  }
}

/* Dev endpoint: POST /api/voice-preview { voice, text } → audio/wav, synthesized through
   LiveKit Inference on LiveKit credentials. Twin of the handler in server.ts.

   ⚠️ This REPLACED /api/tts, which called api.deepgram.com / api.elevenlabs.io directly with
   those vendors' own keys. Everything voice now goes through LiveKit; see engine/voicePreview.ts. */
function voicePreviewApi(cfg: { url?: string; apiKey?: string; apiSecret?: string }): Plugin {
  return {
    name: 'invoca-voice-preview-api',
    configureServer(server) {
      server.middlewares.use('/api/voice-preview', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        const sendErr = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        try {
          if (!cfg.apiKey || !cfg.apiSecret) return sendErr(501, { error: 'LiveKit is not configured. Add LIVEKIT_API_KEY and LIVEKIT_API_SECRET to .env.' })
          let raw = ''
          for await (const chunk of req) raw += chunk
          const { voice, text } = JSON.parse(raw || '{}')
          const mod = await import(
            pathToFileURL(path.resolve(process.cwd(), 'engine/voicePreview.ts')).href
          )
          const wav = await mod.synthesizePreview(
            { voice: String(voice ?? ''), text: String(text ?? '') },
            { url: cfg.url, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret },
          )
          res.statusCode = 200
          res.setHeader('Content-Type', 'audio/wav')
          res.setHeader('Cache-Control', 'no-store')
          res.end(Buffer.from(wav))
        } catch (e: any) {
          console.error('[voice-preview] failed:', e)
          sendErr(400, { error: e?.message || 'Preview failed.' })
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  /* PUT .env ON process.env FOR THE DEV SERVER.

     loadEnv() returns an object; it does NOT populate process.env. The API plugins
     below are handed the values they need explicitly, but the ENGINE modules they
     dynamically import read process.env directly (DEMO_ADMIN_EMAILS in demoApi,
     SMTP_* in mailer, DATA_DIR in demoStore). Under `npm run dev` those were always
     empty, so an admin-only feature was invisible locally and a completion email
     would never have sent no matter what .env said — both failing silently, which is
     the worst way for configuration to be wrong.

     A real shell variable still wins, so `FOO=1 npm run dev` overrides .env. */
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && process.env[k] === undefined) process.env[k] = v
  }
  const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
  return {
    plugins: [
      react(),
      generateApi(apiKey),
      deleteProfileApi(),
      replicateCaptureApi(),   // BEFORE replicateApi() — its /api/replicate prefix-match would otherwise swallow /api/replicate/capture and /lookup
      replicateApi(),
      placeApi(),
      ogImageApi(),
      demoLibraryApi(),
    feedbackApi(),
      ingestApi(),
      statusApi(),
      clientErrorApi(),
      chatApi(apiKey),
      assistantApi(apiKey),
      analyzeApi(apiKey),
      zipApi(env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_PLACES_API_KEY),
      voicePreviewApi({ url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET }),
      livekitApi(env),
    ],
  }
})
