# Invoca Demo Platform — Project Guide

## What this is
A **demo-generation platform** for Invoca Sales Engineers. It replicates Invoca
platform screens as **templates**, then customizes all the on-screen data for a
given prospect from just a **customer name + website URL**. Goal: an SE enters a
name + URL and gets a fully clickable, on-brand Invoca demo tailored to that
prospect (report data, dashboard, campaigns, products, etc.).

The end state is a clickable React app mirroring the Invoca platform, where every
data-driven screen reads from one **canonical customer profile** that an AI
**generation engine** produces per customer.

## How the team ships changes (read first)
`origin` = ddesai-invoca (the team's FINAL repo; its `main` is the team's STAGING area and what the
Render sandbox https://invoca-demo-platform-testing.onrender.com/ builds); `fork` = bmccarty322.
Production is moved from `main` by an outside process. Flow: `npm run start-work` (pull latest main
into the `staging` branch) -> change with Claude Code on `staging` -> `npm run push-staging` (merges
newest main, type-checks, pushes to the fork's staging) -> test locally with `npm run serve` ->
the user approves -> `npm run promote` (asks for YES, pushes staging to origin main) ->
`npm run check-deploy` and final review on the sandbox. Never push to `main` any other way, never
work on `main`, keep ONE piece of work in `staging` at a time. Diagram, rules and one-time setup:
**`docs/TEAM_WORKFLOW.md`**.
⚠️ Do not commit demos created while testing: they land in `src/data/generated/` and ship to everyone.

## Tech stack
- **Vite + React + TypeScript**, **React Router**, **Zod** (schema + validation)
- Node 25 (runs `.ts` directly for the engine)
- Anthropic SDK (`@anthropic-ai/sdk`) for the generation engine

## Run it
```bash
cd /Users/ddesai/invoca-demo-platform
npm run dev          # Vite dev server → http://localhost:5173/
npm run generate -- --name "Customer" --url https://customer.com/   # AI generate a demo customer
npx tsc --noEmit -p tsconfig.app.json   # typecheck
```
The generate command needs `ANTHROPIC_API_KEY` in `.env` (already created; git-ignored).
The same key powers the in-app **Launch screen** (live generation), so `npm run dev`
must run with `.env` present.

## Shared team demo library (server-backed)
Demos are stored **on the server** so the whole team sees the same list, not just
whoever's browser generated them. Storage = **one JSON file per demo on Render's
persistent disk** (`engine/demoStore.ts`: `$DATA_DIR` → `/var/data` or `/data` if
mounted → `<repo>/.data` locally, git-ignored). `engine/demoApi.ts` is a
transport-agnostic handler (`handleDemoApi`) mounted by BOTH `server.ts` (prod) and
the `demoLibraryApi()` plugin in `vite.config.ts` (dev) — keep them in sync.

Routes: `GET /api/me`, `GET|POST /api/demos`, `GET|PATCH|DELETE /api/demos/:id`,
`POST /api/demos/:id/duplicate`.

### Checking the live deploy from outside the gate: `GET /api/status`
`curl -s https://invoca-demo-platform.onrender.com/api/status | python3 -m json.tool`

**PUBLIC** — registered ahead of the auth gate in `server.ts`, the same way
`/healthz` is, because the whole point is answering "did my push actually reach
the live site?" without signing in. One shared implementation in
`engine/status.ts`, served by BOTH `server.ts` and a `statusApi()` Vite plugin so
the two can't drift.

Reports: `commit`/`commitShort`/`branch`/`service` (Render supplies
`RENDER_GIT_COMMIT` etc. free — **null locally, which is how you tell a dev server
from the real deploy**), `bootedAt`, `uptimeSeconds`, `node`, a demo **count**,
`storage.persistent` (is the Render disk actually mounted, or are demos about to
be lost on redeploy?), and `integrations` as **booleans**.

⚠️ **It is public, so adding a field publishes it.** No prospect names, no demo
ids, no emails, no key values — counts and booleans only. Anything naming a
customer belongs behind the gate.

⚠️ **Every key presence is passed IN by the caller, never read from
`process.env` inside `status.ts`.** The first version read them directly and
reported the Places and Mapbox keys as `false` on the dev server even though
`.env` had both: Vite does not put `.env` into `process.env`, it exposes it via
`loadEnv()`. A status endpoint that under-reports configuration is worse than
none — it sends you hunting for a key that was already set.
⚠️ `mapboxTokenInServerEnv` is named for what it measures: the frontend needs
that token at **BUILD** time, so runtime presence does NOT prove the deployed
bundle carries it.

### The nightly canary: `GET /api/canary` (PUBLIC) + a 2am self-check
`engine/canary.ts` runs ONE full `generateProfile()` at **~5am Eastern**, times
every phase, audits the result, and **throws the profile away**. Armed from
`server.ts`'s `scheduleCanary()`; `CANARY=off` disables it, `CANARY_HOUR_ET`
overrides the hour, `CANARY_ON_BOOT=1` runs one immediately for wiring checks.
⚠️ **Two claude.ai routines read `/api/canary` at 6:00 and 6:30 ET, i.e. AFTER
this.** Moving the canary hour without moving them means they report on the
PREVIOUS morning's run and a real failure goes unnoticed for a day.

**Why it lives in the web process** and not in a cloud agent or a Render cron:
`generateProfile()` needs `ANTHROPIC_API_KEY`, and the deployed service is the one
place that already has it. That means **no new endpoint that bypasses the Google
gate, and no secret handed to anything else** — the scheduled cloud agent that
reacts to a regression only reads the PUBLIC result, so it needs no credential.
(The rejected alternative was a token-guarded generate route, which would have
required pasting that token into a routine's prompt.)

⚠️ **The profile is NEVER persisted** — not to the demo library, not to
`src/data/generated`. Only a small result record goes to `DATA_DIR/canary.json`
(last 30 runs). "Generate then delete" leaves junk behind whenever the run dies
between the two steps; this cannot, and it can never put a fake prospect in front
of the team. Verified end to end: `generated/` file count unchanged after a run.

⚠️ **Fixed rotating targets, deliberately not random.** Research time swings with
site size (measured 60s vs 85s across two prospects) — far larger than any
regression worth catching. Three stable sites rotate by day-of-year and each run is
compared against `history` for **its own `targetIndex`**.

⚠️ **`/api/canary` is PUBLIC** (registered before `installAuth`, like
`/api/status`), so adding a field publishes it. `toPublic()` deliberately omits the
target **names and URLs**: they are real companies, and a public endpoint implying
they are Invoca prospects is the exact leak `/api/status` was careful about.
`targetIndex` is enough to compare like with like.

`prefixSeconds` is **measured** as `research + terms` (the serial pre-pool time,
~40% of wall clock). It used to be derived as `total − longest phase`, which is
only correct while a POOL phase is the longest — the moment research becomes the
longest phase that formula silently reports nonsense. `slowestPhase` likewise
excludes research/terms, since those are serial and don't bound the pool.

The audit covers what **Zod does not**: the fields other screens silently fall back
on (the Search Term row the Google Ads keyword needs, the Product Category its ad
group needs, `smsPlaybook.qualifyingQuestions`, `brandDomain`, `bookingTerm`), the
canonical breakdown order, the dashboard **arithmetic** (complete partitions summing
to the call total, top-5s summing to less), and dash-joined prose. 13 checks on a
current profile. Tested in BOTH directions — silent on good profiles and actually
firing on 8 deliberately corrupted ones, because a check that never fires is
indistinguishable from no check.

Measured: 201.6s on a real run (budget 300s), 20 phases captured, 0 audit failures.

**Reacting to a regression is a scheduled cloud agent**, not this code: it reads
`/api/canary` and, if `needsAttention`, opens a **PULL REQUEST**. It must never push
to `main` — main auto-deploys, and a 2am agent must not deploy. See
[[invoca-demo-status-and-next-step]] in user memory for the routine id.

### Error handling: one funnel, and the rate limiting that makes it readable (9/16/2026)
Asked for directly: *"I want to get notified when anything goes wrong with the platform, the
small things like a feature is not working to bigger things like voice agent is not working or
the whole platform is down."* Then, on how: *"the best way to do it, not the easiest"*, with
**Slack** as the channel.

**MEASURED FIRST, and the gap was not where it looked.** The pieces were mostly here — the
canary already models generation health correctly, `engine/mailer.ts` already sends — and what
was missing was somewhere for a failure to GO:

| | state before |
|---|---|
| server errors | **21 `console.error` sites, and console was the only destination.** Render keeps the logs; somebody has to go and look |
| the browser | **completely dark**: no `window.onerror`, no `unhandledrejection`, and `DashboardBoundary` caught render errors and told NOBODY |
| unhandled throws | no `uncaughtException`, no `unhandledRejection`, **no Express error handler at all** |
| the canary's verdict | computed only when somebody READ `/api/canary` — if the tick died, the endpoint said so and nothing was told |

⚠️⚠️ **THE ONE FACT THAT SHAPES ALL OF IT: YOU CANNOT DETECT YOUR OWN OUTAGE FROM INSIDE THE
BOX.** The canary, `/api/status` and the mailer all run in the web process, so "the platform is
down" needs a watcher outside Render (that half is the user's to turn on — see the end). Every
other case can be reported from inside, and now is.

#### `engine/alerts.ts` — the funnel
⚠️⚠️ **THE RATE LIMITING IS THE FEATURE, NOT A NICETY.** An error in a hot path fires per
request, and a channel that delivers five hundred copies of one fault is a channel you mute —
after which the platform is *less* monitored than with nothing, because now you believe it is
covered. Three layers: dedupe by **signature** (a stable `key`, not the message — a message
interpolates ids); a re-send after the 30-minute cooldown carrying "fired N times since the last
alert", so a persistent fault escalates rather than going quiet; and a **global ceiling** of 12
an hour, past which one "being rate limited" notice is sent and the rest are counted.
⚠️ **SLACK IS A WEBHOOK URL AND NOTHING MORE**, which is what keeps an approval off the critical
path. `docs/INTEGRATIONS.md` records a CLOSED request for exactly this — *"Slack notification
when my demo finishes generating"*, rejected because *"it needs a Slack app and workspace
approval"* — but that was for `search:read`. Posting to one channel can come from an
incoming-webhook app (small approval), Slack's own **email-to-channel address (no approval at
all**, and it arrives through the mailer path), or a Workflow Builder webhook. The code cannot
tell them apart. Email is the FALLBACK, not a second channel: two channels for one fault is two
things to mute.
⚠️ A **dead webhook falls back to email** rather than losing the alert — a revoked webhook is
exactly the quiet breakage that would otherwise take the whole channel with it.
⚠️ **NON-PRODUCTION LOGS INSTEAD OF SENDING** (`ALLOW_ALERTS=1` overrides), the same rule and
the same reasoning as `sendMail`.

⚠️⚠️ **THE COOLDOWN IS PERSISTED TO `DATA_DIR/alerts.json`, AND THAT IS WHAT SURVIVES A CRASH
LOOP.** `uncaughtException` alerts and then exits; the host restarts; with in-memory state only,
the same fault notifies on every boot — the storm the dedupe exists to prevent, arriving by a
different door.

**`engine/admins.ts` is new: the admin list was EXTRACTED from `demoApi.ts`** so the funnel can
read it without a `demoApi -> alerts -> demoApi` cycle, since an alert has to be callable from
anywhere a failure happens — including a failed demo write. `demoApi` re-exports `adminEmails`,
so `feedbackApi` and `audit:app` are unchanged. Same reasoning that moved `leadSlug` and
`isProspect`.

#### The three bugs the audit found in my own funnel
Worth recording because each was invisible to a type check and two were invisible to reading:
1. **`repeats` was off by one, and was two different definitions.** Returning `since - 1` made a
   first report read 0, and therefore made the *second* occurrence of a quiet fault also read 0 —
   indistinguishable from "never happened before". It counts occurrences now and `render()`
   decides when to print.
2. **The title was uncapped.** The detail and context values were capped from the start; the
   title, which is where an exception message most often lands, was not. A 5,000-character title
   produced a 5,000-character Slack message.
3. **Repeat counts were lost across a restart**, because the state was only persisted when a
   notification was sent. The escalation line is most valuable for a long-lived quiet fault, and
   that was the exact case that lost it. A throttled write (60s) keeps both: counts survive a
   restart, and a storm costs one write a minute. **Consequence, stated:** occurrences inside one
   throttle window can be lost to a restart. That is a count slightly low, never a missed
   notification, because `notifiedAt` is written the moment one goes out.

#### `POST /api/client-error` — a broken screen reports itself
⚠️⚠️ **REGISTERED BEFORE `installAuth`, WHICH IS A DELIBERATE TRADE.** Behind the gate, an
expired session turns the report into a 302 to Google and the error is lost — and a session
expiring mid-demo is exactly when things break. So every consequence is handled instead: the body
is capped at 8KB, every field truncated, the signature NAMESPACED `client:` so a caller cannot
forge a server-side one, and the funnel's hourly ceiling means the worst an abuser achieves is a
handful of messages followed by suppression. It answers 204 whatever happens — a reporter that can
fail gives the page a second error to handle, on a path that only runs when something is already
wrong.
⚠️ **DEDUPED ON THE CLIENT TOO, and that is not belt-and-braces.** A React render loop fires the
same error hundreds of times a second; the server's cooldown stops the *notifications*, and only a
local guard stops the *traffic* — from the browser, during a demo, on the machine already
struggling. Verified live: the second throw of the same signature produced **zero** further
requests.
⚠️ **BOTH GLOBAL CHANNELS ARE HOOKED.** A rejected promise never reaches `onerror`, and this app
is almost entirely async — every `/api/*` call, the SSE stream, the LiveKit connection. Hooking
only the synchronous one would have missed the failures most likely to happen.
⚠️ **A BROKEN IMAGE IS NOT A PLATFORM FAILURE.** A failed asset also fires `"error"`, with no
`error` object and the ELEMENT as the target; unfiltered, every 404 favicon would report as a
fault. Verified live: a missing image produced zero reports.
⚠️ **`keepalive: true`**, because a crash is often followed by a navigation and an in-flight fetch
dies with the page.

#### The boundary was swallowing errors, and it only covered half the app
⚠️⚠️ `DashboardBoundary` caught the throw, rendered a tidy Undo button and **reported it
nowhere** — the one place in the app that KNOWS a render failed was also the one certain not to
say so. It has a `componentDidCatch` now, carrying the route and the prospect (which demo was
open is the first thing anybody would ask, and what makes it reproducible).
⚠️⚠️ **AND IT ONLY EVER WRAPPED `AppShell`'s `<Outlet/>`** — so Launch, the Preview Agent phone,
Google Search, the four Salesforce screens and `/replica` had **no boundary at all**, and neither
did the shell's own TopBar and Sidebar. A throw in any of those blanked the whole app. A new
`ScreenBoundary` wraps the entire route tree; nesting is deliberate, since React uses the NEAREST
boundary, so an in-shell screen still gets the Undo fallback and this one only handles what that
cannot reach.

#### The two automatic health signals
- **The canary's own verdict now raises an alert**, read back out of `toPublic()` rather than
  re-derived, so the Slack message and `/api/canary` cannot disagree about the same night.
  ⚠️⚠️ **HALF OF THIS SILENTLY DID NOT SHIP IN THE FIRST PUSH (`c3d6749`), AND THE WAY IT WAS
  FOUND IS THE POINT.** Splitting that commit meant replaying the alerting edits onto HEAD one
  at a time, and one was missed: `setInterval(alertOnCanary, TICK_MS)`, the PERIODIC evaluation.
  So the post-run call shipped and the arming did not — meaning a canary that **stopped running
  altogether** (the *missing* / *stale* case, which is the whole "silence is not success" point)
  would have reported nothing, while every other part of the feature looked present. Caught by
  diffing every alerting marker between `HEAD:server.ts` and the working tree before the next
  push, rather than by trusting the split. **Do that comparison after any hunk-level split of a
  feature**: a dropped hunk is invisible in a passing build and a passing audit. It
  covers *missing* and *stale* too, which is the "silence is not success" case that previously
  required a human to load the endpoint. **At most once per ET day** — the funnel's 30-minute
  cooldown would otherwise allow ~48 notifications for a signal that changes once a night, and a
  daily signal that pages twice an hour is a daily signal you mute. `etParts` was hoisted out of
  `scheduleCanary` so both use one answer to "what ET day is it".
- **Voice: the watchdog reports when no agent ever joins.** ⚠️⚠️ **AND IT IS DELIBERATELY NOT A
  WORKER-REGISTRY CHECK.** `/api/status`'s `livekitConfigured` only proves three keys exist; it
  says nothing about a worker being registered under this environment's `voiceAgentName()`, and
  the worker ships by `lk agent deploy` rather than `git push`, so a stale one is invisible. But
  `livekit-server-sdk` exposes no worker registry to ask, and inventing one would be a check that
  cannot be verified — the trap this file records repeatedly. What IS ground truth is the moment
  30 seconds elapse with nothing in the room: every documented cold start is over by then, so it
  is a dead worker or a wake-up far outside LiveKit's stated window, and both are worth knowing.
  It reports through the same client reporter, so it needed no new endpoint.

#### `/api/status` carries the counts
⚠️ **COUNTS AND SIGNATURES ONLY, NEVER THE DETAIL** — that route is PUBLIC, and the standing rule
is counts and booleans. `"chat-500"` is safe; the message that produced it is not, because a
message can quote a prospect or a URL. `alertSummary()` is built for this endpoint and
`audit:alerts` asserts the redaction by alerting with a prospect name in the detail and checking
it cannot be found in the summary. Passed IN by both twins like every other field, per the note at
the top of `status.ts`.

#### ✅ FIXED (9/16/2026): `server.ts` IS TYPE-CHECKED NOW
The finding below stood for about an hour and cost a real bug in the meantime, so it earned
its own fix. `tsconfig.node.json` now includes **`server.ts` and `googleAuth.ts`**, and
`tsc -b --force` is clean with them in.

⚠️⚠️ **THE BLOCKER WAS ONE IMPORT, AND THE FIX FOLLOWS A PATTERN THIS FILE ALREADY HAS.**
43 of the 44 errors came from `server.ts:591`'s dynamic `import("./src/data/replicaPages.ts")`
— a module full of `HTMLInputElement`, `Document` and `HTMLIFrameElement`, in a project that
compiles with `lib: ["ES2023"]` and no DOM. `src/data/leadFields.ts` was extracted for exactly
this reason once already (its own header says so, and `audit:replicas` records that importing
`replicaPages.ts` from `engine/` "breaks `npm run typecheck` — sixteen errors"). So:
**`src/data/replicaRegistry.ts`** now holds the static registry and its lookups
(`ReplicaPage`, `REPLICAS`, `replicaFor`, `replicaExpired`, `replicaBySlug`, `replicaSlugs`),
`replicaPages.ts` **re-exports** them so no existing importer changed, and both server twins
import the registry. The field-map DERIVATION, which reads a live document, stays behind.
⚠️ The other error was an unused `req` on `/auth/logout` (`noUnusedParameters`), renamed `_req`.

⚠️⚠️ **WHAT THE GAP ACTUALLY COST, both in this repo's own history rather than in theory:**
1. a required field added to `StatusInput` went unnoticed at the `deployStatus({...})` call
   site in `server.ts`;
2. while splitting the alerting commit, a **duplicated brace** in `server.ts` passed
   `tsc -b` and surfaced only when the server was booted (`Expected "finally" but found
   "}"`). A commit was minutes from shipping a file that cannot parse.
**Both were reintroduced deliberately and are now caught** — `TS2345` for the missing field,
`TS1472` for the brace.

⚠️ **`audit:replicas` PINS BOTH HALVES, because either alone is worthless**: the include, and
the server not importing a browser-only module. Five checks — server.ts and googleAuth.ts in
the include, server.ts not importing `replicaPages.ts`, the registry staying DOM-free, and
`replicaPages.ts` still re-exporting. Verified to fire: narrowing the include reddens 2,
re-pointing the import reddens 1.
⚠️⚠️ **AND THE FIRST VERSION OF THOSE CHECKS COULD NOT FAIL — the exact mistake this file
already warns about, made again.** `audit-replicas.ts` counts with `let bad = 0` and reports
through `no()`; the new block called `bad(...)`, so a failing check would have called a NUMBER
and crashed the script instead of printing FAIL. Both sabotages "passed". That warning is
already written down two sections above this one; read it before adding a check to that file.

#### ⚠️⚠️ THE ORIGINAL FINDING, kept for the measurement: `server.ts` WAS NOT TYPECHECKED
`tsconfig.node.json` includes only `["vite.config.ts", "engine"]`, so **the production entry point
has never been type-checked** — `npm run build` runs `tsc -b` plus a client-only vite build, and
neither reads it. Demonstrated rather than argued: adding a required field to `StatusInput`
compiled clean, and `server.ts` was calling `deployStatus({...})` without it. Measured with it
temporarily included: **45 errors — 1 real (that missing field, now fixed), 1 trivial (an unused
param in `googleAuth.ts`), and ~43 DOM-type errors from ONE import**, `server.ts:491`'s dynamic
`import("./src/data/replicaPages.ts")` — a module `engine/replicaCapture.ts` already warns about
by name ("that module is full of `HTMLInputElement`"). So the fix is not a two-line include: it
needs that lookup moved out of a browser-side module, or a third tsconfig with the DOM lib.
**Left as a flagged finding rather than restructured mid-build**, and it belongs high on the
error-handling list, because an untypechecked production entry is a source of exactly the runtime
errors this work exists to catch.

#### Then: every failure path wired, through ONE helper (9/16/2026)
The gap left by the first pass, and it was the important one. **18 `console.error` sites in
`server.ts`, 5 alerts** — and the 13 that mattered all CATCH and respond, so they never reach
the Express error handler either. Generation, chat, analyze, the demo library, the feedback
board, Gong, Drive, the ZIP lookup, the voice preview, the LiveKit token mint. Two replicate
paths logged **nothing at all**, which is worse than a bare log: not even a line to find later.

⚠️⚠️ **A HELPER (`routeFailed`) RATHER THAN 13 PAIRED CALLS, AND THAT IS THE WHOLE POINT.** Two
statements that must always appear together will eventually appear apart, and the failure is
invisible: the endpoint still answers, the log still has its line, and nobody is told — which is
precisely the state this work started from. One function cannot log without alerting.

⚠️⚠️ **THE LEVELS ARE THE DIFFERENCE BETWEEN A CHANNEL YOU READ AND ONE YOU MUTE.** Not
everything pages:
| path | level | why |
|---|---|---|
| generation, chat, analyze, demos, feedback, LiveKit token | **page** | ours, and broken means a feature is down |
| **generate-persist** | **page** | the prospect was DELIVERED and then lost — silent data loss |
| chat / ai-assistant when `isOverloaded(e)` | **record** | a 529 is expected, self-correcting, and already surfaced as "briefly overloaded, please resend" |
| replicate (both paths) | **record** | usually the TARGET site blocking a datacenter IP (AutoNation and Orlando Health both do) — not ours, not actionable at 2am |
| Gong, ZIP, voice preview | **record** | one integration or one control degrades |

⚠️ **THE CANARY TICK NOW REPORTS ITS OWN THROW.** It was covered only indirectly: no run
recorded means `toPublic()` reports *stale* the next day. True, but a day late.

⚠️ **THE DEV TWIN IS DELIBERATELY NOT WIRED.** Alerting is a production concern and local logs
rather than sends, so 13 more `alert()` calls in `vite.config.ts` would be churn for no signal.
That asymmetry is principled rather than an oversight — unlike `/api/client-error`, which IS in
both twins, because the client posts unconditionally and a missing route would answer with
`index.html` and read as success.

**`npm run audit:alerts` is 47 checks**, and it is the reason to trust any of the above.
⚠️⚠️ **IT DELIVERS TO A LOCAL HTTP SERVER IT STANDS UP ITSELF.** The dedupe, the cooldown and the
ceiling are only observable once a send SUCCEEDS — with no channel configured every call returns
`sent: false` and every check would pass against a funnel that dedupes nothing. That is the
tautological-check trap this file records three times over, so the fake webhook is not
convenience, it is the only way the assertions mean anything.
⚠️ It also checks the **wiring**, because a perfect funnel nobody calls is the silent no-op this
file records six times: both process handlers, the crash alert being AWAITED (a floating promise
dies with the process, so the most important notification is the one that would never leave), the
Express handler's **four-argument arity** (Express decides by arity — a three-argument one is
ordinary middleware and silently never runs) and its registration AFTER the catch-all, both twins
serving the endpoint, the boundary reporting, and the route tree actually being wrapped.
⚠️ Five sabotages were each verified to fire: removing the dedupe (7 red), disabling persistence
(1), removing the ceiling (4), leaking the detail into the summary (1), and removing the
non-production gate (1).
⚠️⚠️ **AND IT CHECKS THE REMAINDER, NOT A CALL COUNT.** Counting `routeFailed` sites would pass
the day somebody adds a 16th handler that quietly goes back to a bare `console.error`. Instead
every surviving `console.error` in `server.ts` must match a short allow-list of things that
legitimately are not routes (the helper itself, the two crash handlers, canary scaffolding, the
boot seeder). Verified by putting one route back to a bare log: it reddens and **names the file
and line**.

**Verified live in the browser**, not by construction: a thrown `TypeError` and a rejected
`RangeError` both reached the funnel and appear on `/api/status` as `client:/:TypeError` and
`client:/:RangeError`, with the dev-server log showing the signature, title and detail and
correctly declining to send because this is local.

**And verified end to end against the PRODUCTION entry point** (`npm start` with a stand-in
webhook on localhost, so no real credential was involved), both levels through real endpoints:
- `/api/replicate/probe` with an unreachable URL — the route genuinely threw, `routeFailed`
  logged `api:replicate`, it was counted on `/api/status`, and **nothing was posted**, which is
  what `record` means;
- `/api/client-error` — posted, carrying route, `caught: boundary`, the prospect, the user agent
  and the environment tag.
`/api/status` then read `channel: "slack"` with both signatures and their counts and **no detail**.
⚠️ `/api/analyze` with no API key was tried first and correctly alerted NOTHING — it guards on
the missing key and returns early rather than throwing. A guard is not a failure.
⚠️ **NOT verified by a forced render crash**: the boundary's report path is checked by the audit
and shares the reporter proved above, but no screen was made to throw for real. Say so rather than
implying otherwise.

**Still needs credentials the assistant cannot create** — and until then the funnel degrades
honestly (`channel: "none"` on `/api/status`, everything logged): a `SLACK_WEBHOOK_URL` or a
channel email address, Render's own deploy/service-failure notifications turned on, and an
external HTTP monitor on `/healthz` with a **2-failure threshold** (the drain returns 503 for ~40s
on every deploy, so a 1-strike monitor pages on every push). Sentry, for grouped stack traces with
source maps, is the other half of "best" and is not built.

### "Lead Form Performance Summary" — Marketing Performance dashboard
A KPI card directly UNDER "Call Performance Summary", same 4-tile shape so the two
read as a channel pair: Lead Form Count · the prospect's engagement-rate tile · the
conversion percent · revenue.

**Derived in the screen, folded into the registered page data** (so the assistant can
edit its values and rename its labels like any built-in tile, and undo covers it). No
schema slice and no engine phase, so all 19 profiles on disk get it.

Anchors live in **`src/data/leadForms.ts`**, shared with the Location Comparison
scorecard so the two screens cannot disagree about the form count:
`aiMessagingImpact.aiLeadEngagement` → Form Submits + its engagement-rate tile, and
`aiAgentConversion`'s "LEAD FORM (Conversions)" cards for revenue and conversion.
⚠️ Conversion is **revenue-weighted** across those cohorts, not a straight mean — a
plain average of 24/28/31% lets the smallest cohort drag the headline number.
⚠️ The **conversion and revenue LABELS are read off the neighbouring call card's
tiles**, so the pair stays consistent per vertical ("Watch Sold" for a watch dealer,
"Policy Bound" for an insurer, "Move Booked" for a mover) instead of hardcoding one
prospect's vocabulary. Returns null and the card is omitted when the anchors are
missing. Sanity-checked across all 19 profiles: form revenue is always a fraction of
call revenue, never larger.

### The "volume is not value" story — now ENFORCED, not just asked for
Every Call Outcome Summary must open on the highest-volume row with the WORST
conversion rate and close on the smallest with the BEST, because that contrast is the
SE's line: "your biggest channel is not your best channel."

⚠️ **It was silently not holding, and in four profiles was exactly INVERTED** — the
biggest row carried the BEST rate on all six breakdowns, so the tile said the opposite
of the story. Audited 2026-08-05: autonation / continuing-life / key-whitman /
orlando-health inverted on all 6, mattress-firm on 4, and two RECENT profiles missed it
on one each (Product Category, Region). Prompt-only, nothing verified it, invisible
until an SE told that story on a call.

The likely cause was ambiguity: every breakdown has TWO percent columns and
`outcomeStory()` said "the WORST rate" without saying which. It now names the
**conversion column (index 2)** explicitly — col 1 is Quote Discussed, or
"<booking> Set (Industry)" on Product Category — states the rule as "first row lowest,
last row highest", says it applies to EVERY breakdown including Product Category and
Region, and tells the model to re-read the column before returning.

**Enforced by the canary**: 12 checks (both halves × 6 breakdowns). Same
instruct-then-enforce pairing as the dashes and rule 2, and the fix is verified rather
than assumed — regenerating AutoNation took it from **12 story failures to 0**, with
every breakdown rising monotonically (Campaign 14→17→21→25→33%).
⚠️ Reading column 1 by mistake is how a first pass at this check mis-scored Product
Category; the conversion column is index 2 on every breakdown shape.

### The tier misses are SALES VALUE now, and the calls carry it (8/27/2026)
Reported against Aptive, looking at its Silver rail: "I don't like the unmet signals, they don't
show a strong missed value. Let's do sales related signals, like pricing, competitors, and
anything else that may show the value that they missed out on with just phrase spotting. Of
course fix the transcript as well."

Both halves were real problems, and the second one was the cause.

**1. The concepts are sales-value signals.** The first set included **Unmet Need Stated** and
**Add-On Interest**, and the criticism is right: "this caller has a need" is what every inbound
call has, so missing it costs nobody anything. Each concept now names revenue that left the call
undetected:

| signal | what missing it costs |
|---|---|
| Price Sensitivity | you cannot see which leads are lost on cost |
| Competitor Comparison | competitive losses are invisible in the call data |
| `<booking>` Intent | a caller who said yes is logged as a non-conversion |
| Upsell Opportunity | expansion revenue nobody attributed to the call |
| Urgency Expressed | hot leads are not prioritised or routed |
| Contract Objection | the objection nobody is coached on |
| Decision Maker Absent | the deal risk that explains the follow-up nobody made |

⚠️ "Add-On Interest" became **Upsell Opportunity** — the same detection, named for the money.
Aptive's caller asks "What about mosquitoes? Our backyard was terrible last summer" and the agent
parks it for a spring quote: a second service line the customer raised and nobody counted.
⚠️ `/how does .* work/` came OUT of that concept: it matched Aptive's "How does that work
exactly? Is it just one visit?" — a clarifying question about the plan being bought — and because
non-late concepts scan earliest-first it beat the real upsell four turns later.

**2. THE CALLS THEMSELVES WERE THE PROBLEM, AND THE PROMPT WAS WHY.** `engine/core.ts` asked for
"a NEW customer inquires… the agent gathers name + needs, recommends products… and SCHEDULES it",
so every generated call is a clean happy path: no price question, no competitor, no objection.
The derivation can only find what the caller actually said, so the strongest available misses were
the weak ones. The prompt now REQUIRES three moments spoken by the caller — a price or budget
concern, a competitor comparison, and one of (commitment worry / a second service they raise / a
deadline / needing to check with a partner) — with worked examples of saying them SIDEWAYS,
because a caller who says "that's too expensive" hands the keyword library its detection and
there is no gap left to demonstrate.

**`scripts/enrich-ci-sales.ts` brings the calls that already exist up to that shape.** 12 of 13
profiles on disk, plus the Aptive demo on the server. Every prospect now shows **3 to 6** sales
misses, all led by pricing and competitors.

⚠️⚠️ **THE MODEL DESCRIBES THE INSERT AND THE SCRIPT SPLICES IT — and asking for the whole
transcript back was a mistake this file already warned about.** The first version did exactly
that, and the Digital Journey column-edit note says why it fails: "asked to emit full cell lists
and copy the untouched columns verbatim, Haiku rewrote real values… Splicing makes preservation
STRUCTURAL." Measured on the first run, it dropped **Marriott's "That works for our budget. Can
we hold that reservation?"**, National Van Lines' price question AND "What's the next step?", and
**both of Aptive's booking turns** — the exact lines the tier reports quote and the conversion
comment anchors to. An 85% retention threshold passed all of it, because it counted turns instead
of weighing them. With insertions the originals survive by construction: verified against
`git show HEAD:` for all 12, zero dropped.

⚠️ **THE TIMESTAMPS ARE THE SCRIPT'S, NOT THE MODEL'S.** Told to re-time, it paced Marriott at
~12s a turn and pushed a 2:31 call to **4:10** — outside the 1:30 to 3:00 these are generated at.
Re-timed at 5 to 7 seconds, varied by index so it is not a metronome and deterministic so a
re-run produces the same call.

⚠️⚠️ **THE ACCEPTANCE TEST IS THE REPORT, NOT THE WORDING, and three wording proxies were worse
than the outcome check.** Banning every concept's hard phrases in any new turn failed an AGENT
line offering to cancel "immediately"; scoping it to caller turns then failed FOUR prospects for
writing "I'm getting a couple of quotes RIGHT NOW", a COMPETITOR line tripping the URGENCY
keyword. Neither is a defect. Each candidate transcript now goes through the SAME `tierView` the
screen renders, and is accepted only when Competitor Comparison actually comes out as a MISS, a
price moment is on the rail, and there are at least 3 unmet rows. That is what caught a "How is
your **pricing** stacking up" turn every wording rule had passed.
⚠️ **`CONCEPT_HARD_PHRASES` is exported from `signalTiers.ts`** so the script cannot drift from
the derivation — it was policing a shorter local copy.

⚠️ **REQUIRING PRICING *AND* COMPETITOR AS MISSES FOUGHT A CALL THAT ALREADY HAD A PRICE
QUESTION.** National Van Lines' "How much should I expect this to cost roughly?" contains "cost",
which a keyword library genuinely CATCHES — and five attempts running, the model destroyed that
real turn trying to satisfy the check. The prompt now says leave an existing moment alone, and
the check asks for pricing to be ON THE RAIL (met or unmet) rather than necessarily missed. An
honest MET row answers the request; a fabricated miss would not.

⚠️⚠️ **HEALTH SPRING IS SKIPPED, AND ENRICHING IT WOULD HAVE BROKEN ITS REPORTS.** Its pair is
the hand-authored one and its comments quote its transcript verbatim ("I'd like to move forward",
"I don't have coverage yet"). Rewriting that call would leave quotes on the Comments tab that no
turn says any more — the fabricated-evidence failure `audit:tiers` exists to catch, introduced by
the script meant to improve things. It needs no enrichment: `tierView` returns its configured
lists whatever the transcript holds.

⚠️ **THE COMMENT CAP WENT 5 -> 8.** It was set to match Health Spring's hand-authored 4, which
was fine while three misses was the most anyone had; with the sales concepts Goosehead and
Mattress Firm hit SIX, and `audit:tiers` caught the sixth unmet row having no talk track behind
it. An unexplained row is the one an SE gets asked about.

**Aptive, the demo this started from** — a library demo, so patched through the API round trip
(pull, splice, PATCH, read back; `updatedAt` bumped by the handler):

| | before | after |
|---|---|---|
| Silver unmet | Add-On Interest, Unmet Need Stated | **Price Sensitivity, Competitor Comparison, Service Appointment Intent, Upsell Opportunity** |
| call | 22 turns, 2:38 | 28 turns, 2:47 |

Its caller now says "what does that Initial Service run? I want to keep it manageable", "I'm
getting a couple of quotes from other local guys too", and "I'd like to get started, but I should
probably check with my husband first" — so the intent miss means a real conversion logged as a
non-conversion.

⚠️ **CONSEQUENCE, STATED: the `aiSummary` on each enriched profile still describes the call as it
was.** Summaries are selective, so omitting the price and competitor exchange is not wrong, and
its outcome line and key points are all still true. Regenerate that slice if a summary ever needs
to mention them.

### Signal AI Silver / Gold now exists for EVERY prospect, derived (8/27/2026)
Asked for directly: "do for all prospect and also for all prospect moving forward, of course
reskinned for that prospect." Health Spring's hand-authored pair (the section below) is kept as
its CONFIGURED version and wins for that account; every other prospect's is **derived from the
Conversation Intelligence report it already has** — no engine phase, no schema slice, so all 13
profiles on disk have it and a prospect generated next month does too.

⚠️⚠️ **THE MISSES HAVE TO BE REAL, AND THAT IS THE ENTIRE DESIGN PROBLEM.** The claim on screen
is "a keyword library did not fire on this call, and AI did" — with the transcript open beside
the rail. Inventing three misses per prospect is trivial and worthless, because an SE reads the
caller's actual words two inches away. So each candidate is tested against the transcript in
BOTH directions:

1. a CONCEPT is located in the caller's OWN turns by the sideways phrasings real callers use
   ("what does that run", "can we hold that reservation", "do you also offer storage");
2. that turn is then checked against the PHRASES a hand-maintained library would hold ("what
   does it cost", "price", "budget", plus the prospect's own booking term). Contains one ->
   Silver legitimately **CATCHES** it, and it renders as a met row. Contains none -> a genuine
   **MISS**, quoted verbatim on the Comments tab.

⚠️ **SO THE COUNT VARIES PER PROSPECT, AND THAT IS THE HONEST OUTCOME RATHER THAN A GAP.**
Measured across all 13: Roto-Rooter **5**, four prospects 4, three 3, five 2, and **Marriott
exactly 1** — its caller says "budget", "reservation" and "enroll me" out loud, so that call
really is well covered by keywords. Five prospects also carry honest Silver HITS. A comparison
where the old product detects nothing is one a prospect stops believing, which this file already
says about Health Spring.

| | Silver | Gold |
|---|---|---|
| Marriott | 6 rows, 1 unmet (Add-On Interest) | 11 rows |
| Roto-Rooter | 10 rows, 5 unmet | 16 rows |
| Health Spring (hand-authored) | 7 rows, 3 unmet | 13 rows |

**Two approaches were tried and the first one failed, which is worth recording.** Deriving the
misses from the prospect's OWN SIGNAL NAMES (does this signal's name appear in the transcript?)
produced almost no misses at all — the generator writes both the signals and the transcript, so
a signal's words are nearly always present. That measurement is what forced the concept lexicon.

⚠️ **TWO ATTRIBUTION RULES, both found by reading the output for all 13 rather than one:**
- **Scan ALL the turns and PREFER an uncaught one.** Taking the first soft match declared
  "Silver catches this" for Continuing Life on an early turn, while a LATER turn said the same
  thing in words no list holds.
- **A "late" concept may not land on the OPENING turn.** Preferring a miss pulled Key-Whitman's
  booking intent onto "I'm interested in getting LASIK. I've worn glasses forever" — the first
  thing said, and a motivation rather than a decision to proceed. When the only uncaught
  candidate is in the opening third and a later turn genuinely expresses it, the honest CAUGHT
  row beats a badly attributed miss.

⚠️ **"first time" AND "never used" ARE IN THE HARD LIST ON PURPOSE, and it costs two misses.** A
library plausibly holds "first time caller" / "never used you before", so calling a caller who
says those words a miss is the kind of over-claim a prospect catches. Both become honest Silver
HITS instead. Same conservatism as the booking term: Marriott's "Can we hold that reservation?"
was reported as a miss because the list held "reserve", which is not a substring of
"reservation" — while any hotel phrase library obviously holds it.

⚠️⚠️ **SILVER IS DELIBERATELY SHORT, AND THE FIRST DERIVED VERSION LOST THAT.** Including every
deterministic row plus two interest rows gave Silver **12 against Gold 13** — a rail that reads
as two nearly identical reports and throws away the point the signed-off version makes at 7 v
13. A hand-maintained library holds a FEW lists, because every entry is a plan year of upkeep,
and its length is itself the thing being sold against. Silver now keeps exactly what Health
Spring's own Silver keeps: the QA greeting, the answered/routing rule, the conversion phrase,
ONE product list, then the intent rows it misses. Named explicitly (`SILVER_LIBRARY`) rather
than sliced by position, because signal ORDER is the generator's.

⚠️ **GOLD ADDS AI, IT DOES NOT REPLACE.** An interest row keeps its original badge and gains
"AI", so the rail carries the mix — verified on every prospect: Keyword Spotting + Rule +
Keypress + AI, with Silver carrying no AI badge at all.

⚠️ **THE COMMENT ANCHOR WAS `transcript[length - 2]`, WHICH POINTED AT "Thanks again,
goodbye."** The comment explains that Silver matched the AGENT's scheduling phrase, so anchoring
it to the farewell is a contradiction a prospect reads straight off the transcript. It now finds
the agent turn carrying a scheduling VERB, scanning from the end — verbs only, because the
booking term itself is in the greeting ("Thank you for calling Marriott Bonvoy **reservations**"
anchored Marriott at 0:00), and "book" as a STEM, because Marriott's conversion turn is "I have
**booked** your ocean-view suite" and "book you"/"book a" skipped it onto "set up a profile".
Verified: 12 of 12 now land on the real scheduling turn.

⚠️ **`hasTierReports` FAILS CLOSED** — no CI report, no transcript, or no genuine miss means no
rows and a route that refuses, never an invented Silver list. It used to be `isProspect(HEALTH_
SPRING)`; the gate is now the MISS, not the name.

⚠️ **`signalTiers.ts` GAINED EXPLICIT `.ts` IMPORT EXTENSIONS** because `engine/canary.ts` now
imports it and the engine project compiles with `module: nodenext`. `engine/core.ts` already
imports `../src/data/schema.ts` the same way. Without it the node project failed with five
errors that read as type problems inside signalTiers rather than as a cross-project import.

**"MOVING FORWARD" IS ENFORCED BY THE NIGHTLY CANARY, not hoped for.** The misses are found by
matching the caller's own phrasings, and a future transcript is model-written — so a prompt
change could produce a call the lexicon does not recognise, `hasTierReports` would quietly go
false, and the two rows would stop appearing with nothing failing. `auditProfile` therefore
gained three checks (the pair builds · at least one genuine miss · Silver is shorter), so a real
generated prospect is checked every night. Verified to FIRE on a profile whose CI report is
stripped. ⚠️ If it fires, widen the CONCEPTS lexicon — do NOT loosen the phrase test that keeps
a miss honest.

**`npm run audit:tiers` (new, also run by `npm run audit`) covers all 13 profiles**, and the
central check is the **verbatim quote**: every caller line printed on the Comments tab must
appear in that prospect's own transcript character for character. Plus: the miss is real (the
quoted turn contains none of the phrases the comment names) · Silver shorter than Gold · Gold
carries AI and keeps its rules rows · Silver carries none · every Silver miss fires on Gold ·
no Health Spring vocabulary leaks · a profile with no CI report fails closed.
⚠️ **Each was broken on purpose, and THREE PROBES WERE WRONG BEFORE THE CHECKS WERE.** Removing
Silver's interest cap still left it shorter (it keeps 2 deterministic rows where Gold keeps
all), so that probe proved nothing until it also removed the `SILVER_LIBRARY` filter; and
"remove the fail-closed guard" was caught by a SECOND guard downstream, so both had to go.
Second time this session a probe, not a check, was the thing at fault.

Verified in the browser: My Reports lists both rows for Marriott, its Silver rail reads MET (5)
/ UNMET (1) in Marriott's own vocabulary, Gold reads 11 met with the badge mix, and the Comments
tab quotes "Yes, an ocean-view suite would be perfect. Do I earn points on an all-inclusive
stay?" verbatim. Roto-Rooter's Silver shows 5 unmet plus an honest catch. **The untiered report
is unchanged** — 0 tier elements, "MET SIGNALS" with no count, 9 rows, 0 AI badges — and Health
Spring still renders its hand-authored 7 / 13 with "Rules Based" and "Enrollment Intent".

### Signal AI SILVER vs GOLD — two versions of one CI report (Health Spring, 8/24/2026)
Built for an upsell call: Health Spring runs **Signal AI Silver** today and the conversation is
about moving them to **Gold**. Two extra rows on My Reports —
`Conversation Intelligence (Health Spring) (Silver)` and `… (Gold)` — at
`/reports/conversation-intelligence/silver|gold`. `src/data/signalTiers.ts` holds the content;
`ConversationIntelligence.tsx` gained an **opt-in `tier` prop**.

⚠️⚠️ **V2 EXISTS BECAUSE V1 SHOWED THINGS THE PRODUCT CANNOT DO, AND THAT IS THE LESSON.** The
first build (commit `a64c73f`) added a tier pill on the header, a sub-header, a fired-count, a
caller-sentiment ribbon, a Signal AI Discovery panel, a "what reaches your systems" panel,
explanatory notes under every signal row and a locked AI Summary tab. All of it read well and
**none of it exists on Invoca's real CI report** — so a prospect who knows the platform sees a
screen that could not exist and the demo stops being evidence. Removed on request the same day.
**Anything added back has to exist on the real report first.** A replica that out-features the
product is not a better demo, it is a worse one.

**What V2 renders, and it is only this:** the signal rail, split MET / UNMET, with the tier's
own badges. Silver 4 met + **3 unmet** (7 rows), Gold 13 met (13 rows). Everything else on the
page — header, toolbar, call list, transcript, Call Scoring, every other tab — is the base
report untouched.

⚠️ **THE TALK TRACK MOVED TO THE COMMENTS TAB**, which is a REAL tab on this screen holding
real free text anchored to a call time (the centre column already reads "Add comment at 0:00").
So the timing and the phrase-list explanations are one click away mid-demo and invisible while
the rail is on show. Silver gets 4 comments, Gold 5.

⚠️ **THE MISSES ARE ANCHORED IN REAL TURNS OF THEIR OWN CALL** — not the HCSC Medicare script
the request arrived with. Health Spring's transcript is Diana Whitfield, new to Texas, no
coverage, ~$500/month:
| turn | said | Silver's list |
|---|---|---|
| 1:52 | "I'd like to move forward" | "sign me up", "enroll me", "I want to apply" |
| 0:45 | "I'd like to stay around five hundred a month" | "too expensive", "cheaper", "what does it cost" |
| 0:07 | "I don't have coverage yet" | "uninsured", "no insurance", "lost my coverage" |
That first row is the lead of the call and the consultation IS booked 90 seconds later, so
Silver logs a real conversion as a non-conversion — and a missed signal raises no alert, it
just produces a slightly lower number.

⚠️ **SILVER'S HITS ARE HONEST, OR THE DEMO IS A STRAWMAN.** Silver DOES fire on
"Consultation: Scheduled" (the AGENT says "schedule a consultation" at 1:59 — a phrase list
genuinely catches that, and the Comments tab says so) and on Prescription Coverage, because the
word is spoken twice. A comparison where the incumbent detects nothing is one a prospect stops
believing.

⚠️ **SILVER IS DELIBERATELY SHORT: 7 rows against Gold's 13.** A phrase library is maintained
by hand, so its length is part of what is being sold against.
⚠️ **GOLD CARRIES ALL THREE BADGE TYPES — Rules Based, Keyword Spotting AND AI** (verified: 9
AI badges, all three types on one rail). Gold does not replace the deterministic detections;
the QA and routing signals keep their original badges and the three misses come back as AI.

⚠️ **THE BASE REPORT IS BYTE-IDENTICAL AND THAT IS STRUCTURAL, NOT CAREFUL.** `tier` defaults
to undefined, every tier block sits behind a `t &&` guard, and the untiered signal list keeps
its ORIGINAL markup in an `else` branch rather than being refactored into the new one.
Verified: original badges, "MET SIGNALS" with no count, Comments back to its empty state, and
**zero `[class*="ci-tier"]` / `[class*="ci-cmt"]` elements**.
⚠️ **WAS HEALTH SPRING ONLY** — as of 8/27/2026 every prospect has the pair (see the section
above). Health Spring keeps THIS hand-authored version; everyone else derives theirs. The
refusal path still exists and is what a prospect with no CI report gets.
⚠️ **CSS is all-new `.ci-tier-*` / `.ci-cmt-*` plus `.ci-sig-x` and `.ci-badge--ai`**; grepped
for zero prior uses before writing.

⚠️ **PREVIEWING A LIVE-ONLY DEMO LOCALLY:** Health Spring lives on the server, so a
`health-spring-preview` profile was built by grafting its REAL `conversationIntelligence` slice
(pulled from `/api/demos/health-spring` in a signed-in tab) onto a local profile. It is in
`.gitignore` so it can never reach the live site, and only the CI reports on it are faithful —
every other screen is another account's data wearing the name. Same trick as the Comfort
Keepers retarget, but with real data instead of a renamed matcher.

### AI Conversion by <Location> (`/dashboards/ai-conversion-by-location`)
⚠️⚠️ **COMFORT KEEPERS ONLY (scoped 8/24/2026, at the user's request).** It is the one dashboard
on Manage Dashboards gated to a single prospect, and **BOTH the list row AND the route are
gated** — gating only the row would leave a bookmarked or pasted URL rendering a full dashboard
for whichever prospect is active, which works perfectly for an account that is not supposed to
have it and is exactly the thing nobody notices until it is on a projector. Off-prospect the
route renders "Not available for <prospect>" with a link back. Matched by NAME through the
shared `isProspect`, never a guessed id. **To open it to every prospect, drop the `isProspect`
line in `ManageDashboards` and the guard in the screen — the data gates below already say who
CAN have it.**

⚠️ **`isProspect` MOVED TO `src/data/prospect.ts` — ONE implementation, several callers.** It
was a private function in `AgentWorkflow.tsx` (the Comfort Keepers SMS tree) and this screen
needed the identical test; two copies would eventually disagree about which prospect is which,
and the symptom would be the override applying to the workflow and not the dashboard. Verified
with 8 cases: all three plausible Comfort Keepers slugs and a double-space name match, and
`shady-blinds`, `comfort-inn`, `orlando-health` and `Keepers of Comfort` do not.

Requested 8/24/2026 beside the Location Performance Comparison, whose card shape it reuses:
**the top row is the whole organization**, then the same figures per franchise, carrying call
data AND the AI Agent Conversion dashboard's numbers split into **Lead Form / Voice Agent /
After Hours**. `FranchiseAiDashboard.tsx` + `src/data/franchiseAi.ts` (all the arithmetic).

**Derived**, like Location Comparison: no schema slice, no engine phase, so generation time is
unchanged and any prospect it is opened up to gets it for free. Listed only when the prospect
is Comfort Keepers AND has BOTH `locationHandling.rows` and `aiAgentConversion.conversionCards`,
since the channels are read off those cards. The title, both section headings and the table's first column all use the prospect's own noun.

⚠️ **THE NOUN IS OVERRIDDEN TO "Franchise" FOR COMFORT KEEPERS, and `vocabFor` is left alone.**
That helper answers "Community" for a senior-care operator, which is right for its own sites
and wrong for a FRANCHISE NETWORK whose `locationHandling` rows are literally "Comfort Keepers
of Memphis". The dashboard was asked for as a franchise breakdown, so the row read "AI
Conversion by Community" and was easy to scan straight past in the list. Overridden in
`franchiseAi.ts` rather than in `vocabFor`, which also feeds the Insights column catalogue, the
Configuration drawer and the question catalogue — renaming it there would change screens nobody
asked about.

⚠️ **"All Communitys" WAS ON SCREEN, and "All Facilitys" had been since this shipped.** The org
card built its plural as `noun + "s"`, which is fine for Franchise / Showroom / Store / Branch
and visibly broken for the two nouns ending in **y**. `pluralNoun()` handles y/s/x/ch/sh; unit
tested on all eight nouns the vocabulary can produce.
⚠️ **The headings carry a `{noun}` TOKEN resolved at render**, not a baked-in string, because
they are AI-editable labels: an SE who renames one drops the token and `fill()` becomes a no-op
on their text instead of overwriting it.

⚠️ **EVERY COLUMN RECONCILES, AND IT IS ASSERTED ACROSS ALL 11 PROFILES** (nine checks: calls,
revenue, forms, each channel's revenue, each voice channel's interactions, voice + after hours
= the call total, no empty channel, and every rate inside 0-99). `locationHandling` is a
complete partition and every apportioned column goes through `apportion()`.

⚠️ **THE LEAD FORM CHANNEL COMES FROM `leadFormFacts`, NOT A SECOND SUM OF THE SAME CARDS.**
That helper already publishes the form count, the revenue-weighted rate and the lead-form
revenue, and the Marketing dashboard's lead-form card reads the same values — so the two
screens cannot disagree.

⚠️⚠️ **AFTER HOURS IS THE ONE MODELLED CHANNEL, AND IT SAYS SO ON SCREEN** — a "Modelled" chip
on its card and a footnote under the table. No profile carries an after-hours field (checked
every slice; the phrase appears once across 19 profiles and not as data). Rather than invent a
share it is built on calls the prospect DID miss — `locationHandling`'s own "Call Not Answered
(Count)", real and per-location — converted at the **AI-ONLY** Voice Agent card's rate (chips
"Live Agent Call: No"), which is the right cohort for a principled reason: after hours there is
no live agent. Revenue then follows at the prospect's own revenue-per-booking. Every input is a
figure the prospect can find on another screen.

⚠️ **INTERACTIONS ARE COUNTED, NOT SUBTRACTED FROM A SUMMARY TILE.** The first version did
`summaryInteractions - forms - unanswered` and rendered **0** Voice Agent interactions on
Orlando Health, because that account's AI "Interactions" tile (1,247) and its Form Submits
(1,247) happen to be the same number — two unrelated slices agreeing by accident silently
emptied a column. Now: Voice Agent = ANSWERED calls, After Hours = unanswered, Lead Form = form
submits, so the two voice channels sum exactly to the call total.

⚠️ **A TOTALS ROW IS SAFE HERE, unlike on Location Comparison.** The three channels PARTITION
the AI revenue, so summing them is meaningful; that screen's Form-Attributed revenue is a cut
of call revenue and must never be summed with it.
⚠️ Per-franchise rates are the company rate scaled by that franchise's own booking rate
against the company's, clamped to 0-99. A single shared rate would make every row identical in
the only column a manager is reading.
⚠️ **ONE NEW CLASS ONLY** (`.fai-section`, a section heading). Everything else reuses
`.dash-page` / `.dash-card` / `.kpi-grid` / `.kpi-tile` / `.dash-table` / `.aac-conv-grid` /
`.aac-chip`.
⚠️ **A BARE `<>` IN A `.map()` HAS NO KEY.** The grouped header pair warned "Each child in a
list should have a unique key ... check the render method of `tr`", which reads as the cells
being at fault; the key belongs on a `<Fragment key=…>`.

### Location Performance Comparison (`/dashboards/location-comparison`)
A per-location scorecard for the prospect's MANAGERS: a card per location, then the
locations side by side — share of calls (donut), booking-rate ranking (HBarChart) and
a full-width head-to-head table with a metric per ROW and a location per COLUMN, which
is the orientation that lets a manager read one row and see who is ahead.

**Derived, not generated.** Everything comes from `opsDashboard.locationHandling` plus
the Marketing dashboard's KPI totals — no schema slice, no engine phase, so all 19
profiles on disk get it immediately, generation stays at ~2m45s, and the numbers AGREE
with the other dashboards instead of being a second conflicting set. Same approach as
`InsightsDashboard`. Listed in Manage Dashboards only when `locationHandling.rows` is
non-empty (every prospect currently has 4 rows).

⚠️ **The reconciliation is the point.** `locationHandling` is a complete partition:
measured on Avi & Co its rows sum to 5,943 calls = the Marketing dashboard's Call
Count exactly. **Revenue is split by BOOKINGS, then normalised to the company total**
(verified: the four parts sum to $21,628,598 to the dollar). Splitting by call volume
instead would imply every location converts identically, which contradicts the booking
rates printed right beside it — a 31% booker and a 19% booker would show the same
revenue-per-call. Columns a prospect can add up have to add up.

**Lead forms are per-location too**, derived from two real anchors rather than an
invented call:form ratio — `aiMessagingImpact.aiLeadEngagement`'s **Form Submits**
(Avi & Co: 1,247) and the sum of `aiAgentConversion`'s **LEAD FORM (Conversions)**
revenue tiles ($6,346,140). Volume splits by call share (the only per-location signal
the profile has); each location's forms convert at ITS OWN booking rate; form revenue
follows form bookings. `apportion()` makes both columns sum EXACTLY to their published
totals — verified 1,247 and $6,346,140 to the unit. If either anchor is missing the
lead-form rows are simply omitted, because a fabricated form count beside real call
counts is worse than none.

⚠️ There is deliberately **no "Form Booked (Percent)" row**. Form bookings are derived
FROM the call booking rate, so that row rendered identical to "Booked (Percent)" —
two matching percentage rows imply two independent measurements when only one exists.
Replaced with **Revenue per Lead Form**, which carries the same signal honestly.
⚠️ Revenue is labelled **"Form-Attributed"**, never "Total": it is the lead-form
channel cut, NOT an amount to add to the call revenue row above it. There is no totals
row on this table, so nothing sums them.

⚠️ **No new CSS**, per the request to keep the design identical: every class is one
another dashboard already uses (`.dash-page` / `.dash-card` / `.kpi-grid` / `.kpi-tile`
/ `.breakdown-row` / `.dash-table` / `.donut-wrap`), including `.aac-conv-grid` for the
cards row. Its column count is set from the data (`repeat(min(n,4), 1fr)`) — the same
pattern the AI Messaging cards use — so four locations sit on one row rather than
leaving an orphan card under three.

Columns are found by HEADER (`/call count/i`, `/not answered/i`, …), never by index, so
the engine reordering `locationHandling.columns` cannot silently swap Calls for
Voicemail. Headings go through `usePageDataWithLabels`, so the AI can rename any of
them and the edit belongs to this page alone.

### ⚠️ STANDING RULE for every Insights & Analytics screen: charts are interactive
**Every chart on an Insights & Analytics report must do three things**, and this applies to
reports built in future, not just the two that exist:

1. **Highlight on hover, fade the rest.** Bars fade to `0.22`, donut slices to `0.16` (plus a
   `0.28` halo just outside the hovered slice), phase bands to `0.14`. Multi-series charts
   fade by SERIES, not by single bar — pointing at a teal bar keeps every teal bar saturated,
   which isolates one metric across all rows. A heatmap is the exception: it **lightens** the
   hovered cell (`brightness(1.14)`) instead of dimming its neighbours, because on a colour
   ramp fading the others would change the very thing the colour encodes.
2. **Show a metrics panel.** Always `.ind-tip` — one CSS definition shared by every chart on
   every Insights screen, so they cannot drift. Positioned in PERCENTAGES of the chart's
   viewBox inside a `position: relative` wrapper (`.ica-chartwrap`, `.ind-timewrap`,
   `.ind-trendwrap`, `.donut-hoverwrap`); the svg scales with its column, so px drifts.
   Flip the panel toward the middle of the chart past the midpoint so it stays in the card.
3. **Open the interaction drawer on click** (`InteractionsDrawer` + `buildInteractions`),
   with the tile name as the title and what was clicked as the metric.

Every one of those fades **eases** — `transition: opacity 180ms ease`, one duration across all
of them. ⚠️ Transition `opacity` ONLY, never `all`: the hover panels are positioned with
left/top percentages and React reuses the same element as the pointer moves between bars, so
transitioning position makes the panel glide across the chart a beat behind the cursor. The
selectors are scoped so the six shared dashboards gain nothing — the donut's rule hangs off
`.donut-hoverwrap`, which only exists when `hover` is passed.

Bars sit `BAR_GAP = 4` units apart, and the two bars in a grouped row **touch** (the gap goes
between groups) — a group is one row of data, so its bars belong together.

Only the Summary Dashboard's FIRST bar sets `pinFirst`/`topCallHref`; no other chart offers a
clickable call, because the demo has one transcript.

### Insights & Analytics → Details Report (the flat call grid)
`/insights/dashboard/Details Report` (`InsightsDetailsReport.tsx` + `src/data/detailsReport.ts`,
`.idt-*`), from the capture "Insights & Analytics - Reports｜ Invoca for Healthcare 2.0"
(8/6/2026, network 2160, dashboard 4f3a7106). One row per call, 17 columns, a UNIQUE COUNT
footer under every column.

**Only 7 headers survived the capture** — the grid is ThoughtSpot-rendered, so there is no
body and no footer in the DOM. Five more come off the screenshot; the report scrolls further
right than the screenshot reaches, so **columns 13+ are unknown** and the last five are named
from headers verified on OTHER screens (the Digital Journey report, the Marketing dashboards).
Add the real ones if a wider screenshot turns up; do not guess further.

Chrome differences from the other two reports, all from the screenshot: **no Ask pill, no Add
Tile** (kebab only), and the filter chip is **unset** — "Call Start Time (Select)" with a lock
icon at the FAR RIGHT (`.idt-filters` overrides the justification; `.ind-filters` is untouched).
Because the filter is unset the report spans ~2 years, not the dashboards' one month.

No chart hover/drawer — the standing rule above is about CHARTS and this screen has none. Rows
are deliberately inert; the one openable call belongs to the Summary Dashboard's first bar.

Three traps this screen walked into, all fixed and all worth not repeating:
- **`hash % (endMs - startMs)` silently does nothing** over a 2-year span: that is 65 billion
  ms and a shifted 32-bit hash tops out near 134 million, so all 200 rows landed in the same
  1.5 days. Spread by day and second-of-day separately.
- **`MM/DD/YYYY` does not sort chronologically as a string** — "01/02/2024" compares before
  "12/06/2023" — so the TIME PERIOD footer came out backwards. Each row carries its real
  timestamp; the footer takes min/max off that.
- **"Repeat Caller (Invoca)" must be decided walking FORWARD in time**, not in generation
  order (which is hash order). Deciding it at generation and then sorting newest-first for
  display left a caller's oldest call flagged as a repeat. Verified: each caller's first call
  reads No, later ones Yes.

It renders **200 rows and says 200**. The real one says "Showing 1,000 of many rows" and
virtualises; 1,000 × 17 is 17,000 live cells, which stutters on a projector, and claiming
1,000 while showing 200 is catchable by anyone who scrolls. The footer's UNIQUE COUNTs describe
the WHOLE dataset (call record ids = the profile's own call total), which is consistent with a
caption that says "of many rows".

### Insights & Analytics → Connect AI (the agentic-rollout report)
`/insights/dashboard/Connect AI` (`InsightsConnectAi.tsx` + `src/data/connectAi.ts`, `.ica-*`),
from the capture "Insights & Analytics Connect AI｜ Invoca for Healthcare 2.0" (8/6/2026,
network 2160, dashboard c925e7d5). `/insights/dashboard/:name` now goes through
**`InsightsReport.tsx`**, which dispatches on the report name — the route stays one path
because the real product's does. `Details Report` still falls through to the Summary
Dashboard until its contents are defined.

The report is ONE argument: rolling out the AI agent lifted answer rate and bookings. Every
tile is the same month cut into **three phases** (Pre Agentic → Voice Agentic Only → Full
Agentic). Derived, so no engine phase and no schema slice: volume and revenue come from
`marketingDashboard` (the same rows Marketing Performance and the Summary Dashboard use),
handle time from `callDetail`, the vertical-specific intent from `aiMessagingImpact`.

**What is designed rather than measured** — and this is the honest bit: no profile records
when a prospect switched the agent on, because it never happened. The rollout curve
(answer rate 49→73→90%, booking rate 19→26→44%) is the capture's shape, jittered per
prospect, with each phase's rate built as the previous plus a positive step so a jitter can
never invert the story. What keeps it defensible is that the TOTALS it splits are real, and
they reconcile on screen: the three phase revenues sum to the headline, the three
appointment counts sum to "…: Scheduled", voice + messaging + phase 1 = total revenue, the
intent heatmap partitions the Full phase's interactions, and the cancellation bars sum to
the last tile. Verified all of those.

Three places where the real dashboard is internally inconsistent and this one deliberately
is not (a demo where a prospect can add the numbers up must survive it):
- The capture's phase tile reads **34%** where its own table reads 25% for the same phase.
  Here the tile and the table are the same computation, so they agree.
- The last tile puts a **count** (27) under the label "Revenue Retained". Here it shows
  actual revenue — cancellations saved × this month's revenue per booking — with the count
  as a sub-label.
- `signalsUnmet`/`signalsNa` (see below) — same class of problem, filed as an engine fix.

Intents come from the booking term plus generic service intents (Reschedule, Cancel,
Billing, General Info) plus ONE vertical topic, **not** from `commonTopicsChart` alone:
those series are TOPICS, and for a blinds company they render "Blinds / Shades / Shutters"
under a heading that says "Consumer Intents", which is wrong in a way prospects notice.

`.ind-*` header/filter/card rules are reused READ-ONLY. Never edit one for this page — add
an `.ica-*` override. Verified Summary Dashboard and Details Report are byte-identical
after the route change (same KPIs 48,293 / 20,224 / 28,069, same donut labels with counts,
trend + bar charts still present, no `.ica-page`).

### Insights & Analytics: chart click → interaction drawer → ONE call
Every datum on the Summary Dashboard drills in. Clicking a **bar**, a **weekly-trend
point** or a **donut slice** opens the right-hand interaction drawer
(`InteractionsDrawer.tsx` + `src/data/interactions.ts`), measured off the capture
"Insights & Analytics drawer" (8/5/2026) — 800px paper, 225ms slide, 184px cards, exact
badge fills for CALL `#122aa6` and SMS `#89005f` (LEAD's green is off a screenshot, not
the capture). Rows are DERIVED: the summaries are the prospect's own Call Review
summaries; ids, channel mix and durations are pure functions of profile + metric + date.

**Exactly ONE card opens a call**: the top card of the drawer opened by the **first bar**
(leftmost group, first series). That drawer sets `pinFirst` — which replaces its top card
with the prospect's own `reports.callDetail` record, so the card and the page agree on id,
duration and summary — plus `topCallHref`. Every other card is inert and has no pointer
cursor. The reason is that the demo has ONE transcript: thirty cards opening the same
transcript under thirty different ids is a lie, and a transcript per card would mean
generating thirty of them. Widen this only by generating real per-call transcripts.

The call page is **`/insights/call`** (`InsightsCallDetail.tsx`, `.icd-*`), from the
capture "Insights & Analytics - Showing Call｜ Invoca for Forrester" (8/6/2026). It is NOT
`/call-review/detail` — that is a different Invoca screen with its own `.cd-*` styles and
is deliberately untouched. Both exist on purpose.

Everything on it is derived from `reports.callDetail` (+ `digitalInsights.rows[0]` for
attribution, `voiceScreenpop` for the caller), so no engine phase and no schema slice:
- **Sentiment** counts genuinely positive vs trouble turns in the transcript and scores on
  the RATIO. Bare "thank you" does NOT count as a positive moment (every polite call has
  them; that is what the Proper Greeting / Helpful Agent scorecard signals measure) and
  the score must not sit on its clamp — the first version read "Positive (74)" where 74
  was the ceiling.
- **Found Phrases** under a met signal are looked up IN THE TRANSCRIPT (signal name →
  words ≥5 chars → first matching turn → the matched word plus two more), with the real
  speaker and timestamp. A signal with no hits renders as a plain "Rule" signal and "No
  spoken phrases found", which is what the capture shows for rule-only signals.
- **Signal group badges use the LIST LENGTH**, not `signalsUnmet` / `signalsNa`: the engine
  writes 26 and 25 for those on every generated prospect while the name arrays hold 5-15,
  so the badge would contradict the list it expands. Filed as a separate engine fix;
  `CallDetail.tsx` still shows the declared counts.
- The **player is visual only** (no call audio exists, same as `CallDetail.tsx`); its
  marker strip is one dot per transcript turn at that turn's own timestamp.
- **Coaching** and **Deliveries** show honest empty states rather than invented records;
  **Comments** renders the real `callDetail.comment`.

### AI column editing — Digital Journey report ONLY
The assistant can add / remove / rename / move the **leading columns** of the Digital
Journey & Call Attribution Report, including inserting one to the LEFT of Marketing
Source. Deliberately scoped to that ONE table: the dashboards' breakdown tables,
chart series, xLabels and every table's ROW count are still blocked.

⚠️ **The model does NOT emit the new rows.** It returns `kind:"editColumn"` with only
`{op, index, toIndex, header, values}` — where the column goes and one value per row —
and **`src/data/columnEdits.ts` splices it into the current data**. That is not
fastidiousness: asked to emit full cell lists and copy the untouched columns verbatim,
Haiku rewrote `cpc`→`Google Ads`, swapped real tracked URLs for invented ones, wrote
the literal placeholder `Home / Category / Subcategory` into a live demo, renamed a
header it was told to leave alone, and covered 5 of 21 rows. Prompting harder took it
from 7 rows to 5. Splicing makes preservation **structural**.

⚠️ `InteractionRow.cells` (optional) holds the generalized leading cells;
`dimensionColumns` is the header list. Rows without `cells` fall back
**header-driven** (`leadingCells` in `DataTable.tsx`): each header takes the field it
NAMES, and an unmatched header renders empty. An earlier version padded at the end,
which put Marketing Source under a new "Location" heading and shifted every value one
column left — a table that reads as data rather than as a bug.

⚠️ **Two bugs here existed only in the COMPOSITION of separately-passing parts**, so
test the join, not just the pieces:
- `editGuard` blocked every `rows.N.cells` edit because `cells` is absent until the
  first column edit and `undefined → array` is a type flip. The header edit applied,
  all 21 value edits were dropped, and you got a correctly-placed **empty** column.
  Now `undefined → array` is allowed on `LENGTH_IS_CONTENT` paths only (array only —
  `undefined → string` is still blocked, and the first fix was too broad until a test
  caught it).
- `table.report` was `width: 100%`, so extra columns squeezed rather than overflowed
  and `.table-scroll`'s `overflow-x` had nothing to scroll. Now `min-width: 100%;
  width: max-content` — same look at 9 columns, scrolls past that (measured: 2801px
  table in a 1010px wrapper).

⚠️ The drawer reports what actually landed ("I filled 20 of 21 rows"). An empty or
partial column must never read as success — the model's `values` count varies run to
run, and silence there looks like the feature half-working.

### Dashes in prospect data: swept at the SOURCE
`generateProfile()` in `engine/core.ts` runs `sweepValue()` over the assembled
profile before the final Zod parse, so the CLI, the dev endpoint, the prod
endpoint and the library publish ALL get clean data with nobody remembering a
script. `NO_DASH_RULE` in the prompt asks; this makes sure — the same
instruct-then-enforce pairing as `stripDashes` for the live agents' replies.
Prompt-only was not enough: the two most recently generated prospects arrived
with 24 dash-joined clauses between them and were only caught weeks later by
running `scripts/strip-dashes.ts` by hand, after both had been demoed.

One rule set in `engine/dashSweep.ts`, used by three callers (generation, the boot
migration, the script) so they cannot drift. **Em dashes are NOT banned outright,
only in prose** — audited across all 11 profiles: every remaining em dash is a
lone `—` table placeholder meaning "no value", which is real Invoca UI. Kept by
design: placeholders, compound words ("Certified Pre-Owned", "Tempur-Pedic"),
numeric ranges, and anything under a `dateRange`/`url`/`id`-style key
("Jan 1, 2026 - Jan 31, 2026" must keep its dash).
`npx tsx scripts/strip-dashes.ts --dry` re-audits at any time.

### ⚠️ Any server-side write to a demo MUST bump `updatedAt`
`DemoLibraryContext`'s self-heal only refetches when the library's `updatedAt` is
newer than the copy the browser cached. Both boot migrations
(`engine/dashSweep.ts`, `engine/demoPatches.ts`) wrote the file with a raw
`fs.writeFileSync` and left `updatedAt` alone, which made **every server-side
migration invisible to the very mechanism added to catch them** — the server was
correct and each already-loaded browser kept rendering the old content forever.
That is the "Bill is still seeing the old conversation" failure, and its real root
cause: the self-heal could never fire because nothing moved the timestamp it
watches. Both now bump it. If you add another writer, bump it too.
Note the boot migrations run in **`server.ts` only** — the Vite dev server does
not, so a local `.data` is only migrated once you actually run the prod entry.

**Ownership** (server-enforced — the frontend lock is convenience only):
- Anyone signed in can **list and view** every demo.
- Only the **creator** can PATCH/DELETE theirs (others get a 403 telling them to duplicate).
- Anyone can **duplicate** someone else's → a copy owned by them, named
  `<prospect> (copy)` (both `prospect` and `profile.customerName`) so the library and
  the customer switcher never show two identical entries.
- **PROJECT ADMINS can PATCH/DELETE every demo.** `ADMINS` in `engine/demoApi.ts`
  (currently `ddesai@invoca.com`) **plus** anything in the `DEMO_ADMIN_EMAILS` env
  var, comma separated. The env var is **additive on purpose**: replacing the list
  would mean `DEMO_ADMIN_EMAILS=bill@invoca.com`, meant as "Bill too", silently
  strips the project admin of access — the exact problem admin exists to fix. Read
  at module load, so adding an admin on Render needs a **restart, not a redeploy**.
  `owns()` and `isAdmin()` combine in ONE `canWrite()` helper so PATCH and DELETE
  can't drift apart.
  - **Admin is not ownership.** An admin write never reassigns `creator`; it sets
    `updatedBy` instead, so the library still shows whose demo it is, the owner
    keeps their rights, and the Launch row shows "· edited by <name>" when an
    admin last touched it. That audit line is the counterpart to the extra power.
  - The frontend gets `admin` from `GET /api/me` and `GET /api/demos` (the SERVER
    decides — a client that lied would just collect 403s). `useDemoLibrary()`
    exposes `admin` + `canManage(d)`; the Ask AI edit layer needed no change
    because it already keys off the server's `canEdit`.
  - Deleting someone else's demo is the one irreversible thing admin unlocks, so
    the confirm dialog names the owner ("It belongs to A Colleague, and you are
    deleting it as an admin").
  - ⚠️ Off-gate local dev is `local@dev`, which is NOT an admin, so the admin path
    cannot be exercised locally without temporarily adding it to `ADMINS`
    (`.claude/launch.json` does NOT pass env vars through — verified).

Identity comes from the Google sign-in gate (`googleAuth.ts` → `currentUser(req)`,
`@invoca.com` only); off-gate local dev is `Local Dev <local@dev>`.

Frontend: `src/data/DemoLibraryContext.tsx` (`useDemoLibrary()`). If the API is
unreachable it sets `available=false` and the app falls back to the local/bundled
profiles it always used. The **Launch screen** renders library demos + any local-only
profiles in one list: creator shown per row ("You" in blue, else their name), search
matches **prospect / industry / creator name / creator email**, others' demos get a
**Duplicate** button, only yours get **Delete**, and local-only demos get a **Publish**
(`cloud_upload`) button that pushes them to the library. A freshly generated prospect
is published automatically.

**AI edits are per-demo and persist server-side.** `AiAssistantContext.hydrateDemo(id,
customizations, canEdit, creator)` loads a demo's saved AI layer into the store (server
keys are bare pathnames like `/dashboards/marketing`; the store prefixes them
`<demoId>::<path>`), and an effect saves the active demo's slice back via PATCH,
**debounced 800ms**, owner-only, guarded by `lastSyncedRef` so loading doesn't
immediately re-save. On someone else's demo `readOnly` is true: `mutate`/`applyEdits`/
`undo` no-op, and the Ask AI drawer shows a "view only" banner and declines any
create/editData/editTile result.

### Ask AI + Undo on EVERY page (top bar, hover-revealed)
`TopBar.tsx` carries a sparkle (`auto_awesome`) and an undo, immediately left of
the star. They **always occupy their layout space and only fade opacity**, which
is what makes an invisible zone hoverable — `display:none`/`width:0` would leave
nothing to aim at. Revealed on hover of `.tb-ai` and on `:focus-visible`, so they
are not mouse-only, and absent from screenshots and live demos.

Scope key is `${profileId}::${pathname}` — the SAME key the dashboards already
used — so **nothing is dashboard-specific: a new screen gets both for free** by
calling `usePageData(profile.reports.<slice>)` (an alias of `useDashboardData`;
the six dashboards keep the old name). Opted in so far: digital-insights, the
three CI reports, Call Review, Call Detail, agent config / knowledge / AI
recommendations, Signal, and the Insights dashboard.

The three rules, and where each is actually enforced:
1. **Never spills to another page** — structural. Overrides are stored per page
   key and only read back by that page. Verified: editing revenue on
   `/dashboards/marketing` and a heading on `/insights/dashboard/...` produced TWO
   separate override keys and TWO separate undo stacks.
   ⚠️ **The guard that makes this true is in `AiAssistantDrawer`**:
   `registerScope` is only called by screens that HAVE data and **nothing clears
   it on navigation**, so `active` can still point at the last such screen. The
   drawer therefore honours the scope ONLY when `active.key === ${profileId}::${pathname}`,
   and otherwise treats the page as having nothing to edit. Without that check,
   the top-bar sparkle on a list page would silently edit the dashboard you were
   on two clicks ago — an invisible cross-page spill. Keep it.
2. **Never CSS/design/template** — enforced three ways, not one:
   - **CSS is structurally impossible.** No data value reaches a `className` or a
     `style` attribute (the few data-driven classNames are boolean toggles between
     states the designer already built), and nothing renders data as raw HTML —
     the single `dangerouslySetInnerHTML` is a hardcoded SVG in a no-props
     component. Verified by grep, not assumed.
   - **The prompt declines it** — "make the titles bigger and the background
     navy" was refused, no override written, computed style unchanged.
   - **`src/data/editGuard.ts` blocks SHAPE changes in code** (`applyEdits`).
     ⚠️ This was prompt-only and is the one real hole the audit found: the model
     was told not to change array lengths or value types, and `applyEdits` applied
     whatever came back. Array length **is** layout — `gridTemplateColumns:
     repeat(${tiles.length}, 1fr)` on the AI Messaging cards, a table's row count,
     a chart's series and legend — so "add a series" was a template change wearing
     a data costume, and a type flip (string → array) breaks the component. Both
     are now dropped with a `[ai]` console warning. 12 unit cases cover it: same
     length reshape allowed, add/remove/row-delete/type-flip blocked, null ↔ value
     allowed (a legitimate data state). Same instruct-then-enforce pairing the dash
     rule needed.
3. **Data only** (metrics, titles, names, signals) — that is what `editData` does.

**Undo is per page**, so it can never change a screen you are not looking at. It
greys out (opacity .38, still revealed on hover so its absence never reads as the
feature missing) when the current page's stack is empty.

### The workflow diagram is DATA — the AI can reshape it
`components/WorkflowTree.tsx` is ONE renderer for every Agent Studio flow diagram.
It replaced four hand-positioned trees (SMS, Voice, the National Van Lines split,
and the extra-workflow tree), each of which carried its own node coordinates and
SVG line endpoints — which is why adding a branch used to mean writing a new
component: **the geometry WAS the code**.

Now the **layout is computed** from the model: every leaf takes a column, a branch
centres over its own leaves, the connector bus spans only the outermost branches,
and a second fork appears when a branch has more than one leaf. So "add a branch",
"remove that path" and "split this into two teams" all just work.

`deriveTree(profile, isSms, channelLabel)` reproduces what the old trees rendered,
from `voiceCopy` — no schema change and no engine phase, so every prospect on disk
gets an editable diagram. `SHAPE` holds per-prospect shape defaults (National Van
Lines' two-team split, previously a 100-line component, is now a branch with two
leaves). `extraTree` maps an extra workflow's flatter branches onto the same model.

### The built-in SMS workflow is the measured six-row template, for every prospect (9/17/2026)
Asked for directly, with **thirteen SingleFile captures of a real Greenix SMS workflow attached**:
*"this is the workflow i want to replicate for all prospects"*, plus *"the fields in the drawers
are greyed out but i want you to make them white"* and *"add the 'add' functionality"*. Answers to
the three questions asked before building: **Apply really saves**, **the built-in workflow only**
(authored extras keep their own shapes), and **drop the MCP references**.

Every capture is in `reference/agent-workflow/sms-*.html` — the tree plus one per drawer, and the
EMPTY Qualify template that shows the editable state. `src/data/smsTemplate.ts` is the spine.

⚠️⚠️ **THE PRODUCT'S OWN MODEL IS RECURSIVE, AND THE CAPTURE SAYS SO OUTRIGHT.** Every node below
an intent is the same react-flow type — `react-flow__node-segment` — whether it is "All Sales
Inquiry Users", "New Customer, No" or "Serviceable=true". So there is no leaf-versus-path
distinction in the product; there is one kind of node that nests. Ours stopped at two levels
(`leaves` -> `paths`), so this needed exactly **one** more (`TreePath.paths`), not a rewrite:

```
Triggered by            y=0     "0 Campaigns, 2 Forms, and 1 Inbound SMS"
Conversation Start      y=168   "SMS · classify intent"
Sales Inquiry           y=336   Need Support
All Sales Inquiry Users y=504   All Support Users      Qualify / Support & Escalate
New <Noun>, No          y=672   Existing <Noun>, Yes   both Qualify
Serviceable=true/false  y=840   found= true / false    all four Inform
```

⚠️⚠️ **THE GEOMETRY IS `smsV2`, A THIRD GEO ENTRY — NOT A CORRECTION TO `sms`.** Read off the
react-flow transforms: **248px nodes on a 296 pitch** (248 + 48) and a **uniform 168 row pitch**,
corroborated by the edge paths, which run between node CENTRES at `left + 124` and also give the
node heights (trigger 93, start 69, intent 93, segment 81). So the real SMS page is far closer to
our `voice` geometry than to `sms`. `sms` is left alone because **seven signed-off extra workflows
draw it** (Orlando Health's five ER trees, Avi & Co - New, the generated quote-request ones), and
editing it would restyle all of them for a change asked about the built-in workflow.

⚠️⚠️ **A LATENT BUG THE DEEPER TREE EXPOSED: THE TOP OF THE TREE WAS CENTRED ON THE CANVAS, NOT ON
ITS OWN BUS.** The branch bus has always spanned `firstCx`..`lastCx` (the two intent centres) while
the stem feeding it dropped at `W / 2`. Those coincide only on a tree whose branches carry the same
number of terminals — which every SMS tree did, one per branch. With four terminals under Sales and
one under Support the trigger sat **222px left of the bus it connects to**. The capture settles the
rule: its Triggered by is at x=938, exactly the midpoint of its two intent centres (568 and 1308)
and NOT of its columns (716). `topCx` fixes it, and it is a **no-op on a symmetric tree** —
verified on the voice tree BEFORE changing it (trigger, bus centre and stem all read 840 already),
which is what keeps the signed-off diagrams still.

⚠️ **THE PATH ROW IS DEDUPED AND CENTRED NOW TOO.** It rendered one node per COLUMN keyed on the
flat slot index, correct only while a path IS a terminal; once a path has children it spans several
columns and the node drew once per child. Same `new Map` dedupe and `*Cx` midpoint the leaf row
already used. The leaf->path bus likewise spans **path centres** rather than the outermost terminal
columns — the capture's own edges run leaf centre -> path centre (x=568 to x=272).

⚠️ **CHIPS CAP AT FOUR, THEN `...`** — measured, and all five chips on a capped node carry
byte-identical classes, so the ellipsis is an ordinary chip rather than a muted variant. Rendering
all ten made a node three times its height and dragged its whole levelled row with it.

⚠️ **THREE ICONS EXTRACTED VERBATIM**, per the standing use-the-real-icons rule: `callSplit`
(Qualify) and `info` (Inform) did not exist here at all, and the support glyph is **`headsetMic`,
not the `headset` we already ship** — that one has no mic boom. `headset` is untouched because the
voice tree draws it.

#### The drawers: measured copy, and an Apply that really saves
⚠️⚠️ **THE SMS COPY IS NOT THE VOICE COPY, WHICH IS WHY THESE TABLES ARE SEPARATE.** Four strings
differ, and the structure differs too:
| | voice (8/26) | SMS (9/17) |
|---|---|---|
| inform label | "Inform & Route" | **"Inform"** |
| inform description | "The agent will answer the caller's question and transfer them…" | **"Provide information to the caller."** |
| inform prompt | "How should the agent inform and route callers?" | **"How should the agent inform users?"** |
| escalate description | "…escalate by transferring to the queue configured below." | **"…escalate based on the rules and destination configured below."** |
| inform fields | a phone number | **no phone row at all** — straight to Signal + What To Collect |
| escalate destination | a phone number | **a text input**, "Where should the agent escalate unresolved users?" (❌ this row read "an empty combobox" until 9/17/2026 — corrected below) |
| trigger drawer | count + 2 links | count + **the forms and inbound number listed** + 3 links |

⚠️ **THE `Inform` LABEL WAS NEARLY MISSED BECAUSE SingleFile WRITES UNQUOTED ATTRIBUTES.** The
combobox carries `value=Inform`, which a `value="..."` search does not match, so the field read as
empty and the drawer kept the voice label. Same trap this file already records for the Aptive form
capture and the insights SVG.

⚠️⚠️ **EDITABLE ONLY WHERE IT IS TOLD WHERE TO WRITE.** The grey the user described is the REAL
product's read-only state (measured: every field in the twelve configured captures carries
`disabled`, 12 `Mui-disabled` classes, and **no footer at all**); the empty template is the white
one, with an Add button and Cancel / Apply. Ours were already `background: #fff` — what was missing
was that every control was `readOnly` and `Add` was an `e.preventDefault()` stub. Editing is now
gated on `onApply` **plus** the drawer carrying `edits` write-paths, so a field with no home cannot
accept a keystroke that goes nowhere — the silent no-op recorded six times in this file. That gate
is also what keeps the **voice drawers byte-identical**: they were signed off read-only and nobody
asked to change them (asserted).

⚠️⚠️ **THE SEGMENTS ARE THE CHILD NODES, SO `Add` WRITES THE TREE.** A Qualify node's
Answers/Segments ARE the boxes on the row below — `workflowDrawers` has read them from the tree
since 8/27 with the note that says why. So `SmsConfig` deliberately holds **no** `segments`: the
only things registered are the fields the diagram cannot draw (questions, fallbacks, the four
instruction blocks, the escalation text, the intent descriptions and rules). Apply writes segment
changes to `branches.…paths` as whole NODES, carrying `segmentNodes` along so renaming one answer
cannot flatten the branch underneath it — verified: after adding a third answer, `paths.0.paths`
still held `Serviceable=true` / `Serviceable=false`.

⚠️ **APPLY RIDES `applyEdits` INTO THE PAGE'S OWN SCOPE**, which is what hands these edits
persistence per demo, an undo step on the page's stack and the `readOnly` refusal on somebody
else's demo, none of which a bespoke writer would get. `sms.intents.*.rules` joined
`LENGTH_IS_CONTENT`, **scoped to `sms.`** for the same reason `agent.` is: a bare `/rules$/` would
widen rule 2 across every screen carrying a `rules` array.
⚠️ **THE DRAWER READS THE EFFECTIVE CONFIG, NOT THE BASE.** Handing it `smsBase` would open it on
the template's defaults, and Apply would then write that stale copy back over an edit made a minute
earlier. Same trap `drawerFor` records for the voice spec.
⚠️ **CANCEL REALLY DISCARDS** — every edit lands in a local draft keyed on the drawer's identity,
so a mid-demo keystroke costs nothing and reopening a node never shows the last one's half-typed
text.

#### What was re-skinned, and what was refused
⚠️ **GREENIX'S TWO REAL SUPPORT NUMBERS ARE GONE** (844-233-7378, 833-729-4353), rebuilt on the
prospect's own area code with the reserved 555 exchange — the same rule the Google Search ad's call
extension follows. So is its inbound number.
⚠️ **THE MCP TOOL NAMES ARE GONE, on the user's own call when asked.** The capture instructs the
agent to call `greenix_check_zip_serviceable_greenhl` and `greenix_search_customer_greenhl`; a
`<slug>_check_zip_serviceable` on 145 prospects would be inventing an integration none of them has.
The instruction survives in plain English, which is what the field is for.
⚠️ **THREE COLLECT FIELDS WERE DROPPED RATHER THAN TRANSLATED.** "Pest Types" carries a
pest-control meaning no other vertical has, and "Property Type"/"Business Type" are a
residential-versus-commercial split that reads wrong for a hospital or a hotel. What survives is
either platform chrome or genuinely derived from the prospect, so every entry reads correctly on all
145 profiles. Same refusal as the ZIP3 guess and the fabricated accreditations.
⚠️ **THE CONDITION LABELS ARE VERBATIM, UNEVEN SPACING INCLUDED** — `found= true` and
`found = false`, one space before the equals on one and after it on the other. That is what the SE
typed and what the product draws; tidying it is the replica drifting from the thing it replicates.
Asserted, and the check fires.

**`npm run audit:ai` gained 24 checks** covering the shape against the capture, the re-skin (no
Greenix name, no real numbers, no MCP tool names, the 555 exchange, the prospect's own noun), each
drawer's structure, the editable gate in both directions, and a **135-combination sweep of the
six-row layout** asserting no connector inverts and that a tree WITHOUT a sub-row gets no
sixth-row geometry at all (`rowAt` mutates the shared shift — the trap already recorded for the
sub-bus). Five sabotages were verified to fire: tidying a condition label, restoring the voice copy,
putting the phone row back, reintroducing an MCP name, and flattening the recursion.
⚠️ **TWO OF THE NEW CHECKS FAILED ON CORRECT CODE FIRST — the fourteenth and fifteenth probe faults
in this file.** Both asked `"edits" in x`, which is FALSE when the builder simply omits the key,
i.e. exactly the read-only state they were written to confirm.
⚠️ **AND THREE CHECKS HAD TO BE RE-AIMED, NOT LOOSENED.** Three existing ones pinned the SMS intent
titles by grepping `AgentWorkflow.tsx`; the template moved to its own module, so they now BUILD the
tree and read it, which is strictly stronger (a grep passes against `if (false && ...)`). The
intent-count check went 8 -> 6 for the same reason. `audit:ai` also caught the template declaring
its own copies of the four chrome names instead of importing them from `workflowChrome.ts`.

**Verified in the browser**, at 1600px: 12 nodes on 6 rows at a uniform 168 pitch, 248px wide, a
296 column pitch, every parent centred over its own children, trigger/stem/bus-centre all 962,
whole tree fitting with no scroll. The Qualify drawer opens re-skinned ("Are you a new or existing
Aptive homeowner?"), all fields editable; **Add appended an answer, Apply created a real node
(12 -> 13) that survived a reload**, and the page's undo took it back to 12 and cleared the
override. Cancel discarded a pending Add. The four other drawer kinds each match their capture.
**Untouched and checked: the voice tree (12 nodes) and all three of its drawers, still entirely
read-only, two trigger links, no rows.**

#### Then: the measured palette, the dots, and the missing intent descriptions (9/17/2026)
Three things reported against the first build, with a fresh capture attached
(`reference/agent-workflow/sms-tree-v2.html`, which serialises its emotion CSS — so everything
below is a real computed style rather than a screenshot reading):
*"1. the boxes and pills are not the right color. 2. the background dots are too far apart and
also make them lighter. 3. The Sales Inquiry and Need Support are missing their description,
which should match what's in the box when clicked."*

⚠️⚠️ **A NODE IS TINTED BY ITS ACTION, AND `tone` COULD NOT EXPRESS THAT.** The product's whole
system is one hue per action: the card is that hue at **8%** with a **5px solid LEFT edge** at
full strength and **no other border**, the glyph sits in a **26px box of the same hue at 12%**,
and the action text and glyph take a **dark ink** of it. `tone` is one word for a whole card and
carries no ink, so `TreePath.actionKind` / `TreeLeaf.actionKind` were added (opt-in) and the
three `.wf-act-*` rules read them:
| action | hue (8% fill + 5px edge) | icon box (12%) | text + glyph ink |
|---|---|---|---|
| Qualify | `#D0C1F2` | `rgba(208,193,242,.12)` | `#440066` |
| Inform | `#2666F9` | `rgba(38,102,249,.12)` | `#11228C` |
| Support & Escalate | `#FF7045` | `rgba(255,112,69,.12)` | `#B33B00` |

Those inks are the platform's own — `#440066` and `#B33B00` already appear on the Integrations
badges and `.wf-leaf-orange`. ⚠️ **AND `Inform` IS BLUE HERE, NOT THE TEAL** the Create Workflow
note recorded for "Inform & Route" on the voice page; a different action with a different colour,
so both notes stand.

Other measured corrections to the card: radius **6** not 8, border **`#E7E9EB`** not `#d9dee4`,
padding **12** not `10px 14px`, and **no shadow at all** — the real cards are flat and separated
by their border alone. Conversation Start is **`#D4E0FE`**, the platform's titan blue-10. The chip
is **12px on `#E7E9EB` at radius 100px with no border**, where ours was 11px white-on-green — so
every pill had been tinted to the old green leaf. Connectors are **1px**, take **the colour of
the node they point at** (neutral `#D0D3D8` into the two intents, the action hue below that), and
each ends in a closed **arrowhead**.

⚠️⚠️ **ALL OF IT IS SCOPED TO `.wf-v2`, BECAUSE `.wf-node`, `.wf-chip` AND `.wf-leaf-*` ARE
SHARED.** The voice tree and seven authored extra workflows draw those same classes; restyling
them for a change asked about the built-in SMS diagram is what cost this repo 79 `.cd-*` rules
once already. `audit:ai` pins the shared rules as unchanged, and that check fires.
⚠️ **ARROWHEADS HAD TO BE OPT-IN IN THE COMPONENT, NOT JUST IN CSS.** `marker-end` is an
ATTRIBUTE, so no stylesheet scope can keep it off another diagram — `lineFor(kind, arrows)` gates
it, and without that the voice tree and all seven extras grew arrowheads. Caught by measuring the
voice tree after the change, not by reading the diff.

⚠️ **THE DOTS WERE BOTH TOO COARSE AND TOO HEAVY, AND THE FIX IS ONE MEASUREMENT.** react-flow
draws its grid as `<pattern width={gap*zoom}><circle r={size*zoom/2}>`; the capture is at zoom
0.5 with `width=8` and `r=0.25`, so the authored values are a **16px gap** and a **1px dot** in
**`#91919A`**. Ours was a 20px gap with a **1.1px RADIUS** — a 2.2px dot, nearly three times the
area — which is what read as coarse and heavy even in a paler grey. The finer, tighter grid is
simultaneously closer together and visually lighter, which is the whole of the report.
⚠️ **NOT SCOPED:** the canvas is shared chrome and was wrong on every workflow page, so this
fixes the voice diagram and the extra workflows too.

⚠️ **THE INTENT DESCRIPTION IS THE DRAWER'S OWN STRING, CLAMPED IN CSS.** 16px/400 at the title's
ink (not a muted grey), **flush left** — measured: the description's left edge and the title
icon's are both the card's own 12px padding, where ours indented 24px to clear the icon — and
`-webkit-line-clamp: 2`, which is where the "..." comes from. Clamped rather than cut in the data
because the FULL text is what the Intent Details drawer renders and what the agent's prompt is
built from; truncating the string would have shortened all three at once. `audit:ai` asserts the
node's subtitle IS the drawer's `looksLike`, so the two cannot drift.

**`audit:ai` gained 14 more checks** for the palette, the dots, the description and the
shared-class non-regression. Three sabotages were verified to fire: restyling the shared
`.wf-node`, coarsening the dots, and dropping the intent subtitle.
**Verified in the browser** on Aptive and Orlando Health: every measured value matches
(8%/12%/edge/ink per action, chip, card, start, 1px target-coloured connectors with arrowheads on
exactly the 11 drops the capture has, 16px/1px/#91919A dots), and the intents carry their
re-skinned description. **Untouched and checked: the voice tree** (8px radius, its own shadow,
14px titles, 11px chips, 2px grey lines, **zero** arrowheads, no `.wf-v2`) **and Orlando Health's
authored ER workflow** (10 nodes, 0 action tints, 0 markers).

⚠️ **A PRE-EXISTING FAIL-OPEN NOTICED WHILE TESTING, NOT FIXED AND NOT MINE:** opening an extra
workflow's URL whose slug no longer resolves — a generated quote-request workflow whose 7-day
capture has expired, say — falls through to the BUILT-IN SMS workflow rather than the
"Workflow not found" state a created workflow's unknown id gets. The heading does say
"<Prospect> - SMS", so it is not claiming to be the missing workflow, but the route is
fail-open where the created-workflow route is fail-closed.

##### And two bugs the palette pass left behind (9/17/2026)
⚠️⚠️ **THE LAST ROW MUST NOT BE LEVELLED, AND THE CAPTURE OVERRULES THE 9/8 SYMMETRY FIX FOR IT.**
Reported: *"the boxes should not be all sizes, they change based on the number of pills row. so in
this example there isnt any pills so it should be shorter."* Measured on the real bottom row:
**152 / 152 / 176 / 78** — every node sizes to its own content, `found = false` has no pills and
is less than half its neighbours, and even the three five-chip nodes differ because their chips
wrap to different numbers of rows. Ours levelled the row to its tallest and gave that node
**206px of mostly empty card**.

The 9/8 rule still stands for every row ABOVE: a row's bottom is where the next row's stems start,
so siblings hanging off one bus must share a baseline or their connectors cannot be equal.
**Nothing hangs below the last row**, so levelling it buys nothing and costs the shape — and the
capture agrees twice over, because its upper rows are equal-height anyway (their content is
equal). `levelRow` takes a `level` flag, `lastRow` is computed from the tree's own depth rather
than named, and the skip is **scoped to `v2`** so the voice tree's six use cases still sit at one
height (verified: all six still 162 with `min-height` applied).

⚠️⚠️ **A NEW ANSWER INHERITS ITS SIBLINGS' ACTION.** Reported: an answer added in the "All Sales
Inquiry Users" **Qualify** drawer came out reading **Inform**, white and untinted. Both halves had
one cause — Apply's default for a brand-new node was a hardcoded `{ action: "Inform" }` with **no
`actionKind`**, and the tint is keyed on the kind, so the card lost its colour as well as its
label. Siblings are the right source because they are peers under one question: the answers of a
Qualify are Qualifies and the answers of one of THOSE are Informs, which is exactly the shape the
capture draws. Falls back to Inform only when there is no sibling to copy.

⚠️ **AND `repairSmsSegments` FIXES THE ONES ALREADY STORED, AT READ TIME.** The override store is
per demo and syncs to the shared record, so a node written by the old code can reach a colleague's
browser where no migration ever ran — the same argument `toSteps` and the marketing-source rename
already make. A stale node is identified by the **absence of `actionKind`**, which is reliable
because the template has always set it, so the only way one reaches the store without it is the
old Apply path. It copies the first configured sibling, falls back to the action's own wording when
there is none, and **returns the same object when nothing needs repairing** so it never costs a
re-render. It also self-heals: the drawer reads the effective tree, so the next Apply writes the
corrected action back. Verified on the reported nodes — two `Test` answers stored as `Inform` with
no kind now render **Qualify** in lilac with the 5px `#D0C1F2` edge.

**`audit:ai` gained 7 checks** here (45 for this feature): the level flag and its v2 scope, the
computed `lastRow`, Apply's sibling inheritance, and `repairSmsSegments` against a real stale
shape, a lone stale node, and a clean tree (identity). Three sabotages verified to fire: levelling
the last row again, hardcoding a new answer's action, and making the repair copy a clean tree.
**Verified in the browser:** the bottom row measures 206 / 206 / 206 / **76**, a new answer added
under "New Homeowner, No" comes out **Inform** and 76px rather than levelled to its neighbours'
206, and the voice tree's last row is still levelled.

##### Drag the whitespace to move the diagram (9/17/2026)
Asked for directly: *"give the user the ability to click on any white space in the workflow box
and move the diagram around."* The real page does this and says so — measured in
`sms-tree-v2.html`, its pane carries `cursor: grab` (`.react-flow__pane.draggable`).

⚠️⚠️ **IT IS A FREE PAN ON ITS OWN TRANSFORM — AND THE FIRST VERSION, WHICH MOVED THE SCROLL
OFFSET, WAS WRONG IN A WAY ONLY A SCREEN RECORDING SHOWED.** Scrolling works and clamps for free,
but it can only ever travel INSIDE the content: you can never leave empty canvas on one side while
the diagram runs off the other. The user's video does exactly that — the tree dragged right until
its left half is bare canvas and Need Support is clipped off the right edge — so the real thing is
unbounded, and "it clamps for free" was a feature of the wrong mechanism rather than a property of
the real page.

The pan is now `translate(var(--wf-px), var(--wf-py))` on **`.wf-fit`**, composed with — not
replacing — the fit SCALE on `.wf-tree` inside it. Two elements, two transforms, so the drag has no
limits and the scale the zoom buttons own is untouched. ⚠️ **AND THE ZOOM ANCHOR HAD TO LEARN ABOUT
IT:** `zoomTo` works out the focal content point from the scroll offset, so without subtracting the
pan, zooming after a drag snapped the diagram back by the pan distance and the node under the
cursor slid away — the exact thing that anchor exists to prevent. Measured after the fix: 3px of
drift across a zoom step, which is rounding.
⚠️ **A CLAIM IN THE FIRST VERSION OF THIS NOTE WAS SIMPLY FALSE:** it said the wheel already
scrolled this box, so a drag and a two-finger scroll would agree. The wheel is intercepted by
`useFitScale` with a non-passive listener and `preventDefault` to ZOOM; it has never scrolled.

⚠️⚠️ **WHITESPACE ONLY, WHICH IS WHAT KEEPS THE NODES CLICKABLE.** A pointerdown on a node, the
zoom cluster or the minimap returns immediately, so opening a drawer is still one click and a drag
can never swallow it. And because the pointer is CAPTURED from the start, a drag that begins on
whitespace and ends over a node fires no click on that node either. Verified both ways: dragging
from a node leaves the scroll offset untouched, and clicking one still opens its drawer.

⚠️ **TOUCH IS LEFT TO THE BROWSER.** Handling it here as well as natively would move the diagram
twice per gesture, so `pointerType === "touch"` bails and `touch-action` is deliberately not set.
⚠️ **THE CLASS IS TOGGLED IMPERATIVELY**, not held in state: a `setState` per drag start would
re-render the whole tree mid-gesture for the sake of one cursor.
⚠️ **`setPointerCapture` IS IN A `try`.** It throws if the pointer is no longer active by the time
the handler runs, and a pan that can throw would take the diagram down with it; without the
capture the drag still works while the cursor stays inside the box, so failing there degrades
rather than breaks.

⚠️ **NOT SCOPED TO ONE TREE, and that is deliberate.** The canvas is shared chrome and the real
product pans on every workflow page, so the voice diagram and the seven authored extra workflows
get it too. It changes no layout and no colour — only the cursor — so it is additive rather than a
restyle. Verified panning on both the SMS and the voice canvas.
⚠️⚠️ **NO SCROLLBARS — asked for explicitly, and nothing was lost by hiding them.** `.wf-scroll`
is `overflow: hidden` now. The bars had looked like the only thing advertising that the diagram
runs past its frame, which is why the first version kept them; the drag replaces that, and the
wheel was never scrolling in the first place (see above), so they were serving nothing but their
own affordance. ⚠️ **AN `overflow: hidden` BOX IS STILL SCROLLABLE FROM SCRIPT**, which is what
keeps the zoom anchor and Fit to view working unchanged — verified: setting `scrollLeft` reads
back, and a fit still centres to the computed midpoint (158 of 158 on a 720px frame).
⚠️ **THE DOTS TRAVEL WITH THE DIAGRAM.** They moved from `.wf-canvas` to `.wf-scroll`, where the
pan variables live, and its `background-position` reads them — which is what react-flow does with
its own pattern (`patternTransform=translate(-5,-5)` in the capture, the pan modulo the 8px gap).
⚠️ **"Fit to view" CLEARS THE PAN**, and it is the only way back once the diagram has been pushed
clean off the edge — which a free pan deliberately allows.
⚠️ A node dragged under the zoom cluster is occluded by it, as on the real page, which lets those
controls overlay the canvas corner. That is not a hit-testing failure; it cost one wrong diagnosis
while verifying, because `elementFromPoint` returns the button rather than the node there.

**`audit:ai` gained 13 checks**: the grab/grabbing cursors, selection suppressed only while
panning, the node/control exemption, the touch bail, the primary-button test, the guarded capture,
the imperative class, the unbounded pan, the fit scale still owning `.wf-tree`, the translate on
`.wf-fit`, `overflow: hidden`, the dots reading the pan, the zoom anchor subtracting it, and Fit to
view clearing it. ⚠️ **ONE EXISTING CHECK HAD TO BE RE-AIMED AND IT CAUGHT ITSELF:** it pinned the
pan to `scrollLeft`, so it went red the moment the mechanism changed — which is the check doing its
job, but the INVARIANT it asserted was the wrong one, because the video disproved the mechanism
rather than the code drifting from it.
**Verified with real drags at 1200px**: a drag of +221/+120 pushed the diagram right and down with
bare canvas behind it and the dot grid travelling with it (`background-position: 221px 120px`)
while the scroll offsets stayed 0 — something the old scroll-based pan could not do at all. No
scrollbar on either canvas (0px gutter). A real click on a panned node still opened its own drawer,
dragging FROM a node still changed nothing, zooming after a drag held its focal point to 3px, and
Fit to view returned the pan and the dots to 0. **The voice canvas pans too and is otherwise
untouched** — 12 nodes, 8px radius, 2px strokes, no arrowheads, no `.wf-v2`.

##### The node's Action and the drawer's Action are one answer (9/17/2026)
Reported against a node reading Inform whose drawer had Qualify selected: *"the 'Action' in this
example Qualify, it should match the action in the context drawer."* Reproduced exactly before
changing anything — **all eight template nodes agreed, and the two the SE had ADDED (`Test`,
`Test 2`) read Qualify on the card and Inform in the drawer.**

⚠️⚠️ **CAUSE: `smsDrawerFor` HAD TWO SOURCES OF TRUTH FOR ONE FACT.** The template's nodes are
listed in the `SMS_QUALIFY` / `SMS_INFORM` id tables, and any id absent from both fell through to
a fallback that **hardcoded `action: "inform"`** — so an added node's colour came from its own
`actionKind` (the tint, fixed the day before) while its drawer came from a constant. The fallback
now RESOLVES THE NODE FROM THE TREE and takes `node.actionKind`, falling back to the wording of
its own `action` string, so the card and the drawer read the same field and cannot disagree. The
id tables survive only as the fast path for the eight template nodes.
⚠️ **AN ADDED QUALIFY'S ANSWERS ARE ITS OWN CHILDREN**, at `branches.B.leaves.L.paths.P.paths`
derived from the id, so `Add` works there too rather than being a dead control. A **sub** node
gets no segments path at all: it is the last row the diagram draws, so a child would be stored
and never rendered.

⚠️⚠️ **THE STORED-FIELD RULE THIS COST, AND IT IS GENERAL RATHER THAN ABOUT THIS SCREEN: A NEW
FIELD MUST SIT AT A PATH WHOSE PARENTS ALREADY EXIST IN THE STORED OVERRIDE, OR WRITES TO IT ARE
SILENTLY LOST.** `setByPath` refuses a missing INTERMEDIATE key (`if (!(k in cur)) return source`)
and only ever creates the LAST segment, and `applyEdits` operates on the STORED override rather
than the merged base. So `sms.extra.<nodeId>__question` wrote nothing on any demo whose override
already had `sms` but no `sms.extra` — **Apply reported success, the drawer closed, and the text
was gone on reload.** Flattened to `sms.extra__<nodeId>__<field>`, one level under a key that
always exists; `SmsConfig` types it as ``[extra: `extra__${string}`]: string | undefined``. There
is deliberately **no nested `extra` map** to walk into, and `audit:ai` asserts one is not
reintroduced.
⚠️ **AND READING IT MUST TOLERATE AN OVERRIDE SAVED BEFORE THE FIELD EXISTED.** Without the base
spread under the stored config, one click on an added segment threw
`Cannot read properties of undefined` — and because `DashboardBoundary` catches the render, the
error tore down the whole diagram, so **EVERY node stopped opening**, not just that one. The
drawer is handed `{ ...smsBase, ...(tree.sms ?? {}) }`.

**`audit:ai` gained 6 checks** (51 for this feature): every node's drawer describes that node's
own action INCLUDING an added one, an added Qualify's Add writes its own children, its text
writes to a flat key, no nested `extra` map exists, `editGuard` allows the first write, and the
base is spread under the stored config. ⚠️ Each was broken on purpose and seen to fire — and
**one EXISTING check had to be re-aimed rather than loosened**: it asserted a READ-ONLY DRAWER for
an id naming no node, which was the old fallback's behaviour, where the drawer now opens NOTHING
at all. That is the stronger outcome and the one its own failure message already allowed; the
invariant was never "a drawer appears", it is "no node borrows another node's write paths", and
the re-aimed check was verified to still catch a borrowed path.

**Verified in the browser:** all ten nodes now agree, an added node's question and fallback
survive a reload, the page's undo removes them, and the SE's own `Test` / `Test 2` nodes are
intact and reading Qualify on both the card and the drawer.
##### The Action dropdown is real, and its five actions are five different drawers (9/17/2026)
Asked for with five captures attached, one per option: *"These are all the actions, that the user
can select from the drop down. Create these."* They are **Schedule Callback, Qualify, Inform,
Inform & Route, Support & Escalate** — and they are not five labels over one shape.

⚠️⚠️ **PROVENANCE, AND IT IS SPLIT: THE SHAPES ARE MEASURED, THE LIST IS A SCREENSHOT.** All five
captures (`reference/agent-workflow/sms-action-*.html`) saved with the combobox **closed**
(`aria-expanded=false` in every one), so no listbox markup exists anywhere and the option set and
its ORDER come from the screenshot alone. The popup's geometry is that screenshot plus this app's
own already-measured combobox popup (options 32 tall at `6px 16px`, 16/400, paper radius 3, the
MUI shadow). Flagged rather than presented as measured, exactly as the Create Workflow channel
combobox already is. What the captures DO give, verbatim, is each action's drawer:

| action | prompt box | destination | Signal | What To Collect |
|---|---|---|---|---|
| **Schedule Callback** | **none at all** | none | **a FIXED chip, `SMS Scheduled Callback`, no "(optional)"** | yes, seeded **Consumer Name** |
| **Qualify** | "What question…to qualify?" | none | **none** | **none** |
| Inform | "How should the agent inform users?" | none | optional | yes |
| **Inform & Route** | "…inform and route users?" | **"Where should the agent send users?"** | optional | yes |
| Support & Escalate | "…handle escalation requests?" | "Where should the agent escalate unresolved users?" | optional | yes |

⚠️⚠️ **QUALIFY IS THE ONLY ONE WITH NO SIGNAL AND NO WHAT-TO-COLLECT**, which reads as an
omission until you see why: it is the BRANCHING action and the other four are terminal. And
**Schedule Callback's Signal is not a field** — measured as a filled MUI info chip (20px tall,
radius 100px, blue-100 `#11228c` on blue-20 `#b0cdff`, 12/16), because that action always fires
that one signal, so there is nothing to choose. A `Record<ActionKind, string>` for the prompt
would have forced a label to be invented for it, so the type is
`Record<Exclude<ActionKind, "callback">, string>` and `actionCopy` returns `prompt: null`.

⚠️⚠️ **CHANGING THE ACTION RESETS THAT ACTION'S FIELDS, AND THAT IS MEASURED RATHER THAN CHOSEN.**
The same node, same Inform action, showed **eleven** collect fields when its drawer was opened
fresh and **zero** once the combobox had been switched, with the instruction box back to its
placeholder. So `collectOnSwitch` is a SEPARATE question from `COLLECT_FOR`: the latter is what
our template configures per action (it drives the diagram's pills), the former is the product's
default for a just-changed action — empty for four of them, Consumer Name for the callback.
Conflating the two would make a switch to Inform silently inherit the template's zip+name list.
⚠️ **IT DOES NOT RESTORE ON SWITCHING BACK**, which is also measured (Inform was the original
action and still came back empty). Everything lives in the DRAFT, so Cancel is the way back and a
mis-click costs nothing — verified: three switches then Cancel left the node exactly as it was.

⚠️⚠️ **THE TINTS ARE DERIVED FROM THE PALETTE, NOT INVENTED — the capture's own titan variables
close the system.** Every measured ink is its hue's `-100` token: Qualify purple-20 `#d0c1f2` /
purple-100 `#440066`, Inform blue-50 `#2666f9` / blue-100 `#11228c`, Escalate orange-50 `#ff7045`
/ orange-100 `#b33b00`. So Inform & Route is **teal-40 `#33e5c9` / teal-100 `#007e73`** — and
`#33e5c9` is exactly what the Create Workflow capture independently measured for that action, two
signals agreeing — and Schedule Callback is **green-50 `#2cbf58` / green-100 `#0d5400`**, which is
also the green this repo already draws for a scheduling leaf.
⚠️ **NO CAPTURE SHOWS A NODE CARRYING EITHER NEW ACTION**, because the dropdown was never applied
in any of the five. The 8% / 12% / 5px treatment is measured; only the hue is placed by the
palette. Replace if a capture ever shows such a card.
⚠️ `actClass` **lowercases** now, so `informRoute` yields `.wf-act-informroute` rather than a
camelCase selector nobody would grep for. A no-op for the three kinds that predate it.

#### Three things that would each have shipped a silent defect
⚠️⚠️ **1. THE ID TABLES SHADOWED THE NODE, AND IT WAS THIS MORNING'S BUG THROUGH A NEW DOOR.**
Caught in the browser on the first working Apply: `sub-0-0-0-0` is listed in `SMS_INFORM`, whose
fast path hardcoded `action: "inform"` — so a node switched to Schedule Callback **drew correctly
and reopened as Inform**. The tables now stand down when the node no longer carries the action
they were written for (`kindOfNode` outranks every one of them), and such a node falls through to
the generic branch, where its text lives in the flat `extra__` keys. That is right rather than a
compromise: `sms.inform.serviceableYes` is the wrong slot for an action with no instruction text
at all. **Four audit checks catch this regression.**
⚠️⚠️ **2. A LOCKED NODE MUST GET NO PICKER, AND THE GUARD COULD NOT HAVE STOPPED IT.**
`editGuard.LOCKED_KEYS` matches a path ending in `.action`, but the action writes the containing
ARRAY — so a locked leaf's action would have sailed straight past it. `actionSlotFor` refuses a
node with `locked: true`, so there is no slot, no picker and no write, and the two chrome leaves
keep the read-only combobox they were signed off with. Verified: "All Sales Inquiry Users" and
"All Support Users" show a static combobox, a configurable node shows the picker. **Do not add
another writer for a node's action without repeating that test.**
⚠️⚠️ **3. THE WRITE REUSES THE ONE SHAPE ALREADY PROVEN HERE.** `edits.segments` has written
`…paths` as a whole array of NODES since this drawer shipped, so the action change writes the
containing array with the node spread and replaced. A per-field path like `…paths.2.action` sits
one level deeper than anything the stored override is known to contain, and `setByPath` refuses a
missing intermediate key **silently** — this morning's `sms.extra.*` bug wearing a different hat.
Spreading also keeps the node's title, its lock and its own children by construction.
⚠️ **A BLANK ANSWER IS NO LONGER WRITTEN AS A NODE.** Switching to Qualify shows two empty answer
rows, as the capture does; without filtering them at Apply, browsing the dropdown would leave
empty boxes on the diagram. It also fixes the pre-existing case of `Add` then Apply with nothing
typed.
⚠️ **CONSEQUENCE, STATED AND NOT MEASURED: switching a Qualify away from Qualify keeps its
children.** The product very likely drops them, but no capture shows it, and silently destroying a
configured subtree because somebody browsed a dropdown is the worse failure — the same stance
"delete a tile HIDES it" already takes. The diagram will draw those children under a terminal
action until this is settled by a capture.

**`audit:ai` gained 22 checks** (73 for this feature): the five options and their order, each
label, each new Description verbatim, Inform & Route's SMS prompt, callback having no prompt and
no destination, its fixed chip and its seeded collect, the other four seeding none, the two
destination wordings being distinct while plain Inform has none, a node's action text being the
same VALUE as its drawer label for all five, a switched template node opening its own drawer, the
wording fallback not swallowing "Inform & Route" into inform, a locked node getting no slot, a
configurable node's slot resolving to its own position, the write going through the array, the
picker being gated on having somewhere to write, the voice tables staying keyed on the three voice
kinds, both tints being scoped titan values, the lowercased class, and all five captures being in
the repo. ⚠️ Five were broken on purpose and each fired — restoring the table shadowing (4 red),
un-gating the lock, reordering the list, emptying the callback collect, and merging the two
destination strings.

##### The VOICE workflow's drawers get the same treatment (9/21/2026)
Reported: *"i dont see the updated stuff in the voice workflow — 1. updated context drawer 2. have
the ability of add 3. action drop down"*, with one constraint: *"the one thing i dont want you to
change is the actual tree that has been created."*

⚠️ **THEY WERE READ-ONLY BECAUSE NOBODY HAD ASKED, NOT BECAUSE THEY COULD NOT WRITE.** The voice
page has registered its `agent` half beside the tree since 8/27 — that is how Ask AI configures
that agent — so the write targets already existed and only the drawers' `edits` paths were
missing. `onApply` was passed for `smsTemplated` alone; it now also covers the built-in voice
workflow, and still NOT an authored extra or a created one, neither of which has a config slot
for a node the template never made.

⚠️⚠️ **EVERY EDITABLE FIELD WRITES TO A HOME THE AGENT ACTUALLY READS.** That is the whole
difference between this and a drawer full of controls that change nothing spoken:
| field | home | reaches the call via |
|---|---|---|
| the Qualify question / reprompt | `agent.qualifyQuestion` / `agent.qualifyFallback` | `specWithConfig` |
| a Qualify's answers (and `Add`) | the tree's own `paths` | `treeToVoicePaths` |
| a use case's instruction | `agent.informSteps` | the CALL FLOW's steps block |
| What To Collect | **the node's own `chips`** | `treeToVoicePaths` |
| the escalation instruction | `agent.escalateHandling` (new) | the support line, both flows |

⚠️⚠️ **THE ROUTING STEPS ARE ONE SHARED FLOW, NOT PER-NODE TEXT.** Every use case renders
`spec.informSteps`, because there is one call flow and each use case follows it. So the edit goes
to that one home — **consequence, stated: editing the instruction on one use case changes it on
all of them.** A per-node copy would look perfect in the drawer and change nothing the agent says.

⚠️⚠️ **THE ESCALATION INSTRUCTION WAS A LITERAL INSIDE `workflowDrawers.ts`**, so the drawer had
been showing an instruction the PROMPT never carried — the drawer-describes-what-the-agent-does-
not shape this file already records three times. It now has a home defaulting to the same wording
(`DEFAULT_ESCALATE_HANDLING`, one definition shared by the drawer and the prompt), so an untouched
agent is byte-identical.
⚠️ **AND THE FIRST ATTEMPT PUT IT ONLY IN THE HARDCODED FALLBACK FLOW — which is emitted exactly
when a prospect has NO use cases, i.e. for none of them.** The field would have been a dead
control on every real workflow. Caught by reading the built prompt, not the diff; it now renders
in the paths-driven flow too, and `audit:ai` counts both sites.

#### Then: the last row's drawers described a different node (9/21/2026)
Reported straight after, against a use case: *"all the context drawer in the last layer, all the
fields are empty, it should match what is happening in the last layer."* Three things were wrong,
and the first is the one that matters:
1. ⚠️⚠️ **WHAT TO COLLECT WAS A GENERIC TABLE ON EVERY USE CASE.** The node drew "Consumer Name,
   Service Address, Timeline" while its drawer listed `COLLECT_FOR.inform` — Consumer Zip,
   Consumer Name. Two descriptions of one node, which is the pills failure this file records
   already. `nodeCollect` reads the node's own chips, so the diagram, the drawer and the prompt
   are one value; two different use cases now show two different lists.
2. **THE INSTRUCTION BOX WAS BLANK, AND THAT IS USUAL RATHER THAN BROKEN.** `informSteps` is only
   the service-area gate, so a prospect that serves everywhere has none — **measured: 10 of the 15
   profiles on disk.** A bare empty box reads as a defect, so it carries a placeholder naming what
   belongs in it, exactly as every SMS drawer does.
3. **THE NODE'S DESTINATION IS STILL NOT SHOWN.** The card reads "Route to Service Appointment,
   New Customer" and the drawer has no destination row. The measured voice drawer has a phone row
   and no destination row, and **no voice drawer capture survives in `reference/`**, so adding one
   would be inventing a control. Flagged rather than built.
⚠️ Also open: "All Support Users" draws no chips while its drawer shows Consumer Name (the
fallback for a node carrying none, and the prompt does collect a name there) — so the chip is
arguably missing from the NODE. Left alone; it is the row above the one reported.

⚠️⚠️ **THE TREE ITSELF IS UNTOUCHED, WHICH WAS THE CONSTRAINT.** Measured before and after: 12
nodes, 15 chips, **zero** `.wf-v2`, **zero** arrowheads, 8px radius, its own green, 2px strokes,
minimap present. Every edit was in the drawer builder, never the renderer, and two checks pin it —
the SMS action tints stay scoped to `.wf-v2`, and `marker-end` stays opt-in (an ATTRIBUTE, so no
stylesheet scope could keep arrowheads off another diagram).

⚠️ **ONE FIELD IS STORED CORRECTLY AND IS CURRENTLY SILENT, AND IT IS A PRODUCT DECISION, NOT A
BUG TO PAPER OVER.** `voiceQualify` is suppressed whenever the greeting already contains a "?",
by the rule that stops the agent asking twice — and **every profile sampled has a greeting that
asks**. So editing the Qualify question saves and changes nothing audible until the greeting stops
asking. Pre-existing (Ask AI has had the same caveat since 8/27), but making the field editable
turns a stale display into an edit that appears to do nothing. Raised with the user rather than
guessed at; relaxing the suppression risks the double question the rule exists to prevent.

**`audit:ai` gained 12 checks**: the voice drawers can Apply at all, both chrome leaves offer the
picker, Add writes the tree's child nodes, the escalation has a home and reaches BOTH flows, one
definition of its default, a use case's instruction writes the shared list AS a list, a use case's
collect is its own node's chips, two use cases differ, the unset box names itself, the SMS tints
stay scoped, and arrowheads stay opt-in.
⚠️ Three were broken on purpose and each fired. ⚠️ **ONE EXISTING CHECK WAS RE-AIMED, NOT
DELETED** — it asserted a voice drawer carries NO write paths, which was the old scope; it now
asserts every write path goes somewhere the agent reads, which is the invariant that survives.
⚠️ **AND TWO NEW CHECKS FAILED ON CORRECT CODE FIRST**, both fixture faults: one matched
`lineFor(` where the declaration is `lineFor = (`, and one built its tree from `smsBranches`,
whose path nodes carry no chips — so the per-node collect check compared against an empty list.
`audit-voice.ts` already carries `auditTreePaths` for exactly this reason; use a real voice tree.

##### The config is bi-directional: the workflow IS the agent's config (9/17/2026)
Asked for directly: *"can we make the config bi directional, so if there are changes in the
workflow, it also changes it in actual preview agent or preview workflow, and vice versa, if i use
ask AI to make changes, it should make those changes in the workflow."*

⚠️⚠️ **MEASURED FIRST, AND THE GAP WAS TOTAL: THE BUILT-IN SMS WORKFLOW REACHED THE AGENT
NOWHERE.** `buildSmsBrain` read `agentConfig`, an extra workflow's own prompt and (for an extra
workflow) its `wfAgent` half — so every field of the six-row template was invisible to the phone:
three qualify questions, four inform instructions, the escalation text, both intents' looks-like
and rules, every node's collect chips, the destination and the signal. An SE could configure the
entire diagram and both previews would ignore all of it.
⚠️ **THE VOICE PAGE ALREADY WORKED THIS WAY**, which is the pattern mirrored rather than invented:
its call reads the WORKFLOW page's scope and merges `effTree.agent` into the spec. The mechanism
for reading another page's scope was also already here — the Preview Agent has read an EXTRA
workflow's scope since 9/8. The built-in one simply was not being read.

⚠️⚠️ **NOT A SYNC BETWEEN TWO COPIES — ONE HOME PER FIELD, READ BY BOTH SURFACES.** Asked whether
the overlap should be resolved by precedence, the answer was *"whatever was edited most recently"*.
With one home that is automatic and needs no timestamps: the last write to the single value is what
the agent uses, and neither surface can discard the other's edit. Two stores kept in step would be
the duplicated-field trap behind all three of the 8/27 voice bugs. The store carries no timestamps
at all, so the alternative would have meant persisting them into the demo record for a conflict
that, with one home, cannot arise.

**What has which home, measured rather than assumed:**
| | home | overlap |
|---|---|---|
| the three qualify questions, four inform instructions, escalation text, both intents, each node's collect list, destination, signal | the **workflow** (`sms.*` + the tree) | — |
| greeting, brand rules, goal, booking type, offer, Q&A, knowledge | the **agent** (`agentConfig`) | — |
| the qualification script (`smsPlaybook.qualifyingQuestions`) | the agent | **complementary, not duplicate** — the tree's questions ROUTE, the script QUALIFIES |

⚠️⚠️ **IT IS DERIVED THROUGH `smsDrawerFor`, NOT BY A SECOND WALK OF THE CONFIG.** That function
already knows where every node's text lives — the template's tables for the eight it configures,
the flat `extra__` keys for anything switched or added — so the agent is told, by construction,
exactly what an SE reads in the drawer. A second derivation is how the two come to disagree.

⚠️⚠️ **THE WORKFLOW ENRICHES THE SALES FLOW; IT DOES NOT REPLACE IT, AND THE WORDING HAS TO SAY
SO.** The generated SMS prompt is a SALES arc (open, qualify, estimate, schedule, confirm); the
workflow is a ROUTING flow. Declaring "THIS SECTION WINS" beside it, the way `overrideBlock` does
for a hand-written playbook, gives one conversation two competing flows — the self-contradicting
prompt this file already records twice. And replacing the sales arc outright would turn EVERY
prospect's SMS demo into a routing conversation, losing the qualify-quote-book beat that is the
point of the channel. The block says outright that it does not replace the flow above and that a
question appearing in both is asked once. `audit:ai` fails if it starts claiming precedence.

⚠️⚠️ **AND NOTHING IS ASKED TWICE — the same bug this file already records for voice** ("the voice
agent was re-asking ZIP and name": the service-area check and the path's collect list were two
blocks nobody reconciled). The workflow's nodes collect a zip and a name, so feeding the script in
untouched reproduces it on SMS. `dedupeQuestions` drops a scripted question only when the workflow
demonstrably gathers that same datum — measured on Aptive, 5 questions to 4, the ZIP one dropped
and the four genuinely distinct ones (pests, size, interior/exterior, timeline) kept. Conservative
and structural, never semantic, exactly like `dedupeCollect`.

#### The reverse direction: Ask AI on the Preview Agent edits the workflow
`Scope.linkKey` / `linkAs` name another scope a page's Ask AI may also edit. The model is shown
that scope's data under the prefix, and `routeEdits` strips the prefix and applies those edits to
**that** scope — so an instruction typed into the Preview Agent moves the DIAGRAM instead of
storing a second copy of a question beside it.
⚠️ **THE TEXT FIELDS ONLY, WHICH IS NARROWER THAN THE "reword + add answers" THAT WAS ASKED FOR,
AND DELIBERATELY SO.** `sms` carries every question, fallback, instruction and intent, so "ask
about termites first" reaches the node an SE would have typed it into. `branches` is NOT exposed:
a second page with structural control can change the tree's DEPTH, and the six-row geometry has no
row to draw a seventh in, so those nodes would be stored and never rendered — the silent no-op
this file keeps recording. Restructuring stays on the workflow page, where the diagram is on
screen while you do it. **Say so rather than implying the wider version shipped.**

#### Three defects found while building it, two by reading and one in the browser
⚠️⚠️ **1. `registerScope` DROPPED THE LINK SILENTLY.** Its body builds the active scope object
field by field, so a new field has to appear TWICE — in the equality test and in the object — and
omitting the second half type-checks perfectly while the drawer receives `undefined` forever.
Caught by reading that function rather than by the compiler. The check pins both halves.
⚠️⚠️ **2. THE 12,000-CHARACTER CONTEXT CAP ATE THE WORKFLOW, AND A SLICED JSON IS MALFORMED
JSON.** Caught in the browser on the first real Ask AI request: the payload came out at exactly
**12,012** characters — the cap plus its marker — so the `workflow` half, appended last, was cut
off entirely and the model was handed an unterminated object. It could not have edited what it
could not see, and the failure looks like the feature not working. Raised to 40k (Aptive's agent
config alone is ~12KB of prose, so pages were already being clipped before anything was folded
in), and it now degrades by **dropping the linked half first**, so what remains is always valid
JSON about the page's own data.
⚠️ **3. A CHECK THAT COULD NOT FAIL.** The router's first check grepped for "does a router
exist" and passed against a router edited to route nothing. `routeEdits` was extracted as a pure
function so the audit calls it with real batches — including `workflowNotes`, which must NOT be
stolen by a `workflow` prefix.

**`audit:ai` gained 24 checks** (115 for this feature): the flow derives and carries each node's
question, action, instruction and collect list three rows down; both intents' copy reaches it;
editing a node moves what the agent is told; it reaches the brain and the prompt; an EXTRA workflow
gets none of it; a brain with no workflow builds the old prompt byte for byte; the block does not
claim precedence; the dedupe drops a covered question and keeps every distinct one; one definition
of the scope key read by both previews; an empty workflow still gets no flow; `registerScope`
carries the link in both places; `routeEdits` strips and routes, respects a page with no link, and
needs the dot; and the context cap fits the workflow and degrades by dropping it.
⚠️ Six were broken on purpose; four fired immediately and **two were presence-greps that did not**
— both were rewritten, one into the real-function test above. ⚠️ One EXISTING check had to be
re-aimed: it pinned `buildSmsBrain(profile, ac, wf, wfAgent)` exactly and went red the moment a
fifth argument arrived. The arity was never the invariant.

**Verified in the browser, by reading the `/api/chat` REQUEST BODY rather than trusting a drawer**
— the test this file insists on. Editing "All Sales Inquiry Users" to *"Before anything else: are
you dealing with termites?"* through the real drawer put that string in `brain.workflow` on BOTH
previews: Preview Workflow on the same page, and the Preview Agent tab reading it across the page
boundary. Then the reverse: Ask AI on the Preview Agent, asked to change the first qualifying
question, wrote **`sms.qualify.root.question` into the WORKFLOW's scope** with **no copy in the
preview's own scope**, and the diagram's drawer opened showing the new question. The page's undo
took every step back and left no override behind.

##### Every field in an action drawer is editable, and the dropdown is on all of them (9/17/2026)
Asked for with **both LOCKED chrome drawers selected**: *"you need to add the drop and the screen
to any action context drawer, any time its a action drawer with that drop it should have those
screen and options, and make sure all those fields in the drawer is edititable as well."*

⚠️⚠️ **THIS DELIBERATELY RELAXES THE LOCK, AND ONLY FOR THE ACTION.** The build an hour earlier
refused a `locked` node a picker, on the strength of the standing rule that the four chrome boxes
cannot be edited. That rule is about their **NAMES** — which is what was actually reported in
August, against the box titles — and `editGuard` still refuses `.title` and `.subtitle` on them.
Their ACTION is configuration, and on this instruction it is the SE's to change. **Consequence,
stated: `editGuard.LOCKED_KEYS` covers `.action` and cannot see this write**, because it matches a
path ending in `.action` while the write is the containing ARRAY — so that half of the lock now
lives in `actionSlotFor` rather than in the guard. The audit check written an hour before this was
**re-aimed rather than deleted**: it now asserts the picker IS offered on a locked leaf and that
the leaf's name is still refused, so both halves stay watched.

⚠️⚠️ **THE DESTINATION IS A TEXT INPUT, AND WE HAD INVENTED A COMBOBOX FOR IT.** The table above
said "an empty combobox" and we rendered `Select a destination...`. The markup says otherwise in
**both** the original capture and all five Action ones: `<input name=destination type=text>`,
disabled in the configured captures and enabled in the switched ones, carrying
`e.g. https://yourwebsite.com/support or +1-800-555-0100` (and `…/signup…` for Inform & Route).
A URL or a phone number is what you type rather than pick, which is also what makes sense of the
placeholder. Corrected, with the placeholders measured per action.

**The other two were real autocompletes whose option lists are not in any capture** — both saved
closed (`signal-select`, `addInfoField-select`) — so they come from the PROSPECT, the way
everything else on this page is derived:
| field | options |
|---|---|
| Signal | that prospect's **own signals**, off the Signal Manager list (Aptive: 10). A prospect with no `signalManager` slice offers **none** rather than an invented set, and the list says "Nothing to choose from" rather than rendering an empty box |
| Add Info Field | the SMS **collect pool**, plus `Consumer Name` — which is not in the pool (that splits first and last) but IS what the Schedule Callback capture shows seeded, with its own help text |

⚠️⚠️ **THE COLLECT LIST *IS* THE NODE'S `chips`, AND THE FIRST BUILD GOT THIS WRONG IN THE WAY
THIS FILE ALREADY WARNS ABOUT.** Stored under its own `extra__…__collect` key it worked in the
drawer and **the diagram's pills did not move** — two sources for one fact, exactly "a node
advertising collecting one thing while its drawer's What To Collect said another". `chips` is
already what the diagram draws and already exempt from the array-length rule, so it is now what
the drawer reads and writes too, through the same `actionSlot` array write the action uses. One
value, one place; the `editGuard` pattern added for the retired key was **reverted rather than
left as a dead rule**, and the audit fails if either comes back.
⚠️ **EACH CHIP'S × IS A REAL BUTTON NOW.** It was drawn from the start and did nothing — the
dead-control shape this repo keeps paying for. An already-added field is also not offered again,
since the same field twice on one node is not a state the product can mean.

⚠️ **ONE `Combo` COMPONENT SERVES ALL THREE PICKERS**, because all three are the same MUI
autocomplete in the capture and three copies would drift on the first fix. One `openCombo` id
rather than three booleans, so opening one list closes the others — and **all three close on
pick**, which the signal one did not until a browser test caught it leaving its list open.
⚠️ Switching the action resets the destination, the signal AND the collect list with the rest,
since all three are that action's configuration.

**`audit:ai` gained 18 checks** (91 for this feature): both destination placeholders, the invented
combobox being gone, each of the three having somewhere to write on a flat key whose parent
exists, the signal options being the prospect's own and empty for a prospect with none, the
collect list writing the node's chips, no dead guard pattern, a template node keeping its
configured fields and help text, the × being real, no duplicate offer, `Consumer Name` being
offered, one `Combo`, every picker closing on pick, and one open-picker id.
⚠️ Five were broken on purpose and each fired: storing collect apart from the pills, inventing
signal options, making the × decorative, allowing a duplicate, and nesting the destination path.
⚠️⚠️ **AND ONE NEW CHECK FAILED ON CORRECT CODE — the fourteenth probe fault here.** It forbade
`Select a destination...` and reddened on **its own comment** recording the correction. `readCode`
now strips comments before matching, the same fix `audit:place` and the vendor scan already carry.

**Verified in the browser with real interaction**: both of the selected locked drawers now show
the picker with **zero inert comboboxes** — "All Sales Inquiry Users" with all five inputs
editable, "All Support Users" with three pickers and a real destination input carrying its
measured placeholder. On the support leaf: the signal list offered Aptive's own 10, the info list
offered 9 then **8** (the added one filtered out), the destination took typed text, Apply moved
the **node's pills** to match, and all of it **survived a reload**; the × removed a field and
Apply took the pills with it; the page's undo walked every step back to the template with **no
leftover keys**. The template's own Inform drawer still renders its 8 configured fields with their
help lines and its configured instruction text, with the node's pills still capped at 4 + `...`.
**Untouched and checked: the voice drawers** — 0 pickers, every combobox static, every input
read-only, no chip ×.

**Verified in the browser with real clicks**, at 1446px on Aptive: the list opens with all five in
order at 32px/`6px 16px`/16px with Inform marked selected, a second click on the trigger CLOSES it
(the capture-phase handler doing its job), picking Schedule Callback rerenders the drawer to its
measured shape (zero textareas, `Signal` with no "(optional)", the chip at 20px/100px in
`#b0cdff`/`#11228c`, Consumer Name prefilled), and Apply turned "Serviceable=true" green
(`5px solid rgb(44,191,88)`, 8% ground, `rgb(13,84,0)` ink) with its chips reset to Consumer Name.
It **survived a reload and reopened as Schedule Callback**, the page's undo restored it to Inform
with all four chips and the `...` cap, and Cancel discarded three switches. The other three shapes
each render their own measured fields. **Untouched and checked: the voice tree** — 12 nodes, no
`.wf-v2`, no arrowheads, **no picker on any drawer**, and its voice-only phone row still reading
"What phone number should unresolved callers be transferred to?".

### ⚠️ THE SMS WORKFLOW'S FOUR NODE NAMES ARE FIXED, AND LOCKED (8/24/2026)
The real Invoca page does not let a user rename them, so the template must not either. They
are always **"Triggered by"**, **"Conversation Start"**, **"Sales Inquiry"** and
**"Need Support"** for every prospect, plus the support leaf **"All Support Users"**.
❌ **THE TRIGGER LINE THIS SECTION PINNED IS SUPERSEDED (9/17/2026).** It read "0 Campaigns, 0
Forms, and 0 Inbound SMS", which is right for a workflow nobody has wired and is still what
`ZERO_TRIGGER` gives a CREATED one. The built-in template now carries the captured line for a LIVE
SMS workflow — **"0 Campaigns, 2 Forms, and 1 Inbound SMS"** (`SMS_TRIGGER`). See the section
above. The four NODE NAMES are unchanged and still locked.

⚠️ **TWO OF THE FOUR WERE NEVER AT RISK** — "Triggered by" and "Conversation Start" are
literals in `WorkflowTree.tsx`. The INTENT names were being derived from each prospect's own
routing queues (`voiceCopy`), which is why Shady Blinds showed "Design Consultation" /
"Existing Order" and AutoNation "Test Drive" / "Service Appointment" where the product always
shows the same two words.
⚠️ **THE TRIGGER LINE WAS THE VOICE WORDING.** Ours read "0 campaigns and 0 forms" — it never
mentioned SMS, on a screen whose entire subject is SMS.

⚠️ **LOCKED MEANS THE AI IS REFUSED, NOT IGNORED.** `TreeBranch.locked` marks a node as
product chrome and `editGuard.isLockedEdit` blocks a write to its `title`/`subtitle`, counted
with the structural blocks so the drawer reports a REFUSAL. The tempting alternative — fix the
names in the renderer and ignore `branch.title` — is a **silent no-op**: the model accepts
"rename this node", writes the edit, and nothing moves. That exact failure is already recorded
three times in this file (the greeting, the `cells` guard, the workflow tile). The flag lives
on the NODE rather than in a path pattern, so the rule travels with the data.
⚠️ **THE LEAF TITLES AND ACTIONS STAY EDITABLE**, since those are configured queue actions
rather than chrome. Verified: `branches.N.title` is refused on both intents while
`branches.0.leaves.0.title`, `...action` and `triggeredBy` are all still allowed.

⚠️ **IT APPLIES TO EVERY PROSPECT, INCLUDING ONES GENERATED LATER, BY CONSTRUCTION.** The
tree is derived at RENDER time from constants — no schema slice, no engine phase, nothing in
`engine/` writes these names (checked). So a prospect generated next month gets them without
regenerating anything. `npm run audit:ai` now enforces it with **7 checks**: the two renderer
literals, the intents coming from the constants, no intent title derived from `c.newQ`/`c.supQ`
again, the `locked` flag present, the trigger line's wording, and `isLockedEdit` being both
defined AND called. Verified each fires on its own broken shape.
❌ **SUPERSEDED 9/2/2026 — this said extra workflows were an exception, and that was wrong.**
It read: "One narrow exception, and it is correct: EXTRA agent workflows keep their own authored
branch names, because they are different workflows with different intents, a nurture flow's node
is not 'Sales Inquiry'." Reported directly against a new Avi & Co workflow: the four chrome
boxes are locked on EVERY SMS workflow, and an authored one contributes the USE CASES on the row
beneath them, exactly as the voice tree does. What a nurture or speed-to-lead flow brings is its
use cases, not its own intent nodes. See "A second SMS workflow for Avi & Co" below.

⚠️ **SCOPED TO THE SMS TEMPLATE.** The VOICE tree's intents still derive from the prospect's
real queues and keep their caller-intent subtitles, because those were measured off Invoca's
own Voice workflow page — re-verified after this change (AutoNation still reads "Test Drive" /
"Service Appointment" with "2 campaigns and 0 forms"). Lock those only against evidence from
that screen.

⚠️ **THIS SHRANK THE COMFORT KEEPERS OVERRIDE.** Three of the five things that made its tree
different were the PRODUCT's, not the prospect's, so they moved into the template and every
prospect gets them. Keeping the whole tree in the override would have frozen a copy that stops
tracking the template — the same drift the SMS-brain note warns about.

### "No voice agent joined this call" — cold start, not a dead worker (9/3/2026)
Asked directly, on the live site: why does this show up sometimes, and is there a way to keep
the agent worker always running?

**Diagnosed live, not guessed.** `lk agent status` showed the hosted `invoca-voice` worker
(`CA_y7Ctc5ZfZ4G6`) genuinely `Running` with a real replica up. `lk agent logs` at the same
moment showed it had just gone through `"starting worker" -> "registered worker"` seconds
before serving a real call correctly (greeting spoken, session closed cleanly on hangup) — a
**cold start**, not a crashed or missing deployment.

⚠️⚠️ **LIVEKIT CLOUD'S OWN DOCS EXPLAIN THE "SOMETIMES" EXACTLY.** On the Build (free) plan, a
deployed agent "might have their deployed agents shut down after all active sessions end. The
agent automatically starts again when a new session begins. This can cause **up to 10 to 20
seconds of delay** before the agent joins the room." Our client-side watchdog
(`AGENT_JOIN_TIMEOUT_MS`) was **10 seconds** — sitting at the very bottom of LiveKit's own
documented cold-start window, so the first call after any idle stretch was close to a coin
flip. Whenever nobody had called recently, the worker scaled to zero; the next Start Call woke
it back up, and depending on exactly how long that boot took, the SE saw either a working call
or this message. `lk agent status`'s "Running" only proves the worker is up **right now** — it
says nothing about whether it was up 15 seconds ago when the call actually started.

⚠️ **THE ERROR MESSAGE ITSELF WAS WRONG FOR ANYONE SEEING IT ON THE LIVE SITE.** It read "start
it with `npm run dev` in the agent folder" — advice from before a hosted worker existed
(`agent/DEPLOY.md`: "until a HOSTED worker exists, the only worker registered is whatever is
running on a laptop"). A hosted worker exists now, and an SE hitting this in production has no
repo, no terminal, and nothing to `npm run dev` — the message named an action the reader
literally cannot take. Rewritten to describe the real, likely cause and the real fix ("try
again in a few seconds").

**Two things fixed here, in this repo:**
- `AGENT_JOIN_TIMEOUT_MS` raised **10s -> 18s**, covering LiveKit's documented worst case with
  margin while still failing well inside a demo's patience if the worker is genuinely down.
- The error text rewritten to name the cold-start explanation and the actual recovery step
  (retry), instead of local-dev instructions nobody on the live site can follow.
- `agent/DEPLOY.md`'s own troubleshooting section updated to match — including the tell for
  telling a cold start apart from a real outage: **retry immediately** (past any cold-start
  window) — if it fails a SECOND time right away, that's when to suspect the worker is not
  registered under `invoca-voice` at all.

⚠️⚠️ **THE PERMANENT FIX — "always have the agent worker running" — IS A LIVEKIT CLOUD PLAN
DECISION, NOT SOMETHING THIS REPO OR ITS CLI CAN SET.** LiveKit's CLI (`lk agent update` /
`lk agent deploy` / `lk agent config`) exposes secrets and image deployment, but **no flag or
`livekit.toml` key for a minimum warm-replica count** — confirmed by fetching the agent's own
config fresh (`lk agent config`) and reading LiveKit's current deployment-management and
quotas docs directly rather than trusting a possibly-stale memory of their API. The
scale-to-zero behavior is explicitly tied to the **Build (free) plan**; the docs imply paid
tiers behave differently but do not spell out the mechanism. **Check the project's plan on the
LiveKit Cloud dashboard billing page** — this is a real cost decision (a warm, non-scaling
replica bills for idle time) and is the user's to make, not something to change unasked.

Verified: `audit:voice` (62 checks) and `audit:ai` both green, `tsc` clean, no regression to
the worker/token contract (`AGENT_NAME` match, job-metadata shape) — this fix is entirely
client-side timeout and copy, and `agent/voiceAgent.js` was not touched.

#### Then: it is a WARMING-UP NOTICE with a live countdown, not an error (9/3/2026)
Asked for straight after the fix above: *"instead of the error message you give, let's do a
message that lets the user know the voice agent is warming up and when to refresh and try
again."*

⚠️⚠️ **A COLD START IS EXPECTED BEHAVIOUR, SO IT MUST NOT BE PAINTED AS A FAILURE.** The
previous pass fixed the WORDS and left it in `error`, which renders in `.vc-callerror`'s
orange — so an SE mid-demo read "something broke" when the honest answer is "it is coming".
`LiveKitVoice` gained a **`notice`** channel beside `error` (its own `noticeSink`, its own
`.vc-callnotice` in calm blue, rendered ABOVE the error), and the 18s mark now raises the
notice instead of the error.

⚠️⚠️ **AND IT HOLDS THE ROOM OPEN FOR 12 MORE SECONDS RATHER THAN GIVING UP AT 18.** LiveKit
documents a 10-to-20-second wake-up, so the agent very often lands a few seconds AFTER our
watchdog fires — telling the SE to retry at 18s throws away a call that was about to work.
`AGENT_GRACE_MS = 12_000` counts down live ("…hold on 9s"), `ParticipantConnected` ->
`clearAgentWatch()` wipes the notice the instant the agent arrives and the call just proceeds,
and only if the whole 30s is spent does it swap to a definitive retry line — which is now
genuinely worth following, because whatever woke during the wait is warm.
⚠️ **THE COUNTDOWN IS LIVE FOR A REASON**: a static "in a few seconds" is the thing somebody
reads at second 2 and again at second 9 with no idea whether to keep waiting. It runs 12 -> 1
and never prints "0s" (at 12,000ms elapsed `left` is 0 and the branch hands off).

⚠️ **THE INTERVAL IS ARMED BEFORE THE FIRST `tick()`, NOT AFTER — a real leak, fixed.** `tick`
can finish on its very first run, and both of its exits clear `agentGrace`; assigning the
interval on the NEXT line therefore stranded a timer nothing owned, ticking every second past
the end of the call. Teardown is otherwise safe: `hangUp` -> `destroyLive` (immediately, or
after the 250ms reuse grace) -> `clearAgentWatch()`, which clears the timeout AND the interval
and wipes the notice while both sinks are still bound.

⚠️⚠️ **THE COLD-START PATH CANNOT BE EXERCISED IN THE BROWSER PANE, and it is worth knowing
why before someone concludes the feature is broken.** The pane has no microphone, so
`setMicrophoneEnabled(true)` throws **"Permission denied"** on the line BEFORE the watchdog is
armed — the notice can never appear there. What WAS measured is the presentation, injected as
the real element's sibling inside the live call UI: notice `#0250d9` on `#eef3fe` with a
`#cfe0fd` border against the error's `#b33b00` on `#fff4ef`, identical box (452 wide, 4px
radius, `8px 12px`, 13px), and the notice rendering above the error. The countdown arithmetic
and the teardown are verified by reading, not by a live cold start.

Verified: `tsc` clean on BOTH projects, `audit:voice` (62) and `audit:ai` green, zero stray
backspace bytes in every edited file (`od`-safe grep, per the `\b` heredoc trap above).

### The workflow's DETAILS tab, and an agent voice that actually changes (9/3/2026)
Asked for directly: *"lets make the Details page clickable and allow users to change the voice
of the voice agent, give users access to all the different voice available in livekit."* Then,
on how it should behave: *"User clicks the details button, selects or changes a voice and it
automatically changes the voice without the user having to do anything else."*

`src/screens/AgentWorkflowDetails.tsx` + `.wfd-*` + `src/data/voiceOptions.ts`. The two tabs
were `<button className="wf-tab active">Definition</button>` and an inert sibling; they are
stateful now, and Details renders instead of the toolbar + canvas.

⚠️⚠️ **"ALL THE VOICES AVAILABLE IN LIVEKIT" IS NOT AN ENUMERABLE SET, and that shaped the
whole feature.** LiveKit Inference brokers **seven** TTS providers (Cartesia, Deepgram,
ElevenLabs, Rime, Inworld, xAI, Fish Audio — read off `@livekit/agents@1.7.0`'s own
`inference/tts.d.ts`, which is authoritative for our version and lists two the docs page does
not), and it publishes **no endpoint and no CLI that lists their voices** — LiveKit's docs say
each catalogue lives in that provider's own documentation, and ElevenLabs ids are per-account
UUIDs. So any list is a hand-maintained snapshot. Offered the choice, the user picked **six**:
Thalia, Andromeda, Arcas, Harmonia, Neptune, Athena — all Aura-2, all American English, all
voices Deepgram itself describes for customer service or IVR. **Every id is copied from
Deepgram's published table, not typed from memory.**

⚠️ **TWO ID FORMATS, BOTH REAL, BOTH DERIVED FROM ONE ENTRY.** Deepgram's REST API (the play
button) wants `aura-2-thalia-en`; LiveKit wants provider/model plus a voice, which its SDK also
accepts as the composite `deepgram/aura-2:thalia`. One `VoiceOption` produces both, so the
voice an SE previews **is** the voice the call uses. `audit:voice` asserts the two agree.

**The chain, and every link was verified separately** because each is a place this repo has
already been bitten:

| link | how it was proved |
|---|---|
| picker -> stored config | real `form_input`, then read the override store: `agent.voice: "arcas"` under `shady-blinds::/agent-studio/agent/workflow/voice`, undo depth 1 |
| stored config -> preview audio | `/api/tts` returned **8208 bytes for Arcas and 8064 for Athena**, different SHA per voice — so the model is genuinely applied, not ignored |
| stored config -> token | decoded the minted JWT: `roomConfig.agents[0].metadata.voice === "deepgram/aura-2:arcas"` |
| token -> worker's TTS | ran `inference.TTS.fromModelString()` against the installed SDK: `opts.voice === "thalia"` / `"arcas"`, and `undefined` for a bare model |
| worker -> audible on a call | ⚠️ **NOT VERIFIED — needs `lk agent deploy`.** See below |

⚠️⚠️ **THE 7776-BYTE COINCIDENCE IS WHY THE HASH CHECK EXISTS.** Two different voices first
came back with byte-identical LENGTHS, which reads exactly like the model parameter being
dropped. Hashing them showed different content and, on a re-run, different lengths too —
Deepgram is not byte-deterministic. **A matching length is not evidence the same audio was
returned, and it is not evidence the parameter worked either; hash it.**

⚠️⚠️ **THE VOICE IS PER CALL NOW; IT USED TO BE PER WORKER PROCESS.** `agent/voiceAgent.js`
read `VOICE_TTS_MODEL` from the environment **once at startup**, so every demo on the platform
shared one voice and any picker could only ever have been decoration. `ttsFor(brief)` builds the
TTS from the job metadata instead, beside the `instructions` and `greeting` already carried
there. It uses the SDK's own `fromModelString` rather than splitting the string by hand, so the
worker holds **no table of our voices** and cannot disagree with the picker about what a name
means; anything unparseable falls back to the env default, because an empty room is this
pipeline's worst failure and it is silent.

⚠️⚠️ **CONSEQUENCE, STATED PLAINLY: `agent/voiceAgent.js` IS A DEPLOYED IMAGE, SO `git push`
DOES NOT SHIP IT.** Until `lk agent deploy` runs once, the picker stores and previews correctly
and the live call keeps the old voice. That is the difference between this feature and a
beautiful no-op. It is a **one-time** step: after it, every voice change is automatic, which is
the behaviour that was asked for.

⚠️⚠️ **AND THE WORKER'S OWN FALLBACK NAMES IT NOW — a bare `deepgram/aura-2` DID NOT
(9/3/2026).** Asked for directly: "can we make the default voice Thalia, instead of what it is
right now." The picker, the token and `DEFAULT_VOICE_ID` were already Thalia; the gap was
`agent/voiceAgent.js`, whose `VOICE_TTS_MODEL` default was the bare model. Verified against the
installed SDK: `fromModelString("deepgram/aura-2")` leaves `opts.voice` **undefined**, so the
gateway chose the provider's own default and the platform's default voice was whatever that
happened to be — and because that fallback is what an un-deployed worker uses for EVERY call,
it was governing live calls. Now `"deepgram/aura-2:thalia"`, parsed with `fromModelString`
rather than passed as a bare `model` (a composite is not a valid model id on its own).
⚠️ `audit:voice` asserts the worker's fallback string EQUALS
`liveKitVoiceModel(DEFAULT_VOICE_ID)`, so changing the default in either place without the
other reddens — verified in both directions.

⚠️ **THE DEFAULT IS THALIA, AND THAT IS LOAD-BEARING RATHER THAN A TASTE.** `engine/tts.ts` has
always sent `aura-2-thalia-en`, and `deepgram/aura-2` resolves to it — so an untouched demo
sounds exactly as it did before this shipped. `audit:voice` compares `DEFAULT_VOICE_ID` against
`DEEPGRAM_DEFAULT_MODEL` in `engine/tts.ts`, because if those drift, shipping a picker silently
re-voices every prospect on the platform and nobody would attribute it to this change.

⚠️ **`/api/tts` NOW TAKES A MODEL FROM THE BROWSER, so it needed an allow-list or it is an open
Deepgram proxy on our own key.** Only the six the picker offers are accepted; verified live that
`aura-2-zeus-en` (a real Aura-2 voice we do not offer) and `../../etc/passwd` both 400.
⚠️ **A SERVER-CONFIGURED `DEEPGRAM_MODEL` IS DELIBERATELY NOT CHECKED, and the first version got
this wrong.** Validating inside `engine/tts.ts` would have rejected an operator's own env
default and broken TTS everywhere it is set. The check belongs at the request boundary, where
the value's SOURCE is known. Both twins (`vite.config.ts`, `server.ts`) carry it, per the
keep-them-in-sync rule.

⚠️ **THE EDITS GO THROUGH `applyEdits`, NOT A BESPOKE WRITER** — so the picker inherits
`readOnly` on somebody else's demo, an undo step (page undo covers a voice change), and the same
`editGuard` the assistant's edits pass. ⚠️ And `agent.voice` had to join
**CREATABLE_WHEN_ABSENT**: no prospect carries a voice until somebody picks one, so the FIRST
pick is an `undefined -> string` write. Without it the picker would be refused on first use and
work every time after — the exact trap the greeting and `serviceZips` already documented.
⚠️ The greeting field writes **on blur, not on change**: `applyEdits` pushes an undo step per
call, so per-keystroke writes would bury the undo stack under one entry per letter.

⚠️⚠️ **THE CUSTOM GREETING IS VOICE-ONLY, AND THE FIRST BUILD SHIPPED A DEAD CONTROL.** On an
SMS workflow the page registers no `agent` half, so it rendered as a **disabled, empty input
with no explanation** — worse than an absent one, by this file's own rule. Two further reasons
not to fake it there: the screenshot is of a VOICE workflow, so an SMS Details tab's real
contents are unverified, and the SMS opener is `smsPlaybook.greeting` in the **Preview Agent**
scope, so writing `agent.greeting` from there would edit a different agent from the one the page
is about. Gated on `agent`; verified the SMS tab now has **zero** disabled controls.

⚠️ **`useVoiceSpec` WAS EXTRACTED FROM `useBrain` rather than re-deriving the voice in
`VoiceCallLive`.** The call needs the chosen voice for the token, and a second copy of the scope
key plus the merge is how the agent ends up speaking in a voice the Details tab is not showing.
One function answers "which spec is this call using".

⚠️ **PROVENANCE: SCREENSHOT, NOT A CAPTURE — the user's own choice when offered both.** Content
and controls are faithful; the SPACING is authored from platform tokens rather than measured,
because this file's own rule is that screenshot-derived geometry looks plausible and measures
wrong. Same standing as the Create-Tile-with-AI drawer. A SingleFile capture of this tab can be
diffed against it later the way the Create Workflow modal was.
⚠️ **CHROME, DELIBERATELY INERT AND NOT DRESSED UP:** Default Business Hours ("Open 24/7") and
its Edit link, and the Invoca Custom checkbox. The screenshot shows them; nothing behind them is
captured or modelled. Channel and the trigger line are DERIVED from the workflow being rendered.

**`npm run audit:voice` is 78 checks** (was 62). The sixteen new ones call the real functions:
ids are real aura-2 models and unique, the Deepgram and short ids agree, a choice becomes the
composite string, an invented or absent voice falls back, the default still matches
`engine/tts.ts`, every offered voice is previewable while an unoffered real voice and a junk
model are refused, reading an unknown id yields the default, `editGuard` allows the first pick
AND a later change, `specWithConfig` keeps a real voice and drops an invented one, the token
carries the resolved string, the worker builds its TTS per call, and it no longer pins one voice
per process.
⚠️ **Each was broken on purpose and seen to fire**: drifting the default (1 red), removing the
guard pattern (1), reverting the worker to one voice (2), dropping the metadata field (1), and
removing the merge's validation (1) — all restored to green.

**Verified in the browser:** the tab switches and Details renders Channel / Default Business
Hours / Agent Voice / Custom Greeting / Triggered by / Invoca Custom; all six voices list with
Thalia selected by default; picking Arcas stores it, updates the character note, and survives a
full page reload. **Untouched:** the Definition tab (12 nodes, 15 chips, canvas, minimap and
toolbar all present, **zero `.wfd-` elements**) and the SMS workflow's own tab (Channel SMS, its
own trigger line, no voice picker, no dead controls). `audit:ai` and `audit:phases` green, `tsc`
clean on both projects.

#### The picker shows the voice's NAME ONLY — no vendor, no model (9/16/2026)
Asked for directly against the Agent Voice dropdown: *"remove the vendor name and just keep the
Name of the voice."* So "Thalia (Deepgram Aura 2)" is now **"Thalia"**, and the same for all six.

⚠️ **A DELIBERATE DEPARTURE FROM THE SCREENSHOT, which the note above is otherwise strict
about.** Two reasons it is the right one to make: all six voices are Aura-2, so the suffix was
six identical parentheticals carrying no information an SE chooses between; and a third party's
brand on a control clicked in front of a prospect invites a question the demo is not about.

⚠️⚠️ **DISPLAY ONLY, AND THAT IS WHAT MAKES IT SAFE.** `VoiceOption.label` has exactly three
readers, all in `AgentWorkflowDetails` (the `<option>` text and the play button's title and
aria-label). Everything that decides what the agent SOUNDS like keys off `id` — what is stored
on `agent.voice`, what `engine/voicePreview.ts` allow-lists, what `liveKitVoiceModel` builds
`deepgram/aura-2:<id>` from, and what `mintVoiceToken` puts in the dispatch metadata. Verified
with a real pick: choosing Arcas stored **`arcas`**, not the label, and the play button followed.
⚠️ **THE REQUEST CONTRADICTED ITSELF AND THE INTENT WON.** It also said *"just do Deepgram"* —
which IS the vendor, and would have rendered six identically-labelled options. Flagged in the
reply rather than implemented.
⚠️ **STILL SHOWING THE VENDOR, ONE LINE BELOW: the character note.** Thalia's reads "…—
Deepgram's own pick for casual chat and IVR", and it renders directly under the picker. It is
`VoiceOption.note`, not the dropdown, so it was left alone rather than quietly widening the ask;
raised with the user.

#### Then: the vendor is gone from every RENDERED surface (9/16/2026)
Asked for straight after: *"remove deepgram wording for everywhere."* Swept the whole repo and
classified every hit, because "everywhere" cannot mean the model string — see below.

**Changed, because a user sees it:**
| | |
|---|---|
| `VoiceOption.note` (Thalia) | "…— **Deepgram's own pick** for casual chat and IVR" -> "…— made for casual chat and IVR". It renders directly under the picker, so stripping only the labels had left the vendor two lines beneath the control it was just removed from |
| `public/readme.html` | the `DEEPGRAM_API_KEY` / `ELEVENLABS_*` env rows, **which were also STALE** |
| `README.md` | same row, same staleness |

⚠️⚠️ **THOSE DOC ROWS WERE WRONG AS WELL AS VENDOR-NAMED, which is why removing them is a fix
rather than a redaction.** Both vendors were deleted on 9/3 — `engine/tts.ts` is gone, `/api/tts`
404s, and `audit:voice` already asserts neither key is read anywhere — yet the in-app Read.Me
page (served at `/readme.html`, opened from the launch menu) still documented them as "For
voice, pick with `TTS_PROVIDER`". `ARCHITECTURE.md`, the markdown source of truth, had already
been corrected; the HTML had drifted from it for two weeks.
⚠️ **AND REMOVING THEM LEFT THE VOICE ENGINE UNDOCUMENTED**, so a `LIVEKIT_URL` +
`LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` row replaces them — the table had **zero** LiveKit rows
before. Deleting the only voice vars and leaving a gap is a worse doc than the stale one.

⚠️⚠️ **NOT CHANGED, AND THE FIRST ITEM IS LOAD-BEARING: `deepgram/aura-2:<voice>` IS THE WIRE
FORMAT.** `LK_MODEL`, `agent/voiceAgent.js`'s `TTS_MODEL` / `STT_MODEL`, the dispatch metadata
and every audit assertion over them stay exactly as they are. It is a MODEL NAME inside
LiveKit's inference gateway, the way `claude-haiku-4-5` names a model — we hold no credential
for it — and this file already records that a bare `deepgram/aura-2` names NO voice, so dropping
the provider prefix is a call that connects and never speaks.
⚠️ **Code comments, `CLAUDE.md`, `ARCHITECTURE.md` and the audit's own scan messages keep the
word too.** Those explain why the vendors are gone and assert they stay gone; this file already
records the lesson that the vendor scan had to strip comments first because *"a check that
reddens on a correct file gets deleted as a nuisance"*. Redacting the record would make the next
reader re-derive it.

**`audit:voice` is 119 checks** (was 117): no voice **label** and no voice **note** may carry a
vendor or model name (`deepgram|aura|livekit|eleven labs|cartesia|rime|inworld|fish audio`) —
one shared `VENDOR` pattern, so the two cannot drift. Each was verified to FIRE by putting the
old string back. The pre-existing "each label names its own voice" check still holds, because a
bare name still starts with its own id.
**Verified in the browser:** the Details tab's whole `innerText` matches no vendor at all, and
the in-app Read.Me's Technical-detail tab shows the LiveKit row with no `TTS_PROVIDER` and no
vendor key.

### A booked call creates the Salesforce Lead, and the Calendar chip opens it (9/3/2026)
Asked for directly: *"which the voice agent books the appointment and it shows up in salesforce
calendar, i also want you to create that new lead in the leads tab and also when i click on
appointment in the calendar, it should take me to the lead and with lead form filled out from
the information from the call, and then you can make up the other information needed in the lead
form as long as it matches the story."*

`src/data/salesforceLiveLead.ts` is the single definition; the Leads list, the Lead record page
and the Calendar's link all resolve the lead through it.

⚠️⚠️ **ONE DEFINITION BECAUSE THE BEAT ENDS IN A NAVIGATION.** The chip navigates to a slug the
record page has to resolve. Built twice, the chip opens "Lead not found" at the last click of
the demo — and this exact class already bit this family of screens once (two leads hashing to
one call-log record, invisible until a printed value became a LINK). `audit:leads` now checks
the JOIN rather than the pieces.

**What comes from the call, and what is invented** — stated so nobody has to guess later:

| from the call | invented, consistent with the story |
|---|---|
| caller's name, their own phone number | email, built from their name as the pre-call artifacts already do |
| their ZIP -> city, state, area code | the street: place-NEUTRAL ("4629 Maple Avenue"), never a fabricated real local street |
| the product they named | the marketing attribution, taken as ONE WHOLE `digitalInsights` row |
| the boutique, the weekday, the time | Lead Source "Inbound Call" |
| the time the call happened | |

⚠️⚠️ **THE APPOINTMENT GOES IN `Description`, A FIELD THE REAL PAGE ALREADY HAS.** The capture
has no appointment field, and adding one would out-feature the product — the rule the CI tier
report already paid for ("anything added back has to exist on the real report first").
Description is where a Salesforce user records what happened on a call, so the booked day, time
and boutique go there. `Address`, `Lead Source` and `Description` are OPTIONAL on
`SfLeadDetail`, so every DERIVED lead's Address and Additional Information sections stay blank
exactly as captured and as previously asked — asserted.

⚠️⚠️ **THE BOOKING CALLER IS OFTEN ALREADY A LEAD, AND A BLIND PREPEND DUPLICATED THEM.**
Measured: Avi & Co's booking caller is **Marcus Wellington**, who is also its screen-pop caller
and therefore already a derived lead — so the first version put one person on two rows, which is
precisely the duplicated-Dana-Probe look `audit:leads` exists to catch. The row is now replaced
in place and then MOVED TO THE TOP, because the list sorts by Created Date and this is the row
the SE just created. ⚠️ A version between those two replaced without moving, and the
freshly-booked caller sat mid-list while a filler held the top — found by reading the list.

⚠️ **ONE FILLER DROPS SO THE LIST STAYS TEN.** Growing to eleven would be self-consistent (the
count line and both KPI tiles are derived from the rows), but the row that leaves is invented
scaffolding while the row that arrives is a real caller.
⚠️ **AND IT IS SPLICED AFTER THE PAD, NOT PUSHED INTO `sources`.** A source goes through the
dedup and the pad loop, so a live caller sharing a name with a screen-pop caller would be
silently dropped — the very row this exists to show.

⚠️ **THE CHIP IS CLICKABLE ONLY WHEN A CALL CREATED A LEAD.** The DERIVED chip (the hashed SMS
slot every prospect always has) corresponds to no lead at all, so linking it unconditionally
would navigate to "Lead not found" — the reason the Leads and Call Log rows stayed inert until
their pages existed. `.sfc-event-box--link` inherits the chip's own type and colour, because
Lightning does not restyle a clickable event.

⚠️ **`bookedZip` AND `bookedProduct` WERE ADDED TO THE CALL'S OUTCOME**, both allow-listed the
same way `destinations` is: the ZIP only accepted as five digits, the product only if it is one
of the prospect's OWN (from the screen-pop catalogue). Asked what the caller wanted, the model
would otherwise write "a nice watch" into a field sitting beside a Product Category row read off
the prospect's own dashboard.
⚠️ **`resolvePlace` IS NOW EXPORTED and gained four REAL ZIP pairs** (10001, 33139, 33101,
81611 — the boutique cities). One ZIP table, shared with the pre-call artifacts, or a caller
ends up in one city on the Lead and another on the screen-pop. A ZIP3 guess is still refused.
⚠️ An UNRECOGNISED ZIP leaves the address BLANK rather than half-writing it — asserted.

⚠️ **`leadSlug` MOVED to `salesforceLiveLead.ts` TO KILL A RUNTIME IMPORT CYCLE.** The list needs
`liveBookedLead` and that needs the slug function; with the slug on the other side the two
modules imported each other at runtime. It happens to work (function declarations hoist) and is
exactly the fragility that breaks on an unrelated refactor. The type import back is erased at
build, so the dependency now points one way.

**`npm run audit:leads` gained 19 checks**, run against both a brand-new caller and one who is
already a lead: the live lead is the top row, nobody appears twice, the list keeps its length,
the count line matches the rows, the chip's slug resolves on the record page, the record names
the booked time and says Lead Source "Inbound Call" — plus fail-closed: an unbooked call, no
call, a one-name caller and an unrecognised ZIP each produce nothing, and a derived lead's blank
sections are still blank.
⚠️ Each was verified to FIRE: a blind prepend (1 red), the detail page ignoring the captures
(2 red — the "Lead not found" case), and accepting half a name (1 red).
⚠️ **The new block uses LOCAL `okL`/`badL` helpers**, because this script counts with
`let bad = 0` rather than calling `bad()` like `audit:ai` does — the first version called the
counter as a function and crashed.

**Verified in the browser with a real click**: the chip reads "Appointment — Marcus Wellington ·
the New York boutique / 12–1pm" and is an `<a href="/salesforce/leads/marcus-wellington">`;
clicking it opens the record with Address "4629 Maple Avenue, New York, NY 10001", Description
"Appointment booked on the call: Thursday at 12:30 PM at the New York boutique.", Lead Source
"Inbound Call", Product of Interest "rolex" beside Product Category "Rolex", and Marketing Source
"Paid Search"; and the Leads tab lists him first of ten with the call's own number. The four
Salesforce audits, `audit:voice` (107) and `audit:ai` are green, `tsc` clean on both projects.

### "Avi & Co - booking": a voice agent that BOOKS instead of routing (9/3/2026)
Asked for directly: a third Avi & Co voice workflow that runs the same call as the routing
agent but ends by booking the appointment itself — greeting -> caller wants to schedule -> name
and ZIP -> timeline -> weekday -> a time -> the agent confirms with all the details.

⚠️⚠️ **EXTRA WORKFLOWS WERE SMS-ONLY, SO ADDING THIS AS DATA ALONE WOULD HAVE SHIPPED A
CONVINCING SHELL.** Three things fell through for a `channel: "Voice"` extra workflow, and each
was silent: `baseAgent` is `null` for every extra workflow (so no agent config, and the Details
tab correctly reports "no agent configured"), `buildSystem` gates the custom playbook behind
`if (!voice && brain.customSystem)` (so a voice workflow's `systemPrompt` is DISCARDED), and
the call therefore falls back to `voiceSpecFor(profile)`. Net effect: the new workflow would
look right in the sub-nav and behave **exactly like the existing Avi & Co - Voice agent**.
Flagged before building rather than discovered after.

**`ChatBrain.voiceBooking` selects a booking flow, and it REPLACES the routing machinery
rather than trimming it** — the same decision `voiceMinimal` made, for the same reason. The
routing flow's step 3 names a team to hand off to and its service-area gate can REFUSE a
caller; both contradict an agent whose job is to end the call with a confirmed appointment.
`voiceSession` therefore drops `serviceZips`, `outOfAreaScript`, `voiceQualify` and
`voiceSteps` for a booking call, and `audit:voice` asserts none of them reach the prompt.

⚠️⚠️ **THE OFFERED TIMES ARE DERIVED AND BAKED INTO THE PROMPT, NEVER INVENTED.**
`src/data/voiceBooking.ts` gives three slots per weekday (morning / early afternoon / late),
a pure function of the profile id, so the same weekday offers the same times on every
rehearsal. An invented slot is the one thing on this call a prospect could check against a real
diary, and it is also what would desynchronise the Salesforce Calendar. Sunday is absent
because a boutique is not open. ⚠️ `>>>` not `>>` in the hash — the signed-shift bug that once
put a 3am appointment on a business calendar.

⚠️ **THE AGENT SAYS A WEEKDAY AND A TIME, NEVER A CALENDAR DATE.** The Calendar places the
appointment on that weekday of the current week, so a spoken date would be a second,
independent claim about it. One surface owns the date; the screen does.

⚠️ **`ExtraWorkflow.bookingLocations` IS BOTH THE DATA AND THE MARKER.** Its presence is what
makes a workflow a booking one — there is deliberately no separate `mode` flag to drift out of
step with it, and a booking agent with nowhere to book is not a state worth representing.
Optional, so every existing workflow still parses and still routes.

**Out of area: nearest boutique, virtual as the fallback** (the user's choice when asked).
Measured on the real endpoint: ZIP 10001 -> "that puts you closest to our New York boutique";
ZIP 98101 -> nearest offered, caller says it is too far -> "Let's book you a virtual
consultation instead", and the confirmation says virtual.
⚠️ Its geography is still the model's own and occasionally wrong (Seattle was offered New York
where Aspen is nearer) — the same limitation already recorded for the routing agent, harmless
for a demo whose callers are in the served metros.

⚠️⚠️ **THE ROUTING WORKFLOW'S CONVERSATION RULES ARE DROPPED TOO, AND THAT WAS MEASURED.** They
were kept at first, reasoning that rules are "how the agent sounds, not what it does". On the
first real call the agent took the name and then asked *"What brings you in today? Are you
looking to view watches, jewelry, or something else?"* — a qualifying question from the OTHER
workflow, inserted between two steps of this one. They are that workflow's configuration; this
flow is self-contained and carries its own `ASK NOTHING BEYOND THE FLOW ABOVE` cap.

**The booking reaches the Salesforce Calendar, which is what makes it a demo beat.**
⚠️ **THE DAY, TIME AND BOUTIQUE ARE THE CALL'S OWN, NOT DERIVED.** `analyzeSms` fills a
`booked` / `bookedDay` / `bookedTime` / `bookedLocation` outcome by PICKING from the exact
table the prompt offered — the same classify-not-extract pattern `destinations` and
`matchDestination` already use, because this repo has been bitten twice reading model prose.
Flat fields rather than a nested object, since a strict structured-output schema has no
optionals. `bookedEvent` prefers such a booking over its hashed SMS slot and **fails closed**:
no outcome, `booked` false, or a day/time that did not survive validation falls back exactly as
before. Verified on all four bad shapes.
⚠️ **AN EXACT LOCATION MATCH WAS TOO LITERAL AND SILENTLY LOST THE BOUTIQUE.** On a real
transcript the agent said "at **our** New York boutique" while the list holds "**the** New York
boutique", so a strict compare dropped it to `""` and the Salesforce chip lost the one detail
proving the caller's ZIP decided anything. `matchLocation` normalises the article and any
possessive — and nothing else, so an invented "Beverly Hills boutique" is still refused.

⚠️ **THE LOCKED CHROME KEEPS ITS DEFAULT ACTIONS ("Qualify", "Support & Escalate"), and that is
correct rather than an oversight.** Those four boxes are product chrome the user has already
ruled un-editable; the booking actions ("Book Appointment", "Book Virtual", "Confirm & Update")
sit on the USE CASES below, which is where authored content belongs.

⚠️ **`scripts/demo-voice-sim.ts` GAINED `--wf=<slug>`**, mirroring what `AgentWorkflow` passes
as `brainOpts.booking`. Without it the harness could only ever exercise the prospect's built-in
routing agent — and a booking workflow whose prompt is never built is exactly the thing that
ships looking right.
⚠️⚠️ **AND THE FIRST REAL RUN WAS AGAINST A STALE MODULE.** The conversation used the ROUTING
agent's greeting and questions while `--prompt` printed a perfect booking flow, because
`--prompt` is built locally by the script and the CALL goes through the dev server's
Node-cached `engine/chat.ts`. That reads exactly like the feature not working. **Restart the
dev server after editing that file** — the caveat this file already carries, hit again.

**`npm run audit:voice` is 106 checks** (was 87). Nineteen are new and BUILD the prompt: the
flow tells the agent to book, every weekday's times and every location appear verbatim, the
cap and the no-date rule are present, and **none** of the service-area gate, refusal script,
routing steps or routing CALL FLOW leak in; with the flag off the routing prompt is untouched;
slots are stable, three per weekday, no Sunday; `matchLocation` tolerates an article and
refuses an invention; and a confirmed booking lands on the Calendar at its own day and hour
naming the boutique, while all three malformed shapes fall back.
⚠️ Each was verified to FIRE (deselecting the flow reddens 5, removing the cap 1, restricting
the matcher 1, un-preferring the booking on the Calendar 2).
⚠️ **ONE OF THEM WAS WRONG FIRST AND THE CODE WAS FINE:** it asserted the routing prompt
contains "SERVICE-AREA CHECK", but with `voiceSteps` present the STEPS branch wins and that
wording never appears. Yet another probe-not-code fault.

**Verified in the app:** Agent Studio lists it Live / Voice / "Inbound calls to the booking
line" (and the dash in the name survives the sweep, per `SKIP_KEY`); the page draws 9 nodes and
11 chips with the three booking use cases; Preview Workflow is the voice drawer and there is no
Preview Agent button; and the Details tab gives THIS workflow its own voice picker (6 voices,
enabled) and its own opener. ⚠️ **The workflow itself lives in git-ignored
`.data/demos/avi-co.json`** — reaching the live site is a PATCH to the server's own Avi & Co
record, as "Avi & Co - New" already documents.

### ⚠️⚠️ Ask AI said it applied and nothing changed: TWO no-ops on an extra workflow (9/3/2026)
Reported directly, from the Preview Agent: *"in the ask AI feature i asked for a couple of
changes, the AI said that they applied but none of them actually applied to the actual text
messages, for example the opening message still hasnt changed."*

**Both halves were real, both were silent, and both only bite on a Preview Agent opened for an
EXTRA workflow (`/agent-studio/agent/preview?wf=<slug>`).** Reproduced on the user's own Avi & Co
state, whose stored override held their edited greeting and four edited questions.

**1. `wf.openingMessage` OUTRANKED THE AI-EDITABLE GREETING.** `buildSmsBrain` read
`wf?.openingMessage || ac?.smsPlaybook?.greeting || defaultGreeting(...)` — and `wf` comes from
the RAW profile, so no edit could ever win. The drawer's row updated, the assistant reported
success, and the phone opened with the workflow's scripted line forever.
⚠️ **THE FIX RESTS ON `smsPlaybook.greeting` BEING ABSENT UNTIL SOMEBODY SETS IT** — verified
across the demos on disk (Avi & Co and Reyes Law both carry a workflow opener and NO stored
greeting). So its mere PRESENCE means a human or the assistant put it there, which is exactly
what should win. Order is now explicit-greeting -> workflow opener -> derived default, so an
UNEDITED workflow is byte-identical to before.

**2. `customSystem` SWALLOWED EVERY OTHER EDIT — the bigger half.** `buildSystem` does
`if (!voice && brain.customSystem) return customSystem + SMS_FORMAT_RULES`, returning **before**
the lines that render the questions, the brand rules, the Q&A and the knowledge list. So on such
a page an edited question list never reached the model at all. That is what "a couple of changes,
none of them applied" actually was.
⚠️⚠️ **ONLY WHAT GENUINELY DIFFERS FROM THE PROFILE IS APPENDED, and that gate is the whole
design.** Appending a prospect's generic playbook questions to a nurture script nobody edited
would CONTRADICT that script — "a self-contradicting prompt is worse than either rule", which
this file already records twice (the column-edit prompt, and the out-of-area script fighting
step 3). `editedSlices()` diffs the effective config against `profile.reports.agentConfig`, so
untouched workflows send nothing and read exactly as authored. Same
regenerate-only-when-the-source-changed pattern as the voice greeting sync and `stepsForZips`.
⚠️ **THE APPENDED BLOCK STATES ITS OWN PRECEDENCE** ("Where the two disagree, THIS SECTION
WINS") and mirrors step 2's question wording verbatim, so a question list behaves the same
whichever branch renders it. Without that sentence the model has two competing lists and picks
one at random.

**3. AND THE DRAWER WAS SHOWING A LINE THE AGENT NEVER SENDS.** Its greeting memo carried the
comment *"The SAME derivation the phone uses"* and had stopped being true: it read
`smsPlaybook.greeting || defaultGreeting(...)` with no workflow term. So the row displayed a
DERIVED default and the prompt handed the model that same wrong text as the current opening
message — which is why the assistant's edits read as plausible and landed nowhere.
⚠️ **THE OPENER IS PASSED AS SCOPE METADATA (`Scope.greetingFallback`), NOT SEEDED INTO THE
BASE.** The agent scope key is `<profileId>::/agent-studio/agent/preview` for EVERY Preview
Agent regardless of `?wf=`, so seeding it would leak one workflow's opener into the built-in
agent and into every other workflow's chat. Opt-in, defaulted absent, threaded
`PhonePreview -> usePageData -> registerScope -> the drawer`.

**Verified on the user's own data, end to end.** With the fix, `/api/chat`'s request body
carries `openingMessage` = their edited greeting and `overrides.questions` = all four of their
edited questions, while `hasCustomSystem` stays true so the workflow's playbook still governs.
The phone's first bubble is their line rather than the scripted one.
⚠️ **A NOTE ON WHAT WAS PROVED:** the config now REACHES the model with explicit
in-this-exact-order instructions. Whether the model then asks them in order is model behaviour,
not plumbing — one reply is not proof of that, and this section does not claim it.

**`npm run audit:ai` gained 10 checks**, and they call the real `buildSmsBrain` +
`smsSystemPromptForAudit` against a real workflow shape rather than grepping: an unedited
workflow keeps its opener / sends no overrides / gains no block, an edited greeting beats the
scripted opener, edited questions and rules survive `customSystem`, the block declares
precedence, the workflow's playbook is still present, and both ends of the drawer fallback are
wired.
⚠️ Each was broken on purpose and seen to fire: restoring the old precedence (1 red), restoring
the early return (3 red), removing the drawer fallback (1 red), and deleting the precedence
sentence (1 red).

⚠️ **A LESSON WORTH THE REPEAT: "the drawer said it applied" IS NOT EVIDENCE.** That is now the
fourth time in this file. The reliable test is to read the REQUEST BODY the agent is sent, which
is what settled it here — patching `fetch` in the page and inspecting `brain`.

### ⚠️⚠️ STANDING RULE: ALL VOICE GOES THROUGH LIVEKIT — Deepgram and ElevenLabs are DELETED (9/3/2026)
Asked for directly: *"completely delete everything related to elevenlabs or deepgram, i no
longer want to use them for anything, I am going to remove their API credentials locally and on
render, i want everything to do with Voice agents to go through LiveKit."*

⚠️ **FIRST, THE DISTINCTION THAT DECIDES HOW TO READ THE CODE.** `deepgram/aura-2` and
`deepgram/nova-3` still appear, and they are **MODEL NAMES INSIDE LIVEKIT'S INFERENCE GATEWAY**
— the way `claude-haiku-4-5` names a model. LiveKit brokers seven TTS providers and you pick
one by name; we hold no Deepgram credential on that path and LiveKit bills it. What was deleted
is **both vendors as direct APIs with our own keys**. Confirmed with the user before deleting,
because the other reading would mean re-picking all six voices from Cartesia/Rime/Inworld.

**What is gone:**

| deleted | was |
|---|---|
| `engine/tts.ts` | the whole provider layer: `api.deepgram.com/v1/speak`, `api.elevenlabs.io/v1/text-to-speech` |
| `POST /api/tts` (both twins) | the endpoint in front of it |
| `src/screens/VoiceCall.tsx` | the **browser-speech call engine** — see below |
| `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `TTS_PROVIDER` | every read, plus `.env.example` and the deploy docs |
| `status.ttsProvider` / `status.ttsKey` | two fields on the PUBLIC `/api/status` payload |

⚠️⚠️ **THE BROWSER-SPEECH ENGINE HAD TO GO WITH THEM, AND THAT IS A REAL DELETION RATHER THAN
A TIDY-UP.** `VoiceCall.tsx` was the pre-LiveKit pipeline (browser `SpeechRecognition` ->
`/api/chat` -> `/api/tts`), kept as the fallback for a server with no LiveKit keys. Its mouth
WAS Deepgram or ElevenLabs; without them it could only speak in the browser's robotic voice, so
keeping it would have shipped a "fallback" that sounds nothing like the product. **LiveKit is
now the only voice engine**, and where it is unconfigured the workflow page says so instead of
degrading silently.
⚠️ **ITS SHARED HALF SURVIVED AS `src/data/voiceSession.ts`** — `useBrain`, `useVoiceSpec`,
`captureVoiceCall` and `buildVoiceConversation` were used by BOTH engines, and the capture path
in particular is the one `audit:voice` asserts is single (a duplicated copy is how a real
LiveKit call once stored no outcome). The barge-in constants, VAD thresholds and browser
voice-picker went with the component, because LiveKit handles interruption itself and leaving
them would imply knobs that control nothing.

**The preview button, rebuilt on LiveKit — `engine/voicePreview.ts`.** This is the part worth
reading before changing anything:

⚠️⚠️ **NO NEW DEPENDENCY, AND THAT WAS MEASURED RATHER THAN ASSUMED.** The obvious route is
`inference.TTS` from `@livekit/agents` — the class the worker uses. On the WEB server that costs
**26 MB** plus the OpenTelemetry exporter stack and `@livekit/local-inference` (partly native),
on a service whose job is serving screens; a native install failure on Render would break the
whole app for one button. So the endpoint speaks the gateway's own protocol using
`livekit-server-sdk` (already a dependency) for auth and **Node's built-in WebSocket**.

| | measured |
|---|---|
| endpoint | `wss://agent-gateway.livekit.cloud/v1/tts` (staging variant when `LIVEKIT_URL` says staging) |
| auth | `AccessToken` + **`addInferenceGrant({ perform: true })`** |
| handshake | **`?access_token=<jwt>` as a QUERY PARAM** |
| frames | `session.create` -> `input_transcript` -> `session.flush`; back: `session.created`, `output_audio` (base64), `done` |
| audio | headerless **pcm_s16le, 16 kHz mono** -> wrapped in a 44-byte WAV header |

⚠️ **THE QUERY PARAM IS WHY NO `ws` PACKAGE IS NEEDED, and the name was verified rather than
guessed.** The SDK authenticates with an `Authorization: Bearer` HEADER, and Node's built-in
WebSocket cannot set headers. Tested against the live gateway: `?access_token=` is **accepted**
and `?token=` is **rejected**.
⚠️ **THE WAV HEADER IS NOT OPTIONAL.** The gateway returns raw PCM, which no browser will play
— that is why the endpoint does not just forward the bytes. WAV over MP3 because it needs no
encoder; ~40 KB for three words.
⚠️⚠️ **THE FRAME SHAPES ARE READ OFF THE SDK'S COMPILED CLIENT, NOT A PUBLISHED SPEC — so the
blast radius is stated deliberately.** If LiveKit changes this wire format the **play button**
breaks and says so; **the call does not**, because the deployed worker uses the real SDK. That
asymmetry is the only reason this shortcut is acceptable here, and it would NOT be acceptable
inside the worker.

⚠️ **THE PREVIEW AND THE CALL NOW SHARE ONE MODEL STRING, which fixed a real defect rather than
just removing a vendor.** The old button went to Deepgram DIRECT while the call went through
LiveKit's gateway — two paths that could resolve the same voice differently, so an SE could
audition a voice the call would not produce. Both now send `deepgram/aura-2:<id>` to the same
gateway, and `audit:voice` asserts the endpoint derives it from `liveKitVoiceModel`.
⚠️ `VoiceOption.deepgramModel` (`aura-2-<name>-en`) is **deleted** — it existed only for the
REST call. One id format now.
⚠️ The endpoint still **allow-lists the voice** and caps the text at 200 characters: it is
reachable from a browser and spends LiveKit inference, so it may only ever say a short line in
one of the six voices the picker offers. Verified live that `zeus` (a real Aura-2 voice we do
not offer) returns 400 naming the six.

**Point 3 of the request — "when the voice changes in the details tab it should also change in
the Preview Workflow" — is the same wire, and was verified end to end**: picking Harmonia on
Details made Preview Workflow's Start Call post `voice: "harmonia"` on its token request (proved
by patching `fetch` and reading the body), which `mintVoiceToken` resolves to
`deepgram/aura-2:harmonia` in the dispatch metadata, which the worker's parser turns into
`opts.voice = "harmonia"`. The only unproven link remains the worker RUNNING that code, which
needs one `lk agent deploy`.

**`npm run audit:voice` is 87 checks** (was 78). The nine new ones are the guard against this
drifting back: no `api.deepgram.com` / `api.elevenlabs.io` anywhere, neither key read anywhere,
`engine/tts.ts` gone, the browser engine gone, **both twins** serving `/api/voice-preview` and
neither serving `/api/tts`, and an unconfigured server saying LiveKit is missing.
⚠️⚠️ **THE VENDOR SCAN STRIPS COMMENTS FIRST, AND IT HAD TO — IT FIRED ON ITS OWN
DOCUMENTATION.** Several files legitimately NAME the retired endpoints while explaining why they
are gone. A check that reddens on a correct file gets deleted as a nuisance, so only code is
searched (line comments matched anchored to the line start, or a `https://` inside a string
looks like one).
⚠️ Each was broken on purpose and seen to fire: reintroducing a real `api.deepgram.com` fetch,
renaming the route back to `/api/tts`, and removing the voice allow-list each turned one red.
⚠️ Two existing checks had to be **re-aimed rather than deleted** when the second engine went:
the "exactly ONE `/api/analyze` call" and shared-capture checks now read `voiceSession.ts` plus
the one engine. The invariant is unchanged and still the thing that caught a real bug.

**Verified live:** `/api/voice-preview` returns valid RIFF/WAV for every offered voice with
different byte lengths per voice (Thalia 34,606; Arcas 41,006), refuses an unoffered one with a
message naming the six, and `POST /api/tts` now 404s. `tsc` clean on both projects,
`audit:voice` (87) and `audit:ai` green.

### Don't ask twice: the voice agent was re-asking ZIP and name (9/2/2026)
Reported directly: "when asking for things like are you looking to book an appointment or
something, or their zipcode, or their name. Only ask that once, you should remember that data or
customer doesn't have to say it twice."

⚠️⚠️ **THIS WAS STRUCTURAL AND AFFECTS ANY PROSPECT WITH A SERVICE-AREA CHECK, NOT ONLY AVI &
CO.** The CALL FLOW's step 2 (the service-area check, built from `voiceSteps`/`serviceZips`)
and each path's own "collecting X, Y, Z" line (built from `TreePath.chips`) are two independent
blocks that were never reconciled. `deriveUseCases` puts **"Consumer Name" on every single
sales AND support use case by design**, and "Consumer Zip" is the DEFAULT `where` for any
vertical that is not a hotel, home-service, or senior-care business. So the agent asked for the
ZIP (or name) once during the service-area check, then asked for the SAME field again the
moment it reached the chosen path's collect list — on Avi & Co (custom AI-written steps, ZIP
only) and, worse, on **Comfort Keepers** (the generic template, which asks for BOTH zip and full
name in its own hardcoded step 4), where every single path re-asked "Consumer Name" a second
time.

**Two deductions, computed fresh from the same `zips`/`steps`/`serviceArea` values that already
decide whether step 2 exists**, so there is no second flag to drift out of sync with them:
- a ZIP is asked in step 2 whenever ANY of the three service-area branches fires (custom steps,
  an allow-list, or the demo's single-ZIP fallback) — that block's only purpose is asking for a
  ZIP, so this can never misfire;
- a full name is asked in step 2 only when the steps TEXT actually says so (`/\bfull name\b/i`)
  — true of `stepsForZips`'s own wording, and of a custom step that happens to mention it too.
  Deliberately conservative: a custom step that never asks for a name leaves "Consumer Name"
  alone, so the field still gets asked exactly once, just later in the path rather than not at
  all.

`dedupeCollect()` strips those two EXACT chip strings from a path's collect list when the
matching deduction is true. Everything else — Care Location, Timeline, Consumer Email,
Destination, Travel Dates — is untouched, because those are genuinely distinct fields the
service-area check never gathers.

⚠️ **A GENERAL BACKSTOP RULE WAS ADDED TOO, for what the structural fix cannot see**: a caller
who volunteers their name before being asked, or gives their ZIP while answering a different
question. "NEVER ask for anything you already have… track what you have gathered so far" — the
same instruct-then-enforce pairing the dash rule and the placeholder rule already use in this
file. Verified live: a caller who says everything in one breath ("this is Marcus Wellington,
I'm in zip code 80202, ready to book") gets neither re-asked, and the agent moves straight to
resolving the ZIP.

⚠️⚠️ **TWO SEPARATE EDITS TO A `\b` WORD-BOUNDARY REGEX WERE SILENTLY CORRUPTED BY THE SAME
PYTHON-HEREDOC MISTAKE, and it cost the most time in this fix.** Writing `\bfull name\b` inside
a Python triple-quoted (non-raw) string collapses `\b` to an actual ASCII BACKSPACE byte
(0x08), not the two characters backslash-then-b. `tsc` cannot catch it — a raw backspace
between two `/` delimiters is a syntactically valid regex, it just matches a literal control
character that never appears in real text, so the regex silently never matched anything.
`grep`/terminal output rendered the corrupted line as if it read `/full name/i` (the backspace
erased the visible `\` when printed), which is exactly why the bug looked invisible until the
bytes were inspected with `od -c`. **Any edit containing `\b`, `\n` inside a Python string
literal (not a raw string) needs its bytes verified with `od -c`, not just `grep`, before
trusting it compiled correctly.** Both occurrences (the fix itself, and the audit check written
to verify it) were caught and fixed the same way.

⚠️ **`npm run audit:voice`'s OWN "every field a use-case node advertises is asked for in the
prompt" check had to be updated, and this is not a case of loosening a check to make it pass.**
It did a literal `prompt.includes(field)` substring search, which is now too strict: Denver
Health's service-area step says "ask for their zip code and capture it", never the literal UI
label "Consumer Zip", so stripping the duplicate from the path line correctly made the LITERAL
string vanish from the whole prompt even though the ZIP is still asked, just earlier and in
different words. The check now accepts two narrow SEMANTIC exceptions — "Consumer Zip" is
satisfied whenever a service-area check of any shape exists, "Consumer Name" whenever the
prompt matches `/\bfull name\b/i` — and every other field (Destination, Travel Dates, Care
Location) still has to appear literally. **Verified the check still fires**: force-dropping an
unrelated field ("Destination") from a `dedupeCollect`-style filter still fails it on Marriott,
exactly as before.

⚠️ **AND `.data/demos/*` IS GIT-IGNORED, SO THIS IS A DEPLOY-TIME FIX FOR EVERY EXISTING
DEMO.** Both dedupe passes read `brain.voiceSteps`/`serviceZips` at PROMPT-BUILD time, not at
save time, so no demo record needs editing — Avi & Co, Comfort Keepers, and any other demo
already carrying a service-area check stop double-asking the moment this deploys.

Verified end to end via `scripts/demo-voice-sim.ts` against the real `/api/chat` endpoint:
Avi & Co's ZIP is asked exactly once (previously twice); Comfort Keepers' name is asked exactly
once (previously twice); AutoNation, which has NO service-area check at all, is byte-for-byte
unaffected (Consumer Name and Consumer Zip both still appear, since nothing was ever gathered
earlier to deduplicate against). `audit:voice` (62 checks) and `audit:ai` both green; the
pre-existing 14-of-25 `audit:seeds` failures are unchanged.

### The tree's pills overflow their box on any non-voice leaf, fixed (9/2/2026)
Reported directly: "some of the pills in the boxing are going outside the box, the pills should
only be similar to the voice agent 'Consumer Name and Consumer Zip'." — i.e. wrap the way the
voice tree's chips already do.

⚠️⚠️ **`flex-wrap: wrap` WAS ONLY EVER SET ON `.wf-voice .wf-chips`, NEVER ON `.wf-chips`
ITSELF.** Every other leaf — the built-in SMS tree's, and any extra workflow's use cases, where
2-3 chips is normal — had NO wrap at all, so a chip row wider than the SMS node's 220px just kept
going in one line. `.wf-node` sets no `overflow`, so the pills rendered fully visible OUTSIDE the
card's border rather than being clipped, which is what made the bug so obvious on screen. Moved
the property to the base `.wf-chips` rule and removed the now-redundant voice-only copy.

⚠️ **THIS WAS A REAL, PRE-EXISTING BUG ON REYES LAW, NOT SOMETHING THE NEW AVI & CO WORKFLOW
INTRODUCED.** Its "Re-engaged" leaf carries three chips (First Name, Injury Type, Date of
Incident) and was overflowing the same way before this fix — confirmed by loading the actual
demo and measuring it. The new Avi & Co workflow's three-chip use cases just made the same
long-standing bug impossible to miss.

**Verified with real measurements, not a screenshot glance**: every chip's `getBoundingClientRect()`
compared against its own node's, on Avi & Co's new tree (4 leaves, 2-3 chips each), Reyes Law's
nurture tree (now rendering correctly through the locked-chrome restructure from the same day),
the built-in SMS tree (Consumer Name / Rolex, 2 chips, unaffected, still one line), and the voice
tree (unaffected, wrap was already there). `audit:ai` and `audit:voice` (62) both green; `tsc`
clean.

### Orlando Health's five ER messaging workflows, and Ask AI reaching an SMS agent (9/8/2026)
Asked for with a doc attached: *"Create a new workflow for each of the scenarios just for Orlando
Health, make sure the Tree matches, similar to the logic in the voice ai trees. and make sure
preview agent and preview workflow does what the scenarios says. Also make sure the Ask AI
performs the same way the Voice AI workflow does."* Source: **"Orlando Health - AI Messaging
Scenarios for Demo Video"**, the sign-off doc for the video, five scenarios with transcripts.

**Five `reports.extraWorkflows` entries on the BUNDLED profile** (`src/data/generated/orlando-health.json`,
which is in git), so they travel with the demo and reach the live site through a push rather than
a PATCH. That is the opposite of the Avi & Co case: those live in `.data/demos`, which is
git-ignored, because Avi & Co is a library demo. **Check which store a prospect is in before
authoring anything.**

| slug | scenario | trigger | use cases |
|---|---|---|---|
| `sms-er-still-waiting` | 1, still waiting at ORMC | wait over threshold | 3 sales + 1 support |
| `sms-er-lwbs-pcp` | 2, left without being seen, refer to primary care | LWBS in Epic | 2 + 1 |
| `sms-er-lwbs-care-now` | 3, still needs care now | LWBS in Epic | 2 + 1 |
| `sms-er-warm-handoff` | 4, context travels to the call center | asks for a person | 1 + 2 |
| `sms-er-new-vs-existing` | 5, new versus established patient | LWBS, Epic record checked | 3 + 1 |

Every `openingMessage` is the doc's own outbound text VERBATIM, minus the "Orlando Health:"
sender label the doc uses to mark who is speaking. Scenario 5 keeps `{name}` as a token
(`resolveGreeting` resolves it off the voice screenpop's caller, so it renders "Hi Michael…").
The doc's five ground rules are in every `systemPrompt`, not spot-checked on one, and
`audit:ai` asserts each of the seven on all five.

#### `ExtraWorkflow.playbookSteps` — the ordered flow, as a LIST
⚠️⚠️ **THE WHOLE REASON IT IS A LIST AND NOT MORE PROSE.** `systemPrompt` is one blob: a model
asked to "confirm the facility first" has to rewrite the whole thing, and `editGuard` sees one
giant string diff rather than a list whose length is its content. The voice page settled this
shape already, `agent.informSteps` is a `string[]` and is why "drop the step that asks for a
name" works there. Rendered by a new `stepsBlock()` in `engine/chat.ts`, **numbered, with "do
not skip, do not reorder"** copied from step 2 of the main flow: a bulleted list of steps reads
to the model as a MENU, which is the exact mistake this file records against the Preview Agent's
questions.
⚠️ **NEVER AUTHOR BOTH.** Put a workflow's flow in `playbookSteps` OR in the prose, not both, or
the prompt carries two orderings of one flow and the model picks one. Avi & Co and Reyes Law
carry theirs in prose and set no `playbookSteps`, so nothing is appended and their prompts are
byte-identical, which `audit:ai` pins.
⚠️ **IT IS SKIPPED BY THE DASH SWEEP**, and it needed its OWN constant to be. `systemPrompt`
earned that exemption on 9/2 because it is instructions to the model and never shown to a
prospect, and this is the same thing; but the object walk skips a `SKIP_KEY` **only when the
value is a string**, so an array keyed `playbookSteps` was recursed into and swept step by step.
`SKIP_LIST_KEY` + `isSkipped()` handle the list form. Kept separate rather than widening the
guard to arrays, because `path` and `range` are also in `SKIP_KEY` and could hold an array
somewhere.

#### Ask AI on an SMS workflow now configures the agent, exactly as the voice page does
⚠️⚠️ **BEFORE THIS, AN SMS EXTRA WORKFLOW REGISTERED ONLY ITS DIAGRAM.** So "open with X" or
"confirm the facility before offering anything" had nowhere to land: the model wrote the edit,
`applyEdits` found no such path, and the drawer reported success. Sixth instance of the silent
no-op in this file, and the same gap the voice page closed on 8/27.

`AgentWorkflow` now merges `agent: smsWorkflowAgentOf(extra)` into the SAME registered object as
the tree (never a second `usePageData`, which is last-write-wins and would repoint the page's
sparkle off the diagram).

| lives in | fields |
|---|---|
| the **tree** | intent subtitles, leaf titles, use-case titles, chips |
| **`agent`** | `greeting` (the workflow's `openingMessage`), `steps` (its `playbookSteps`) |

⚠️ **`rules` AND `questions` ARE DELIBERATELY NOT IN IT.** They already have a home, the
prospect's `brandConversationRules` and `smsPlaybook.qualifyingQuestions`, edited on the Preview
Agent page and reaching a custom-playbook workflow through `overrides`. A second home for one
field is the duplicated-field failure behind all three of the 8/27 voice bugs.

⚠️ **THE EDIT HAS TO CROSS A TAB BOUNDARY, and that is the part that could have been a no-op.**
Preview Agent opens at `/agent-studio/agent/preview?wf=<slug>`, a different page, so it rebuilds
the workflow page's key via `smsWorkflowScopePath(slug)` and reads it with `effectiveData`
(registers nothing). Overrides are persisted to localStorage, which is what makes a value
written in the other tab visible at all. ONE definition of that path string, because the page
writes it and another page reads it, and two copies is how one of them ends up reading a key
nobody writes. `WorkflowChatPreview` gets the same half handed down as a `wfAgent` prop, since
it is on the page and may not register a scope.

⚠️ **PRECEDENCE IS `smsPlaybook.greeting` -> `wfAgent.greeting` -> `wf.openingMessage`.** The
middle one's BASE is the authored opener, so an unedited workflow resolves to the same string as
before. Putting `wfAgent` first would have re-created the 9/3 bug: a workflow-side value
outranking a greeting a human explicitly set.

#### Three things found by looking, not by a test
1. ⚠️⚠️ **THE DRAWER SHOWED A LINE THE AGENT NO LONGER SENDS — defect 3 of the 9/3 report, back
   through a new door.** With the opener edited on the workflow page, the phone's first bubble
   read "Hi Michael, Orlando Health here…" while the drawer's OPENING MESSAGE row still showed
   "Hi Michael, this is Orlando Health…". `greetingFallback` was `wf?.openingMessage`, the RAW
   value, and it is now `wfAgent?.greeting ?? wf?.openingMessage`. The 9/3 check had to be
   WIDENED (it required `greetingFallback:` immediately followed by `wf?.openingMessage`) and
   the strict half moved to its own assertion.
2. ⚠️ **THE AGENT MINTED A PHONE NUMBER.** Asked to refer a patient, it produced "Call Orlando
   Health scheduling at 321-841-5111" — plausible, unverifiable, and headed for a demo video.
   The doc writes "Call [number]" and leaves it to us. Ground rule 8 now pins **407-303-5910**,
   which is Orlando Health's own callback number ELSEWHERE IN THIS DEMO (a call transcript in
   `conversationIntelligence`), so it is derived rather than invented, and forbids inventing a
   number, address, provider or facility.
3. ⚠️ **THE DECORATIVE MINIMAP SAT ON THE LAST NODE OF A FOUR-COLUMN SMS TREE.** Measured at
   1440x1000: `sms-er-new-vs-existing`'s "Clinical or Emotional Reply" and its action text were
   both under the minimap's box, while a 3-use-case tree cleared it. **So it has been true since
   9/2 for Avi & Co's `sms-new` and Reyes Law's `sms-nurture`, both four-branch.** `app.css`
   already hides this element on the voice canvas with the note "Voice tree is taller, so it
   doesn't overlap the leaves", so `.wf-canvas-tall` does the same for an SMS tree that has a
   USE-CASE row. **The condition is the fourth row, not a column count** — keying off a
   threshold would put hardcoded geometry back into the component that exists to compute it. The
   built-in SMS tree, the Comfort Keepers override and a created workflow all have leaves with
   no `paths`, so none of them changes.

#### ⚠️⚠️ THE TREE HAD NO SYMMETRY, AND BOTH HALVES WERE ONE ROOT CAUSE (9/8/2026)
Reported the same day, against these five pages: *"There isnt any symmetry, in the branch in the
tree diagram. for example 1. Sometimes the sales Inquiry branch is different length to the Need
support. or the the branch line is too close to the Conversation Start box."*

**`GEO`'s row constants are FIXED while node heights are MEASURED, so every gap in the diagram
was `(a constant) − (however tall the text above made the row)`.** Measured across the seven
Orlando Health workflow pages before touching anything:

| | stub under Conversation Start |
|---|---|
| the two whose `startLabel` wraps to a second line | **4px** |
| the five that fit one line | 23px |
| the voice tree | 73px |

One workflow away from a third line it would have **inverted and pointed upwards**, which is the
failure the note at the top of `FALLBACK` already records for a hardcoded offset. And the second
half is the same arithmetic one row down: the built-in SMS tree's sales leaf measured **142px
against the support leaf's 75px** because it carries two chips, so the two branches genuinely
were different lengths.

**Two fixes, and both were needed — the first alone does nothing for the second.**

1. **`rowLayout()` places every row at `max(its constant, the row above + MIN_GAP)`**, with
   `MIN_GAP = 30` (the product's own bus-to-intent drop, which was written as `g.intent - 30`).
   ⚠️ **ONE SHARED, ACCUMULATED SHIFT, NOT A `max` PER ROW — and the per-row version was the
   first attempt.** Clamping each row independently fixed the crowding and then ate the NEXT
   gap instead: the intent-to-leaf stem came out 54px on five workflows and **35px on the two
   whose subtitle wraps**. Symmetric within a tree, still ragged across the list of them.
   Accumulating one shift and applying it to every row below preserves each variant's designed
   gaps, because a row that has to move takes everything under it along.
   ⚠️ **MONOTONE, WHICH IS WHY NO SIGNED-OFF DIAGRAM MOVED.** A row only ever moves DOWN.
   Verified: the voice tree is byte-identical (its 103 / 73 / 100 gaps all clear MIN_GAP
   already, so the shift stays 0) and the built-in SMS tree's bus and intent row move 7px,
   which is that bus finally clearing the box by 30.
   ⚠️ **ONLY ASK IT ABOUT ROWS THE TREE ACTUALLY DRAWS.** `rowAt` mutates the shift, so
   querying the sub-bus on a tree with no split grew it by 13px and pushed every row below
   down for a bus that is never rendered. Caught in the arithmetic, not on screen.

2. **`levelRow()` gives every node in a row the tallest one's height**, so a row has ONE bottom
   and every stem leaving it is the same length by construction. The height state collapsed
   from `intents: number[]` + `leaves: Record<string, number>` to scalars; those per-node
   lookups existed only to cope with the raggedness.
   ⚠️ **IT CLEARS `minHeight` BEFORE MEASURING, AND THAT IS THE WHOLE TRICK.** Reading
   `offsetHeight` with the previous pass's levelling still applied returns the level, not the
   content, so the row could only ever GROW: Ask AI dropping a chip would leave every box
   stranded at the old height with dead space, and nothing on screen would say why.
   ⚠️ **THE HEIGHT IS WRITTEN IMPERATIVELY, NOT THROUGH THE `style` PROP.** Rendering it means
   React re-applies it next commit and the effect clears it the pass after — and when the
   measurement is unchanged `setH` bails, React does not re-render, and the row is left CLEARED
   and ragged on screen. Ending the layout phase with the value applied is what guarantees the
   painted frame is levelled.

**Consequence, stated: the last row of every diagram is now level.** The built-in SMS tree's
support leaf grows from 75 to 142 to match the sales leaf, and the voice tree's six use cases
all sit at 162. That is the change the report asked for, and it reaches every prospect. The
strongest evidence it is right is the product's own empty-workflow capture, which measures both
user-group leaves at **248 x 72** and both intents at **248 x 46** — a uniform row.

#### `workflowRows.ts`, and 30 more audit checks that sweep instead of sampling
`GEO`, `MIN_GAP` and `rowLayout` moved into `src/data/workflowRows.ts` — a pure module with no
JSX and no React, for the two reasons `workflowChrome.ts` is one: node can call `rowLayout`
directly, and exporting a plain function from `WorkflowTree.tsx` breaks that file's fast refresh
(`oxlint`'s `only-export-components`, which this repo already carries three of).

`audit:ai` (129 checks, up from 76) now sweeps `rowLayout` over **10,368 height combinations** (six box heights from one
to five lines plus an absurd 400, across both variants and with and without the sub-bus and the
path row) and asserts that **no connector inverts and none is shorter than 30**. Plus:
monotonicity, the voice tree's six row constants pinned to their captured values, and that
`levelRow` still clears before measuring. **Verified to fire**: reverting `busY` to the constant
turns up 5,904 inverted connectors and a −628px line; removing the clear, moving a voice
constant, and putting a per-node row bottom back each turn one red.
⚠️ Two probe faults again, both from this file's own catalogue. One check read the row
arithmetic out of `WorkflowTree.tsx` after it had moved to `workflowRows.ts`, and reported a
defect that did not exist. And the first sabotage attempt (`intentBottom = intentTop + h.intent
+ 0`) still satisfied the regex, so the check LOOKED like it had failed to fire when the test
was the thing at fault.

#### The five workflows' own copy got shorter, for a measured reason
⚠️ **LEVELLING A ROW COSTS HEIGHT, AND THE FIT HAS A 0.5 FLOOR.** With the row levelled to its
tallest card, `sms-er-new-vs-existing` grew past the floor at 1180x780 and the canvas started
scrolling where it had fitted at 0.5015 — that margin was already nothing. Eleven actions and
titles that wrapped to a second line were shortened ("Refer to Primary Care and Hand to
Scheduling" to "Refer to Primary Care", "Route to Patient Financial Services" to "Route to
Patient Billing"), and the three `startLabel`s over 29 characters were cut to under 27 so the
Conversation Start box stays one line and the shift stays at 7. Better on the diagram either
way: a two-line action in one card and a one-line action in the next is what made the row
ragged in the first place.
**After: no tree scrolls at 1440x1000** and they render at 0.78 to 1.0 rather than 0.5, so they
are LARGER than before. Two of the five still scroll at 1180x780, which is a canvas 369px tall
— the voice tree has always done that there, and the floor exists for exactly this ("a legible
diagram you move, not an illegible one you cannot read").

#### `extraTree` and the three leaf actions MOVED to `workflowChrome.ts`
⚠️ **BECAUSE THE AUDIT COULD ONLY GREP THEM.** `AgentWorkflow.tsx` imports `useProfile`, which
reaches `profiles.ts` and its Vite-only `import.meta.glob`, so node cannot import that screen —
which is why the extra-workflow checks matched `title: INTENT_SALES` and counted `locked: true`
occurrences. Exactly the reason `INTENT_SALES` and friends moved on 8/27, and that file's own
header records why it matters: "a grep passed against `if (false && CHROME_KEYS.has(path))`."
Nothing about the values or the logic changed; the one edit is the signature, which took
`ReturnType<typeof useProfile>[...]` to reach a type the schema exports directly. All eight of
those checks now BUILD a tree and read it, and the lock checks run against the tree they just
built rather than a hand-written copy.

**`npm run audit:ai` went from 76 checks to 123**, and every new one was broken on purpose and seen to fire.
Two of them did not fire on the first try, both probe faults, both already in this file's
catalogue:
- ⚠️ **A CHECK THAT PASSED AGAINST DEAD CODE.** The Ask AI hint check located the SMS body by
  searching for `d?.variant === "sms"` and then read the copy inside it, so disabling the branch
  as `if (false && d?.variant === "sms")` left the search string in place and the check passed.
  It now asserts the guard line verbatim.
- ⚠️ **A CHECK THAT MATCHED ITS OWN DOCUMENTATION.** `!/usePageData/.test(chat)` failed on
  correct code because `WorkflowChatPreview`'s header says "It must NEVER call `usePageData`".
  Comments are stripped first, which is the fix `audit:place` already carries.
- ⚠️ And one assertion was simply wrong about the codebase: it claimed a chart's `series` length
  was still blocked, but `/\bseries$/i` has been a length exemption since the standing AI-button
  rules. The thing to prove is that the exemption is SCOPED, so it now asserts a BARE `steps`
  array is still refused while `agent.steps` is not.

**Verified live, end to end, reading request bodies rather than trusting the drawer:**
- The Agent Studio table lists all five with their own Triggered By prose; the sub-nav lists them
  under the built-in pair.
- Each tree draws the locked chrome (`Sales Inquiry` / `Need Support`, `All Sales Inquiry Users` /
  `Qualify`, `All Support Users` / `Support & Escalate`) with its use cases and chips below, and
  `isLockedEdit` refuses all four boxes on every one of the five.
- Preview Workflow and Preview Agent both send `steps` and the workflow's playbook. Scenario 1
  answered "what else is close" by naming Randal Park, about 15 miles, with the wait-times link
  and no wait-time number. Scenario 2 answered the doc's own line almost verbatim: "I can't
  advise on symptoms, but I can get you in with someone who can", then asked about a primary
  care doctor, then referred with 407-303-5910 and the context attached. Scenario 3 flagged the
  registration for Randal Park. Scenario 4 replied "I'll connect you with our team now. It will
  be one moment." and asked nothing further. Scenario 5 handed to scheduling for Dr. Reyes
  without offering a time.
- One Ask AI instruction ("open with …, add a step that confirms which facility they checked
  into, rename Wants Care Sooner to Needs Care Tonight") produced edits to **both halves**: the
  greeting, `steps` grown from 6 to 7 with the new step at position 3, and the path title. The
  tree redrew, the chat's next request body carried 7 steps and the new opener, and the agent's
  reply confirmed the facility first. The **separate** Preview Agent tab opened with the edited
  line, proving the cross-tab read.
- Untouched and checked: the built-in `Orlando Health - SMS` page (6 nodes, minimap still drawn,
  Ask AI still offers "Change Orlando Health's workflow") and `Orlando Health - Voice` (12 nodes,
  "Build Orlando Health's voice agent"). `audit:voice` 107, `audit:place`, `audit:phases` green,
  typecheck clean. `audit:seeds` fails orlando-health on the same 14 of 34 checks as before the
  change, verified by stashing.
- ⚠️ Pre-existing and NOT from this work, confirmed by stashing everything and reloading: a
  console `useProfile must be used within ProfileProvider` on the workflow pages, and repeated
  400s from `/api/livekit-token` (the documented probe against a server with no LiveKit creds).
- ⚠️ Also noticed: **`.wf-canvas-wide` in `app.css` is dead** — declared for "a four-branch
  nurture tree loses a whole node off the right edge" and applied nowhere. Left alone rather
  than removed, since the horizontal-scroll behaviour it describes may still be wanted.

### A second SMS workflow for Avi & Co: "Avi & Co - New" (9/2/2026)
Asked for directly: *"add one more Avi & Co - SMS workflow called 'Avi & Co - New'"*. Built as a
**speed-to-lead** agent (chosen from four options offered, since a name gives no purpose): the
first reply to a brand new inbound lead, within seconds, while the interest is still live.

⚠️⚠️ **IT LIVES IN `reports.extraWorkflows`, NOT IN `agentWorkflows.ts`, AND THAT CHOICE IS THE
WHOLE ANSWER TO "can you add one".** There are two workflow stores and only one of them travels:

| | `agentWorkflows.ts` (Create Workflow) | `reports.extraWorkflows` |
|---|---|---|
| storage | **localStorage, per BROWSER** | the profile, so per DEMO |
| survives a colleague opening the demo | no | yes |
| starting content | the empty four-node tree | authored branches + its own playbook |
| Preview Agent | the prospect's configured agent | **its own `systemPrompt`** |

So clicking Create Workflow on this machine would have produced a workflow that existed only in
one browser session and never reached the person who asked for it. `extraWorkflows` is
schema-backed (`ExtraWorkflow`), lists in BOTH the Agent Studio table and the left sub-nav,
routes at `/agent-studio/agent/workflow/<slug>`, and its `systemPrompt` becomes
`buildSmsBrain`'s `customSystem`, which REPLACES the default sales flow — so Preview Agent runs
this workflow's playbook rather than the built-in one.

**What it contains**, all in Avi & Co's own vocabulary rather than generic sales copy: four
branches (Ready to Book -> Book Appointment, Comparing Options -> Answer & Nurture, Selling or
Trading -> Route to Trade Sales, Human Requested -> Warm Hand-off) with ten chips between them,
and a playbook that names the brands the profile actually carries (Rolex, Patek Philippe,
Audemars Piguet, Richard Mille, Diamonds By Avi & Co., the Iced and Hue Collections), the real
AMETA 0% financing offer, and the three boutiques. It asks brand -> buy/sell/trade -> ZIP ->
timeline, one question at a time, and offers a virtual consultation when the ZIP is not near a
boutique — which is the same three-city logic the voice workflow got the same day.
⚠️ **`openingMessage` keeps `{name}` AS A TOKEN**, resolved by `resolveGreeting` off the
prospect's own caller, so a demo shown against a different client still greets the right person.
Verified: it renders "Hi Marcus, this is Avi & Co…".
⚠️ Two rules the playbook carries for a reason: it never quotes an exact price (pre-owned pricing
moves with condition and paperwork, and the voice agent already defers pricing the same way), and
it never asks for payment details, account numbers or document images over text.

#### The dash sweep would have renamed it, and flattened its playbook
⚠️⚠️ **`sweepValue` REWROTE "Avi & Co - New" TO "Avi & Co, New".** The spaced-connector rule
(`([A-Za-z0-9)\]%])\s+-\s+([A-Za-z])` -> `"$1, $2"`) cannot tell a dash joining two clauses from
a dash separating the parts of a NAME. The proof it had already happened is in the schema:
`ExtraWorkflow.label` is commented `// "Reyes Law - SMS - Nurture"` and the stored value reads
**"Reyes Law, SMS, Nurture"**. The other two workflow names dodge it only because they are
derived at render from `customerName` and never stored.

⚠️⚠️ **AND `\s{2,}` COLLAPSES EVERY BLANK LINE, so a multi-line playbook comes out as one
run-on paragraph.** Reyes Law's stored `systemPrompt` shows exactly that damage — "intake team,
You are warm, empathetic, and professional, this is a law firm dealing with people who…" — a
bulleted persona list flattened into comma-joined prose, and its structure is not recoverable
from the swept copy.

`SKIP_KEY` now covers **`label`** and **`systemPrompt`**:
- a **label is a name**, and names legitimately carry dashes, which is why this file already
  keeps "Certified Pre-Owned" and "Trade-In and Consignment";
- a **`systemPrompt` is instructions to the model and is never shown to a prospect**, so the rule
  it was being held to does not apply — dashes matter here because they make COPY read as machine
  written.
⚠️ **`openingMessage` is deliberately NOT skipped**: the agent texts that to a real person, so it
is copy and the rule applies. Verified in both directions — the label and the prompt are now left
alone, while an em dash in an `aiSummary`, a `title` or an `openingMessage` is still swept, and
the seeds audit fails the same 14 of 25 demos as before.
⚠️ The migration is marker-guarded (`.dash-sweep-v1`) so nothing re-walked this demo, but
`npx tsx scripts/strip-dashes.ts` is manual and would have.

⚠️ **`updatedAt` WAS BUMPED BY HAND**, because writing the demo file directly is a server-side
write and `DemoLibraryContext`'s self-heal only refetches when the library's `updatedAt` is newer
than the copy the browser cached. Both boot migrations were bitten by exactly this; a write that
leaves the timestamp alone is invisible to every already-loaded tab.

⚠️ **THE WORKFLOW ITSELF IS NOT IN GIT.** It lives in `.data/demos/avi-co.json`, and `DATA_DIR`
is git-ignored by design. What this commit carries is the `SKIP_KEY` fix and this note. Getting
the workflow onto the live site is a PATCH to the server's own Avi & Co record, which is a
different record from the local one (the local demo's creator is `local@dev`).

#### ⚠️ CORRECTED SAME DAY: the four chrome boxes are locked here too
Reported after the first build: *"you forgot one rule, take a look at the voice tree, just like
the voice tree the 'Sales Inquiry, Need support, all sales inquiry users and All support users'
box are locked, those can't be change / edit. we can only do branches below that."*

Right, and the miss was reading this file's own SMS note, which carved out an exception for
`extraWorkflows` (now marked superseded above). `extraTree` drew each authored branch as its own
TOP-LEVEL intent node with a `${title} Users` leaf under it, so the new workflow rendered **four
intent nodes where the product always shows two**, and neither those nodes nor their leaves were
locked. It now builds the same locked chrome the voice tree does, with the authored branches as
the USE CASES below:

```
Triggered by                                   (authored: what fires this workflow)
Conversation Start                             (authored: the classify line)
Sales Inquiry            Need Support          LOCKED, icon cart / headset
All Sales Inquiry Users  All Support Users     LOCKED, Qualify / Support & Escalate
Ready to Book …          Human Requested       the use cases, editable
```

⚠️ **`WorkflowBranch` GAINED `intent: "sales" | "support"`** so an authored branch can say which
locked leaf it hangs under. Optional and defaulting to the sales side, so existing data parses;
Avi & Co's four are 3 sales + 1 support, Reyes Law's are 2 + 2.

⚠️ **`chromeLocked` IS DELIBERATELY NOT SET, and the two flags are not the same thing.** Per-node
`locked` refuses the four titles the user named (plus a locked leaf's ACTION, since
`LOCKED_KEYS` covers it); `chromeLocked` additionally freezes `triggeredBy` and `startLabel`. An
authored workflow's trigger line is real configuration — "New inbound lead, web form and missed
call" is what fires it, and the Agent Studio table renders that same field under its own
**Triggered By** column — and `editGuard`'s own note already sanctions this: "an authored extra
workflow that wants its own trigger line simply does not set it."

⚠️ **NO `route` ON A BRANCH, AND THAT WAS A REAL TRAP AVOIDED.** I first added one, mirroring
`TreePath.route`. But the renderer draws `Route to <route>` **INSTEAD OF** the action, so all
four authored actions ("Book Appointment", "Warm Hand-off") became data that is stored and never
drawn — the silent no-op this file records repeatedly. `TreePath.route` exists because the VOICE
agent names its destination aloud on transfer; an SMS agent books or hands off, so the action is
the meaningful line and a use case that does hand off says so in its action.

⚠️ **CONSEQUENCE, STATED: THIS RESTRUCTURED REYES LAW'S NURTURE TREE TOO.** Its four branches
now sit under the two locked leaves rather than being intent nodes themselves (Re-engaged and
Hesitant / Needs Info under Sales, Already Represented and Human Requested under Support). That
is not collateral from someone else's fix — it is the same product rule, and its old tree was
drawing chrome the product does not have.

⚠️ **A STALE BROWSER CACHE MADE THE LAYOUT LOOK BROKEN, and the numbers are worth keeping
because they diagnose it exactly.** Straight after the data edit the tree measured Sales Inquiry
at cx855 over use cases at 567/759/951 (centre 759) and Need Support at cx1335 over a use case at
1143 — parents not above their children. That is precisely what the OLD data renders: with no
`intent` on any branch, all four use cases go under Sales (4 columns) and the support leaf becomes
a fifth EMPTY terminal, putting Sales Inquiry at the midpoint of columns 0-3 and Need Support
alone at column 4. The layout was never wrong; `DemoLibraryContext` had not yet refetched. After
the refetch: sales leaf cx850 over 647/850/1052, support leaf cx1255 over 1255, both centred.
**A demo-record edit is invisible until the library refetches, which is why the `updatedAt` bump
matters.**

⚠️ **THE BUILT-IN SMS TREE'S LEAVES ARE STILL UNLOCKED, and that is left alone rather than
quietly changed.** `deriveTree`'s SMS branch locks the two intents but not the two leaves,
because its leaf ACTION is documented as per-prospect configuration (`Schedule ${bookingTerm}`).
The voice tree and now the extra tree lock both. Flagged for a decision rather than changed,
since that screen is signed off and the user's report was about a new workflow.

**`npm run audit:ai` gained 7 checks**, and they BUILD a tree and call the real `isLockedEdit`
rather than grepping for a flag: the two chrome intents are drawn, both chrome leaves are, at
least four nodes are marked locked, the leaves carry the two default actions, no authored branch
is mapped onto a leaf again, all four boxes plus both leaf actions are REFUSED, and the use cases
below stay editable (title, action, chips, and adding or removing one). Verified to fire by
unlocking one leaf and by restoring the old branch mapping.
⚠️ Its lock probe was wrong once — `isStructuralChange(before, after, path)` was called with the
tree as `before` and a path string as `after`, so "adding a use case" reported as refused when it
is allowed. **Fourth probe-not-code fault this session.**

**Verified end to end:** the Agent Studio table lists three workflows with "Avi & Co - New" as
Live / SMS / "New inbound lead, web form and missed call" under the **Triggered By** column (that
column takes prose, which is what Reyes Law's "No-response follow-up" already does); the sub-nav
lists it third and highlights it; the tree draws 10 nodes and all 10 chips with the Warm Hand-off
leaf in orange; and its Preview Agent runs the new playbook — asked for a Daytona it went brand
-> buy/sell -> ZIP, and answered 90210 with a virtual consultation. Untouched: "Avi & Co - SMS"
(6 nodes, 2 chips, its own Financing Question / Trade branches), "Avi & Co - Voice" (12 nodes, 15
chips, the showroom logic intact), the built-in SMS brain (no `customSystem`, its own opener) and
Reyes Law's single nurture workflow. `audit:voice` (62) and `audit:ai` green.

### Multiple service locations: "offer the nearest showroom" (9/2/2026)
Reported against Avi & Co: *"I asked the AI in the UI 'Avi and Co only has 3 showroom locations,
Miami, New York and Aspen. So when asking a Caller for their Zipcode, if they are outside of
those cities zipcode. Tell them which showroom location is the closest and if thats ok'. I think
the tree changed so the actual voice agent during the call didnt change."*

⚠️⚠️ **THE EDIT HAD LANDED PERFECTLY. THREE THINGS BETWEEN THE STORED CONFIG AND THE PROMPT
UNDID IT** — and the reported symptom ("the call didn't change") pointed at the plumbing that
was, in fact, the one part working. The stored override held `serviceZips: ["33101","10001",
"81611"]`, a nearest-showroom `outOfAreaScript`, and two `informSteps` naming all three cities.
`editGuard` refused nothing.

**1. A `typeof r === "string"` FILTER SILENTLY ATE THE MODEL'S STEPS.** It wrote them as
OBJECTS — `{step, action, description}` — a reasonable shape, and its two steps described the
requested behaviour exactly. `specWithConfig` filtered both out for not being strings, leaving
`informSteps: []`.
⚠️ **`editGuard` CANNOT CATCH THIS**: `agent.informSteps` is a LENGTH_IS_CONTENT path and
array -> array is not a type flip, so the write is legitimately allowed. The shape has to be
accepted where it is read. `toSteps()` now normalises objects into the `string[]` the prompt
needs and falls back to the base when nothing survives, because returning `[]` is what turned
"the agent stopped asking for a name" into a silent regression before.

**2. THE EMPTIED LIST THEN READ AS "UNTOUCHED", so the stock refusal was regenerated.** The
`stepsUntouched` guard compares `merged.informSteps` against `spec.informSteps` — and the
derived spec's steps are ALSO `[]`, so an edit that had been destroyed one line earlier
compared equal to no edit at all and `stepsForZips` overwrote it. Two failures compounding, each
individually plausible.

**3. `stepsForZips` REFUSED IN STEP 3 AND OFFERED THE SCRIPT IN STEP 5.** It hardcoded "politely
inform the caller that we do not serve their area and end the call without routing" and then
appended the out-of-area script. Those agree when the script turns the caller away and flatly
contradict each other when it offers an alternative — **with the refusal first**, which is the
one the agent obeyed. The script is now the ONLY statement of the policy; what survives from the
old step 3 is the safety property ("never route a caller somewhere they have not agreed to"),
which holds either way and needs no guess about what the script says. A self-contradicting
prompt is worse than either rule, which this file already records for the SMS playbook leaking
into the voice prompt.
⚠️ **The same hardcoded refusal existed a second time in `engine/chat.ts`**, in the
`zips.length` branch ("say exactly this and then END the call, asking nothing further and routing
nobody"). Fixed identically. Safe to change: **every prospect on disk that has `serviceZips`
also has `informSteps`**, so that branch was unreachable for all of them — only an AI-added
allow-list reaches it, which is precisely this bug.

⚠️ **A BRACKETED PLACEHOLDER GETS READ ALOUD ON A LIVE CALL.** The script the model wrote
contained the literal token `[CLOSEST_LOCATION]`, expecting something downstream to fill it in.
Nothing does. Rather than sniff for one vocabulary of placeholder names, any `[ALL_CAPS]` token
left in the flow now earns ONE instruction telling the agent to resolve it and never speak the
bracket — and `engine/assistant.ts` asks for none to be written in the first place. Same
instruct-then-enforce pairing as the dashes and rule 2.

⚠️ **AN ALLOW-LIST HAS TO REACH THE PROMPT EVEN WHEN THE SE'S STEPS WIN.** With steps present
the ZIP list vanished entirely, so the agent knew the policy and not the ZIPs it applies to —
the lands-and-does-nothing shape one level over. The list now goes in as **data**
("Service-area ZIP codes: …") and the steps stay the only **policy**, so the two cannot
contradict; suppressed when the steps already recite the ZIPs, as `stepsForZips` output does.

⚠️ **AND THE ASSISTANT'S OWN FIELD DESCRIPTION WAS REFUSAL-ONLY.** `engine/assistant.ts` said an
allow-list means the agent "reads `agent.outOfAreaScript` to everyone else **and does not route
them**", full stop — so a request to offer the nearest of several locations was fighting the
prompt's own definition of the field, which is why the model reached for a shape of its own. It
now says the script decides what happens next, and asks for the served locations to be NAMED in
the steps so the agent can tell a caller which is closest.

**Measured on the real endpoint afterwards** (`scripts/demo-voice-sim.ts avi-co`):

| caller ZIP | agent |
|---|---|
| **33139** (Miami Beach, NOT on the 3-ZIP list) | "That's in the Miami area, so I can connect you with our Miami showroom. Does that work for you?" |
| **80202** (Denver) | "Our closest location to you is in Aspen, Colorado. Would that work for you to visit, or would you prefer one of our other showrooms in Miami or New York?" |
| **98101** (Seattle), then "no thanks, thats too far" | offers a showroom, then "we're currently only in Miami, New York, and Aspen, so unfortunately we wouldn't be a good fit for you right now" — closes politely instead of hanging up mid-qualification |

⚠️ **THE THREE ZIPS BEING ONE-PER-CITY TURNED OUT NOT TO MATTER, for a reason worth knowing.**
33101 is a single Miami ZIP, so a literal allow-list would refuse Miami Beach. Because the steps
name the CITIES, the agent does the geography instead — 33139 is recognised as Miami. That is
better than a longer allow-list would be, and it is why the fix is "name the locations" rather
than "enumerate more ZIPs".
⚠️ **Its geography is the model's own and is occasionally wrong**: Seattle was offered New York
"which serves the broader northeast area" when Aspen is far closer. Harmless for a demo whose
callers are in the served metros, and not something more prompt text reliably fixes.

**`scripts/demo-voice-sim.ts` is new, and it exists because neither existing harness could see
this.** `voice-sim.mts` and `askai-voice.ts` both read `src/data/generated/<slug>.json`, so
neither can reach a prospect that lives only in the shared demo LIBRARY — which is most real
ones, and every one an SE has actually tuned with Ask AI. It rebuilds the brain exactly as
`useBrain` does, from the demo record's own override layer, and talks to the real `/api/chat`;
`--prompt` prints the built prompt instead.

**`npm run audit:voice` is 62 checks** (was 49). The twelve new ones cover: object-shaped steps
normalising rather than dropping, a normalise-to-nothing falling back to the base, a non-array
keeping the base, `stepsForZips` carrying no hardcoded refusal beside the script, the script
being what states the policy, an unresolved placeholder earning the resolve-it instruction, no
such line when there is no placeholder, the ZIP list reaching the prompt alongside the SE's own
steps, not being repeated when the steps recite it, the allow-list branch not doubling up on the
steps, and the end-to-end regression (object steps + allow-list produce a prompt that names the
locations and does NOT tell the agent to hang up).
⚠️ **Each was verified to FIRE by restoring the original bug** — the string filter, the
hardcoded refusal, and the dropped placeholder rule each turn one red.
⚠️ **TWO OF THE NEW CHECKS WERE WRONG FIRST, AND FIXING THEM DOCUMENTED A BRANCH.** They asserted
the placeholder rule fires on a prompt built with `voiceSteps` — but when the SE's steps win the
script is never emitted at all, so there is no bracket in the prompt to guard. The guard is for
the allow-list branch, which quotes the script verbatim. Third time in this file a probe rather
than a check was at fault.

⚠️ **NO DATA MIGRATION, AND THAT IS DELIBERATE.** All of this is fixed at READ time, so the
stored override — object-shaped steps, `[CLOSEST_LOCATION]` and all — starts working as soon as
this deploys, on the live demo and on every other demo already carrying an edit like it. Nothing
had to be re-issued through the drawer.

**Untouched, verified:** Comfort Keepers, the one configured spec with BOTH an allow-list and
steps, is byte-identical — its own hand-authored six steps still recite 30097 / 30096 / 30095,
its refusal script is still quoted verbatim, it gains no duplicate ZIP line and no placeholder
rule. It never goes through `stepsForZips`. `audit:ai` green, and `audit:seeds` fails the same 14
of 25 demos before and after (checked with the changes stashed — pre-existing profile-data
failures, not this work).

### The (Voice AI) story: routing demo + screenpop from the call just had (8/27/2026)
The demo beat, in the user's words: "the Caller calls in, then voice agent picks up and has the
conversation, the Voice Routing Demo shows how we took that conversation, pulled out all the
signals and routed them to the correct department, then the Voice Screenpop shows what the agent
in the call center gets when that call got routed to him."

Two new My Reports rows — **Voice Routing Demo (Voice AI)** and **Voice Screenpop (Voice AI)** —
render the SAME two artifact templates from the call the SE just had. `src/data/voiceAiArtifacts.ts`
derives both slices; the seeded pair is untouched (verified: still St. Regis, no live transcript).

⚠️⚠️ **GATED ON A REAL TRANSFER, AND IT FAILS CLOSED.** The rows exist only when `/api/analyze`
returned `transferred: true` AND a department. Out of area, hung up, or a failed analysis
produces NOTHING. These artifacts NAME A DEPARTMENT on screen, and one pointing at a queue
nobody was sent to is the single thing on them a prospect would check.
Verified in both directions: an out-of-area Orlando Health call and a caller who hangs up
mid-qualification both yield no rows; flipping `transferred` in storage removes them live.

⚠️⚠️ **`routedTo` IS A CLASSIFICATION AGAINST THE WORKFLOW'S OWN DESTINATIONS, NOT AN EXTRACTION
— and the first build got this wrong in a way that rendered.** Asked to copy the department "as
the agent said it", a Marriott cancellation came back as **"our support team"**, because that is
what the agent says out loud (the naming rule deliberately keeps it speakable). The routing demo
then drew a FOURTH queue with that name beside the real "Guest Support, Existing Reservation".
`AnalyzeInput.destinations` now carries the workflow's own team list and the model picks ONE;
`matchDestination()` then drops anything off-list to `""`, so a stray answer produces no
artifacts rather than a wrong department. Instruct-then-enforce, as everywhere else here.

⚠️⚠️ **THERE ARE TWO VOICE ENGINES, AND THE FIRST BUILD ONLY PATCHED ONE.** `VoiceCall`
(browser speech) and `VoiceCallLive` (LiveKit) each carried their own copy of "capture the call,
then POST /api/analyze". The destinations and the `outcome` patch went into the OLD engine only
— so a real LiveKit call, which is what every configured environment actually runs, captured
perfectly, stored no outcome, and the two rows silently never appeared. Reported as: "I had the
conversation, it transferred me, and it wasn't there."

**The duplication survived because both copies worked** for the thing they were written for; it
only broke when one gained a feature. `captureVoiceCall` in `VoiceCall.tsx` is now the single
path and `VoiceCallLive` calls it. `audit:voice` checks this STRUCTURALLY rather than by
feature — exactly ONE `/api/analyze` fetch may exist across the two files, and both must call
the shared helper — because the next divergence will be a different field.

⚠️ **NOT A REGEX OVER THE AGENT'S LAST LINE.** The obvious gate is looking for "transferring
you". This repo has been bitten twice reading model prose that way — the Salesforce appointment
slot, and the Comfort Keepers simulator false-failing 5 runs in 6 on a curly apostrophe. It
rides along on the `/api/analyze` call that ALREADY runs when a call ends, so it costs nothing.

⚠️ **`VoiceConversation.outcome` IS APP-WRITTEN AND OMITTED FROM GENERATION.** `toSchema()`'s
`sanitize()` marks every property required, so an `.optional()` field in a generated type is
FORCED onto the model — it would fabricate a routing decision on a seeded conversation and the
two artifacts would render it as if a call had happened. Same class as `InteractionRow.cells`.
`VOICE_CI_GEN` omits it, and the audit checks BOTH the omit and that no profile on disk carries
a generated `outcome`.

⚠️⚠️ **THE PRE-CALL STORY IS RE-SKINNED TO THE CALL'S LOCATION, and the first build got this
badly wrong.** The rule was "keep whatever the call could not establish" — right for an email or
a cart id, and WRONG for anything naming a place. A caller who said **New York** was shown, on
the same two screens as the transcript: `Marketing Search Term(s): luxury hotels Las Vegas
weekend`, `Calling Page: St. Regis Las Vegas`, `Pages Viewed: W Hotels Las Vegas`,
`Location: Las Vegas, NV`, `Campaign: Luxury Resort Getaway, Las Vegas Acquisition`,
`Google Search: Ritz-Carlton Las Vegas`, a **702** area code, and an email belonging to a
different person entirely (`j.martinez.702@email.com` beside a caller named Challer Bing).
Reported as: "I want a consistent story so no one says wait a sec, this metric and these
attributions don't match."

**The digital journey is fiction we control**, so it costs nothing to make it agree — and a
prospect reading the search term against the transcript is exactly who this demo is for. The
seeded city is now substituted throughout both artifacts: attribution, visitor history, campaign,
searches, calling page, products, journey, city/state/zip and the area code.

⚠️ **STATE, ZIP AND AREA CODE MOVE WITH THE CITY OR THEY CONTRADICT IT.** Substituting only the
city left "City: New York / State: NV / Zip: 89121" — the same mismatch one row further down.
`CITY_PLACE` carries state + zip + area code for 24 cities; an UNKNOWN city leaves the address
block alone rather than half-rewriting it, because a city with someone else's state is worse than
a seeded address the call never claimed to know.
⚠️ **THE 555 EXCHANGE SURVIVES THE AREA-CODE SWAP** — reserved so a demo number cannot ring a
real business, the same care the Google Search ad's call extension takes.
⚠️ A first `swapAreaCode` matched the prefix with `\D*`, which greedily ate the opening "(" and
then wrote another, producing **"+1 ((212) 555-0847"**. Anchor on the 555 exchange and CAPTURE
the parentheses. Tested against five real formats.
⚠️ **The email is derived from whoever called** (`challer.bing@gmail.com`); a call that got no
name keeps the seeded address rather than inventing one.
⚠️⚠️ **A ZIP IS A LOCATION TOO, AND FOR A SERVICEABLE-ADDRESS PROSPECT IT *IS* THE CALLER'S
ADDRESS.** Asked for directly: "in this use case its just the calls address that doesn't matter
when booking a hotel, but for another prospect if its for a serviceable address and on the call
they give a zipcode for example 30097, then i do want you to go change the pre call intelligence
to match the address with zipcode." A hotel caller's own address is irrelevant — the DESTINATION
is what matters; a plumber's or a carer's is the whole job. `resolvePlace()` therefore takes
either a city name or a 5-digit ZIP and returns one place. Verified: Comfort Keepers + "30097"
gives **Duluth, GA 30097** with a **770** area code, and Marriott + "New York" gives New York, NY
10019 with 212.

⚠️ **`ZIP_PLACE` HOLDS REAL ZIP-TO-CITY PAIRS ONLY, and a ZIP3 prefix guess was rejected.**
Deriving a city from the first three digits would print "Atlanta, GA 30097" when USPS assigns
30097 to Duluth — and the prospect who knows their own service area is exactly the person
reading it. An UNRESOLVED ZIP leaves the address block ALONE (verified with 12345): a city
carrying someone else's state is worse than a seeded address the call never claimed to know.

⚠️ **THE STREET MOVES WITH THE ADDRESS, AND BECOMES PLACE-NEUTRAL.** "4521 Desert Palm Drive"
reads as Las Vegas wherever it is printed, so once the city becomes Duluth it is the last field
still telling the old story. Fabricating a real local street is inventing; keeping the house
NUMBER and choosing a name that evokes nowhere ("4218 Maple Avenue") is not. Deterministic on
the ZIP, so a rehearsal renders the same address twice. This replaces the note below, which
raised the street as an open question.

⚠️ **SUPERSEDED — `street` was flagged here as still seeded.** "4521 Desert Palm Drive" reads as Las Vegas in a New
York address block. It is the one field left that carries a place flavour, and inventing a
Manhattan street is inventing — raised with the user rather than decided here.

**The audit asserts this over the WHOLE serialised pair**, not field by field, so a field added
later is covered: no artifact may still name the seeded city once the caller named another.

⚠️ **THE AI VOICE AGENT PANEL COMES FROM THE CALL; THE CRM FIELDS DO NOT** — and the distinction
is not pedantry. Agreed that email, street, cart id, digital journey and estimated value stay as
the prospect's own (blanking them undersells the pre-call-intelligence pitch). But keeping the
seeded `coverage` left a support caller who never gave a location reading "ZIP 89121 confirmed,
Las Vegas serviceable" **on a panel headed by the AI agent's name** — crediting the agent with a
check it never ran. An address is a fact a CRM legitimately holds; a verification is an EVENT.
No location now reads "Service area not checked on this call".

⚠️ **Signals are attached to turns by the `InsightsCallDetail` "Found Phrases" technique** —
signal name to its words of 5+ characters to the first turn containing one — not a second model
call, so a rehearsal renders identically twice. An unmatched signal lands on the LAST turn
rather than being dropped, because the artifact prints a signal COUNT and losing detections
would make it disagree with the CI report built from the same call.

⚠️ **THE CONFIDENCE RAMP IS THE ONE MODELLED THING, and it is bounded by two real facts:** it
starts near even and ENDS on the department the agent actually named. No transcript carries a
per-turn probability, and asking a model for one would score the same call differently on each
replay.

⚠️ **NEWEST CALL ONLY** — one pair of rows, not a pair per practice run.

⚠️ **A CHECK THAT CANNOT FAIL IS NOT A CHECK, and one here proved it.** The dedup check used
"Group Sales", which is a use-case DESTINATION and not one of Marriott's seeded queues — so the
branch that could duplicate was never entered, and the check stayed green against deliberately
broken code. Rewritten against a seeded queue, it fails loudly and prints the duplicate.

**`scripts/voice-story.ts`** drives the whole beat from the terminal: the call through
`/api/chat`, the transcript through `/api/analyze`, then both artifacts built exactly as My
Reports builds them, printing the department three times over so a mismatch is obvious.

### What Create Workflow BUILDS: an empty workflow (measured 8/27/2026)
The open question at the end of the modal section is closed, by the user and by a capture taken
straight after creating one (`/networks/2751/ai_agents/edit/169/workflow/550`, kept at
`reference/agent-workflow/create-workflow-built.html`). In their words: **"an empty template
with just the starting tree without anything."**

`src/data/agentWorkflows.ts` stores them per prospect; `emptyWorkflowTree()` in
`src/data/workflowChrome.ts` is the tree; `/agent-studio/agent/workflow/new/:id` renders it.

| node | measured |
|---|---|
| Triggered by | **"0 Campaigns, 0 Forms, and 0 Inbound SMS"**, 248 x 90 |
| Conversation Start | `<channel> · classify intent`, 248 x 66, ground `#D4E0FE` |
| Sales Inquiry / Need Support | title ONLY — **no caller-intent subtitle**, 248 x 46 |
| All Sales Inquiry / Support Users | title + **"+ Add action"** (`400 16/20` `#2666F9`, no icon), 248 x 72, **no pills** |
| the new sub-nav row | channel icon, the typed name, **MUI warning `#FF7045` 20px**, kebab, **no status pill** |
| header | the workflow NAME alone (20/28), then **✓ Saved** (`#2CBF58`) · **Undo disabled** · Preview Workflow |

The canvas is React Flow at scale 0.78125, so its 193.75px nodes are the **248px** our voice
tree already draws — the geometry needed no change, only the contents.

⚠️⚠️ **THE WARNING TRIANGLE MEANS "NOTHING CONFIGURED", AND TWO CAPTURES PROVE IT** — 1
occurrence on the new row, **0** on the configured workflow in the same account. Same trick
settled two more things in one grep: the disabled **Undo** is on BOTH captures (permanent
workflow-page chrome), while **Saved** is only on the new one (a transient state from the
create that just happened) — and `Go Live` is disabled in BOTH, so its greyness is that
agent's own state and **ours was correctly left alone**. A comparison stopped a change that
looked obviously right.

⚠️⚠️ **A NODE IS TINTED BY ITS ACTION, so an empty leaf is WHITE.** The two captures give the
whole system: a configured leaf takes its action's hue at 8% with a matching 1px border and a
**5px LEFT edge** — Qualify **lilac `#D0C1F2`**, Inform & Route **teal `#33E5C9`**, Support &
Escalate **orange `#FF7045`** — and an empty leaf is white with 1px `#E7E9EB` and a GREY 5px
left edge. With no action there is no hue, so the first build's green/orange tints were
colouring a route nobody had configured. **Our configured tree's own green/orange and its
missing 5px edge come from an older capture of a different page and are deliberately
untouched** — raised with the user rather than rewritten here.

⚠️⚠️ **THE STALE-STORE BUG, AND ITS SYMPTOM POINTED NOWHERE NEAR ITS CAUSE.** `AgentStudioLayout`
and `AgentWorkflow` each call `useAgentWorkflows`, so there are TWO instances of that state.
Create wrote localStorage and updated the LAYOUT's copy; the page was already mounted, its copy
stayed stale, `byId` found nothing, and the created-workflow branch fell through to the SMS
default — so creating a **Voice** workflow rendered a complete **"Agent Workflow: Marriott -
SMS"** while the URL, the store and the highlighted row were all correct. **The `storage` event
is deliberately not delivered to the tab that wrote it**, so the cross-tab listener could never
have covered this. Writes now notify every mounted hook directly and the listener stays for
other tabs. Same shape as the two-voice-engines bug: two copies of one thing, working
separately until one had to hear about a change.

⚠️⚠️ **THE ROUTE FAILS CLOSED, NOT JUST THE ROW.** With an `:id` this prospect has no workflow
for, `created` is undefined, `channel` is undefined too, and `isSms` defaults TRUE: measured,
opening Marriott's created workflow while AutoNation was active rendered a full, plausible
**"Agent Workflow: AutoNation - SMS"**. That is exactly what the AI-Conversion dashboard's note
warns about ("gating only the row leaves a bookmarked URL rendering a full dashboard for
whichever prospect is active"). It renders "Workflow not found" instead.

✅ **SUPERSEDED — Preview Workflow is ENABLED again, as measured.** It was disabled here
because a preview would have run the prospect's configured agent; it now previews THIS
workflow (greet, classify, announce, transfer). See the section above.

⚠️ **A CREATED WORKFLOW REGISTERS NO `agent` HALF.** The agent config is the prospect's
configured voice agent (greeting, rules, ZIP allow-list); attaching it here would let an SE
edit the live agent's greeting from a workflow with no actions, and the Ask AI drawer would
promise "Build this voice agent" on a page whose whole state is that nothing is built. It gets
the tree only, so the drawer offers "Change this workflow" — and the scope key carries the id,
so each created workflow has its own edits and undo stack.

⚠️ **THE TITLE IS THE WORKFLOW NAME ALONE**, per the capture's h2; the two built-in pages keep
their "Agent Workflow: " prefix because dropping it there would change screens nobody asked
about. Same reasoning for not adding the (permanent, measured) `Undo` to those pages. Both
flagged for the user.

⚠️ **`ZERO_TRIGGER` WAS `SMS_TRIGGER`, AND IT IS NOT SMS-SPECIFIC.** Both captures carry that
line on a VOICE workflow — the configured one as "**1 Campaign**, 0 Forms, and 0 Inbound SMS",
singular at one. A second constant was written for the empty tree before this was noticed, with
a byte-identical value; **one field copying another is the common cause of three separate silent
bugs in this file**, so there is one constant and both callers use it. The configured voice
tree still reads "2 campaigns and 0 forms" from an older capture and is left alone.

⚠️ **THE CHROME CONSTANTS AND THE EMPTY TREE MOVED TO `src/data/workflowChrome.ts` SO NODE CAN
IMPORT THEM.** `AgentWorkflow.tsx` reaches `profiles.ts` and its `import.meta.glob`, a
Vite-only builtin, so the audit could not import anything from that screen and its checks had
to grep source. Now the empty tree is BUILT and READ by the audit. That distinction has already
mattered twice here: a grep passed against `if (false && CHROME_KEYS.has(path))`, and another
matched a conversation RULE rather than the imperative it was written for. Values unchanged.

⚠️ **`TreeLeaf.addAction` IS OPT-IN, defaulted off**, like `actionIcon` and `warn` — every
existing diagram is byte-identical. ⚠️ And `.wf-leaf-add` is written **`.wf-leaf .wf-leaf-add`
(0,2,0)**: as a bare class it TIES with `.wf-leaf-action` and loses on source order, so the
affordance rendered `rgb(52,58,64)` while the rule plainly said blue — the same tie
`.ts-tablewrap .ts-table` exists to win.

**`npm run audit:ai` gained 7 checks, and they BUILD the tree rather than grepping for it:**
four chrome nodes and nothing else · leaves offer "+ Add action" with no action text and no
pills · leaves untinted · intents carry no subtitle · the all-zero trigger wording · the chrome
locked AND `isLockedEdit` refusing a rename · the not-found guard present. **Each was verified
to FIRE on its own broken shape** (a third branch, pills, a tint, a subtitle, reworded trigger,
`chromeLocked` dropped, guard removed) and to go green again.

Verified end to end with real clicks and typing: Create stores the workflow, the row appears
with its warning triangle and no status pill, the page renders the 6-node tree with 2 blue
affordances / 0 pills / white leaves, `Saved` shows, `Undo` and `Preview Workflow` are disabled.
Per prospect: AutoNation shows only its two rows and Marriott's workflow does not leak, and
pasting its id there renders "Workflow not found". Untouched: the Voice page (11 nodes, 13
chips, "2 campaigns and 0 forms", enabled preview, no Saved/Undo), the SMS page (6 nodes, 2
chips, Preview Agent present) and `/dashboards/marketing` (17 cards, 4px, 5 donuts, zero `wf-`
leakage). `audit:voice` (38) and `audit:phases` (4) green.

✅ **RESOLVED — a created workflow DOES appear in the Agent Studio list now, and can be
deleted.** See the section above; the cells are derived rather than invented.

### Previewing an empty workflow, and listing + deleting one (8/27/2026)
Two follow-ups to what Create builds, both asked for directly.

**1. Preview Workflow on an empty tree.** In the user's words: "introduce yourself, and thank
them for calling the prospect, and ask them how can you help them today; based on what they say,
make a decision to transfer them to the sales team or the support team, and let them know that,
and transfer them." `ChatBrain.voiceMinimal` selects that flow in `buildSystem`;
`emptyWorkflowGreeting()` is the opening line.

⚠️⚠️ **THIS REMOVED THE ONE MEASURED VALUE THE PREVIOUS COMMIT DID NOT REPRODUCE.** Preview
Workflow was disabled on a created workflow because a preview would have run the prospect's
CONFIGURED agent — ZIP gate, travel dates, six use cases — against a diagram showing none of
it. The requested behaviour IS the four chrome nodes (Conversation Start classifies intent; the
two user groups are the destinations), so the button is enabled again, as the capture shows, and
the preview is honest.

⚠️ **IT REPLACES THE PATH MACHINERY RATHER THAN TRIMMING IT.** Routing the empty tree through
`treeToVoicePaths` + the configured flow emitted "Ask what they need, in their own words" ON TOP
of the opening question — a second question this flow must not ask — and named the destination
"the team that handles Sales Inquiry", which is a screen label rather than something to say
aloud. Reading the BUILT prompt is what showed both.

⚠️ **THE DESTINATIONS ARE GENERIC ON PURPOSE.** "the sales team" / "the support team" are what
was asked for and also the honest names: an empty workflow has no configured queue, so naming
the prospect's real desks would credit it with routing nobody has set up.

⚠️ **BOTH CHANNELS, because the modal defaults to SMS.** An empty SMS workflow's Preview
Workflow opens the CHAT drawer, which builds `buildSmsBrain` — the prospect's configured SMS
agent, with its playbook, questions and offer. Same lie in a different drawer. `voiceMinimal`
therefore also selects a minimal SMS flow (it hands the conversation over rather than
transferring a call, and keeps `SMS_FORMAT_RULES`), and `WorkflowChatPreview` takes a `minimal`
prop that drops `openingMessage`, `customSystem` and `playbook`.

⚠️⚠️ **`useBrain` HARDCODED THE VOICE PAGE'S SCOPE KEY**, so a call started from a created
workflow would have read the CONFIGURED tree and previewed a diagram the SE was not looking at
— the same wrong-surface bug as reading the profile instead of the page, one level up. It takes
`BrainOpts { scopePath, minimal }` now, threaded through both engines as an optional prop
defaulted to absent.

⚠️ **A MINIMAL PREVIEW MUST NOT INHERIT THE CONFIGURED FIELDS.** `serviceZips`,
`outOfAreaScript`, `voiceQualify`, `voiceRules` and `voiceSteps` are dropped at the source
rather than merely flagged — leaving them would put a service-area gate in a prompt whose whole
point is that nothing is configured, which is the self-contradicting prompt this file records
once already.

⚠️ **"EXACTLY ONE OF THESE" GOT READ AS THE WHOLE UTTERANCE.** The agent replied just
"Transferring you to the sales team now." to a caller who had explained what they wanted, which
is abrupt on a demo call. Step 4 asks for the acknowledgement FIRST and names the scripted line
as the ENDING. Heard, not assumed.

**Measured on the real endpoint** (`scripts/empty-workflow-sim.mts`, the sibling of
`voice-sim.mts`):

| caller | agent |
|---|---|
| "looking to book a room in new york for next weekend" | "Great, I can help you with that. **Transferring you to the sales team now.**" |
| "there's a charge on my card i don't recognise" | "I understand, that sounds frustrating… **Transferring you to the support team now.**" |
| "hi" → "a question about a stay" → "one i already booked" | one clarifying question, then **support** |
| SMS: "change the dates on a booking i already have" | "Got it… **I'm handing you over to the support team now.**" |

**2. The created workflow shows in the Agent Studio LIST, and can be deleted.** This was the
open item at the end of the previous section. Every cell is DERIVED rather than invented: the
channel is what the modal collected, the date is its own `createdAt`, **"0 Campaigns"** is the
wording its own trigger node carries, and "Went Live On" is the same "-" the agent row already
uses for never — because it never has. The one word not read off a capture of that table is the
status, and **"Draft"** is the product's own (the editor header shows it for this agent).

⚠️ **`.as-status-draft` ALREADY EXISTED IN app.css, and a duplicate went in.** A created
workflow must not wear the live pill's green, so a draft pill was written — and the older copy
further down the file won on source order, so the new value never applied and the pill rendered
`#ECEFF2` instead of `#E7E9EB`. Harmless only because the older rule is the right one.
**Grep for a class name before writing it**, the lesson `.fbb-page` already records.

⚠️ **ONE `WorkflowRowMenu`, TWO PLACEMENTS** — the list table and the editor's left sub-nav.
Two copies would drift on the first fix and the symptom would be delete working in one place and
not the other.
⚠️ **CREATED ROWS ONLY.** The Voice and SMS rows are DERIVED from the prospect, so deleting one
would either no-op or appear to work and come back on the next render. They keep the inert kebab
the capture shows.
⚠️ **IT CONFIRMS, AND NAMES THE WORKFLOW.** Delete is the one irreversible thing here and in the
sub-nav the kebab sits INSIDE the row's `<Link>`, one stray click from the row itself — so every
handler calls `preventDefault` + `stopPropagation`, or opening the menu navigates.
⚠️ **DELETING THE ONE YOU ARE LOOKING AT navigates to the Voice workflow**, or you land on the
not-found state, which reads as the delete having broken something.

**`npm run audit:voice` is 49 checks** (was 38). Nine are new and BUILD both prompts: the
greeting thanks them / introduces itself / asks how it can help · both destinations named · both
transfer lines scripted · no service-area gate reaches it · none of the path machinery reaches it
· the ask-nothing cap still applies · the SMS preview hands off to the same two teams and keeps
its format rules · and **without the flag the configured path flow is unchanged**, so one created
workflow cannot flatten every prospect's agent.
⚠️ **TWO OF THEM WERE TAUTOLOGIES AND BREAKING THEM ON PURPOSE IS WHAT FOUND IT.** One asserted
`prompt.includes(emptyWorkflowGreeting(...))` — both sides from the same function, so rewording
the greeting to "Please hold." changed the expectation with it and the check stayed green. The
other looked fine and my PROBE was wrong: it replaced the first occurrence of the transfer line,
which is in a COMMENT. Re-probed against the real line, it fires.
⚠️ The gate check matches **`SERVICE-AREA CHECK` / `ask for their ZIP code`, not the word "ZIP"**
— which appears in this prompt's own prohibitions, so a bare match would fail on a correct
prompt. Same trap as the earlier `/zip code/i` matching a conversation rule.

Verified with real clicks and typing: Create → the row appears with its warning triangle → the
page renders the 6-node tree → Preview Workflow opens and behaves as above → the list row reads
Draft / Voice / Network / 0 Campaigns / its own date / "-" with a working kebab → Delete confirms,
names the workflow, Cancel is a no-op, Delete removes it from both the list and the sub-nav, and
deleting the open one lands on the Voice workflow. **The configured previews are untouched**: the
voice sim still gates and collects Travel Dates, and the built-in SMS chat still opens with
Marriott's own "AI booking assistant … 9,000+ properties … Bonvoy member rates".

### Create Workflow: the name + channel modal (measured 8/27/2026)
`src/components/CreateWorkflowModal.tsx` (`.cwm-`), opened by **Create Workflow** in
`AgentStudioLayout`'s left sub-nav. From a SingleFile capture saved with the modal OPEN
(network 2751, `/ai_agents/edit/169/workflow/186`), kept at
`reference/agent-workflow/create-workflow-modal.html` — Invoca's own MUI dialog, so it
serialises in full and every value is a computed style, not a screenshot reading.

| | measured |
|---|---|
| paper | **500 x 422**, radius 3, MUI elevation-24 shadow; `52 title + 310 content + 60 actions` |
| title | "Create Workflow" 400 20/28 `#15243E`, inset 12, **no bottom rule** |
| content | `flex: 1 1 auto; overflow-y: auto`, padding `0 13.6px`; inner wrapper `16px 0` |
| lede | 400 16/20, wraps to two lines (40 tall) at dy 69 |
| field | dy **133** (h **74**) and **231** (h **76**); label box **32 tall with `margin-top: 7px`** |
| inputs | name 472.8 x **35** radius 3 · channel 472.8 x **37** radius **4** |
| actions | band 60 at dy 362, **no top rule**; buttons 36 tall, 16 apart, Create 12 from the edge |
| Cancel / Create | outlined `1px rgba(38,102,249,.5)` ink `#2666F9` · **disabled** `#E7E9EB` on `#A1A7B2` |

⚠️ **THE PAPER HEIGHT IS AUTHORED `422px`, NOT CONTENT-DRIVEN.** The first build came out
**66px short** (356) because it let the content size the paper; there are ~40px of slack under
the last field. `height: 422px` + `flex-direction: column` on the paper with `flex: 1 1 auto`
on the content reproduces every offset.

⚠️⚠️ **`display: flex` ON `.cwm-field` IS LOAD-BEARING, and its absence was the second
defect.** As a plain block, the field's own `margin-top: 24px` and the label's `margin-top: 7px`
**COLLAPSE into one 24** — so the label sat flush at the field's top, each FormControl measured
**67 against 74**, and the second field was dragged 8px up with it. A flex container establishes
its own formatting context, so the child margin is no longer adjacent to the parent's and both
spacings count. Two symptoms (short fields AND a shifted second field) from one collapse.

⚠️ **THE LABEL BOX IS 32 TALL; THE 23 IS ITS INNER SPAN.** Measuring the span rather than the
FormLabel is what produced the 67. `7 + 32 + 35 = 74` and `7 + 32 + 37 = 76` land both fields
exactly, which is how the decomposition was checked rather than eyeballed.

⚠️ **NAME 35 / CHANNEL 37 IS REAL** — MUI's Autocomplete wraps its input with an extra pixel
each side. Reproduced rather than evened up; tidying it is how a replica starts drifting.

⚠️ **NEITHER THE TITLE NOR THE ACTIONS BAND HAS A RULE** (both measured `0px none`).
`NewDashboardModal` DOES carry one under its title and is **also 500 x 422**, so the two are
easy to conflate. Every other value differs (its label is 16/**700**, its field 384 x 40).

⚠️⚠️ **THE CHANNEL POPUP IS PORTALLED TO THE BODY, LIKE MUI'S OWN POPPER, AND IT HAD TO BE.**
`.cwm-content` is the measured `overflow-y: auto` scroll box, so an absolutely positioned list
inside it was **CLIPPED — "Voice" cut in half by the content's bottom edge, and the paper grew a
scrollbar.** Now `createPortal` + `position: fixed` anchored to the combo's rect, re-measured on
any scroll in the **capture phase** (scroll does not bubble, and it is the modal's own content
that scrolls, not the window) — the same anchoring the sidebar flyout documents.
⚠️ **The outside-pointerdown handler had to learn about the portal.** Testing only
`comboRef.contains` closed the popup on the very pointerdown that was selecting an option, so
the option's own handler never ran and the channel never changed — the silent-no-op shape this
file records repeatedly. It checks the LIST too.
⚠️ z-index **3150**: above `.cwm-root` (3100) because the list is now a body child rather than a
descendant of the paper, and deliberately not 3200, which `.ndm-backdrop` uses. They can never
be on screen together, but a tie decided by source order becomes a confusing bug later.

⚠️ **THE DROPDOWN'S OPEN STATE IS NOT IN THE CAPTURE** (`aria-expanded="false"`), so its popup
geometry is the screenshot plus the combobox values already measured for the tile Configuration
drawer — options 32 tall at `6px 16px`, 16/400, paper radius 3 with the MUI shadow. Flagged
rather than presented as measured.
⚠️ **THE TWO TOOLTIPS ARE VERBATIM from the capture's own `aria-label`s** — Invoca's product
words, which is why they read as long as they do.
⚠️ **Channel defaults to "SMS"** — the capture opens with it already in the field, so it is a
default, not a placeholder. **Create is disabled until the NAME has content** (measured
`disabled` while Channel already held SMS). The combo is READ-ONLY: with two options there is
nothing to search, and a text field that accepts "Fax" is a worse lie than one that does not.

⚠️ **WHAT CREATE *BUILDS* IS UNRESOLVED — today it navigates to the chosen channel's existing
workflow and the typed name is discarded.** So an SE who types "Marriott - After Hours" and
picks Voice lands on "Marriott - Voice". That is honest about the modal and dishonest about the
name; adding a real workflow means storing it, listing it in the sub-nav, and deciding what tree
it starts with, none of which the capture settles. Raised with the user rather than invented.

Verified with real clicks and real typing: a **22-property diff against the measured spec came
back empty** (paper 500 x 422, fields 132/74 and 230/76, labels 32, inputs 35 and 37 at 472.8,
actions at 362); the popup escapes the paper with both options at 32px and the content no longer
scrolling (310/310); picking Voice sets the field and closes the list; Create navigates to
`/agent-studio/agent/workflow/voice` leaving **zero** stray portal nodes; Escape and a backdrop
click both close. Untouched afterwards: the SMS workflow page (6 nodes, 2 chips, its own Create
Workflow button, zero `.cwm-`) and `/dashboards/marketing` (17 cards at 4px, 5 donuts, zero
`.cwm-`). `audit:ai` and `audit:voice` (38 checks) both green.

### The Ask AI empty state describes THIS page (8/27/2026)
Reported from the voice workflow page: the drawer opened with "bump Total Revenue to $1.2M",
"make Q4 trend up" and "On a dashboard I can add a tile too" — three examples that would all be
declined, on the screen where the feature is most capable. `pageHint()` in `AiAssistantDrawer`
returns a title and body per page:

| page | title |
|---|---|
| voice workflow (data has `agent` + `branches`) | **Build this voice agent** |
| SMS / extra workflow (`branches`, no `agent`) | **Change this workflow** |
| everything else | unchanged, verbatim |

⚠️⚠️ **AND THE EXAMPLES NAME THE PROSPECT'S OWN BRANCHES.** A first version listed invented
ones — "a use case for loyalty members", "the billing branch", "ZIP codes 30097 and 30096" —
which read as somebody else's agent, and on a prospect with none of those they were
instructions that would not work. `branchTitles()` reads them off the tree the SE is looking
at, so every example is true by construction and changes per prospect for free:

| prospect | reads |
|---|---|
| Marriott | Build **Marriott's** voice agent — "remove the **Cancel a reservation** branch", "ask **Ready to book now** for their email as well", "route **Comparing options** to a dedicated team" |
| Comfort Keepers | Build **Comfort Keepers'** voice agent — "remove the **Interested in becoming a caregiver** branch", "ask **Looking for care services** for their email as well" |

⚠️ **THE EXAMPLES ARE A BUILT LIST, NOT FIXED SLOTS.** With one example per slot, Comfort
Keepers' two branches put "Interested in becoming a caregiver" in BOTH the remove example and
the route example — which reads as a typo rather than as two things you can do. A prospect with
fewer branches gets fewer examples.
⚠️ **`possessive()` EXISTS BECAUSE `+ "'s"` PRINTED "Comfort Keepers's"** — the prospect's own
name, wrong, in the first line of the drawer. Several prospects end in s.

⚠️ **KEYED ON THE REGISTERED DATA'S SHAPE, NOT THE PATHNAME.** A pathname test breaks when a
route moves and says nothing about what is editable. The shape is the SAME signal
`engine/assistant.ts` uses to decide whether to describe the agent, so the drawer's promise and
the model's instructions cannot drift apart. Returns null for every other screen, so their copy
is untouched — verified live on `/dashboards/marketing`.

⚠️⚠️ **WRITING THE COPY EXPOSED A REAL GUARD BUG, which is the argument for making UI promises
concrete.** The new text offers "route cancellations to the retention team". `TreePath.route` is
OPTIONAL so that a spec naming no teams (Comfort Keepers) renders byte-identically — which made
that an `undefined -> string` write, a TYPE FLIP, on exactly the prospects whose branches carry
no route. The drawer advertised something `editGuard` refused, and it would only have failed on
those accounts. `/\bpaths\.\d+\.route$/` is now in CREATABLE_WHEN_ABSENT, and three checks
assert it by CALLING the guard against what the copy says.

### Use-case branches: both user-group nodes fork now (8/27/2026)
Agreed in a capabilities exercise, in the user's own words: the four chrome nodes stay locked,
"but after all sales inquiry users and all support users, those 2 can have as many branches as
the user want, those branches represents use cases."

| | before | now |
|---|---|---|
| under **All Sales Inquiry Users** | exactly **2**, enforced by a `[string, string]` TUPLE | **N** use cases |
| under **All Support Users** | **none** — this file said it must not branch | **N** use cases |
| per branch | shared pills from a table keyed by ACTION | its own fields AND its own destination |

⚠️ **THE SUPPORT NODE NOT BRANCHING WAS OUR LIMIT, NOT THE PRODUCT'S**, and this file previously
asserted the opposite: "Support & Escalate does not branch; giving it paths would draw a fork the
product does not have." The consequence was that every support caller got the same two questions
and one queue, when an existing customer rings to DO something — change it, cancel it, query a
charge — each wanting a different reference number and a different team.

**`src/data/voiceUseCases.ts`** derives the defaults: sales branches by BUYING STAGE, support
branches by ACTION. **Derived, not generated** — no engine phase, no schema slice, so every demo
on disk gets them and generation time is unchanged. Marriott, from data it already had:

```
Ready to book now      -> Reservation, New Booking  [Consumer Name, Destination, Travel Dates]
Comparing options      -> Reservation, New Booking  [Consumer Name, Consumer Email, Destination]
Group or event booking -> Group Sales               [Consumer Name, Group Size, Travel Dates]
Change or reschedule   -> Guest Support, Existing…   [Confirmation Number, Consumer Name]
Cancel a reservation   -> Guest Support, Existing…   [Confirmation Number, Consumer Name]
Billing question       -> Billing                    [Confirmation Number, Consumer Name]
```

⚠️ **BUYING STAGE, NOT PRODUCT LINE.** One branch per "Conversions by Product Category" row reads
well on a slide and is wrong on a phone: a caller does not ring having sorted themselves into the
prospect's product taxonomy. Where they are in the decision is something they CAN answer.

⚠️ **THE DESTINATION PUTS BACK WHAT THE LOCKED CHROME TOOK AWAY.** When the leaf became "All Sales
Inquiry Users", the note in `AgentWorkflow` recorded: "the diagram no longer contains a
destination the agent could name aloud", and `buildVoiceSystem` stopped naming one. `TreePath.route`
is drawn as `Route to <team>` — reusing the ACTION slot, so no new node chrome on a tree that
already has to fit — and `voicePaths` reads it as the route's `team`, falling back to the leaf
title. `isGroupLabel()` in chat.ts stops the fallback ever being SAID, because "All Sales Inquiry
Users" is a screen label.

⚠️⚠️ **THREE CONTRADICTIONS THIS CREATED, all caught by reading the built prompt or hearing the
call, and all the same shape as the duplicated-field bugs above:**
1. **`informSteps` said "ask for the zip and the full name" while the branches carried their own
   fields.** The steps WIN in `buildVoiceSystem`, so Marriott's Destination and Travel Dates would
   have been silently ignored. The steps are now ONLY the service-area gate, and a national
   prospect gets **none at all** — with no gate to describe there is nothing left for them to say
   that the call flow does not already carry.
2. **The opening question recited the branches.** Building it from the sales titles sounds
   principled — the question can then never offer something the diagram lacks — and produced,
   verbatim: *"Are you ready to book now, comparing options or group or event booking, or do you
   need help with something already in progress?"* Nobody says that on a phone. The tree already
   answers it: the OPENING sorts on Sales Inquiry vs Need Support; the use cases are the row below,
   classified from what the caller goes on to say.
3. **The pills came from `collectNames(actionKind)`**, a table keyed by the action, which is right
   only while every branch collects the same thing. Both the pills and the prompt now read ONE
   array on the use case.

⚠️ **`vocabFor` IS NOT EXTENDED** — it feeds the Insights catalogue, the tile Configuration drawer
and the question catalogue, so voice words would change screens nobody asked about. Same call
`franchiseAi` makes. `voiceUseCases` keeps its own vocabulary.

⚠️⚠️ **"In-home senior care" CONTAINS "car", AND COMFORT KEEPERS BECAME A CAR DEALERSHIP.** It
derived a "Fleet or business enquiry" branch routed to Fleet Sales and asked callers for a
"Purchase Timeline". Word boundaries alone did NOT fix it — the trailing `[a-z]*` needed for
"auto"→"automotive" also lets "car" swallow "care" — so the keyword is BANNED from the lists and
"auto" covers it. `vocabFor` gets away with `includes` because none of its keywords are substrings
of another vertical's word; these are.
⚠️ **QUEUE NAMES ARE USED WHOLE.** Cutting at the first separator the way intent NODE titles do
turned "Reservation, New Booking" into "Reservation", so the agent announced a transfer to a
booking term rather than a desk.

⚠️ **COMFORT KEEPERS IS UNTOUCHED, and that is the test of the design.** Its SE configured two
sales branches, no support branches and no destinations; verified byte-identical — 8 nodes,
"Inform & Route" with no `Route to`, Consumer Zip + Consumer Name, support leaf unbranched. A
configured spec is the words a human typed; the derived defaults are what a prospect gets when
nobody has typed any.

**Fit at six branches, measured** (the user chose "fit it all, let the text get smaller"):

| viewport | scale | scrolls | node title |
|---|---|---|---|
| 1500 x 900 | 0.56 | no | **7.5px** |
| 1920 x 1000 | 0.67 | no | **9.1px** (chips 7.4px) |

⚠️ It FITS at both, which is what was asked for, but the type is small and worth knowing before a
projector. The 0.5 `MIN_SCALE` floor is what stops it going further; below that the canvas scrolls
instead. The zoom cluster comes within 1px of the first branch at 1500 and does not overlap it —
and the 136px reserve that used to guarantee that was deliberately removed earlier, because the
real page lets those controls overlay the canvas corner.

⚠️ **`voice-call-sim.mts` HAD A FALSE FAILURE THAT LOOKED EXACTLY LIKE A REGRESSION.** Its
out-of-area check matched a literal `don't`, and a TTS-facing model returns U+2019 as often as
U+0027 — so a word-perfect reply failed, 5 runs in 6, while the transcript read correctly. It
normalises the apostrophe now. **Normalise before matching any scripted line.** The residual
flakiness (the model paraphrasing instead of reading verbatim) is real and pre-existing.

**`npm run audit:voice` stays at 35 checks but two changed meaning.** "Every prospect asks for a
ZIP and a name" was right only while the pills were uniform; it is now **every field a use-case
node advertises is asked for in the prompt**, which generalises and is the invariant that always
mattered. Plus: a derived prospect branches under BOTH user-group nodes. Each verified to fire.

### Ask AI configures the voice agent, not just the diagram (8/27/2026)
Asked for directly: "tell the AI what you want the Voice agent to do, and it builds the tree
and also configures the Voice agent." Before this the workflow page registered **only the
diagram**, so "greet callers with X" or "only serve these ZIPs" had nowhere to land — the model
wrote the edit, `applyEdits` found no such path, and the drawer reported success.

`AgentWorkflow` now registers `{ ...tree, agent }` as ONE object, so a single instruction
returns edits to both halves. Measured on the real drawer: one sentence produced **11 edits** —
path titles, chips, greeting, qualifying question, fallback and routing steps — and the live
call opened with the new greeting.

⚠️ **ONE OBJECT, NOT TWO SCOPES.** `registerScope` is last-write-wins, so a second
`usePageData` here would repoint the page's sparkle away from the tree and break "add a branch"
with no visible cause — the trap `WorkflowChatPreview` documents.

⚠️ **EACH FIELD HAS EXACTLY ONE HOME, or the two renderings fight:**

| lives in | fields |
|---|---|
| the **tree** (the diagram draws it) | intent subtitle, leaf titles, path titles, chips |
| **`agent`** (the diagram cannot draw it) | greeting, qualifyQuestion, qualifyFallback, rules, serviceZips, outOfAreaScript, informSteps |

`segments` is deliberately NOT in `agent` — the two answers ARE the path nodes. `intent` is not
either: its first line is the Sales Inquiry subtitle, and that node is locked chrome, so
offering it would be offering an edit `isLockedEdit` then refuses.

⚠️ **THE CALL READS THE PAGE, NOT THE PROFILE.** `VoiceCall` was `voiceSpecFor(profile)` — the
BASE spec — so an edit updated the diagram and drawers and the agent on the phone used the old
greeting anyway. Now `specWithConfig(voiceSpecFor(profile), effTree?.agent)`, laid over field by
field rather than spread, so a partial override cannot drop `informSteps` and silently stop the
agent asking for a name.

⚠️⚠️ **THREE BUGS HERE WERE ALL THE SAME SHAPE: AN EDIT THAT LANDED AND CHANGED NOTHING.** Each
was found by reading the built prompt or hearing the call, never by a type or a green test:
1. **`qualifyQuestion` reached the drawer and never the prompt.** It had been in the spec since
   it was written; the agent inferred a question from the path nodes instead. Invisible while
   the only spec was Comfort Keepers', whose GREETING already contains its question. `chat.ts`
   gained `voiceQualify`, appended **only when the greeting has no "?"** or Comfort Keepers asks
   twice.
2. **The greeting is COPIED into `rules`** (both specs end with "This is how you should also
   greet…", mirroring how an SE writes it). Changing only `agent.greeting` left the copy
   reciting the old opening, and the agent spoke the new greeting then obeyed the old rule.
   Observed live: it opened "Thanks for calling AutoNation, this is Max." and immediately asked
   the previous "book a test drive" question. `specWithConfig` rewrites the copy, and ONLY when
   the greeting actually changed, so a hand-written rule is never overwritten.
3. **A ZIP allow-list added without rewriting the steps is IGNORED** — `buildVoiceSystem`
   prefers the SE's steps, which still said "takes enquiries nationally". `stepsForZips`
   regenerates them, and ONLY when the steps are byte-identical to the base.

**A duplicated field is the common cause of all three.** When one field copies another, changing
the source silently strands the copy. Both repairs are narrow by the same rule: regenerate the
copy only when the source changed AND the copy was not itself edited.

⚠️ **`editGuard` gained `/^agent\.(rules|informSteps|serviceZips)$/` under LENGTH_IS_CONTENT and
`/^agent\.(serviceZips|outOfAreaScript)$/` under CREATABLE_WHEN_ABSENT**, plus `paths` (adding an
answer under Qualify was refused before). **Scoped to `agent.` on purpose** — a bare `/rules$/`
would also match the Signal Manager's rule strings and quietly widen rule 2 across the app.
`agentConfigOf` OMITS absent optionals rather than writing `undefined`, so "absent" really is
absent to both the guard and the model.

**`npm run audit:voice` is 35 checks.** The ten new ones are FUNCTIONAL — they call the code and
read the built prompt rather than grepping for a helper that might not be called. Each verified
to fire: disabling the greeting sync, the ZIP repair, or `voiceQualify` each turns one red.

**`scripts/askai-voice.ts`** drives the whole loop from the terminal: instruction ->
`/api/ai-assistant` -> the REAL `editGuard` -> the resulting prompt -> a live call. It reports
applied/blocked/locked per edit, because "the drawer said yes" is exactly what was misleading.

### The Qualify-and-Route voice template now applies to EVERY prospect (8/27/2026)
Asked for directly: "this template should apply to all prospects that are generated by other
users." `voiceSpecFor` used to return **null for everyone but Comfort Keepers**, and the
consequence was measured across all 12 profiles on disk before changing anything:

| | prospects |
|---|---|
| never asked for a ZIP | **8 of 12** |
| never asked for a full name | **11 of 12** |
| no scripted greeting, no conversation rules | 11 of 12 |

⚠️⚠️ **AND EVERY ONE OF THEM DREW "Consumer Zip" AND "Consumer Name" PILLS.** The diagram
advertised collecting two things the agent never collected, on 11 of 12 prospects, and nothing
failed anywhere. Same silent-disagreement shape as the greeting, the `cells` guard and the
workflow tile before it.

`deriveVoiceSpec(profile)` now builds the same `VoiceAgentSpec` shape from the prospect's own
profile, and `voiceSpecFor` returns **the SE's configured spec where one exists, else the
derived one** — it can no longer return null. **Derived, not generated**: no engine phase and
no schema slice, so generation time is unchanged and every demo already in the shared library
gets it without regenerating.

⚠️ **THE DIAGRAM DELIBERATELY DOES NOT MOVE.** The tree renders `intent.split("\n")[0]` as the
Sales Inquiry subtitle and `segments` as the two path nodes, so the derived values are the
EXACT strings `deriveTree` previously used as its inline fallback. Verified on all 12 profiles
and re-checked live on AutoNation: subtitle "Caller wants to book a test drive and is not an
existing customer", paths "Looking to book a test drive" / "Needs help with an existing
request", both still carrying Consumer Zip + Consumer Name. Any other phrasing here would
silently reword a screen nobody asked about.

⚠️ **ZIP CODES ARE NEVER INVENTED, and this is the one place the template stops short.**
Comfort Keepers' 30097/30096/30095 are an SE's own configuration. Minting a plausible allow-list
for a real company would fabricate its service area and turn real callers away for a reason
that does not exist. So `serviceZips` stays undefined when derived, and the gate falls back to
the prospect's **generated `serviceArea`** — a real refusal where it has one (Orlando Health,
Key-Whitman, Continuing Life), and a nearest-location lookup rather than a refusal where it does
not. Both branches verified against the real `/api/chat`.

⚠️⚠️ **`brandConversationRules` IS THE *SMS* SALES PLAYBOOK AND MUST NEVER REACH THIS PROMPT.**
The Intent drawer had always appended three of them, which was harmless while nothing forwarded
the drawer's rules to the agent. The moment every prospect got a spec they did, and they read
"Qualify one at a time: ... your target price or monthly payment, your timeline to buy" —
directly contradicting the flow's own "ASK NOTHING BEYOND THE FLOW ABOVE" cap. That is the
over-asking already fixed once by hand for Comfort Keepers, and **a self-contradicting prompt is
worse than either rule**. Caught by reading the built drawer, not by any type.
**Consequence, stated rather than discovered later:** a non-configured prospect's Intent drawer
now shows three rules instead of six. The three it lost were SMS playbook lines rendered as
voice-workflow rules, which was wrong on that screen too.

⚠️ **`voiceCopy` MOVED to `src/data/voiceCopy.ts`** because `deriveVoiceSpec` is a second
caller and the two MUST use the same words. Identical reasoning to `isProspect` moving to
`prospect.ts`. `workflowDrawers`' hand-written structural `Profile` type widened to
`CustomerProfile` for the same reason.

**`npm run audit:voice` grew to 25 checks**, six of them new, and they **BUILD THE REAL PROMPT**
rather than grepping for a helper that might not be called:
every prospect asks for a ZIP · asks for a full name · opens with a scripted greeting · no
derived spec invents ZIPs · a derived spec renders the diagram's existing wording · the SMS
playbook never reaches the voice prompt.
⚠️ Each was verified to FIRE on its own broken shape. One of them **did not fire the first
time**: `/zip code/i` also matched the conversation RULE explaining the ZIP, so a prompt with
the rule and no step passed. It matches `/for their zip code/i` — the imperative — now. That is
exactly why checks are broken on purpose before being trusted.
⚠️ The audit must pass a REAL tree: `voiceSystemPrompt` only emits the CALL FLOW block when
`voicePaths` is non-empty, so an empty tree skips everything the checks assert and they all pass
against a prompt that was never built. Hit while writing them.

**`scripts/voice-sim.mts`** is the generic counterpart to the Comfort-Keepers-only
`voice-call-sim.mts`: `npx tsx scripts/voice-sim.mts <slug> "line" "line"` talks to any
prospect's agent through the real endpoint. Verified end to end on AutoNation (national),
Orlando Health (regional, both in-area and out-of-area) and Vector Security. Comfort Keepers
re-checked with its own 9 assertions: all still pass.

### Comfort Keepers has its own SMS workflow tree (8/24/2026)
Requested as a change for **that prospect only**, matched to a supplied diagram. `SMS_SHAPE`
in `AgentWorkflow.tsx` is the SMS counterpart to the existing voice `SHAPE` table. It differs
from the derived default in five visible ways: "Triggered by" names inbound SMS
("0 Campaigns, 0 Forms, and 0 Inbound SMS"); the intents are the literal "Sales Inquiry" /
"Need Support" rather than the prospect's own queue names; the support leaf is
**"All Support Users"**, not "All Need Support Users"; the sales action is "Schedule Callback"
with a **phone** icon rather than "Schedule <bookingTerm>"; and it carries ONE chip
("Consumer Name") where the default carries two.

⚠️ **MATCHED BY PROSPECT *NAME*, NOT BY A HARDCODED ID** (`isProspect`). Comfort Keepers is a
demo in the shared LIBRARY, not a profile on disk, so its id was minted from whatever the SE
typed — `comfort-keepers`, `comfort-keepers-home-care`, or a name with a city on the end.
Keying an override off a guessed id **fails silently**: the tree renders the default and
nobody knows why. Verified the matcher hits all three of those shapes and rejects both
`shady-blinds` and `comfort-inn`.

⚠️ **THE TWO NEW VISUALS ARE OPT-IN LEAF PROPS**, `actionIcon` and `warn`, defaulted to
today's behaviour — the same pattern `DonutChart`'s extra props follow. Without them the
action icon is still chosen from `tone` and no warning is drawn, so every other diagram in
the app is byte-identical. Proved it: Shady Blinds' SMS tree is back to Design Consultation /
Existing Order with "Schedule Consultation" and two chips, and its Voice tree still renders
`altRoute` + `headset` with **zero** warning triangles.

⚠️ **HOW THIS WAS VERIFIED WITHOUT THE PROFILE.** There is no Comfort Keepers profile on
disk, so the override could not be seen directly. Pointing the SAME table entry at
"shady blinds" for one run exercised the whole path — shape lookup, renderer, both new icons —
against a prospect that IS on disk, then the entry was reverted and the absence of leakage
re-checked. Use that trick for any library-only prospect.

⚠️ **`editGuard` lets `branches`/`leaves`/`chips` change length.** On a workflow
screen the tree's shape IS the content, so that exemption is deliberate — and it is
only safe BECAUSE the layout is computed: a new branch positions itself and draws
its own connectors instead of landing on top of something. Chart series and table
rows are still blocked. Node styling, sizes, colours and the icon set are not data
and remain out of reach, so rule 2 still holds.

⚠️ **Tile creation is now dashboard-only** (`canCreateTiles` from the drawer,
`pathname.startsWith("/dashboards/")`). Asked to "add a third branch", the model
first answered by creating a KPI TILE — which a workflow page never renders, so it
reported success and nothing appeared. When the flag is false the prompt forbids
`kind:"create"` and requires an `editData` edit that appends to the right list.

⚠️ **Connector endpoints are MEASURED from the nodes, never offsets.** They used to
leave a node at `top + 54` (trigger/start) and `top + 108` (intent), and both were
wrong — which surfaced as two bugs that looked unrelated:
- **SMS** intent nodes are 43px and 64px tall (the title "Existing Customer Support"
  wraps, "Consultation" does not), so real bottoms are 283/304 — but the line was
  drawn `348 → 344`. **A 4px line pointing UPWARDS: no connector visible at all.**
- **Voice** nodes are taller and the leaf row lower, so the same `+108` gave a
  correctly-directed line that **started ~24px BELOW the node** — a stub floating in
  space, attached to nothing.

A hardcoded height cannot survive text that wraps, a re-skinned label, or the AI
renaming a node — all of which this component exists to support. Each node now
reports its own `offsetHeight` (layout effect for the first paint and model changes,
plus a `ResizeObserver` for a later reflow that changes no prop), and every branch
uses ITS OWN intent height. `offsetHeight` is the layout box, so the wrapper's
`transform: scale()` doesn't distort it. `FALLBACK` covers only the frame before the
first measurement. Verified on all three shapes: SMS `283/304 → 344`, Voice
`428/446 → 528`, and the National Van Lines split `428 → 470` sub-bus → two
`470 → 528` drops — zero gaps at the nodes, no inverted lines.

⚠️ `.wf-canvas` has `padding-bottom: 136px` so the zoom cluster (`bottom: 16px`,
104px tall) can never be overlapped by a tall tree. That replaced a per-tree
`min-height` override which only fixed the one hand-built tree it was written for.

### Preview Workflow (SMS): the chat drawer that tests the same agent
`components/WorkflowChatPreview.tsx`. On an SMS workflow page **Preview Workflow**
slides in a right-side chat drawer — the SMS counterpart to the Voice page's
call drawer. Before this the SMS button rendered and **did nothing** (`onClick`
was `if (!isSms) …`).

Matched to the real page (network 1847 `/ai_agents/edit/25/workflow/114`) from a
SingleFile capture. It is an **embedded chat widget**, not a platform component, so
its own stylesheet is the source of truth and the values are MEASURED:
`.cloud{width:400px}` → 400px panel · header `h-[50px]` `rgb(231,233,235)` on
`rgb(21,36,62)`, 6px top radius · host bubble white / guest bubble
`rgb(231,233,235)`, both 6px radius, 16px, `px-4 py-2` · rows carry a 50px margin
on the opposite side so a long line never spans the full width · textarea
min-height 56px / max 128px, placeholder "Type your question" · footer
`Last Updated: <date>` 13px `rgb(48,50,53)`. Header title is
`Preview Workflow - <workflow> (Draft)`, with the capture's tabler-refresh
**Reset Chat** and a close X. Positioned like its sibling `.vp-drawer`.

⚠️ **It tests the SAME agent as the Preview Agent screen.** Both build their brain
from `buildSmsBrain()` in **`src/data/smsBrain.ts`** (which also owns
`askSmsAgent()` — the `/api/chat` call, its transient-failure backoff, and the
markdown strip), so the questions, order and rules are identical **by
construction**. Two local copies of that object would drift on the first edit, and
an SE who tunes questions on one screen and sees different behaviour on the other
has been shown a lie. Verified live: asked "i need a home insurance quote", the
drawer replied with Goosehead's configured question 1 **verbatim**.

⚠️ **It must NEVER call `usePageData`.** The workflow page has already registered
its DIAGRAM as the AI scope and `registerScope` is last-write-wins, so a second
registration here would silently repoint that page's sparkle from the tree to the
agent config — killing "add a branch" with no visible cause. It reads the Preview
Agent page's EFFECTIVE config via `effectiveData(`${profileId}::${SMS_AGENT_SCOPE_PATH}`)`,
which registers nothing and still picks up edits made over there (right behaviour:
two views of one agent). Verified: with the drawer open, the Ask AI drawer's scope
still reads "…- SMS workflow".

⚠️ It deliberately does **not** capture to the SMS Conversation Intelligence
report. The iPhone Preview Agent does that and it is the demo's headline move; a
second capture source would file the same conversation twice. This drawer is a test
bench, not a demo beat.

### Preview Agent: the AI sets exactly what the phone asks
The sparkle + undo sit **top-LEFT** on `/agent-studio/agent/preview` — that route
renders outside the app shell, so there is no top bar to hang them on. Same
hover-to-reveal contract (`.pp-ai` reuses `.tb-ai-btn`), and `SmsPreviewPage`
renders `<AiAssistantDrawer />` itself, because AppShell only renders it for
in-shell screens and without that the sparkle opens nothing.

**The edit reaches the LIVE agent**: `useBrain` in `PhonePreview.tsx` reads the
EFFECTIVE agent config via `usePageData`, not `profile.reports.agentConfig`, so
"ask for the ZIP code first" changes the very next reply rather than being a note
in a panel. Scope key is the usual `<profileId>::<pathname>`, so these edits and
their undo stack belong to this page alone.

Two things had to change for "exactly what questions" to be literally true:
- **`editGuard` lets question lists change length.** The array-length rule exists
  because length drives layout, but a list of questions is content — "ask three
  instead of five" is a data change, and blocking it made the feature useless.
  `LENGTH_IS_CONTENT` matches the edit PATH so the exemption stays narrow; chart
  series and table rows are still blocked.
- **`engine/chat.ts` numbers the questions and forbids reordering.** They used to
  be a bullet list under "adapt naturally to what the customer says", which read
  as a menu: asked for ZIP → service → timing, the agent skipped straight to the
  second question. Now numbered, with "IN THIS EXACT ORDER, do not skip, do not
  reorder, do not add your own". Verified live: it asks the ZIP first, verbatim.
  ⚠️ Node-cached — restart the dev server after editing that prompt.

**Headings that were literals are now DATA** — `usePageDataWithLabels(base, LABELS)`
folds a screen's `LABELS` constant into the object registered as the page scope, so
the assistant sees them at `labels.<key>`, edits store under the page key like any
other, and undo covers them. No schema change and no engine phase, so every
prospect already on disk gets it. Used by `InsightsDashboard` (all 13 headings and
metric labels) and `MarketingDashboard` ("Sales Call Breakout Graph"). The final
spread means an override saved before a label key existed falls back to the default
instead of rendering `undefined`.

⚠️ **A literal heading is worse than a missing feature**: the assistant accepts
"rename this to X", writes the edit, and the screen does not budge — a silent
no-op. If you add a heading a user might want renamed, put it in that screen's
LABELS, not in the JSX.

**What deliberately STAYS hardcoded** (audited: 334 user-visible literals across
the screens, and these are the right ones to leave): Invoca's own product
vocabulary — page names ("Call Review", "Agent Studio"), filter labels ("Filters",
"Speaker", "Sort By:"), Call Detail rail sections ("SCORECARDS", "TRANSCRIPT"),
table headers ("Name", "Shared Status"), ThoughtSpot footers ("UNIQUE COUNT",
"TOTAL"), the dimension columns ("Marketing Source"), and workflow node labels
("Triggered by"). Plus third-party chrome on the Google and ChatGPT screens, and
the Launch screen (our tool, not the demo). That is the template, and rule 2 keeps
the AI out of it. The six platform dashboards were already fully data-driven.

### ⚠️⚠️ A COMPONENT REBUILD DELETED ANOTHER SCREEN'S ENTIRE STYLESHEET (found 8/27/2026)
Reported as "what's going on with this page, it didn't render correctly" — Call Detail was
rendering as unstyled stacked text: a default `<h1>`, default buttons, every rail section and
every transcript turn in one column.

**Cause: `fbd7d96` ("Rebuild the voice preview drawer against the real one", 8/26) removed 79
`.cd-*` rules and the 3 `.cr-card-link` rules along with the `.vc-*` ones it meant to
replace.** Call Detail had been broken for a day. Restored verbatim from `fbd7d96^`.

⚠️ **NOTHING FAILED, AND EVERY SIGNAL POINTED AWAY FROM A DELETION.** `tsc` cannot see a
missing CSS rule, that screen has no test, and the SIDEBAR AND TOPBAR STILL RENDERED —
they are styled from rules earlier in the file — so the page reads as "half loaded", which
sends you looking at the dev server and the route rather than at the stylesheet. The
`.cd-` grep that finds the problem in one command returns a comment mentioning `.cd-*` and
nothing else, which is easy to skim past as a hit.

⚠️ **THE DIFFSTAT ACTIVELY CONCEALED IT: `343 ++++----` on app.css, 375 insertions against
374 deletions across the commit.** That reads as a rewrite of one component. **Diff the RULE
COUNT PER PREFIX before and after any prefix rename, component rebuild or large CSS move** —
it takes one script and it names the blast radius outright:

```
.cd-        79 ->  0   (-79)     <- Call Detail, collateral
.cr-        51 -> 48   (-3)      <- Call Review's clickable card, collateral
.vc-        36 -> 22   (-14)     <- the rebuild's actual subject
```

⚠️ Two of this file's existing rules would each have caught it and neither was applied: "one
CSS prefix per screen" (which exists because prefixes get confused with one another) and
"THEN PROVE IT — load one of the other screens and assert the old values". The screens to
prove after touching a shared stylesheet are the ones whose prefixes the diff TOUCHED, and
the count table above is how you learn which those are.

## Launch screen & live generation (the front door)
`/` and `/launch` render `src/screens/Launch.tsx` (full-page, outside the AppShell).
An SE enters a prospect **name + URL** → **Launch** → the app POSTs to
`/api/generate`, which **streams progress back as Server-Sent Events**. The Launch
screen renders a **live build checklist** (all 16 pieces — research, report, each
dashboard, Call Review/Detail, the CI reports, Agent config, artifacts) that flips
each item pending → building (spinner) → ✓ as the engine emits `{phase,status}`
events, plus a weighted **% bar** (research+report weighted 10/6 vs 1 since they're the
long sequential prefix; the currently-building phase's contribution also eases up
**asymptotically over time** via a 0.5s tick + `RAMP_MS`, so the bar always creeps
and never looks frozen — critical because for big sites research alone can run
~4-5 min and would otherwise sit flat). On the final `{type:"done",profile}` event it validates +
routes into the platform re-skinned to that prospect. `BUILD_STEPS` in `Launch.tsx`
maps engine phase keys → friendly labels; the frontend reads the SSE stream via
`res.body.getReader()` (splitting on `\n\n`). Opening a prospect (fresh generation OR one-click
revisit) lands on the **Marketing Performance dashboard** (`/dashboards/marketing`)
— the demo's start screen; change the `LANDING` const in `Launch.tsx` to move it.
The screen also has a **"Your prospects" searchable dropdown** (all known customers,
filter by name/industry) for instant one-click revisit — no regeneration/API cost.
Generated prospects show a **delete** (trash) icon → a **confirm modal** ("are you
sure") → `removeProfile(id)` (state + localStorage + the on-disk JSON via
`POST /api/delete-profile`, so it doesn't reload on restart). Seed profiles
(`SEED_IDS` in `profiles.ts`, e.g. Shady Blinds) are code-defined and show NO delete.

Flow of the pieces:
- **`engine/core.ts`** — `generateProfile(name, url, {apiKey})` is the reusable
  research→report→dashboard→callReview→callDetail→opsDashboard→aiAgentConversion→
  aiMessagingImpact→conversationIntelligence→smsConversationIntelligence→
  voiceConversationIntelligence→agentConfig→qualityManagement→qmInstantInsights→signalManager→screenpops→voiceRoutingDemo pipeline
  (17 phases; returns a validated `CustomerProfile` with report, six dashboards,
  Call Review, Conversation Intelligence, the SMS + Voice conversation reports, and
  the Agent Studio config per prospect).
  `engine/generate.ts` (the CLI) and the dev endpoint both call it.
  ⚠️ `structured()` MUST use streaming (`messages.stream().finalMessage()`) — the SDK
  throws on any non-streaming call it estimates could exceed 10 min (large max_tokens),
  which was silently failing every generation at the ops phase. The SMS-conversation
  phase uses the FAST model (Haiku) via `structured(..., FAST_MODEL)`.
  ⚡ **Perf: <=3min (optimized 2026-07-22).** Critical path = `research()` → `generateTerms()`
  (tiny, fast) → a **concurrency-limited pool of 16 phases**. Key wins, in order of impact:
  (1) **`report` split**: the old `generateReport` blocked the pool for ~50s to hand off 6
  short strings. Now `generateTerms()` (schema = just the 6 identity/canonical terms, max_tokens
  1200) runs in the prefix (~15s), and the heavy 18-24-row Digital Insights table is
  `generateDigitalInsights()` — a normal **pool phase** (nothing reads `digitalInsights` until
  final assembly, so no race; bookingTerm is threaded in for its signalColumns). (2)
  **`runPool(tasks, CONCURRENCY=6)`** ordered **longest-processing-time first (LPT)** so a heavy
  Opus phase never starts late and tails the makespan. (3) **`research()` trimmed**: web_fetch
  5→3, web_search 5→2, pause_turn loop 6→4, + a "prioritize homepage/key pages, stop early" hint
  — this is the ONLY lever for big multi-page sites (research dominated their time). `runPool`
  preserves tuple types (`| []` trick). `phase(label,run)` retries **ONCE on ANY rejection**
  (rescues a one-off malformed-JSON/Zod failure — do NOT restrict to transient codes) with a
  small random start-jitter to soften the 6-wide burst, and logs `[phase] <name>: <s>s`.
  **Measured: Continuing Life 217s→159s; Orlando Health (large site) ~360s→~123s — both under
  3min, quality intact (17 report sections, rich re-skinned data, consistent terminology).**
  To add a phase: append a `() => phase(...)` thunk to the `runPool` array (place it by expected
  duration for LPT), add a slot to the destructure, and add it to the `reports:{}` assembly.
  ⚡ **The Marketing Performance dashboard is THREE phases, not one (split 2026-07-30).**
  As one call it WAS the makespan: **180s of a 258s generation**, with all fifteen other
  phases idle behind it (measured on Roto-Rooter). It is the biggest output in the
  pipeline — 3 KPI groups, SIX breakdowns of 5 rows × 4 metric columns (120 cells) and
  two multi-series charts — and `effort:"high"` had to hold every arithmetic rule in
  `scaleRules()` across all of it in one pass. Now:
  `dashboard` (KPI tiles + the breakout line chart that rolls up into them) ·
  `dashboardChannels` (Source/Medium/Campaign/Search Term) ·
  `dashboardSegments` (Product Category + the chart plotting the SAME categories, + Region).
  ⚠️ **This is only safe because the numbers are pinned BEFORE the pool starts.**
  `buildScale()` fixes total calls, revenue, won sales, bookings and answer rate, and
  `scaleRules()` hands the SAME figures to every phase, so the three pieces agree by
  construction rather than by luck. **If you ever make a dashboard number depend on
  another phase's OUTPUT instead of on `Scale`, these have to merge back.** The split
  also follows the real internal dependencies, so nothing that must match is separated.
  ⚠️ `breakdowns` is **order-sensitive, in two different ways**. `MarketingDashboard`
  splits the array **by flag**: `filter(hasDonut)` renders the donut+table tiles in
  **array order**, and `find(!hasDonut)` pulls the single Product Category one out to sit
  beside `productCategoryGraph` — so on screen the donut sequence reads Source, Medium,
  Campaign, Search Term, **Region**, with Product Category in its own section further
  down, even though the array holds it fifth. Separately, `prospectPlace.derive()` and
  `google-ads-demo.js` look rows up **by title**. `assembleDashboard()` rebuilds the
  canonical array order (Source, Medium, Campaign, Search Term, Product Category, Region)
  and matches the four channel breakdowns **by title** so a model that reorders its own
  array still lands them right. Do not append.
  Round-trip tested against all 9 real dashboards on disk: cut each into the three
  slices, reassemble, byte-identical — plus a shuffled-array case.
  ⚠️ A new phase key must also be added to **`BUILD_STEPS` in `Launch.tsx`** or its
  progress is invisible on the live build checklist (and its weight missing from the bar).
  ⚠️ **Model param support:** `thinking:{type:"adaptive"}` and `output_config.effort`
  are **Opus-only** — `structured()` gates BOTH to `MODEL`; Haiku (FAST_MODEL) 400s on
  either. Strict structured-output schemas can't use `z.record()` (→ `additionalProperties`
  object); use a positional array instead (see `VrdTurn.q`).
  ⚠️ **Engine IS now type-checked:** `tsconfig.node.json` includes `engine` (it didn't
  before — that's how a missing `CallDetailView` import + these param bugs went unnoticed;
  no full generation had been run in a while). Run BOTH `tsc -p tsconfig.app.json` and
  `-p tsconfig.node.json`.
  ⚠️⚠️ **`npx tsc --noEmit` CHECKS ZERO FILES, AND IT EXITS 0 — measured 9/8/2026 after a
  Render build failed on an error it had reported clean.** The root `tsconfig.json` is a
  SOLUTION file: `"files": []` plus two references. So the bare command compiles nothing and
  is indistinguishable from success, while `-p tsconfig.app.json` covers 161 files and
  `-p tsconfig.node.json` 19. Everything green from the bare command means nothing.
  **Use `npm run typecheck` (an alias for `tsc -b`, which is exactly what `npm run build`
  runs), and it is now the FIRST step of `npm run audit`** so a type error cannot hide behind
  a wall of passing checks. ⚠️ Two ways the same reading went wrong in one session: this, and
  `npx tsc --noEmit 2>&1 | head; echo $?` reporting **head's** exit status. A type-check is
  only evidence if you can name the files it read.
- **`/api/generate`** — a Vite dev-server plugin in `vite.config.ts`
  (`configureServer`). **Streams Server-Sent Events** (`text/event-stream`): a
  `{type:"progress",phase,status}` event for every phase start/done (fed by
  `generateProfile`'s `onProgress` callback → `Progress` type `{phase,status}`),
  then sends the final `{type:"done",profile}` (or `{type:"error",error}`) and ONLY
  THEN writes `src/data/generated/<slug>.json` (write-after-done, in its own try/catch,
  so a disk error can't discard a profile the user waited minutes for). Reads the key via `loadEnv`. NOTE: this is a **dev-only**
  endpoint; hosting the app for real would need a proper backend/serverless fn.
  The plugin unwatches `src/data/generated` so writing a file mid-demo doesn't
  trigger a page reload.
- **`/api/chat`** — sibling Vite dev-server plugin. `POST { brain, messages, voice? }` →
  `engine/chat.ts` `chatReply()` (fast **Haiku** model) → `{ reply }`. Powers BOTH
  the Agent Studio **Preview Agent** iPhone SMS chat (`PhonePreview.tsx`) and, with
  `voice: true`, the live **Voice-agent phone call** (`VoiceCall.tsx`). The two
  channels are DIFFERENT use cases and `buildSystem(brain, voice)` branches
  accordingly: **SMS = sales** (qualify → quote → book a consultation, from the
  `smsPlaybook`); **Voice = qualify-and-ROUTE** (`buildVoiceSystem` — two paths,
  new-order vs existing/support, never sells/quotes/resolves, hands off to a team).
  The `brain` is built client-side from the active profile's `agentConfig` (same
  brand rules/knowledge feed both). Key stays server-side. NOTE: `engine/chat.ts` is dynamically
  imported and Node-cached, so editing its prompt needs a dev-server restart to
  take effect (the client also strips markdown as a safety net). Same caching
  caveat for `engine/analyze.ts` and `engine/core.ts` — restart after editing.
- **`/api/analyze`** — sibling plugin. `POST { customerName, bookingTerm, customerNoun,
  channel?, transcript }` → `engine/analyze.ts` `analyzeSms()` (fast Haiku) → `{ signals }`.
  Called when the SE ends a Preview Agent session, to extract the captured
  conversation's Analysis signals. Shared by BOTH the SMS chat and the Voice call;
  `channel` (`"sms"`|`"voice"`) only tunes the prompt wording.
- **`/api/ai-assistant`** — sibling plugin. `POST { customerName, dashboardTitle,
  dataContext, question, focus, history }` → `engine/assistant.ts` `askAssistant()`
  (fast Haiku, `output_config.json_schema`, max_tokens 8000) → `{ result }`. Powers
  the **"Ask AI"** drawer on every dashboard. `focus` scopes it (whole dashboard vs
  one tile). `result.kind` is one of: `"answer"` (text / scenario suggestions),
  `"create"` (a new tile spec — `tileType` kpi/line/bar/pie), `"editData"` (path
  edits `[{path,value}]` into the dashboard DATA — value is JSON-encoded; paths use
  dot OR bracket notation), or `"editTile"` (replacement spec for a focused
  generated tile). **DATA-ONLY**: the prompt forbids structural/CSS/layout/color
  changes and array-length changes (edits target scalar leaves or same-length chart
  series); styling requests are declined. All numbers come strictly from
  `dataContext`. Same Node-cache caveat — restart the dev server after editing
  `engine/assistant.ts`.
- **`/api/tts`** — sibling plugin. `POST { text, voiceId? }` → **audio/mpeg** (MP3)
  bytes from the configured provider (`engine/tts.ts`, key server-side). Powers the
  premium human voice on the live Voice call. **Two providers**: **Deepgram Aura**
  (`DEEPGRAM_API_KEY`, optional `DEEPGRAM_MODEL`) and **ElevenLabs**
  (`ELEVENLABS_API_KEY`, optional `ELEVENLABS_VOICE_ID` / `ELEVENLABS_MODEL_ID`).
  Provider is chosen by `TTS_PROVIDER` (`deepgram`|`elevenlabs`), else auto:
  Deepgram if its key is set, else ElevenLabs. Returns a JSON error (501 when the
  chosen provider's key is missing) so `VoiceCall.tsx` falls back to the browser
  voice. Same Node-cache caveat — restart the dev server after editing `engine/tts.ts`.
- **`SmsCaptureContext`** (`src/data/SmsCaptureContext.tsx`) — session store of
  Preview-Agent-captured SMS conversations, keyed by prospect id, **persisted to
  localStorage** (`invoca-demo:sms-captures`) with a **7-day TTL** (pruned on load,
  capped 25/prospect). `addCaptured` prepends; `patchCaptured` fills in signals.
  The SMS report merges these (newest first) ahead of the seed conversations.
- **`VoiceCaptureContext`** (`src/data/VoiceCaptureContext.tsx`) — identical sibling
  for captured **voice calls** (`invoca-demo:voice-captures`, 7-day TTL, capped 25).
  Ending a Preview-Agent voice call prepends the call here; the AI Voice
  Conversation Intelligence report merges these ahead of its seed.
- **`ProfileContext`** holds the customer list in state with `addProfile()`, and
  **persists to localStorage** (`invoca-demo:profiles` + `:activeId`) so generated
  customers and the active selection survive a browser refresh. Durable record is
  still the JSON files (picked up by the `import.meta.glob` in `profiles.ts` on the
  next dev-server start). TopBar's network switcher + the Launch list read from context.
- Known nit: seed `mavis` + generated `mavis-tires-and-brakes` show as two
  "Invoca for Automotive" entries — de-dupe later if it bothers a live demo.

## Core architecture
1. **Canonical customer profile** — `src/data/schema.ts` defines a Zod
   `CustomerProfile` (identity + `reports.digitalInsights` + `reports.marketingDashboard`).
   This is the single source of truth; every screen reads a slice of it, so a
   customer's data is consistent across all screens. Zod gives runtime validation
   (guards AI output) + derived TS types.
2. **Profile-driven screens** — read the active profile via `useProfile()`
   (`src/data/ProfileContext.tsx`). The **top-bar network selector doubles as the
   customer switcher** — pick a customer and the whole app re-skins.
3. **Generation engine** — `engine/generate.ts`: URL → researches the site
   (web_fetch/web_search) → generates data constrained to the schema
   (structured outputs) → Zod-validates → writes `src/data/generated/<slug>.json`,
   which the app **auto-loads** via `import.meta.glob` and adds to the switcher.
4. **Exact-copy static pages** — some screens must look EXACTLY like a real page
   and are identical for every customer (marketing/console pages). These are saved
   real HTML served from `public/*.html` (see below), not React rebuilds.

## File map
```
src/
  tokens/tokens.css        Design tokens (measured Invoca colors/type) + fonts (Lato/Material Icons, bundled in public/fonts)
  styles/app.css           App component + layout styles
  styles/standalone.css    (mostly legacy; the exact-copy pages carry their own CSS)
  data/
    schema.ts              Zod CustomerProfile + DashboardView + GenerationOutput + types  ← EXTEND HERE for new screens
                             (DigitalInsightsReport now has dimensionColumns + signalColumns;
                              InteractionRow = 6 dimension fields + signals:boolean[] aligned to signalColumns)
    ProfileContext.tsx     useProfile() + ProfileProvider (active customer)
    profiles.ts            Registry: seed profiles + import.meta.glob('./generated/*.json')
    profiles/shadyBlinds.ts   Seed profile (real captured data) — the reference customer
    profiles/mavis.ts         Seed profile (hand-authored auto-service analog)
    generated/*.json          Engine output (auto-loaded, Zod-validated on load; INVALID/old-schema files are skipped with a readable console warning, NOT fatal — one stale file can't crash the app)
  components/              Sidebar, TopBar, Pill, Card, BarChart, DonutChart, LineChart, StackedBarChart, DataTable, nav.tsx (NAV config + exact SVG icons: ProfilesIcon/CallReviewIcon/AgentStudioIcon/LeadFormsIcon), DashHeaderActions + DashTileMenu (shared dashboard actions; the AI sparkle — DashTileAi/DashTileToggle put it on EVERY tile incl. charts — opens the Ask AI drawer), AiAssistantDrawer + GeneratedTiles (DashAssistant + useDashboardData hook) + DashboardBoundary (the Ask AI feature: chat, data edits, undo, error safety net)
  screens/
    DigitalInsights.tsx     "Digital Journey & Call Attribution Report" (chart + interactions table w/ dimension + signal columns)
    CallReview.tsx          Call Review list: filters panel + call cards (score % / AI summary / meta + 3 stats: scorecards ✓, comments 💬, negative-sentiment 😠 red). Reads reports.callReview (optional). The **Signals** filter is INTERACTIVE: clicking it opens a two-panel modal (`.sig-*`) — 10-signal list (only the top, `${bookingTerm}: Scheduled`, is active) × Yes/No/Not Applied checkboxes; Apply → removable pill in the field + live-filters the list off each call's `converted` flag (fallback: `didConvert()` keyword heuristic). **Global Transcript Search** is also live: a substring match over each call's summary (the per-call transcript-derived text we have) with matched terms highlighted (`Highlight` / `.cr-hl`) and count updating; composes (AND) with the Signals filter. The input's **placeholder** shows 3 per-prospect example terms (`i.e. term1, term2, term3`) so the SE never has to guess what to type for a new prospect: curated `reports.callReview.searchSuggestions` (engine-generated, each present in ≥2 summaries) validated against the real summaries, with a client-side `extractTerms()` fallback (top doc-frequency words) for older profiles. Both filters **reset on prospect switch** (`useEffect` on `profile.id`) so a stale term never strands the list on 0 Calls. 4th call drills into Call Detail (tracked by object ref so it survives filtering).
    ManageDashboards.tsx    Dashboards landing = a list of dashboards (Name/Shared Status/Owned By/Last Modified); click a name → that dashboard. Add a row here per new dashboard.
    MarketingDashboard.tsx  Marketing Performance Dashboard (KPI groups, donut+table breakdowns, line + stacked charts)
    MarketingOpsDashboard.tsx  "Marketing & Operations Performance with Revenue" dashboard (reuses dashboard-1 CSS + HBarChart + StackedBarChart). Adapt: to add a 3rd dashboard, add a schema view + shadyBlinds data + a screen + a route + a ManageDashboards row + an engine phase.
    Placeholder.tsx         Fallback for nav items not yet built
  layout/AppShell.tsx     Sidebar + TopBar + <Outlet>
  App.tsx                 Router: in-shell routes for built screens/placeholders; standalone routes for exact-copy pages
engine/
  generate.ts             The generation engine (3 phases: research → report → dashboard)
  README.md               How to run the engine
public/
  invoca-exchange.html    EXACT copy of invoca.com/integrations (+ "Integrations and Apps _ Invoca_files/" assets)
  google-ads.html         EXACT copy of the Shady Blinds Google Ads "Search Keywords" console (+ its _files folder)
  logo.png, fonts/        Invoca logo + bundled Lato/Material Icons woff2
```

## Screens & their patterns
| Screen | Route | Pattern | Status |
|---|---|---|---|
| My Reports | `/reports` | Profile-driven (React) | ✅ landing page the **Reports** nav opens (Saved/Requested/Subscriptions tabs, search, paginated table). Lists the built reports; rows link to them. List is derived from `customerName` + which optional reports the profile has — no schema/engine change. `DigitalInsights` breadcrumb "My Reports" links back here. Also lists the 3 **Gumloop artifacts** (see below) as "AI Artifact" rows: the **Schedule Status** column shows a dash for complete artifacts (only Creating…/Failed render a label — "Complete" was intentionally removed), and a complete row **opens the artifact standalone in a NEW browser tab** (Blob URL, no platform chrome) via `openArtifact`. Table row borders live on the `<td>`s (the Name cell's flex is on an inner `<div>`, NOT the `<td>`, so all cell borders align); report-title links are `#2666f9` |
| Gumloop artifacts (Voice Screenpop / SMS Screenpop / Voice Routing Demo) | opened in a new tab from My Reports | Template (self-contained HTML) | ✅ 3 HTML "leave-behinds" originally from an external Gumloop agent. Since the Gumloop API key isn't available, they're **replicated in-house**: `src/artifacts/*` renders each from a typed data slice on the profile (`reports.voiceScreenpop` / `smsScreenpop` / `voiceRoutingDemo`) — the two screen pops share one shell (`screenpop.ts`; CTI agent-desktop with Invoca Pre-Call Intelligence, ringing→answer→active-call), the routing demo (`voiceRoutingDemo.ts`) is the animated live-call-routing (queues climb, signals detected, routed-outcome card). `renderArtifact(profile, id)` resolves id→HTML; `openArtifact` serves it via Blob URL in a new tab. `reports.gumloopArtifacts[]` carries the My Reports rows (id/name/status/createdAt; optional html/url for a future real Gumloop hookup). Sources: `reference/gumloop/*.html`. Gumloop API trigger is scaffolded in `.env.example` (`GUMLOOP_*`) for whenever the key exists, but not required |
| Digital Journey & Call Attribution report | `/reports/digital-insights` | Profile-driven (React) | ✅ built, swaps per customer — matched pixel-for-pixel to the live report (saved_report 52517). Opened from My Reports |
| Conversation Intelligence | `/reports/conversation-intelligence` | Profile-driven (React) | ✅ per-call analysis view (call details, network 2160). 3-col: call list / audio player + transcript (keyword highlights) / right rail with **interactive tabs**: **Analysis** (Signals + Call Scoring ring), **AI Summary** (AI recap of the selected call — paragraph + sentiment pill + outcome line + key-point bullets, from `aiSummary` which is `.optional()` so profiles predating it show a graceful "regenerate to include it" fallback), **Call Info** (call metadata from the selected call), plus Comments/Deliveries empty-state placeholders. `reports.conversationIntelligence` (optional); Shady Blinds hand-authored + engine generates it (incl. `aiSummary`, grounded in the transcript) per prospect. Opened from My Reports (2nd row, shown only when the profile has the data) |
| AI SMS Conversation Intelligence | `/reports/sms-conversation-intelligence` | Profile-driven (React) + **live capture** | ✅ SMS sibling of CI (network 2160 details). 3-col: conversation list / SMS transcript (Consumer person + AI-Agent purple sparkle) / tabs **Analysis** (signals) · **SMS Info** (4 metadata cards) · Comments. `reports.smsConversationIntelligence` (optional): **1 active example** (re-skinned, full transcript+signals+SMS Info) + **3 inactive shells** (id/time only, real-looking, non-clickable). **Headline feature:** closing the Agent Studio **Preview Agent** captures that chat via `SmsCaptureContext` and **prepends it as a new active conversation at the top** — captures accumulate (multiple stack) and **persist to localStorage with a 7-day TTL** (survive reloads for a week, then auto-expire; keyed per prospect, capped 25). Its Analysis signals are extracted fast via `POST /api/analyze` (Haiku) on close. Opened from My Reports (3rd row) |
| AI Voice Conversation Intelligence | `/reports/voice-conversation-intelligence` | Profile-driven (React) + **live capture** | ✅ Voice sibling of the SMS report — same 3-col layout (`VoiceConversationIntelligence.tsx`, reuses `.ci-`/`.sci-` styles): call list / spoken transcript / tabs **Analysis** (signals) · **Call Info** (call metadata cards: Call Record ID, Duration, Source, Connection Status, Consumer Data, Enhanced Caller Profile, Campaign Data) · Comments. `reports.voiceConversationIntelligence` (optional): **1 active example** (re-skinned) + **3 inactive shells**. **Headline feature:** ending the Agent Studio Voice **Preview** call (End Call, or drawer close mid-call) captures the call via `VoiceCaptureContext` and **prepends it as a new active call at the top** — accumulates + **persists to localStorage 7-day TTL**. Signals extracted via `POST /api/analyze` (channel `voice`) on end. Opened from My Reports (4th row) |
| Call Review | `/call-review` | Profile-driven (React) | ✅ built, matched to live (network 1750). `reports.callReview` is optional; Shady Blinds is hand-authored and the engine now generates it per prospect too. Customers without it (e.g. seed Mavis) show an empty state. The **4th call** (index 3) is always evaluated + 70s Quality Score and is **clickable → Call Detail**. The **Signals filter is live**: modal picks Yes/No/Not Applied on the conversion signal (`${bookingTerm}: Scheduled`) → pill + filters calls by each call's `converted` flag |
| Call Detail | `/call-review/detail` | Profile-driven (React) + interactive | ✅ drill-in from the 4th Call Review call (`CallDetail.tsx`, `reports.callDetail`, optional), matched to Invoca. 3 columns: left rail (Review Status checkbox, Evaluation select, **Scorecard** [click to expand → signal rows w/ met/unmet/na icons + points], **Signals** [click to expand → Met/Unmet/Not-Applicable groups, each expands to its signal list], Prompts accordions) · center transcript (search, Agent/Caller turns, "Estimated Conversation Start" divider, redacted PII shown as ****) · right AI Summary (agent/date/duration) + Comment. Sticky bottom audio bar. Re-skinned per prospect (a new-customer intake call); engine generates it |
| Agent Studio | `/agent-studio` | Profile-driven (React) | ✅ built, matched to live (network 2751 /ai_agents). One agent + two workflows (Voice + SMS) **derived from `customerName`** — no schema/engine change. Every row (agent + both workflows) links to the agent config editor |
| Agent configuration editor | `/agent-studio/agent` | Profile-driven (React) | ✅ the "Agent Settings" page opened from a workflow row (network 2751 /ai_agents/edit). Shared chrome in `AgentStudioLayout` (header + left sub-nav + sticky Cancel/Save/Publish footer); sub-nav icons match live MUI set (library_books/school/auto_awesome/transform). Agent Name/Brand = `customerName`, Profile = `networkName`; **Brand Conversation Rules** from `reports.agentConfig` (optional, engine-generated; component falls back to name-derived defaults). Sidebar keeps Agent Studio active (NavLink descendant match) |
| Knowledge Sources | `/agent-studio/agent/knowledge` | Profile-driven (React) | ✅ Agent Studio sub-page (uses `AgentStudioLayout`). Table of docs + main website links the agent learned from (Status/Name/Type/Last Updated/Refresh); search + Upload/Add-Web-Links buttons + pagination. From `reports.agentConfig.knowledgeSources` (optional; falls back to brand-domain-derived defaults), engine-generated per prospect. **Feeds the planned SMS agent's knowledge** |
| AI Recommendations | `/agent-studio/agent/recommendations` | Profile-driven (React) | ✅ Agent Studio sub-page (uses `AgentStudioLayout`). AI Q&A recommendation cards from call transcripts, each with an on/off toggle (interactive), sparkle+title (blue when on, grayed when off), updated date, and a truncated JSON payload. Clicking the **Qa pairs** card opens the **"Edit AI Generated Q&A" modal** — top ~20 {question,answer} pairs (`aiRecommendations[].qaPairs`), scrollable, Cancel/Done. From `reports.agentConfig.aiRecommendations` (optional; falls back to defaults), engine-generated per prospect. **Q&A pairs + intent follow-ups feed the planned SMS agent** |
| Agent Workflow (Definition) | `/agent-studio/agent/workflow/:channel` | Template (React) | ✅ Agent Studio sub-page (uses `AgentStudioLayout`); opened from a workflow in the left sub-nav or the Agent Studio table (voice/sms). Definition/Details tabs + Flow/Table toggle + dotted-canvas **flow diagram** (`AgentWorkflow.tsx`) — **channel-specific tree**: **SMS** (`FlowTree`) = Triggered by → Conversation Start → Sales Inquiry / Need Support → green "Schedule `<bookingTerm>`" leaf (chips Consumer Name/Interest) + orange "Support & Escalate" leaf, zoom + minimap. **Voice** (`VoiceFlowTree`) = the qualify-and-route tree, **matched to Invoca's real Voice workflow** (`agent-management-v2` HTML): **248px** nodes in two columns (48px gap), **exact MUI SVG icons** (Bolt/Chat/ShoppingCart/Headset/AltRoute, grey `#5b6577`), intent nodes carry caller-intent subtitles; green "**Inform & Route**" leaf (AltRoute icon, chips Room Type/Product Type/Timeline) + orange "**Support & Escalate**" leaf (chips Order Number/Order Issue), leaf-action colors from Invoca tokens (green `#0d7a3e` / orange `#b33b00`); "2 campaigns" trigger, taller canvas, minimap hidden. Buttons are **channel-specific**: **SMS** shows **Preview Agent** (filled, opens the iPhone chat) + **Preview Workflow**; **Voice** shows only **Preview Workflow**, which slides in a right-side **voice-preview drawer** (`VoicePreviewIllustration.tsx`: gray header bar, calls illustration, "Preview Your Voice Agent"; starts 20% down / 80% height, no dim). **Start Call** launches the live **Voice call** (`VoiceCall.tsx`) inside the drawer body; End/close returns to the empty state. Template; title/channel from profile + `:channel` |
| Preview Agent (live SMS chat) | **own browser tab** `/agent-studio/agent/preview` (opened via `window.open` from Agent Workflow's Preview Agent button; `SmsPreviewPage.tsx` → `PhonePreview.tsx` `mode="page"`, full-page dark `.phone-page` fixed inset:0, outside the app shell) | Profile-driven (React) + live AI | ✅ iPhone mockup where the SE role-plays a customer texting in; the SMS agent replies **live** via `POST /api/chat`. **Captured to the AI SMS Conversation Intelligence report PROGRESSIVELY** (not on close): a `useEffect` on `messages` upserts the conversation (stable `ConvBase` id/time/callerId per session) after every turn and debounces `POST /api/analyze` (1.2s) to fill signals — all while the tab is open, so nothing is lost when it closes and signals actually get generated (the old capture-on-close killed the analyze fetch). Because it runs in a SEPARATE tab, `SmsCaptureContext` writes localStorage **synchronously** and a **`storage` event listener syncs the report tab live** (no refresh). `PhonePreview` still supports `mode="modal"` (legacy) but the button opens the tab. (fast **Haiku** model, `engine/chat.ts`). System prompt built from the profile's agent brain (customerName, industry, `brandConversationRules`, Q&A `qaPairs`, knowledge-source names). Agent opens with a greeting, keeps SMS-short one-question-at-a-time, qualifies, and **confirms a day/time by text** (no booking card). Green outgoing / gray incoming bubbles, typing indicator, markdown stripped. Dev-only endpoint (key server-side, like `/api/generate`) |
| Voice Call (live phone call) | Start Call in the voice drawer (`VoiceCall.tsx`) | Profile-driven (React) + live AI | ✅ Realtime spoken call, **Claude stays the brain**. Ears = browser **SpeechRecognition** (STT); brain = Haiku via `POST /api/chat { voice: true }` — a **DIFFERENT prompt from SMS: qualify-and-ROUTE** (`buildVoiceSystem` in `engine/chat.ts`), NOT the SMS sales flow. Two paths: **new order** → **ZIP first** (serviceable-area gate, demo rule: only ZIP **`12345`** is out-of-area → apologize (naming `agentConfig.serviceArea`) + stop, no routing; **any other ZIP proceeds**; empty serviceArea = national business, no gate) → room → style → timeline → route (urgent = hot lead to a design consultant; browsing → browse support), and **existing order/support** → order number → issue type → route to the right team (delivery→fulfillment, installation→installation support, else→support). Never quotes prices/availability/promos, never resolves — only qualifies + hands off. mouth = **premium voice** (Deepgram Aura or ElevenLabs) via `POST /api/tts` (`engine/tts.ts`, key server-side) played through an `HTMLAudioElement`, with an automatic **fallback to the browser voice** when no provider key is set/errors (never silent). **Strictly turn-based** — the agent always finishes its turn before listening; the caller talking does NOT interrupt it (**barge-in off by default**, `ALLOW_BARGE_IN = false`; flip to re-enable talk-over via Web Audio VAD). Web Audio VAD stays on only to drive the listening mic meter. Turn state machine connecting→speaking→listening→thinking; all async work gated behind an `aliveRef` (StrictMode-safe). Call UI: purple AI-glyph avatar with speaking/listening pulse rings, status + call timer, live-captions transcript, ref-driven mic meter (via `--vc-level` CSS var, no re-renders), Mute + Keypad + red End controls. **On End Call** (or drawer close mid-call) the call is captured via `VoiceCaptureContext` and **prepended to the AI Voice Conversation Intelligence report** (transcript + call info instant; signals via `/api/analyze`). A **"type instead" fallback** shows when the mic is blocked/unsupported (and is how it's verified in the preview pane, which has no mic). Chrome/Edge only for real voice; STT no-ops silently elsewhere. Voice/model overridable via `ELEVENLABS_VOICE_ID` / `ELEVENLABS_MODEL_ID` (default model `eleven_multilingual_v2` — best/most human; use `eleven_turbo_v2_5`/`eleven_flash_v2_5` for lower latency) |
| Signal (Manage Signals) | `/signal` | Profile-driven (React) | ✅ matched to the real Invoca page (`reference/signal/manage-signals.html`, network 1847 `/manage_signals`). Two hero cards (Upload Signal Records / View API Documentation) over a MUI-DataGrid-style table. **Column widths come straight off the capture's inline styles** — checkbox 50 / Name 200 / Status 100 / five 123.8 columns / Rules 197 / Created At 150 / Last Updated 150 / Actions 123.8, header row 56px — so the columns land where the real ones do. `reports.signalManager` (optional): **10 signals covering three groups** — 3 CONVERSIONS (tagged "Conversion", one is `<bookingTerm> Booked (Conversion)`), 3–4 QUALITY (scorecard-backed), the rest PRODUCT / INTENT (product interest, price sensitivity, competitor named). `rules` holds REAL Signal syntax (`voice_signal = any(1, ["phrase (Agent)", …])`, `scorecard[Name] < 60 and duration > 45 sec`, `duration < 1 min`) with the spotted phrases re-skinned — that string is what makes the screen read as the product rather than a mock-up. **The single conversion row renders FIRST**, then the rest name-sorted like the real grid — a deliberate deviation (the real one is purely name-sorted) because a later screen drills into that row and it must not be buried. `SignalManager.tsx` re-applies the order at render, so a generated prospect leads with its conversion whatever order the model emitted. The Rules cell line-clamps to 4 lines (the real one ellipsises), which is what keeps row heights compact. Emotion's runtime CSS did NOT serialise into the saved page, so colours came from our tokens measured against the screenshot. Engine phase `signalManager` generates it per prospect |
| Manage Dashboards | `/dashboards` | Profile-driven (React) | ✅ list page the Dashboards nav lands on; one row per built dashboard (add rows in `ManageDashboards.tsx` as more are built) |
| Marketing Performance Dashboard | `/dashboards/marketing` | Profile-driven (React) | ✅ built, swaps per customer; opened from the Manage Dashboards list |
| Marketing & Operations Performance | `/dashboards/marketing-ops` | Profile-driven (React) | ✅ 2nd dashboard (`reports.opsDashboard`, optional): KPI groups + 4 HBarChart+table sections + 2 tables + stacked "No Booking" chart. Reuses dashboard-1 CSS; engine generates it per prospect |
| AI Agent Conversion Dashboard | `/dashboards/ai-agent-conversion` | Profile-driven (React) | ✅ 3rd dashboard (`reports.aiAgentConversion`, optional), built from screenshots (`AiAgentConversionDashboard.tsx`): "AI Agent Performance Summary" KPI group + **6 conversion cards** (Lead Form + Voice Agent, each with filter chips + Job Complete% / Total Revenue tiles, `.aac-*` CSS) + 4 donut+table breakdowns (Source/Medium/Campaign/Search Term; donut %-labels use `Breakdown.donutTotal`) + Product Category table + StackedBarChart. Reuses the shared `.dash-`/`.breakdown-`/`.kpi-` template + DonutChart/StackedBarChart; engine generates it per prospect |
| Quality Management (QM Actionable Insights) | `/dashboards/quality-management` | Profile-driven (React) | ✅ 5th dashboard (`reports.qualityManagement`, optional), matched to the real Invoca page (`reference/quality-management/*.html`, network 2982). **Layout = the real 3-col gridstack**: Row1 Sales Opportunities **2/3** \| Sales Conversions **1/3** (`.qm-row-21`); Rows 2/3/5/6 left **1/3** \| right **2/3** (`.qm-row-13`); Rows 4/7/8 full width. 13 tiles: 4 KPI cards (ConversionCard title+chips+tiles), Calls Needing Review + Bottom/Top Quality Scores HBars (the two by-agent bars show a `pager` "1 - 6 of 30"), Highest Converting Agents stacked bar (**9 weeks × 5 agents**), Bottom/Quality Scores tables, and 3 **BarLineChart**s: Baseline Sales Quality Score (bars + red dashed avg line w/ a value badge) + the two Trending charts (**dual-axis**: bars=left %, orange line=right count/revenue via `rightLabel/rightMax/rightTicks/rightPrefix`). Platform metric labels verbatim; agents/scorecards/vertical terms re-skinned. Engine composes scaffolding + deterministic daily points; model generates compact `QmGen` content |
| QM Instant Insights | `/dashboards/qm-instant-insights` | Profile-driven (React) | ✅ 6th dashboard (`reports.qmInstantInsights`, optional), matched to the real Invoca page (`reference/quality-management/*Instant*.html`, network 2982). QA at-a-glance: Trending Essential Metrics full-width (BarLineChart, **line-primary + DUAL-axis**: blue AHT line on left time axis, orange Negative-Sentiment **bars on the RIGHT axis** 0–120%; passed `height={150}` = 50% shorter), Essential Metrics **2/3** \| Trending Answer Rate **1/3** (`.qm-row-21`; answer rate = line-only, zoomed `yMin` 65–100), Contact Center Metrics, Overall Evaluation Score **1/3** \| Evaluation Rollup **2/3** (`.qm-row-13`), Scored Calls by Evaluator table. `BarLineChart` supports the SECONDARY series on the right axis (bars-on-right when `linePrimary`, else line-on-right). Engine composes charts; model supplies compact values (`QmInstantGen`) |
| AI Messaging Impact (Human vs AI) | `/dashboards/ai-messaging-impact` | Profile-driven (React) | ✅ 4th dashboard (`reports.aiMessagingImpact`, optional), built from screenshots (`AiMessagingImpactDashboard.tsx`): paired **1/3 + 2/3 KPI cards** (`.aim-row`) — AI (This Month) vs Human (Last Month, grey chip) for Lead Engagement + Appointment Performance — then AI-Assisted Appointment Trend **LineChart** (49 daily pts, flat→jump; sparse x-labels), AI-Assisted Opportunities + AI Lead Nurture tiles, and a **Common Topics** StackedBarChart re-skinned to the prospect (window-treatment topics for Shady Blinds). Reuses the shared template; engine generates it per prospect |
| Integrations (in-platform) | `/integrations` | Profile-independent (React) | ✅ Invoca's OWN in-platform page (`action_collections/ui`), measured live 8/24/2026. Search + INTEGRATED/LIBRARY sections + 48 cards with the real logos. **Two cards navigate**: Google Ads -> the captured Ads console, ChatGPT Ads -> the sponsored-ad screen. See its own section below |
| Invoca Exchange (marketing site) | `/invoca-exchange` | **Exact static copy** (identical for all customers) | ✅ real page served — KEPT, just no longer what the sidebar opens |
| Google Ads Search Keywords | `/integrations/google-ads` | **Exact static copy** | ✅ real page served |
| Google Ads AI + undo (in-page) | n/a | Static + JS | The Ads page is a saved document, NOT a React screen, so the platform's Ask AI drawer cannot render there. `google-ads-demo.js` injects a compact equivalent: sparkle + undo left of the Ads **SEARCH** icon, hover-revealed on `.iga-zone` (same always-hold-layout-space-and-fade contract as the top bar), a small drawer, and the SAME `/api/ai-assistant` endpoint. **Rule 2 is structural here**: an edit only lands when its path names one of six fields (`keyword`, `campaign`, `adGroup`, `conversion`, `impressions`, `clicks`) and its value is a string or number, so there is no route from a reply to CSS or layout whatever the model returns. State persists per prospect (`invoca-demo:google-ads-ai::<id>`) and undo is one step at a time. ⚠️ Two traps found while building it: the capture ships **"Material Icons Extended"**, not "Material Icons" (asking for the latter renders the ligature as the literal text `auto_awesome`, 119px wide), and the injected `demo-back-nav` click rule now **excludes `.iga-zone`/`.iga-wrap`** — it is capture-phase so the assistant cannot stop it, and the drawer's backdrop covers the `x<255, y<60` logo region, so dismissing the drawer there used to navigate out of the page. ⚠️ A null field means "keep the capture's own value", so `ORIGINAL` snapshots each cell's text BEFORE the first write; without it, undoing impressions back to null left the edited number on screen instead of restoring 1,560. |
| Google Ads per-prospect overrides | n/a | Static + JS re-skin | `public/google-ads-demo.js` re-skins the captured console from the active profile in localStorage, all from the prospect's OWN dashboard data: **keyword** = the top `Calls by Search Term` row (a real phrase somebody types, e.g. "emergency room near me" — it used to be `callReview.searchSuggestions[0]`, which are single transcript words like "monitoring" and read as a transcript search rather than a paid keyword), **ad group** = a `Conversions by Product Category` row picked by word overlap with the keyword (an ad group contains its keywords, so "used cars…" in a "New Cars" ad group looked fake; **two** shared words minimum, because one matched "continuing CARE" to "Memory Care" over the better "Independent Living"), and **conversion** = `<bookingTerm> Booked` ("Appointment Booked", "Tour Booked"). `OVERRIDES` is now EMPTY on purpose: the vector-security entry set the keyword by hand to exactly what the Search Term row already returns, so it was pure drift risk. Both defaults are borrowed from other screens and can read wrong for an ads account (searchSuggestions are single CALL REVIEW transcript words like "monitoring", not phrases anyone types into Google). Fix that in the `OVERRIDES` table at the top of that file, keyed by profile id, NOT in the profile: editing `searchSuggestions` makes the Call Review search placeholder suggest a term matching no summary, and editing `bookingTerm` renames the Agent Workflow leaf, the dashboard KPIs and the CI signals with it. Currently overridden: **vector-security** (keyword "home security systems near me", conversion term "Quote") |
| Google Search results | `/google-search` | Profile-driven (React) | ✅ dark-theme google.com/search with the PROSPECT in the top sponsored slot, opened from the green **Network** chip in the top bar (`TopBar.tsx`; the chip is a button, the `<select>` beside it is still the customer switcher). Matched to a SingleFile capture, measured off the rendered DOM: page `#22242a`, text `#e8e8e8`, link `#99c3ff`, place action `#a8c7fa`, hairline `#444746`, pill `#2c2e35`, search pill `#4d5156` 694x52 r26, results column x=122 w=652, result title 22/28, sitelink 18/26, place name 18/24, Places head 28/36, local pack 876 wide with a 438 map column. Sections in capture order: location chip, Sponsored Results (4 ads, stacked sitelink rows on the first), Places pack (list + Mapbox night map with pins, prospect repeated as a Sponsored place), organic results, a SECOND Sponsored Results block (inline chips + visits line), more organic, People also search for, Goooogle pager, footer. **Clicking the prospect's ad opens their site with the paid parameters**: `oppref` + `utm_source=google` + `utm_medium=cpc` + `utm_campaign=<their top campaign from the Marketing Performance dashboard>` + `utm_term=<the query>` + `utm_content` + a deterministic `gclid`. Only the prospect's ad is a real link; the rivals are inert by design. The ad's call extension uses the reserved **555** exchange with the prospect's own area code, so it reads local but cannot ring a real business. The search box is editable and Enter re-renders the wording (and `utm_term`) without pretending to search. The logo goes back to where the SE came from. "Google Sans" is not bundled, so headings fall back to Roboto/Arial |
| All other nav items | various | Placeholder | ⏳ not built |

### Signal → Semantic Signal Library (`/signal/new/semantic`)
`SemanticSignalLibrary.tsx` + `.ssl-*`, from the capture "Semantic Signals｜ Invoca For
Telecom 2.0" (8/6/2026; real URL `/manage_signals/semantic_signal/template`). Reached from
Semantic Signal's SELECT on the type-select. Fifteen template cards, each with a speaker chip
(Agent/Caller), the Invoca publisher mark, a 3-line-clamped description and an Activate button.

Measured, since this page serialises in full: grid 1/2/3 columns at 0/600/900px with a 24px
gap; card `min-height: 280px` / `max-height: 400px` with the MUI elevation-1 shadow and a
`translateY` lift on hover; title 20px/28px with `flex: 1` (that is what pushes the speaker
chip right); speaker `rgb(102,112,142)`; body clamped to 3 lines; Activate pushed right with
`margin-left: auto`.

**THE 15 TEMPLATES ARE INVOCA'S OWN and must NOT be re-skinned per prospect.** This is the
platform's stock library — identical in every account — and the descriptions are Invoca
product copy. The prospect's own signals live on Manage Signals, which IS profile-driven. The
publisher mark is inlined SVG (`#02B388`), not the capture's base64 `<img>`.

The search box filters on name AND description, so "resistance" finds Objection Handling and
"hold" finds Put On Hold. A title-only filter would be a prop. Activate returns to Manage
Signals until the activation flow is built (and it stops propagation, or it would also open
the drawer on its way past).

**Hover LIFTS AND TINTS** — `translateY(-0.25rem)` with `background-color: rgb(212,224,254)`
(titan blue-10), `rgb(176,205,255)` on active. Both are the capture's own values; the lift
alone was half the effect.

**Clicking a tile opens a 500px right drawer** (`.sdr-*`, capture "Semantic Signals 2"):
title, publisher, description, Spoken By, Suggested Use, the phrase list, and a sticky
Close/Activate footer the list scrolls under. Same MuiDrawer chrome as the Insights
interaction drawer but the SMALL width token — 500px against that one's 800px.

⚠️ **PHRASE PROVENANCE IS UNEVEN — see the note atop `src/data/semanticSignals.ts`.** Only
ONE drawer was open when the capture was saved, so "Ask for Appointment" has all 44 of its
real phrases; "Ask for Sale" and "Competitor Mention" have the 13 and 14 visible in the
screenshots (real, but cut off by the viewport); the other **12 templates' phrases are
AUTHORED, not captured**, and their Suggested Use is inferred. Replace any list marked
`captured: false` when a real drawer capture turns up.

### Signal → Edit Rule Signal (`/signal/rule`)
`EditRuleSignal.tsx` + `.ers-*`, from the captures "Edit Rule Signal" (one condition) and
"Edit Rule Signal 2" (four, plus the advanced section), both 8/6/2026; real URL
`/manage_signals/rule_signal/edit/<id>`. **Every signal row on Manage Signals opens it**,
carrying its own name in `?name=`, so a Shady Blinds row titled "Consultation Booked
(Conversion)" heads the editor with that, not the capture's "Appointment Booked".

Measured: terminals are literally `border: 2px solid rgb(38,102,249)`; chips 16px radius; the
join select 70px; the value box 1px `rgb(208,211,216)` at 4px radius. **All 31 terminals are
verbatim** in three groups (Call Details 21, Reported Data 5, Invoca Platform Details 5) —
Invoca's rule-builder vocabulary, identical in every account, NOT re-skinned.

**The rail actually builds the rule.** Clicking a terminal appends a condition with an "and"
join (switchable to "or"); the × removes one; TEXT renders the same rule as a sentence. Two
things that only show up once it is interactive:
- Deleting the FIRST condition must strip the new head's join, or the rule renders with a
  dangling "and" in front of it.
- A value box renders **only for a condition that has a value**. In the capture just Spoken
  Phrases does; the other three chips sit bare with the next "and" straight after. Rendering
  an empty box for every condition also wrapped the row a condition early.

### Signal → New: the source type-select (`/signal/new`)
`SignalTypeSelect.tsx` + `.sts-*`, from the capture "Signal /new signal.html" (the real URL
is `/manage_signals/type-select`). Reached from **New Signal** on Manage Signals, which is
now a `<Link>`. Three cards — Semantic Signal (with the NEW! corner ribbon), Signal AI Studio
(Recommended), Rule-based Signal — over a divider and a Cancel button.

This page is Invoca's own MUI markup and serialises in full, so every value is measured:
lede 24px/36px `rgb(81,133,250)` with 32px below; cards 3px radius, 1px border, no shadow;
ribbon a 110px square clipping a `-45deg` band in `#5185fa` at `700 15px/1` uppercase.

**The illustrations are Invoca's own icon sprite**, lifted out of the capture to
`public/signal-sprite.png` — 4468×236 drawn at `background-size: 2234px`, i.e. a 2x asset, so
the capture's `background-position` values are used verbatim (`-706px 0` splash, `-1618px
-27px` semantic, `-1859px -31px` AI, `-2051px -27px` rules). Using the sprite beats cropping
four images by hand, and the rest of the platform's illustrations are in it if a later Signal
screen needs one.

Nothing here is re-skinned per prospect: every word is Invoca product copy describing Invoca
features, and no customer data appears on the page.

⚠️ The grid is `repeat(auto-fit, minmax(290px, 1fr))`, not `repeat(3, 1fr)` with a
breakpoint. Two reasons: a fixed three-up squeezes the text column to ~160px on a narrow
window, and **grid only equalises card heights within a ROW** — when it wrapped to one column
the cards stopped matching and the three SELECT links fell out of line. At the reference's
width all three sit in one row at 517px and their SELECTs share a baseline.

SELECT and Cancel both return to `/signal` for now; point each SELECT at its builder as those
screens arrive.

### Sidebar (left nav)
**Signal opens a FLYOUT, it does not navigate.** A `NavItem` with a `submenu` renders as a
`<button>` instead of a `NavLink` and opens a dark panel beside the rail — measured off the
capture "Signal /Singal Box.html": 230px wide, `left: 82px`, `#2c3951`, radius 5, shadow
`0 2px 4px rgba(12,0,51,.2)`, 12px bottom padding only; heading 20px/28px bold uppercase at
`24px 24px 12px`; links 16px/16px at `6px 24px`. Signal is the only item with one today; any
item can have one.

Three things that are easy to get wrong here:
- The panel must be **`position: fixed`**, anchored to the button's own rect. `.nav-scroll`
  is `overflow-x: hidden`, so anything positioned inside the rail is clipped at 86px.
- It **follows its rail item as the rail scrolls.** Reading the button's top once at click
  time leaves the panel behind the moment the nav scrolls, so a `useLayoutEffect` re-reads
  the rect on the SCROLL CONTAINER's scroll event (`.nav-scroll` scrolls, not the window)
  plus window scroll and resize. Layout effect, not effect, so it is never painted at a
  stale offset. Verified delta 0 at every scroll position across the rail's full range.
- The outside-click listener runs on **`pointerdown` in the capture phase**. On bubble, a
  second click of the Signal item would close the panel here and immediately reopen it in the
  button's own onClick.
- `button.nav-item` needs the browser's button styling removed so it sits flush with the
  `<a>` items; everything else comes from the shared `.nav-item` rule so the two cannot drift.

The parent highlights for any route beneath it (`/signal/discovery` keeps Signal green), and
navigating closes the panel. Destinations: Manage Signals -> `/signal` (SignalManager, real),
Signal AI Studio -> `/signal/ai-studio` and Signal Discovery -> `/signal/discovery`, both
**Placeholders awaiting captures**.

Matched **exactly** to the live network 2751 nav: **14 items** in order —
Dashboards, Call Review, Agent Studio, Profiles, Campaigns, Lead Forms (NEW),
Publishers, Promo Numbers, Reports, Integrations, Signal, Score, Labs, Settings.
The main list scrolls (`.nav-scroll`) and **Settings is pinned to the bottom**,
like the real rail. Active item = green text/icon + `4px` green left bar
(`#0a830e`) + `#f5f6fa` background; icons 24px, labels 12px, items 60px tall.
Icons are the real glyphs: Material Icons ligatures where the platform uses them
(dashboard, phone_forwarded, supervisor_account, dialpad, equalizer, device_hub,
explore, assignment_turned_in, settings) and exact inline SVG for the custom
glyphs (Call Review, Agent Studio, Profiles, Lead Forms, Labs) in `nav.tsx`.
⚠️ The full nav has 14 items — the list scrolls, so don't assume the last item
you can see is the last item (that mistake once dropped Integrations/Signal/
Score/Labs). Re-derive the whole set from the saved HTML's `data-nav` `<li>`s.

### Dashboard styling (matched to live, from saved "Dashboard _ Invoca for Home Services.html")
The dashboard is a gray page (`--color-bg-page`) with a grid of **white tile
cards**, each: white bg, `border-radius:4px`, soft two-layer shadow
`0 1px 1px 0 rgba(0,0,0,.1), 0 1px 5px 0 rgba(0,0,0,.1)`, ~10px gaps.
GOTCHA: the saved HTML is the dashboard **builder/edit** view (gs-id="builder"),
which renders tiles FLAT (no shadow). Don't measure tile borders/shadows from it
— the view-mode style lives in `common-3b9dc252.css`
(`.grid-stack-item-content{...box-shadow:0 1px 1px..., 0 1px 5px...}`). Font sizes
DO measure correctly off the rendered builder nodes.
Measured values now in the demo: page title 29.7px; tile titles (h2) 26.4px
`#3d3d3d`; KPI value 36px/700 `#15243e`, label 14px; KPI divider = `::before`
bar **4px × 63px `#f5f6fa`** between cells (not full-height borders). Breakdown
tables use `table.dash-table` (NOT `table.report`): th 14px/700 `#343a40` with
1px `#e7e9eb` bottom rule; td 14px, 12px padding, 1px `#e7e9eb` top rule, **no
striping, no sort carets**. Chart palettes: donut `#2666f9 #129922 #f5575a
#009788 #a182e5`; line/stacked `#2666f9 #ff7045 #f3cb00 #00d1b4 #a182e5`;
gridlines `#e7e9eb`. **Chart legends** (`StackedBarChart`/`LineChart`) truncate
long series names to fit their slot with an "…" (full name kept in an SVG `<title>`
for hover) so they never overlap the next legend item.
**Shared header/chip conventions (all dashboards must match):** every dashboard
header uses the SAME `.title-actions` set — `file_download`, `history`, a blue
**Add Tile** `.save-btn`, then `more_vert`. Accent color is **`#2666f9`**: the
Add Tile button (white `+`), the "Manage Dashboards" `.breadcrumb a`, and chart
blue. Header icons (download/history/kebab) are `#5b6577` to match the topbar
star. Filter chips (`.aac-chip`, used by AI Agent Conversion / QM / QM Instant /
AI Messaging) are **pills** (`border-radius: 999px`). AI Agent Conversion: LEAD
FORM cards use "Interaction Type: Form Fill", Voice Agent cards use "Interaction
Type: Voice".
Gotcha: the saved dashboard HTML doesn't render as-is (gridstack/MUI position
tiles at runtime) — reconstruct by absolutely positioning `.grid-stack-item`s
from their `gs-x/y/w/h` attrs (3-col grid) and clamping `svg.MuiSvgIcon-root`
to 24px, then measure computed styles.

### UI convention: show the customer name, not the network name
Across the whole app, display `profile.customerName` (e.g. "Shady Blinds"), NOT
`profile.networkName` ("Invoca for Home Services"). The top-bar network selector
and the Launch "Your prospects" list already do this. `networkName` stays in the
data but isn't shown. Apply this to any new screen that would surface it.

### Page chrome & backgrounds (matched to live)
Gray chrome, white content: **topbar `#f6f7f9`**, **sidebar `#f5f6fa`**, page `#f6f7f9`.
The Digital Journey report is one **white panel** (`.report-surface`: `#fff`, 1px
border, `0 2px 4px` shadow, top-left corner rounded `5px`). `.main` is **full-bleed
(no padding)** so that panel sits flush against the sidebar/topbar like the real
page — non-report screens add their own padding (`.dash-page`; `.placeholder` self-pads).

### Before Invoca sees the call: the two paid-placement screens
`src/data/prospectPlace.ts` is shared by **`GoogleSearch.tsx`** and
**`ChatGptAd.tsx`** and owns everything both need to agree on: `derive(profile)`
(location, the invented rivals, hero product, the search query, the offer),
`CITY_LL`/`lookupLL`/`DEFAULT_PLACE` (geocoding, fallback Santa Barbara),
`trackedSiteUrl()` (the `oppref` token) and the Mapbox helpers. It lives outside
both screens because the same prospect must land in the same city against the
same competitors on both, and two copies would drift on the first fix.
⚠️ **Label and coordinates must always resolve TOGETHER.** `derive` falls back
label-and-all when it cannot geocode; recombining a fallback city with a live
screenpop state printed "Santa Barbara, TX" for Reyes Law. If you build a
location string, take BOTH halves from one source.
⚠️ Competitor names, directories and review counts on both screens are
**invented** from city + industry. The real captures name real businesses with
real ratings; reproducing that shape with fabricated copy would put words in a
named company's mouth. `derive` also rejects any rival name sharing two
significant words with the prospect (that is what stopped "Orlando Health
Systems" appearing beside the real Orlando Health).

### Salesforce Seller Home REBUILT off a newer capture (8/27/2026)
Asked for directly: "let's actually recreate the salesforce page, I found a newer page, since
now you know what to look for, replicate this page perfectly." Capture:
`reference/salesforce/seller-home-v2.html`
(`invocafforhomeservices.lightning.force.com/lightning/page/home`).

**Salesforce has restyled this page, so almost every measured value changed.** The rebuild is
the same method as last time — dump one property set off the capture's rendered DOM, dump the
same off ours, fix until the diff is empty — at BOTH 1500 and 1920.

| | 8/24 capture | THIS capture |
|---|---|---|
| card | radius 4, 1px `#C9C9C9`, `0 2px 2px` shadow | **radius 20, no border, no shadow** |
| card heights | 333 / 370.5 / 396.5 | **338 / 400 / 376** (re-measured 4-across, below) |
| card title | `700 16/20` `#181818` | **`400 20px/25px` `#03234D`** |
| h1 | `300 28/49` `#181818` | **`300 32px/56px` `#03234D`** |
| ring value | `300 28/33` | **`300 32px/40px`** |
| footer button | full width, radius 4, `#0176D3` | **centred pill**, radius 240, 1px `#5C5C5C`, **`#0250D9`**, 600 |
| brand button | `#0176D3` | **`#066AFE`** |
| legend pill | radius 4 | **radius 8** |
| record tile | 32 square, radius 4 | **32 CIRCLE**, radius 100% |
| nav bar | white, **3px `#0070D2`** rule | white, **no rule**, `0 2px 4px rgba(0,0,0,.07)` |
| nav item | 37 tall, `#181818` | **32** tall, **500** 13/19.5 `#03234D` |
| active tab | `rgba(0,112,210,.1)` **wash** | ink `#0250D9` + a **3px underline**, radius 12 |
| search | radius 4, 1px `#747474` | radius **8**, 1px **`#5C5C5C`** |
| the + button | grey, radius 4 | grey, **radius 240** (a circle) |
| favourites | one star | a **split pair**, 26 + 22, mirrored radii |
| cards | 8 | **9** — Salesblazer sits alone on row 3 |
| tabs | 16, incl. Calendar | **14**, incl. **Invoca Call Log**, ending in **More** |

⚠️⚠️ **THE CARD BODY IS TWO 50% COLUMNS, EACH CENTRING ITS CONTENT — and only the two-width
rule reveals it.** The ring starts 34px into the body at 1500 and **30** at 1920; the legend's
dot 63.65 and 60 into the right half. Centring each in half the body gives (218.35-150)/2 =
34.2, (210-150)/2 = 30, (218.35-90.1)/2 = 64.1 and (210-90.1)/2 = 60 — all four land. Fixed
offsets reproduce one width and drift at the other, which is exactly what that rule exists for.
The card widths solve the same way: `flex: 1 1 440px` + 24px gap gives 462.67 at 1500 (3 per
row) and 446 at 1920 (4 per row), both measured.

⚠️⚠️ **"THE TILE IS TRANSPARENT, THE COLOUR MUST BE BAKED INTO THE PNG" WAS WRONG, and the
PNGs are what disproved it.** Probing `img.closest('span,div')` lands on `.uiImage` — 32
square, transparent, radius 0 — so the record tiles read as having no fill. Decoding the
extracted PNGs showed them only **~16% opaque**, i.e. white glyphs on transparent, which cannot
produce the coloured circles the capture plainly shows. The fill lives TWO levels further up on
`.slds-media__figure`: 32 square at **radius 100%**, Lead `#06A59A`, Invoca Call Log `#8B85F9`,
Account `#5867E8`, Contact `#9602C7`. Same family as the check-`background-image` lesson one
section down: **when a probe says "nothing paints this", walk further up before believing it.**

⚠️ **ONE MISSING 12px MARGIN PRODUCED FIVE DIFFS.** Dropping the header's `margin-bottom: 12px`
while rewriting put the subtitle, the ring, its value, its label and the legend all 15 to 37px
high. The diff named five failures with one cause, which is the argument for diffing positions
rather than eyeballing a screenshot.

⚠️ **THE ACTIVE TAB IS AN `::after`, NOT A BACKGROUND** — `top: 32px; bottom: -3px; left/right:
0; border-radius: 12px; background: #0250D9`, a 3px rounded bar under the tab. An INACTIVE tab
carries the same pseudo element with a dark navy fill, hidden rather than absent, so "does it
have an ::after" would light every tab up.

⚠️ **"Sales" IS NOT IN THE LOGO.** `.slds-global-header__logo` (200 x 40) contains a
`slds-assistive-text` span reading "Sales" that measures 0 x 0; the visible app name is a
separate `400 20px/25px` element one row down, on the NAV row at x=60. Reading the assistive
text as the label puts the app name in the wrong row.

⚠️ **PLAN MY ACCOUNTS' RING IS TWO FILLED ARCS**, outer r=75 inner r=69, `#0D9DDA` for the 1
account with past activity and `#FE5C4C` for the 3 without. Every other ring really is a
`<circle r=72>` with a 6px stroke, so both shapes are drawn the way the page draws them.

⚠️ **TWO NEW ASSETS EXTRACTED VERBATIM**: `invoca-call-log.png` and `account.png` (both 120x120).
⚠️ **THE LEAD GLYPH IS STILL A PLACEHOLDER** — `<svg><rect fill-opacity="0"/></svg>`, exactly
like the call-log icon in the older capture. It is drawn by hand in `SldsIcon` and flagged
there; it is the only authored glyph on the screen. Replace it when a capture carries the real
one.

⚠️⚠️ **THIS ORG'S NAV HAS NO CALENDAR TAB, which breaks a documented click path.** The flow is
"Seller Home -> Calendar -> the appointment the SMS agent booked", and this bar ends Chatter,
Groups, **More**. Keeping a Calendar tab would invent one this org does not have; dropping it
dead-ends the demo. **More** is the overflow menu, which is where such a tab lives, so it
carries the route and highlights on the Calendar screen. Smallest available departure, and
raised with the user rather than decided quietly — give me a capture of the More menu and it
becomes a real dropdown.

**Verified: a 29-property diff came back empty at 1500 and a 6-property one at 1920** (card
width, gap, inset, ring and legend offsets, cards per row), 9 cards, zero broken images, the
record tiles carrying their four measured colours. The Calendar screen still renders under the
updated chrome (week grid, the 11am event, the mini calendar), and `/dashboards/marketing` is
untouched — 21 cards at 4px radius, KPI 48,293, 7 donuts, **zero `.sfh-` elements**.

#### Then: four tiles per row, always (8/27/2026)
"No, each row on the salesforce main screen needs to have 4 tiles in each row just like the
real page." The faithful rule was `flex: 1 1 440px` + 24px gap, and it *is* what the capture
does — but that yields **4 per row at 1920 and only 3 at 1500**, so on a laptop the page
stopped looking like the screenshot everyone pictures. Now `grid-template-columns: repeat(4,
1fr)`.

⚠️⚠️ **THE ROW HEIGHTS WERE MEASURED AT A WIDTH WHERE THE CAPTURE WRAPPED DIFFERENTLY, so
they described rows this build no longer has.** 338 / 366.5 / 400 came off a 3-across
reading; re-read at 1920, where the capture is genuinely 4 across, the rows are **338 / 400 /
376** — Salesblazer is the SHORT card, not the tall one. *A row height is only meaningful
together with the row's membership.* Any per-row constant is suspect the moment the grouping
changes, and every inner offset measured against one is suspect with it: My Goals' art and
pill had been placed in the old 366.5 frame, so they were 33px and 21px out in the 400 one.

Pinning the columns means rendering cards narrower than the real page ever draws them (its
own answer at that width is to wrap). Three rules absorb that instead of clipping:
- **the floor goes on the COLUMN, not on the list inside it.** `min-width: max-content` on
  `.sfh-legend` under a `min-width: 0` column let flexbox shrink the column below its own
  content — pills spilled 19.7px past the card's clipped edge, text cut mid-word, while the
  pill itself reported **no** overflow (`scrollWidth === clientWidth`). The probe has to
  compare against the clipping ancestor, not the element.
- **whatever scales, its type scales with it.** Freeing the legend shrank three rings to 76px
  while `32px/40px` stayed put and "4 Accounts" sat outside its own donut. Ring type is now
  `cqw` against the ring itself — 21.333/26.667/8.667/13, each the measured pixel over 150, so
  a 150px ring still computes to exactly 32/40/13/19.5.
- **the pill anchors to the card's bottom** (measured 21px) and the art takes the slack, so a
  subtitle wrapping to a second line no longer pushes "Set goals" out through the edge.

⚠️ **A SAFETY MARGIN ON A CONTAINER-QUERY THRESHOLD IS NOT FREE — it moves the degraded band
over widths that did not need it.** `@container sfhcard (max-width: 380px)` was a guess; cards
are 341 at 1500, so the query fired there and pills rendered 11px against the capture's 12px.
The real floor is derivable: a 150px ring beside a 155.4px `0 Upcoming Activity` row = 305.4,
plus 24px of card padding = **330**.

Also fixed here: `.sfh-card-head` is `align-items: center`. The capture puts the title at 13
on plain cards but 16.5 on the two with an icon button — exactly (32 − 25) / 2, the title
centred against the button. One rule reproduces both; `flex-start` reproduced only one.

**Verified at 1920, 1500 and 1157:** 4 / 4 / 1 every time, heights 338×4 / 400×4 / 376, no
horizontal document scroll, and nothing escaping its card (legend, pills, buttons, recents,
illustrations, ring value and label all checked against the card's own rect). At 1920 the KPI
card matches the capture value for value — card 446, ring 150, ring dx 43, value 32/40 at
dy 46, label 13 at dy 87, pill 12px / `4px 9.6px` / radius 8, dot dx 283 — and My Goals lands
on sub 45 / art 142.8 / pill gap 21, all within the uniform 1px offset that predates this
work. `.sfh-card-head`, `.sfh-pillbtn`, `.sfh-goal*` and `.sfh-ring*` are Home-only;
SalesforceCalendar shares just `.sfh-iconbtn`, untouched, and still renders.

#### Then: the nav bar is WHITE, and the active underline had never been drawn (8/27/2026)
"Fix the bar with all the tabs, it's not a grey background, it's white, so match the real site
and the shadowing. Also match how a tab looks when it's selected."

⚠️⚠️ **"TRANSPARENT, NO RULE" WAS A BAD MEASUREMENT, AND IT IS THE RECORD-TILE MISTAKE AGAIN:
the probe stopped at the first ancestor and reported what it found there as the answer.**
`one-app-nav-bar` and `.navCenter` genuinely paint nothing — but `.slds-context-bar` two levels
further out is `#fff`, 40 tall, `4px 0` padding, and ITS wrapper `.oneAppNavContainer` carries
`box-shadow: 0 2px 4px 0 rgba(0,0,0,.07)`. *When a probe says "nothing paints this", walk
further out before believing it.* Third time this exact shape has cost a pass.

⚠️⚠️ **THE ACTIVE UNDERLINE WAS NEVER VISIBLE IN ANY BUILD.** It is an `::after` 3px BELOW the
tab, and `.sfh-tabs { overflow: hidden }` — needed to clip the row at the right edge — clipped
it away too; `overflow` cannot be hidden on one axis and visible on the other. The row is now
35 tall (32 + the 3), `align-self: flex-start`, and hangs into the bar's padding, which does
not clip. **Proved, not assumed:** hit-testing the 3px band under the active tab returned only
`.sfh-bar`, and returned `li.sfh-tab` the instant the clip was lifted, with the tab's interior
and an inactive tab's band as controls. A rule can be right in every declaration and still
paint nothing.

Selected state, measured: label `#0250D9` (inactive `#03234D`), weight 500 either way — the
colour and the underline are the whole difference, there is no wash and no weight change. The
underline is `left/right: 0; bottom: -3px; height: 3px; radius: 12px`. Both states carry the
`::after`; the inactive one is `#001E5B` at `opacity: 0`, i.e. a hover affordance, not a
second style.

⚠️ **THE CHEVRON OCCUPIES 36px, NOT 14** — a 24 square button butted against the label's right
padding, the 14px glyph centred in it, then 12px. With a bare glyph every tab carrying a
chevron was exactly 22px narrow, and with `.navUL`'s 4px `gap` missing as well the error
accumulated along the row: by "Invoca Call Log" the replica was 82px left of the capture. Now
every tab's x and width match the capture exactly at 1157 (Home 131.3/60.5, Opportunities
195.7/145.2, Leads 344.9/96.8, Tasks 445.7/95, Invoca Call Log 544.8/153.5).

Checked that the wider row did not push **More** — which carries the Calendar route — out of
the clip: at 1920 all 14 tabs fit with nothing clipped, and More keeps its underline. At 1157
it is off the right edge, as it was before this change.

### Salesforce Leads -> Lead Intelligence View — screen 3 of 4 (8/27/2026)
"Next is the Leads tab." Capture: `reference/salesforce/leads-v1.html`. `SalesforceLeads.tsx`
+ `.sfl-*` + `src/data/salesforceLeads.ts`, routed at `/salesforce/leads`, and the **Leads tab
now links** (added to `ROUTES` in the same commit as the screen, per the rule there).

Measured at 1920 the same way as Seller Home — dump one property set off the capture's DOM,
dump the same off ours, fix until the diff is empty:

| | measured |
|---|---|
| page header | 101.5 tall on `#F3F3F3`, padding 16 |
| entity icon | 32 circle **`#1B96FF`** at radius 100%, white glyph |
| eyebrow / title | 13/19.5 `#03234D` / **`400 28px/49px`**, with a `#0250D9` caret 9px after it |
| header buttons | 43 / 32 / 32 / 60.9 / 91.3, all 32 tall, 1px `#5C5C5C`, ink `#0250D9`, 600 |
| card | `#fff`, radius **12**, 1px `#C9C9C9`, padding `0 16`, **fills the stage** |
| filter pill | radius **8** (not 240), 1px `#5C5C5C`, ink `#5C5C5C`, padding `0 16` |
| KPI tile | radius 10, padding `16px 20px`; selected `#F3F3F3` + **2px `#5C5C5C`** |
| KPI label / value | 13/16 **`#000`** / **32px/32 weight 274** |
| list header | count 12/18 `#03234D` 33 in; the 5-button group 9 from the right |
| table header | **41 tall on `#F3F3F3`**, `600 13px` `#5C5C5C`, padding `8px 32px 8px 12px` |
| rows | **52** tall, cells `8px 12px`, 13px `#5C5C5C`, links `#0250D9` weight 500 |
| columns | 52 / 32 / 289 / 44 / 140 / 155 / 199 / 174 / 140 / 322 / 241 / **591** / 241 / 181 / 100 / 50 = **2951** |

⚠️⚠️ **THE ROW SEPARATOR IS A `border-top` ON EVERY ROW BUT THE FIRST, and every border on
the `tr` and the `td` computes to 0** — so a probe that reads the first row concludes the
grid has no rules at all, which is visibly false. Reading rows 1 and 2 instead shows
`border-top: 1px #C9C9C9` appearing from the second row on. The distinction is not academic:
a `border-bottom` on every row draws a line under the LAST row, which the capture does not
have.

⚠️⚠️ **THE ACTIVE HEADER RULE LOST TO A LATER `position: relative` IN ITS OWN BLOCK.** The
`th` needs `sticky` (the capture scrolls the body under a fixed header) and `relative` (the
sort chevron is absolutely positioned), and the rule carried both — so the later one won and
the header simply scrolled away while every declaration read correctly. `sticky` establishes a
containing block too, so one declaration does both jobs.

⚠️ **THE TABLE IS 2951 WIDE INSIDE AN 1854 CARD, so the Invoca Attribution ID column starts
off-screen** — and that column is the reason this screen is in the demo. The order is the
capture's and the SE scrolls to it; promoting it forward would make the screen easier to demo
and stop it being a replica. Verified the scroll reaches it and that the ids render.

#### Ten leads, seven visible, the rest behind a scroll (8/27/2026)
Asked for directly: "have a total of 10 leads instead of 2, show only 7 and the user has to
scroll for the rest just like the real site." Both halves of that were fixes.

**The list is padded to ten, and WHICH half is which is what keeps it honest.** The
prospect's own named callers keep the top of the list — so an SE can still point at row 1 and
open that same person's screen-pop — and the remainder is scaffolding: a name, a **555**
number in the prospect's own area code, and one of the prospect's own products.
⚠️ **THE FILLER CARRIES NO FIGURE, and that is the line this repo actually draws.** Every
number it refuses to invent is a MEASUREMENT a prospect can check against another screen. A
lead row is a contact record, and the capture's own list is padded with John Doe and QA Test.
What still must never be typed is the COUNT: "N items" and the Total Leads / No Activity
tiles are computed from the rows.
⚠️ **A FILLER NAME MUST NOT COLLIDE WITH A NAME THE DEMO ALREADY USES.** Measured: the pool
produced **"Curtis Nakamura" for AutoNation, one of that profile's own agents**, so the same
person would have been an agent on one screen and a lead on another. Rejected against the
whole serialised profile rather than a list of the fields that hold names today. ⚠️ And the
loop tests `leads.length` while a separate counter advances the seed, or a rejected name
costs a ROW and the list silently comes back nine long.

**Seven rows then a scroll**: `max-height: 406px` on the scroll box = 41 of sticky header +
7 × 52 + the last row's own 1px rule. A max, not a height, so a short window shrinks it
instead of pushing the To Do bar off screen. ⚠️ `.sfl-card` also went `flex: 1 1 auto` ->
`0 1 auto`: filling the stage is what the capture does with 13 rows in it, but with the list
capped at 7 that left a band of empty card under the box, and a white slab beneath a bordered
list reads as a rendering fault. **This also retires the grey field flagged above** — the
capture's container is `#F3F3F3` and its rows always cover it, and 7 of 10 cover it here.

⚠️⚠️ **THE PHONE CHECK ENCODED THE BUG IT EXISTED TO CATCH.** The filler rendered
**"(805) 555-466"** — a nine-digit phone number, on screen — and `audit:leads` asked for
`\(\d{3}\) 555-\d{3}`, three digits, so it passed. Found by reading the rendered rows, not
by the suite. Both the pad and the regex say four now.
⚠️ **AND THE "every lead is named in the profile" CHECK HAD TO BE RE-AIMED, not deleted.**
Padding made it fail 13 profiles for doing its job. The invariant now is that no
profile-named lead sits BELOW a filler, plus at least two came from the profile at all (every
profile names its two screen-pop callers, so "at least one" would not notice a source going
dark). ⚠️ Its first version classified by full-name match alone and called **James Mitchell**
filler — the CI-derived leads come from separate `firstName` / `lastName` fields, so that name
appears nowhere as one string. Either form counts.

⚠️⚠️ **THE ROWS ARE THE PROSPECT'S OWN PEOPLE FIRST, NOT THE CAPTURE'S 13.** That org's list is real
names mixed with its test rows — John Doe, QA Test, and **Dana Probe twice** — and copying it
would put those on a projector in front of a customer. The leads at the top are derived from the four
places a profile actually names a caller (both screen-pops, the voice CI record, the SMS CI
record); see the section above for the padding that follows them and for why the COUNTS are
still computed from the rows rather than typed.

⚠️⚠️ **DEDUP ON THE NAME ALONE, AND THE CHECK THAT SHOULD HAVE CAUGHT THIS WAS TAUTOLOGICAL.**
Keyed on name+phone, four profiles rendered the same person on two rows — "Sarah Mitchell,
Sarah Mitchell" — because the screen-pop and the call record store their number in two forms.
The audit's duplicate check used **the dedup's own key**, so it passed 13 profiles while four
of them were visibly broken. It now asks the question the screen cares about (does one person
appear twice?) and **is proved to bite**: it must fail a deliberately doubled list, asserted
in the script. Third tautological check recorded in this file.

⚠️ **THE ATTRIBUTION ID IS DERIVED, NOT RANDOM** — `<network>/<promo>/i-<uuid>` in the
capture's own shape, a pure function of the lead's identity, so an SE re-opening the tab
mid-demo sees the same ids. `Math.random()` would change them on every reload.

⚠️⚠️ **THE LIST IS A BORDERED BOX DRAWN AS TWO HALVES, and the first pass rendered neither.**
Reported directly, with the region circled: "fix the background colour and shadows for the bar
I tagged, and there is a border around the whole box, with the bar and the lead information."
`.commonListHeader` is **50 tall on `#F3F3F3`** with a 1px `#C9C9C9` border on all four sides
and `8px 8px 0 0` radii; the table's container repeats that border on its other three sides
with `0 0 8px 8px` and **no top border**, so the bar's own bottom edge is the divider rather
than two rules stacking into 2px. Without it the count line and the five buttons floated on
the card's white with nothing around the list.
⚠️ **THERE IS NO BOX-SHADOW ANYWHERE HERE** — measured `none` on the bar, the container, the
table, the header row and the fixed header cell. What reads as a shadow is that 1px border
against the grey ground, which is worth knowing before adding one to "match".
⚠️ The bar's padding is `8px 8px 8px 32px`, and THAT is what puts the count at x=66 and the
button group 9px off the right edge — the first build reproduced both with 9px margins on the
row instead, which landed the same two numbers and drew no bar.
✅ **RESOLVED — the container's grey no longer shows.** It had been visible under a two-row
list; with ten leads in a seven-row viewport the rows cover it, as they do in the capture.

⚠️ **FOUR GLYPHS EXTRACTED VERBATIM** (bookmark, filter, email, info) per the use-the-real-icons
rule. ⚠️ `info` is on a **52-unit box**, like the two calendar glyphs — dropping it into the
520 grid renders a speck, which is exactly what the `SldsIcon` VIEWBOX note already warns about.

⚠️ **THE LEAD ICON IS `#1B96FF` HERE AND `#06A59A` ON SELLER HOME.** Both measured, on their
own captures, and the fill is three levels above the glyph in both — the same walk-further-out
trap as the nav bar and the record tiles. Left as measured rather than unified; flagged.

**`npm run audit:leads` (also run by `npm run audit`) covers all 13 profiles**: the counts
equal the row count, no person repeats, at least ten rows, no profile-named lead below a
filler, at least two from the profile, no filler colliding with a name the profile already
uses, filler phones on the 555 exchange in the prospect's own area code carrying one of its
own products, ids matching the capture's shape, and the derivation stable across calls.

**Verified** at 1920: a 25-property diff came back with one entry, the action button group 4px
narrower from font metrics across five labels. The header sticks, the chevron stays at 12/13,
and the horizontal scroll reaches the attribution ids. Untouched: Seller Home (4/4/1, 338 /
400 / 376, zero `.sfl-`), the Calendar, and `/dashboards/marketing` (21 cards, 7 donuts, KPI
48,293, zero `.sfl-`).

### Salesforce Invoca Call Log -> Recently Viewed — screen 4 of 4 (8/28/2026)
"Next is the Invoca Call Log tab." Capture: `reference/salesforce/call-log-v1.html`.
`SalesforceCallLog.tsx` + `.scl-*` + `src/data/salesforceCallLog.ts`, routed at
`/salesforce/call-log`, with the tab added to `ROUTES` in the same commit. The Invoca
package's own custom object: one record per call, ONE data column, an auto-numbered name —
the plainest of the four screens and the one that shows the integration writes into
Salesforce at all.

| | measured at 1920 |
|---|---|
| card | white, **radius 20**, 1px TRANSPARENT border (which is what insets everything by 1) |
| header band | **#F3F3F3 INSIDE the card**, 128 tall, padding `16px 16px 12px`, 1px `#C9C9C9` under it |
| entity icon | 32 circle **`#8B85F9`** — the same purple Seller Home's call-log tile carries |
| eyebrow / title | **13px/13** `#5C5C5C` / `400 28px/49` `#03234D` |
| title controls | caret 4px after the title (no border), pin 16 further on (1px `#5C5C5C`), both 24 at radius 240 |
| action group | New / Import / Change Owner / Assign Label, `li` 32 tall 1px `#5C5C5C`, label 13/30 600 `#0250D9` |
| count line | 12/18 `#5C5C5C`, **bottom-aligned** to the tools row |
| search | 240 x 32, radius **8**, 1px `#5C5C5C`, glyph inside 32px of left padding |
| icon buttons | 44 / 44 / 32 / 32 / 32 then a **grey pair** — `#E5E5E5` ground, `#757575` ink |
| list box | **radius 8 on all four corners**, 1px `#C9C9C9`, `#F3F3F3` ground, sticky header |
| header row | 32 tall on `#F3F3F3`, `600 13px` `#5C5C5C`, padding `8px` |
| rows | **37** tall (the Leads list is 52), padding 8, border-top from the second row on |
| columns | 52 / 32 / **fills** / 50 |

⚠️⚠️ **THE CAPTURE'S 1558px NAME COLUMN IS ITS WINDOW WIDTH, NOT A DESIGN VALUE.**
`lightning-datatable` writes `table-layout: fixed; width: 1692px` plus a per-`th` inline
width when it renders, and SingleFile froze the numbers from the window the capture was
taken in (~1728 CSS px). Re-rendered at 1920 the table keeps 1692 and leaves a 194px band
of the box's grey to its right, which reads as a deliberate gutter until you open the
inline style. Copying it would have pinned every prospect's list to one SE's window. The
other three columns ARE fixed; the name column takes what is left.
⚠️ **Two signals agreed before this was changed**: the inline `style` attribute, and the
user's own screenshot, where the row-action caret sits at the far right of the box.

⚠️⚠️ **`display: inline-block` ON A 16px CHECKBOX MADE THE HEADER ROW 33.5 AGAINST 32.** An
inline box sits on the BASELINE, so a 16px checkbox on a 16px line box grows the line to
17.5 and takes the whole row with it — while `line-height: 16px` on the cell read as
correct and measured 16 on the label beside it. A block fills the cell's content box
exactly. Third time in this file a row height has been decided by something other than the
`height` on it.

⚠️ **THE ORDER IS "RECENTLY VIEWED", WHICH IS NOT NUMERIC.** The capture reads 1889, 1875,
1872, 1888, 1884, 1887 — an SE's viewing history, and the column header carries "Column
sort is disabled". A tidy descending list would contradict that, so each record gets a
derived last-viewed instant and the list orders by it. `audit:calllog` **proves the check
bites** by feeding it a numerically sorted list, which must fail.

⚠️⚠️ **THIS FIXED A CROSS-SCREEN BUG ON SELLER HOME.** That screen built its Recent Records
call-log row as `INVOCA-${callId}` -> **"INVOCA-0597627F"**, because the Invoca call id was
the only id to hand when it was built. Both captures say the object is an **8-digit
auto-number** — this one's records are `INVOCA-00001889` and neighbours, and the Seller Home
capture's own row is **`INVOCA-00001888`**, a neighbour from the same block. So the two
screens disagreed about one record's name in one org. `newestCallLogName()` is exported and
Seller Home reads it, so the row it shows is genuinely the newest record in this list —
verified live: Home now shows `INVOCA-00002741`, the exact first row here.

⚠️ **THE COUNT IS THE ROW COUNT, NOT THE CAPTURE'S "50+".** Salesforce prints the "+" when
there are more records than it fetched; printing it over exactly the rows we render would
claim an unseen remainder. Same rule as the Leads list.
⚠️ **THE STARTING NUMBER IS DERIVED PER PROSPECT and anchored near the capture's own block**
rather than at 1 — an org whose call-log records start at INVOCA-00000001 has just been
installed, which is the opposite of the story. The audit asserts the 14 profiles get
distinct blocks, so two demos cannot show the same ids.

⚠️ **ROWS ARE INERT**, like the Leads list's: the record pages behind these links are not
captured, and a link that navigates somewhere invented is worse than one that does nothing.

⚠️ **FOUR GLYPHS EXTRACTED VERBATIM** (pin, listdisplay, sortarrows, piechart). The gear,
pencil, refresh, funnel, search and both carets were already in `SldsIcon` and matched the
capture's paths character for character — checked rather than assumed.

⚠️ **`.scl-` DUPLICATES THE LEADS SCREEN'S GROUP BUTTON, SEARCH PILL AND ROW CHROME rather
than sharing them.** Every value is identical on both captures today, so sharing is
tempting — and one prefix per screen is what stops a change to one list altering the other,
which this file has already paid for once this week. If a value here changes, re-read BOTH
captures.
⚠️ Also measured here and NOT shared: neighbours in the action group omit `border-right`
rather than pulling back 1px (a negative margin lands in the same place and stacks two
borders), and the Charts/Filters pair does not overlap at all.

**`npm run audit:calllog` (also run by `npm run audit`) covers all 14 profiles**: 50 records,
the `INVOCA-` + 8-digit format, no duplicates, the status line agreeing with the rows, the
order not numerically sorted, stability across calls, `newestCallLogName` being the first
row, distinct blocks per prospect, and Seller Home still reading that helper instead of
minting its own name.

**Verified at 1920: a 21-property diff came back with ONE entry** — the action group 4px
narrower from font metrics across four labels, the same drift the Leads header has. 50 rows
scrolling under a sticky header. Untouched: Seller Home (4/4/1, 338 / 400 / 376), the Leads
list (10 rows, "10 items") and `/dashboards/marketing` (21 cards, 7 donuts, KPI 48,293) —
**zero `.scl-` elements on any of them**.

### Salesforce Lead record page — screen 5, and the attribution section is the point (8/28/2026)
"This page is what happens when the user clicks on the first name in the lead, in this example
its Jessica Harper. Fill in the following sections as well: 1. Invoca Captured Attribution.
Don't worry about the Address information and Additional Information." Capture:
`reference/salesforce/lead-detail-v1.html`. `SalesforceLeadDetail.tsx` + `.sld-*` +
`src/data/salesforceLeadDetail.ts`, routed at `/salesforce/leads/:slug`, and **the name cell on
the Leads list is now a `<Link>`** — the one live link on that row, added in the same commit as
the screen per the rule the nav tabs already follow.

⚠️ **THE FOUR SCREENS ABOVE ARE LABELLED "of 4" AND THERE ARE NOW FIVE.** Left as written
rather than renumbering four signed-off sections; this is the fifth.

| | measured at 1920 |
|---|---|
| header slab | 1888 x **148.6** on `#F3F3F3`, radius 4, padding 16 |
| entity icon | 32 circle **`#06A59A`**, at y130 |
| eyebrow / title | 13/19.5 / **`300 28px/35px`** `#03234D` |
| highlights | labels 12px at y202, values 21.6 tall; **31px under the title block** |
| path | y266.6, **58** tall; stage 32 tall, current `#032d60` on white ink |
| Mark Status as Complete | 30 tall, `#066AFE` |
| columns | left **67.0%** (1265), right 623, both `padding: 0 17px`, right +29 on its left |
| tabs | x33 y349.6 w1231 **h41**, `13px 0 8px`, **13px below the column top** |
| card | x33 w1231, radius **20** |
| field | **591.5** wide, 52 tall, at x45 and x660.5 |
| section band | the grey `#F3F3F3` band is a **button** inside the h3, 32 tall, `20px` `#03234D` |
| related card | x1310 **w577**, radius 12 |

⚠️⚠️ **ONE MISSING 31px PRODUCED SIX DIFFS, AND THEY LOOKED LIKE SIX PROBLEMS.** The header
slab came out 142 against 148.6, so the highlight labels, the path, both stage rows and the
tab list were all ~6.6px high — five of the six entries named a consequence rather than the
cause. The slab's height is not authored: it decomposes as `16 padding + 49 title block + 31 +
15 label + 21.6 value + 16 padding`, and the 31 is what a `margin-top: 24` had been guessing.
Same argument as the Seller Home 12px margin: **diff positions, do not eyeball a screenshot.**

⚠️ **THE COLUMNS ARE ADJACENT AND THE TAB LIST IS INSET 13px INTO ITS OWN COLUMN** — not flush
with it. Reproducing the tabs at the column top left them 19.6px high, which reads as the whole
card being misplaced.

⚠️ **THE ATTRIBUTION SECTION IS FILLED, WHICH THE CAPTURE'S IS NOT, and that is deliberate.**
That org has all eleven fields blank except Product of Interest — it simply is not passing them.
Blank is the honest replica and a terrible demo: the entire claim of this screen is that Invoca
writes the attribution onto the lead, and an empty section says the opposite. Address Information
and Additional Information stay blank, exactly as captured and as asked.

⚠️ **EVERY FIELD COMES FROM DATA ANOTHER SCREEN ALREADY SHOWS**, so a prospect who cross-checks
finds the same values rather than a second set: Line of Business from `networkName` less "Invoca
for ", Product of Interest from the lead's own product, Product Name its proper-case form,
Product Category as below, the promotion as below, and **Marketing Source / Medium / Campaign /
Search Terms + Website Journey + Calling Page from ONE `digitalInsights` row taken WHOLE** — the
same rule the Details Report note gives, because cycling those four independently is what
produced "Medium: Bing, Source: Paid Search" there. Rows are sorted by how many fields they fill,
so the complete ones land on the leads an SE actually clicks; strictly by index, the FIRST lead's
Marketing Search Terms was the em-dash placeholder, i.e. a section asked to be "filled in"
opened with a blank.

⚠️ **THE LEAD CARRIES ITS OWN PROPER-CASE PRODUCT.** Picking one off the screen-pops by index
instead gave David Chen "apartments by marriott bonvoy" as his Product of Interest and "The
Ritz-Carlton Las Vegas" as his Product Name — two products for one person, on adjacent rows of
the same section.

#### Product Category: the screen-pop knows, and keyword overlap did not
⚠️⚠️ **WORD OVERLAP FILED A CARDIAC CATHETERIZATION UNDER "Cancer Institute".** Orlando Health's
category rows are Cancer / **Heart & Vascular** / Orthopedic / Women's / Digestive Institute, and
overlap cannot reach the right one because "cardiac" is not "heart" — so it fell through to a
stable index pick and produced a contradiction two rows apart in the same section.

**The profile already records the answer, twice, on the very object the lead's product came
from**: `voiceScreenpop.campaign` is "Heart & Vascular Institute, Winter Park Acquisition" and
its `callingWebpage` is `/services/heart-vascular-institute`, beside `products: "Cardiac
Catheterization, Diagnostic Imaging"`. The campaign's FIRST SEGMENT is that caller's product
category and it is a real `Conversions by Product Category` row; the rest is the campaign's own
targeting ("Winter Park Acquisition"), which is not a category. Same principle as taking a
`digitalInsights` row whole — read the coherent tuple the generator already produced rather than
re-deriving one field of it by keyword.

⚠️ **BUT A STRONG LEXICAL MATCH MUST WIN OVER THE CAMPAIGN, because a screen-pop lists TWO
products against ONE campaign.** With the campaign first, its second product inherits the
first's category: measured, **"memory care neighborhood" rendered as "Assisted Living" with a
**Memory Care** row sitting in the same list.** Precedence is now: an unambiguous lexical match
(**two** shared significant words, the threshold the Google Ads ad-group note settled after one
word matched "continuing CARE" to "Memory Care") -> the screen-pop's campaign -> the looser
single-word overlap -> a stable index pick.

⚠️ **A KNOWN LIMIT, STATED RATHER THAN PAPERED OVER:** where the words differ AND the campaign
disagrees, the pair is merely plausible rather than right — "the ritz-carlton las vegas" files
under "Full Service / Premium Hotels" where "Luxury Hotels" exists. Closing that needs a
per-vertical synonym taxonomy, which is inventing vocabulary for a real company; the campaign is
genuine attribution evidence, so it wins over a guess.

#### Product Promotion: recovered from the call, or honestly blank
⚠️⚠️ **`agentConfig.smsPlaybook.offer` IS EMPTY ON 5 OF THE 14 PROFILES ON DISK** — every
healthcare prospect plus Comfort Keepers — so the section asked to be "filled in" opened with a
blank Product Promotion on **50 of 140** lead pages. A hospital genuinely runs no promotion, and
minting one would fabricate a healthcare offer, the same refusal `serviceZips` and the rejected
ZIP3 guess already make.

Two of those five DO name a real offer **in their own call data**, and a promotion the agent made
on the recorded call is exactly what an attribution field should carry: Comfort Keepers' met
signal "Agent offered free in-home assessment" -> **"Free in-home assessment"**, and Orlando
Health's key point "MyChart portal enrollment offered at no cost" -> **"MyChart portal enrollment
at no cost"**. So it is RECOVERED, never invented, and stays blank for the three prospects that
run none. Blanks went **50 -> 30**; 11 of 14 profiles now fill all eleven fields.

⚠️ **`qaPairs` IS DELIBERATELY NOT A SOURCE.** Those are questions the CALLER asks and they are
full of the word "offer" — "Do you offer virtual visits?", "Do you offer physical therapy?" — so
including them prints a caller's question as the prospect's promotion. Anything containing "?" is
rejected as a second guard.

⚠️⚠️ **TWO KEYWORD BRANCHES WERE TOO LOOSE AND BOTH RENDERED, which is why the matcher is this
narrow.** A bare `\boffered\b` turned Denver Health's "Agent offered specific clinic locations"
into the promotion **"Specific clinic locations"** — the agent naming clinics, not an offer. And
`\$\d` turned Health Spring's "Needs an individual plan near $500/month" into a promotion, i.e.
**the caller's own budget**. A promotion needs a VALUE word (free / complimentary / no cost /
waived / discount / % off); "offered" survives only as a phrase to strip during normalisation,
and a bare dollar amount is not a discount. Third and fourth time in this file a keyword has been
too loose in exactly this way.

⚠️ **THE DUPLICATES CARD IS OMITTED, and that is a decision.** The capture's Related column opens
with "We found 38 potential duplicates of this Lead" — true of that org, and impossible here: this
demo's list is ten leads deduplicated by name, so a duplicate warning would contradict the screen
the SE just came from. Flagged rather than rendered with an invented count.

⚠️ **THE ROUTE FAILS CLOSED** on a slug this prospect has no lead for ("Lead not found" plus a
link back), the same rule the created-workflow route documents. A plausible page for a lead that
does not exist is worse than a refusal.

⚠️ **THE LEAD ICON IS `#06A59A` HERE AND `#1B96FF` ON THE LIST VIEW.** Both measured, on their
own captures, and in both the fill is levels above the glyph — the same walk-further-out trap as
the nav bar and the record tiles. Left as measured rather than unified; flagged.

**`npm run audit:leaddetail` (also run by `npm run audit`) covers all 14 profiles**: every slug on
the list resolves (no dead link mid-demo), slugs are unique, the ten always-populated attribution
fields are non-blank, a lead's two product fields describe ONE product, an unambiguous category
row is never ignored in favour of the campaign, the Invoca Call Log record named here exists in
that tab's own list, a call-derived promotion names a value and is not a question, the derivation
is stable across calls, and an unknown slug returns null.
⚠️ **`offerFromCall`, `strongLexical` and `categoryRows` are EXPORTED so the audit tests the real
functions rather than copies of their rules** — the same reason `CONCEPT_HARD_PHRASES` is exported
from `signalTiers.ts`, which had been policing a shorter local copy.
⚠️ **EVERY CHECK WAS BROKEN ON PURPOSE AND SEEN TO FIRE**: a blanked `marketingSource`, a call-log
name outside the list, the fail-closed guard removed, the category precedence reversed (which
reproduced the Memory Care failure exactly), plus four self-tests asserting the promotion matcher
rejects agent behaviour, the caller's budget and a caller question while accepting a genuine free
offer. Three tautological checks are already recorded in this file; a check that cannot fail is
worse than none.

**Verified at 1920: a 10-property diff came back empty**, all eleven attribution fields populated
on Shady Blinds (Line of Business "Home Services", Product Category "Shades", promotion "Schedule
a consultation today to save 10% on wood blinds", Search Terms "traditional colonial window
shutters"), and Orlando Health re-skins completely (Healthcare / cardiac catheterization / Heart &
Vascular Institute / MyChart portal enrollment at no cost / "emergency room near me"). Untouched:
Seller Home (9 cards, 4/4/1, 338 / 400 / 376, the active underline still hit-testable), the Leads
list (10 rows, "10 items", 52px rows, 406px scroll box), the Call Log (50 rows, 37px, header 32,
INVOCA-00002741 first) and `/dashboards/marketing` (21 cards, 7 donuts, KPI 48,293) — **zero
`.sld-` elements on any of them**. `audit:leads` and `audit:calllog` both green.

### Salesforce Invoca Call Log RECORD page — screen 6 (8/28/2026)
"Next screen is what happens when you click on the Invoca Call Log link. In the page, reduce the
number of fields in the Enriched Caller Data. For signals the left column is the name and the
right column is a check or not if it existed in the call. Custom Data: reduce the number of
fields and also left column is the name of the data and the right column is the value of the
name." Capture: `reference/salesforce/call-log-detail-v1.html`. `SalesforceCallLogDetail.tsx` +
`.clr-*` + `src/data/salesforceCallLogRecord.ts`, routed at `/salesforce/call-log/:name`.

This is the screen that shows, field by field, exactly what the integration WRITES INTO
Salesforce — the payoff for the Call Log list being in the demo at all.

| | measured at 1920 |
|---|---|
| header | **FULL-BLEED 80px `#F3F3F3` band** at y90, padding `0 32px` — not the Lead page's inset slab |
| entity icon | 32 circle **`#8B85F9`** at x32 y114 (the same purple as the list and Seller Home's tile) |
| eyebrow / title | 13px/13 **`#444`** / `400 28px/35px` `#03234D` |
| header buttons | 32 tall, white, 1px `#5C5C5C`, ink **`#0250D9`**, `600 13px`, padding `0 16px`, ends radius 240 |
| gap under the band | **30px** of page ground before the panel |
| left panel | x16 y200 **w1254.9**, white, radius 20, padding `13px 17px 0` |
| right panel | x1295, same chrome; the two are 24px apart |
| tabs | 41 tall over 1px `#C9C9C9`; tab `600 16px`, inactive `#5C5C5C`, active **`#022AC0`** + a 3px underline |
| card | x33 y278 **w1220.9** (two 610.5 columns, no gutter) |
| field item | **610.5** wide, padding `0 12px`; populated 48 tall, empty 49.3 |
| the separator | 1px `#C9C9C9` on an INNER box, **x45 w586.5** |
| label / value | `600 13px/19.5` `#2E2E2E` / `400 13px/19.5` **`#181818`** |
| section band | h3 34 tall with a 1px inset **button**: 32 tall, `#F3F3F3`, radius 8, `20px/30px` `#03234D` |
| PLAY RECORDING | a real **200x50 PNG drawn at 140x35** |

⚠️⚠️ **THE CAPTURE STORES SIGNALS AND CUSTOM DATA AS PAIRED GENERIC FIELDS, and that is why
collapsing them is not a departure so much as a translation.** A field literally called
`Customer Boolean Name 0` holds the value "Buying Intent (Industry)", and beside it
`Customer Boolean Value 0` holds True — because these are generic columns on a custom object
and Salesforce cannot label them with the thing they happen to contain. So the real page spends
**20 rows to show 10 signals and 52 rows to show 25 custom values**, with every actual name
buried in the VALUE column. One row per pair — name on the left, what it holds on the right —
is what those rows MEAN, and it is the difference between a screen an SE can point at and a
wall of "Customer Boolean Name 7".

⚠️ **AND I FIRST RENDERED CUSTOM DATA AS ORDINARY STACKED FIELDS, which reproduced the exact
thing being collapsed.** With the name as a label above its value, the two-column grid puts
TWO DIFFERENT KEYS on one row each with its own value underneath — `invoca_caller_language`
over "English" beside `utm_source` over "Paid Search". Read back off the rendered page rather
than assumed. `PairRow` is now one component serving both sections, so they cannot drift.

⚠️ **ENRICHED CALLER DATA: 23 FIELDS DOWN TO 8, AND *WHICH* EIGHT IS THE DECISION.** Twenty of
the capture's are empty, and what got dropped is the whole demographic block — Age Range,
Gender, Marital Status, Has Children, Education, Household Income, Home Market Value, High Net
Worth, Occupation. Those are real Invoca enrichment fields, and filling them would mean
**inventing a named caller's income and marital status to decorate a demo**. What stays is the
line intelligence an SE actually talks about: who the number belongs to, what kind of line it
is, and where it is. The audit asserts the dropped ones never come back.

⚠️ **THE UNFIRED SIGNAL IS A DASHED SQUARE, NOT AN ABSENCE.** Both states are 16px SLDS glyphs
on the 520 grid at fill `#181818`, extracted verbatim into `SldsIcon` as `check` and
`checkboxdash`. Drawing nothing for a signal that did not fire would make it indistinguishable
from a field the page failed to render — and this file already records that **a missing icon
key fails silently**.

#### Four bugs, and the first one is the important one
⚠️⚠️ **TWO LEADS HASHED TO THE SAME CALL LOG RECORD, IN 6 OF THE 14 PROFILES ON DISK.**
`salesforceLeadDetail` picked its record as `recs[hash(lead.slug) % 50]` — independently per
lead, so collisions were inevitable. That was **invisible while the value was only ever
PRINTED**: two leads naming one record contradicted nothing. The moment the record got its own
page it could only name ONE of them back, so clicking Priya Castellano's call log record landed
on a page reading **"Lead: Michael Chen"**. Now stepped by 7 from a per-profile offset — 7 is
coprime with 50, so the pick is injective for far more than ten leads, still scatters instead of
handing lead 1 the newest row, and is as stable as the hash was.
**The lesson generalises: a derived value that becomes a LINK acquires an invariant it never had
as a string.** The round-trip check in the new audit is what found it, on its first run.

⚠️ **ONE MISSING 30px GAP PRODUCED FOUR DIFFS.** The panel, both columns and the card were all
30px high because nothing separated the header band from the panel — three of the four entries
named a consequence. Second screen running where one spacing value did this.

⚠️ **THE 1px SEPARATOR IS ON AN INNER BOX, NOT THE FIELD.** The item is 610.5 with 12px of
padding and the rule spans only the 586.5 inside it, so putting the border on the outer element
draws it 24px too wide on every row of the page.

⚠️⚠️ **THE utm ROWS CONTRADICTED THE URL PRINTED TWO ROWS BELOW THEM.** The first version read
`utm_source = Paid Search` above a `calling_page` of `…?utm_source=google&utm_medium=cpc…`.
Marketing Source is a CHANNEL; `utm_source` is the PARAMETER that was on the link. They now come
out of the URL itself, falling back to the channel labels only for a row whose URL carries no utm
params — so the rows agree by construction, the same reason the Details Report takes a whole
attribution row instead of cycling its fields.

⚠️⚠️ **EXTRACTING THE PLAY PNG THROUGH MY OWN MESSAGE TRUNCATED IT, and the byte count nearly
let it through.** 3,270 base64 chars came back from the browser, went out through a `printf`, and
decoded to a file whose chunk walk read `IHDR, tEXt, IDAT, <garbage chunk of length 75029>` — no
IEND, running off the end. **Extract from the capture ON DISK instead of copying base64 through a
message.** Two further traps in doing so: SingleFile writes **UNQUOTED attributes**, so
`src="data:…"` does not match and the value ends at whitespace; and my first IEND test compared
the last 8 bytes against a 12-byte pattern and so reported False on the good file too. **The
authoritative check is a chunk walk that ends exactly at EOF.**

⚠️ **THE CALL LOG LIST'S ROWS ARE LIVE NOW.** They were deliberately inert while no record page
existed — "a link that navigates somewhere invented is worse than one that does nothing" — and
that same rule is what let them go live once the destination was real and audited. All 50 per
prospect resolve.

⚠️ **ITS OWN `.clr-` PREFIX even though several values match the Lead page's `.sld-` ones.** One
prefix per screen is what stops a change to one record page restyling the other — the rule this
repo paid for when a component rebuild deleted 79 `.cd-` rules as collateral. Note two values
that genuinely differ and were left as measured: the eyebrow is `#444` here and `#03234D` there,
and the active tab is `#022AC0` here against `#0250D9` on the Leads list.

**`npm run audit:clrecord` (also run by `npm run audit`) covers all 14 profiles**: every one of
the 50 rows per prospect resolves, an unknown record fails closed, the **lead -> record -> lead
round trip** holds for all ten leads, Enriched is <= 10 fields and carries none of the dropped
demographics, Custom Data is <= 12 pairs, every signal name is one of that prospect's own with at
least one fired and one not, the utm rows agree with the calling_page beside them, every phone
number is on the reserved 555 exchange, and the derivation is stable across calls.
⚠️ **The 555 check is written against the formats this page actually renders** — `(805) 555-0142`
and `877-555-0961` — because the Leads audit's own version asked for three digits after the
exchange and so agreed with the nine-digit phone number it existed to catch. Proved on both
formats plus a real exchange.

**Verified at 1920: a 21-property diff came back empty.** Signals render 10 rows with 4 checked
and 6 dashed, all name-and-check on ONE row; Custom Data renders 11 name/value rows whose three
utm values match the URL beneath them; Enriched renders 8. A real click on Jessica Harper's
record link opens INVOCA-00002700, whose Lead field reads "Jessica Harper" and links back.
Untouched: Seller Home (9 cards, 4/4/1, 338 / 400 / 376, 14 tabs, 0 broken images), the Leads
list (10 rows, 52px, 406px scroll), the Call Log list (50 rows, 37px, header 32, all 50 now
linking) and `/dashboards/marketing` (21 cards, 7 donuts, KPI 48,293) — **zero `.clr-` elements
on any of them**. `audit:leads`, `audit:calllog`, `audit:leaddetail`, `audit:phases` and
`audit:ai` all green.

### Salesforce Calendar — screen 2 of 4 (8/24/2026)
`SalesforceCalendar.tsx` + `.sfc-`, plus `salesforceEvent.ts` for the booked appointment.
What the **Calendar** tab opens; measured off a capture of the live week view.

| | measured |
|---|---|
| page header | 69.5 tall over a 1px `#C9C9C9` rule; kicker 13/19.5, range **700 18px/22.5** |
| buttons | 32 tall, 1px `#747474`, radius 4, ink `#0176D3`; the list toggle is white-on-`#0176D3` |
| GMT label | 11px/40 `#757575`; day header 13px/40 `#181818`, centred |
| **hour pitch** | **80px** — 24 rows, so the body is 1920 and scrolls |
| hour label | 13/19.5 `#444` at 23 from the left; slot rules are **white on `#F3F3F3`** |
| event chip | `#5A93B1`, radius 4, padding `2px 4px 0`, 81 tall for one hour; title `700 12px` and time `12px`, both `#181818` with **`line-height: normal`** |
| right rail | 304 wide, white; heading `700 16/24`; mini cell 40 square, out-of-month `#C9C9C9`; swatch 16 at radius 8 |

⚠️ **THE GRID WAS REBUILT FROM LIGHTNING'S OWN AUTHORED CSS, and that is the lesson.** The
first pass measured computed boxes and got the grid visibly wrong; the fix was reading the
capture's STYLESHEET (`document.styleSheets` → `cssRules`, filtered for `calendarDay`,
`eventList`, `forceCalendarTimeRuler`, `slds-datepicker`). Line colour, line frequency,
column shading and the vertical offsets are all expressed in rules that a box-by-box
measurement cannot reveal:

| | authored rule |
|---|---|
| time ruler | `min/max-width: 80px` (the first build used 60) |
| day headers | `padding-left: 80px` |
| column | `height: calc(480px*4)` = 1920, **`margin-top: calc(40px/2)`** = 20, `border-left: 1px #C9C9C9` |
| shading | **only** `.calendarDay.pastDay` is shaded; the base column has NO background rule |
| **gridlines** | `background: linear-gradient(rgba(0,0,0,.1) 1px, transparent 1.01px) / 100% 2.08333%` on `.eventList` — 1px at 10% black every **40px**, i.e. every HALF hour |
| hour label | `.label { top: -10px; background: #fff }` — it interrupts the line |
| day header | `line-height: 40px`, `font-weight: normal`, cell 55 tall, and a `::after` drawing the column tick from `top: 40px` |
| grid edges | `.calendarRow, .calendarDayHeaders { border-right: 1px #C9C9C9 }` |
| chip column | `.eventListContainer { width: calc(100% - 0.75rem) }` → 144.141px in a 157.1 column |
| mini day | td `padding: 4px` around a **32px circle** (`line-height: 32px`, `border-radius: 50%`) |
| mini today | `background: #F3F3F3` **plus** `box-shadow: 0 0 0 1px #C9C9C9` — a filled circle with a ring, not a ring alone |

⚠️ **THE DAY HEADERS MUST LIVE INSIDE THE SCROLLER, and this was a real misalignment.** As a
sibling ABOVE the scroll box, the header row shared the box's width but not its **16px
scrollbar**, so the seven header cells were each 2.1px wider than the seven day columns and the
vertical ticks drifted — measured **12.9px out by Saturday**, which is exactly the "misaligned
lines" a screenshot shows. The fix is structural, not arithmetic: the scroller is the outer
`.sfc-grid`, the header row sits inside it as `position: sticky; top: 0` with its own white
ground, and both rows then resolve against one content width. Verified 0.00px x- and
width-delta on all seven columns, and the header stays pinned at scrollTop 600.
⚠️ Do NOT "fix" this by padding the header by a scrollbar width — that number is
platform- and setting-dependent (overlay scrollbars measure 0) and the two rows go out of
alignment again the moment the grid stops scrolling.

⚠️ **THERE ARE *TWO* GRIDLINE LAYERS, which is why the hours read darker than the
half-hours.** Both are background gradients, and reading only the first is why the grid looked
uniform:

| layer | gradient | size | effect |
|---|---|---|---|
| `.eventList` | `rgba(0,0,0,.1)` at **1px** | `100% 2.08333%` | every 40px — the half-hour |
| `.eventList::before` | **`#C9C9C9` at 1.25px** | `100% 4.16667%` | every 80px — the hour, darker AND thicker |

The chips need a `z-index` above both, since the `::before` sits at 0.

⚠️ **THE PAGE-HEADER BAND IS `#F3F3F3`, NOT WHITE** (`.slds-page-header_joined`), and the
Event object's tile is **`#CB65FF`** with a 32px white glyph — not the muted lavender I first
guessed.

⚠️ **WHY THE TILE ICON WAS MISSING, AND IT WAS NOT AN EXTRACTION PROBLEM: I referenced a name
that does not exist.** The glyph was extracted correctly as `calendar-tile` (a 100-unit box);
the markup asked for `name="calendar"`, `PATHS["calendar"]` was undefined, and `SldsIcon`
returns `null` — so the tile rendered as an empty purple square with no error anywhere. Same
for the view picker (`calendar-sm`). **A missing icon key fails SILENTLY**; if a glyph is
absent, check the key before re-extracting the asset.

⚠️ **THE LOGO AND THE AVATAR *ARE* IN THE CAPTURE, AND I SAID TWICE THAT THEY WERE NOT.**
This is the correction worth keeping, because the wrong conclusion was confidently argued from
evidence: I searched for `<img>` with a src, for inline `<svg>`, for a sprite, found only
Lightning's `class="icon noicon"` placeholder, inventoried every data URI, and concluded the
assets had never been saved. **Both are CSS `background-image`s**, and both were missed for
the same two reasons — I never checked `background-image` across the header region, and my
corner searches filtered to elements narrower than ~70px while `.slds-global-header__logo` is
**200 x 40**.

| mark | where it actually lives | measured |
|---|---|---|
| Salesforce logo | `background-image` on `.slds-global-header__logo` | 200 x 40, `contain`, `0% 50%`, no-repeat, at x=16 |
| profile avatar | `background-image` on `.profileTrigger` over `#1B96FF` | 32 square, `cover`, radius 100% |

Both are now extracted verbatim to `public/icons/salesforce/logo.svg` (a 4000x2800 viewBox)
and `avatar.png`, and **there are no authored marks left on these screens.** The lesson, and
it generalises to every replica: **when a mark looks absent from a capture, check
`background-image` across the region before drawing one** — and do not let a width filter
decide what you looked at.

⚠️ **THE FIRST BUILD'S GRIDLINES WERE WRONG THREE WAYS AT ONCE** — white instead of 10%
black, every 80px instead of 40, and drawn as bordered cells instead of a background
gradient. Any one of those reads as "the lines are off".
⚠️ **TODAY AND FUTURE COLUMNS ARE WHITE, and that came from the ABSENCE of a rule.** The
capture's week is entirely in the past, so every column computed to `#F3F3F3` and a
computed-style reading would have shaded the whole grid forever. Only `.pastDay` has a
background; the base class has none.
⚠️ **`display: block` ON THE CHIP IS LOAD-BEARING.** It is a `<span>`, and `height: 100%`
does nothing on an inline box — the chip collapsed to a 4px sliver with its text spilling
across the column.

⚠️ **THE EVENT IS THE APPOINTMENT THE SMS AGENT BOOKED, and it prefers a LIVE capture.**
`bookedEvent()` takes the newest conversation from `SmsCaptureContext` (what the Preview
Agent just wrote) and falls back to the profile's seeded SMS conversation, so the calendar is
never empty — a screen that shows nothing until someone runs a chat is worse on a projector
than one that always carries the record.
⚠️ **THE DAY AND TIME ARE DERIVED, NOT PARSED OUT OF THE CHAT.** The agent confirms a slot in
prose ("does Thursday at 2 work?"); reading that back with a regex breaks the first time a
model phrases it differently. The slot is a pure function of the conversation id, so it is
stable across reloads and an SE can rehearse against it.

⚠️ **A REAL BUG WORTH NOT REPEATING: `>>` IS SIGNED, AND `%` KEEPS THE SIGN.** `hash()`
returns an UNSIGNED 32-bit value, so any hash above 2^31 goes negative under `h >> 4`, and
`9 + ((h >> 4) % 8)` — which reads as "9 plus 0..7" — produced **3**, i.e. a 3am appointment
on a business calendar, for Shady Blinds' own conversation id. Fixed with `>>>`. It also hid
a second symptom: the grid opens scrolled to `(startHour - 4) * 80`, which clamped to 0, so
"the scroll didn't work" and "the time is wrong" were one fault.

⚠️ **THE WEEK COMES FROM THE DEMO'S OWN CLOCK, not the capture.** The capture shows Aug 2-8
because that SE had navigated back — session state, not design. The appointment is placed
inside the current week.

⚠️ **THE CHROME IS NOW SHARED** (`SalesforceChrome.tsx`: global header, context bar, To Do
bar). It was inline in the Home screen, and a second copy is exactly how the nav ends up with
a different active-tab treatment on each page. Only tabs in its `ROUTES` map link; the rest
stay inert because there is no `*` catch-all.

Header marks corrected in the same pass, all measured: the **+ is white on `#919191` GREY**
at 20 square (it was the `#0176D3` primary, the loudest thing in the header), the search
border is **`#747474`** not `#C9C9C9`, and the avatar carries a **white user glyph on
`#1B96FF`** where it had been an empty circle. The Salesforce cloud and that user glyph are
the two authored marks — neither capture carries the logo or avatar image (both serialise as
`class="icon noicon"` with no src).

Verified: the appointment renders at 11am–12pm on a weekday of the current week, the grid
opens scrolled to it, the Calendar tab is the pale-blue wash and navigates from Home with a
real click, and a 22-property diff against the spec is empty.

### Salesforce: the Sales Cloud flow (screen 1 of 4, REBUILT 8/24/2026)
⚠️ **THE FIRST PASS WAS REPORTED WRONG ON SIX COUNTS and every one was a place I measured a
COLOUR but inferred a STRUCTURE.** Recording them because the failure mode generalises: a
palette lifted off a capture makes a screen look plausible in a screenshot while the geometry,
the type and the icons are all invented. What fixed it was dumping the capture's own DOM —
element boxes, the flex/grid rules, the icon paths — instead of reading values off a picture.

| reported | cause | measured truth |
|---|---|---|
| icons wrong | Material ligatures substituted | real SLDS `<svg viewBox="0 0 520 520">` paths, extracted verbatim to `SldsIcon.tsx` |
| font + colour wrong | platform Lato leaked in; h1 guessed | the SYSTEM stack, 13px base `#181818`; h1 **`300 28px/49px`** |
| tab bar not full width | strip sized to content | `.navCenter` is `flex: 1 1 0%` — the strip spans the bar |
| tab selection wrong | drew a 3px brand underline, blue bold label | `slds-is-active` is a **`rgba(0,112,210,.1)` wash**, no border, label stays `#181818`/400 |
| tile heights off | height fell out of the content | fixed **333** (row 1) / **370.5** / **396.5** |
| in-tile spacing wrong | one 16px padding, everything centred | three bands: 32 header (`12px 16px 0` + 12 margin), body inset 12, 57 footer behind a 1px rule |

⚠️ **THE CARDS FLEX BETWEEN ~442 AND ~458 — CORRECTED AGAIN.** Two passes got this wrong in
opposite directions: first a `repeat(4, 1fr)` grid, then a FIXED 457.7px basis. Measured:
**457.7 wide / 3 per row at 1500** and **442.3 wide / 4 per row at 1920**. `flex: 1 1 440px`
with a **24px** gap reproduces both exactly — at 1500 only three 440s fit so each grows to
(1421-48)/3 = 457.7, at 1920 four fit and each settles at (1837-72)/4 = 442. A fixed basis is
right at one width and wrong at the other, which is precisely what measuring at a single
width cannot tell you.

⚠️ **THE SECOND ROW'S TILES ARE 396.5 TALL, NOT 370.5** — measured directly on Today's
Events, Today's Tasks and My Goals rather than read off the mixed list of ten `.slds-card`
heights (that list includes nested cards, which is how 370.5 got picked).

⚠️ **THREE SLDS ILLUSTRATIONS WERE MISSING ENTIRELY, and they are `<img>` not `<svg>`** —
which is why an svg inventory of the capture found 34 icons and none of them. Extracted
verbatim to `public/icons/salesforce/`: `illus-events.svg` (257x108), `illus-tasks.svg`
(256x90) and `goals-rings.svg` (**127x126**). That last one matters most: **My Goals' four
circles are ONE illustration**, and two passes hand-built them out of spans, getting the
size, the overlap and the avatar glyph wrong every time.

⚠️ **THE TOP-RIGHT CONTROLS ARE BORDERED 32px BUTTONS, and the two are different variants:**
round on My Goals (`border-radius: 240px`) and square on Today's Tasks (radius 4), both
`1px solid #747474` at x=393.3 y=13. Drawing either as a bare glyph is a large part of why
the tile chrome read as wrong.
⚠️ **"Set goals" IS A PILL INSIDE THE BODY** — 90.3 x 32 at radius 240, `#0176D3`, centred —
and My Goals has NO `.slds-card__footer` at all, where every other tile does.

⚠️ **EVERY SLDS ICON IS ON A 520 GRID, filled not stroked.** Dropping one of those paths into
a 24-unit viewBox renders an invisible speck. `SldsIcon` sets `fill: currentColor` so callers
tint them the way Lightning does.
⚠️ **TWO MARKS COULD NOT BE EXTRACTED AND ARE AUTHORED, both flagged in code**: the
Salesforce cloud logo (the capture's `<img>` has no src — `class="icon noicon"`) and the
"Invoca Call Log" object glyph, whose data URI is an EMPTY `<rect fill-opacity="0"/>`. The
object TILE colours are the capture's own inline styles: Opportunity `#FF5D2D`, Contact
`#9602C7`, Invoca Call Log `#8b85f9`, all 32 square at radius 4.
⚠️ The Opportunity and Contact glyphs, and the Salesblazer banner (a webp), ARE extracted
verbatim to `public/icons/salesforce/`.

Verified after the rebuild: a **26-property diff against the spec came back empty**, 3 cards
per row at 1500 and 4 at 1920, 31 SLDS icons rendering, **zero Material ligatures left**, zero
broken images.

### Salesforce: the original notes (screen 1 of 4, 8/24/2026)
The **Sales Cloud** tile on Integrations opens `/salesforce` — `SalesforceHome.tsx` + `.sfh-`,
from a SingleFile capture of `lightning.force.com/lightning/page/home`. The planned flow:
Seller Home -> **Calendar** tab -> the appointment the SMS AI agent just booked -> open it and
its fields are filled from that conversation. **Only screen 1 exists so far.**

⚠️ **A REACT REPLICA, NOT AN EXACT-COPY PAGE — a deliberate departure from the
third-party-console convention** (Google Ads and the Invoca Exchange are saved HTML). The
flow is the reason: later screens must show the appointment the SMS agent booked and open it
with that conversation's values, so they need prospect data and real routing, and a 1.6MB
Lightning document gives neither. Same call `GoogleSearch` and `ChatGptAd` already make.

| | measured |
|---|---|
| face | **`-apple-system`**, NOT Lato — this screen does not inherit the platform font |
| global header | 50 tall | 
| nav bar | 40 tall, white, **3px `#0070D2`** bottom rule (the Lightning tell) |
| page | `#F3F3F3` behind white cards |
| card | 457.7 x 333, white, radius 4, 1px `#C9C9C9`, shadow `0 2px 2px rgba(0,0,0,.1)` |
| card title / sub | `700 16/20` `#181818` / `13/19.5` |
| ring | 150 x 150, `circle r=72`, stroke-width 6, track `#E5E5E5`; value `300 28/35` `#2E2E2E` |
| legend | 10px dot; pill radius 4, padding `4px 9.6px` |
| footer button | full width, 32 tall, 1px `#747474`, radius 4, ink `#0176D3` |
| greeting | `300 13px/49px` `#444` — the 49px line box is what puts it on the h1 baseline |

⚠️ **THE THREE LEGEND PALETTES ARE MEASURED PAIRS**, not one hue at two opacities:
open dot `#06A59A` / pill `#ACF3E4` / ink `#056764`; won `#0D9DDA` / `#CFE9FE` / `#05628A`;
lost `#FE5C4C` / `#FEDED8` / `#BA0517`. Plan My Accounts' ring is the lost coral at full
circle (its `stroke-dasharray` is `none` — nothing here is a partial arc).

⚠️ **THE CAPTURED ORG IS EMPTY and that is reproduced, not filled in** — $0 pipeline, 0
contacts, 0 leads, 5 accounts with no activity. This is the SE's own Salesforce, not the
prospect's, so inventing a pipeline would be inventing Invoca's numbers.
⚠️ **RECENT RECORDS IS THE ONE DATA-BEARING TILE** and is derived: the caller from
`voiceScreenpop.callerName` plus `callDetail.callId` and the CI report's first call id, so a
record here is a call the rest of the demo already knows about. The capture's own rows name a
real person in that org.

⚠️ **THE NAV COUNTS 16 TABS, AND THE DOM SAYS 20.** Every tab also carries an "<X> List"
entry — those are its dropdown items, not tabs. Counting anchors gives the wrong bar.

⚠️ **EVERY TAB IS INERT, INCLUDING CALENDAR, UNTIL ITS SCREEN EXISTS.** There is no `*`
catch-all in the router, so linking Calendar before screen 2 lands would put a BLANK page
mid-demo behind a tab that looks live. Flip it to a `Link` in the same commit that adds the
screen.

Verified: a **24-property diff against the spec came back empty**, 16 tabs, 8 cards, zero
anchors (nothing falsely clickable), Recent Records showing Shady Blinds' own Jessica Harper
and two INVOCA call ids, and the Sales Cloud tile lands here with no Invoca chrome.

### Integrations: the IN-PLATFORM page (measured live 8/24/2026)
`src/screens/Integrations.tsx` + `.itg-`, from the live `/networks/2160/action_collections/ui`
(Invoca's own React, same-origin) plus a SingleFile capture for the logos. The sidebar's
**Integrations** now opens THIS, not the marketing-site copy.

⚠️ **NOTHING WAS DELETED.** `public/invoca-exchange.html` and its Google Ads tile still work,
now at `/invoca-exchange`; `/integrations/google-ads` -> `google-ads.html` is untouched. The
new page's **Google Ads** card routes to that same path, so the existing click-through is
reached from the real screen instead of the marketing page. **ChatGPT Ads** routes to
`/integrations/chatgpt` (the existing sponsored-ad screen).

| | measured |
|---|---|
| h1 | "Integrations" 24/36 `#15243E` |
| search | 274 x 36, 1px `#E7E9EB`, radius 3, white, 16/23 text, 24px icon `#66708E`; 60 under the h1, 30 above the first heading |
| heading | h2 **sentence case in the DOM**, uppercased in CSS, 16.5/19.8 `#868E96`, 19.5 below |
| tile | white, radius 8, shadow `0 4px 4px rgba(0,0,0,.2)`, NO border, **79.5** tall, inner padding 13 |
| logo | 50 x 50 image in a column 63.6 wide (50 + 13.6 of `pr-3`) |
| badge -> name | **6.5px** — 23 badge + 6.5 + 24 name + 26 padding = the 79.5 |
| badge | 10px/10px, padding 6.5, radius 100px, `text-transform: capitalize` |
| grid | 30px gutter, 30px row gap; **4 cols >= 1400, 3 >= 1200, 2 >= 576, 1 below** |

⚠️ **THE PAGE IS WHITE AND CARRIES A THIN RULE UNDER THE HEADER** (both added on request
8/24/2026, both measured off the live page): the content surface is the app shell's
`.site-content.card` — `#fff`, `1px solid rgba(0,0,0,.125)`, `border-radius: 5px 0 0 0`, inset
21px — and the header band is `padding: 20px 0` with `border-bottom: 1px solid #E7E9EB` and
39px of margin under it, which is exactly the 60px the h1 sits above the search box. Ours
painted no background, so the body's `#f6f7f9` showed through behind the cards.

⚠️ **ChatGPT Ads AND Google Ads ARE IN THE *INTEGRATED* SECTION, a deliberate departure from
the capture** (requested 8/24/2026). Both are library "Learn More" / "Ready To Integrate"
cards on the live page because that account has neither journey built; this demo HAS both (the
captured Ads console and the ChatGPT sponsored-ad screen), so Integrated is the true state
here. They keep alphabetical position, which is how the live INTEGRATED list is ordered, and
they are removed from LIBRARY so neither appears twice. Still the only two cards that
navigate.

⚠️ **THE COLOURED LEFT EDGE IS AN 8px DIV, NOT A BORDER**, and one palette dresses both it
and the badge chip: integrated `#ABE5BC`/`#0D5400`, ready `#B0CDFF`/`#003399`, learnMore
`#E7E0F9`/`#440066`. EVERY tile has a stripe including Learn More — the lilac is quiet enough
to read as no stripe in a screenshot, which is how it nearly got left out.

⚠️ **4 COLUMNS NEEDS 1400 OF *LAYOUT* VIEWPORT, and one measurement got this wrong.** At
`innerWidth` 1406 the real page rendered THREE columns, because the classic scrollbar puts the
layout viewport under Bootstrap's 1400 xxl breakpoint while `innerWidth` still reads 1406.
Re-measured at 1500: four columns, `matchMedia('(min-width: 1400px)')` true. Exactly what the
measure-at-more-than-one-width rule exists for.

⚠️ **THE CARD LIST IS INVOCA'S OWN CATALOGUE and is NOT re-skinned** — every name is a real
third-party product, identical in every account, like the Semantic Signal library. The
per-account part is which are Integrated / Ready To Integrate, kept as captured: they name no
customer, and an empty Integrated section would read as a broken page.
⚠️ **"TEST - Do not turn live" IS OMITTED** — an internal artifact of that account, not
something to put in front of a prospect. 49 captured tiles -> 48 rendered.

⚠️ **LOGOS EXTRACTED VERBATIM to `public/icons/integrations/` (46 files)**, per the standing
use-the-real-icons rule: 44 raster logos, 2 inline SVGs (Custom Webhooks, Invoca APIs), and
Favorite Actions is a Material `star_border` ligature exactly as the live page renders it.
HubSpot and HubSpot MCP SHARE one file — the same icon-sharing the Add Tile picker documents.
⚠️ **THE BASE64 CARRIES `%0A` ESCAPES.** SingleFile writes the newlines it wrapped into the
attribute as `%0A`, and `img.src` hands them back the same way. A walker that treats `%` as a
terminator stops instantly: 3 of 47 logos extracted and 44 reported "missing". The extractor
skips `%0A`/`%0D` as whitespace, and the DOM-side fingerprints are taken after
`decodeURIComponent`, or the two sides never match.
⚠️ Three logos are CSS `background-image` data URIs on a sprite-style div (Sales Cloud, Google
Ads, Invoca for AdWords) rather than `<img>`, so any extractor has to read computed
`backgroundImage` too. Rendered here as plain 50x50 images like the rest — the real ones sit
in a 58x40 box — which trades a 2px difference for 48 uniform tiles.
⚠️ **Resampled to 160px: 1.68MB -> 492KB.** They render at 50px and several were 300-500KB.
They live under `public/` and are referenced by URL, so none of it reaches the single bundle.

⚠️ **ONLY TWO CARDS NAVIGATE.** The live cards open Invoca's own documentation, which is not
captured, so every other card is inert and carries no pointer cursor. A card that navigates
somewhere invented is worse than one that does nothing.
Unmeasured choice, stated: when a search empties a section, its heading is hidden too.

Verified: a **16-property diff against the spec came back empty**, tile 79.5 / badge gap 6.5 /
logo column 63.6 all exact, 48 tiles, 4 per row at 1500, **zero broken images**, the sidebar
marks Integrations active, real typing "google" filters 48 -> 5, and both live paths work end
to end (Google Ads -> `google-ads.html` titled "Search Keywords - Finance - Google Ads",
ChatGPT Ads -> the ChatGPT screen). `/invoca-exchange` still serves the old copy with its
Google Ads tile. `/dashboards/marketing` unchanged (21 cards, 4px, KPI 48,293, 7 donuts, zero
`.itg-` leakage).

### The Integrations click-through (demo circuit)
Sidebar **Integrations** → `/integrations` → `StaticRedirect` to `/invoca-exchange.html`
→ click the **Google Ads** tile (JS override injected in the HTML) → `/integrations/google-ads`
→ `StaticRedirect` to `/google-ads.html` → click the **Google Ads logo (top-left)** → back to `/dashboards`.

⚠️ **Testing the exact-copy pages: use a REAL click, never `el.click()` or a
synthetic `MouseEvent`.** The injected `demo-back-nav` script in
`public/google-ads.html` treats any click with `clientX < 255 && clientY < 60` as
the Google Ads logo and navigates to `/dashboards`. A synthetic MouseEvent
defaults those to 0/0, so it ALWAYS trips the back-nav wherever you aimed it,
which looks exactly like the Next/Prev walkthrough being broken. It is not: the
walkthrough works fine when clicked at real coordinates.

### How the exact-copy pages were made (reproduce if a page changes)
Server-side `curl` gets a different A/B variant than a real browser, so:
1. Open the real page in a browser, **File → Save Page As → "Webpage, Complete"**.
2. Drop the `.html` + its `_files/` folder into `public/`.
3. Process the HTML: for SPA pages (Google Ads) **strip all `<script>` tags** so the
   saved rendered DOM displays statically instead of re-hydrating and blanking;
   remove chat/consent widgets (Qualified/OneTrust) and any width constraints they
   injected; inject the click overrides (Google Ads tile → demo; logo → dashboard).
   (Processing scripts were run from scratch; not committed — re-create as needed.)
- The Exchange page loads GT America font + logos from Invoca's CDN (needs internet).
- These render the **desktop layout at ≥992px** (they're the real responsive pages).

## Signal AI Studio
- `src/screens/SignalAiStudio.tsx`, route `/signal/ai-studio` (replaced the Placeholder).
  Reached from the Signal flyout's middle item. Real page: `/networks/2751/label_groups/manage`.
- Values MEASURED off the live page 8/17/2026: page bg `#f6f7f9`; h1 24px/400; New AI Model
  `#2666f9` 14px/500 radius 3 pad 8/12; info banner bg `#d4e0fe` ink `#11228c` 14px radius 3;
  row card white, 1px `#e7e9eb`, radius 5, shadow `0 2px 4px rgba(12,0,51,.2)`, 12px gap;
  model name 16px/700; label line 16px/400; Round chip `#e7e9eb` / `#5b6577` / 12px /
  radius 16; action button **outlined** (white, `1px rgba(38,102,249,.5)`, ink `#2666f9`,
  12px/500, 32px tall) -- the leaf holding "Label Calls" has NO chrome, it is on the
  ancestor `<button>`, so measure the button not the text.
- **TWO cards.** The live capture had four (it also carried a `quote, sales_call,
  service_call` intent model and one named from `profile.networkName`); trimmed on request
  to the two that carry the story. Keep one of each ROUND state so both action buttons stay
  visible on screen.
- **Card 2's label re-skins; card 1's deliberately does not.**
  - Card 2 is `${snake(profile.bookingTerm)}_set` -- THAT PROSPECT'S LEAD CONVERSION.
    `bookingTerm` is the same field the platform renders as "<term> Booked (Conversion)"
    everywhere else, so this is the right source, not an approximation of one. Snake_case
    the WHOLE term or "Test Drive" becomes `drive_set`. Verified across the library:
    `consultation_set`, `estimate_set`, `quote_set`, `lifestyle_visit_set`,
    `installation_appointment_set`, `service_appointment_set`, `appointment_set`.
  - Card 1 stays `sales_qualified_lead` -- a generic qualification model that reads the
    same in every Invoca account. Re-skinning it would invent an account-specific name for
    something that is not account-specific.
  - Derived in the component: no schema change, no engine phase, so every profile already
    on disk gets it and generation time is unchanged.
- **Creation dates are HASHED from the profile id, never `new Date()`.** The page shows
  "Created on ..." timestamps; if they moved on every open, an SE could not rehearse
  against the screen or screenshot it twice the same way. Anchored before the demo's
  January 2026 window so a model reads as trained before the calls it scored. Verified
  identical across reloads.
- `Round 0` gets "Label Calls", a round-tripped model gets "Verify Labels". That is the
  only thing driving which button appears.
- The chevron expands to show the row's own labels as chips. What the real page reveals was
  not captured, so it deliberately shows only what the row already knows rather than
  inventing training statistics a prospect might ask us to explain.

## USE THE REAL ICONS (standing rule for every replica)
Never substitute a lookalike glyph. Material Icons stood in for the Add Tile picker's
artwork and it was wrong in four ways at once, none of which a screenshot shows:

- **The real set has its own palette** -- #1643D5 #5185FA #2666F9 #7DA3FB #B0CDFF,
  #2CBF58 green, #33E5C9 teal, #FFD800 yellow, #5B6577 axis grey. Flat single-colour
  Material glyphs read as a different product.
- **Icons are SHARED.** Fourteen Add Tile cards use only TEN files: one line icon
  across Single and Multi-Line, one clock across Calls by Hour and Day of Week, one
  table across all three Reports. Giving each card its own glyph invents distinctions
  the product does not make.
- **Some are gradient-filled.** Build With AI paints Material's auto_awesome path with
  a hidden `<defs>` linearGradient (#66ebd7 -> #7da3fb -> #a182e5). Flat purple looks
  plausible alone and clearly duller side by side.
- **viewBoxes differ** (most are 48x48; calls-by-time is 25x24), so sizing has to come
  from CSS rather than the file.

HOW TO EXTRACT THEM. On the live page the icons are `<img>` elements whose `src` is a
base64 data URI. Read the srcs with `javascript_tool`, then decode to real files:

    printf '%s' "<base64>" | base64 -d > public/icons/<screen>/<name>.svg

Verify the decoded byte count against the length the page reports -- a truncated tool
result would otherwise write a silently broken file. For anything over ~8KB of base64,
fetch it in halves and concatenate; one 14KB string risks being clipped.

Dedupe FIRST (group the srcs and count unique assets) so the shared files are obvious
before any are written. These are Invoca's own icons in Invoca's own internal tool, so
extracting them verbatim is correct; approximating them is not.

## ONE CSS PREFIX PER SCREEN (standing rule)
Two screens sharing a class prefix is a bug that presents as "the design is off", which
is the worst possible symptom because it sends you re-measuring geometry that is already
correct. The tile Configuration drawer and the Insights CALL DETAIL screen both used
`.icd-`, and three names collided outright: **`icd-body`, `icd-field`, `icd-title`**.
Call detail's `.icd-body`/`.icd-field` are flex containers and its `.icd-title` is
26px/600, so the drawer's 452px fields measured **52.7px wide**, one label came out
**248px tall**, and its 24px/400 title was overridden. Every value in the drawer's own
CSS was right.

The drawer is now **`.itc-`**. Before adding a screen's styles, grep for the prefix:

    comm -12 <(grep -o 'xyz-[a-z-]*' A.tsx | sort -u) <(grep -o 'xyz-[a-z-]*' B.tsx | sort -u)

⚠️ A prefix rename must also catch the **BARE base class**. `.icd` -> `.itc` is not
covered by replacing `icd-`, so the panel kept `className="icd"` against a stylesheet
that only defined `.itc` and the drawer rendered with no styling at all.

## Insights & Analytics: the three Reports are DIFFERENT surfaces
`src/data/insightsColumns.ts` holds the measured group -> column membership, extracted by
walking the accordions in saved captures of all three live builders. Do not infer
grouping from column names: the keyword rules that preceded this put Agent under Contact
Center Metrics and a third of the catalogue into "Short Text Fields".

| Report | Groups | Sidebar |
|---|---|---|
| Details | 20 | Reorder columns, seeded with Call Record ID |
| Summary | 11, **measures only** | **Group By** + Reorder, seeded with nothing |
| Transactions | 21 (Details + RingPool Details) | Reorder, seeded with Call Record ID **and** Transaction ID |

⚠️ **A SUMMARY COUNTS BOOLEAN FLAGS**, which is why Summary first came out two groups
short. Live Summary shows Signals with 75 columns and Voice AI with 5 — signal names and
"Voice AI Agent Engaged" and friends. None reads as a metric, but a summary counts them.
The tell is STRUCTURAL, not lexical: each has a `<name> (T/F)` twin in its own group, so
`countableFlags()` finds them from the group's own contents and therefore works for a
prospect's generated signals without naming any of them.

⚠️ **Our column totals are LOWER than the captured account's and that is correct**
(240 v 371). Almost all of the difference is Signals: that healthcare account has 75
configured signals (150 entries with twins), Shady Blinds has 11. Do not "fix" it by
padding the list with that account's signals — the whole point is deriving from the
prospect. Scores is the same story.

⚠️ **The checkbox grid is a BREAKPOINT, not `auto-fill minmax()`.** Measured 653px -> 2
columns and 1439px -> 3. No single minimum satisfies both (it would have to be >359 and
<=326 simultaneously), so it is MUI's lg breakpoint: 3 columns at >=1200px, 2 below.
A single-width measurement cannot tell these apart, which is the whole reason for the
two-width rule below.

⚠️ **The three reports share ONE route pattern**, so React Router reuses the component
when only `:report` changes and `useState(sidebarFor(kind).seeded)` never re-runs.
Transactions showed Details' single seeded column and Summary showed one it should not
have had at all. Reset on `kind` change, and test by navigating in an order built to
expose stale state (details -> transactions -> summary -> details), not by loading each
report fresh.

## Creating a dashboard: New -> name + description -> an empty dashboard (8/23/2026)
`src/data/insightsDashboards.ts` (the store), `src/components/NewDashboardModal.tsx`
(`.ndm-*`), `src/screens/InsightsEmptyDashboard.tsx` (`.ied-*`), and the `?to=` plumbing in
`InsightsAddTile` / `InsightsColumnPicker` / `InsightsDashboard`. **+ New** on Insights &
Analytics opens the modal; Create lands on the new, empty dashboard, and Add Tile there fills
it in place. Both captures are Invoca's own React (no ThoughtSpot iframe), so every value
below is measured off the rendered DOM rather than a screenshot.

| modal | measured |
|---|---|
| backdrop | `rgba(0,0,0,.5)` |
| paper | 500 x 422, white, radius 3, MUI elevation shadow |
| title | "New Dashboard", Lato 20/400 `#15243E` at 12,12; 1px `#E7E9EB` under the band |
| label | Lato **16/700** `#15243E` |
| field | **384** wide, radius 3, 1px `#E7E9EB` — Name 40 tall, Description 56 |
| footer | buttons 36 tall; Cancel OUTLINED (`1px rgba(38,102,249,.5)`, ink `#2666F9`) |
| Create | **disabled until the name has content** — the capture's is `disabled` with both fields empty. Description is optional |

### The empty state, RE-MEASURED 8/23/2026 — the first build had the layout wrong
The first pass had every colour, font and radius right and still did not read as the same
screen, because the SHAPE was wrong. Re-measured off the capture "Creating | Invoca for
Healthcare 2.0", which is Invoca's own React rendered as a **`ts-embed__overlay` in the HOST
page** — so it serialises in full and nothing here comes off a screenshot. Confirmed at
**three widths (900 / 1262 / 1920)**.

⚠️ **THE CONTENT IS ONE CENTRED COLUMN, AND THAT IS THE WHOLE SHAPE.** Measured
`flex-direction: column; align-items: center; gap: 24px; padding: 24px` on a container the
full width of the content area. Both children are therefore sized by their own content and
centred — the empty block is **320** wide and the panel **1074**, with air either side.
Rendered as full-width siblings instead, the panel spans the page and drags the cards with
it, which is exactly what looked wrong.

| empty block (320 x 310.5) | measured |
|---|---|
| illustration | 320 x 220 (an inline `<svg>` in the real page) |
| copy | **296** wide, `700 16px/20px` `#15243E`, centred, `margin: 16px 0 6.5px` |
| Add Tile | **98.6 x 36**, `margin-top: 12px`, padding 8px 12px, radius 3, `#2666F9` |

It decomposes exactly: 220 + 16 + 20 + 6.5 + 12 + 36 = **310.5**.

| templates | measured |
|---|---|
| wrapper | full width, `display: flex; justify-content: center` — this is what centres it |
| panel | **1074** wide, `max-width: 100%`, `#F5F6FA`, 1px `#E7E9EB`, radius 8 |
| heading | 16/20 `#15243E`, `text-transform: uppercase`, padding `24px 0 24px 24px`, 68 tall |
| cards grid | **`320px 320px 320px`**, gap **32**, `align-items: start`, padding `0 24px 24px` |
| card | **320** wide, **2px** `#E7E9EB`, radius **8**, `box-shadow: none`, padding 24 |
| card heights | **124 / 124 / 164** — content-driven and DIFFERENT |
| card title / body | `700 16/20` with 12px under it / `16/20`, both `#15243E` |

⚠️ **THREE FIXED 320px COLUMNS, NOT `auto-fit minmax()`.** The grid computes
`320px 320px 320px` at 900, 1262 AND 1920, so the cards never stretch and never reflow, and
the panel's 1074 is just this grid plus its padding and border (960 + 64 + 48 + 2).
`align-items: start` is load-bearing — stretching made all three cards the same height where
the real third one grows to 164 for its fourth line of copy.
⚠️ **BELOW ~840px OF PANEL THE THIRD CARD OVERFLOWS THE PANEL'S RIGHT EDGE.** Measured at a
900px viewport on the real page: the panel clamps to `max-width: 100%` while the grid stays
3 x 320. That is the product's own behaviour, reproduced rather than "fixed".
⚠️ **NO SHADOW, DESPITE THE MUI `elevation1` CLASS** — measured `box-shadow: none`. A 1px
border at 4px radius reads as a Dashboards-tab card instead.
⚠️ **The real cards are `cursor: pointer`; ours deliberately are not.** They are inert here
(see above), and a pointer cursor on a card that does nothing is the same lie the interaction
drawer's inert cards already avoid.

⚠️ **THE LIVEBOARD TITLE IS 24/36/400, where the shared `.ind-title` is 28/42/600.** Scoped
to `.ied-page` so the Summary Dashboard and Connect AI are untouched (re-verified: both still
`600 28px/42px` `#1D2B4A`). **OPEN:** those two are probably 24/36 as well — all three are
the same liveboard header — but this capture is of THIS dashboard and cannot settle it.
Re-measure from their own captures before widening.
⚠️ **CORRECTED 8/24/2026 — the scoping note below was too cautious and one claim in it was
WRONG.** It said the Dashboards tab is "measured grey-page-with-white-cards" and so must not
be whitened. `.dash-page` has carried `background: var(--color-white)` since the INITIAL
COMMIT, with the comment "matches the live screen" — the Dashboards tab was always white, and
the `#f6f7f9` in the page-chrome note is the body behind it, not the dashboard surface. The
white is now on `.ind-page` + `.idt-page`, covering all four Insights screens. Audited every
`*-page` wrapper in app.css for a painted background: the only one left unpainted was
`.ssa-page` (Semantic Signal Activate), whose two siblings `.sts-page` and `.ssl-page` are
both `#fff` — fixed. `.sas-page` (Signal AI Studio) stays `#f6f7f9` because that IS measured.

⚠️ **THE PAGE IS WHITE, AND NOT PAINTING IT WAS A VISIBLE BUG.** Measured: the whole content
area is `rgb(255,255,255)` (`ts-embed__overlay`), which is what
`--ts-var-liveboard-layout-background` says and what the very first Insights note in this file
already recorded. This screen painted no background at all, so the app body's `#f6f7f9` showed
through — and because **the illustration's own ground is `#F5F6FA`**, the artwork's backdrop
blended into the page and the whole thing read as washed out. On white that ellipse reads as a
panel, exactly as the reference does. `min-height: 100%` keeps the grey from reappearing under
a short page (verified: no spurious scrollbar). Scoped to `.ied-page` — every other Insights
screen paints nothing either and is probably grey for the same reason, but each is signed off
and widening it is its own pass.

⚠️ **THE DESCRIPTION IS NOT RENDERED, and that IS the measurement.** The captured liveboard
header carries the crumb and the title and nothing else. It used to print under the title,
where it read as a stray word in the corner. Still collected by the modal and stored on the
dashboard; put it on screen only against a capture that shows one.

⚠️ **THE ILLUSTRATION IS GREY BY DESIGN — 13.5% of its painted pixels are chromatic.** The
figures are `#66708E` / `#8A919E` / `#B8BDC5` with blue accents (`#2666F9`, `#7DA3FB`,
`#D7E6FF`) and one skin tone (`#FFC6B5`). Rasterised at 300x204 our file is **pixel-identical
to the real inline svg** — 47,339 painted, 6,370 chromatic, same top-10 histogram — so
"make it colour" is already satisfied by matching; what made it look flat was the grey page
above.

⚠️ **BUT `<lineargradient>` IS A DIFFERENT ELEMENT FROM `<linearGradient>` IN XML, AND ALL 12
OF OURS WERE LOWERCASE.** SingleFile serialises SVG element names in lower case; the HTML
parser silently case-corrects known SVG names, which is why the capture renders correctly and
why the bug is invisible until the same bytes are loaded through an `<img>`, where they are
parsed as XML. Every `fill="url(#paintN...)"` then resolved to nothing and the 12 gradient
shadow washes did not paint (measured: ~1,100 pixels of soft shading, and 0 chromatic pixels
— so this was NOT the cause of the flat look, only a real defect found while checking it).
Corrected in `public/insights-empty.svg`; verified by parsing the file with `DOMParser` as
`image/svg+xml` and confirming all 12 `url(#…)` references resolve.
⚠️ **THE EASY WAY TO EXTRACT AN SVG FROM A CAPTURE IS `XMLSerializer` ON THE LIVE NODE**, not
a regex over the saved text — the DOM has already been case-corrected, so serialising it gives
valid XML with no hand-fixing. Attribute quoting (the earlier broken-image bug) is handled the
same way.

⚠️ **#1335BF WAS A HOVER STATE, NOT A SECOND DESIGN.** The centre Add Tile serialised at
`rgb(19,53,191)` while the header's identically-classed one read `#2666F9` — the capture
caught the cursor over it. Resolving the emotion rules gives
`--titan-tokens-background-primary-bold-hover: #1335BF` and `-pressed: #122AA6`, so the
resting colour is `#2666F9` for both and the hover/active values are now measured rather than
taken from the general button note's `#1c53e9`/`#1643d5`.

Verified after the rebuild: a **30-property diff against the measured spec came back empty**
at 1262, and the panel stays 1074-and-centred with 320px cards at 1920.

⚠️ **THE DESTINATION DASHBOARD WAS HARDCODED, AND THAT WAS THE REAL BUG IN THIS FEATURE.**
Both Add Tile screens carried `const DASH = "/insights/dashboard/Summary%20Dashboard"` and
built every tile against it. That was accidentally right while the Summary Dashboard was the
only screen with an Add Tile button, and silently wrong the moment an SE could create their
own: the tile was stored under the Summary Dashboard's key, so the new dashboard stayed empty
and the tile turned up on a screen nobody was looking at. Now `?to=<path>` is carried from
the button, through Add Tile, through the Report column picker (and its Back), to the
`addTile` key — verified end to end with real clicks: a Details Report built from
`Q3 Marketing Review` landed under `shady-blinds::/insights/dashboard/Q3%20Marketing%20Review`
while the Summary Dashboard's own 5 tiles were untouched.
⚠️ **`dashboardFrom` VALIDATES the parameter** rather than trusting it. The return value is
half of a tile-store key, so an unchecked `?to=` would let a hand-edited URL write tiles
against any key it liked. Only `/insights/dashboard/<name>` is accepted; anything else falls
back to the Summary Dashboard. It also decodes once and re-encodes the name, so the key
matches `location.pathname` whether the caller passed the path raw or encoded.

⚠️ **THE EMPTY STATE IS A STATE, NOT THE SCREEN.** The illustration and the templates panel
are gated on `tilesFor(key).length === 0` — the SAME key `DashAssistant` renders from, so the
two cannot disagree. Without the gate a dashboard reads "add a tile to get started" directly
above the tile you just added, which is indistinguishable from the add having failed.

⚠️ **PER PROSPECT, NO TTL.** Keyed by profile id like the SMS and Voice capture stores
(verified: switching to `autonation` empties the list and the created dashboard does not
leak), but with no expiry — a captured conversation is a session artifact, a dashboard
somebody named is not. Consequence, stated rather than discovered later: localStorage means
per browser, so a built dashboard does NOT follow a demo to a colleague. Move it into the
demo record if sharing one ever matters.

⚠️ **`InsightsReport` CHECKS THE SE'S OWN DASHBOARDS FIRST**, so a new one named "Details
Report" opens as theirs rather than vanishing behind the seeded report.

⚠️ **THE ILLUSTRATION IS INVOCA'S OWN, extracted verbatim** to `public/insights-empty.svg`
(170 paths, 103,377 bytes) per the use-the-real-icons rule, referenced as an `<img>` rather
than inlined — at ~100KB it would otherwise land in the single bundle every screen loads.
⚠️ **SingleFile WRITES UNQUOTED ATTRIBUTES, AND AN SVG IN AN `<img>` IS PARSED AS XML.** It
rendered as a broken image until the attribute values were quoted; `xml.etree` reported
"not well-formed (invalid token): line 1, column 17", which is the fastest way to check one.
⚠️ **THE HEADER STRUCTURE IS `InsightsDashboard`'s, COPIED EXACTLY** — a div holding
`.ind-crumb` + `.ind-title`, then a sibling `.ind-actions`. Inventing `.ind-titlerow` and
`.ind-breadcrumb`, neither of which exists, right-aligned the title and wrapped the buttons
underneath. The `.ind-*` rules are reused READ-ONLY, per the Connect AI note.

⚠️ **THE THREE DASHBOARD TEMPLATES CARDS ARE INERT, DELIBERATELY.** Their names and copy are
the product's, but the capture shows only the cards, not what any of them builds. Wiring them
means inventing three dashboard layouts and presenting them as Invoca's — the same call the
Semantic Signal library makes for its uncaptured phrase lists. Give me the tile list for each
and they become real.
⚠️ Also unwired: `useInsightsDashboards().remove` exists and nothing calls it. The kebab is
the obvious home for Delete; it was not part of the ask, so there is no half-built menu.

Non-regression after this: Summary Dashboard 48,293 / 20,224 / 28,069 with its 5 generated
tiles and 11 charts, Details Report screen still 17 columns / 200 rows / 13px Lato, Connect
AI 10 charts, `/dashboards/marketing` 21 dash-cards at 4px radius with KPI 48,293 and 7
donuts and **zero `ts-` or `ied-` elements**, `npm run audit:ai` all green. (`npm run audit`
reports 8 of 20 demos passing — verified identical with these changes stashed, so those are
pre-existing generated-profile failures, not this work.)

### A template card opens "Dashboard Configuration" (measured LIVE 8/24/2026)
`DashboardConfigDrawer.tsx` (`.dcd-`) + `dashboardTemplates.ts`. Clicking **Lead Conversion
Dashboard** slides in an 800px right drawer. Measured off the LIVE page with the drawer open
(same-origin, Invoca's own React), so every value is a computed style:

| | measured |
|---|---|
| backdrop | `rgba(0,0,0,.5)` |
| paper | 800 wide, anchored RIGHT, white, `transform 225ms cubic-bezier(0,0,.2,1)` |
| title | "Dashboard Configuration", 20/28 `#15243E` |
| Name | label 16/23, field 752 x 35 radius 3, **pre-filled with the dashboard's own name** |
| lede | "Select the data that best fits these categories.", 16/20 |
| category | label **700** 16/20 (28 tall) · field 752 x 35 · help **ITALIC** 16/20 |
| between | **40px** from one help line to the next label |
| footer | 62 tall = 12 + 36 + 12 **over a 2px `#E7E9EB` top border** |
| footer buttons | right-aligned, **8px** apart, inset a further **16px** (Save ends 40 from the paper edge) |
| Save | **disabled on open**, `#E7E9EB` on `#A1A7B2` |
| dropdown | 752 wide, max-height **374.4**, radius 3, padding 8px 0; option 32 tall, 6px 16px, 16/20 |

⚠️ **FIVE CATEGORIES, TWO OPTION LISTS — read off the comboboxes' React props, not by
opening one menu.** The three *Metric* fields share ONE list (that account's **75** Signals)
and the two *Marketing* fields share ANOTHER (its **96** marketing data fields). Opening a
single dropdown and generalising would have invented three lists that do not exist. Reading
`memoizedProps.options` off the fiber got all five in one call and proved the sharing.

⚠️ **BOTH LISTS ARE RE-SKINNED, because both are account data.** The captured lists name
Facility / Medicare / Patient Type / Specialty. Ours come from the prospect's own catalogue:
the Metric fields from the **Signals** group minus its `(T/F)` twins (a metric picker is not
a column picker), the Marketing fields from **Categories + Short Text Fields + Long Text
Fields**. Shady Blinds gets 13 and 85 against the account's 75 and 96 — lower, and correct,
the same call the 240-v-371 column note makes. Verified zero healthcare leakage.

⚠️ **`Interaction Count` and `Transfer` ARE APPENDED AFTER the alphabetical run** in the
Signals list — measured, and it looks like a sorting bug until you check.

⚠️ **THE MARKETING LIST IS IN THE PRODUCT'S ORDER, NOT ALPHABETICAL.** "Calling Page" comes
BEFORE "Call Intent" and "Masked Caller ID" sits between "Call Type" and "Consumer Name", so
it sorts on an internal field key. `MARKETING_ORDER` pins the captured sequence (product
chrome, like the column groups themselves) and orders the prospect's own fields by it.
⚠️ **RESOLVE THE `{TOKEN}`s, DO NOT PATTERN-MATCH THEM.** The first version turned each
token into `.+` and took the first match, which breaks two ways: a bare `{LOCATION}` becomes
`^.+$` and matches ANY column, and two entries can claim the same column and strand the
other. Measured: six Shady Blinds fields (Consultation Status, Customer Type, Product
Category, Showroom, Showroom Type, Showroom Zip) fell out of position into the alphabetical
tail. Resolving through the same `vocabFor` the column table uses puts all six back (indices
4 / 61 / 75 / 25 / 30 / 32).

⚠️ **ONE CARD IS LIVE, TWO ARE INERT.** All three live cards are `cursor: pointer`, but only
Lead Conversion's drawer is captured; the other two keep `fields: null` and no pointer, since
reusing these five categories for an SMS dashboard would put invented labels in front of a
prospect.
⚠️ **WHAT SAVE BUILDS IS UNMEASURED AND WAS NOT GUESSED — saving on the live page would have
written to a real customer's dashboard, which is not ours to do.** Save stores the five
choices and closes. Give me a capture of a built Lead Conversion Dashboard and the layout
becomes real.
⚠️ Save enables only when ALL five are answered. Measured `disabled` with four of five empty;
whether ONE empty is enough to disable it is not measured, and five-of-five is the reading
that fits the drawer's own instruction.

Verified end to end with real clicks: a **21-property diff against the spec came back empty**
(the last 2px led to the footer's border-top), the Signals dropdown shows Shady Blinds' own 13
signals with the captured popup geometry, filling all five flipped Save from `#E7E9EB` to
`#2666F9`, and Escape closes. Untouched: Add Tile (15 cards, no `.dcd-` leak) and
`/dashboards/marketing` (21 cards, 4px radius, KPI 48,293, 7 donuts).

### The column picker: expanded by default, and the list is DRAGGABLE (8/23/2026)
Two captures of the live builder — one with the groups open, one closed — measured directly,
because that page is Invoca's own React and serialises in full (no ThoughtSpot iframe).

⚠️ **EVERY GROUP IS OPEN BY DEFAULT.** All 20 accordions carry `aria-expanded="true"` and all
372 checkboxes lay out at once. Ours opened only the first, so finding a column meant clicking
through twenty accordions. They stay collapsible; this is the default state. The open set is
also reset per REPORT, or a group only one report has stays collapsed after switching
(Transactions adds RingPool Details to Details' twenty).

⚠️ **THE REORDER LIST IS A SORTABLE DRAG LIST**, not a nudge button. Measured: every row is
`role="button" tabindex="0"` with `aria-roledescription="sortable"`, `cursor: grab`, a 24px
`drag_indicator` handle and an inline `transition: transform linear` — a dnd-kit sortable.
Implemented with POINTER EVENTS, not a library: the app is one bundle with no code splitting,
so a dependency lands on every screen, and this is ~20 lines. `setPointerCapture` keeps the
drag alive when the pointer leaves the row. Reordering happens LIVE on move, which the
transform transition implies, and rows move when the pointer passes a row's MIDPOINT.
Arrow keys move a focused row too, and focus follows it — the real row is focusable, and a
drag alone is mouse-only.

| | measured |
|---|---|
| panel | 320 wide, `padding: 24px 0 0` |
| heading | Lato **16/700** `#15243E`, inset 24 |
| scroll box | 320 x **672**, `overflow-y: auto` |
| row | **53** tall, `padding: 12px 24px`, radius 4, `cursor: grab` |
| handle | 24px `drag_indicator`, `rgba(0,0,0,.54)`, 12px to its right |
| row label | Lato **16/400** `#15243E` |
| group header | 48 tall, Lato **16/400** `#15243E`, no bottom rule |
| per-group links | Lato **12/500** `#2666F9`, no underline, NO button chrome, and they read "Select all" / "Deselect all" — lower-case second word |
| checkbox label | Lato 13.2/400 `#15243E`, 28 tall |

⚠️ **THE ROW LABEL IS 16px, NOT 13.2.** 13.2 is the checkbox list's size on the left, and ours
was using it for both. The row is also inset 24 on BOTH sides; ours had 0 on the left, so the
handle sat flush against the panel edge.
⚠️ `.icp-bulk.icp-bulk--group button` is written at (0,2,1) on purpose: as
`.icp-bulk--group button` it ties with `.icp-bulk button` at (0,1,1) and loses on source order —
measured, the border came back 2px and the pill was still drawn.

✅ **RESOLVED — the `(%)` columns are DERIVED, not pickable.** This was an open item on the
Details Report: the tile shows `Call Not Answered (%)` and `Answered by Agent (%)` beside their
`Total …` columns, and no `(%)` name appeared in the extracted builder list. The builder capture
settles it — **zero of its 372 checkbox labels contain `(%)`**. So the report adds a percentage
companion for a conditional measure, and the base `Call Count` gets none (a percentage of itself
is always 100%). The structural tell for "conditional" is a `(T/F)` twin, which both of those
have and `Call Count` does not. NOT implemented: it adds columns the SE did not tick, which is a
visible behaviour change and its own decision.
✅ Also confirmed by the same capture: `Answered`, `Answered by Agent`, `Call Not Answered` and
their `(T/F)` twins really are builder columns. Their existence had been proven only by a
rendered tile, with the group placement inferred.

⚠️ **THE PICKER SCROLLS ITSELF TO THE TOP ON ARRIVAL**, and expanding every group is what made
its absence obvious. `.main` is the scroller (`overflow-y: auto`), not the window, and this is an
in-shell route — so scrolling the Add Tile grid down to reach "Details Report" near the bottom
and clicking it opened the picker **523px down its own now very tall page**. React Router
restores nothing here. Fixed with a LAYOUT effect (at the top on first paint, no jump after it),
keyed on `kind` as well as mount because the three reports share one route and reuse the
component. The scroller is found by WALKING UP rather than by selecting `.main`, so a change to
the shell cannot silently break it, and it is a plain `scrollTop` assignment — smooth scrolling
does not work on `.main` in this app's browser.

⚠️ **SEARCH: TEST IT WITH REAL TYPING.** Dispatching `new Event("input")` at the search box does
not reach React — it tracks a controlled input's value through a descriptor and dedupes the
event — so filtering appeared broken (21 groups still shown) when it was not. Typed for real:
"zip" cuts 21 groups to 3 and 262 checkboxes to the 4 that match. Third time synthetic events
have produced a false negative in this repo; the other two are recorded at the combobox and the
Google Ads back-nav.

The Configuration drawer's dropdown is a **floating searchable popup**, not a native
`<select>`: paper 450 wide, max-height 375, radius 3, MUI shadow, padding 8px 0; options
32px tall (20px line box + 6px padding — the default line-height makes them 36) at
padding 6px 16px, 16px/400. Typing filters, which is the only way 250 options is usable.
Drawer content insets **24px** (8 beyond the panel's own 16), fields **452** wide, combo
`h=37` border `1px #e7e9eb` radius 4.

⚠️ **The combobox toggles on `mousedown`, and must NOT also open on focus.** With
`onClick` toggling and `onFocus` opening, the FIRST click looked dead: the order is
mousedown -> focus -> click, so focus opened the popup and the click handler toggled it
straight shut; the second click worked only because the input was already focused and
fired no focus event. Mousedown runs before focus, so one handler owns the state. A
keyboard user gets no mousedown, so ArrowDown / Enter opens the list instead.
⚠️ This class of bug is invisible to `el.click()` and synthetic events, which skip the
focus step entirely. Verify a toggle with REAL clicks at real coordinates — the same
lesson the Google Ads back-nav note records.

## MEASURE AT MORE THAN ONE WIDTH (standing rule for every replica)
A single-width measurement is not a measurement. The Add Tile picker was built from
a 1134px viewport and looked right there; at 1920 the real page shows FIVE columns,
not two, and the card's description sits below the icon rather than beside it. Both
were invisible at the width I checked.

Before believing any layout:
- measure the live page at a NARROW and a WIDE viewport (1134 and 1920 are the two
  used here; a third in between pins down a fluid grid);
- solve for the authored rule rather than hard-coding what one width happened to
  show. Three data points -- 983px available -> 2 columns, 1349 -> 4, 1769 -> 5 --
  identify `repeat(auto-fill, minmax(320px, 1fr))` uniquely;
- check whether a card's HEIGHT is fixed or content-driven. Add Tile's cards measure
  144 tall narrow and 164 wide, because the description rewraps; a fixed height would
  clip on a wide screen;
- re-measure the replica at the SAME widths and compare numbers, not screenshots.

The Browser pane can resize (`resize_window`) and is already signed in to the live
account, so this costs one extra call per width. Claude in Chrome cannot help here:
it only exposes tabs inside its own tab group, so it cannot read a tab the user
already had open.

## INSIGHTS & ANALYTICS IS A CROSS-ORIGIN IFRAME — where the design system actually lives
The tab is an `<iframe>` on **invoca.thoughtspot.cloud** (1224x790 at a 1312 viewport).
Nothing inside it is reachable: no DOM, no computed styles, no SVG geometry, and
**the mouse wheel and Page Down do not scroll it** from the browser pane. A capture of
the page does not serialise its contents either, which is the real reason the earlier
Details Report note says "no body and no footer in the DOM".

**But the design system is not inside the frame — it is in the PARENT window**, and it
is exact rather than measured:

    window._tsEmbedSDK.embedConfig.customizations.style.customCSS.variables   // 90 tokens
    window._tsEmbedSDK.embedConfig.customizations.style.customCSS.rules_UNSTABLE  // 51 rules

All 90 are saved verbatim in **`src/tokens/thoughtspot.css`** (loaded from `main.tsx`),
so any Insights screen can say `var(--ts-var-liveboard-tile-border-radius)` rather than
hardcoding a guess. Re-read that object whenever the real page is restyled.
⚠️ Do NOT `JSON.stringify` the SDK object — it holds DOM nodes with React fibers and
throws on the circular structure. Walk it and skip anything `instanceof Node`.

**Three things this proved wrong**, each of which had been in this file or the CSS:
1. **The font is Lato, not optimo-plain.** Every `*-font-family` token is
   `Lato, Avenir, Avenir-Book, "Museo Sans", sans-serif`. optimo-plain is ThoughtSpot's
   DEFAULT and Invoca overrides it, so Insights uses the SAME face as the rest of the
   platform. `.ind-page` asked for optimo-plain and fell back to Helvetica Neue, so
   every Insights screen was rendering in **Helvetica**. Now `var(--ts-var-root-font-family)`.
2. **Tiles are 8px radius with a 1px `#e7e9eb` border and NO shadow.** The Dashboards
   tab is 4px radius with a two-layer shadow and no border. That one difference is most
   of why the two tabs read as different products.
3. **The liveboard page is WHITE** (`--ts-var-liveboard-layout-background: #ffffff`),
   not the platform's `#f6f7f9`. Dashboards is grey-page-with-white-cards; Insights is
   white-on-white separated by borders.

Other values worth knowing, all from the token map: viz title `#15243e` / description
`#5b6577`; **axis data labels AND axis titles are both `#5b6577`**; every hover and
selected state across menus, lists, chips and legends is `#d4e0fe`; buttons
`#2666f9` -> hover `#1c53e9` -> active `#1643d5` at radius 3, secondary/tertiary
`#f3f4f5` on `#5b6577`; icon buttons are radius **100px**; checkboxes `#2666f9` checked,
border `#e7e9eb`, hover border `#2666f9`, disabled `#a1a7b2`, error `#e4131b`; chips
`#e7e9eb`/`#5b6577` going to `#d4e0fe`/`#15243e` when active.

`rules_UNSTABLE` is chrome surgery, not chart styling: it hides ThoughtSpot's own
header, edit button and logo, makes the filter bar sticky, and fully specifies the
**"Ask" / Spotter pill** —
`linear-gradient(135deg, #ccf8f2 0%, #e5fbf8 38%, #e9f0fe 72%, #e7e0f9 100%)`,
`1px solid #d4e0fe`, radius `3.5rem`, text `#007e73`, hovering to
`#99f2e4 -> #ccf8f2 -> #d4e0fe -> #e7e0f9` with text `#009788`, and a sparkle drawn as
a `::before` data-URI SVG.

### Reading inside the frame: the SingleFile capture route (this WORKS)
The series palette and all chart geometry are not in the embed config, but a SingleFile
capture does serialise the frame. How to get at it:

1. SingleFile saves the frame into a **`srcdoc` attribute** on `#_thoughtspot-embed`
   (9.4MB of it). The rendered Highcharts SVG, the tables and the inline heatmap
   colours are all in there.
2. **Do NOT try to read it through the iframe.** Its `sandbox` attribute omits
   `allow-same-origin`, so `contentDocument` is null. Stripping the sandbox to get in
   is both the wrong instinct and blocked as a security bypass.
3. **Extract the `srcdoc` to its own file instead**: unescape the attribute, strip
   `<script>` tags (saved SPA pages re-hydrate and blank themselves; the DOM you want
   is already serialised), write it to `public/__m/ts.html`, and open that. Now
   everything is same-origin and every computed style is readable.
4. Vite needs a restart to serve a new `public/` file, and avoid `&` in the name.

That capture yielded 12 charts: 1 area sparkline, 1 grouped column (4 series), 4 pies,
1 single line, 1 multi-line (3 series), 1 dual-axis (column + line), 1 horizontal bar,
plus KPI/metric tiles and 28 tables.

**The palette is a SYSTEM, not a list** — 8 hues x 5 steps = 40 colours, in
`src/data/tsPalette.ts`. A chart takes the first n BASE hues; a donut needing more than
8 slices continues into the tints of hues already used, which is why big donuts show
pale and dark relatives of earlier slices. Approximating this is what makes a replica
read as "close but off".
⚠️ **Series order differs BY CHART TYPE.** Lines and areas start at blue
(#2666F9, #00DEBC, #FFD800); the grouped column starts at GREEN
(#2CBF58, #FFD800, #00DEBC, #2666F9), confirmed against its own legend swatches. There
is no single global sequence.

**The "show heat map" table ramp** is a pale cyan lerp, #f8fdfe -> #b5ecf2, and it is
normalised **per COLUMN**. `heatColor(v, min, max)` reproduces all 16 sampled stops to
within 2/255.
⚠️ Pass that column's own bounds. Checking it against the whole table's range (1..825,
where 825 is another column's value) made a correct function look broken — the test was
wrong, not the code, which is the usual direction of travel here.

**Two layers decide every chart value.** Invoca overrides only the 90 tokens; ThoughtSpot's
own CSS uses a wider set with fallbacks (`var(--ts-var-chart-y-axis-line-color, #e0e0e0)`).
Override wins where it exists, ThoughtSpot's default applies everywhere else — so axis
LABELS are Invoca's `#5b6577` while axis LINES are `#e0e0e0` and legend TEXT is `#777e8b`.
⚠️ **1rem = 14px in ThoughtSpot**, so convert their rem values by /14. `.5714…rem` is 8px.
⚠️ **Charts are Lato, TABLES ARE NOT.** ThoughtSpot's table CSS sets
`optimo-plain, "Helvetica Neue", Helvetica, Arial` explicitly, which beats the inherited
Lato. Both read off the same captured document, so it is not an artefact.

**A tall viewport DOES render the whole liveboard**, which is the one trick that works
for surveying layout when scrolling will not: `resize_window` to something like
1600x4000 and the frame lays out every tile at once. The screenshot is downscaled at
that size, so it is good for INVENTORY and useless for colour or geometry.

## The `ts-` component layer (built 8/18/2026)
`src/components/ts/` + `src/styles/ts.css`, with the palette in `src/data/tsPalette.ts`
and the tokens in `src/tokens/thoughtspot.css`. Import from `components/ts` (the barrel),
never the individual files. Gallery bench at **`/ts-gallery`** — every template on one
page with capture-shaped data, so the layer can be checked side by side at two widths.
Nothing links to it and no prospect sees it.

Components: `TsTile` (frame + HTML legend) · `TsLine` (single, multi, area) · `TsColumn`
(grouped and stacked) · `TsBar` (horizontal) · `TsDualAxis` · `TsPie` (pie and donut) ·
`TsKpi` / `TsMetric` / `TsTrend` · `TsTable` (with the heat map).

**Why a separate layer rather than more opt-in props on `DonutChart`.** The Dashboards
components had already grown `colors`, `onSlice`, `slicePct`, `label` and `geom` for
Insights' benefit, and the tab still looked like Dashboards because apart from one donut
it WAS Dashboards. A `.ts-` prefix in its own stylesheet makes "changes stay in their
tab" structural instead of a matter of care. Do not put `.dash-`, `.kpi-` or `.ind-`
selectors in `ts.css`.

Every value is measured. The ones most likely to be "tidied" back to wrong:
- **NO GRIDLINES.** Every grid path in the capture is `stroke: none`. Dashboards draws
  #e7e9eb ones, so the instinct is to add them. Their absence is a big part of the look.
- **The legend is HTML**, 212px on the right, 12px CIRCULAR swatches, 24px rows, 12px
  `#777e8b`. In-svg legend text would scale with the chart.
- **Pies carry outside data labels with leader lines** reading `Label - count (pct%)` at
  12px `#5b6577` (16 labels, 16 connectors in the capture). Columns and lines carry
  NONE. Leaving the pie labels off made the donuts read as a different chart.
  ⚠️ Labels are pushed apart per side to a 16px minimum: nine slices put several
  mid-angles within a couple of degrees and the small-slice labels stack illegibly.
- **Columns are 22 wide with a 5px gap, square corners.** A group nearly fills its band
  (103 of 111 measured), so the fit rule is "band minus an 8px gutter", NOT a fraction
  of the band — capping at 0.72 gave 17.2/3.9 where the measured 22/5 fitted fine.
- **KPI value ink is `#1d232f`, its label `#15243e`.** Two different inks in one tile,
  because Invoca overrides the label colour and the big number falls back to
  ThoughtSpot's own. Using one for both reads as slightly off.
- Tiles: 8px radius, 1px `#e7e9eb`, AND a faint `0 2px 4px rgba(0,0,0,.05)` — both.
- Donut hole is exactly 50% of the outer radius; plot inset is 68/15 on every cartesian
  chart; lines are 2px; area fill is the line colour at 20%.

All series data goes through `fitValues`/`fitCells`, so the renderers stay TOTAL and the
AI can edit values without crashing one — the precondition the four standing AI rules
put on any `LENGTH_IS_CONTENT` path.

**New tiles from Add Tile render through this layer**; the existing Insights screens
still use their own charts. `DashAssistant` gained a `variant` prop (`"dash"` by
default, `"ts"` on `InsightsDashboard`) and `TsTileCard` draws the SAME
`GeneratedTile` with the ThoughtSpot components. `TileCard` is untouched, so the six
Dashboards keep their card and charts to the pixel. Both Add Tile paths land here: the
Configuration drawer (via `buildTile`) and the Report column picker.
⚠️ **`TsTileCard` keeps the AI identity byte-identical** — same `data-genid`, same
`DashTileAi` focus object. Those are what rule 3 and "remove this tile" key off, and
re-rendering a tile while quietly changing its id is the silent-no-op this repo has
already been bitten by twice. Verified end to end: a table tile and a line tile both
built through the real flows, rendered with `.ts-table` / `.ts-svg`, zero `.dash-card`
leakage, and remove still works.

⚠️ **`.ind-page table { font-family: inherit }` IN app.css BEATS A BARE `.ts-table`.**
Specificity 0,1,1 against 0,1,0, so the ThoughtSpot table rendered in **Lato** on the
Insights dashboard while `ts.css` plainly said optimo-plain. Written as
`.ts-tablewrap .ts-table` (0,2,0) to win outright — relying on `ts.css` importing after
`app.css` would only TIE, and a tie decided by import order is too fragile. This is the
cross-screen interference the one-prefix-per-screen rule warns about, showing up through
a bare TAG selector rather than a shared class name, so grepping prefixes would not have
caught it. Check computed style on the real screen, not just in the gallery.

Verified after building: 22/5 bars (⚠️ read as VIEWBOX units at the time — see "Charts are
drawn 1:1"; the same bars rendered at 14.8 real px in that tile), 0 gridlines, 212px legend
with 12px round swatches,
axis 12px `#5b6577` on `#e0e0e0` lines, slice order continuing into the blue tint at
slice 9, table 11.9px Helvetica with a 13/700 header, 40 heat cells normalised per
column. Dashboards re-checked unchanged: 4px radius, two-layer shadow, 21 cards, donut
350x260, KPI 48,293, and its 12 gridlines still present.

## ⚠️ STANDING RULE: the completed template IS the design, and only DATA varies
Agreed 2026-08-20, and it applies to every Insights & Analytics template as each one is
finished. **"Single Line Chart Over Time" is the first completed template and is the
reference.** Once a template is signed off:

- **The look is FROZEN.** Canvas and plot insets, the absence of gridlines, tick counts
  and step progression, the zoomed y floor, HTML axis titles at 12px/600, the dotted
  partial tail, the tile frame, the hover-fade and the interaction drawer. None of it is
  a per-tile decision and none of it is editable by the AI (rule 1).
- **Only the DATA changes**, driven by the attribute the SE picks: the values, their
  magnitude, their format, and the axis title that names them.
- **The window is NOT the attribute's business.** It comes from the dashboard's filter
  (`marketingDashboard.dateRange`), so every tile on a dashboard covers the same period.

⚠️ **What "only the data changes" actually requires, and does NOT yet hold.** Measured
2026-08-20 across seven attributes: the template apportions EVERY attribute as if it
were an additive count, which is right for Call Count (48,293 exactly) and Answered, and
wrong for everything else:

| attribute | got | why it is wrong |
|---|---|---|
| Revenue (Sale Amount) | 4,744,086..8,907,516 | renders bare, needs `$` on the ticks |
| Publisher Conversion **Rate** | 13..23 summing to 100 | a rate does not SUM across weeks; each week has its own |
| Agent **Handle Time** | 55..99 summing to 420 | an average per call, not a monthly total of 420 seconds |
| Sentiment **Score** | 58..99 summing to 420 | a score does not sum either |

**BUILT — `src/data/insightsMeasures.ts` (2026-08-20).** Every measure has a KIND
(count / money / flag / percent / duration / score / rank) which decides three things:
whether a series PARTITIONS a total or carries a LEVEL per period, the tick format, and
the aggregation word. Verified across all 108 of Shady Blinds' measures.

| kind | additive | series | tick | title |
|---|---|---|---|---|
| count, money, flag | yes | partition of a total | `6.1K`, `$4.7M` | **Total** `<measure>` |
| percent, duration, score, rank | no | level per period | `71%`, `2:43`, `82`, `#7` | `<measure>`, **no prefix** |

⚠️ **"Average" was WRONG and a capture corrected it.** The multi-line capture's own axis
titles and legend read `Total Call Count` for the count but `Answered by Agent (%)` and
`Appointment: Scheduled (%)` VERBATIM for the percents. ThoughtSpot prefixes an additive
aggregation and leaves everything else exactly as the measure is named, so
`aggregationWord` returns `""` for the non-additive kinds. Percent is the only
non-additive kind a capture has actually shown; duration, score and rank follow by
inference, not by separate measurement.

Classified by NAME SHAPE plus a short override list, not by enumerating 108 measures —
that is what makes it survive the next generated prospect, whose measures do not exist
yet. A long override list means the families are miscut.

⚠️ **FAMILY ORDER MATTERS, and three real measures prove it.** Rank is tested BEFORE
money and percent, and the `X: gt Y` threshold shape before duration:
- "Publisher Commissions **Ranking**" contains "commission" -> money by a naive rule
- "Publisher Conversion **Rate** Ranking" contains "rate" -> percent by a naive rule
- "**Duration**: gt 1-minute" contains "duration" -> a duration, when it counts calls

⚠️ **Three defects the classification report caught, all invisible in a type check:**
- **Same-family money printed the SAME figure.** "Earned" and "Paid" both came out
  $2,636,798 and "Fees" matched "Advertiser Fees" to the dollar, because the share was a
  constant per branch and the seed went unused. A seeded +/-15% spread fixes it; Revenue
  stays EXACT so it still agrees with the dashboards.
- **"Total Total Messages."** The measure is named "Total Messages", so the prefix
  doubled. `axisTitleFor` skips the word when the name already starts with one.
- **IVR Duration read longer than the call.** The sliver band (monologue, silence,
  overtalk, dead air, hold, offset) needed `ivr` in it, or a 30-second IVR leg rendered
  at 5:34 against a 2:35 call.

⚠️ Percent and flag are UNEXERCISED by Shady Blinds — its catalogue has no rate measure
(which is why the question resolver maps "Answer Rate" onto the count "Answered") and no
`(T/F)` measures. Both were verified against synthetic names instead; do not assume they
are dead code.

⚠️ **A known limit, recorded rather than papered over:** levels are independent per
measure, so "Connected Duration" can exceed "Duration" if a chart shows both. Harmless
while a line chart shows ONE measure; if Multi-Line ever plots two durations together,
they need a shared anchor.

**Multi-Line makes this reachable now** (it plots several measures at once), but each
series gets its OWN axis and scale, so two durations no longer have to agree to look
right — the contradiction would only be in the numbers, not the picture. Still worth a
shared anchor if an SE ever puts "Duration" and "Connected Duration" side by side.

## Template: "Single Line Chart Over Time" (measured 8/20/2026)
Re-measured from a capture of the REAL tile, and the first build was wrong in seven ways.
`buildTile`'s `"Single Line Chart Over Time"` case + `weeklySpan()` in
`src/data/insightsTileData.ts`.

| | first build | the real tile |
|---|---|---|
| points | 5 week buckets, "Wk 1" labels | **5 week-start dates**, `MM/DD/YYYY` |
| y ticks | `8,000` | **`8K`** compact from 1,000 up |
| tick count | 6 | **8** (`0..8K by 1K`) |
| x labels | "Jan 1-4" | **`12/29/2025` … `01/26/2026`**, Monday-aligned |
| axis titles | none | **`Total <measure>` + `Weekly Call Start Time`** |
| last segment | solid | **dotted**, `stroke-dasharray: 2,2` |
| under the chart | "Call Count over the reporting period" | **nothing** |

⚠️ **A TILE HONOURS THE DASHBOARD'S FILTER — do not re-derive this.** The first rebuild
spanned TWO YEARS, reasoning from a capture whose tile ran 07/2024 to 08/2026 and
concluding "a new tile carries no date filter". Wrong: our Summary Dashboard shows a chip
reading `Call Start Time Between (01/01/2026 <= 01/31/2026)`, and a tile plotting two
years under that chip contradicts the filter a prospect is reading. The captured tile was
built somewhere the filter was not applied.

The window comes from `marketingDashboard.dateRange` — **the same field the chip renders
from** — so the two can never disagree. Corroborated by the grouped-column capture, whose
x axis reads 12/29/2025, 01/05/2026, 01/12/2026, 01/19/2026, 01/26/2026: five
Monday-aligned WEEK-START dates for a one-month filter.

⚠️ **Buckets are weighted by IN-RANGE DAYS**, which is what makes it a complete partition:
Jan 1-31 is 4 + 7 + 7 + 7 + 6 = 31 days across five Monday weeks, so the first and last
buckets are genuinely smaller, the values sum to EXACTLY the prospect's own call total
(verified 48,293), and the last week being partial is also why the final segment is
dotted.

⚠️ **THE Y TITLE IS CENTRED BY TRANSFORM ORDER, AND THE ORDER IS EASY TO GET BACKWARDS.**
Written `rotate(180deg) translateY(-50%)` the translate applies FIRST and the rotation
then flips its direction, so the -50% that should centre the label becomes +50% and the
title sits **154px below** the plot centre (measured; the computed matrix read +76.97
instead of -76.97). It must be `translateY(-50%) rotate(180deg)` — rotate in place about
the centre, then translate in the final space. Verify by comparing the label's centre
against the plot's, not by eye: a title that is merely low still looks plausible.

⚠️ **AXIS TITLES ARE HTML, NOT SVG TEXT.** `axis-label-title`, 12px/**600**/`#5b6577`.
No `.highcharts-axis-title` exists in ANY captured chart's svg, so this was wrong on
every ts chart, not just this one. They live in `TsAxisTitles` and are positioned in
PERCENTAGES, the same reason the legend is HTML and the hover panel uses percentages.

⚠️ **THE LEFT PLOT INSET IS CONTENT-DERIVED.** An earlier note here said "68 on every
cartesian chart". Re-measuring gave **62** where the y labels read `8K` and 68 where they
read `600` — it tracks the widest tick label. `leftInsetFor()` reproduces both exactly.

⚠️ **`niceTicks` count is 8 and 2.5 is NOT an allowed step.** Both from captures, not
taste: count 8 reproduces the line chart's `0..8K by 1K` (9 labels) AND the column
chart's `0..600 by 100` (7 labels). At count 6 the line chart drew **2.5K** steps, which
no captured axis uses anywhere.

⚠️ **Calendar ticks only apply when there are enough points to thin.** The grouped
column's five weekly dates all sit inside one month, so a 4-month rule there would print
one label and drop the rest. Gated on `> 12` categories.

⚠️ **THE Y AXIS DOES NOT START AT ZERO ON A LINE CHART, AND THE LOWEST POINT SITS ON THE
X AXIS.** The floor is the EXACT data minimum, not the tick below it. Flooring to a tick
is the obvious reading of the captured 100..550 axis and it leaves up to a full step of
gap — measured, a $4.74M minimum floored to $4M sat **12% up the axis** and 2:32 floored
to 2:30 sat 8% up, both of which read as the line hovering. `niceScale(min, max,
zeroBased)`: step from the DATA RANGE (not the max), floor = the min itself, top = max
plus ~5% headroom snapped UP to a tick. Verified 0px gap on every tile.

The TICKS above the floor are still round (`$6M $7M $8M …`) so the axis stays readable,
and the bottom label is the real minimum. A nice tick landing within 35% of a step of
that floor label is DROPPED — two labels a few pixels apart is worse than one, which is
why the Revenue axis reads `$4.7M $6M $7M …` with no `$5M`.

⚠️ **BARS, COLUMNS AND AREAS KEEP A ZERO BASELINE.** A bar's length and an area's fill
ARE the magnitude, so a non-zero floor overstates every difference — the captured column
chart runs 0..600 even though its smallest group is ~48. `zeroBased` is a parameter, not
a preference: lines zoom, everything whose size encodes the value does not.
⚠️ A zoom that RESOLVES to zero is not a broken zoom. The gallery's sample spans 87..503,
and 87 floored at a step of 100 is 0 — so that bench chart still reads 0..600 and is
correct. Check the arithmetic before "fixing" it.

⚠️ **Kept from the two-year attempt, because it will matter again for any long series:
a fresh hash per bucket is UNCORRELATED and renders as a perfect SAWTOOTH.** Over 112
weekly points at +/-14% it drew a metronome climbing the chart, which reads as synthetic
at a glance. If a long span is ever wanted, smooth the jitter across neighbours (a 3-week
moving average measured 42% direction flips against a sawtooth's ~100%) rather than
raising or lowering its amplitude. The five-bucket window keeps a modest +/-8% wobble,
since with five points a large jitter reads as noise rather than as a busy week.

⚠️ **`{ label: "Attribute", kind: "measure" }` IS CORRECT — do not "fix" it.** The field
looks mislabelled (it offers measures under the word "Attribute") and is verbatim right:
the capture has `<label id=measure-label><span>Attribute</span></label>`. The `id` also
independently confirms the `kind: "measure"` classification, which was originally inferred
from live option COUNTS — two signals agreeing.

## Templates: "Calls by Hour" / "Calls by Day of Week" (measured 8/21, re-measured 8/23/2026)
`timePivot` in `insightsTileData.ts` + `TsTable`'s `heatScope` / `heatMax` / `pivotHeader`.

⚠️ **THESE ARE PIVOT TABLES, NOT BAR CHARTS.** Rows are the chosen dimension, columns are
the 24 hours (or 7 days), plus a row-total column AND a column-total row. The previous build
drew a vertical column chart per hour — a different visualisation entirely.

```
header 1:  <measure>            | <column dimension>  (spans the rest)
header 2:  <row dimension>      | 0 1 2 … 23 | <measure>
body:      <dimension value>    | value per hour, BLANK where zero | row total
footer:    <measure>            | total per hour                   | grand total
```
Values abbreviate (1.62K, 42.05K) via `formatHero`. Header cells sit on `#F6F8FA`, the
totals-column header on `#F5F5F5`.

⚠️ **THE HEAT SCALE IS GLOBAL AND SATURATES — the Details Report's is PER COLUMN.** Both are
measured, so `TsTable` gained `heatScope`, defaulting to `"column"` so the report is
untouched. The proof it is not per-column: this pivot's 24 column maxima carry **20 different
colours**, where per-column normalisation would give every one of them the same darkest
shade. And it clamps rather than stretching — measured t reaches 1 at ~4,320 while the grand
total is 42,050, so several large values share `#B5ECF2`.

⚠️ **THE SATURATION POINT IS `heatMax`, AND THE DAY-OF-WEEK CAPTURE PINNED IT PROPERLY.**
Fitted against all 367 non-blank cells of that grid, `t = min(1, v / 8024)` reproduces every
one to a mean **0.185/255 per channel** — so the ramp is linear from ZERO with a hard clamp,
not a stretch to the max and not a curve. But **8,024 matches nothing on screen**, so the
rule is a proxy. Every candidate, scored against that same fit:

| candidate | value | err/channel |
|---|---|---|
| largest BODY cell (totals excluded) | 7,580 | 0.224 ← **what we use** |
| 2nd largest row total | 7,870 | 0.200 |
| free-fit optimum | 8,024 | 0.185 |
| largest column total | 10,440 | 0.399 ← what we used before |
| grand total | 42,960 | 1.106 |

The surface is shallow, so anything in 7.6K-8.6K is indistinguishable; the largest body cell
is the one that is both close and principled, and it explains the capture's signature exactly
— **only 3 of 367 cells saturate, and all three are aggregates**, because a sum is
necessarily larger than the largest thing summed.
⚠️ On OUR data more cells flatten at the top (12 of 48), and that is arithmetic, not a bug:
the capture splits its total across 51 sources so each body cell is tiny beside the totals,
where Shady Blinds has 5 and each row total is only ~5x its cells. The reference screenshot
shows its own footer row saturating too, so the character matches.

⚠️ **`numOf` HAD TO LEARN K/M/B, and this was a silent bug.** The pivot renders "1.63K" /
"21.73K"; every one of those failed `numOf`'s digits-only test, so the ONLY cells that took a
colour were the plain ones under 1,000 — all the small ones — and the grid came out
near-white with "845" as its darkest cell. Sorting cells by heat is what exposed it; a glance
at the screenshot would not have.

⚠️ **"Show heatmap" WAS A DECORATIVE CHECKBOX.** `InsightsConfigDrawer` collected the
chart-display options into state and then dropped them on submit — `onCreate` only carried
template/name/measures/dimensions. `CreatedTile.options` and `TileChoices.options` now carry
them, which is what makes the user's two variants (with and without heat) actually differ.

⚠️ **THE HOUR SHAPE IS BIMODAL ON PURPOSE.** Real call traffic peaks late morning and again
early evening and is near-dead overnight; a flat spread would make "spot your busiest and
slowest times" meaningless, which is the template's whole stated purpose. Row weights come
from the REAL breakdown, so a pivot and a Stacked Bar on the same dimension agree — Paid
Search totals 21.73K in both, and the grand total is the prospect's own 48.3K.
The DAY shape is the same idea: a gentle Mon-to-Fri decline with a clear weekend drop.
⚠️ The capture's own day shape is nothing like that — **Saturday is its biggest day at
10.44K** against ~5K weekdays. That is one healthcare account's data, not the template, and
copying it would give every prospect a Saturday spike nobody can explain.

⚠️ **ROWS ARE SORTED ALPHABETICALLY, AND THEY WERE NOT BEFORE.** The Day-of-Week capture runs
{Null}, Billboard, Bing, … Zocdoc across 51 rows, so the biggest row sits mid-list and the
breakdown's own value order must not survive into the pivot. Both pivots shared this defect
because both go through `timePivot`.

⚠️ **A PIVOT COLLATES BY LOCALE WHERE THE PIE AND BAR MEASURED CODE UNITS.** Both are
measurements and they stay two functions (`pivotOrder` v `categoryOrder`) — do not unify
them. Verified: `localeCompare` reproduces all 51 captured rows including `{Null}` at index 0,
and a code-unit sort diverges at index 6 (`CTV` before `ChatGPT`). Four rows make the
difference visible rather than academic: `direct` before `Direct` and `Meta` before `META`
(case is only a tertiary difference under locale collation, and lowercase wins the tie),
plus `duckduckgo.com` filed under D and `umassmemorial.org` under U, where a code-unit sort
exiles both to the end. `{Null}` needs no pinning here — ICU puts `{` ahead of letters by
itself, which is exactly where the capture has it.

⚠️ **THE PIVOT'S CHROME IS NOT THE TABLE TILE'S, and the two were sharing one rule set.**
`.ts-table--pivot` (opt-in, set only when `pivotHeader` is passed) carries the measured pivot
values; the three Report table tiles keep their own. Rows are the headline difference — 27px
against a table tile's 50px, which is why a 51-row pivot rendered nearly twice the real
height.

| | pivot (measured) | plain table tile (measured earlier) |
|---|---|---|
| header | 11.9px / **400** / `#777E8B`, centred | 13px / **700** / root ink, left |
| header height | band 1 **50**, band 2 **53** | 48 |
| row height | **26.86** | 50 |
| body ink | `#333` (row LABELS are `#777E8B`) | `#333` |
| column rules | 1px `#DDD` from column 1 rightwards | none |
| row rules | 1px `#EAEDF2` | 1px `#EAEDF2` |
| totals column + footer | **700 on `#F5F5F5`** | footer 700 on `#F6F8FA` |

⚠️ **THE FIRST HEADER BAND IS 400/`#777E8B`, NOT 600/`#1d232f`** — the old value was inferred
from the table tile's header rather than read off a pivot. Only the `#F6F8FA` ground sets the
band apart; every header cell in the grid is the same size and weight.

⚠️ **THE FOOTER IS PART OF THE HEAT RAMP.** All 367 non-blank cells fit one ramp, per-day
totals included, and the grand total is one of the three that saturate. `TsTable` tinted the
body only, which left the row a prospect looks at first as the one row carrying no signal.

⚠️ **TWO CSS TRAPS, both found by reading the RENDERED tile rather than the stylesheet.**
- `.ts-pivot-head th` is (0,1,1) and loses to `.ts-tablewrap .ts-table--pivot th` (0,2,1), so
  the first band rendered transparent and centred while both rules read correctly in
  isolation. The band restates its own ground and alignment.
- **`line-height` is load-bearing on the row height.** `height` cannot shrink a row below its
  content box, so 27px plus the default line box rendered 28.84 against the measured 26.86.
  The measured height INCLUDES the 1px row rule, so the line box has to be 16.

Verified on the real Add Tile path, both variants, at the same time: heat tile 48/48 value
cells on the cyan ramp with the totals column and footer tinted; plain tile 0 heat and
exactly **13** cells on `#F5F5F5` (5 total-column + 8 footer), which is the capture's own
count. Rows read Email, Organic, **Paid Search**, Print, Social Media — the biggest mid-list.
Untouched afterwards: Details Report (`.idt-table`, 200 rows, 13/600 Lato, UNIQUE COUNT
footer), the gallery's two plain table tiles (13/700 at 48px, 50px rows, 40 per-column heat
cells) and `/dashboards/marketing` (21 dash-cards, 4px radius, KPI 48,293, zero `ts-`).

## Template: "Details Report" (the row-level grid, measured 8/23/2026)
`reportRows` / `reportHeaders` / `reportFooter` / `reportCaption` in `insightsTileData.ts`,
`TsTable`'s `reportFooter` + `caption`, `.ts-table--report` in `ts.css`. Built through
`InsightsColumnPicker`, not the Configuration drawer.

⚠️ **NOT THE SAME SURFACE AS `/insights/dashboard/Details Report`.** That SCREEN is
`.idt-*`, 17 columns, its own CSS, and is deliberately untouched here. This is the Add Tile
TEMPLATE. Both exist on purpose, and this capture does NOT settle the screen's columns —
see the open item at the end.

⚠️ **A THIRD TABLE RENDERER.** The Details Report tile is **ag-Grid** (`ag-theme-alpine`,
`ag-root-wrapper`, `.ag-header-cell`, a pinned `.ag-floating-bottom` row); the Calls-by-Hour
pivot is **DevExtreme**; the plain table tile is a third thing again. They are typeset
differently, so `.ts-table` could not just be reused:

| | Details Report (ag-Grid) | pivot (DevExtreme) | plain table tile |
|---|---|---|---|
| face | **12px Lato `#15243E`** | 11.9px optimo-plain `#333` | 11.9px optimo-plain |
| header | 12px/**700**, 48px, wraps | 11.9px/400, 50 + 53px | 13px/700, 48px |
| row height | **31px, content-driven** (47 / 63 wrapped) | 26.86px fixed | 50px |
| rules | col `#EAEDF2`, row **`#DDE2EB`** | col `#DDD`, row `#EAEDF2` | row `#EAEDF2` |
| cell inset | 16px | 6px | 12px |

⚠️ **THE AGGREGATION ROW HAS THREE DIFFERENT LABELS, and the column's own kind picks which.**
Measured on the pinned bottom row: `UNIQUE COUNT` over every dimension (and over
`Answered by Agent (T/F)`, whose value is 2), `TOTAL` over the additive measures (42.96K,
15.35K, 20.02K), and **`TABLE AGGREGATE`** over the percentages (49%, 64%). That is the
additive / non-additive split `insightsMeasures` already draws, appearing in the product's
own vocabulary — a rate cannot be summed down a column, so it is recomputed over the table
and the label says so. Label 12px `#777E8B` above a **16px/700** value, both right-aligned
even under a left-aligned dimension column.

⚠️ **A `(T/F)` COLUMN IS A DIMENSION HERE.** `kindOf` calls it `flag`, which is additive, so
keying the label off the kind alone prints TOTAL under a column of "true"/"false". The
catalogue decides: `(T/F)` twins are dimensions and the measure is the `Total <name>` sibling.

⚠️ **HEADERS ARE THE AGGREGATED FORM OF THE MEASURE.** The grid reads `Total Call Count`
where the builder's 371-column checkbox list offers `Call Count` — so the prefix is applied
at render, and this is a third independent confirmation of `axisTitleFor` after the axis
titles and the legend. Percentages carry no prefix, which is `aggregationWord` returning ""
for a non-additive kind. Only catalogue MEASURES go through it: `kindOf` defaults an unknown
name to `count`, so a dimension would print "Total Marketing Source".

⚠️ **ONE ROW IS ONE CALL, AND THE COLUMNS OF A ROW HAVE TO AGREE.** This was the biggest
correction. Every cell used to be minted from its own (column, row) seed, so a count column
printed "15" and "26" per row — a monthly total sitting in a row-level report — and the
answered flag, the answered count and the answered percentage in one row were three
independent inventions. The capture's rows fall into exactly four shapes:

```
(T/F)    Count   Not Answered   Not Ans (%)   Answered   Ans (%)    n
{Null}     1          0           {Null}         0       {Null}     1
false      1          1            100%          0         0%      10
true       1          0             0%           1        100%     18
true       1          1            100%          1        100%      5
```
- **Total Call Count is 1 on every row**, so the footer's TOTAL is the row count and the
  column adds up for anyone who checks.
- **A percentage is 0% or 100%**, never between — a rate over one call is binary — and it is
  `{Null}`, not 0%, when the call carries no agent-leg data. Note the flagless row prints
  `0` for the counts but `{Null}` for the percentages.
- **The fourth shape is real**: 5 of 34 rows are answered by an agent AND counted as not
  answered, so both percentages read 100%. Reproduced at that rate; without it the two
  percentage columns are perfect complements and read as computed rather than observed.
- `(T/F)` is **lowercase** "true"/"false". Ours was "True"/"False".

⚠️ **ATTRIBUTION COMES FROM `digitalInsights.rows`, WHOLE.** Cycling source, medium, campaign
and search term independently produced rows like "Medium: Bing, Source: Organic" next to
"Medium: cpc, Source: Paid Search" — one coherent, one contradictory, from the same code, and
a marketer reads that instantly. `InteractionRow` already holds a coherent tuple per
interaction, so the row is taken whole; the Details Report and the Digital Journey report now
show the same attribution rather than two conflicting sets. It also supplies **Website
Journey**, which was rendering the literal placeholder **"Website Journey A"** — no regex
matched that column so it fell through to the minted-dimension fallback, the same failure the
REPORTED CONTACT FIELDS note was written about. `websiteJourney` is documented as
"Home / Category / Subcategory", exactly the capture's shape.

⚠️ **THE BODY SCROLLS INSIDE THE TILE.** Measured: tile 703 tall, `.ag-body-viewport` **477**
with `overflow-y: auto` over 16,925px of virtualised rows, header 49 above and the pinned row
65 below. Ours came out **8,958px tall** — 200 rows at 31px with nothing capping it — which
made the dashboard scroll for nine screens and pushed every tile below it out of sight. Now
`max-height: 589px` (48 + 477 + 64) with the header and aggregation row `position: sticky`,
both needing an opaque ground or the rows read through them.

⚠️ **COLUMNS LIVE IN A BAND, 145 TO 202, AND BOTH ENDS MATTER.** Measured across all twelve
captured columns: 144.7, 146.7, 158.3, 183.5, 195.1, 195.3, 201.2 and 201.6 five times.
Nothing is narrower than ~145 even where the values are "true" and "false", and nothing is
wider than ~202 even for a 44-character search term.
- The **ceiling** is what makes cells wrap at all. Without it every column grows to its widest
  value, no row wraps, and the grid loses the multi-line texture that is most of what makes it
  read as real records.
- The **floor** is what the first pass missed, and it is why the user reported the tile still
  "doesn't look anything like the real site" with every colour and rule already correct.
  Content-fitted columns came out 118 to 202 — a spread the real grid never shows — so the
  narrow ones read as cramped and the wide ones as bloated beside them.

⚠️ **THREE MORE THINGS THAT FIRST PASS MISSED, all only visible side by side with the live tile:**
1. **The grid is a bordered box.** `.ag-root-wrapper` carries 1px `#EAEDF2` on all four sides.
   Ours had every rule BETWEEN cells and no outline, so the columns ran into the tile's white.
2. **The scrollbars are always visible**, and on macOS ours were not there at all — a grid
   571px wider than its tile gave no hint that it scrolled. ⚠️ **Do NOT set `scrollbar-width` /
   `scrollbar-color` alongside the `::-webkit-scrollbar` rules**: the standard properties make
   Chrome take the standard path, which on macOS is an overlay scrollbar that fades and
   reserves no gutter — measured 0px, so the `::-webkit-` rules were dead while both looked
   correct in the stylesheet. Removing them gives the measured 8px gutter. The thumb colours
   are READ OFF THE LIVE SCREENSHOT, not measured — the grid is cross-origin, so there is no
   computed style to take them from (same caveat as the Geo Heatmap's dot colour).
3. **The Call Record ID format is four hex, a dash, then TWELVE** — `DD11-82B03247078E`,
   `0000-1856E2CB3EF7`. Ours produced `CFB8-ECB711`, four and SIX. Six characters short
   sounds cosmetic and is not: at the report's column widths the real id wraps onto two lines
   and ours sat on one, so the first column had visibly the wrong shape. A 32-bit hash is only
   8 hex digits, so the tail is a second hash. (The Details Report SCREEN's own generator was
   already 4-12, which is independent corroboration.)

### The pixel-exact spec, and how it was reached
Asked for a pixel-by-pixel match, so it was done as a **programmatic diff** rather than by
eye: dump one property set (family / size / weight / colour / line-height / transform /
padding / each border / rect) from the capture's ag-Grid nodes, dump the same from our
`<table>`, and fix until the diff is empty. Eyeballing had already missed four of these twice.

| | measured |
|---|---|
| grid box | 1px solid `#EAEDF2` all four sides, ground `#fff` |
| header block | **49** = 16 space / 16 line / 16 space, then a 1px `#EAEDF2` rule |
| header rule | **2px solid #000**, painting INSIDE the 48 (`.ag-header-viewport`) |
| header text | Lato **12/700** `#15243E`, lh 16, wraps, **16px** from the cell's left |
| gap header→first row | **0** |
| row | **31** tall, `#fff`, bottom rule 1px `#DDE2EB` |
| body text | Lato **12/400** `#15243E`, lh 16, `pre-wrap`, **9** from the row top, 5 + rule below |
| body inset | **17px** each side (a 1px transparent cell border + the inner div's 16) |
| column rule | 1px `#EAEDF2`, on the right of every cell |
| numeric cells | right-aligned |
| agg row | **64** tall, top rule 1px `#EAEDF2`, right rule 1px `#EAEDF2` |
| agg label | `bb-roller-regular` **12/400** `#777E8B`, lh **15.96**, uppercase, **13** from the row top |
| agg value | Lato **16/700** `#15243E`, lh 24, **32** from the row top |
| agg inset | text ends **17px** in, both lines |
| caption | Lato 12/400 `#777E8B`, lh 17.1429, box 33 tall, 4px above |

⚠️ **`border-collapse: separate` IS WHAT MAKES THE FROZEN HEADER WORK.** Under `collapse` the
borders belong to the TABLE, not the cells, so a `position: sticky` th leaves its rules behind
and the 2px black edge disappears the moment you scroll. With `separate` + `border-spacing: 0`
each cell paints its own edges and they travel with it; nothing doubles up because every rule
here is a single `border-right` or `border-bottom`. Scoped to `--report`, so the pivot and the
plain table tiles keep `collapse`.

⚠️ **THE BLACK RULE IS AN INSET BOX-SHADOW, NOT A BORDER.** It paints over the last 2px of the
header's own 48 in the reference; a real `border-bottom: 2px` ADDS to the box and pushes the
text off centre. A box-shadow also travels with a sticky cell whatever the collapse mode.
Verified frozen: at scrollTop 0 / 1200 / 7886 the header sits 1px inside the wrapper every
time, with the shadow and the pale rule intact and `elementFromPoint` over the band returning
the `th` (not a row bleeding through), and the agg row pinned 1px off the bottom.

⚠️ **THREE PLACES WHERE 1px OF BORDER CHANGES THE PADDING**, all of which read as sloppiness
if the reason is not written down:
- the header is `height: 49px`, not 48 — `box-sizing: border-box` means the 1px pale rule eats
  into it, so 48 gave 47 of content and a text block a pixel off centre;
- the body cell is `padding: 9px 16px 5px 17px` — 17 on the LEFT because nothing borders it
  there, 16 on the RIGHT because the 1px column rule makes up the difference;
- the agg cell is `padding-top: 12px` for a measured 13, because its own 1px top rule already
  pushes the content down.

⚠️ **A TILE BUILT BEFORE THE TEMPLATE WAS MEASURED DOES NOT UPGRADE ITSELF, and that read as
the template still being broken.** Reported as "doesn't look anything like the real site"
against a tile created an hour earlier — and the screenshot was right, but the cause was
stored data, not the design. A generated tile keeps its computed rows and props forever, so
an old Report tile shows raw headers ("Call Count"), monthly totals in a row-level grid (33,
4, 15 where every row is one call), short 4-and-6 ids, a "6 columns" note, and — because it
has no `reportFooter` — the PLAIN table chrome instead of the ag-Grid one. **The tell was the
row count: exactly 8, which was `reportRows`' old default.**
`upgradeReportTile` now re-derives those tiles on the way to the card, keyed off the missing
`reportFooter`, which only the old builder could produce. Verified by injecting a tile of
exactly that shape: it came back with the `--report` chrome, `Total Call Count`, 200 rows, 1
per row, the aggregation row and the caption. Idempotent on new tiles, and a no-op on any
other table.
⚠️ It re-derives the ROWS, so an AI edit to a stale tile's cells would be discarded — a
deliberate trade, since those rows are wrong in a way a prospect can catch and the template
is hours old. Do not widen it to tiles that already carry the new props.

✅ **CORRECTED: COLUMNS DO NOT FLEX AT ALL.** This section previously said "ag-Grid shrinks
below the floor when the tile is narrow", inferred from estimating pixel widths off a live
screenshot at an unknown scale. Two captures of the SAME 6-column report settle it — one in an
**863px** tile, one in a **1760px** tile — and the widths are IDENTICAL in both: 187.93 /
201.59 / 201.59 / 144.69 / 166.26 / 158.29. Columns are content-sized and then fixed; the grid
simply scrolls when they overflow. Do not re-derive geometry from a screenshot when a capture
can be measured.

⚠️ **WHEN THE COLUMNS DO NOT FILL THE TILE, THE HORIZONTAL RULES STILL DO.** In the 1760px
capture the columns total 1060 in a 1742 viewport, and the grid splits in two:

| element | width | what it draws |
|---|---|---|
| `.ag-row` | **1734** (full container) | its 1px `#DDE2EB` bottom rule, all the way across |
| `.ag-header-viewport` | **1742** | the 2px black rule, all the way across |
| `.ag-floating-bottom` | **1742** | the aggregation row's 1px `#EAEDF2` top rule |
| header ROW / aggregation ROW | **1060** | cells, text and the vertical column rules — these STOP |

So the empty area to the right of the last column is crossed by every horizontal rule and by
nothing else. That is the "lighter grey lines run all the width of the tile" in the reference.

**Reproduced with a trailing filler cell** (`.ts-report-spacer`, one per row, report grid only)
whose width is measured in JS by `useFillerWidth`. ⚠️ **Three CSS-only formulations were tried
and each measured wrong**, so do not "simplify" this back:
- `width: max-content` on the table — columns correct, but the table stops at the last column
  and takes its rules with it;
- `width: 100%` on the table — the browser negotiates every column against the available space
  and hands the slack to the DATA columns, past the 202 cap (226.1 measured);
- `width: 100%` on the filler cell — a percentage cell width forces every other column to its
  MINIMUM: all six came out 145.
The table stays `width: max-content; min-width: 0` (so the columns are genuinely content-sized)
and the filler takes `wrapper.clientWidth − Σ(data cell widths)`. Verified at two widths from a
fresh load: at a 1088px wrapper the columns read 164.9 / 145 / 170.2 / 202 / 145 / 145 with a
116px filler and the rules running 116px past the last column; at a 690px wrapper the same six
columns are unchanged, the filler collapses to 0 and the grid scrolls 282px.

⚠️ **THE FILLER MEASUREMENT NEEDS A LAYOUT EFFECT PLUS A rAF PASS** — the same first-paint trap
`TsGeoMap` documents. A single `useEffect` measured before the wrapper had a width, got 0, and
the ResizeObserver then never fired again because the box it watches never changed after
`observe()`. The filler sat at 0 forever and the rules stopped at the last column; forcing a
real resize by hand corrected it to 116, which is how the ordering was confirmed rather than
guessed.

✅ **THE TILE HEIGHT IS A CONSTANT 601, NOT LAYOUT-DRIVEN — this was recorded here as an open
item and the three captures close it.** Measured on an 863px tile, a 1760px tile with 6 columns
and a 1760px tile with 12: the grid box is **601** every time and the tile **703** every time.
Height tracks neither width nor column count. It decomposes as 2 (border) + 49 (header) + body
+ 65 (aggregation row), where the body is **485** when nothing scrolls sideways and **477**
when the 8px horizontal scrollbar takes its space — both fall out of the fixed 601 rather than
being set anywhere. One `max-height: 601px` reproduces every case; the earlier 589 was
assembled from parts (48 + 477 + 64) and came out 12px short.

⚠️ **AND THERE ARE 27px OF AIR UNDER THE TILE TITLE**, on all three captures, where ours had
the grid starting immediately below the heading. Scoped to the report grid, though the 27
almost certainly belongs to the tile chrome and therefore to every ts template — the gap falls
OUTSIDE the svg, so none of the chart measurements would have caught its absence. Applying it
globally means re-verifying nine signed-off templates, which is its own pass.
Verified after both changes: grid box 601, title-to-grid 27, header 49, aggregation row 65,
caption 33, 486 of visible rows against the reference's 485 — diff empty.

⚠️ **`__` IS DATA, NOT A SECOND ABSENCE MARKER.** One cell renders as what looks like an em
dash beside neighbours reading `{Null}`, which invites a rule about two kinds of absence. Its
code points are **U+005F U+005F** — two underscores, a real search-term value in that account.
Checked because the glyph was about to become a template rule; `{Null}` is the only absence
marker (66 cells in that capture, zero dashes).

❌ **REFUTED: the all-`{Null}` row does NOT sort first.** This section previously carried that
as an inference from a single capture whose first row was fully null. With three captures the
rule breaks: two of them lead with THREE fully-null rows whose ids are not in order (E79C,
4D95, AAA5), then ascend from 0093 — but `02B8-1C6F2B5EAA41`, also fully null, sits in its
ascending position rather than at the top. So nulls are not hoisted, and whatever orders those
leading rows is not visible in the grid. Left alone rather than implemented on a guess.

⚠️ **`height: auto` HAD TO BE SAID OUT LOUD.** The base `.ts-table td` pins 50px, so every
row sat at 50 against a measured 31 while the `--report` rule looked complete (it set the
padding and the line box and never mentioned height). And the padding is **7px** where the
capture's cell reads 8: ag-Grid pins its row height (31) BELOW the content box its own padding
implies (8+16+8+1 = 33), so copying the padding reproduces neither height. 7+16+7+1 lands on
31 / 47 / 63 exactly.

⚠️ **"Showing 1,000 of many rows" — WE RENDER 200 AND SAY 200**, the same call the Details
Report screen already made: 1,000 rows times a dozen columns is 12,000 live cells in a tile,
and claiming 1,000 while showing 200 is catchable by anyone who scrolls. It stays honest
because the footer aggregates describe the whole dataset, which is what "of many rows" means.
The caption sits OUTSIDE the scroller — inside it, it landed at the bottom of 8,958px of rows.

⚠️ **THE CAPTURE'S OWN PERCENTAGES DO NOT RECONCILE and ours deliberately do.** Its
15.35K/42.96K is 36% printed as 49%, and 20.02K/42.96K is 47% printed as 64% — evidently over
a smaller non-null denominator that is not on screen. Reproducing an inconsistency a prospect
can check with a calculator is worse than being self-consistent.

⚠️ **THE BUILDER EXTRACTION WAS MISSING THE ANSWERED FAMILY.** The tile renders
`Total Call Not Answered` and `Total Answered by Agent`, neither of which `insightsColumns`
offered — so the captured tile was not buildable. `Call Not Answered`, `Answered` and
`Answered by Agent` (with `(T/F)` twins) are now in **Call Details** beside `Call Count`;
their existence is proven by the tile, the GROUP is inferred from the family. Column totals
moved 234 → 240.

⚠️ **OPEN, and deliberately not guessed:** the capture also shows `Call Not Answered (%)` and
`Answered by Agent (%)` beside their `Total …` columns, and **no `(%)` name exists anywhere in
the 371 extracted builder columns**. Either the report derives a percentage companion per
conditional measure, or our accordion walk missed those names. We render exactly what the SE
picked and invent no companion column — a rule guessed from one sample would put columns
nobody asked for into the tile. Settle it with a capture of the Details builder scrolled to
the Call Details group.
⚠️ Also open: the SCREEN at `/insights/dashboard/Details Report` still shows **17** columns,
five of them guessed and five borrowed from other screens (see its own section). This capture
gives a definitive **12** for the TILE. They may legitimately differ — the screen is a saved
report someone configured — so the screen was left alone rather than rewritten off a
different surface's capture.

Verified through the real picker with the capture's own 9 picks: headers carry the Total
prefix, 200 rows all 31px, 2 of 10 columns capped at 202 with 164 rows wrapping to 47,
aggregation row 64px reading UNIQUE COUNT 48,293 / 6 / 15 / 7 / 5 / 18 / 2 then TOTAL 48.29K /
18.35K / 28.01K, caption present, wrapper 589px over 8,936px of scroll with header and footer
sticky at offset 0. Row shapes came out 3% / 30% / 52% / 15% against the capture's 3% / 29% /
53% / 15%. Untouched afterwards: the Details Report SCREEN (17 cols, 200 rows, 13/600 Lato,
42.5px rows), both pivot tiles (27px rows, optimo-plain, heat intact), the gallery's two plain
table tiles (13/700 at 48px, 50px rows, 40 per-column heat cells) and `/dashboards/marketing`
(21 dash-cards, 4px radius, KPI 48,293, 7 donuts, zero `ts-`). `npm run audit:ai` all green.

## Template: "Transactions Report" (measured 8/23/2026)
`reportRows(profile, cols, { transactions: true })` + the transaction fields on `RowShape`.
The grid is the Details Report's, unchanged — same chrome, same 145-202 band, same 2px black
header rule, same 601 box, same "Showing 1,000 of many rows". Geometry verified identical
(tile 703, grid 601, header 49, body 485, aggregation 65). **A ROW IS A TRANSACTION, NOT A
CALL**, and five things follow from that:

⚠️ **1. IT IS SORTED BY TRANSACTION ID, NOT CALL RECORD ID.** Measured: the transaction ids
ascend down the capture (4291B4C0 / 42B723DC / 446B5426 …) while the call record ids plainly do
not. The Details Report is the other way round. So the transaction id is built from the ROW
INDEX and the call id is hashed FROM the transaction id — which also means one transaction
always belongs to the same call.
⚠️ Ours ascended down BOTH columns at first, because the call id was derived from the row index
the way the Details Report correctly does it. That lost the very distinction the sort creates.

⚠️ **2. TRANSACTION ID IS 8 HEX, A DASH, 8 HEX** — `4291B4C0-57E84B76` — against the Call
Record ID's 4 and 12.
⚠️ It used to render the literal **"Transaction ID A"**: the THIRD time the minted-dimension
fallback has produced a placeholder in this grid (Website Journey and the measure columns were
the other two). Any column this report can show needs a real generator or that is what appears.

⚠️ **3. TOTAL CALL COUNT IS 0 OR 1 PER ROW**, where a Details row is always 1 — only one of a
call's transactions is the call leg. The capture's column holds exactly those two values.

⚠️ **4. THE TWO ID COLUMNS DISAGREE IN THE FOOTER, AND THAT IS THE POINT OF THE TEMPLATE.**
Measured: **105,359** unique Transaction IDs against **45,633** unique Call Record IDs, i.e.
`TX_PER_CALL = 2.31`. Counting both as "calls" printed the same figure twice and lost the one
fact the report exists to show. The 1-in-2.31 share of call-carrying rows falls out of the same
constant, so Total Call Count sums to the prospect's own call total (48.29K) — the capture's own
42.28K sits slightly under its 45,633 call ids, and ours reconciles exactly instead.

⚠️ **5. THE MONOTONIC-ID TRAP.** A first pass stepped the id by `row * (0x20 + seed % 0x1c0)`,
and because `seed` changes per row the ids wandered — 420002EA was followed by 420002AC. The
jitter has to be SMALLER than the stride: 0x200 per row with at most 0x1F0 of jitter ascends
while still leaving the irregular gaps the capture shows.

Verified through the real picker with the capture's seven columns (the two seeded ids plus five):
headers, footer labels, caption, header 49 / row 31 / aggregation 65 / title-to-grid 27,
transaction ids strictly ascending, call ids NOT ascending, Total Call Count only ever 0 or 1 —
diff empty. Details re-checked in the same pass: still ascending by call id, still 1 per row,
still 4-and-12 ids. All three Reports rendered side by side on one dashboard keep their own
identity (Details 200 rows / 601 box, Summary 1 row / 154 box, Transactions 200 rows / 601 box).

## Template: "Summary Report" (measured 8/23/2026)
`summaryRows` in `insightsTileData.ts`, the `summary-report` branch in
`InsightsColumnPicker`. It reuses the Details Report's grid wholesale — same ag-Grid chrome,
same 145-202 column band, same 2px black header rule, same pinned aggregation row. What
differs is the BODY.

⚠️ **A SUMMARY IS THE AGGREGATE, NOT A SLICE OF ROWS.** Measured: seven measure columns, ONE
body row, and every number in it repeated under `TOTAL` in the pinned row — 42.96K / 6.03K /
1.46K / 172 / 8 / 1.76K / 19.73K in both. So it cannot go through `reportRows`, which mints
one row per call. `summaryRows` builds the row from the same `magnitudeOf` the footer uses,
which is what makes the two agree by construction rather than by luck (asserted).

⚠️ **THE CAPTION COUNTS ITS ROWS: "Showing 1 of 1 row"**, singular — where the Details Report
says "Showing 1,000 of many rows". A summary shows everything it has; a details grid shows a
slice. `reportCaption` takes an optional total and agrees the noun with it.
⚠️ `upgradeReportTile` re-derives the caption, so it has to know which report it is looking
at — deriving it blind overwrote the picker's "1 of 1 row" with "1 of many rows". The title is
the only thing on a stored tile carrying that.

⚠️ **GROUP BY IS OPTIONAL, and Create used to be disabled without it.** This file previously
said "a summary has to aggregate by something". The capture is a summary of NOTHING — no
dimension column, one row of totals — so the ungrouped case is the product's own default and
was unreachable in our picker. The option now reads "None". The GROUPED shape (one row per
dimension value) is implemented but **unmeasured**; no capture sets a Group By.

### Two corrections to the measure model, both from this capture
⚠️ **"Total Total Messages" IS WHAT THE PRODUCT PRINTS.** `axisTitleFor` used to suppress the
prefix when the measure already began with "Total"/"Average", on the grounds that doubling read
as a bug. The capture's second column header is exactly `Total Total Messages` for the measure
named `Total Messages`, so the guard was a departure from the real site and is gone. Blast
radius is one measure — the only catalogue name starting with an aggregation word.

⚠️ **A NAME ENDING IN "(Seconds)" IS ADDITIVE, NOT A DURATION.** `AI Agent Answer Offset
(Seconds)` and `AI Agent Handle Time (Seconds)` both carry the **Total** prefix, both print
compactly (1.76K, 19.73K — not 29:20) and both are labelled `TOTAL`. The duration family would
have made them non-additive and dropped the prefix. This replaces an INFERENCE with a
measurement: the note at `aggregationWord` records that duration was never captured, only
percent was. A bare time measure ("Agent Handle Time", "Hold Time") has no unit in its name and
stays a duration — an average per call, where this is a quantity of seconds. Verified the
gallery's multi-line specimen still renders `$4.7M` beside `2:32`, so the widest-label case is
intact.

⚠️ **`pick()` HAD FIVE POSSIBLE VALUES, and a one-row report is where that finally showed.**
`lo + (seed % ((hi - lo) * 10)) / 10` over the count branch's 0.18-0.72 band yields exactly
0.18 / 0.28 / 0.38 / 0.48 / 0.58, so differently-named measures collided constantly — three of
seven Summary columns came out 18.35K and two more 28.01K. Invisible in a Details Report, where
every measure column is a column of 1s; unmissable with one number per measure side by side.
Now 1,000 steps. Same defect the money branch's seeded spread already existed to prevent.

⚠️ **AND THE COUNT SHARE IS LOG-UNIFORM NOW, not a linear 0.18-0.72 band.** The capture spans
**8 to 42.96K on one row** — Voice AI Agent Opt In at 8, Engaged at 172, Answered By AI Voice
Agent at 1.46K — because a pilot feature and a call count are not the same order of thing. A
linear band put every count measure between a fifth and three quarters of the call total, so a
row of them read as the same number over and over. `Answered` and `not answered` stay anchored
to plausible rates, since those are the two a prospect checks against the dashboards.

⚠️ **THE REFERENCE'S 87px OF EMPTY BODY IS ITS TILE SLOT, NOT THE TEMPLATE.** Its grid box is
**234** for a single 31px row (2 + 49 header + 118 body + 65 aggregation), and the tile is 336
where the Details tiles are 703 — the SE sized that tile taller than its content. Ours is
content-height under the 601 cap, so a 1-row summary renders compactly at ~154. Also worth
noting against the Details Report section above: 601 is that tile's slot, not a universal — a
tile in a smaller slot gets a smaller grid box.

Verified through the real picker with the capture's own seven measures and no Group By: headers
identical including `Total Total Messages`, one body row, all seven footer cells `TOTAL`, body
values equal to footer values, caption `Showing 1 of 1 row`, header 49 / row 31 / aggregation
65 / title-to-grid 27 — diff empty. Non-regression: the 46-question catalogue still resolves
0 failures, the gallery's 9 charts keep 0 gridlines and no axis title doubled, Calls-by-Hour
still totals 48.3K, a Stacked Bar still totals 48,293, and `/dashboards/marketing` is unchanged
(21 cards, KPI 48,293).

## Templates: "KPI" and "Metric" (measured 8/21/2026)

**Metric** is the number and NOTHING else — the captured card's entire text content is
`42.05K`. No label beneath it, no period, no sparkline, no legend. Value 32px/700 `#1d232f`
at line-height **37px**, carrying the same `kpi-module__hero` class as a KPI's value.

⚠️ **THE HERO NUMBER ABBREVIATES, and none of the three existing formatters did it.** 42,050
prints **"42.05K"** — `formatMeasure` gives "42,050" and `formatTick` gives "42.1K" (one
decimal). So the hero is its own format (`formatHero`): compact from 1,000, up to TWO
decimals, trailing zeros stripped — the same stripping the pie's percentages showed. A
duration deliberately does NOT compact; "2.05K" seconds means nothing.

⚠️ **TWO PARTS OF THAT ARE INFERRED FROM ONE SAMPLE, and are flagged in the code:**
1. The two-decimal rule rests on the single value 42.05K. A captured 42,000 would settle
   whether it prints "42K" or "42.00K"; stripping is the assumption.
2. Whether a KPI's hero abbreviates too. Its captured value was "7", identical either way.
   They share `kpi-module__hero`, which is why it is applied to both — a class name, not a
   measurement. It changes a KPI headline from "9,502" to "9.5K".

⚠️ **`.ts-kpi .ts-kpi-value` IS 0,2,0 ON PURPOSE.** A single-class `.ts-kpi-value` ties with
`.ts-trend-value` and loses on source order, rendering the KPI's 40px line-height where the
Metric capture measures 37.


`TsTrend` / `TsKpi` in `TsKpi.tsx`. Both share `tileType: "kpi"`; a KPI carries `trend` and
a Metric does not, which is the only difference between the two templates.

| | measured |
|---|---|
| value | **32px / 700** `#1d232f` — NOT `.ts-metric-value`'s 28px |
| period ("Week of …") | 14px / 400 `#777e8b` |
| delta percentage | 14px / 400 **`#F04152`** with a down arrow |
| absolute delta "(29)" | 14px / **700** `#777e8b` |
| comparison period | 14px / 400 `#777e8b` |
| trailing chevron | 16px `#777e8b` (`rd-icon-chevron-right`) |
| sparkline | **453 x 178**, area `rgba(38,102,249,0.2)`, line `#2666F9` at 2px |
| axes / gridlines / footer | none visible |

⚠️ **THE DELTA ROW IS THREE DIFFERENT TREATMENTS, NOT ONE COLOURED STRING.** Only the
percentage is red; the absolute delta is grey and BOLD; the comparison period is grey and
regular. The previous version coloured the whole row, which dragged "(29) Week of …" red
along with it. The real markup confirms it — `kpi-module__difflabel` carries an inline
`color:rgb(240,65,82)` while `kpi-module__base` and `kpi-module__timeBucket` do not.

⚠️ **THE ARROW IS A TINTED DIV, NOT A GLYPH.** `kpi-module__arrowDown` with
`aria-label="Decrease"` and a CSS `filter` recolouring it. Reproduced with a text arrow plus
the same `aria-label`, since the semantics are what matter and the glyph is 13px either way.

⚠️ **THE INCREASE COLOUR IS UNVERIFIED.** The capture only ever showed a DECREASE, so the
red is measured and the green (`#0d7a3e`) is a choice. A capture of a rising KPI would settle
it. Likewise unverified: whether ThoughtSpot ever treats a fall as GOOD — for a measure like
abandoned calls, down is good, and this colours purely by direction.

⚠️ **THE DELTA IS DERIVED FROM THE SERIES, NOT INVENTED.** The old build printed a random
`+{4 + seed % 12}%` beside a number with no series behind it, so the figure and the trend
could not agree — there was no trend. It is now the last bucket against the one before, over
the same `filteredWeeks` window every time-series template uses, so a KPI's headline equals
the last point of a Single Line tile on the same measure. A zero baseline yields 0% rather
than an infinity.

⚠️ **THE GREY RECTANGLE IN THE CAPTURE IS NOT PART OF THE TEMPLATE.** It is a second
`arearange` series filled `rgba(116,126,140,0.3)` with no stroke — the user said to ignore
it, and a first pass at measuring grabbed it instead of the real blue `area-series`.

## Template: "Geo Heatmap" (measured 8/21/2026)
`TsGeoMap` (Leaflet + Mapbox raster tiles) + `geoPoints` in `insightsTileData.ts`.

⚠️ **THE REAL TILE IS OPENLAYERS, NOT MAPBOX GL.** The capture carries `ol-viewport`,
`ol-layer`, `ol-zoom`, `ol-zoom-in` — OpenLayers — drawing **Mapbox raster tiles**, which is
where the "© Mapbox © OpenStreetMap / Improve this map" attribution comes from. Mapbox
supplies the tiles; it is not the map library. That is also why the +/− buttons are square
and dark rather than Mapbox GL's rounded pair.

⚠️ **WE USE LEAFLET, DELIBERATELY, AND IT IS A BUNDLE DECISION.** The app ships as ONE
bundle with NO code splitting — load-bearing for the service worker — so anything added
loads on every screen. Measured: Leaflet took the bundle 1,855,972 → 2,010,239 bytes raw,
**+154KB raw / ~+43KB gzipped**. OpenLayers is ~120–180KB gzipped even tree-shaken, and
mapbox-gl ~900KB, for a map nobody can tell apart once the tiles are the same. Agreed with
the user 2026-08-21 after laying out all three options.

| | how |
|---|---|
| tiles | `mapbox/light-v11` at `@2x` (the captured canvas carried a 1.111 device-pixel transform) |
| initial view | `fitBounds` over every point, `maxZoom: 9`, 28px padding |
| dots | palette red `#E4131B` at 0.7 opacity, radius **2.5–8** scaled by **√(value/max)** |
| hovered dot | a `#1d232f` ring and 0.9 opacity, as the reference shows |
| zoom control | square, `#1d232f`, white glyphs, 26px, top-left |
| tooltip | the shared dark panel: coordinate caption + `lat, lon` to 4dp, then the measure caption + value |
| legend | none |

⚠️ **DOT SIZE WAS REDUCED FROM 4–13 TO 2.5–8** (asked for 2026-08-21): at the larger size a
big metro read as one blob and adjacent dots merged, where the reference keeps them
individually visible even overlapping.

⚠️ **THE DOT COLOUR IS READ FROM A SCREENSHOT, NOT MEASURED — the only template where that
is true.** OpenLayers renders its vector layer to a CANVAS, so no DOM node carries a fill.
Every other template's colours came off the DOM.

⚠️ **`fitBounds` MUST RUN AFTER THE CONTAINER HAS A SIZE.** Inside a flex tile the map div
is 0x0 on first paint, so an immediate fit computes against nothing and lands on a wrong
zoom — observed: Alaska stayed off-screen even though its dot was inside the bounds.
`invalidateSize` alone does NOT re-fit, it only re-measures, so the fit is held in a ref and
re-run from a ResizeObserver. That also handles the window being resized mid-demo.

⚠️ **NO PROFILE CARRIES PER-CALL COORDINATES**, so this is the one template whose geography
cannot come from the prospect. `geoPoints` uses REAL metro coordinates and REAL population
weights, apportioning the MEASURE's own total across them — so the geography is true, the
volumes are the prospect's, and only the scatter inside a metro is invented. Seeded off the
profile id, so an SE demoing the same account twice never sees the dots move.

⚠️ **VERIFYING A LEAFLET DOT: IT IS A `<path>`, NOT A `<circle>`.** `circleMarker` renders
arc commands (`d="M…a13,13 0 1,0 26,0…"`), so reading an `r` attribute returns nothing and a
naive check reports radius 0 for a perfectly good dot. That cost a wrong diagnosis.

## Template: "Dual Y-Axis" (measured 8/21/2026)
`TsDualAxis` + `TS_DUAL_*` / `dualBarWidth` / `dateTickIndices` in `tsChart.ts`.

⚠️ **LEFT MEASURE = BARS, RIGHT MEASURE = LINE.** Proven, not assumed: the capture holds TWO
of these tiles with the measures swapped, and whichever sits on the left drives the teal
columns and the left axis while whichever sits on the right drives the blue line and the
right axis. The drawer's fields are already named "Measure (Left Side)" / "Measure (Right
Side)".

| | measured (two charts, 14 categories) |
|---|---|
| canvas | **664.913 x 634.93**, drawn 1:1 |
| plot | left **68**, right **68**, top **15**, bottom **55** |
| bars | **#00DEBC** teal, width `round(band * 0.8)` — band 37.79 → **30** |
| bar stroke | **#ffffff at 0.5px** — a thin white gap between columns |
| line | **#2666F9** at 2px, point markers at **opacity 0** (invisible until hover) |
| left axis labels | 15px left of the plot (x=53 for a plot at 68) |
| right axis labels | 15px right of the plot (x=612 for a plot edge at 597) |
| axis titles | HTML 12px/600 `#5b6577` — bar measure left, line measure right, rotated |

⚠️ **THE RIGHT INSET IS 68, NOT THE 212px LEGEND WIDTH.** `plotOf(w, h, LEGEND_W)` was
reserving the legend's width INSIDE the svg, shrinking the plot by 144px for space nothing
occupies — the legend is HTML, a `TsTile` sibling. The measured insets are symmetric because
the right axis needs the same room as the left.

⚠️ **NO AXIS LINES AND NO GRIDLINES** — every such element computes to `stroke: none`, the
same as the horizontal-bar template and unlike the line templates, which DO paint a visible
`#e0e0e0` axis line. `TsAxes` gained `showLines` for exactly this; it defaults to true so the
line templates are untouched.

⚠️ **X LABELS THIN BY WIDTH, NOT BY CALENDAR.** The capture prints 7 of 14 weekly dates —
every SECOND one, anchored to the LAST index (03/30 is shown, 12/29 is not). `calendarTicks`
thins on month boundaries, which is right for 112 weekly points and wrong here.
`dateTickIndices` derives the step from label width: 14 labels of ~70px need 980px in a 529px
plot, so step = ceil(980/529) = 2, which reproduces the captured set exactly. Our own 5-week
filter window needs no thinning and shows all five.

⚠️ **A DUAL TILE OPTS INTO `needsWidth`.** It carries a right-hand axis AND a legend, so in a
one-column tile the legend's 212px squeezed the plot until the date labels thinned down to
two of five. The container query drops the legend below the chart under 700px — the same
mechanism multi-line uses.

⚠️ **`round`, WHERE THE HORIZONTAL BAR MEASURED `ceil`.** Band 37.79 gives a 30px bar here
(round → 30, ceil → 31); the horizontal chart's band 52.667 gives 43 (round → 42, ceil → 43).
One pixel, measured differently on each, and deliberately left as two rules rather than
forced into one that matches neither.

⚠️ **HOVERING A BAR BRIGHTENS THAT BAR; ITS NEIGHBOURS DO NOT CHANGE.** Reported against the
real tile. The hovered column lightens and the line fades to 0.22, while the sibling columns
stay exactly as they were — dimming them too would read as "the others are inactive" rather
than "this is the one".
⚠️ **THE BRIGHTEN AMOUNT IS HIGHCHARTS' DOCUMENTED DEFAULT, NOT A MEASUREMENT — and it cannot
be measured from a capture.** SingleFile strips the scripts, so the hover state never runs in
the extracted frame; there is no hover fill in the DOM to read. ThoughtSpot renders Highcharts
10.2.0 (the capture says so), whose `plotOptions.column.states.hover.brightness` defaults to
0.1, i.e. each channel moves by 255*0.1. `#00DEBC` → **#1AF8D6**, which matches the brighter
aqua in the reference screenshot. `brighten()` lives in tsPalette.ts.

⚠️ **THE TOOLTIP USES THE AXIS-TITLE FORM AND THE MEASURE'S OWN FORMAT.** The reference reads
"Total Call Count: 426"; ours read "Revenue (Sale Amount): 7.4M" — no "Total" and no "$". The
same defect the multi-line LEGEND had, surfacing again in a different place. Fixed here by
`axisTitleFor(name)` plus a `leftFormat` prop, which also gives the left axis its `$0 … $10M`
ticks. ✅ **NOW CONSISTENT ACROSS EVERY TEMPLATE.** Single-line, multi-line, grouped column and the
horizontal bar all use `axisTitleFor(name)` too, so a tooltip and its axis can never disagree.
⚠️ **EXCEPT THE PIE, AND DELIBERATELY.** A pie's tooltip label is a DIMENSION VALUE ("Paid
Search"), not a measure, and `axisTitleFor` would render it "Total Paid Search" — `kindOf`
defaults an unrecognised name to `count`. Every other chart's first tooltip row IS a measure.
Verified across all nine bench tiles: the measure charts read "Total Call Count:", the pie and
donut read "Affiliate:" / "Direct:", and the dual-axis line reads "Appointment Rate:" with NO
prefix because percent is non-additive — three different correct outcomes from one rule.
The horizontal bar also gained a `valueFormat` prop, so a money Stacked Bar keeps its `$` on
both the ticks and the tooltip.

⚠️ **UNVERIFIED: whether the bar width is capped.** Only one capture exists, with 14
categories. Our own 5-week window gives band ~80 and therefore ~64px bars, which is wider
than anything measured. The grouped-column template DOES cap at 22px; this one shows no
evidence either way.

`tileType: "dual"` is a new member of the union and, like the render hints, is deliberately
absent from `TILE_PROPS` in `engine/assistant.ts` — only `buildTile` sets it.

## Template: "Stacked Bar" (really a HORIZONTAL BAR, measured 8/21/2026)
`TsBar` + `barLeftInset` / `barThickness` / `TS_BAR_PLOT` in `tsChart.ts`.

⚠️ **THE NAME LIES AND THIS IS THE WHOLE POINT.** The Add Tile list calls it "Stacked Bar"
and its blurb says "see the breakdown of each segment". The real tile draws **ONE blue
series as HORIZONTAL bars** — categories down the left, values along the bottom. Nothing is
stacked, and there is no second series to stack. The previous build drew stacked VERTICAL
columns, which is a different chart entirely.

| | measured (two charts, 12 and 33 categories) |
|---|---|
| canvas | **956 x 707**, drawn 1:1 |
| plot | top **20**, bottom **55**, right **3**, left content-derived |
| left inset | **125** with 12-char labels, **309** with 40-char ones → `48 + chars * 6.5` reproduces both within 1px |
| bar thickness | `ceil(band * 0.8)` — band 52.667 → **43**, band 19.152 → **16** |
| fill | **#2666F9**, single series, no stroke |
| category labels | right-aligned (`anchor=end`) **15px** left of the plot, 12px Lato 400 `#5b6577` |
| value labels | **20px** below the plot, centred on their tick |
| axis titles | HTML 12px/**600** `#5b6577` — category rotated left, value centred below |

⚠️ **CATEGORY LABELS ARE NEVER TRUNCATED — the inset grows instead.** 40-character campaign
names print in full and the plot starts at 309. That is the OPPOSITE of the pie, which caps
its labels at 30 characters and keeps the ring where it is. Do not "unify" the two.

⚠️ **`ceil`, NOT `round`.** Both measured thicknesses come out wrong with `round` (42 and
15) and exactly right with `ceil` (43 and 16). The old `min(TS_BAR_THICK=56, band * 0.8)`
also wrongly pinned a few-category chart to 56.

⚠️ **NO AXIS LINES, NO GRIDLINES, NO FOOTER — all three differ from other templates.** The
axis-line and grid-line elements exist and BOTH compute to `stroke: none`, so neither
paints; the line templates DO carry a visible `#e0e0e0` axis line, so `TsAxes` must not be
reused here. The "Showing N of N data points" text sits outside the svg's visible box, and
the reference screenshot shows none — while the PIE does show one.

⚠️ **CATEGORIES SORT ALPHABETICALLY — the SAME code-unit order as the pie, measured on the
bar capture too.** It reads {Null}, Billboard, Connected TV, Direct Mail, Display, Email,
Organic, Paid Search, Print, Social Media, Television, direct — lowercase `direct` last
because 'd' (100) is above every uppercase letter. So the LONGEST BAR SITS MID-LIST: order
and magnitude are independent, and sorting by value would be wrong. `categoryOrder` in
tsChart.ts serves both charts (`pieOrder` is an alias).

⚠️ **VALUES COME FROM THE REAL BREAKDOWN, NOT A SPREAD** (`dimensionBreakdown`). The
synthetic `series()` generated values inside a ~1.6x band, so five near-identical bars told
no story; the prospect's own by-source rows run 21,732 down to 4,225 (5.1x) and the reference
capture runs 660 down to 3 (220x). `dimensionValues` was reading the row NAMES out of
`marketingDashboard.breakdowns` and discarding the numbers sitting right beside them.
Two paths, both derive-don't-generate:
- the measure MATCHES a metric column -> that column verbatim, so the tile and the dashboard
  cannot disagree. Call Count totals **48,293**, the prospect's real call total.
- otherwise -> the first column as the SHAPE, with the measure's own magnitude apportioned
  across it by largest remainder (additive kinds) or a level per category skewed by weight
  (percent / duration / score / rank).

⚠️ **"KEEP PAID SEARCH BIGGEST" HOLDS FOR COUNTS BUT NOT FOR REVENUE, AND THAT IS THE REAL
DATA.** Call Count and Answered both peak on Paid Search (21,732 / 12,605). Revenue peaks on
**Email** at $11,850,511, because Email converts far better (93% quote discussed, 71%
purchase) on fewer calls. Forcing Paid Search to the top there would contradict the
prospect's own dashboard — and the Email story is the more interesting one to demo.

⚠️ **THREE TEMPLATES SHARE `tileType: "bar"`** — Stacked Bar, Calls by Hour and Calls by Day
of Week — and only Stacked Bar is horizontal. `GeneratedTile.horizontal` tells them apart at
render time; it is optional and deliberately absent from `TILE_PROPS`, like the other render
hints. The `/ts-gallery` bench now carries BOTH a horizontal Stacked Bar and a vertical
column specimen, because a regression in one would otherwise hide behind the other.

Verified on the real Add Tile path, not just the bench: `isHorizontal: true`, thickness 58
at band 72.4 (= `ceil(57.92)`), `#2666F9`, 0 axis lines, 0 gridlines, no legend, both axis
titles present.

## Template: "Pie Chart" (really a DONUT, measured 8/20/2026)
`TsPie` + `piePlot` / `pieOrder` / `pieLabelText` in `tsChart.ts`, `TS_PIE_COLORS` in
`tsPalette.ts`. Measured off a 33-slice capture; the first build was wrong in six ways.

| | measured |
|---|---|
| canvas | **847 x 635**, drawn 1:1 (was 563x402) |
| centre | **(420.458, 300)** — NOT the canvas centre; cx is 3px left of w/2 and cy sits above h/2, leaving room for the footer |
| radii | outer **206**, inner **103** — exactly 0.5, confirming `TS_DONUT_INNER` a second time |
| start | 12 o'clock, clockwise |
| slice gap | **0.057°**, and **NO stroke** |
| label | `Name - count (pct%)`, name cut at **30 chars + …** |
| percentage | 2dp with **trailing zeros stripped** — the capture reads `1.7%`, not `1.70%` |
| label type | 12px Lato 400, `#5b6577` |
| connector | **2px, coloured to match its slice**, and it CURVES (a cubic, not an elbow) |
| legend | **none** — the outside labels replace it |
| footer | `Showing N of N data points` at x=13, y=615 |

⚠️ **SLICES ARE ORDERED ALPHABETICALLY, NOT BY VALUE.** The 1-call slice sits 18th and the
155-call slice 23rd, so size plays no part — the opposite of what a chart library defaults
to.

⚠️ **AND IT IS A CODE-UNIT COMPARE, NOT `localeCompare`.** Verified against all 32 non-null
labels: a plain `<` sort reproduces the captured sequence exactly; `localeCompare` diverges
on the FIRST element. My code comment originally claimed localeCompare "reproduces it on its
own", which was wrong. Three cases show the difference is real:
- `“Stronger Every Day”` sorts LAST (U+201C is above every ASCII letter); localeCompare
  treats the quote as ignorable and files it under S.
- `Hear Better` before `Heart & Lung` (space 32 < `t`).
- `The Sinus-Allergy` before `The transformational` (`S` 83 < `t` 116) — case-SENSITIVE,
  which a locale compare deliberately undoes.
`{Null}` is pinned first: by code unit `{` (123) would sort it after every lowercase letter.

⚠️ **DO NOT CLAMP THE RADIUS BY LABEL WIDTH.** The first `piePlot` reserved 250px a side for
labels and produced r = 173.5 at the measured canvas instead of 206. The labels are not
outside the ring's column — they overlap it and run to the canvas edge, which is exactly why
11 of the capture's 33 are truncated. The only clamp is an overflow guard.

⚠️ **THE VISIBLE WHITE SEPARATION IS THE 0.057° GAP, NOT A BORDER.** The captured slices
carry no `stroke` attribute and no CSS stroke rule — checked both. At high DPI a 0.2px gap
leaves a partially-covered pixel that blends to the white background and reads as a thin
white line, so measurement and appearance agree. Do not "fix" it by adding a 1px white
stroke.

⚠️ **NO LEGEND, AND A PIE SPANS THE ROW.** Both confirmed against the real tile
2026-08-20. The outside labels already name every slice, so a legend says everything twice
AND steals 212px the labels need. `TsTileCard` had to be fixed separately from the gallery —
fixing only the bench left every GENERATED pie with a legend, which is what the user
screenshotted. The tile also carries `ts-span-2` like a table: the labels need ~250px a side
on top of a ~280px donut, so ~800px of chart, and the measured tile IS 847 wide. In a
half-width tile (584px at a 1500px viewport) the left-hand labels ran off the canvas.

⚠️ **THE COLOUR SEQUENCE IS UNRESOLVED — THREE CAPTURES NOW DISAGREE ON SLICE 0.** The 33-slice
donut starts GREY: hue-major, grey → orange → purple → green → yellow → teal → blue, steps
`[0,3,1,4,2]` within each hue so every block ends on its base colour and the last slice lands
on `#2666F9`. Grey and orange skip their darkest step (`#53575f`, `#994329`), which is what
makes it 4 + 4 + 5×5 = **exactly 33** for 33 slices — every colour used, so nothing is known
about a 34th. That is `TS_PIE_COLORS`, and it matches all 33 measured fills exactly.
An earlier small pie ran the step-major order and reached a blue TINT by slice 9, i.e. it
started BLUE. And a THIRD pie, from a different tenant, gives `{Null}` a dark maroon.

✅ **THAT SETTLES IT: THE COLOUR IS NOT DERIVABLE, so stop trying.** Position 0 is grey in
one, blue in another and dark red in a third, so it is not positional. It is not a label hash
either — `{Null}` is the same string in two of them and gets different colours. It is not
value-rank: `{Null}` is the largest slice in both and still differs. The remaining
explanation is per-visualisation colour configuration saved on the tile, which no rule of
ours can reproduce. `TS_PIE_ACTIVE_COLORS` therefore stays on the blue-first
`TS_SLICE_COLORS` permanently, and the pending small-pie capture is NO LONGER NEEDED.
`TS_PIE_COLORS` is kept only as the measured record of that one 33-slice tile.

## Template: "Multi-Line Chart Over Time" (measured 8/20/2026)
`TsMultiLine` in `src/components/ts/TsCharts.tsx` + `buildTile`'s
`"Multi-Line Chart Over Time"` case. Measured from a capture holding four of them (2, 3
and 4 series, plus a 4-series percent variant), so every number below has at least two
independent confirmations.

**It INHERITS the frozen single-line design** — canvas, plot insets, no gridlines, tick
count 8, the exact-minimum y floor, HTML axis titles, the dotted partial tail, the tile
frame, the window from the dashboard filter. Three things are genuinely new:

| | how |
|---|---|
| several lines | `#2666F9`, `#00DEBC`, `#FFD800`, `#2CBF58` in order, from `TS_SERIES_LINE` |
| an axis PER series | series 0 on the left, 1..n stacked rightward, **each on its own scale** |
| the legend | top-**right**, `align-self: flex-start`, 204px, 24px rows, 12px round dots |

⚠️ **EVERY SERIES GETS ITS OWN Y AXIS AND ITS OWN SCALE — they are not shared.** Measured
axis lines at x = 68 / 555 / 607 / 672: the left axis, then the plot's right edge, then
+52, then +65. The first right-hand axis sits ON the plot edge. The plot NARROWS as series
are added: measured 626 / 561 / 487 for 2 / 3 / 4 series.

Right-hand tick labels are `anchor="start"` 15px outside their axis line, and the rotated
title then sits in the space between those labels and the NEXT axis line.

⚠️ **THOSE GAPS ARE CONTENT-DERIVED, NOT CONSTANTS — and freezing them as 52 and 65 was a
real bug the user caught.** The first version explained the difference as "the first gap
really is narrower than the rest". It is not. The capture's first right axis printed the
single label `0` and its second printed `91%`; each gap is just wide enough for that
axis's own labels plus its title. One rule reproduces both:

```
gap = 15 (label offset) + widestChars * 6 + 7 + titleBand + 6
  "0"   -> 15 +  6 + 7 + 18 + 6 = 52   (measured 52)
  "91%" -> 15 + 18 + 7 + 18 + 6 = 64   (measured 65)
```

`rightAxisLayout()` in `tsChart.ts` takes the FORMATTED labels each right axis will print
and returns the line and title positions. With the frozen constants, a `$4.7M` money axis
put its title 7px INSIDE its own tick labels and straddling the next axis line — the
reported defect. This is the same mistake `leftInsetFor` exists to avoid on the left, 40
lines up in the same file.

⚠️ **THE TITLE BAND IS ITS MEASURED 18px — RESOLVED BY DRAWING 1:1.** Historical, because
it explains the shape of the bug: the titles are HTML at a fixed 12px, and while the svg
scaled with its column a title's 18px band cost `18 / scale` viewBox units — measured **16
units at scale 1.12 and 35.5 at 0.508**, same title. Reserving a flat 18 is why the
collision was invisible in a wide bench tile and obvious in a half-width dashboard tile.
Charts are now drawn at 1:1 (see "Charts are drawn 1:1" below) so the band is simply 18 and
the conversion is gone.

Verified at two widths after the fix — every title clears its own labels and the next axis
line: at scale 1.12, gaps of 2.6 / 7.1px past the labels and 6px before the next line; at
0.508, 2.5 / 7.1 and 6. The `/ts-gallery` specimen deliberately mixes a count, a money and
a duration measure so the widest label case (`$4.7M` beside `2:32`) is always on the bench;
a specimen with narrow labels would not have shown this.

⚠️ **A FLAT SERIES COLLAPSES TO ONE TICK, IT DOES NOT DRAW AN AXIS OF ZEROS.** The
capture's all-zero series rendered a single `0` label at mid-height with the line across
the middle. `niceScale` returns `{min: v-1, max: v+1, ticks: [v]}` for a flat series so a
measure with no variation in the window still reads as a level rather than as an empty
axis.

⚠️ **THE LEGEND IS TOP-ALIGNED, and `align-self: center` was a guess I had to unlearn.**
Measured y = 0 against the tile body on all four charts. It is asserted in the
non-regression check (`legendTopAligned: 0`), because vertical centring looks perfectly
reasonable in isolation.

⚠️ **THE LEGEND USES THE AXIS TITLE FORM, not the bare measure name.** The capture's
legend reads `Total Call Count` and `Answered by Agent (%)` — character for character its
axis titles. Showing `Call Count` in the legend beside an axis that says `Total Call
Count` reads as two different measures.

⚠️ **`TsMultiLine` is a SIBLING of `TsLine`, deliberately not an overload.** `TsLine` is
signed off as the frozen single-line template; adding multi-axis branches inside it would
put the reference implementation one bad conditional away from changing. `TsTileCard`
picks by `series.length > 1`. The single-line path is untouched — re-verified after this
build: 2 axis lines, 0 gridlines.

Multi-Line uses the same five-week window as single-line, from the same
`marketingDashboard.dateRange` field, so every tile on a dashboard still covers one period.

⚠️ **THE CHART FILLS THE TILE; ITS HEIGHT IS NOT DERIVED FROM ITS WIDTH.** Reported: the
x axis stopped well short of the bottom of the tile where the real instance reaches it.
Cause: `.ts-svg { height: auto }` derives the svg's height from its WIDTH through the
viewBox, so a chart that gives 212px to a legend is proportionally SHORTER than the
legend-less chart beside it, and the grid stretches both tiles to the taller one. Measured
in the reported pairing: single-line's x title sat 15px off the tile bottom, multi-line's
sat **114px** off.

ThoughtSpot sizes its chart to the container box in BOTH dimensions. `useVbBox` measures
the wrapper and the viewBox HEIGHT is derived from the real aspect ratio, so the geometry
stretches without distorting text. After the fix both x titles sit at 15px, and the
multi-line svg went 310x292 -> 310x391.

Two CSS facts, each of which cost a wrong attempt and both recorded in `ts.css`:
- **`height: 100%`, not `align-items: stretch`.** The wrapper's parent is `.ts-tile-viz`,
  an intermediate BLOCK, so the body's stretch never reaches it — measured tile 445, body
  391, wrapper still 292. A percentage height resolves against `.ts-tile-viz`, which the
  flex row DID stretch.
- **The intrinsic height is a `padding-top` spacer, not `aspect-ratio`.** `aspect-ratio`
  makes a flex item's cross size definite, so nothing can grow it afterwards. Some
  intrinsic height is required or the wrapper and the svg size off each other and collapse
  to zero.

`.ts-tile` also became a flex column so the body can receive the height the grid gives the
tile. A no-op for a tile that is already the tallest in its row.

⚠️ **THE FALLBACK IS THE MEASURED BASELINE, and that is what makes this safe.** When a tile
is NOT stretched, `.ts-tile-viz` is auto-height, the percentage cannot resolve, and the
wrapper falls back to the spacer — verified on `/ts-gallery`, where the span-2 multi-line
tile still renders viewBox exactly `748 704`. So the signed-off geometry is untouched
wherever nothing is stretching the tile.

Scope: `.ts-tile` / `.ts-chartwrap` appear only in the ts layer, `GeneratedTiles` and the
gallery. Dashboards re-checked after this change — 21 `dash-card`s, 4px radius, `display:
block`, zero `.ts-tile` — so this stayed inside the Insights tab.

✅ **RESOLVED — this was recorded here as open and is now done.** svg text scaled with the
viewBox while the HTML axis titles stayed 12px, so ticks and titles drifted apart and two
tiles in one row rendered different text sizes. Fixed by drawing at 1:1; see the next
section.

## Hover on every ts- template (8/20/2026)
`TsTip` + `useTsHover` + `TsPointMarker` in `TsShell.tsx`, `.ts-tip` in `ts.css`.

Every chart template answers a hover the same way: a dark tooltip, the hovered series at
full strength, everything else faded. Verified across all of them:

| template | tooltip | fade | point marker |
|---|---|---|---|
| Single Line | dark | one series | yes |
| Multi-Line | dark | 1 / 0.22 / 0.22 | yes |
| Dual Y-Axis | dark | bars 0.22 | yes (line) |
| Grouped Column, Stacked Bar, Calls by Hour | dark | 1 / 0.22 | no |
| Pie, Donut | dark | 1 / 0.16 | no |

KPI, Metric and the table templates have no hover: there is no data point to hover, and
ThoughtSpot does not put a tooltip on a table cell.

⚠️ **THE TOOLTIP IS `.ind-tip`, COPIED VALUE FOR VALUE — do not restyle it independently.**
`.ts-tip` began as a white two-column panel (key left, value right), which was a guess and
the only tooltip on the tab that did not match the others. `.ind-tip` was measured off the
reference, so `.ts-tip` now takes every value from it: `#2f3a4a`, 4px radius, `12px 16px`
padding, 13px/1.45, and a stacked `label:` / value pair with a 10px gap before the next.
Verified identical: computed style and row weights match character for character on a
dashboard showing both.

⚠️ **`.ind-tip` IS NOT INSIGHTS-ONLY. `DonutChart` renders it, and DonutChart appears on
MarketingDashboard, AiAgentConversionDashboard and LocationComparisonDashboard.** I changed
`.ind-tip-k/-v` believing them inverted and had to revert it: that edit reached three
Dashboards screens, which the one-screen rule forbids. The claim was also weaker than I
stated — the reference screenshots cannot settle 400 vs 600 in white text on a dark panel.
Left as measured, with the reach recorded at the rule. **If it is ever settled, change both
tooltips together.**

**The hovered line thickens by 1px and gets a marker.** `TS_LINE_W + 1` is Highcharts'
`lineWidthPlus` default, and Highcharts is what ThoughtSpot renders. The marker follows
`.ind-trenddot` (series colour, 3px white ring) plus the faint colour halo the reference
screenshots show. `activePoint` was added to `useTsHover` for it, separate from
`activeSeries` so the fade-only charts are untouched.

⚠️ **HOVER TARGETS ON A LINE ARE ONE TRACKER PATH, NOT A CIRCLE PER POINT.** Point-only
targets meant hovering the line BETWEEN two points did nothing — a user had to find a data
point. Each line series now carries an invisible tracker: the same path geometry with a
transparent `TS_TRACKER_W` (14px) stroke and `pointer-events: stroke`, which hit-tests the
stroke region regardless of paint. `onMouseMove` picks the nearest point with
`nearestIndex()` and sets series + point + tooltip. This is Highcharts' `stickyTracking`,
which is what ThoughtSpot renders. Applies to Single Line, Multi-Line and the Dual Y-Axis
line; the column, bar and pie templates keep hovering their own shapes and gained no
tracker.

⚠️ **THE POINTER-TO-DATA CONVERSION IS `e.clientX - svgRect.left`, AND IT IS ONLY THAT
SIMPLE BECAUSE CHARTS ARE DRAWN 1:1** — one user unit is one CSS pixel. Two traps: the
reference must be the SVG's rect, NOT the path's (`getBoundingClientRect` on the path starts
at its leftmost point, and compensating for that by hand was the first, wrong version); and
if the svg ever scales again this needs the viewBox conversion restored. `nearestIndex`
carries the warning.

Verified by probing mid-segment rather than at points: at 15% and 45% between two points the
tooltip reports the earlier one, at 55% and 85% the later one — the crossover sits exactly
at the midpoint — while the hovered series shows strokes `2,3,2` and opacity `0.22,1,0.22`
and the marker appears.

⚠️ **CLICK-TO-SELECT ON A LINE NOW USES `hv.activePoint`,** since there is no per-point
element to carry the index. Correct by construction — `onMouseMove` always sets the point
before a click can land — but UNEXERCISED: no caller passes `onSelect` to a ts- chart yet.
Check it when the interaction drawer is wired to Insights tiles.

⚠️ **VERIFYING HOVER: `computer{action:"hover"}` DOES NOT REACH REACT on these svg children
— it produced no tooltip at a coordinate where `elementFromPoint` returned the hit circle.**
A real `left_click` does (its genuine mouseover fires first), and that is how the behaviour
was confirmed end to end. For a SCREENSHOT of a live hover, note the screenshot action
itself moves the pointer and clears the state; freeze it first by stopping `mouseout` /
`pointerout` in the capture phase, then reload to undo.

## Clicking a datum opens the interactions drawer (8/20/2026)
`DashAssistant` (ts variant) owns the drawer; `TsTileCard` passes `onPick` to every chart.

Every data point on a generated Insights tile opens the same `InteractionsDrawer` the
built-in cards use, and **the top card always links to the call summary**.

⚠️ **`topCallHref` USED TO BE SET ON EXACTLY ONE DRAWER** — the bar chart's first bar —
reasoning that thirty cards opening one transcript under thirty different ids would be a
lie. Requested changed 8/20/2026, and `pinFirst` is what makes it honest: it REPLACES the
top card with the prospect's own `callDetail` record, so the card and the detail page always
agree on id, duration and summary. Verified end to end — drawer card `0597-627F62F2570D`
opens `/insights/call?...` showing the same id, its AI summary, a 19-turn transcript and a
pager matching the drawer's count. All three built-in sites (weekly trend, every bar, the
four donuts) now link too; a non-first bar was checked specifically, since that was the
case with no link before.

⚠️ **THE HEADER COUNTS INTERACTIONS, NOT THE MEASURE — and this is easy to get wrong
because the built-in cards never hit it.** They only ever pass call counts. A ts tile's
clicked series can be money, a percent, a duration or a score, and passing the value
straight through made a revenue click read **"8,907,516 interactions"** with 30 cards. Only
`count` and `flag` measures ARE numbers of calls; everything else uses `interactionsAt()`,
which reads the bucket's own call count from the same window machinery every tile uses.
Verified: clicking Call Count and clicking Revenue in the same week both report 11,415.

The card date comes from the category when it is a `MM/DD/YYYY` bucket and from
`rangeStartIso()` otherwise — a pie slice or a day-of-week column has no date of its own,
which is the same choice the built-in donuts make.

⚠️ **THE DRAWER IS ON THE `ts` VARIANT ONLY.** The same `DashAssistant` renders the
Dashboards tab's generated tiles, which have their own card design and no drawer. Verified
after this change: `/dashboards/marketing` has 21 dash-cards, zero `.idr-root`. The
`/ts-gallery` bench stays inert too — it uses `TsTile` directly and passes no `onSelect`.

## Charts are drawn 1:1 (the whole ts- layer, 8/20/2026)
`useTsBox` in `TsShell.tsx` + `.ts-chartwrap--fill` in `ts.css`.

**Every ts chart's svg viewBox is the container's PIXEL size. It is not a fixed box that
scales.** ThoughtSpot's charts are Highcharts, which always sets the viewBox to the
container's exact pixel size — so the capture's `748 704` WAS its pixel size, and every
constant measured off it (the 68px left inset, the 15px tick offset, the 18px title band,
the 22/5 bars, the axis gaps) is a PIXEL measurement.

⚠️ **THE OLD FIXED-VIEWBOX MODEL MADE THOSE CONSTANTS TRUE AT EXACTLY ONE WIDTH, and it
caused three separate reported or measured defects before it was replaced:**
- a title reserved 18 units where it needed 30, so it landed on its own tick labels and
  across the next axis line
- a multi-line chart could not reach the bottom of its tile
- two tiles in the SAME ROW rendered **16px and 13.5px** tick labels, because each scaled
  by its own width

**Verification, which is the real argument for it.** At each template's own measured canvas
the constants now land exactly:

| pinned canvas | measured | capture |
|---|---|---|
| single line 846x633 | plot top **15**, bottom **579** (=633-54), height **564** | 564 |
| single line 846x633 | plot left **68** (`600` ticks) | 62 for `8K`; 843-62 = **781** |
| grouped column 634.5x449 | bar **22**, gap **5**, rendering at **21.98 real px** | 22 / 5 |

The single-line plot width reads 775 against the capture's 781 for the documented reason:
our specimen's widest tick is `600` (inset 68) where the capture's was `8K` (inset 62).
Content-derived, as designed.

⚠️ **"THE BARS ARE 22" WAS NOT A PIXEL CHECK BEFORE THIS.** It read `getAttribute("width")`,
a viewBox number. In the tile it was measured in, a 634.5-wide viewBox rendered into a 427px
box, so those 22 units were **14.8 real pixels**. Any invariant asserted in viewBox units
only meant something at 1:1. Pin the canvas and assert rendered pixels.

⚠️ **1:1 REQUIRES AN EXPLICIT HEIGHT, because the svg can no longer derive one.** With
`height: auto` the svg's height came from its width through the viewBox; now the viewBox
comes from the box, so the two would size off each other and collapse to zero. Hence
`height: 100%` plus a `padding-top` spacer carrying the template's own measured ratio
(`--ts-ar`, set per chart by `useTsBox`). Both details, and the two wrong attempts that
found them, are recorded at the rule itself in `ts.css`.

⚠️ **AT 1:1 A NARROW TILE RUNS OUT OF ROOM INSTEAD OF SHRINKING.** This is the real cost and
it is handled, not hoped about: a `@container ts-tile (max-width: 700px)` query moves the
legend under the chart, which hands back the 212px it was taking. Measured on a 560px tile:
the chart went 314px -> 526px. It is a CONTAINER query because what matters is how wide
THIS tile is, and two tiles in one row differ. It replaced a viewport media query at the
same 700px, which got exactly the half-width-tile-on-a-wide-screen case wrong.

⚠️ **AND IT IS SCOPED TO `needsWidth`, WHICH IT HAD TO BE.** Unscoped it moved the legend on
the pie, donut and column tiles too — measured, their legends went from 0 to 452/456/480px
below the body top. Those were signed off with a right-hand legend and have no right-hand
axes to make room for. Only a chart with right-hand axes opts in, which today means
multi-line.

**A tile with the legend below is still FULLY used — do not read the gap as dead space.** On
the reported pairing the multi-line chart is 624 tall plus a 32px legend row = 656, exactly
the single-line's 656 svg. The original bug was 114px of nothing; 47px of legend is not the
same thing.

⚠️ **A PRE-EXISTING DEFECT 1:1 EXPOSED, fixed in the same pass.** `TsDualAxis` computed its
column width as `min(TS_COLUMN_W * 4, b.width * 0.55)` — an 88px cap and a 55%-of-band
heuristic predating the measured 22/5 fit rule, never brought in line when `TsColumn` was
corrected. It drew an **88px** column beside the grouped chart's 22px one, in the same
layer, off the same capture. It rendered at 82px on screen before 1:1, so 1:1 did not cause
it. Now uses TsColumn's rule and measures 22.

Scope: `.ts-tile` / `.ts-chartwrap` appear only in the ts layer, `GeneratedTiles` and the
gallery. Dashboards re-verified after this change — 21 `dash-card`s, 4px radius, `display:
block`, 14 svgs, 22 `chart-axis`, 25 `bar-label`s, KPI 48,293, and zero `ts-` elements.

## Build With AI -> "Create Tile with AI" (the question-to-tile drawer)
`src/components/InsightsCreateTileAi.tsx` (`.icta-`) + `src/data/insightsQuestions.ts`.
**Build With AI** on Add Tile opens its OWN drawer there; it used to navigate to
`${DASH}?ask=1`, which threw the SE onto a different screen and into the general Ask
drawer, which EDITS a page rather than creating a tile.

⚠️ **PROVENANCE: SCREENSHOT, NOT CAPTURE.** The HTML supplied with the request was the
earlier Data Display Options capture (byte-identical, 845,047 bytes) with no "Create
Tile with AI" markup in it. So layout and copy are read off the screenshot — 814px
panel, 22px/400 title, 30px/700 hero, the composer well, the 36px send circle — while
every colour, font and radius comes from the measured `--ts-var-*` tokens. Re-measure
from a capture with the drawer OPEN when one exists.
The resting state is deliberately bare (hero + composer only, as the screenshot shows);
the question catalogue sits behind a collapsed "Need ideas?".

**A QUESTION RESOLVES TO A TEMPLATE CHOICE, NOT A DRAWING.** `resolveQuestion` returns
`{template, name, measures, dimensions}` and hands it to `buildTile` — the same function
the Configuration drawer uses — so an AI tile is byte-identical in shape to a hand-built
one and inherits the ts- geometry for free. That is the standing architecture's rule
that answers come from editing the TEMPLATES.

**It is deterministic and local, no model call.** `parseQuestionList` already set the
precedent, but the binding reason is the architecture's "a number never changes once
shown": a per-answer model call returning 34% then 41% for the same question is exactly
what that forbids. Verified: the same question twice produces byte-identical tiles.

⚠️ **Questions are TOKENISED and the catalogue is FILTERED per prospect.** The examples
came from a healthcare account (Facility, Specialty, Medicare, Insurance Type).
`{BOOKING}/{LOCATION}/{CATEGORY}/{PAYMENT}` resolve through `vocabFor`, and
`questionsFor()` then drops any question this prospect's data cannot answer. Measured:
Shady Blinds offers 46/47 under a "Consultations" category, AutoNation offers 46/47
under "Test Drives", and every offered question resolves on both. Offering a chip that
answers "I could not match that" is worse than not offering it.

### The matcher, and four wrong turns it took
Getting phrase -> measure right took four iterations, each of which LOOKED right:
1. **Overlap alone, plus a `?? "Call Count"` fallback.** Every unmatched question became
   a confident Call Count tile: "Appointments by Facility" on a blinds account and
   "purple monkey dishwasher" both produced one. A tile answering a question nobody
   asked is the worst outcome available, because it looks right. Fallback removed;
   the count is used only when a DIMENSION resolved and no measure was named.
2. **Coverage measured on the QUESTION.** Sounded equivalent, was not: questions carry
   words no measure name contains ("volume", "avg", "channel", "hour"), so 15 of 47
   catalogue questions started declining. Coverage is measured on the OPTION.
3. **Rejecting an all-generic overlap.** Refused "Total Call Count" — whose only
   significant word is the generic "call" — against the measure literally named Call
   Count. The rule is narrower: if the question named a SPECIFIC word, the match must
   contain one. "Appointment Conversion Rate" names "appointment", which "Publisher
   Conversion Rate Ranking" lacks, so that similarity is refused.
4. **Plural-only stemming.** "Answer Rate" could not reach the measure "Answered".
   Stem drops a trailing "s", then "ed", then "e", applied to both sides.

Also: parenthetical qualifiers are excluded from the coverage denominator, because
"(Sale Amount)" and "(Seconds)" are not part of what a metric is called — counting them
put "Total Revenue" at 0.41 against "Revenue (Sale Amount)", just under the bar. And a
question naming only a DIMENSION ("Not Completed Reason Breakdown") becomes a count by
that dimension, which is what a pie already is.

### The Insights Ask drawer can create tiles now (it used to refuse)
`InsightsAskDrawer` hardcoded `canCreateTiles: false`, with the reason "this screen
registers its data but does not render GeneratedTiles, so a tile created here would be
stored and never drawn". **That reason expired** the moment `InsightsDashboard` started
rendering `<DashAssistant variant="ts" />`: asked for "Bar chart of Call Count by
Marketing Medium" the assistant answered "This page cannot add new tiles", a refusal
that was correct when written and became a bug when the surface arrived. Now `true`, and
`/insights/` is in `AiAssistantDrawer`'s `canCreateTiles` list too so the top-bar sparkle
can create there as well.
⚠️ **A `create` result must be PLACED, not just described.** The drawer only read
`result.answer`, so a model "create" would have been reported and never rendered — the
silent-success shape this repo keeps hitting. It now calls `addTile` on the page's own
encoded scope key.

**Explicit chart requests take the DETERMINISTIC path** (`resolveQuestion` + `buildTile`,
no model call), gated on `WANTS_TILE` so "how many calls did we get?" is still answered
rather than turned into a tile. Verified live: the exact question from the refusal now
builds a 6-bar column of the prospect's own mediums (cpc, Organic, Bing, Brochure,
Facebook, Instagram) at 22px `#2CBF58` with 0 gridlines.

⚠️ **A NAMED chart type overrides the inferred shape.** "Create a pie chart of Call
Count by Marketing Source" hit the "X by Y" rule and returned a column: the user said
pie. `NAMED_TYPE` wins, except where the question names a surface with its own template
("Calls by Hour"), which says more about the data than "bar" says about the drawing.
⚠️ **The request wrapper must be stripped BEFORE matching, not just before titling.**
Left in, "line" and "chart" count as significant words the measure has to contain, so
"show me a line chart of Call Volume Over Time" matched nothing at all. Stripping it also
gives the tile a clean heading, since the chart type is already visible in the chart.

⚠️ **The catalogue IS the regression test.** Every listed question is one that resolves,
so a matcher change that breaks one shows up immediately. Run
`npx tsx` over `questionsFor` + `resolveQuestion` after touching any of it.

Verified end to end with the drawer: typing "Revenue by Marketing Campaign" resolved to
a Stacked Bar of Revenue (Sale Amount) by Marketing Campaign, and "Add to dashboard"
landed a tile rendering through the ts- layer (22px `#2CBF58` bars, 0 gridlines, no
`.dash-card` leakage).

## ⚠️ INSIGHTS & ANALYTICS IS PHASE 2, AND IT IS NOW ENFORCED (8/24/2026)
The user's constraint: **a demo must be generatable in under five minutes**, so Insights &
Analytics builds AFTER the rest of the platform. Where that actually stands, measured rather
than assumed:

**Insights costs ZERO generation seconds today — better than phase 2.** There is no Insights
engine phase and no Insights schema slice. Every screen on the tab derives at RENDER time from
phase-1 data: the Summary Dashboard, Connect AI, the Details Report screen, all twelve ts-
templates, the tile builder, the three Report column pickers and the dashboards an SE creates.
The phase-1 pool is 18 phases and none of them is an Insights phase. So there is nothing to
defer, and every demo already on disk has the tab.

**The five-minute budget is real and already enforced.** `BUDGET_SECONDS = 300` in
`engine/canary.ts`; the nightly canary times a full generation, sets `overBudget`, and that
feeds `needsAttention` on the PUBLIC `/api/canary`.

⚠️ **BUT IT HAS BEEN BREACHED TWICE IN THE LAST EIGHT RUNS — 389.9s and 300.5s** (live canary,
8/24/2026; latest run 211.5s, prefix 98.3s, slowest phase `opsDashboard`). Research dominates
the serial prefix and swings with site size, so a big multi-page prospect is what puts a run
over. The budget is not a comfortable margin — which is the real argument for keeping Insights
out of phase 1, not a theoretical one.

**MEASURED END TO END 8/24/2026, and the decision holds.** One full generation, timed phase
by phase, profile discarded (`runCanary`, target index 2):

| | |
|---|---|
| total | **151.8s** = 2m32s, **51% of the 300s budget**, 148s of headroom |
| phases | **20** — research + terms + the 18-phase pool. **Zero Insights phases** |
| serial prefix | 67.4s (research 58.6 + terms 8.8), **44% of wall clock** |
| pool | 494.9s of work compressed into 84.4s wall = **5.86x** on CONCURRENCY 6 |
| slowest | `opsDashboard` 70.1s, then callReview 60.2, dashboardChannels 55.5, agentConfig 46.4 |
| audit | 30 checks, **0 failures** |

⚠️ **THE POOL IS WITHIN 2.3% OF OPTIMAL, SO THERE IS NOTHING LEFT TO WIN THERE.** The floor is
`max(longest phase 70.1, work/6 = 82.5) = 82.5s` and it ran in 84.4 — the LPT ordering is doing
its job. Any further speedup has to come from **research** (the serial prefix) or from splitting
`opsDashboard`, the way the Marketing dashboard was already split. Adding an Insights phase to
the pool would cost close to its full duration in wall clock, because the pool is saturated.

**`npm run audit:phases`** (also run by `npm run audit`) is the enforcement, because
"Insights costs nothing" is only true while nobody has added a phase for it, and the standing
architecture below describes a Phase 2 that WILL mint dimensions server-side. The cheapest way
to build that is a thunk in `runPool` beside the other eighteen, and generation then grows on
the critical path of every SE waiting on a demo. Three checks:
1. no Insights & Analytics phase in the phase-1 pool;
2. every pool phase has a `BUILD_STEPS` row in `Launch.tsx` (otherwise its progress is
   invisible on the checklist and its weight is missing from the bar — a trap this file has
   warned about in prose since the checklist was built);
3. `BUDGET_SECONDS` is still <= 300, so nobody relaxes the budget instead of fixing a slow
   phase.

⚠️ **IT MATCHES THE INSIGHTS SURFACE, NOT THE WORD "insights".** Two phase-1 phases contain it
and are legitimately NOT this tab — `digitalInsights` (the Digital Journey report, Reports tab)
and `qmInstantInsights` (a Dashboards-tab dashboard). A naive `/insights/i` fails on both, gets
dismissed as a false alarm, and gets deleted — worse than no check.
⚠️ **It also fails if its own parse breaks** (fewer than 10 phases found, or no `runPool([`),
because a static audit that silently matches nothing reports success forever.
Verified in BOTH directions: passing on the real tree, and actually FIRING on all three broken
shapes — a smuggled `insightsAnalytics` phase, a renamed `BUILD_STEPS` key, and a 600s budget —
with exit code 1 so it can gate a push.

## INSIGHTS & ANALYTICS — the standing architecture (agreed 8/18/2026)
Context for every I&A screen we build. Not yet implemented; this is the contract.

### Two phases
- **Phase 1** = everything the platform already generates (`research -> terms -> an
  18-phase concurrency-6 pool` in `engine/core.ts`). It ends where it does today and
  the SE starts using the platform immediately.
- **Phase 2** = Insights & Analytics, kicked off when Phase 1 SAVES, and it runs
  **SERVER-SIDE against the saved demo**. Not in the browser: closing the tab or
  navigating away must not leave a half-generated tab, it runs ONCE per demo, and a
  colleague opening that demo later finds it finished.
- Opening the tab mid-run shows a PROGRESS BAR; opening it after shows the tab. The
  existing `progress({ phase, status })` callback already feeds a real percentage, so
  the bar reports actual phases rather than a timer.

### The data pool
- I&A derives from the PHASE-1 DATA. It never invents a parallel universe: 10
  campaign sources in the pool means 10 rows on screen, 48,293 calls means 48,293,
  and every filter narrows that same pool.
- **MINT ONCE, THEN REUSE FOREVER.** Phase 2 mints the dimensions the pool lacks
  (measured against a real profile: repeat callers, monologue duration,
  commitment-to-help, words of interest, facility, specialty, transfer rate).
- **MINT ON DEMAND, THEN PERSIST.** When someone later asks for something Phase 2
  did not mint -- "top locations by call volume", say -- generate it THEN, write it
  back, and read it from there ever after. The rule is that a number never changes
  once it has been shown: asking twice, or building a tile from an answer, must agree.
  A per-answer invention that returns 34% and then 41% is the failure this avoids.
- **RE-SKIN EVERY DIMENSION PER INDUSTRY**, the way `bookingTerm` already works.
  "Specialty" is a product line for a retailer and a service type for a plumber;
  "facility" is a showroom or store; "insurance type" is a finance/payment method.
  A blinds company must never show "Medicare".

### Ask AI in this tab
- Creates DASHBOARDS, creates and removes TILES, edits any data (numbers,
  percentages, titles, charts), and answers questions about the data. The four
  standing AI-button rules above apply unchanged -- skeleton, CSS, fonts and colours
  are never editable, and a tile's own button only ever changes that tile.
- **ANSWERS DEFAULT TO A TABLE.** Paragraph, line and pie only when asked for.
- The visualisation TEMPLATES the user supplies are the foundation: new tiles and
  assets are produced by editing those templates, not by inventing a look per answer.

### Open point to settle before building the write-back
Minting on demand WRITES to a saved demo, and demo editing is server-enforced
(creator or admin). An SE asking a question on a colleague's demo cannot write to it.
Planned default unless told otherwise: persist to the demo when the asker may edit it,
otherwise keep the minted dimension in that session's override layer so their view is
still self-consistent, and never silently fail.

## THE FOUR STANDING AI-BUTTON RULES (Dashboards tab + Reports tab)
These are the user's standing rules, not a one-off request. `npm run audit:ai` checks
them statically; it has caught a real regression already, so run it after touching any
dashboard, report, the drawer, the guard or the prompt.

**Rule 1 — presentation is NEVER editable.** CSS, fonts, colours, spacing, and WHICH
KIND of chart a built-in tile is. Structurally true, not just prompted: no data value
reaches a `className` or `style` (the only data-driven classes are boolean toggles
between designed states), and chart type is chosen in JSX. The prompt also declines
restyle and change-the-chart-type requests, verified live.

**Rule 2 — all the DATA is editable.** Numbers, percentages, titles, chart values
("show a massive dip on Jan 5th" -> that series' value at that index), add/remove a
COLUMN, add/remove a TILE, add/remove a chart SERIES, pie SLICE or axis POINT.
- Length used to be blocked because length drives layout. The safety MOVED, it did not
  disappear: `chartFit.ts` (fitValues/fitCells) makes renderers TOTAL, and only then
  does `editGuard`'s LENGTH_IS_CONTENT allow those shapes. **Do not add a pattern to
  that list until the renderer can survive the wrong length.** It stays an allow-list;
  TYPE changes are blocked everywhere, always.
- `fitValues` returns null for an EMPTY series and the caller skips it: a new series
  must not draw a flat line along y=0, which reads as a real measurement of zero.
- Column ops cover BOTH table shapes -- `dimensionColumns`/`cells` (Digital Journey)
  and `metricColumns`/`metrics` (dashboard breakdowns) -- via `resolveTableShape`,
  and take the FOCUSED table's path so a breakdown edits its own columns.
- "Delete a tile" HIDES it (`hidden` per scope key, keyed by tile id) and never
  destroys data, so Undo and "put it back" are free. `HiddenTileStyles` emits one
  `:has()` rule per hidden tile; that is app CSS keyed off app state, not the model
  writing CSS.

**Rule 3 — a tile's own AI button changes ONLY that tile.**
- The tile declares its id/path; `findTilePath` derives it from the page data when a
  screen does not, and REFUSES when a heading is ambiguous rather than guessing.
- A card is not always one subtree: `<stem>Title` siblings (`trendTitle` +
  `trendChip` + `trendChart`) resolve to the sibling GROUP, so focus paths can be a
  LIST. An explicit prop always beats the lookup, and must, wherever two cards share
  a heading but read different data (Product Category table vs its graph).
- `constrainToFocus` ENFORCES it: keep what is inside, remap a same-container
  wrong-index edit onto the focused tile, DROP the rest and say so.
- **When you filter or reorder a list before rendering, keep the original index**
  (`map((b,i)=>({b,i}))`). Building a path from a filtered index is the original bug.

**Rule 4 — the header AI button applies to the whole page.** Scope `dashboard`.

### Traps this cost us, do not re-learn them
- **A self-contradicting prompt is worse than either rule.** Adding "you MAY add
  columns" while leaving "NEVER change the number of rows/series" made the model pick
  the prohibition, and "add a Total Calls column" came back as a plain answer. The
  canary now fails if the old line reappears.
- **Interpolating an array into the prompt.** Widening `path` to `string | string[]`
  told the model its data lived at `"trendTitle,trendChip,trendChart"`; every edit was
  then discarded for being outside the focus.
- **"I couldn't map that change" vs "I refused it."** Reporting confusion when the
  truth is refusal sends the user off rewording a request that was understood.
- **The Reports screens did not render `<DashAssistant />`.** Both "add a tile" and
  hiding were silent no-ops there until it was added.
- **Measure against the profile you rendered.** A coverage figure comparing Shady
  Blinds headings to Big O Tires data read 57/77 when the truth was 68/77.
- **`Lead Form Performance Summary` IS editable** — an earlier note here claiming it
  was not was wrong. It is computed by `deriveLeadFormGroup`, but MarketingDashboard
  FOLDS the derived group into the data it registers (`leadFormSummary`), so edits
  target `leadFormSummary.*`, the override sits on top of the re-derived value, and
  they persist. The claim came from measuring `findTilePath` against the raw profile
  instead of the object the page registers — check the registered data, not the seed.
  Verified live: Lead Form Count 24,867 -> 31,402, and its labels and title too.
- **A card with no `path` uses its HEADING as its tile id.** `data-tile={tileId(path)
  ?? title}` on the head, and the drawer resolves hide targets with the same fallback.
  Both sides must agree or hiding silently does nothing; the canary checks that. This
  is what makes every card hideable without threading a path through ~35 call sites.
- Source-text checks are not runtime checks: `data-tile={tileId(path)}` LOOKS tagged
  but React omits the attribute when no path is passed, so those cards could not be
  hidden while every file read as correct. The fallback above closes it.

## Ask AI: focused edits must land on the focused tile
- **The bug, for the record.** Renaming the "Conversions by Product Category" tile
  with the AI silently failed: the drawer said "Updated the tile title", that tile
  did not change, and "Calls by Region" got renamed instead. Reproduced 6/6 against
  the real endpoint, focused and named alike -- deterministic, not flaky.
- **Cause: render order is not array order.** MarketingDashboard did
  `filter(b => b.hasDonut)` and rendered those first, then the one table-only
  breakdown LAST. So Product Category is 6th on screen but index 4 in the array, and
  index 5 renders 5th. The model reasons about the page as RENDERED, counted the
  tile it could see, and returned `breakdowns.5.title`. It landed on the single tile
  whose screen position disagrees with its index -- i.e. exactly the one being edited.
- **Two things I checked first that were NOT the cause**, so nobody re-checks them:
  the 12,000-char `dataContext` truncation in AiAssistantDrawer (the payload is only
  ~6KB and the title sits at offset ~4,200 in all 20 profiles), and the prompt, which
  explicitly permits editing "a title/label".
- **Fix, in three parts:**
  1. The tile declares its own path. `AssistantFocus.path`, an OPT-IN prop threaded
     `CardHead -> DashTileMenu/DashTileToggle -> DashTileAi`. Tiles that pass nothing
     behave exactly as before.
  2. The prompt is told the path outright ("THIS TILE'S DATA IS AT ... every edit
     path MUST begin with it; do NOT count tiles by screen position"). 4/4 correct
     after, vs 0/6 before.
  3. `constrainToFocus()` in editGuard.ts ENFORCES it, because instructing is not
     guaranteeing: an edit already inside the focused path is kept; a same-container
     wrong-index edit is REMAPPED onto the focused tile when that leaf exists there;
     anything else is DROPPED and the drawer says so rather than reporting a clean
     success. 7 unit tests including the negatives (never invents a key, no-ops
     without a path).
- **Keep the index when you filter.** Any dashboard that reorders or filters an array
  before rendering must carry the original index (`map((b,i)=>({b,i}))`) and pass
  `path={`breakdowns.${i}`}`. Done for MarketingDashboard and
  AiAgentConversionDashboard, which share the layout. A new screen that filters
  without doing this reintroduces the bug silently.

## Verify Labels (Signal AI Studio > Verify Labels)
- `src/screens/VerifyLabels.tsx` + `src/data/verifyCalls.ts`, route
  `/signal/ai-studio/verify/:modelId?label=&name=&round=&p=`. Reached from the
  "Verify Labels" button on a Signal AI Studio row. Real page:
  `/networks/2160/label_groups/manage/verify_calls/532?round=5&folderId=...&callId=...`.
  Only the row whose action IS "Verify Labels" navigates; "Label Calls" is a
  different flow we have not built and stays inert.
- Values MEASURED off a SingleFile save of the live page (8/17/2026). **Two of them
  the screenshot actively misleads about, so do not re-derive either from an image:**
  - The accuracy readout is NOT a percentage bar. Four layers: track `#e7e9eb` r5;
    a darker `#b8bdc5` band covering only 80-100% (radius `0 5 5 0`); a HATCHED
    confidence interval (`repeating-linear-gradient(135deg, rgba(38,102,249,.3)...)`,
    1px `#2666f9`); a 1px point-estimate tick; and a chip labelling the interval.
    Live values: interval 89.7->97.6%, tick 93.5%, chip "90%-98%".
  - **"Save & Next Call" is OUTLINED white** (bg `#fff`, border
    `1px rgba(38,102,249,.5)`, ink `#2666f9`), not the filled primary it looks like.
    "Review Last Call" and "Train AI Model" are the disabled greys
    (bg `#e7e9eb`, border `#d0d3d8`, ink `#a1a7b2`).
- Other measured values: eyebrow `<a>` 12px/700 `#2666f9` **uppercased via CSS**
  (DOM text is mixed case); h1 24px/400; card white `2px #e7e9eb` r3 w468 pad24;
  "Signal Activated" chip bg `#abe5bc` ink `#0d5400` r16; T:/F: and description
  16px/400 `#66708e`; segmented True/False/Not Sure = three JOINED outlined buttons
  ~138x36 with **border-radius 0**, selected bg `#d4e0fe`, 20px icons; Verified
  Calls bar 165x18 (live 47.5%); transcript turn rules 2px r5, **agent `#855ede`,
  caller `#e4126f`**.
- "Predicted by AI" is a bracket over WHICHEVER button the AI chose (the cell is
  `position: relative`), not a fixed label. Bracket = top rule + two 14px end ticks
  + a 10px centre stem in `#5b6577`.
- **THE FIVE CALLS ARE DERIVED, NOT GENERATED.** Slots 1 and 3 are the profile's own
  `reports.callDetail.transcript` and `reports.conversationIntelligence.transcript`
  (real, prospect-specific, and `callDetail` already has this page's exact shape:
  `speaker`/`time`/`text` with `****` redaction). The other three are templates
  filled from `customerName`/`bookingTerm`, plus two fallbacks so a profile missing
  either report still shows five. No engine phase: generation time is unchanged and
  every one of the ~60 saved demos gets the screen. Adding a phase instead would
  have left them all empty until regenerated.
- **The AI is deliberately WRONG on call 4.** If it were right on all five the SE
  clicks True five times, accuracy sits at 100%, and no prospect believes it. Call 4
  is a price shopper using every scheduling phrase and committing to nothing; the AI
  says True, the honest answer is False, and disagreeing visibly drops the interval
  (verified: 82-99% -> 73-99%, back out of the grey target band).
- Accuracy = **how often the human AGREED with the AI**; the human is ground truth,
  so nothing stores a "real" answer. A 95% Wald interval on that rate, which is why
  it narrows as calls are verified. Two deliberate departures: the variance is
  floored so a perfect run still shows a band instead of a zero-width line, and the
  ends clamp to [40, 99] so it cannot draw past the track.
- **"Not Sure" advances but scores nothing** - no T/F, no accuracy move. You cannot
  measure agreement against an answer the reviewer declined to give.
- **"Review Last Call" UN-APPLIES its save** (`Saved` records carry the delta).
  Without that, stepping back and re-saving counts the same call twice and quietly
  inflates the accuracy an SE is standing in front of. Verified round-trip exact.
- **`convStartIndex()` compares SECONDS, never strings.** Real data breaks string
  equality both ways: the Shady Blinds seed has `convStart: "00:00"` and three saved
  demos have `"00:16"` with no turn at exactly that second, so an exact match drew no
  marker at all and did it silently. Index 0 IS a legitimate position (7 of 11
  profiles have a first turn at 00:16, and a marker there says the record began 16s
  before anyone spoke); only `00:00` is vacuous and suppressed. An earlier version
  refused index 0 and so drew nothing on those 7.
- `?p=<profileId>` stamps the owning prospect. **A model belongs to one account**, so
  switching the network selector invalidates the label, name and hashed date: without
  the guard the page showed `consultation_set` over National Van Lines' calls. On
  mismatch it redirects to `/signal/ai-studio`.
- Article agreement matters here: `labelDescription()` picks "a"/"an", or every
  vowel-initial booking term reads "for a estimate" in a sentence a prospect is
  looking straight at.
- CSS trap: hover is written `.vl-seg-btn:not(.vl-seg-btn--on):hover`. As a plain
  `:hover` it ties `--on` on specificity and wins by order, so the selected button
  turned hover-blue under the pointer and read as unselected.
- "Train AI Model" stays disabled with an explanatory `title`, matching the capture.
  Ask AI is scoped to the label and its description only; transcripts are out of
  scope because an edit could contradict the AI prediction shown beside them.

## New Semantic Signal (the library's Activate flow)
- `src/screens/SemanticSignalActivate.tsx`, route
  `/signal/new/semantic/activate?trackerId=146&standardDataFieldName=$.<name>`. The query
  string matches the real page, so the template is identified the way Invoca identifies it
  and a refresh or a pasted link still resolves.
- Values MEASURED off the live page 8/14/2026, not eyeballed: rail 296px, MUI vertical tabs
  48px min-height / 12-16 padding / 16px, selected `#d4e0fe` with a 2px `#2666f9` indicator
  on the RIGHT edge, `text-transform: none`; h1 24px/400; label 16px/700; input 16px,
  padding 6px 8px, radius 3px; Phrases 20px/700; Save `#2666f9` 14px/500. Ink `#15243e`.
  The only value taken from the SCREENSHOT is the small-caps "ADVANCED OPTIONS" divider,
  because the live DOM probe for it matched the TAB, not the section heading.
- **The rail SCROLLS, it does not swap panels.** All three sections render at once and the
  tabs jump to them, which is what the real page does. A tab-panel version looks identical
  on load and is wrong the moment anyone clicks.
- ⚠️ **Smooth scrolling cannot be used on `.main` in this app's browser.** Measured:
  `scrollTo({behavior:"smooth"})` leaves `scrollTop` at 0 while a plain jump to 600 lands
  at 600; setting CSS `scroll-behavior: smooth` then breaks the plain write as well, so
  NOTHING scrolls; a rAF tween is no good either because rAF does not run when the pane is
  not painting. The jump is a plain clamped `scrollTop` assignment. Don't "improve" it.
- ⚠️ **Programmatic `scrollTop` fires no scroll event here**, so testing a scroll-spy by
  assigning `scrollTop` proves nothing. Verify with real clicks or a real wheel gesture.
- The spy listens at `document` with `capture: true` (scroll does not bubble) and resolves
  the scroller on EVERY event: resolving it once in an effect ran before layout settled,
  found nothing scrollable, and silently never attached.
- **The last section is anchored to the bottom of the scroll.** It starts inside the final
  viewport so it can never reach the top, and without that clamp clicking "Advanced
  Options" jumped correctly and the scroll event immediately re-selected "Phrases", which
  reads as the click having failed.
- Phrases are NOT re-skinned per prospect: the stock library is identical in every Invoca
  account (`data/semanticSignals.ts`). The live measurement confirmed all 44 "Ask for
  Appointment" phrases match that file verbatim.
- **Only `captured: true` templates activate.** Today that is exactly the top row (Ask for
  Appointment, Ask for Sale, Competitor Mention); the other twelve carry phrase lists
  AUTHORED IN THIS REPO, and opening a form full of invented Invoca content in front of a
  prospect is worse than a button that declines. Their button is visibly disabled, not
  silently inert. Gated on the FLAG, not a list of names: capture a real list, flip
  `captured: true`, and that card starts working with no component change.
- Note the activation screen costs NO generation time. Its phrases are static template
  data, so the gate is about provenance, not speed.

## Preview Agent: changing the agent's questions (4 ways)
- The Ask AI drawer on `/agent-studio/agent/preview` can change
  `smsPlaybook.qualifyingQuestions` four ways: **one by one**, **paste a list**,
  **import a file**, **or name a use case** and let the assistant rewrite them all.
- **The split is deliberate.** Paste and import are **local, no model call**
  (`src/data/questionImport.ts` -> `parseQuestionList`). The user already typed the exact
  words; sending them through Haiku to be echoed is the same mistake `AssistantColumnOp`
  documents (it paraphrases, reorders, drops the tail). One-by-one and use-case ARE
  judgement, so those go to the assistant.
- `parseQuestionList` handles: numbered/bulleted lists, a `Questions` header line,
  CSV/TSV with or without a header (finds a `question`/`prompt`/`ask` column, honours
  `"quoted, fields"`), a single run-on paragraph split on `?`, dedupe, and a
  `MAX_QUESTIONS` cap that is **reported, never silent**.
- **Preview Workflow has its OWN sparkle**, in the chat drawer's header beside Reset,
  with its own undo. **Both are hidden until the header is hovered** (`.wcp-icon-hover`,
  `focus-within` for the keyboard): Reset and Close are part of the real Invoca widget,
  the sparkle and undo are ours, so at rest the replica matches the capture. They hold
  their layout space and only fade, or the header reflows under the cursor.
- **It opens the drawer on the LEFT** (`side: "left"` on the focus). The chat is on the
  right and the whole point is watching it pick the edit up, so the drawer must not cover
  it: no backdrop (which would dim AND swallow clicks on the chat), `pointer-events` only
  on the panel, and a width of `min(420px, max(300px, calc(100vw - 412px)))` so it yields
  to the 400px chat instead of sliding under it. Verified side by side at 766px. It edits the SMS agent (greeting + questions). The workflow page's
  top-bar sparkle edits the DIAGRAM and nothing else. Two different things, two buttons:
  one button doing both was the confusing version.
- **How a preview's sparkle gets its own scope**: `openDrawer({ scope: "agent", key,
  questionPath, label })`. An `agent` focus CARRIES its scope, and the drawer synthesises
  the active scope from it instead of the page's. That keeps exactly one scope in play per
  opening, so `applyEdits`, the undo stack, the question tools and the model context all
  work unchanged. Do NOT solve this by registering a second scope: `registerScope` is
  last-write-wins and would repoint the page's sparkle away from its own data.
- `registerBase(key, data)` seeds a foreign scope's base WITHOUT making it active.
  `applyEdits` returns 0 for a key with no base, so an SE who opens Preview Workflow
  without ever visiting the Preview Agent tab would make edits that silently did nothing.
  Fills only, never overwrites: the owning page registers a richer object.
- The workflow chat also restarts on a config change (`.wcp-restart`) and uses the shared
  `resolveGreeting`.
- **The tools are OPT-IN via the scope's `questionPath`** (`usePageData(base, { questionPath })`).
  Four screens register `agentConfig` -- Agent Config, AI Recommendations, Knowledge
  Sources and this preview -- so all four have a question list in their data. Gating on
  "the data has questions" would light up three screens nobody asked to change. Verified:
  the tools appear on the preview only.
- **`editGuard` already exempts `qualifyingQuestions`** from the array-length rule
  (`LENGTH_IS_CONTENT`), which is what lets add/remove work here and nowhere else.
- **Assistant-written questions get `stripGeneratedDashes()`** in the drawer before
  `applyEdits`. `engine/chat.ts::stripDashes` only cleans the agent's live replies, so a
  generated question kept its em dash ("stay in touch-text, email, or phone?"). Pasted and
  imported lists are NOT cleaned -- the user's own punctuation stays verbatim.
- The list in the drawer reads from EFFECTIVE data, so it updates live and is the
  confirmation that an edit landed. Undo covers the local paths too.
- **The phone restarts itself when the config changes.** `PhonePreview` compares a
  serialised `brain` across renders; on a change it clears the thread, drops the
  conversation identity (so the chat that already happened stays in the SMS report as
  its own record rather than being overwritten), re-issues the greeting under the new
  config, and flashes `.phone-restart` OUTSIDE the phone frame -- the screen itself has
  to stay a believable iMessage mockup. Serialise the WHOLE brain: the questions live
  under `brain.playbook`, and picking `brain.questions` / `goal` / `bookingType` reads
  as `undefined` for all three, so the signature never changes and nothing restarts.
- **The greeting is editable data too.** `smsPlaybook.greeting` (OPTIONAL in the schema,
  so every existing profile and saved demo still parses). Precedence in `buildSmsBrain`:
  an extra workflow's scripted `openingMessage`, then the stored greeting, then
  `defaultGreeting()` derived from `bookingType` + `offer`. Derived rather than
  engine-generated so nothing needs regenerating; the `offer` goes in VERBATIM as its own
  sentence, because splicing it mid-sentence needs the first letter lowercased and that
  mangles "72 Hour Sale" and brand names. Side effect: the opening line is now identical
  on every run, where the model used to improvise it per load.
- **The greeting addresses the customer by name** via a literal `{name}` token, resolved by
  `resolveGreeting()` in `smsBrain.ts` from `reports.voiceScreenpop.callerName` (falls back
  to "there"). That name is deliberate: the SMS thread and the Voice Screenpop then name the
  SAME customer instead of inventing a second one. The token is STORED, never the resolved
  name, so a demo shown against a different caller still addresses the right person.
  The drawer shows the RESOLVED text (it must match the phone) but sends the RAW token to
  the model, and the prompt forbids a hard-coded first name. One resolver, called by both
  the phone and the drawer, or the two drift on the fallback.
- **Three traps, all hit while building this:**
  1. `editGuard` blocked the FIRST greeting write. `undefined -> string` is a type flip, and
     the field does not exist until someone sets it. Fixed with `CREATABLE_WHEN_ABSENT`
     (narrow, named list). Same shape as the `cells` bug already documented there.
  2. Even unblocked, the model wrote the new greeting to **`brandConversationRules.0`**,
     overwriting a real brand rule, because `smsPlaybook.greeting` was NOT IN THE DATA it
     was shown (it was derived). The drawer now injects the derived greeting into the
     serialised context, so the model edits a field it can actually see. **If a value is
     on screen but not in `dataContext`, the model will write it somewhere else.**
  3. Both failures were SILENT and the model reported success both times. Never trust the
     assistant's prose confirmation; assert against the data or the rendered value.
- **NURTURE = RE-ENGAGEMENT.** Someone who was interested, then went quiet (stopped
  replying, or a rep could not reach them); the agent picks that thread back up, finds
  what stalled it, and still drives to a booking. It is NOT a cold opener and NOT a
  no-booking newsletter. `schema.ts` already said this for the extra nurture workflows
  ("re-engage prospects who went quiet after intake"). Each use-case chip carries a
  `brief` (a paragraph, not the label) because a one-word label lets the model invent
  its own meaning, and `engine/assistant.ts` states the nurture definition too.

## ⚠️⚠️ NOBODY WAS BEING TOLD WHEN FEEDBACK ARRIVED (found and fixed 9/10/2026)

Reported: *"i just realised that all the feature request or feedback are only going to the local
host and not to the live instance, so i am missing them."* The premise turned out to be half
right, and the real cause was worse than a misrouted store.

**MEASURED FIRST, on the live board.** Nothing was lost — the live instance held **24 items
(6 feedback, 18 feature requests), 15 still open**, safe on the Render disk (`feedbackStore`
shares `demoStore`'s `DATA_DIR`, and `/api/status` reports `storage.persistent: true`). Three of
them were **colleagues' feedback sitting In review for over two weeks**.

**Two separate things were going on, and only the second is a defect:**

1. **The two stores ARE separate, and that is by design.** Localhost writes to `<repo>/.data/
   feedback/`, the live site writes to the Render disk, and `.data` is git-ignored so neither
   travels. The 11 items visible locally are hand-submitted test items — dated **before the
   feature shipped**, with fabricated colleague addresses, which is how you can tell.
2. ⚠️⚠️ **THE DEFECT: NOTHING NOTIFIED THE MAINTAINER.** The only mail this app sent was the
   **completion** notice, to the **submitter**. So the sole signal that anything had arrived was
   the Inbox badge on the **live** launch screen — and that badge is **per-instance**. Working on
   localhost it read a reassuring **8 open** from test data while the live board sat at **15**.
   A number that looks like it is working is worse than no number at all.

**The fix: `newItemEmail()` in `mailer.ts`, sent from the POST path.** The maintainer is emailed
the moment an item is submitted, with the title, the full body, who sent it and which page they
were on.

⚠️ **AWAITED, NOT FIRE-AND-FORGET.** A floating promise can be killed by the SIGTERM drain
mid-deploy, which is exactly when a submission is most likely to be the last request through.
`sendMail` never throws and returns its outcome, so awaiting cannot fail the submission — and
the item is `saveFeedback`'d **before** the mail is attempted, so a mail failure can never lose
a report. Both orderings are asserted.

⚠️ **THE SUBMITTER IS EXCLUDED FROM THEIR OWN NOTIFICATION.** The maintainer files most of the
feature requests on this board (16 of the 18 live ones), and an inbox full of your own notes is
the same mistake as the permanent "0" badge: a notification that is usually about nothing trains
you to stop reading it.

⚠️ **`Mail.replyTo` WAS ADDED FOR THIS ONE CASE, and it is load-bearing.** This app sends FROM
the maintainer's own address, so without an explicit Reply-To, hitting Reply on a feedback notice
**mails yourself**. Both transports had it hardcoded (`GMAIL_SENDER || from` in the raw-message
builder, `USER` in nodemailer); both now honour `mail.replyTo`, and the audit checks BOTH — set
in one and not the other, Reply-To silently depends on which route sends.

⚠️ **`adminEmails()` IS EXPORTED FROM `demoApi`, NOT THREADED THROUGH THE HANDLER.** `isAdmin`
is passed IN to `handleFeedbackApi` by both callers, and following that pattern for the address
list would mean `server.ts` AND the `vite.config.ts` twin each passing it — the exact place those
two drift. Both already import `isAdmin` from `demoApi`, so there is no new dependency and one
admin list.

⚠️ **NON-PRODUCTION STILL DOES NOT SEND**, via the existing `isProduction()` guard — verified in
the local log: `[mail] local: not sending to ddesai@invoca.com — "Feature request: …"`. That is
what makes this testable at all without emailing a real colleague from a dev server.

⚠️ **THE NODE-CACHE TRAP BIT AGAIN, and cost the first test.** The vite plugin **dynamically
imports** `engine/feedbackApi.ts`, so the running dev server held the pre-fix module: the item
saved, and **no mail line appeared in the log at all**, which reads exactly like the code not
working. Restart the dev server after editing anything under `engine/` — this file already says
so for `chat.ts`, `analyze.ts`, `core.ts` and `assistant.ts`.

**`audit:app` gained 12 checks** covering the notice: an admin address exists at all, the subject
carries kind + title for both kinds, Reply-To is the submitter, the full body and the board link
are in the mail, title/body/name are HTML-escaped (submission text is user input rendered into
HTML mail), both transports honour `replyTo`, the POST path sends it, the send is awaited, the
submitter is excluded, and the item is saved before the mail is attempted.
⚠️ Five were broken on purpose and each fired: making the send fire-and-forget, dropping the
submitter exclusion, removing `replyTo` from the mail, making the Gmail transport ignore it, and
un-escaping the title.

⚠️ **THE THREE ITEMS THAT WERE WAITING** are recorded here because they are real work, not
demo data: sales language appearing on healthcare demos (wants appointment vocabulary), a
lead-form attribution page wanted for the UK, and a dashboard adjusted to recruiting while the
rest of the demo stayed geared to selling freight. A fourth — a sponsored ad showing a location
the company does not operate in — was **already fixed** by the 9/8 location work and the seven
city keys added 9/9, and is marked Complete.

## Feedback / Support & feature requests
- The launch-menu row is **Support**; inside the modal, the two kinds are
  **Feedback / Support** and **Feature request**. The board splits them into TABS,
  because one is "something is broken" and the other is a backlog: mixed together you
  read past the wrong kind to find the one you came for. Each tab shows its own count
  and how many are still open.
- **Modal**: `src/components/SupportModal.tsx` ("Support"), opened from the **launch menu**
  (see the hamburger section below). Opens a modal rather than routing away: someone has a
  thought about the tool WHILE using it, and making them leave the page is how you get no
  feedback. ⚠️ It is **CONTROLLED** (`{open, onClose}`) and mounted OUTSIDE the menu panel —
  see that section for why it cannot live inside it.
- **Board**: `/feedback` (`src/screens/FeedbackBoard.tsx`), full-page outside the shell,
  because it is about the TOOL, not a prospect's demo.
- **Getting there**: the **Inbox** row in the launch menu, **admin only** (the row is hidden
  otherwise, because the SERVER decides — a non-admin's `?summary=1` carries no `open`, so
  there is nothing to render), with a count of how many are still open. The count is the
  point as much as the row: a passive signal beats a board you forget. It shows nothing at
  zero, because a permanent "0" trains you to stop reading it.
  - ⚠️ **THE COUNT ALSO SITS ON THE CLOSED HAMBURGER** (`.lm-dot`). Folding the Inbox pill
    into a menu would otherwise have destroyed the one property it was built for — a badge
    you notice without opening anything — so the dot survives even though the pill did not.
  - It fetches `GET /api/feedback?summary=1` -> counts only, 79 bytes vs 1.6KB for the full
    list on four items. Rendering a badge must not download everyone's submissions, and
    that gap grows with the backlog.
  ✅ **RESOLVED — its placement is no longer "provisional".** This used to read: "Placement
  is provisional (the alternative was folding it into Support as a split control). It is one
  line in `LaunchCorner`…". It is a menu row now, which is the folding-in that note
  anticipated.
  - The in-form link reads "See all submissions" for an admin and "See what I've sent" for
    everyone else; same summary call decides.
- **Visibility is server-side** (`engine/feedbackApi.ts`): a submitter sees only their own
  items, an admin (`isAdmin`, same list as the demo library) sees all and can change
  status. The list is filtered BEFORE serialising, so someone else's text never reaches a
  browser that shouldn't have it. A client-side filter would be a suggestion.
- **The submitter comes from the SESSION**, never the request body. No name/email fields to
  fill in or spoof, and the completion email always has a real address.
- **Storage**: `engine/feedbackStore.ts`, one JSON per item under `DATA_DIR/feedback/`,
  atomic write, same Render disk as the demos. No database for a handful of items a week.
- **Attachments** (up to 5, 10MB each) land in `DATA_DIR/feedback-files/<id>/`. Uploaded as
  RAW BYTES to `POST /api/feedback/:id/files?name=&type=`, one call per file, after the item
  exists. Not base64 in the JSON: it inflates a third and two screenshots would blow the
  body limit. A failed upload does NOT fail the submission; the names are reported instead.
  - `server.ts` registers `express.raw()` for that path BEFORE `express.json()`, or a PNG
    is rejected as malformed JSON. The Vite dev twin concatenates **Buffers**, never
    strings, which would corrupt every byte above 0x7F.
  - **Serving is the security story.** The stored filename is rebuilt from scratch
    (`safeName`) and resolve-checked, so `../../../server.ts` becomes `2-server.ts` inside
    the item's own directory (verified). Types are an ALLOW-list. Downloads set `nosniff`,
    and only RASTER images are `inline` — **SVG is deliberately served as a download**,
    because an inline SVG on this origin can run script and read the session.
  - Only the submitter can attach; only the submitter or an admin can download.
- **Query params must be DECODED.** `qs()` returning a raw value made `image%2Fpng` fail the
  allow-list, so every image upload 415'd while `name` (decoded separately) looked fine.
  It decodes now, and splits on the FIRST `=` only.
- **Email**: `engine/mailer.ts`, sent FROM your own address TO the submitter's sign-in
  address. TWO routes, tried in order:
  1. **Gmail API** (what is actually used). Invoca's Workspace **blocks app passwords**
     ("The setting you are looking for is not available for your account"), so SMTP was a
     dead end. This reuses the SIGN-IN OAuth client plus a refresh token minted once at
     **`/auth/gmail`** (admin only). That route reuses the EXISTING `/auth/callback`
     redirect URI, distinguished by a `gmail:` state prefix, so nothing new has to be
     registered in the Cloud Console beyond adding the `gmail.send` scope.
     - `access_type=offline` **and** `prompt=consent` are both required. Without the
       prompt Google reuses a prior grant and returns no refresh token at all, which is
       the classic "it worked but there is no token" dead end. The callback says so
       explicitly if it happens.
     - The token is shown ONCE on a page and never written to disk or logged.
     - Access tokens are cached until a minute before expiry; no background refresher.
  2. **SMTP app password**, kept for a tenant that allows them. Chosen over a transactional provider: no
  vendor, no DNS verification, and a reply lands in a real inbox.
  - `SMTP_APP_PASSWORD` is a Google **app password**, not the account password.
  - **Unconfigured is a supported state.** No SMTP vars means the feature works end to end
    and the would-be email is logged. `emailEnabled` is reported by the API so the form
    and the board never PROMISE an email that cannot be sent.
  - Fires only on entering a `TERMINAL` status (currently just `Complete`), and only once:
    `notifiedAt` is stamped on a successful send, so re-saving cannot mail twice. It is NOT
    stamped on a failed send, so an item completed before SMTP existed still notifies later.
  - `sendMail` never throws. A notification failure must not fail the status change that
    triggered it, or the admin sees an error for an item that already saved.
  - The title is user text and goes into HTML email: it is escaped (verified).

### A comment goes out with the "your request is done" email (9/16/2026)
Asked for directly: *"allow me to add a comment when i change status of any Feedback & feature
requests to complete before the email gets send out, and the email includes the comment."*

⚠️⚠️ **MOST OF THIS ALREADY EXISTED AND NOTHING COULD REACH IT.** `PATCH /api/feedback/:id` has
always accepted `note`, the board has always rendered it (`.fbb-note`, "Note: …"), and
`completionEmail` has always included it in BOTH the text and the escaped HTML. What was missing
was any way to WRITE one: the status `<select>` PATCHed `{ status }` alone, so the field was
effectively dead code. So this is a UI change plus a check, not a new field — a second
`completionComment` would have duplicated a path that already works end to end.

⚠️⚠️ **ONE PATCH, WHICH IS THE WHOLE CORRECTNESS ARGUMENT, and it rests on ONE LINE'S POSITION.**
The handler assigns `rec.note` from the body BEFORE the terminal-status block builds the mail, so
the comment and the email are atomic by construction rather than by ordering luck. **Move that
assignment below the block and the feature still looks like it works** — the comment saves, the
board shows it, the status changes — and the email goes out without it, every time, silently.
That is the only way this can break, so `audit:app` pins the order by comparing the two indexes
in the source. Verified: moving it reddens.

⚠️ **`note` IS OMITTED FROM EVERY OTHER STATUS CHANGE.** Sending `note: ""` on a move to "In
progress" would erase a comment somebody had already written. The board sends `{ status }` alone
unless the composer produced something.
⚠️ **AN ALREADY-NOTIFIED ITEM GETS NO COMPOSER.** `notifiedAt` means that person has been told
and no second email will be sent, so offering to write one would promise something that cannot
happen. It saves straight through instead.
⚠️ **THE COMPOSER'S COPY HONOURS `emailEnabled`, ALL THREE LINES OF IT** — the label, the button
and the hint. The first version branched the label and the button and left the hint saying "Leave
it blank to send the email without a comment", directly under a label that had just explained
email is not configured. Two lines contradicting each other on any server without a mailer,
caught by reading the rendered panel rather than by a type.
⚠️ Optional, and it says so; an empty note simply omits that line, which the mail builder already
handled. Escape closes the composer, Cancel leaves the status untouched (the `<select>` is
controlled by item state, so it snaps back).
⚠️ Its own `.fbb-say-*` prefix rather than the submit modal's `.fb-*` — different surface, and
one prefix per screen is what stops a change to one restyling the other.

**`npm run audit:app` gained 8 checks**; three were broken on purpose and each fired: moving the
note assignment after the mail, sending `note: ""` on any change, and offering the composer on an
already-notified item.

**Verified end to end in the real UI**, against the production entry point with `local@dev`
granted admin through the additive `DEMO_ADMIN_EMAILS` env var (no code edit, per the note on the
admin list): picking Complete opened the composer without saving, the `<select>` still read "New",
typing a comment and clicking through stored `status: Complete` with the note on the record, the
card then rendered it, and the toast reported honestly — *"Marked complete, but the email did not
send (local does not send email)"*. `completionEmail` was called with the note; both bodies carry
it and a blank note omits the line. ⚠️ The test item was restored to `New` with its note and
history cleared afterwards.

## One hamburger, top right: the launch menu (9/10/2026)

Asked for directly: *"the buttons on the bottom [are] good, but there are more things that i
want to add so i dont want multiple buttons on the bottom, so lets do a Hamburger Menu with
these on the top right."* `src/components/LaunchMenu.tsx` + `.lm-*`.

Three floating pills in `.corner-stack` (bottom right) became one 42px hamburger at
`top: 18px; right: 22px`, holding **Support**, **Inbox** (admin) and **Read.Me**.

⚠️ **ADDING AN ITEM IS ONE ENTRY IN `items`, WHICH IS THE POINT OF THE COMPONENT.** Every row
goes through `activate()` and picks its behaviour from which field it sets — `href` (new tab),
`to` (in-app navigation), or `onSelect` (anything else) — plus optional `hint`, `badge` and
`hidden`. **Do not add a second bespoke button beside the hamburger**; that is what this
replaced, and the request was explicitly about not accumulating buttons.

⚠️⚠️ **THE SUPPORT MODAL CANNOT LIVE INSIDE THE PANEL, and this is the trap the design is
shaped around.** Selecting a row closes the menu, which unmounts the panel — so a modal
rendered inside it is destroyed by the very click that asked for it. `FeedbackButton` was
therefore split: it is now `SupportModal`, **controlled** via `{open, onClose}`, with the
open state held by `LaunchMenu` and the modal rendered as a **SIBLING** of the panel.
⚠️ `ReadmeButton.tsx` and `InboxButton.tsx` are **DELETED**, not left unmounted, and
`FeedbackButton.tsx` was `git mv`'d to `SupportModal.tsx` — the name would otherwise describe
a component that is no longer a button.

⚠️ **THE INBOX COUNT SURVIVES ON THE CLOSED HAMBURGER** (`.lm-dot`, hidden while the menu is
open where the row states it better). The old Inbox pill's whole argument was that a count in
the corner is a passive signal you notice; folding it into a menu would have quietly destroyed
that, so the dot is what keeps the feature's reason for existing.

⚠️ **POINTERDOWN IN THE CAPTURE PHASE, NOT BUBBLE.** On bubble, clicking the hamburger while
open closes the panel in the document handler and then immediately reopens it in the button's
own `onClick`, so the trigger can never dismiss its own menu. This repo already documents the
identical trap twice — the Signal sidebar flyout and the Create-Workflow channel combobox
(where it silently ate the option click). Verified with real pointer sequences rather than
`el.click()`, which skips the phase entirely.

⚠️ **ARROW KEYS MOVE THROUGH THE ROWS.** A pointer-only menu is unreachable from the keyboard,
the same reason the Reorder list grew arrow support. Rows are real `<button role="menuitem">`s
so Enter/Space are native; Escape closes.

**CSS: `.lm-*`, its own prefix, z-1000.** Above the launch form, below `.fb-overlay` (1400) so
the Support modal covers it, far below `.envbadge` (4000) which must never be hidden.
⚠️ **THE FOUR DEAD RULE SETS WERE DELETED (`.corner-stack`, `.readme-fab`, `.fb-fab`,
`.inbox-fab`/`.inbox-n`) AND THE BLAST RADIUS WAS MEASURED**, because a component rebuild in
this repo once deleted another screen's entire stylesheet as collateral (79 `.cd-*` rules,
concealed by a plausible-looking diffstat). Rule counts per prefix, before → after:
`corner 1→0`, `readme 4→0`, `inbox 5→0`, `fb 49→45` (the four `.fb-fab*` rules; all 45 modal
rules intact), **101 other prefixes unchanged**. Two orphaned comment blocks describing the
deleted Read.Me pill went with them.

**Verified in the browser with real pointer sequences:** hamburger at 18/22 (42×42) with the
count dot; the panel opens 288px wide inside the viewport; the toggle CLOSES it rather than
reopening; outside-click and Escape close; arrow keys walk Support → Inbox → Support; Support
closes the menu and opens a modal that is **still open 700ms later**; Read.Me calls
`window.open("/readme.html", "_blank", "noopener,noreferrer")`; Inbox navigates to `/feedback`
(where the menu still renders, since it is in `MENU_ON`). Route gating re-checked on five
replica screens — `/dashboards/marketing`, `/call-review`, `/agent-studio`, `/reports`,
`/signal` — all render **zero** `.lm-toggle` and zero stray fabs. At 375×812 the panel clamps
to `calc(100vw - 28px)` with no horizontal page scroll.
⚠️ **STALE HMR ERRORS IN THE CONSOLE LOOKED LIKE A BROKEN BUILD and were not.** After deleting
the three components the console kept reporting `Failed to reload /src/components/
FeedbackButton.tsx` and `InboxButton is not defined` — through a dev-server restart AND a hard
reload, because that buffer is session-level and is not cleared per page load. The **network
log settled it**: this load requests `SupportModal.tsx` → 200 and never requests any of the
three deleted files. **Check the network log, not the console buffer, when an error names a
file that no longer exists.**

## Release notes, backfilled to the first commit (9/10/2026)

Asked for straight after the hamburger: *"is there a way to add release notes as well from the
very beginning"*. `/release-notes` (`src/screens/ReleaseNotes.tsx`, `.rn-*`) rendering
`src/data/releaseNotes.ts`, reached from the launch menu's **What's new** row.

**27 dated entries, 87 changes (55 new / 24 improved / 8 fixed), 2026-07-23 to 2026-09-10.**

⚠️ **DATED, NOT VERSIONED, AND THE PAGE SAYS SO.** A push to `main` IS the release here, so
there is no version to be on — the subtitle states that outright, because an SE asking "am I on
the latest?" deserves an answer rather than a number that means nothing.

⚠️⚠️ **CURATED FROM GIT HISTORY, AND GENERATING IT FROM COMMITS WAS CONSIDERED AND REJECTED.**
All 284 commits were read and grouped by date. The commit subjects in this repo are unusually
outcome-shaped, which is what made a *faithful* backfill possible rather than an invented one —
but a generated changelog would still print "Record two deploy findings from shipping the
drain", which is a true subject and useless to an SE. So anything invisible to someone USING the
tool is deliberately absent: refactors, captures, audit scripts, documentation, and the many
"record why X" commits. **This is not a changelog of the repository.**
⚠️ **THE PROVENANCE IS ON SCREEN, not only in a code comment** — a footnote says the pre-September
entries were reconstructed afterwards. A tidy list of 27 dated releases otherwise reads as
having been written as the work happened, and the early weeks are genuinely coarser (late July
shipped in bursts of twenty small commits a day, so those are summarised at the feature level).

⚠️ **ADDING AN ENTRY IS PART OF SHIPPING A USER-VISIBLE CHANGE** — at the TOP of `RELEASES`.
Nothing enforces the habit; a curated file rots the moment it stops being updated in the same
commit as the work.

### ⚠️⚠️ PRODUCT-WIDE ONLY — NOTHING PROSPECT-SPECIFIC (9/10/2026)
Asked for directly, against the first draft: *"only add items that apply to the whole product,
not anything that is prospect specific like the 'Orlando Health's ER Messaging'."* An entry has
to be true for anyone using the tool, whichever demo they open. The **capability** belongs here
("a demo can carry extra agent workflows"); the **instance** built on one demo does not.

⚠️⚠️ **"NOT PROSPECT-SPECIFIC" IS NOT THE SAME AS "DOES NOT NAME A PROSPECT", and that gap is
where the real work was.** A name scan found **5** offending entries. Three more had to come out
that **named nobody and were still scoped to one demo**, which no static check can see:
| pulled | why it was not product-wide |
|---|---|
| the AI Conversion by Location dashboard | gated to a single prospect, by its own design |
| Signal AI Silver/Gold, on its 8/24 entry | shipped for ONE account that day — it legitimately earned an entry on 8/27, when it became derived for every prospect |
| a second SMS workflow on one demo | an instance of the extra-workflow capability, which already has its own entry |

Two entries were **reframed rather than deleted**, because the capability underneath them is
real: the Dallas roster became "demos can be filed under an event of their own" (the launch-screen
capability, which is what changed for everyone), and "extra workflows, starting with <a prospect>'s
nurture agent" became "a demo can carry extra agent workflows beyond the built-in pair". Net
92 → **87 changes**; the day that led with a single prospect's workflows was retitled around the
product changes that shipped beside them.

**The rule to apply when writing one: ask what an SE on a DIFFERENT demo would see.** Not whether
a name appears in the sentence.

⚠️ **`audit:app` ENFORCES THE NAME HALF AND CANNOT ENFORCE THE SCOPE HALF, and it says so.** It
scans every title and change against the `customerName` of every profile in `src/data/generated`
and `engine/event-seeds` plus every demo in `.data/demos` — **derived, not a hardcoded list**, so
a prospect generated next month is covered without touching the check (80 names today). Verified
to fire on two different names. The scope judgement is on whoever writes the entry, which is why
it is stated in the data file's own header where the next entry gets written.

⚠️⚠️ **`RELEASES[0]` IS ASSUMED TO BE THE NEWEST, and that assumption is the feature's quiet
failure mode.** `LATEST_RELEASE` and the "New" chip are both derived from it, so an entry added
in the wrong place leaves the chip either never firing again or firing forever, with nothing on
screen to notice. `audit:app` asserts the list is **strictly** newest-first.

### One dot, two signals, and they cannot collide
The hamburger already carried the admin's open-feedback count. Unread release notes needed a
signal too, and two badges on one 42px button is how a number starts meaning two things.
- a **NUMBER** always means open feedback items, and only an admin ever has those;
- a **PLAIN dot** means unread notes, shown only when there is no count to contradict it.

So each person gets the signal that is actually theirs: the admin their inbox, everyone else the
thing that was just shipped to them. Both hide while the menu is open, where each row states its
own. The row additionally carries a **"New"** chip (`tag` on a `MenuItem` — a word where a count
would mean nothing), cleared by opening the page, so it is "unread" rather than decoration.
⚠️ **`unseen` IS RE-READ ON EVERY OPEN, not once at mount.** `/release-notes` is in `MENU_ON`, so
the menu stays mounted while you navigate there and back — a value computed at mount would still
say "New" after you had just read them.
⚠️ **EVERY localStorage ACCESS IS TRY/CAUGHT and the failure answers NO.** It throws outright in
some contexts, and this runs on the launch screen, the first thing anyone opens; an unguarded read
would take the page down to decide whether to draw a two-word chip. A chip that cannot be
dismissed is worse than one that never appears, because it stops meaning anything.

**`npm run audit:app` is 37 checks** and covers our own chrome rather than a replica: the notes
are non-empty, dates valid, unique and strictly newest-first, `LATEST_RELEASE` really is the
newest, every entry has a title and changes, every change a valid kind and text, `unseenRelease()`
survives having no localStorage, and — pinning the actual ask — **the oldest entry equals the
repo's first commit**, so trimming the list to "the recent stuff" cannot silently rewrite what the
page claims to be (skipped where git is unavailable rather than failing for the wrong reason).
Plus the menu: all four rows present, both routes registered AND in `MENU_ON`, the gate still an
allow-list, `SupportModal` controlled and **structurally outside the panel**, capture-phase
pointerdown, Escape and arrows, no CSS left for the three replaced pills, the z-order
(menu 1000 < support overlay 1400 < env badge 4000) read from the stylesheet, and the replaced
components gone from disk rather than merely unmounted.
⚠️ Five were broken on purpose and each fired: swapping two entries out of order (2 red), deleting
the first-commit entry, putting the outside-click back on the bubble phase, removing the
release-notes row, and dropping `/release-notes` from `MENU_ON`.

**Verified in the browser:** the row shows "New" on a fresh profile, the page renders 27 releases
and 87 changes with the kind chips at a uniform 70px so the sentences align, the chip is gone
after reading, and the back link returns to `/launch`. The non-admin branch was exercised by
suppressing the summary fetch: no numeric dot, a 10×10 plain dot, and the Inbox row hidden
(three rows instead of four). No horizontal scroll; at 640px the chips stack above their text
rather than leaving ~150px for the sentence.

## AI SMS Conversation Intelligence's Marketing Data card now carries real attribution (9/11/2026)
Asked for directly, against the selected `.sci-info-card`: *"add all the marketing data for this
SMS Info, like all the data that you have added to the salesforce lead."* Before this the card
had two generic fields (Destination Time Zone, SMS Session Status); it now carries the same
eleven attribution fields the Salesforce Lead record's "Invoca Captured Attribution" section
shows — same labels, same order, same derivation.

⚠️⚠️ **DERIVED, REUSING `salesforceLeadDetail.ts` RATHER THAN A SECOND, INDEPENDENT COPY OF THE
SAME LOGIC.** `smsInfoAttribution(profile, callerName)` (new, in that file) exports
`lineOfBusiness` and reuses `categoryRows` / `strongLexical` / `categoryFor` / `offerFromCall` —
the exact functions the Lead page's own attribution runs through — so the two screens are
structurally incapable of computing two different answers for the same inputs. This is the same
"one digitalInsights row taken whole" principle the Lead page's own header already states,
applied a second time rather than re-derived.

⚠️⚠️ **WHEN THE CALLER IS SOMEONE `salesforceLeads.ts` ALREADY NAMES, THIS IS LITERALLY THAT
PERSON'S OWN LEAD RECORD, NOT A LOOK-ALIKE — and getting this right took two passes.**
`salesforceLeadDetail(profile, leadSlug(first, last))` is called directly for a caller who
matches a real Lead, so the two screens share their numbers by construction rather than by two
derivations happening to agree.
- **First pass matched only `smsScreenpop.callerName`, and it silently never fired.**
  Verified on Shady Blinds: the seeded ACTIVE SMS conversation's caller is "Jessica Harper" —
  but `smsScreenpop.callerName` on that profile is **"Marcus Bell"**; Jessica Harper is
  `voiceScreenpop.callerName`. `salesforceLeads.ts`'s own header already documents that a
  profile's named callers are scattered across FOUR sources (voice screen-pop, SMS screen-pop,
  voice CI, SMS CI) — checking only one of them missed exactly the case that mattered on the
  very first profile tested. Fixed to check both screen-pops' caller names.
- **Second, unrelated bug in the same pass: matched against `info.displayName`, which is NOT
  the caller's full name.** The engine invents `displayName` and `firstName`/`lastName`
  independently ("J Harper" vs. "Jessica" + "Harper"), so comparing `displayName` against
  `smsScreenpop.callerName` ("Jessica Harper") could never equal it even once the screen-pop
  check was widened. Fixed to compare `` `${info.firstName} ${info.lastName}` `` instead.
  ⚠️ **Neither bug was caught by a type or a build** — both were found by reading the rendered
  page against that same caller's own Lead record and noticing the numbers disagreed, which is
  the whole failure mode this feature exists to prevent. Verified after both fixes: Shady
  Blinds' Jessica Harper reads Product of Interest "motorized shades", Marketing Campaign "The
  Privacy Project", Marketing Search Terms "traditional colonial window shutters" on BOTH
  screens, character for character.

⚠️ **EVERY OTHER CALLER (an inactive shell, or a name neither screen-pop mentions) falls back
to the SAME functions with a stable hash of that caller's own name** — still one coherent
`digitalInsights` row, still the real category-matching order, still the recovered-or-blank
promotion — just not claiming to be a specific person's CRM record. Verified on Orlando Health
with a non-matching caller ("Jennifer Martinez"): the card renders a fully internally-coherent
row (Line of Business "Healthcare", Product Category "Cancer Institute" agreeing with Product
Name "Cancer Treatment", Marketing Source "Social Media" agreeing with Medium "Facebook" and a
calling-page URL whose own `utm_source`/`utm_medium` match both), with no crash and no blank
card.
⚠️ **A KNOWN, ACCEPTED LIMIT: the fallback's product is not necessarily what THIS transcript is
about.** Jennifer Martinez's transcript is about scheduling a mammogram; her card's Product of
Interest reads "cancer treatment" (a stable pick off Orlando Health's own `smsScreenpop.products`
list, not the transcript). Fixing this would need parsing the transcript itself for a topic,
which no other field on this screen does either — the existing signals/key points are already
independent of a structured "topic" field. Flagged rather than papered over with a heuristic.

`products` and `productList` were exported from `salesforceLeads.ts` (previously private) so
`smsInfoAttribution` can pick a product for a caller with no Lead of their own, using the exact
same comma-split every real lead's product already goes through.

No new CSS: `.sci-info-card` / `.sci-info-grid` are plain auto-sized flex/grid with no fixed
height, so a card growing from 2 fields to 13 needed no layout change — verified by screenshot.

Verified: `npm run audit:leaddetail` (15 profiles) and `npm run audit:leads` (15 profiles) both
green — this reuses their functions but touches none of their own logic — and `tsc -b` clean.

## The dashboard header's own AI sparkle removed — one was already enough (9/11/2026)
Asked for directly, against the selected `.dash-ai-header` sparkle in a dashboard's
`title-actions` row: "Remove this AI icon as there is already one at the top of page."

TopBar's own hover-revealed sparkle (`.tb-ai`) already opens the same Ask AI drawer on every
page, dashboards included, so the header's copy was a second entry point to the identical
feature, not a second capability. Removed from `DashHeaderActions.tsx` (the `openDrawer`
destructure went with it, since nothing else used it) and its now-dead `.dash-ai-header` CSS
rule from `app.css`. The **per-tile** sparkles (`DashTileAi`/`.dash-tile-actions`) are
unrelated — they scope an edit to one tile rather than the whole page — and are untouched.

Verified: `npm run typecheck` clean, `npm run audit:ai` green (nothing asserted the removed
icon's presence), and live on Orlando Health's Marketing Performance dashboard — the header
sparkle is gone, TopBar's own "Ask AI about this page" button still opens the drawer.

## Every "Ask AI" surface now runs the voice workflow's director treatment (9/11/2026)
Asked for directly, in the same message as the icon removal above: "for all the Ask AI,
become a lot more robust, basically all the Ask AI on the platform should be just as robust
as however you set up the Ask AI for the Voice Agent."

⚠️⚠️ **INVESTIGATED FIRST, AND THE FINDING SHAPED THE WHOLE CHANGE: BOTH TIERS ALREADY LIVED
IN ONE FUNCTION.** `engine/assistant.ts`'s `askAssistant()` already served every "Ask AI"
surface platform-wide from one entry point, gated by a single boolean —
`isVoiceAgentPage(dataContext) = /"agent"\s*:/.test(dataContext)` — that chose between a
fast, cheap Haiku path (every other page) and a strong, streamed Opus path with adaptive
thinking and `effort:"high"` (the voice workflow only). The frontend (`AiAssistantDrawer.tsx`)
and both server endpoint twins (`server.ts`, `vite.config.ts`) already branched generically
on a `stream` flag, so the progress-bar UI already existed and needed no new component. So
this was never a rewrite — it was widening which requests take the strong path, and rewriting
the prompt language that had been written specifically to restrain a WEAK model.

**What changed, concretely:**
1. **`isVoiceAgentPage()` no longer gates the model, effort or transport** — only the removed
   `FAST_MODEL` (Haiku) path did that, and it is deleted. `DIRECTOR_MODEL` is renamed `MODEL`
   (it is no longer one page's special case) and every request now runs Opus 5 with
   `thinking: {type:"adaptive", display:"summarized"}` and `output_config.effort:"high"`,
   streamed via `client.messages.stream()`.
2. **`isVoiceAgentPage()` still exists**, narrowed to what it always should have meant: whether
   `buildSystem()` splices in the voice-specific brief (`agent.greeting`, `informSteps`,
   `serviceZips`, the voice list, …). Those fields genuinely do not exist on a page whose data
   carries no `agent` key, and naming them anyway is the documented failure mode ("naming a
   field that is not in the model's data is how it invents a path and writes the edit
   somewhere else" — the exact bug recorded at the SMS greeting).
3. **The generic "HARD RULES" section was rewritten out of its hedged, refusal-heavy form**,
   for the same reason the director brief itself was rewritten on 9/3: `editGuard` already
   makes CSS/layout/chart-type edits structurally impossible (no data value reaches a
   `className` or `style`, chart type is chosen in JSX, `editGuard` drops a type flip or
   structural change regardless of what the model returns), so repeating "YOU MAY NEVER X,
   DECLINE via answer" for something the code already prevents reads as a weak model being
   managed — and it had previously self-contradicted the capability line beside it (asked to
   add a column, the model read the old prohibition and refused). The rules now say what IS
   wired up, once, and trust the guard for the rest.
4. **Both frontend drawers (`AiAssistantDrawer.tsx`, `InsightsAskDrawer.tsx`) always request
   the stream now** — `wantsStream` was a test of the page's data shape matching the old
   Haiku/Opus split; with one path for every page, that test would have silently left some
   pages showing no progress bar for a 15-25s wait. `InsightsAskDrawer` gained the same SSE
   reader `AiAssistantDrawer` already had (it had none before, only a static "Thinking…").

⚠️⚠️ **THE COST/LATENCY TRADEOFF IS REAL AND STATED, NOT HIDDEN.** A one-line dashboard edit
that used to answer in ~2-3s on Haiku now takes the same 15-25s the voice page always has,
and costs Opus-tier tokens instead of Haiku's. Chosen deliberately over keeping the split,
because the split's failure mode was invisible: a Haiku answer to a multi-part instruction
looks like a normal, if partial, success, and only a careful SE comparing the request against
what actually changed ever notices the gap. Every request streams with a real progress bar
precisely so the new wait is never a silent spinner.

⚠️ **`scripts/audit-ai-rules.ts`'s "THE VOICE AGENT DIRECTOR" section was rewritten, not
just relaxed** — its dozen checks assumed the two-tier split and asserted the fast path
existed, which is now backwards. The rewritten section asserts the opposite invariant: no
`FAST_MODEL`/`if (!director)` path exists at all, `isVoiceAgentPage` is still called (scoping
prompt content only), adaptive thinking and `effort:"high"` are unconditional, both drawers
always request the stream, and a dropped stream still fails loudly rather than reading as a
silent success. Two of the new checks were wrong on the first pass and are the record of it:
the `effort` check matched this very section's own header prose (`` `effort:"high"` `` with no
space, versus the real code's `effort: "high"` with one) until anchored to require the space,
and the `InsightsAskDrawer` stream check matched an unrelated `dec.decode(value, {stream:
true})` TextDecoder option until anchored to the request body's `canCreateTiles: true,\nstream:
true,` pair. Both were caught by deliberately sabotaging the real code and confirming the
check still passed — a check that cannot fail is worse than none, the same lesson this file
has recorded from several other probes.

Verified: `npm run typecheck` clean, `npx tsx scripts/audit-ai-rules.ts` green with every check
in the rewritten section confirmed to FIRE by sabotaging the corresponding code (reintroducing
`FAST_MODEL`, dropping `effort:"high"`, reverting either drawer's stream flag) and reverting.
`npm run audit` unaffected — its only failures are the pre-existing generated-profile-data
issues this file already tracks (signal tier pairs, conversion-story ordering on a handful of
demos), unchanged by this work. Live in the browser: asking the Marketing Performance
dashboard's Ask AI (Orlando Health) to "Bump Call Count to 9500 and Total Revenue to
$2,000,000" showed "Sending to Claude Opus" and a live progress bar — the voice page's exact
UI — then landed both edits, and the model additionally flagged (in "answer") that the
breakdown tables still summed to the old total and offered to reconcile them, which is the
kind of coordinated, multi-part reasoning a Haiku answer would not have caught.

## Local Services Ads on the Google Search screen (9/12/2026)
Asked for first with a screenshot — a real LSA unit ("Sponsored Plumbers | Duluth", two rows,
each with a rating/review count/years-in-business/status line and Get quote / Book online / Get
phone number actions), "build 2 rows of LSA before the first marketing campaign similar to this
page" — then rebuilt against a SingleFile **capture** of the same unit (see the next block).
`GoogleSearch.tsx` (`.gs-lsa-*` in `standalone.css`), inserted between the location chip and the
first `Sponsored Results` heading (the text-ad block). It is Google's OTHER paid unit: the one
that runs above the text ads for local trade categories.

⚠️⚠️ **THE PROSPECT LEADS IT, AND THE SECOND ROW IS A RIVAL THE SCREEN ALREADY BUILT** — not
a third set of invented names. `rivals[0]` and its rating (`d.places[1].rating`) already exist
for the local pack; the LSA rows reuse them rather than inventing a disagreeing figure.

⚠️⚠️ **THE HEADER NOUN IS A TRADE-PROFESSIONAL PLURAL, NOT `d.seg`.** `d.seg` is a
product/category noun built for the ad copy elsewhere on this screen ("Window Treatments",
"Vision Care") and reads wrong as "Sponsored Window Treatmentss | Duluth" — wrong word class
and wrong pluralisation. `providerNoun()` is a keyword table over `profile.industry` (the same
shape as `vocabFor` in `insightsCatalog.ts`), with a generic `${seg} Providers` fallback so a
vertical not in the table still reads as a real category. Verified across three very different
verticals: Shady Blinds → "Window Treatment Companies", Orlando Health → "Doctors", AutoNation
→ "Auto Repair Shops" — all correct, all in Santa Barbara / Orlando / Miami respectively.

### ⚠️⚠️ REBUILT FROM A REAL CAPTURE THE SAME DAY, AND THE SCREENSHOT VERSION WAS WRONG SIX WAYS
The first pass was authored from the screenshot, reusing PlaceRow's classes on the reasoning
that it was "structurally the same kind of row". A SingleFile capture of the real unit arrived
an hour later (`reference/google-search/lsa-v1.html`) — "make sure it matches perfectly, CSS,
the Icons, alignment" — and measuring it the way the rest of this screen was measured found six
things a picture cannot settle. **Every one is now a measured value**, listed in full at the
`.gs-lsa-*` rules:

| | screenshot pass | measured |
|---|---|---|
| heading | 16px, borrowed `.gs-spons-head` **with its underline** | **20px** Google Sans, **no underline** |
| name | 18px Google Sans (`.gs-place-name`) | **20px/24px Roboto** |
| secondary text | `--gs-2` `#9e9e9e` | **`#bfbfbf`** — the unit's own grey, neither `--gs-2` nor `--gs-mut` |
| status line | whole line green | **only the leading phrase** is `#6dd58c`; the `·` and badge are `#bfbfbf` |
| thumbnail | 64x64 | **92x92**, radius 8 |
| "Show more" | a standalone pill | a **372x40 pill centred ON a full-width 1px rule** |

⚠️⚠️ **THE STATUS-LINE COLOUR IS THE ONE WORTH REMEMBERING.** A screenshot reads
"Open 24 hours · Emergency heating services" as one green line, and it is not: the capture's
DOM nests the leading phrase in its own span at `#6dd58c` while the separator and badge stay
`#bfbfbf` — exactly the split `.gs-place-hours b` already does one section down. Colour that a
human eye reads off a JPEG is a guess; the computed style is not.

⚠️ **AND IT NO LONGER REUSES PlaceRow's CLASSES.** Once measured, `.gs-place-name` (18px Google
Sans) and `.gs-place-stars` were simply different values, so sharing them would have meant
either wrong type here or editing classes another section is signed off on — the "a change for
one screen stays on that screen" rule. The LSA unit has its own `.gs-lsa-*` set throughout.

⚠️ **THE ICONS ARE GOOGLE'S OWN, EXTRACTED VERBATIM** (`LSA_P` in `GoogleSearch.tsx`), per the
standing use-the-real-icons rule: filled 24x24 Material paths for the quote bubble, calendar,
phone, the `more_vert` kebab and the `expand_more` chevron. ⚠️ **They are deliberately NOT the
thin stroke glyphs `P` holds** — that set exists because the filled icons read too heavy for
this page's CHROME, whereas the LSA unit's icons genuinely ARE the filled set at
`fill: #a8c7fa`. Rendered with `<Icon fill />`, which the component already supported.

⚠️ **THE STARS ARE A PARTIAL-FILL GRADIENT, because the real ones are.** The capture draws a
68x11 bar with `linear-gradient(to right, #fdd663 …, #80868b …)`, which is how a 4.7 shows a
partially filled last star. Reproduced with this page's own glyphs plus `background-clip: text`
driven by a `--fill` custom property computed from the rating — with the colour set on the
element first and only made transparent inside an `@supports` guard, or a browser without
`background-clip: text` would render five invisible stars.

⚠️ **THE ACTION SET VARIES PER ROW ON PURPOSE.** The capture's first row carries two buttons and
its second three; that unevenness is part of how the real unit reads. The prospect gets the full
three (Get quote is the one this demo is about) and the rival two.

### The thumbnails are REAL photos, from two different sources on purpose (9/12/2026)
This shipped with hashed-colour initial squares and the reasoning that inventing a photo for a
fictional business was the "wrong kind of convincing". Overruled, directly: *"I want the
thumbnail pictures to be real pictures, so ofcourse for the prospect it should be a real pic,
but for the made up ad in the 2nd row, you can choose whatever relevant real pic."*

⚠️⚠️ **THE PROSPECT'S IS THE PROSPECT'S OWN, ON THE CHAIN `ChatGptAd` ALREADY USES** —
`/api/place` (a real Google Places listing photo of the actual business), then `/api/og-image`,
then a stand-in. Both endpoints already existed on BOTH server twins, so this needed no new
infrastructure, and `engine/places.ts` already REJECTS a listing whose name does not match the
prospect — which is exactly what stops the tile showing some other company's storefront.
**Measured across the library: 12 of 15 prospects resolve a genuine Places photo**, complete
with that business's real rating and review count.

⚠️⚠️ **THE RIVAL'S MUST NOT COME FROM PLACES, and that is the whole reason it is a stock
photo.** Querying Places for an INVENTED name ("Miami Automotive Retail") would either find
nothing or, far worse, attach a real local business's photograph to a business this demo made
up — the misattribution `nameMatches` exists to prevent. So row 2 draws from a curated
per-vertical table (`LSA_PHOTO`): nobody's specific storefront, just the trade.

⚠️ **FREE-LICENCE UNSPLASH ONLY.** Every id was harvested from Unsplash's own search and
filtered to `images.unsplash.com/photo-…`; Unsplash+ results (`plus.unsplash.com/premium_photo-…`)
are excluded because that tier carries a different licence. All 25 were verified to load at the
exact 184x184 params used — a 404 would silently fall back and read as the feature not working.

⚠️ **THE PROSPECT'S FALLBACK IS A DIFFERENT GENERIC FROM THE RIVAL'S, and that collision
actually happened.** With one generic photo, a prospect with no real listing (Shady Blinds)
drew the SAME image as the rival directly beneath it — two identical photos stacked, which is
worse than the letter tile it replaced. `_prospect` (service vans) is separate from `_default`
(a storefront), so the two rows can never collide. The three prospects that take this path are
Shady Blinds, Surfside Healthcare and Marriott — two of them FICTIONAL businesses, i.e. exactly
the "made up" case a stock photo was authorised for.

⚠️ **THE LETTER TILE SURVIVES AS THE LAST RESORT ONLY** — no photo at all, or an image that
fails to load — because a broken-image glyph mid-demo is worse than a deliberate-looking tile.

#### ⚠️⚠️ "Can you grab the image the prospect actually uses?" — measured, and the answer is no
Asked directly, and worth recording because the obvious answer is wrong. `og:image` IS the
picture the company chose for itself (`engine/ogImage.ts` says exactly that), and it is already
the fallback — so "prefer it over Places" looks like a free win. **Rendering both columns at
92x92 side by side killed it:**

| | Places | their own og:image |
|---|---|---|
| coverage | **12 of 15** | 8 of 15 — the enterprise sites (AutoNation, Orlando Health, Mattress Firm, Marriott, Denver Health, Key-Whitman) 403 a server-side fetch |
| Roto-Rooter | van + technician | its **LOGO** |
| Goosehead | storefront signage | a **logo mark** |
| National Van Lines | truck + driver | its **LOGO** |
| Continuing Life | community exterior | a **"Great Place To Work" AWARD BADGE** |
| Comfort Keepers | office exterior | banner cropping to "…e Care …vates …man Spirit" |
| Aptive | building | banner cropping to "ptive" |

**Places wins for all seven prospects that carry both.** The reason is structural: `og:image` is
authored for a WIDE link-preview card, so square-cropping one slices the wordmark in half. And a
`logo|badge` filename filter cannot rescue the idea — the two WORST og images are named
`og-img.jpg` and `image.jpg`.

⚠️ **SO THE PRECEDENCE DID NOT CHANGE; ONLY THE FALLBACK WAS GUARDED.** `looksLikeLogo()` now
skips an og:image that names itself a logo/badge/icon/award and takes the stock trade photo
instead. **That path is reachable, not hypothetical: a server with no Places key is a supported
state, and in it EVERY prospect falls through to og:image** — four of eight would show a cropped
logo. Verified by stubbing `/api/place` empty in the browser: Roto-Rooter then renders the
plumber stock photo rather than its cropped logo, and with Places live it is back to its own van
photo, unchanged.
⚠️ **A STATED LIMIT:** Goosehead's og:image is a content-hash filename (`52e9612c….png`), so no
filename rule can catch it. It is a logo, and if Places ever fails for that prospect it will be
cropped. Caught only by a real image inspection, which is not worth building for one case.

⚠️ **AND A GRAMMAR BUG THE PHOTOS EXPOSED: "Sponsored Hotels Providers | Santa Barbara".**
`providerNoun`'s fallback appended "Providers" to `industrySeg`, which is ALREADY PLURAL about
half the time ("Hotels", "Health Systems", "Care Services"). An already-plural seg is the answer
as it stands; only a singular one ("Vision Care") takes the suffix.

⚠️ **THE GREEN STATUS LINE NAMES NO REAL ACCREDITATION BODY.** The capture's own rows read
"BBB A+ rated" and "Generac authorized dealer" — a real certifying body and a real manufacturer
program, on REAL businesses. Inventing either for a fictional rival would be fabricating a
credential, so `LSA_STATUS` uses generic, genuinely Google-Guarantee-shaped badges instead:
"Licensed & insured", "Background checked", "Locally owned & operated", "Same-day service
available".

⚠️ **REVIEW COUNTS, YEARS IN BUSINESS AND THE STATUS LINE ARE ALL HASHED PER BUSINESS NAME**,
so an SE revisiting sees the same numbers rather than ones that move under them — the same
determinism rule every other invented figure on this screen already follows (the gclid, the
tracking phone number, the competitor names).

**Verified: a 66-property diff against the capture came back EMPTY** — unit box and transparency,
header height and the absence of an underline, heading/name/line/label/pill fonts and colours,
the CTA's radius, border, padding and 12px icon inset, row height and padding, the 92x92/8px
thumb and its 16px gap, the three 20px lines, the green/grey status split, the actions' 24px gap
and flex-end alignment, the 44x44 circles at y=17, the label line-breaks ("Get quote" one line,
the other two wrapping), the between-rows divider and its absence after the last row, and the
pill's 372x40/20px/`#2c2e35` box centred at x=140 over a `top: 20px` 1px `#444746` rule.
⚠️ **Two of the three apparent mismatches in that run were PROBE faults, not code** — reading
the actions' wrapper box instead of the circle inside it, and dot-accessing `top` on a
`getComputedStyle(el, '::before')` object (which returns 0; `getPropertyValue('top')` returns
the real `20px`). Ninth and tenth probe-not-code faults recorded in this file.

Also verified across three very different verticals (Shady Blinds, Orlando Health, AutoNation):
the header noun, city and both rows render correctly, the rest of the page (Sponsored Results,
Places/local pack, organic results, footer) is unchanged, the block fits the 652px column with
no horizontal overflow, and `npm run typecheck` is clean.
⚠️ The capture is kept at `reference/google-search/lsa-v1.html` so these values can be
re-checked; the transient stripped copy went in `public/__m/`, which is git-ignored precisely
for that ("extracted capture frames, measured then deleted") and was deleted after measuring.

## "Get quote" opens the Send request dialog (9/12/2026)
Asked for directly: *"Build what happens when someone clicks the 'Get Quote' button."* Measured
off a SECOND capture taken with the dialog open (`reference/google-search/lsa-quote-v1.html`).
`QuoteDialog` in `GoogleSearch.tsx`, `.gs-q-*` in `standalone.css`.

⚠️⚠️ **THE DIALOG LIVES IN A SANDBOXED IFRAME, SO NONE OF IT IS MEASURABLE FROM THE PARENT.**
Its `sandbox` omits `allow-same-origin`, so `contentDocument` is null — the same wall
CLAUDE.md already records for the ThoughtSpot frame, and the fix is the same: SingleFile
stores the frame in a **`srcdoc` attribute** (1,002,710 chars here), so extract that to its
own file and serve it, at which point every computed style is readable. **Stripping the
sandbox to get in is both the wrong instinct and blocked.**
⚠️ **AND MEASURE THE FRAME AT THE SIZE IT ACTUALLY GETS — 700x748.** Its layout is
responsive: read at the browser's own width it lays out 800 wide and reports a column width
the dialog never renders. The iframe's size in the parent is the only correct viewport.

⚠️ **THE DIALOG'S SURFACE IS `#1f1f1f`, NOT THE PAGE'S `#22242a`.** That is the frame's own
body colour, and the container behind it (`.qk7LXc`, which IS #22242a) is completely covered.
Reading the outer container would have painted the dialog the wrong grey.

Everything else measured and reproduced: scrim `rgba(0,0,0,.6)`; dialog 700 wide, centred both
axes, radius 8, shadow `0 5px 26px / 0 20px 28px rgba(0,0,0,.5)`; header 64 with a 48x48 back
button at x=20 and the title at x=88 in `400 18/24 Google Sans #dadce0`; body inset 24 (652
content); the business block's 52x65 radius-8 photo with a 12px gap and the text column at
x=88; MDC notched outline `1px #bdc1c6` at radius 4; message box 636x128; helper/counter
`400 12/14 Roboto #9aa0a6`; name and phone at **313** (half the column); radios 40x40 with a
20x20 ring `2px #8ab4f8` and a 10x10 dot; legal `400 12/16 #bfbfbf` with `#99c3ff` links;
footer 52 with two 321x36 buttons 10px apart — "No thanks" outlined `1px #3c4043` ink `#8ab4f8`,
"Send" filled `#8ab4f8` on `#1f1f1f`, both radius 36.
**A 52-property diff against the capture came back empty.**

⚠️ **THE CAPTURE'S SELECT IS IN ITS FOCUSED STATE** (blue label and outline) because it held
focus when the page was saved — so the resting grey is what is built, and blue is the
`:focus-within` rule. A freshly opened dialog focuses the MESSAGE field, which is the one
thing the dialog exists to collect.

⚠️⚠️ **THE SERVICE LIST IS THE PROSPECT'S OWN PRODUCT CATEGORIES.** The capture's dropdown was
closed when saved, so its options are NOT measured — but "the service you need" is exactly what
`Conversions by Product Category` already holds, so this re-skins for free and can never offer
a service the business does not sell. Verified: Roto-Rooter offers Plumbing / Drains / Water
Damage / Commercial, Orlando Health offers Cancer Institute / Heart & Vascular Institute /
Orthopedic Institute / Women's Institute.

⚠️⚠️ **WHAT HAPPENS AFTER "Send" IS NOT IN THE CAPTURE, SO THE CONFIRMATION IS AUTHORED AND
SAYS SO IN THE CODE.** It is deliberately assembled from the dialog's OWN measured parts (the
same header, the same business block, the same button) rather than inventing new Google chrome
— the rule the CI tier report already paid for ("anything added back has to exist on the real
report first"). Replace it if a capture of the real one turns up.

⚠️ **THE OTHER TWO ACTIONS STAY INERT.** "Book online" and "Get phone number" have no captured
destination, so they remain spans rather than buttons — a control that looks clickable and goes
nowhere is the same lie the inert place actions on this page already avoid. Only "Get quote"
became a `<button>`, and it needed the browser's button styling reset or it sits a pixel out in
a system font (the reset `.gs-loc-pill` already needed).

Verified with real clicks: the dialog opens re-skinned to the prospect (its real Places photo,
rating and review count), Send is disabled until message + name + contact are filled, the
counters track (94/600, 14/50), sending shows the confirmation echoing the real contact method
and number, and Done / Escape / a scrim click all close it and it reopens empty. The unit
underneath is untouched at 652x341.

## Sending the quote request creates a Salesforce lead AND an SMS workflow (9/12/2026)
Asked for directly: *"When send is click, it should create a lead in salesforce, and also
create a SMS Workflow based on what is shared in the form… Duplicate the SMS workflow, keep
everything the same, the only difference will be the Preview Agent and Preview Workflow. the
opening message and follow up messages are customized based on what was typed in the form
fields: Your message, Service and Name."*

⚠️⚠️ **ONE RECORD, TWO READERS.** The submission goes into `QuoteCaptureContext` — the third
sibling of the SMS and Voice capture stores, same localStorage shape, same 7-day TTL, same
`storage` listener — and the Leads tab and Agent Studio each DERIVE their view from it
(`liveQuoteLead` in `salesforceLiveLead.ts`, `quoteWorkflow` in `quoteWorkflow.ts`). Writing a
lead and a workflow separately at submit time would be two records of one event, free to drift.
⚠️ **AND THE SEARCH SCREEN IS USUALLY A DIFFERENT TAB** (it opens from the top bar's Network
chip), which is why the store writes synchronously and listens for `storage` — otherwise
neither the lead nor the workflow would appear until somebody refreshed.

### The lead
Built beside `liveBookedLead` and spliced with the **same replace-then-move rule**, not a
second one: an LSA requester can easily be a name already on the list, and a blind `unshift` is
what put one person on two rows before. Lead Source is **"Web"**, not "Inbound Call" — they
typed into an ad, they did not ring — and the Description carries what they wrote plus the
service and how they asked to be contacted. No address: the form never asked for one, and
inventing a street for somebody who only gave a phone number would fabricate the one field a
rep would act on.
⚠️ **`salesforceLeadDetail` HAD TO BE THREADED TOO.** It resolves a slug against
`salesforceLeads`, so called without the quotes the record page opens "Lead not found" on the
row the SE just created — the exact failure that file already records for the Calendar chip.

### The workflow
⚠️⚠️ **THE TREE IS DELIBERATELY THE STANDARD ONE.** `branches: []` makes `extraTree` render
exactly the four locked chrome boxes and the two locked leaves — i.e. the shape the built-in
SMS workflow draws. The instruction was "keep everything the same"; inventing use cases is the
one thing that would have made it NOT a duplicate. Everything that differs is conversation.
Each form field does a different job and none is dropped: **Name** — the agent greets a person;
**Message** — quoted back in the opener (that is what makes it read as a reply rather than a
broadcast) and handed to the model as the job to scope; **Service** — optional, so every use of
it is guarded, and it picks the qualifying questions.

⚠️⚠️ **`openingMessageWins` EXISTS BECAUSE THE FEATURE WAS OTHERWISE A SILENT NO-OP ON THREE
PROSPECTS.** `buildSmsBrain` ranks a stored `smsPlaybook.greeting` ABOVE a workflow's own
`openingMessage` — correct for the 9/3 bug, where a line authored months ago was beating an
SE's edit. A workflow generated from a form inverts that: its opener quotes words typed seconds
ago. **Measured: 3 of 15 profiles ship a stored greeting (Aptive, Denver Health, Marriott)**,
and on those the whole beat would have opened with the generic line. Flagged on the workflow
rather than re-ordering the precedence for everyone, so every authored workflow is untouched,
and an edit made ON the generated workflow still wins (`wfAgent.greeting` is checked first) so
Ask AI and the Details tab keep working.
⚠️ Safe as an `.optional()` schema field because `ExtraWorkflow` is **not** part of any
generation schema — `sanitize()` would otherwise force it onto the model, the trap that made
the engine invent `InteractionRow.cells`. Verified no engine phase writes `extraWorkflows`.

⚠️ **ONE DEFINITION, SIX READERS — `useExtraWorkflows`.** The Agent Studio table, the sub-nav,
the workflow page, Preview Agent, Preview Workflow and the preview page's title each resolved
`profile.reports.extraWorkflows` separately; a generated workflow listing in one and resolving
in none is a dead row mid-demo. All six now call one hook. ⚠️ The hook lives in
`quoteWorkflow.ts` and imports the context, never the reverse — the other direction is a
runtime cycle of exactly the kind `leadSlug` was moved to kill.

**Verified end to end on Aptive** (chosen *because* it ships its own greeting): submitting
"carpenter ants along the back deck…" with the service "Recurring Residential Pest Plans"
produced — Dana Whitfield as the top lead with the form's own phone, the list still 10, the
record page resolving with Lead Source "Web" and the message in Description; and
"Aptive - SMS - Quote Request (Dana)" in the Agent Studio table, the sub-nav and its own
workflow page with the standard locked chrome. **Reading the `/api/chat` request body** (the
reliable test this file insists on) shows the customized opener, all 7 form-derived steps and a
system prompt quoting their words; the agent then took the address without re-asking the
problem and offered two windows. The stored Aptive greeting is "Hi, this is Aptive's AI
agent…" — proving the flag is what makes the opener reach the phone. A prospect with no
submission is unchanged: Orlando Health still lists exactly its own seven workflows.
`audit:ai`, `audit:leads`, `audit:leaddetail`, `audit:calllog`, `audit:clrecord` and
`audit:place` all green, typecheck clean.

## Replicate renders in a REAL browser, off-box, because uptime beats accuracy (9/13/2026)
Reported after a live test of `https://ridgeline-roofing.com/`: *"assets weren't loaded, like the
video playing in the background of the form; the formatting of the header is off; Icon SVG are
missing… instead of replicating with speed, i rather do accuracy."* Then, on how: *"top priority
is that the site should always be up and not go down."*
`engine/renderService.ts` + the render-first path in `engine/replicate.ts`.

⚠️⚠️ **ALL THREE SYMPTOMS WERE ONE CAUSE, MEASURED.** That page carries **21 `data-src`
attributes and 62 `loading="lazy"` images**, so nothing has a real `src` until its JavaScript
runs; its icons are JS-injected (**zero inline `<svg>`** in the served HTML); and its layout
needs JS-applied classes. After letting a browser run it: **104 of 104 images resolve**, the
background video gains a source, and the header lays out correctly. Screenshots of both were
compared side by side before any code was written.

⚠️⚠️ **AND A FOURTH CAUSE THE CAPTURE PATH SHARED: 37 STYLESHEETS, ONLY 17 READABLE.** The
capture script stripped `<link rel=stylesheet>` and inlined only the sheets it could read from
script — throwing away the 20 cross-origin ones, which is its own version of the broken header.
**A stylesheet loads cross-origin perfectly well; CORS only governs READING its rules.** The
links now stay, and the inlined copy is belt-and-braces. Both paths fixed.

⚠️⚠️ **THE RENDERER RUNS OFF-BOX, AND THE "FALLBACK" I FIRST PROPOSED WOULD NOT HAVE PROTECTED
ANYTHING.** Render enforces memory **per container**, so a Chromium in this service counts
against the same limit as Node; when that limit is crossed the kernel kills the process and **no
`catch` block runs** — the platform restarts and every SE mid-demo drops. A `try/catch` around
the renderer handles crashes, timeouts and blocks, none of which was the stated risk. The only
structural answer is to put the browser in somebody else's container, which makes the worst case
"a less accurate replica" rather than "a down platform". Said plainly to the user rather than
shipping the weaker mitigation.

⚠️ **BROWSERLESS `/content`, WHICH MEANS NO NPM DEPENDENCY.** It takes a URL and returns rendered
HTML, so this is a `fetch` — no Playwright, no puppeteer-core, no Chromium download. Same
reasoning that rejected a 26MB SDK for one button in `engine/voicePreview.ts`. Free tier is 1k
units/month with no card, which covers this comfortably. `BROWSERLESS_URL` can point at a
self-hosted instance later without touching code.

⚠️ **UNCONFIGURED IS A SUPPORTED STATE.** With no `BROWSERLESS_TOKEN` the fast fetch is used
exactly as before — nothing is gated on somebody buying anything — and the screen SAYS it is the
fast copy. That matters: a page missing its lazy images looks like a badly built replica rather
than a fallback, and the SE has no way to tell, which is how this feature lost trust the first
time. Every degraded path carries its reason to the banner.

⚠️⚠️ **A CIRCUIT BREAKER, BECAUSE A DEAD RENDERER WOULD OTHERWISE COST EVERY SE THE FULL
TIMEOUT.** Three consecutive failures and it stops asking for five minutes, then lets one probe
through. Verified with a deliberately bad token: requests 1–3 fall back in ~200–760ms each
naming "the token was rejected", the breaker opens, and request 4 skips the service entirely.
Without it every click would sit for 20 seconds against a service that is down.

⚠️ **`waitUntil: "networkidle2"` PLUS `bestAttempt: true`.** Lazy images and injected SVG arrive
AFTER `load`, so waiting for the network to quieten is what buys the accuracy; `bestAttempt`
returns what it has rather than nothing, because a marketing page with a chat widget or an
analytics beacon may never go fully idle and a perfectly good render would otherwise be thrown
away on a timeout.

⚠️ **A BODY UNDER 500 BYTES IS TREATED AS A BLOCKED STUB** and falls back, per Browserless's own
bot-detection note. Sites that 403/429 a datacenter IP (AutoNation, Orlando Health) still fail —
`/unblock` with residential proxies is the paid answer and is not wired up.

⚠️ **`/api/status` GAINED `renderConfigured` — a BOOLEAN.** That endpoint is PUBLIC, so it names
no token and no URL, the same rule the other integration flags follow.

⚠️⚠️ **A TALL VIEWPORT BROKE THE HERO, AND IT WAS MY OWN OPTIMISATION.** Trying to drag more
below-the-fold lazy images into range with `viewport: {height: 2400}` won four extra images and
wrecked the page: ridgeline-roofing.com sizes its hero in `vh`, so a 2400px-tall viewport made
the hero 2400px tall and two carousel slides' text rendered on top of each other — **the exact
"formatting of the header is off" complaint, reintroduced by a performance tweak.** Caught by
screenshotting the served result against the live site rather than trusting the element counts,
which looked fine (`swiper-slide-active` was 1 in every variant). **1440x900 is the viewport;
fidelity is the whole point of this path.**

⚠️ **THE OPTION SET WAS MEASURED, NOT ASSUMED** — three renders of the same page against the
real service: `networkidle2 + bestAttempt` 14.0s, `domcontentloaded + 4s wait` **7.0s for
byte-identical output**, the tall-viewport variant 7.1s with a broken hero. A marketing page
with a chat widget never goes network-idle, so `networkidle2` just burns the timeout and
`bestAttempt` returns what it had anyway.

**Verified live on the reported URL** once `BROWSERLESS_TOKEN` was set: the replica is a faithful
copy of ridgeline-roofing.com — green inspection form in the hero, "KEEPING THE SOUTHEAST
COVERED", roof photograph, nav, chat widget — and the banner reads "rendered in a browser".
⚠️ **ITS FORM IS WPFORMS, WHOSE FIELD NAMES ARE OPAQUE** (`wpforms[fields][23]`), and
`deriveFieldMap` mapped all six purely from their LABELS. That is the case a name-based table
could never have covered, and the reason the classifier reads the rendered DOM. Filling it and
clicking its own **Submit** created the lead with the message and ZIP 85018 resolved to Phoenix.

**`npm run audit:replicas` gained 11 checks** covering the half that matters: unconfigured
reports itself and still serves a page, a rejected token degrades **every time** rather than
erroring, the breaker trips, short-circuits while tripped and recovers, a working service is
actually used, `sanitizeReplica` keeps stylesheet links / drops preloads / strips form actions /
adds `<base href>`, and the capture tool no longer strips stylesheets.
⚠️⚠️ **THEY RUN AGAINST A MOCKED `fetch`, AND THE FIRST VERSION DID NOT — reporting three
failures that were entirely the probe's fault.** It used `https://example.com/`, which is not
reachable from this environment, so `fetchReplica` threw and three checks "failed" on correct
code. An audit that depends on somebody else's site is flaky by construction; this is the same
rule `audit:advanced` already follows for Gong.
⚠️ A fourth probe fault in the same pass: the mock page was ~200 bytes, which the stub guard
correctly rejects, so the happy-path check failed for a reason unrelated to the code. Fixtures
have to clear the thresholds the code enforces.

## Replicate — the prospect's OWN booking page, with its form wired in (9/12/2026)
Asked for from the Book online menu: *"add another button called replicate, and what it does is,
it replicates the given webpage with the form on it, so that way when the form is completed and
'submitted' on the fake replicated website then it can actually take the information from the
form and do stuff with it. like create a SMS workflow with the information from lead form."*
`scripts/capture-replica.js` → `public/replicas/<slug>.html` → `src/data/replicaPages.ts` →
`/replica/:slug`.

⚠️⚠️ **THIS IS NOT WHAT WAS REJECTED TWO SECTIONS DOWN, AND THE DIFFERENCE IS THE WHOLE POINT.**
That section killed replicating *ServiceTitan's* form — one form matching nobody, on a product
only 2 of 15 prospects use. Replicating **whatever is at the URL** is per-prospect by
construction, which is exactly the objection ("every prospect has a different form") that killed
the earlier idea.

⚠️⚠️ **A SERVER CANNOT DO THIS, AND IT WAS MEASURED BEFORE A LINE WAS WRITTEN.** These forms are
JavaScript widgets:

| | `curl` | a real browser |
|---|---|---|
| Aptive `/build-a-plan/` | **0 forms** | **1 form, 38 inputs** (the real First/Last/Email/Phone/Zip) |
| AutoNation | **403** | loads fine, 59/59 readable stylesheets |
| 10 prospect booking pages | **1 of 10** had a real lead field | — |

So "fetch and replicate on demand" would hand an SE a formless, unstyled page — silently — for
about nine prospects in ten. Captures are made ONCE by a browser and ship in the repo; **the SE
installs nothing and clicks one button**, which was the constraint that ruled out asking every SE
to install SingleFile.

⚠️⚠️ **THE CAPTURE IS NEUTRALISED AT SOURCE AND AGAIN AT SERVE, AND THAT IS NOT BELT-AND-BRACES
PEDANTRY.** AutoNation's is a **Salesforce Web-to-Lead** form (`00N1U00000Utmts` and friends are
Salesforce custom field ids) and Aptive's posts to Aptive's own lead API. A replica that kept its
`action` would **file a real lead at the prospect's own company** the first time it was demoed —
the one failure here that cannot be taken back. The serializer strips
`action`/`method`/`target`/`onsubmit`, every `formaction`, every `on*` attribute, all scripts and
all iframes; `ReplicaPage` re-strips on load and `preventDefault()`s every submit;
`audit:replicas` asserts it **over the files on disk**, not over the code meant to have cleaned
them. Verified to fire by putting an action back on a capture.

⚠️⚠️ **THE IFRAME IS SAME-ORIGIN, WHICH IS THE ENTIRE MECHANISM.** The capture is served from
`public/replicas/` by our own server, so `contentDocument` is reachable and the parent binds to
the real form. That is the exact inverse of the ThoughtSpot and LSA-quote frames this file
documents as unreadable — those are cross-origin. **Never add a `sandbox` that omits
`allow-same-origin`**; every interception would silently stop and the form would just do nothing.

⚠️⚠️ **TWO THINGS A CAPTURE FREEZES THAT COST REAL DEBUGGING TIME, both now handled:**
- **A DISABLED CONTROL.** AutoNation's submit is captured as `<input type="button" disabled>` —
  its own JS enables it once the form validates, and the capture has no JS. **A disabled element
  dispatches no click at all**, so the listener attached perfectly and never fired, which reads
  exactly like broken wiring. `wireFrame` removes `disabled` from controls it has just decided
  to wire.
- **A BUTTON THAT IS NOT A SUBMIT.** That same control is `type="button"`, driven by the removed
  script, so it fires no submit event. `wireFrame` bridges click → submit for controls whose
  label or name looks like one.

⚠️ **LINKS ARE MADE INERT AT SERVE, NOT IN THE CAPTURE.** The page is full of real navigation
that would take the SE to the live site mid-demo; the capture stays a true copy and the behaviour
lives in `wireFrame`.

⚠️ **SUBMIT FEEDS THE EXISTING PIPELINE — nothing new was built for the "do stuff with it"
half.** The form's own field names are mapped by `replicaPages.fields` (no normalising at capture
time, so the copy stays faithful) into the same `LsaQuote` the LSA dialog writes, so a submit
produces the Salesforce lead, the customised SMS workflow and the Interactions payload exactly as
a quote does. **`LsaQuote.source` distinguishes them**, optional and defaulting to `"lsa"` because
the store is persisted and the measured LSA wording must not move.
⚠️ **THE ZIP IS RESOLVED TO A CITY** through the same `/api/zip` the precise-location pill uses
(30328 → Sandy Springs), because the captured payload names a place, not a postcode — and it
falls back to the raw ZIP rather than making a submit wait on a network call.
⚠️ **TWO OPENER SHAPES, because one did not fit both.** A web-form quote did not arrive "on
Google", and these forms often have **no free-text box at all** (Aptive's has five fields and none
is a message) — a fixed opener greeted a real person with `You told us: ""`. The quote is included
only when there is one. ⚠️ And the two intros are whole SENTENCES rather than a shared stem: built
as `this is <name> ${tail}.` the web variant read *"this is AutoNation thanks for reaching out"*.

⚠️ **AUTONATION'S REPLICA IS NOT ITS `bookingPath` PAGE, deliberately.** `/appointment` is a
multi-step scheduler behind a consent gate whose contact fields never appear on step one, so a
capture of it shows a form an SE cannot fill. The replica is `/an-fleet-services`, a genuine
single-page lead form. The two fields answer different questions — `bookingPath` is "where does
Book online go", `replicaPages` is "which page can we actually replicate".

⚠️ **SIZE: 1.7MB and 2.9MB.** Static files, never bundled, but this is a per-prospect feature
rather than something to run across all 145.
⚠️ **Needs internet at demo time** — assets resolve from the prospect's CDN via `<base href>`,
the same property the saved Invoca Exchange page has.
⚠️ **A CAPTURE FREEZES THE CAPTURING BROWSER'S STATE**, including hidden tracking fields
(Aptive's came out carrying a `gclid` and `utm_campaign`). Harmless here — they are our own
demo's fabricated values — but capture in a clean tab and never while signed in to anything.

⚠️ **A DEV-ONLY `/api/replica-capture` ENDPOINT WAS BUILT AND THEN DELETED.** POSTing the HTML to
the dev server is tidier than a download, and `curl` confirmed it worked — but from a real capture
it fails with a bare `TypeError: Failed to fetch`, because every page worth capturing is HTTPS and
the browser blocks mixed content to `http://localhost`. It could only ever be reached from an HTTP
page, and a dev server that writes files from an unauthenticated body is not worth carrying for
nothing. The capture is a download instead.

**`npm run audit:replicas` is 28 checks** (also in `npm run audit`): per capture — no live
script, no iframe, **no form action**, no inline handler, no `formaction`, a form present, a
doctype, a `<base href>`, inlined CSS, every mapped field actually present in that HTML, a filled
form yielding a lead and an empty one refused; plus the serving layer still re-stripping,
preventing default and re-enabling disabled controls, and the capture tool still neutralising.
⚠️ Its script counter **strips HTML comments first** — Aptive's page carries three commented-out
`<script>` tags and a naive count reports a clean capture as dirty, the same fix `audit:place`
needed.

**Verified end to end with real clicks**: Replicate opens Aptive's actual booking page under our
own bar; filling First/Last/Email/Phone/Zip and clicking **Contact Me** created the lead and
"Aptive - SMS - Quote Request (Dana)" appeared in Agent Studio. On AutoNation, filling the fleet
form and clicking its own **Request a Quote** produced *"Lead created for Marcus Bell"* with
Company and Fleet size chips, `location: "Sandy Springs"` resolved from ZIP 30328, and the
comments field carried into the SMS opener. A prospect with no capture (Roto-Rooter) is offered
**no Replicate button at all**, and the route fails closed if the URL is typed.
⚠️ **ONE DEBUGGING DETOUR WORTH NOT REPEATING: a stale module.** The click bridge was tested
against a dev-server module that predated the edit and appeared not to work at all; instrumenting
`wireFrame` to report what it wired showed `buttons: 2` after a reload. This file already records
the Node-cache version of this trap for `engine/*`; the browser HMR version is the same lesson.

## Marketing Source names the channels the demo can SHOW: Google LSA and ChatGPT (9/12/2026)
Asked for from a Marketing Source breakdown: *"can you replace Youtube and facebook in the
marketing source in all the dashboards and replace it Google LSA and ChatGPT."* Right change for
a reason worth stating: this platform now demos a **Google Local Services ad** and a **ChatGPT
sponsored ad**, and neither channel appeared anywhere in the attribution data an SE opens
straight afterwards. `src/data/marketingSources.ts` + `sourceRows()` in `engine/core.ts`.

⚠️⚠️ **A STRING REPLACE WOULD HAVE BEEN BADLY WRONG, AND THE MEASUREMENT IS WHY.** Across the
145 profiles on disk these two words appear **370 times as a Marketing MEDIUM and 366 times
inside a landing-page URL** (`utm_source=facebook`) against **97 in a source breakdown**. A
medium legitimately IS "Facebook". So the rename walks structurally to the positions that MEAN
Marketing Source — breakdowns whose `dimensionColumn` says so, and the ops section whose table's
first column does — and `dimensionColumn` is the identifier rather than the title for the same
reason Location Comparison finds its columns by header instead of by index.

⚠️⚠️ **DONE AT LOAD, NOT AS A DATA MIGRATION.** 145 profiles carry these values locally and the
shared library holds ~234 more that no local edit reaches. Same call `withoutAgentQaSignals`
records — "changing the prompts alone would have fixed nothing an SE could see" — so
`renameMarketingSources` runs as a profile enters `ProfileContext` and every screen is right by
construction, live demos included. The engine asks for the new names too, so a prospect
generated from now on is born correct and the rename is a no-op for it.
⚠️ **BOTH ENTRY POINTS NORMALIZE** — the initial state (registry + localStorage cache) and
`addProfile` (a fresh generation, or a library demo). Doing one and not the other is how a
library demo renders Facebook while a bundled one renders Google LSA.

⚠️⚠️ **`digitalInsights` IS DELIBERATELY UNTOUCHED, and that was measured rather than assumed.**
The Digital Journey report prints **Marketing Source, Marketing Medium and the Full Landing Page
URL in ONE VISIBLE ROW**, and on a Facebook source row all three say so (medium "Facebook" on 37
of 38, `utm_source=facebook` on the same 37). Renaming only the source would print
`Google LSA | Facebook | …utm_source=facebook` on one line — the contradiction this file already
records twice. Moving the whole tuple means inventing utm conventions for ChatGPT that nothing
in the demo emits, which is a decision to ask for. **It costs less than it looks: the two slices
already use different source vocabularies** (Aptive's dashboard reads Google / Bing / Direct /
Facebook / YouTube while its journey rows read Organic / Paid Search / Social Media), so they
were never aligned and this introduces no new drift.

⚠️ **EXACT VALUES ONLY.** A source row reading "Paid Social (Facebook/Instagram)" or
"Facebook / Instagram" is a COMBINED channel; calling it "Google LSA" would be wrong rather than
renamed. Measured: 8 such rows against 94 standalone ones.
⚠️ **FACEBOOK -> GOOGLE LSA, WHICH INVERTS THE ORDER THE REQUEST LISTED.** Taken positionally it
would be YouTube -> Google LSA; the measurement argues the other way — Facebook appears in 86
profiles' source breakdowns and YouTube in 16, so this is what actually puts the channel we just
built a screen for in front of most prospects. One line to flip.
⚠️ **RENAME ONLY, NEVER AN INSERT.** A breakdown's rows are a partition whose metrics sum to the
prospect's own call total. Relabelling preserves every sum by construction; adding a row would
not. **Consequence, stated: 56 of 145 profiles carry neither value and so gain neither name.**

⚠️ **ONE RULE, THREE PROMPTS.** Source rows are generated by `dashboardChannels`, `opsDashboard`
AND `aiAgentConversion`; a rule pasted into two of them is how one dashboard says Google LSA and
another says Facebook. `sourceRows()` is injected into all three and the audit fails below three.

**`npm run audit:sources` (also in `npm run audit`) is 11 checks** over all 145 profiles: the
exact-match rule and its refusal of compounds, the mapping, that **nothing outside a source
position moved** (mediums, landing URLs, journey rows, row counts and every metric byte-identical),
that no source row still reads Facebook/YouTube, idempotence, the untouched-profile identity path,
and the prompt carrying the rule at all three sites while still permitting the MEDIUM.
⚠️ Each was broken on purpose and seen to fire: widening to a substring match (the compound check
reddens), dropping the ops chart from the rename (36 leaks + 41 survivors), and removing the rule
from one prompt.
⚠️⚠️ **TWO OF THOSE CHECKS FAILED ON CORRECT CODE FIRST — the eleventh and twelfth probe faults
in this file.** One asserted every ops chart bar appears in its own table, which **five profiles
never satisfied**: Hopscotch Primary Care's chart says "Paid Social" where its table says
"Facebook (Paid Social)". That is a GENERATOR bug predating this work (the rename leaves both
untouched, since both are compounds), so the check now measures "the rename must not make
divergence worse" and the real defect is filed separately. The other looked for the prompt's
finished sentence in `engine/core.ts` and found nothing, because the rule is built across a
template-literal break (`` `…Marketing ` + `MEDIUM…` ``); adjacent literals are joined before
matching now.

Verified in the browser: Aptive's Calls by Source reads Google / Bing / Direct / **Google LSA** /
**ChatGPT**, summing to its own 64,004 KPI exactly, with the Medium table untouched — and the two
new rows land as the smallest-volume, highest-converting ones (58.2% and 64.5% against Google's
44.3%), which is the "volume is not value" story this file already enforces. AutoNation's
Marketing & Operations Source **table and its chart moved together**, no Facebook or YouTube
anywhere on either page. Mattress Firm's Digital Journey report still shows Facebook as source
AND medium on the same row, untouched on purpose.

## The LSA conversation opens with Google's lead payload (9/12/2026)
Asked for with a capture of the real thing attached — an **Interactions** report for a pest
control advertiser (`reference/google-search/lsa-interactions-v1.html`): *"for the LSA
submission, when setting up the SMS agent the first message only in the interaction report
should always be 'You have received a new message from a customer via Google Local Services
Ads. Customer Name: …, Location: …, Service: …, Message: … [Notes from LSA: This customer has
requested a quote].'"* `lsaLeadMessage` in `quoteWorkflow.ts`, rendered by `buildConversation`.

⚠️⚠️ **IT IS AN INBOUND MESSAGE, NOT THE AGENT'S GREETING — and the capture is what settles
that.** It sits on the **Consumer** side of the thread, and the agent's own first reply follows
it ("Thank you for contacting <business>. Reply STOP at any time to opt out…"). It has to be
inbound: the text is addressed to the BUSINESS ("You have received…"), so making it the opener
would be texting the customer a notification about themselves. Only the first message changes,
exactly as asked — `quoteWorkflow`'s customized opener is untouched.

⚠️⚠️ **IN THE REPORT, NEVER ON THE PHONE — which is why it is a parameter to
`buildConversation` rather than a seeded `messages` entry.** The payload arrives on the
business's inbound channel; the consumer never sees it, and putting a notification about
themselves into the iPhone mockup would break the one screen that has to stay a believable
iMessage thread. The phone renders `messages`; the capture renders this in front of them.
Verified both ways: the report's first turn is the payload and the phone's first bubble is the
agent's opener, with the payload string absent from the preview's DOM entirely.

⚠️⚠️ **AN EMPTY SLOT KEEPS ITS LABEL, AND THAT IS MEASURED RATHER THAN TIDIED.** The captured
payload reads `Customer Name: , Location: Lowell` — that advertiser's feed carried no name and
the label stayed with nothing after it. Reproducing that is also what makes the field addition
below safe. **The string is asserted character-for-character against the capture** (extracted
from the saved HTML, not transcribed from the screenshot).

⚠️ **`LsaQuote.location` IS NEW AND OPTIONAL, because the store is PERSISTED.** Google's payload
names the consumer's city and the quote form never asks for one, so it comes from the search
screen's own location (`d.shortCity` — the same value the unit prints as "Serves <city>", and
the one the ZIP pill can re-point). Optional because a quote captured before this field existed
is still in localStorage for up to seven days; it renders as the empty slot the real payload
already uses, so an old record degrades into a correct-looking message rather than `undefined`.

⚠️ **`smsInfo.totalMessages` COUNTS THE TRANSCRIPT, NOT `messages`.** With a lead-in the two
differ by one, and an SMS Info card that disagrees with the transcript beside it is exactly what
a prospect notices before we do. The lead-in also takes the earliest timestamp, with the rest of
the thread shifted a minute, so the order on screen is the order it happened.

⚠️ **THE HOOK IS CALLED UNCONDITIONALLY.** `wf && quoteForWorkflow(useQuoteCaptures()…)` reads
naturally and puts a hook behind a condition, which React forbids and which would break the
moment an SE opened a different preview. The slug is tested after the hook, not around it.

⚠️ **A SIDE EFFECT WORTH HAVING: the payload reaches `/api/analyze`,** since signals are
extracted from `conv.transcript`. Measured on a real submission, the Analysis tab came back with
"Service Area Confirmed: Phoenix", "Service Type: Recurring Residential Pest Plans" and "Pest
Type Identified: Carpenter Ants" — all grounded in the form, none of which the chat alone said.

Verified end to end by submitting a real quote through the dialog (Aptive, Phoenix): the record
stored `location: "Phoenix"`; the Interactions report's first turn is the payload on the Consumer
side, character-identical to the template with all four fields filled; the phone shows only the
agent's opener; `totalMessages` reads 4 against a 4-turn transcript. **Untouched and checked: the
built-in agent's preview (no `?wf=`) still captures a 3-turn conversation beginning with its own
stored greeting and no lead-in.** `audit:ai` and `audit:place` green, typecheck clean.
⚠️ A note for the next person driving this form in a browser: the contact field's centre sits
under the dialog's sticky footer until the body is scrolled, so a click at its centre hits the
footer. That is ordinary scrollable-dialog behaviour, not a defect — scroll first.

## "Book online" is a tracked handoff, and the beat ENDS there (9/12/2026)
Asked as a question — *"each prospect has a unique form, so what do you recommend?"* — and
settled by measuring the capture rather than guessing. **This section exists so the "let's
build the booking form" idea is not relitigated; it was considered, costed and rejected.**

⚠️⚠️ **GOOGLE DOES NOT HOST THIS FORM.** In `reference/google-search/lsa-quote-v1.html`,
"Book online" is an `<a href>` to `google.com/localservices/booking?ebd=<base64>`, and that
blob decodes to the advertiser's OWN booking system plus a Reserve-with-Google token:

| advertiser | destination |
|---|---|
| 6 of 8 | **ServiceTitan** — `book.servicetitan.com/<tenant-id>` |
| Roto-Rooter | its own page — `rotorooter.com/schedule-service/?zipCode=30318&gad=789-200-3717` |
| 1 | a third-party form builder — `form.recreateai.com/?rai_pak=<uuid>` |

Every destination carries `rwg_token=AE37R_…`.

⚠️⚠️ **SO THERE IS NO SINGLE FORM TO REPLICATE — two independent reasons, both measured:**
  1. **Per-TENANT variance.** Even among ServiceTitan advertisers the services, fields and
     branding are configured per business, so one replica matches none of them. (Raised by the
     user, and correct.)
  2. **WRONG VERTICAL FOR ALMOST EVERYONE.** ServiceTitan is a home-services product, and only
     **2 of the 15 profiles on disk are home services** — the other 13 are healthcare, hotels,
     auto, insurance, senior living, retail and moving. Orlando Health does not book through
     ServiceTitan.

⚠️ **A NEUTRAL, PROSPECT-BRANDED BOOKING PAGE WAS DESIGNED AND ALSO REJECTED** — by the user,
and it was the right call: it would be a form nobody's prospect actually uses, presented as
theirs, which is the same failure mode as every other invented-content refusal in this file.

⚠️⚠️ **AND NOTHING CAN COME BACK FROM THE REAL FORM, WHICH IS HONEST RATHER THAN A GAP.** The
question asked was whether the click could carry a tag that pushes the submission back into the
demo. It cannot: those URLs are live tenants belonging to REAL named businesses (Keep Smiling
Plumbing, Cool Air Mechanical, Plumb Works are all in the capture) so submitting one books an
actual service call; a third-party page is cross-origin with no `postMessage` contract and no
webhook we can receive; and `rwg_token` is Google's tag, not Invoca's.
**What makes a form submission reach Invoca in the real world is `InvocaJS` deployed on the
advertiser's own booking page** — it finds the form in the DOM, injects a hidden field carrying
the Invoca id, and captures the values client-side. That is a property of THAT page, not of this
click, and it is a selling point rather than a limitation. The tag half already exists here:
every outbound link on this screen carries `oppref`.

**What was built instead:** `bookingHandoffUrl()` — the prospect's own site with `oppref`,
`utm_medium=lsa`, `utm_content=book_online` and a deterministic `rwg_token`. ⚠️ The token is
fabricated for exactly the reason `gclid` already is on this screen: it is the parameter that
marks a booking click as coming from the ad, so omitting it would drop the thing being
demonstrated.
⚠️ **PROSPECT ROW ONLY.** The rival is an invented business with an invented domain, so its
"Book online" stays an inert span — linking it would open a 404, the same reason its ad headline
is inert while the prospect's is a real link. "Get phone number" stays inert on both rows: no
captured destination.

Verified: the prospect's button is an `<a target="_blank" rel="noopener noreferrer">` carrying
all five parameters, the rival's and both "Get phone number" are still spans, and an 11-property
re-measure shows the unit unchanged (341 tall, rows 116, circles 44x44 at y=17, actions ending
at 642, label still `500 14/18 #a8c7fa` on two lines with no underline).

### ⚠️⚠️ CORRECTED SAME DAY — it was landing on the HOME page, which is not what the real one does
Reported directly: *"the book online link is just taking them to their website, it needs to take
them to the actual page to what happens when they click book online, for example when you click
on the book online for Roto Rooter it takes them to URL:
`www.rotorooter.com/schedule-service/?zipCode=30328&gad=138-660-5452&rwg_token=AE37R_…` and not
the home page."* Right, and the decoded `ebd=` blobs above say the same thing — the handoff lands
on the advertiser's own BOOKING page. `bookingHandoffUrl` was setting every parameter correctly
onto the front door. `src/data/bookingPath.ts` is a `domain -> path` table it now consults.

⚠️⚠️ **A TABLE, NOT RUNTIME DISCOVERY, AND THAT WAS MEASURED RATHER THAN ASSUMED.** The obvious
build is the `engine/ogImage.ts` pattern: fetch the site at view time and find the booking link.
Probed across the library, it fails for exactly the prospects that matter — **AutoNation 403,
Mattress Firm 403, Orlando Health 429**, the same enterprise blocking `ogImage` already records —
and three more are SPAs whose CTA is not in the served HTML. A BROWSER reaches all six (that is
how their paths were resolved), a server cannot, so runtime discovery would quietly drop the
biggest brands to the home page. A demo link must also not depend on whether somebody else's site
answers a fetch mid-pitch.

| resolved by | |
|---|---|
| server fetch | rotorooter.com **`/schedule-service/`**, aptivepestcontrol.com `/build-a-plan/`, keywhitman.com `/lasik/schedule-online/`, nationalvanlines.com `/free-moving-quote/` |
| a browser (these 403/429 a server) | autonation.com `/appointment`, orlandohealth.com `/request-an-appointment`, mattressfirm.com `/en-us/stores/` |
| read off the rendered page (SPAs) | comfortkeepers.com `/care-assessment/`, vectorsecurity.com `/services/` |

⚠️⚠️ **ROTO-ROOTER IS THE CONTROL, AND IT MATCHES THE REAL DESTINATION CHARACTER FOR
CHARACTER.** The discovery found `/schedule-service/` independently, which is the path in the
live Google LSA link quoted above — that is the evidence the rest of the table is the right KIND
of page rather than a plausible-looking contact form.

⚠️ **PATHS ONLY, NEVER A QUERY STRING.** The real URL also carries `zipCode=30328` and `gad=…`,
but those are ADVERTISER-SPECIFIC parameters Google fills in for a page that accepts them;
appending a zipCode to a prospect whose booking page has no such field would be inventing an
integration. The generic tokens (`oppref`, the utm set, `rwg_token`) are still appended for every
prospect, because those are Google's and Invoca's own.

⚠️ **AN UNKNOWN PROSPECT FALLS BACK TO "/" — the home page, which is never a 404.** The platform
generates new prospects constantly and none of them is in this table; **Goosehead is in it today**
(the discovery found no booking link on that site at all). A guessed path (`/book`, `/schedule`)
404s in front of a customer, which is worse than landing one click away.

Verified in the browser on four prospects: Roto-Rooter renders
`https://rotorooter.com/schedule-service/?oppref=…&utm_medium=lsa&utm_content=book_online&rwg_token=AE37R_…`,
Orlando Health `/request-an-appointment`, and Goosehead falls back to `https://goosehead.com/`
with `oppref` and the `rwg_token` still attached. The unit is unchanged (341 tall, 652 wide, rows
116, thumb 92x92, 5 actions of which exactly 1 is a link). `bookingPath` normalises protocol,
`www.` and case (unit-checked); `audit:place` green, typecheck clean.

### Right-click it and the SE picks the destination (9/12/2026)
Asked for straight after the table landed: *"when i right click on the book online it gives the
user the option to enter the URL where they want the button to take them to when its click, so
there will def be a default place it goes, but the user can also change it."*
`src/data/bookingOverride.ts` (the store, `.gs-lnk-*` for the panel).

⚠️⚠️ **THIS IS WHAT MAKES `bookingPath` A DEFAULT RATHER THAN A CEILING.** That table is
hand-resolved, so it can only ever cover prospects somebody has looked up — and the platform
generates new ones constantly, booking pages move, and a regional franchise books somewhere the
national site does not. Every one of those is an SE with the right URL in their clipboard and,
until this, no way to use it.

⚠️⚠️ **A RIGHT-CLICK IS THE ONLY REASON THIS CAN LIVE ON A REPLICA SCREEN.** Every pixel of the
unit is measured against a capture, and the standing rule is that an affordance of ours must not
change what a prospect sees. At rest this adds nothing — no control, no marker, **not even when
an override is in force** — so the unit still diffs clean (re-measured after: 652x341, rows 116,
thumb 92x92, circles 44x44, 5 actions, 1 link). Same argument as the hover-revealed Ask AI
sparkle. The one concession to discoverability is a native `title` on the link, which is what
"Use precise location" already does on this same screen.

⚠️⚠️ **AN OVERRIDE OPENS VERBATIM — IT DOES NOT GET THE TRACKING ENVELOPE, and that is a
deliberate trade.** The default is wrapped in `oppref` + the utm set + `rwg_token` because that
is the demo's own point. An overridden URL is not: the instruction was "take them to this URL",
and what an SE pastes is very often a real booking link copied complete with its own parameters
(the real Roto-Rooter destination carries `zipCode` and `gad`). Rewriting a pasted link's query
is how you break one, and appending ours beside theirs reads as a bug the moment they look at
the address bar. **Consequence, stated: an overridden link carries no `oppref` unless the SE
includes one.** The menu shows the default underneath so what was replaced is never hidden.

⚠️ **PROSPECT'S ROW ONLY.** `onContextMenu` and `title` are opt-in props on `LsaAct`, defaulted
absent, passed only by the prospect's "Book online" — verified live: of the five actions exactly
one carries them, the rival's is still an inert `<span>`, and right-clicking it does not open the
panel. "Get quote" opens the dialog and "Get phone number" has no destination, so neither takes
one either.

⚠️ **PER PROSPECT, PERSISTED, NO TTL** — the same shape and reasoning as `locationOverride`, and
verified live: an override set on Roto-Rooter survives a reload and does NOT follow a switch to
Orlando Health, which still resolves its own `/request-an-appointment` default.

⚠️ **ONLY http AND https ARE STORED**, checked at the one place that writes and again on read.
The value goes straight into an `href`, so a `javascript:` URL would be script on our own origin.
⚠️⚠️ **THE SCHEME TEST IS `scheme://`, NOT A BARE COLON — the first version refused a good URL.**
`[a-z0-9+.-]*` happily matches `example.com`, so `example.com:8080/book` was read as the scheme
"example.com:" and rejected. Requiring the slashes still catches both dangerous shapes by two
different routes: an opaque `javascript:alert(1)` gets the `https://` prefix and `new URL` throws
on its non-numeric "port", while `javascript://…` keeps its protocol and the allow-list refuses
it. Both measured, along with a hostname-needs-a-dot rule (a bare `rotorooter` is a typo here,
not an intranet host, and finding out mid-demo is worse than being told now).

⚠️ **THE INPUT SELECTS ALL AND SCROLLS BACK TO THE START, and `setSelectionRange(…, "backward")`
IS NOT ENOUGH ON ITS OWN.** A plain `.select()` leaves the caret at the end and the field follows
it, so the tracked default — which is mostly query string — opened showing `…&rwg_token=AE37R_…`
with the domain out of view. Measured after switching to a backward selection: direction came
back `"backward"` and `scrollLeft` was still 16. The explicit `el.scrollLeft = 0` is what does
the work.

⚠️ **OUTSIDE-CLICK IS POINTERDOWN IN THE CAPTURE PHASE**, per the trap the Signal flyout and the
Create-Workflow combobox already record.

⚠️⚠️ **AND ONE "BUG" WAS THE TEST HARNESS — the eleventh in this file.** Enter appeared to do
nothing: the panel stayed open, no error, nothing stored, while a real click on Save worked
perfectly. The Browser pane's `computer {action:"key", text:"Return"}` dispatches a **trusted
keydown with an EMPTY `key` and `code`** (logged from a capture-phase listener), so
`e.key === "Enter"` can never match. **Never conclude a key handler is broken from that tool
alone** — dispatch a real `KeyboardEvent` instead, which is how both Enter (saves and closes)
and Escape (closes) were actually confirmed.

Verified end to end with real right-clicks, real typing and real clicks: the panel opens at the
cursor prefilled with where the button goes now; `rotorooter` is refused with "That does not look
like a full web address" and stores nothing; `book.servicetitan.com/tenant/9f2b?campaignId=demo`
saves as `https://…` with their own query intact and the link re-points immediately; reopening
shows Reset plus the full default underneath; Escape, an outside click and Cancel all close; and
Reset restores the tracked default and clears the key. `audit:place` and `audit:ai` green,
typecheck clean.

#### Replicate ENDS in the menu now: Complete, saved, and no navigation (9/15/2026)
Asked for directly: *"when i click replicate, show the progress bar like its doing now, but once
its done, just show complete, but dont go to it, auto save the page, so when the user click book
online it goes to the replicated page."*

The capture already happened before the old version navigated — that is why the wait is in this
panel at all — so opening the replica was the one part that cost something: it threw the SE off
the search screen they were demoing from, and left them to come back and re-point Book online by
hand. The capture is on disk either way, so the useful end of the action is the DESTINATION being
set. On success it now calls `onSet("/replica?url=…")` and reports Complete; the panel stays open.

⚠⚠ **IT WRITES THROUGH `onSet`, NOT A SECOND WRITER**, so it inherits the store's validation, the
per-prospect key, the persistence and the **Reset** that puts the tracked default back — and the
"Default: …" line appears underneath the moment it lands, which is what tells the SE the link was
genuinely re-pointed rather than merely claimed to be.

⚠⚠ **AND THAT IS EXACTLY WHERE IT WOULD HAVE SILENTLY FAILED.** `normalizeUrl` refuses a hostname
with no dot (a real rule: "rotorooter" is a typo, not an intranet host), and a `/replica?url=…`
path has no host at all — so the save would have come back "That does not look like a full web
address" and the SE would see an error where a receipt belongs. Worse, the obvious workaround of
storing `${location.origin}/replica…` fails the SAME rule on **localhost** while working on the
live site, i.e. broken for every SE testing it and fine in production. A **same-origin path branch**
now returns the value verbatim, above every other rule.
⚠ **`//host/path` IS EXCLUDED** — a protocol-relative URL is somebody else's origin wearing a
path's clothes. One leading slash cannot carry a scheme, so `javascript:` stays unreachable by
that branch and the existing guard still owns every other shape.

⚠⚠ **AND THE BOX HAS TO BECOME THE REPLICA TOO — leaving it alone was a REAL BUG, reported as
"it still takes me to the real website".** The link genuinely WAS re-pointed; then **Save** stores
whatever sits in the input, which was still the ORIGINAL site URL, silently clobbering the replica
that had just landed. Confirmed from the SE's own stored state: `bookingUrl` held the raw
`https://www.greenixpc.com/contact-us` while a capture of that very page sat on disk. That click
is the natural next move now that the panel **stays open** instead of navigating away, so the old
flow could never expose it — **a change that removes a navigation can make a pre-existing button
reachable at a moment it was never meant for.** It also broke this panel's own rule that the field
shows where the button goes RIGHT NOW. `setValue(replica)` on success fixes all of it: Save
re-saves the same thing, reopening shows it, and there is no way to overwrite it by accident.
⚠ `setValue` fires no `onChange`, so Complete deliberately survives it — only a human editing the
field clears the receipt.

⚠ **THE BAR FINISHES AT 100 RATHER THAN DISAPPEARING.** A progress bar that vanishes at the end is
indistinguishable from one that was cancelled, and this flow no longer navigates away to prove it
worked — so the same row stays, fills, and reads **Complete**, with the button doing the same.
⚠ **`.gs-lnk-prog-done` IS WRITTEN `.gs-lnk-prog .gs-lnk-prog-done` (0,2,0).** `.gs-lnk-prog-pct`
pins `width: 34px` (room for a percentage) and is defined LATER in the file, so a bare class would
TIE and lose on source order — "Complete" clipped to 34px while the rule read perfectly. Same tie
`.ts-tablewrap .ts-table` and `.wf-leaf .wf-leaf-add` exist to win. Verified `scrollWidth ===
clientWidth` on the rendered label.
⚠ **Complete is GREEN, not a faded `:disabled`** — the state is success, not unavailability.
`.gs-lnk-btn` deliberately carries no `:disabled` opacity, so it reads at full strength while
still refusing a second click. **Typing a new URL clears the receipt**, or Complete would be
describing a capture of a different page.

**`npm run audit:replicas` gained 9 checks**: the box becomes the replica so a following Save
cannot clobber it, the replica path stores verbatim with its query untouched, `//host/path` is not treated as same-origin, both `javascript:` shapes are still
refused, the needs-a-dot rule still fires, the success path calls `onSet` with the replica route,
it no longer navigates, the Complete state exists, and editing the URL clears it.
⚠ Verified to FIRE by disabling the path branch and by restoring the navigate (3 red), then
restored to green.

**Verified live on Aptive** with real right-clicks and clicks: Replicate ran to 100%, the page
stayed on `/google-search`, the bar and the button both read Complete in `#6dd58c` with no
clipping, `invoca-demo:booking-url::aptive` held `/replica?url=…`, and "Default: …" appeared
underneath. Book online then opened the replica — Aptive's real form, **1 form / 38 inputs** — the
override survived a reload, and **Reset restored the tracked `oppref` link and cleared the key**.
The unit itself is unchanged: 652x341, 5 actions of which exactly 1 is a link.

#### And the saved link travels with the DEMO now, not just the browser (9/15/2026)
Asked for straight after: *"it should always stay and save even when the users closes it and
opens it the next day."*

⚠️ **THE NEXT-DAY HALF ALREADY HELD, and saying so is the honest start.** localStorage has no
expiry and this store never had a TTL. What made it look otherwise was **me clicking Reset at the
end of the previous verification** and leaving the demo in that state — the SE then saw the real
URL and reasonably read it as the save not sticking. **Finish a verification in the state the
feature is meant to be in**, or the last thing you prove is the teardown.

What localStorage genuinely could NOT do is leave the machine: a colleague opening the same demo,
the same SE on a second laptop, or the live site after a link was saved on localhost, all fell
back to the tracked default with nothing on screen to say why.

⚠⚠ **SO THE VALUE RIDES THE OVERRIDE LAYER THAT ALREADY TRAVELS — no server change, no schema
change, no migration.** `AiAssistantContext`'s store is keyed `<demoId>::<path>`, is written to
localStorage on every change, is PATCHed onto the shared demo record debounced and owner-only, and
is re-hydrated by `hydrateDemo` for anyone who opens that demo. The link is written there as
`bookingUrl` under **`<profileId>::/google-search`** (`bookingScopeKey`, one definition — it is
half of a key the sync slices on, and two copies is how one side writes a key nobody reads).
⚠ **A LIBRARY DEMO'S `profile.id` IS ITS DEMO ID**, which is the whole reason a key built from
`profile.id` lands inside the `<demoId>::` prefix the PATCH effect slices on. A key built any
other way is never synced and **nothing reports it** — which is what the audit pins.

⚠ **`registerBase`, NEVER `registerScope`** — the latter is last-write-wins and would repoint
whatever sparkle the SE has open at this screen's one field. And the base is seeded `""`, so the
first save is a string-to-string write rather than the `undefined -> string` TYPE FLIP `editGuard`
refuses — the trap the greeting, `serviceZips` and the voice picker each had to be let through by
name. Writing through `applyEdits` also inherits `readOnly` on somebody else's demo for free.

⚠⚠ **THE LOCAL KEY SURVIVES AS THE FALLBACK, AND IT IS LOAD-BEARING RATHER THAN LEGACY.**
`applyEdits` returns 0 for a demo the SE may not edit and for a bundled profile that is no library
demo at all — both are real, and in both the SE still needs to point the link at a replica for the
conversation they are having. **Precedence is local, then shared**, and a successful shared save
CLEARS the local copy: a local value therefore exists only when the shared write was refused, i.e.
only when it is genuinely that SE's own and should win on their own machine. Without the clear, an
owner re-pointing the link on one laptop would leave the other reading a stale local copy forever.
⚠ **Reset clears BOTH, unconditionally**, or the old link is back on the next render.

**`npm run audit:replicas` gained 8 more checks** (16 in total for this feature): the scope key is
`<profileId>::<path>`, it is a bare pathname, the base is seeded `""`, it registers a base and not
a scope, a save tries the durable layer first, a successful shared save clears the local copy, the
precedence is local-then-shared, and Reset clears both.
⚠ Three were broken on purpose and seen to fire — renaming the key out of the sync prefix,
inverting the precedence, and leaving the local copy behind.

#### What the page says after a submit — revealed where it exists, pointed at where it does not (9/16/2026)
Asked directly: *"are you able to also replicate what happens when someone click submit. like
sometime it goes to a different page, or sometimes it just says thank you etc."* Answered by
MEASURING the captures rather than guessing, and the three outcomes are genuinely different:

| capture | after submit | in the capture? |
|---|---|---|
| Aptive | an inline thank-you panel with "What happens next" | **yes** — real markup carrying `hidden=""` |
| Greenix | a HubSpot inline message | **no** — only the CSS that would STYLE `.submitted-message`; the text comes from HubSpot's JS |
| Reyes Law, AutoNation | unknown | no trace either way |

**1. Where the page ships its own confirmation, the replica reveals it** — `findConfirmation` +
`revealConfirmation`. This is replication, not invention: the words are the prospect's own and
revealing them is exactly what the site's script does. Aptive renders "Thank You! Dana — A pest
control specialist will contact you shortly…" with its own next-steps list, and the form is
hidden underneath, because a thank-you panel above a still-editable form reads as the submit not
having happened.
⚠ **THREE GUARDS KEEP IT FROM FIRING ON SOMETHING ELSE:** the node must be HIDDEN (an already
visible one is page furniture), must carry ≥12 characters of text (HubSpot leaves a styled EMPTY
shell, and revealing a blank box reads as the page breaking), and must hold no form fields.
⚠ **AND IT MUST FAIL CLOSED**, which is most of the design: Greenix produces zero candidates in
the rendered DOM, so nothing happens and the submit stays silent exactly as before. A generic
"Thanks!" there would be inventing a company's own confirmation copy.
⚠ **A REFUSED SUBMIT SHOWS NOTHING.** `onSubmit` returns whether a lead was created, and the
reveal is gated on it — otherwise the screen thanks someone while an error says it failed.
⚠ **THE NAME SLOT IS THE PAGE'S OWN.** Aptive leaves `<span class="…thankyou-name"></span>` for
its script; filling an EMPTY such element is still replication. ⚠ It reads the MAPPED lead, not
the raw field bag — written as `values.name` first, which silently left it blank because `values`
is keyed by the form's own input names (`firstName`, `hs-firstname`, `wpforms[fields][3]`).

**2. Where it does not, the SE points at the real page** — an "After submit, show" field on the
same Book online menu, stored beside the booking link in the SAME object (they describe one page;
a second store is a second thing to forget to clear). On a successful submit the frame navigates
there, resolved through the same lookup the main frame uses, so a captured page is instant and an
uncaptured one still works through the live fetch.
⚠ **RESOLVED WHEN THE PAGE OPENS, READ THROUGH A REF.** Looking it up on submit would put a round
trip in the one moment anyone is watching; and putting it in the bind effect's deps would RE-WIRE
every form each time it resolved — while a plain closure read would be the empty string exactly
when it matters, since the lookup lands after the first bind.
⚠ **`thankYouUrl` HAD TO JOIN `CREATABLE_WHEN_ABSENT`.** A demo that saved a booking link before
this field existed has an override of `{ bookingUrl }` alone, so the first write on exactly those
demos is an `undefined -> string` flip — it would have worked on a fresh demo and silently failed
on the ones most likely to be set up already. Fourth time this trap is recorded here.
⚠ **THE SE'S PAGE WINS OVER A BLOCK WE MERELY RECOGNISED**, and **Reset clears both** — a
post-submit page outliving the link it belonged to is the same stale leftover.
⚠ **NO LOCAL FALLBACK FOR THIS ONE, deliberately**, unlike the booking link: a post-submit page is
part of how the demo is BUILT, so it belongs to the demo or nowhere. A refusal says so rather than
no-opping.

**`npm run audit:replicas` gained 11 checks**; two were broken on purpose and seen to fire (the
empty-shell guard, the created-lead gate). ⚠ Three EXISTING checks had to be **re-aimed** when the
store gained a second field — same invariants, new shape.

**Verified with real clicks on both paths**: Aptive's own panel appears with the form hidden and
the name filled; Greenix finds nothing and stays silent; and with an after-submit page set, a
Reyes Law submit created the lead AND swapped the frame to that page's capture.

#### ⚠⚠ "Replicate said Complete and Book online opens a BLANK page" — on PRODUCTION only (9/15/2026)
Reported the moment `BROWSERLESS_TOKEN` went live. The capture had genuinely been made; the
screen framed a path that does not exist on a deploy, and **nothing anywhere reported a
failure** — which is what made it blank rather than broken.

The chain, confirmed on the live site rather than reasoned about:
1. `replicaPages.ts` registers `aptivepestcontrol.com` → the STATIC `public/replicas/aptive.html`.
2. `ReplicaPage` short-circuited on that registry **in the browser** and never asked the server.
3. It framed `/replicas/aptive.html`.
4. That file is **git-ignored on purpose** (megabytes; pruned after 10 days), so no deploy has it.
5. `express.static` missed — and `app.get("*")` served **`index.html` INTO THE IFRAME**. Measured
   live: that URL returned **200** carrying `<div id="root">` and `/assets/index-…`. The app
   rendered itself inside the frame with no route: blank.
6. Meanwhile the capture Browserless had just made sat unused in the dynamic store.

⚠⚠ **THE ROOT CAUSE IS A CLIENT ASSERTING SOMETHING ONLY THE SERVER CAN KNOW.** A registry
compiled into the bundle cannot tell you what is on the server's disk. Three guards now, because
any one alone still leaves a silent blank frame:
- **the page asks the server** — the `replicaFor`/`replicaBySlug` short-circuit is gone, and the
  `undefined` "still checking" state it already modelled is what makes the extra hop invisible;
- **lookup checks the file** before claiming a static hit (BOTH twins, BOTH branches), so the
  registry fails CLOSED and falls through to the dynamic store;
- **`/replicas/*` 404s** rather than reaching the SPA catch-all — registered BEFORE it, or it can
  never run, which the audit pins separately from the route's existence.

⚠ **A DEPLOY-ONLY BUG, AND THAT IS WHY IT SURVIVED EVERY LOCAL CHECK.** This machine has both
captures, so the static path resolved and the page was correct here every single time. Reproduced
by moving `public/replicas/aptive.html` aside: the page then framed the SPA shell exactly as
production did, and after the fix served the real capture ("Build a Plan – Aptive Pest Control",
1 form, 38 inputs). Restoring the file, the static path still works — both verified.
⚠ **AND THE VITE CONFIG IS READ AT STARTUP**: the API fix looked like it had not worked until the
dev server was restarted, which is this file's Node-cache caveat wearing a different hat.

**`npm run audit:replicas` gained 5 checks** — both twins' branches, the 404 guard, its ORDER
against the catch-all, and the page no longer reading the registry. Two were broken on purpose
and seen to fire (moving the guard after the catch-all, restoring the short-circuit).

#### The submit button WAS replicated — it was clipped out of its own frame (9/15/2026)
Reported directly: *"you need to also make sure that the submission button is also always
replicated, for example i dont see one for greenix"*, alongside *"if i hit submit, would you be
able to see the values of these fields."*

⚠⚠ **I HAD ALREADY MIS-REPORTED THIS ONCE, AND THE MISTAKE IS THE ONE THIS FILE KEEPS
RECORDING.** I said the Greenix replica rendered "0 form fields in the DOM" — measured on the
replica frame's document only. Walking one level further finds **1 form, 25 inputs and a real
Submit** inside the HubSpot embed. `replicaDocs` had always handled that (its own header names
greenixpc.com as the reason it exists); my probe did not. **When a probe says a page has nothing,
walk further in before believing it** — the same shape as the record tiles, the nav bar and the
`background-image` marks.

**The real defect was geometry.** Measured on that replica: the HubSpot frame renders **402x498**
while its own document is **600** tall, putting Submit at **527** — 29px past the bottom edge,
with no scrollbar to reach it. A third-party embed is normally grown by its own script posting a
height to the host page, and that script is precisely what a replica strips, so the frame stays
frozen at whatever height it was captured with. The button was captured, neutralised, wired and
working; it simply was not on screen.

`fitEmbeddedFrames(doc)` grows every same-origin **form** frame to its content height, called on
bind and again at 600ms once fonts and images have settled. Measured after: the frame is 600 and
Submit sits **219px inside it**.
⚠ **IT ONLY EVER GROWS** — shrinking would clip an embed deliberately taller than its document,
and nothing here knows which is which. ⚠ **FORM FRAMES ONLY** — a chat widget or an ad iframe
reports a tall document too, and stretching those pushes the real page apart for nothing.

**So yes, a submit delivers the values — verified with a real click rather than asserted.** Filled
the nested HubSpot form and pressed its own Submit: a lead was captured reading name
"Dana Whitfield", contact "(602) 555-0147", `location: "Phoenix"` (ZIP 85018 resolved through
`/api/zip`), `source: "web"` — and **"Aptive - SMS - Quote Request (Dana)" appeared in the Agent
Studio table**, so the whole replicate → lead → workflow chain runs from a form inside a frame.
⚠⚠ **A PROBE FAULT WORTH RECORDING, because it looked exactly like a bug in the field map.** The
first submit stored `contact: "+1"`. HubSpot's phone widget is TWO inputs — a visible `type=tel`
with **no name** (id `phone-8e0d2466…`, which is what the stored field map points at) and a
HIDDEN `name="phone"` twin its script normally syncs. My fill targeted `input[name^=phone]` and
hit the hidden one, so the read returned the visible field's placeholder `+1`. Typing into the
field a human actually uses returns the number in full. **Fill what the map names, not what the
name looks like.**

⚠ **AND A WEB-FORM LEAD WAS LISTING UNDER AN LSA TRIGGER.** `triggeredBy` was pinned to
"Google Local Services ad — quote request submitted", so a lead filled in on the prospect's own
replicated booking page showed that in Agent Studio's **Triggered By** column — contradicting the
page the SE had just submitted in front of the room. It reads `q.source`, the same flag the
opener's channel phrase already uses, rather than a second one that can drift out of step.

**`npm run audit:replicas` gained 6 checks**: the fit exists, only grows, is form-frames-only,
runs twice, clears its timer, and the trigger line names the real source. Three were broken on
purpose and seen to fire (letting it shrink, letting it stretch every iframe, restoring the
hardcoded trigger).

**Verified end to end against the real server, not by construction.** Saving wrote
`customizations.overrides["/google-search"].bookingUrl` into `.data/demos/aptive.json` with
`updatedAt` bumped; **deleting every local trace** (the store key and the legacy key), reloading,
and reopening the demo from the Launch library brought the link back **from the record** and Book
online rendered `/replica?url=…` again. Reset then wrote `bookingUrl: ""` through to that same
file and the link returned to the tracked `oppref` default. The unit is unchanged at 652x341 with
5 actions, exactly 1 a link — and Aptive is left **saved**, pointing at its replica.

## Read.Me + the in-app docs
- A **row in the launch menu** (`src/components/LaunchMenu.tsx`), not its own button — see the
  hamburger section below. It was `ReadmeButton.tsx`, a fixed bottom-right pill styled
  `.readme-fab`, until the corner stack was folded into one menu on 9/10/2026; that component
  and its CSS are **deleted**, not merely unmounted.
- **It renders ONLY on the launch form** (`MENU_ON` in `App.tsx`). Everything past that form
  is a replica of Invoca's product shown to a prospect, and an internal-docs affordance on a
  dashboard reads as ours rather than theirs. The launch form is the one screen that IS our
  tool. It is an ALLOW-list, not a deny-list, so a new route defaults to not carrying it.
- ⚠️ **NO OVERLAY-HIDE CSS RULES, AND THEY MUST NOT COME BACK.** `.aiad`, `.idr-root`,
  `.sdr-root` and `.vp-root` all live inside the app shell, which the launch form is not part
  of, so such selectors could never match. What DOES matter is the z-order: `.lm-root` is
  z-1000, deliberately under `.fb-overlay` (1400), so the Support modal covers the hamburger
  instead of competing with it (asserted by hit-testing the toggle's centre while the modal is
  open — it returns `.fb-overlay`).
  ❌ **A LATER BULLET IN THIS SECTION CLAIMED THE OPPOSITE and was stale for months** — it
  described the button being hidden via `body:has(.aiad--open)` etc. Those rules were removed
  long before this change; the bullet is deleted below rather than left to contradict this one.
- **The docs ship with the app.** `public/readme.html` is copied into `dist/` by the build and
  served by `express.static`, so `/readme.html` works on Render, on `npm run serve`, and in
  dev. No external host, no claude.ai account needed. Opens in a new tab so an SE mid-demo
  doesn't lose their place. Two tabs inside it: "The short version" and "Technical detail".
- **It reads its own deployment.** A small inline script fetches `/api/status` (public, counts
  and booleans only) and fills the commit SHA and *every* printed demo count. The count is a
  **class** (`.s-demos`, 8 instances incl. one SVG `<tspan>`), not an id -- wiring only the
  masthead left the prose saying 58 while the chip said 9. Writes are guarded: off Render
  `commitShort` is null, so the printed SHA stands. Update that printed SHA when it drifts.
- `.mast` / `.tabs` sit **outside** `.wrap`, so they must not carry `.wrap`'s negative inset
  margins -- `margin: 0 -30px` there pushed 60px past the viewport and scrolled the whole page
  sideways. They're full-bleed already; padding alone gets the look.
- **Two different demo counts, both correct.** `/api/status.demos` is `listDemos().length`,
  the shared library on the server disk -- that is what the doc prints. The Launch picker's
  "My demos" adds locally-registered profiles that were never published, so it reads higher.
  Don't "fix" one to match the other.
- `ARCHITECTURE.md` is the Markdown source of truth; keep it and `readme.html` in sync.

## `.env` and the dev server (a silent-config trap)
- `vite.config.ts` reads `.env` with `loadEnv()`, which returns an OBJECT and does **not**
  populate `process.env`. The API plugins are handed the few values they need explicitly,
  but the **engine modules they dynamically import read `process.env` directly**
  (`DEMO_ADMIN_EMAILS` in `demoApi`, `SMTP_*` in `mailer`, `DATA_DIR` in `demoStore`).
  Under `npm run dev` all of those were empty regardless of what `.env` said.
- Symptoms are silent, which is why this cost time: admin-only UI simply never appeared
  locally, and a completion email would never have sent while the code looked correct.
- Fixed at the top of `defineConfig`: every `loadEnv` key is copied onto `process.env`
  unless a real shell variable already set it (so `FOO=1 npm run dev` still wins).
- `npm start` / `npm run serve` were never affected: they use
  `node --env-file-if-exists=.env`, which populates `process.env` properly.
- **Engine changes need a dev-server RESTART**, not just a save: those modules are
  dynamically imported and Node-cached. A stale one answers new routes with the old
  shape, which is how `?summary=1` came back as a full list.

## Generation: optional fields become REQUIRED (a real bug, twice bitten)
- `toSchema()` in `engine/core.ts` runs `sanitize()`, which sets
  `required = Object.keys(properties)` on every object. That is deliberate (strict
  structured output has no optionals) and it means **every `.optional()` field in a
  generated type is forced onto the model**.
- That is fine for content the model should invent, and **wrong for any field the APP
  writes later**. `InteractionRow.cells` is written by `columnEdits` when a column is
  added; forcing it made the model emit a 2-entry `cells` against 6 `dimensionColumns`,
  and `leadingCells` preferred it, so the Digital Journey report rendered an interaction
  count under "Marketing Source" and revenue under "Marketing Medium" while the six
  correct values sat unused in the same row. Hit `autonation` (a bundled seed, in git)
  and every demo generated after 2026-08-04.
- **Fix pattern**: generate with a type that omits app-owned fields, e.g.
  `DIGITAL_INSIGHTS_GEN = DigitalInsightsReport.extend({ rows: z.array(InteractionRow.omit({ cells: true })) })`.
  Adding a new app-written row field? Add it to that omit list in the same commit.
- **`leadingCells` now only trusts `cells` when `cells.length === headers.length`.** A
  mismatched array is damage, not data, so it falls back to the named fields. This is
  what makes demos ALREADY saved with the bad array render correctly, including live ones
  nobody is going to re-generate.
- **Four layers now stop this recurring**, because the schema omit alone is one edit away
  from being undone:
  1. `DIGITAL_INSIGHTS_GEN` omits app-owned fields from the generation schema.
  2. `stripAppOwnedFields()` deletes them from the result anyway, whatever comes back.
  3. `auditProfile()` (engine/canary.ts) has four Digital Journey checks: canonical
     dimension columns, no app-owned `cells`, signals aligned to signalColumns, and no
     blank marketing values. The nightly canary runs them on a fresh prospect.
  4. `npm run audit` runs those SAME rules over every seed in `src/data/generated` and
     every local demo in `.data/demos`, exits non-zero on failure, needs no network.
     Run it before a push that touches the engine or the report.
  Each check was verified to FAIL on its own broken shape, not merely to pass on good data.
- Switching profiles in a test: `invoca-demo:activeId` is a **raw string**, not JSON.
  `JSON.stringify(id)` writes `"autonation"` with quotes, no profile matches, and the app
  silently falls back to Shady Blinds, so the test "passes" against the wrong prospect.

## Conventions & decisions
- **Data-driven**: never hard-code screen data in components; put it in the profile/schema.
- **Re-skin EVERY data point to the prospect's vertical.** No industry-specific wording is
  hard-coded — the engine generates all labels/values for the business (products, campaigns,
  locations, call reasons, conversion events, customer terminology, transcript, Q&A…). Each
  generation prompt is prefixed with a shared `reskin(name)` directive (in `engine/core.ts`)
  that says: use THIS vertical's terminology everywhere, keep each section's STRUCTURE
  identical (column/group/series counts), only wording + numbers change. Just a few platform
  labels stay verbatim: "Marketing Source/Medium/Campaign/Search Term", "Call Count",
  "Total Revenue (Sale Amount)".
  - **Canonical terms** are chosen once (in the fast `generateTerms` prefix call) and threaded through every
    section for consistency: **`bookingTerm`** (Title-Case singular: "Consultation" |
    "Appointment" | "Estimate" | "Tour" | "Test Drive"…) and **customerNoun** ("Customer" |
    "Patient" | "Member" | "Client" | "Guest"…). `bookingTerm` is stored on the profile
    (`profile.bookingTerm`) and read by UI (Agent Workflow leaf "Schedule `<bookingTerm>`");
    it drives Digital Insights signals ("`<bookingTerm>` Discussed/Booked"), Marketing
    dashboard ("`<bookingTerm>` Set"), Ops dashboard ("`<bookingTerm>`: Scheduled"),
    Conversation Intelligence ("`<bookingTerm>`: Scheduled"). `customerNoun` drives the Ops
    "Caller Type: New/Existing `<customerNoun>`" labels + CI signal. The SMS agent also has
    `agentConfig.smsPlaybook` (bookingType + modality, qualifying questions, offer, etc.).
  - Two MORE canonical conversion terms come from `report` (`ReportOutput`) — **`qualifiedCallTerm`**
    (the sales-qualified inbound call, e.g. "Sales Call"/"Residency Inquiry"/"New Patient Call")
    and **`conversionTerm`** (the won revenue outcome, e.g. "Purchase"/"Move-In"/"Job Won") —
    threaded into the conversion dashboards (**Marketing Performance, AI Agent Conversion, AI
    Messaging Impact**) so their funnel labels are IDENTICAL across the platform (no more
    per-dashboard drift like "Sales Call"/"Job Complete"/"In-Home Tour"). These two are
    engine-internal (used at generation time; not persisted on the profile). AI Messaging's
    booking labels all use `bookingTerm` (never "In-Home <bookingTerm>" or "Appointment").
    ⚠️ QM dashboards still use their own "Sales Quality Score"/"Sales Opportunities" wording
    (Invoca product-feature names, not yet canonicalized).
  - When adding a screen with any industry-specific label, read it from the profile
    (`bookingTerm`) or generate it per-business — never type "Consultation"/"Customer"/
    "Appointment"/product terms literally.
- **One canonical profile** feeds all screens (consistency across screens is the whole point).
- **Exact-copy** (saved real HTML) is used ONLY for pages that are identical for every
  customer and must be pixel-perfect (marketing/3rd-party consoles). Everything
  customer-specific is profile-driven React.
- **TypeScript + Zod** chosen deliberately (multi-dev, evolving schema): changing the
  schema surfaces every screen that needs updating at compile time.
- **⚠️ ALWAYS ASK the user which URL to read/build from before replicating any screen.**
  (Also saved in user memory.) Don't pick a screen/variant yourself.
- **⚠️ A CHANGE FOR ONE SCREEN STAYS ON THAT SCREEN.** When the user asks for something on a
  named tab ("on Insights & Analytics…", "on this dashboard…"), no other screen may change
  look or behaviour — even when the fix lives in a component six screens share, and even when
  the change would arguably improve them too. Widening the blast radius is a separate ask.
  The pattern for shared components is **OPT-IN props defaulted to today's behaviour**:
  `DonutChart` grew `colors`, `onSlice`, `slicePct`, `label` and `geom` this way, so Insights
  gets a 740×340 box with `name - count (pct%)` labels, no inner percent, column-aligned
  labels and a click-to-drawer, while the six dashboards keep 350×260, their inner percents,
  name-only labels and no cursor. Same rule for CSS: scope it (`.ind-page .donut-svg`), never
  edit the shared selector. THEN PROVE IT — load one of the other screens and assert the old
  values (see the Insights donut work: viewBox, inside-percent count, label text, font size,
  max-width and cursor all re-checked on `/dashboards/marketing`). Two earlier violations
  were caught only because someone looked: an `.ind-split` change would have narrowed every
  breakdown, and a label-alignment fix was moments from moving labels on all seven donuts.

## How a screen gets built (workflow) + environment
The proven loop for replicating an Invoca screen (used for report, dashboard, Call
Review, Agent Studio, Manage Dashboards, ops dashboard):
1. User provides the real page's **saved HTML + `_files/` + a screenshot + the URL**
   (ALWAYS ask for the URL first — see conventions). Assets live in
   `~/Documents/Lovable Project/*.html`.
2. These are heavy SPAs whose CSS is JS-injected (emotion), so the static save renders
   UNSTYLED. Method: copy to the scratchpad, strip `<script>` tags, serve over a local
   `python3 -m http.server`, open in the Browser-pane, and read **computed styles** off
   the live DOM (colors/fonts/px) + extract structure/labels/SVG icon paths via grep.
   When emotion CSS is absent, measure from the screenshot + reuse our tokens, then
   iterate visually against the screenshot.
3. Build the React screen + data (in `shadyBlinds.ts`), reusing existing CSS/components;
   verify in the Browser-pane preview at the screenshot's width; iterate pixel-by-pixel.

**Dev server / preview:** `.claude/launch.json` defines `invoca-demo` (npm run dev on
port 5173, autoPort:false). Start/refresh with `preview_start {name:"invoca-demo"}`;
it holds the app in the Browser pane. Navigate within it via `preview_eval`
(`location.assign('/path')`) and check with `preview_screenshot` / `preview_eval`
(the `mcp__Claude_Browser__navigate` tool is not always available; preview_* are).
`npm run dev` reads `.env` for `ANTHROPIC_API_KEY` (powers `/api/generate`).

## Status summary
- ✅ Foundation: Vite/React/TS/Zod/Router, tokens, components, app shell, 14-item nav
- ✅ **Digital Journey report** — pixel-matched, signal columns, per-customer
- ✅ **Marketing Performance dashboard** — pixel-matched (white tile cards, KPI tiles 147px
  tall w/ 4×63px `#f5f6fa` dividers, donut cards 460px w/ height capped, split metrics 440px)
- ✅ **Call Review** — filter box is a `#f5f6fa` independently-scrolling panel (full height);
  gray tiles on white; score weight 400
- ✅ **Agent Studio** — one agent + 2 workflows from `customerName`
- ✅ **Manage Dashboards** — Dashboards nav lands here; lists all four dashboards
- ✅ **Marketing & Operations dashboard** (`/dashboards/marketing-ops`) — `HBarChart`
  (bars 42px; labels hug left via `--hbar-lw:96px` + small left padding; continuous
  vertical gridlines via a single `.hbar-grid` overlay over the track area — matched
  to the real Invoca), even-column tables (`.ops-page .dash-table` fixed layout),
  existing-customers card = 1 big + 2 aligned percents
- ✅ **Launch screen** (`/` and `/launch`) + live generation via `/api/generate`;
  generated profiles persist (files + localStorage); customer name shown, not network name
- ✅ **Engine** — 17 phases (research→report→dashboard→callReview→callDetail→opsDashboard→aiAgentConversion→aiMessagingImpact→conversationIntelligence→smsConversationIntelligence→voiceConversationIntelligence→agentConfig→qualityManagement→qmInstantInsights→screenpops→voiceRoutingDemo), verified (streaming; re-skin confirmed on a gym: Tour/Member). qualityManagement + last 2 phases (Haiku) re-skin the QM dashboard + 3 Gumloop artifacts per prospect. **SingleFile browser extension** is the way to capture a real Invoca (emotion/MUI SPA) page as self-contained standalone HTML (renders styled, unlike native "Webpage, Complete")
  live on Terminix; ran on Mavis earlier
- ✅ Integrations + Google Ads — exact static copies, click-through verified
- Seed: `shady-blinds` (reference, hand-authored — the working instance), `mavis`.
  Generated files: `mavis-tires-and-brakes`, `terminix`, `davy-tree`.
- **Working style (from user, in memory):** iterate on Shady Blinds directly; mirror any
  NEW data-driven feature into `engine/core.ts` so new prospects get it. Pure design
  changes are shared CSS and apply to everyone.

## A fourth Launch-screen dropdown: "2026 Dallas Invoca Summit" (9/9/2026)

Asked for directly: *"Can you another drop down under Team Demos call '2026 Dallas Invoca
Summit'."* — a new section between **Team Demos** and **Samples** on the Launch screen's demo
library.

⚠️ **DELIBERATELY UNWIRED — asked, and the user's own answer.** Offered three ways to
populate it (tag specific existing demos now, add a per-row "move to Dallas Summit" action, or
just the empty section with wiring as a follow-up); the user picked the third. So `EntryGroup`
gained a fourth member, `"dallas"`, that nothing currently assigns — no demo carries it, and
there is no UI action that would.

⚠️⚠️ **EVERY OTHER SECTION HIDES ITSELF WHEN EMPTY, so adding the group alone would have
rendered NOTHING.** `GROUP_ORDER.map` already dropped a section with zero rows
(`if (!rows.length) return null`), which is right for My/Team/Samples — an empty "Samples"
would be a rendering bug — and wrong for a placeholder whose whole point is to be visible
before anything is tagged into it. `GROUP_ORDER` entries now carry an optional third element,
`alwaysShow`, set only on this one; the skip becomes `if (!rows.length && !alwaysShow) return
null`.

⚠️ **THE EMPTY-STATE COPY NEEDED ITS OWN BRANCH TOO.** `LibraryPicker`'s dropdown showed
`Nothing matches "{query}"` whenever the filtered list was empty — correct for a real miss, and
misleading here: with no query typed it would have printed `Nothing matches ""`, blaming a
search that never happened. Branches on `entries.length === 0` (no rows exist at all, not just
none matching) to show **"No demos in this section yet."** instead.

Verified live: the section renders at position 3 of 4 reading "2026 DALLAS INVOCA SUMMIT · 0",
opens to the new empty-state copy, and Team Demos and Samples on either side of it are
unaffected (Team Demos still opens and lists its one real row, Discount Tire).

✅ **SUPERSEDED — the section is populated now.** This previously ended "NOTHING TAGS A DEMO
INTO IT YET… that is its own follow-up". The follow-up arrived the same day; see the section
directly below.

## The 59-prospect Dallas Summit roster, and the EVENT store it needed (9/9/2026)

Asked for with a spreadsheet attached (`Companies_-_2026_Dallas_Invoca_Summit_with_websites.xlsx`,
59 rows of name + website): *"i want you to create all of these prospects, i have shared their
name and URL, and i want you to only add them to the '2026 dallas Invoc Summit' drop down."*

### ⚠️⚠️ NEITHER EXISTING STORE FITS A ROSTER, AND ONE OF THEM WOULD HAVE QUINTUPLED THE BUNDLE
This is the decision the whole change rests on. There were two obvious homes and both are wrong:

| store | why not |
|---|---|
| `src/data/generated/*.json` | loaded by an **EAGER `import.meta.glob`** and Zod-parsed at boot, so every file lands in the single JS bundle. Measured: profiles are **~155KB each**, so 59 of them is **~9MB on top of a 1.85MB bundle** — and the single bundle is load-bearing for the service worker. They would also all appear in the customer switcher and under "My demos", which is the opposite of the ask. |
| `DATA_DIR/demos` | the RIGHT shape (fetched one at a time, shared by the team) but it is a **git-ignored disk**, so nothing generated locally ever reaches production. |

So the profiles are committed under **`engine/event-seeds/`** — outside `src/`, where the glob
cannot see them — and `engine/eventSeeds.ts` imports them into the library **at boot**, beside
the dash sweep and the demo patches. They travel with a `git push` and cost the browser nothing
until somebody opens one.
⚠️ **EXISTING RECORDS ARE NEVER OVERWRITTEN, and "already in the store" is the guard rather than
a marker file.** Both boot migrations use a marker; this must not, because a redeploy mid-
conference would then clobber whatever an SE had just edited on a roster demo. Asserted by
mutating a seeded demo and reimporting.
⚠️ **Boot migrations run in `server.ts` ONLY** (the Vite dev server does not run them), which
this file already records — so `npm run seed:events` exists to populate a local `.data` without
booting the prod entry.

### ⚠️⚠️ EVERY SEEDED ID IS PREFIXED `dallas-`, AND THE COLLISION IS REAL, NOT HYPOTHETICAL
Two of the 59 — **AutoNation** and **Goosehead Insurance** — already exist as BUNDLED profiles
under exactly the slug a clean name produces, and the shared library holds 200+ more demos whose
ids nobody is checking against this list. An unprefixed collision **does not error**: the seeder
finds the id taken and SKIPS it, so that prospect is silently absent from the conference roster,
and a bundled profile sharing an id drops out of its own Launch section too. `dallasDemoId(slug)`
in `src/data/eventDemos.ts` is the one definition. `audit:events` asserts the prefix is
**load-bearing** — it fails if no roster slug clashes any more, so the prefix cannot come to look
like dead ceremony and get dropped.

### `DemoRecord.event` is what files a demo under its own dropdown
Optional, so all 234 records already on the disk keep loading. `DemoSummary` is the record minus
the heavy payload, so it reaches `/api/demos` for free. Launch groups on it:
`d.event === DALLAS_EVENT ? "dallas" : mine ? "mine" : "team"` — an event demo is filed under its
event **whoever owns it**, because the roster is the point, not whose copy it is.
⚠️ **ONE DEFINITION OF THE KEY, `src/data/eventDemos.ts`** — the seeder WRITES it and Launch
READS it, and two copies is how one side ends up reading a key nobody writes: the demo renders in
**no section at all** and nothing errors. Same trap as `smsWorkflowScopePath`. The module carries
no React import so `engine/` can use it (engine → src is the existing direction).
⚠️ **PATCH preserves it** (it spreads the record), so an SE editing a roster demo keeps it in the
roster. **A DUPLICATE deliberately does NOT** — `createDemo` never sets `event`, so a copy lands
in "My demos", which is right: a duplicate is that SE's own working demo. Both asserted.
⚠️ **The Dallas section KEEPS its "always show even when empty" flag** even now that it has rows.
Its rows come from the SERVER, and with the library unreachable the app falls back to local
profiles only — a conference roster that silently vanishes reads as the demos having been deleted
rather than as an offline library.

### The names are cleaned, and the spreadsheet name stays searchable
The user's choice when offered verbatim vs cleaned. `prospect` is what every screen shows **and
what the voice agent says out loud**, so "H. LEE MOFFITT CANCER CENTER AND RESEARCH INSTITUTE,
INC." became **Moffitt Cancer Center** and 28 other rows lost an LLC/Inc./Corporation suffix or
gained proper casing (`JPMC` → JPMorgan Chase, `Task Us` → TaskUs, `Health Markets` →
HealthMarkets, `University of Texas Southwestern Medical Center` → UT Southwestern Medical
Center).
⚠️ **SINGLE-WORD BRAND CAPS ARE PRESERVED — DIRECTV, TRG, HCL, DECA, MB2, CHRISTUS.** The first
version of the audit's ALL-CAPS check failed **DIRECTV**, i.e. reddened on correct data, which is
how a check gets deleted as a nuisance. It requires MULTI-WORD all-caps now.
⚠️ **`DemoRecord.listedAs` keeps the verbatim row searchable**, because the Launch filter is a
substring match on the DISPLAYED name — so pasting "Acuity Eyecare Holdings, LLC" off the original
list would have found nothing, the query being longer than "Acuity Eyecare". Read from the roster
JSON by the seeder so the two cannot disagree, and **absent** where the name was not changed
rather than duplicating the same string twice.
⚠️ The roster (`scripts/dallas-roster.json`) is verified **row for row against the .xlsx** — all
59 `listedAs` and all 59 URLs match column A and column B exactly, so the cleanup can be re-read
against the source at any time.

### Generating 59 of them: `npm run gen:events`
⚠️ **RESUMABLE BY CONSTRUCTION, and that is not polish.** A prospect whose seed file already
exists is skipped, so a run that dies at prospect 40 is restarted with the same command. The
roster is a couple of hours of Opus; a rate limit or a dropped connection is a normal event over
that window, not an exceptional one.
⚠️ **A SHARED CURSOR, NOT FIXED-SIZE BATCHES.** A batch only finishes when its slowest member
does, and research time swings with site size (this file already measures 60s vs 85s across two
prospects), so batching spends a large fraction of the wall clock with idle slots.
`--parallel N` × the engine's own 6-wide pool is the real concurrency — keep N low.
⚠️ **`--limit` was used for a 3-prospect pilot before spending the rest**, on the user's own
choice: the systemic risk here is the wiring, and finding it after 59 runs costs the whole roster.
`--list` prints what is done and what is left.

**`npm run audit:events` (also run by `npm run audit`)** — the roster half is 9 checks (count,
unique slugs, valid ids, the prefix, complete rows, the prefix being load-bearing, no prefixed
clash, multi-word caps, corporate suffixes); the seeder half RUNS the real `importEventSeeds`
against a **throwaway `DATA_DIR`** (set before importing `demoStore`, which resolves it at module
load) and reads the records back — event key present, `profile.id === id`, library metadata,
an owner, `listedAs` agreeing with the roster, and a reimport adding nothing while an edited demo
survives; then 10 wiring checks over comment-stripped source.
⚠️ Each was broken on purpose and seen to fire: an ALL-CAPS name, a duplicate slug, removing the
dallas grouping from Launch, and stubbing out `importEventSeeds()` in server.ts each turned one
red, and all went green again on restore.

### Result: 59 of 59, and the two defects the new prospects exposed
**56 generated in 69.3 minutes at `--parallel 3`, 0 failures** (plus the 3-prospect pilot).
Measured: ~190s per prospect against the canary's 151s solo, so 3-wide contention costs ~25%
per run and still triples throughput. **4 API 500s, all on `qualityManagement`, all absorbed by
`phase()`'s single retry** — verified afterwards that every one of the 59 carries a full 15-key
`qualityManagement`, so nothing was silently thinned. All 59 Zod-parse, all 17 report slices
present on every one, 59 unique names, and 58 of 59 derive a valid Signal AI Silver/Gold pair
(Methodist Health System **fails closed** — no genuine keyword miss on its transcript, which is
the honest documented outcome rather than an invented rail).

⚠️⚠️ **THE 59 NEW PROSPECTS TURNED `audit:place` RED, AND BOTH CAUSES WERE REAL.** Worth
recording because the roster acted as a much wider test of screens nobody had changed:

**1. Seven prospects fell back to Santa Barbara** — the exact defect the 9/8 note is about,
reappearing not as a regression but as the documented limit of substring matching. Every one
named a real city that simply was not in `CITIES`: Katy, Tyler, Hershey, Nacogdoches, Asheville,
Cerritos, Cornelia. Seven keys added, coordinates from **Places API (New)** `places:searchText`
with a **state-qualified** query and every returned address checked — the bare-city ambiguity
that put Washington in the wrong state and Duluth in Minnesota is what qualifying avoids.
⚠️ The legacy `maps/api/place/textsearch` endpoint is **REQUEST_DENIED — "You're calling a legacy
API"** on this project's key; only Places (New) is enabled, which is what `engine/places.ts`
already uses. Same class of trap as the Geocoding API note.

**2. `offerHook`'s free-booking rule was only on the `offer` branch, and a CAMPAIGN THEME walked
past it.** Rentokil generated a campaign literally named **"Free Site Survey"** while its
`bookingTerm` **is** "Site Survey", so the ad headline promised a free booking — precisely the
claim the other branch refuses. The rule is about what the ad ASSERTS, so it cannot depend on
which field the words came from; `promisesFreeBooking()` now gates both. Verified to fire:
removing it reddens Rentokil again.

⚠️ **AND ONE OF THE TWO FAILURES WAS THE CHECK, NOT THE DATA — the eighth probe fault in this
file.** `audit:place`'s relevance test reported Acuity Eyecare's "Comprehensive Eye Exams &
Medical Eye Care" as *unrelated* to "eye exam near me": `sig()` keeps words of 4+ letters, so
"eye" is dropped, and "exams" is not "exam". Both sides are singularised now, and it still
catches what it was written for — ungating the hero product reddens Roto-Rooter, American Home
Shield, Christian Brothers Automotive and Daikin, so stemming did not neuter it.
⚠️ A NINTH probe fault in the same pass: a one-off sweep of the 59 called `tierView(...).rows`,
but `TierView` carries **`signals`**, and the resulting "Cannot read properties of undefined"
across all 59 read exactly like a broken generation.

⚠️ **THOSE OTHER SUITES ONLY SCAN `src/data/generated` (15 profiles), so the roster is NOT
covered by them** — `audit:leads`, `calllog`, `leaddetail`, `clrecord` and `tiers` all report
"all 15 profiles ok" with 59 new profiles on disk. `audit:place` and `audit:events` are the two
that see the roster. Widening the rest is its own pass; the roster was instead checked directly
(Zod, every slice, `qualityManagement` depth, the tier pairs, lead counts).

⚠️ **THREE ROSTER NAMES ALSO EXIST ELSEWHERE, and all three are correct rather than duplicates.**
`Valet Living` is a second, distinct library record (`dallas-valet-living` beside the pre-existing
`valet-living`), and `AutoNation` / `Goosehead Insurance` sit alongside their BUNDLED profiles —
which is what the id prefix guarantees, and it was verified by id rather than by name. ⚠️ A
name-based leakage probe reported all three as "leaked into My demos" and was wrong; the section
counts (My demos unchanged at 22 while Dallas went to 59) are what settled it.
⚠️ **`AT&T Business` and `AT&T` are two rows in the source list with different URLs**, so they are
deliberately two demos. The ampersand survives to the screen (verified: no `&amp;`).

## The SMS thread header shows a toll-free number, not the prospect's name (9/8/2026)

Asked for directly, against the selected `.sms-namepill` element reading "Orlando Health":
*"For all prospects i want you to change the contact information from the name of the
prospect to a random 1-800 number."*

⚠️ **A REAL IPHONE MESSAGES THREAD ONLY SHOWS A NAME WHEN THE SENDER IS A SAVED CONTACT.**
This is a cold business number texting in, so the mockup was overstating the relationship
even before the ask — digits are the more faithful render, not just what was requested.

`tollFreeNumber(profileId)` lives in its own file, **`src/data/smsContactNumber.ts`**, for
the same reason `workflowChrome.ts` and `workflowRows.ts` are their own files: `PhonePreview.tsx`
imports `useProfile`, which reaches `profiles.ts` and its Vite-only `import.meta.glob`, so
node cannot import that screen and a function stranded inside it could only be grepped, never
called and swept for real collisions across every profile.

⚠️ **DETERMINISTIC, HASHED OFF THE PROFILE ID — NOT `Math.random()`.** This file's own
`newConvBase()` a few lines above is allowed to randomize a `callerId`, because that is a
fresh CONSUMER phoning in on every new conversation. This is the BUSINESS'S OWN number, which
has to be the same every time this prospect's preview opens, or an SE rehearsing the same demo
twice sees a different "800 number" reach out — the same drift this repo already refuses for
the SMS agent's opening line. Verified live: Orlando Health renders `(800) 555-0959` and Shady
Blinds `(800) 555-0673`, both stable across a reload and a page navigation.

⚠️⚠️ **THE FIRST EXCHANGE CHOICE COLLIDED, AND A WIDER ONE WAS ALREADY SITTING IN THIS
REPO'S OWN DATA.** The obvious reserved-for-fiction block is 555-0100 through 555-0199 (100
values), and it collided twice over the 17 real profiles on disk. But this repo's own
generated phone numbers already use the WIDER shape — `555-0184`, `555-0847`, `555-0641`,
`555-0142` all appear elsewhere in this file's own history — i.e. exchange 555 followed by
`0` and three digits, 1,000 values. Switching to that shape gives **zero collisions across
all 23 profiles** (bundled and library), where the narrower block already had two.

**`npm run audit:ai` gained 7 checks**: at least ten real profiles get swept, every number
matches `(800) 555-0XXX`, all are distinct, the number is a pure function of the id, at least
one real id proves the wider 1,000-value range is actually in effect (not just the narrower
555-01XX block), the contact pill calls `tollFreeNumber(profile.id)`, and the old
`profile.customerName` render is gone rather than merely shadowed. Each verified to fire:
narrowing back to 100 values produced a real collision across the 23 profiles, breaking the
format, making the number non-deterministic, and reverting the render call each turned one
red.

Verified in the browser on two prospects: Orlando Health's Preview Agent renders
`(800) 555-0959` and Shady Blinds' renders `(800) 555-0673`, both matching the values computed
directly from `hash(profileId) % 1000`, both surviving a `location.reload()`. `audit:voice`
(107), `audit:place` and `audit:phases` green, typecheck clean, `audit:seeds` unchanged at the
same pre-existing 14 of 34.

## No human-agent QA signals on the AI conversation reports (9/3/2026)

Asked for pointing at "(QA) Proper Greeting" / "(QA) Proper Close" in the AI SMS report's MET
SIGNALS rail: the AI SMS and AI Voice reports "don't need QA signals as there is no human agent
involved."

⚠️ **The `(QA)` prefix is Invoca's own agent-quality category** — what a supervisor grades a rep
against, and the same names carry the Call Review scorecard. On an AI-handled conversation it
passes on every call by construction, so it takes a row in the rail, tells an SE nothing, and
implies a person was on a call whose whole point is that nobody was.

⚠️⚠️ **FIXED AT FOUR PLACES, AND THE RENDER BOUNDARY IS THE ONE THAT MATTERS.** Changing the
prompts alone would have fixed nothing an SE could see: 14 bundled seeds and 11 local library
records were ALREADY generated with these signals, and no prompt reaches data that exists.
  - `src/data/aiSignals.ts` — `withoutAgentQaSignals()`, applied to the merged
    `[...captured, ...seed]` list in `SmsConversationIntelligence` and
    `VoiceConversationIntelligence` **only**. This is what corrects every existing demo, every
    live record on Render (which cannot be regenerated), and any stale `/api/analyze` response,
    with no migration. It matches the `(QA)` PREFIX rather than the two known names, so
    "(QA) Commitment to Help" is caught without another edit.
  - `engine/core.ts` — both AI CI prompts now ask for signals grounded in what the agent
    established (the answers it captured, the product named, an estimate given, a service area
    confirmed) in place of the QA pair.
  - `engine/analyze.ts` — same, for a REAL captured call. This one covers both channels.
  - The data: 100 QA signals stripped from the two AI report blocks across all 25 demo JSONs,
    and Shady Blinds' hand-authored pair replaced with "Service Area: Confirmed" /
    "Estimate Provided", both true of its transcript.

⚠️ **WHAT KEEPS ITS QA SIGNALS, DELIBERATELY** — the human call-log CI
(`ConversationIntelligence`), `CallReview`, and `callDetail`'s scorecard, where agent-quality
scoring IS the subject (the scorecard grades "(QA) Proper Close" 0/10 and that miss is the
story). `insightsCatalog.ts` keeps them too: it lists the signals an account HAS, not the ones
one conversation hit. **Verified by reading the rails after the change** — the two AI reports
render 5 substantive signals each, the human call log still renders all 9 including both QA
rows. `auditProfile` now gates the data so a future generation cannot quietly reintroduce them.

## Ask AI directs the voice agent, on Opus, with a real progress bar (9/3/2026)

Asked for from the voice workflow's drawer: *"you know how I can ask you to change how the
voice agent acts, and does, and what questions it asks, I want the ASK AI to have all the
abilities that you have to change the Voice AI behavior which everything it does. Its ok if it
takes a bit like it does for you, just put the process bar or a percentage."*

⚠️⚠️ **THE GAP WAS THE MODEL, NOT THE DATA MODEL — measured before changing anything.**
`agent.rules[]` already reaches the live prompt verbatim, `agent.informSteps[]` already IS the
call flow, the tree's paths and chips already are what the agent collects and asks for, and
`editGuard` already lets every one of those change LENGTH. So almost anything an SE can
describe was already expressible. What was missing was a model strong enough to turn one
sentence into the six or seven coordinated edits it implies — and a prompt that let it.

**Three changes, in order of how much they mattered:**

**1. `DIRECTOR_MODEL = "claude-opus-5"`, adaptive thinking, `effort: "high"` — on ONE page.**
The gate is `isVoiceAgentPage()`, the same `"agent":` test that already decided whether to
describe the agent at all, so the model choice, the prompt section and the transport cannot
drift apart (`audit:ai` asserts it is one called function, not three copies of the regex).
⚠️ **EVERYTHING ELSE STAYS ON HAIKU AND STAYS INSTANT** — measured after the change: a
dashboard edit still answers in **2.3s** as plain JSON. A voice instruction takes **16 to 22s**.
⚠️ **ADAPTIVE THINKING AND `effort` ARE OPUS-ONLY; Haiku 400s on either**, which `engine/core.ts`
already records for the generation pipeline. The audit asserts neither appears before the fast
path returns, because leaking one there would break Ask AI on every screen in the app.

**2. Streamed, which is a REQUIREMENT and not only a progress bar.** The SDK refuses a
non-streaming call it estimates could exceed 10 minutes — the identical failure recorded at
`structured()` ("silently failing every generation at the ops phase"). The progress events are
what streaming makes possible, not the reason for it.
⚠️ **`thinking: { display: "summarized" }` IS DELIBERATE: "omitted" is the Opus 5 DEFAULT** and
streams thinking blocks with EMPTY text, so the note would render blank and the bar would move
on nothing. Summarized puts the model's own account of what it is doing under the bar.
⚠️ **THE PHASES ARE REAL; THE POSITION WITHIN A PHASE IS ESTIMATED, and the bar never prints
100 before the JSON has parsed.** Thinking and text deltas are distinct events on the wire;
what is unknowable is how far through either one you are, so each creeps toward its own ceiling
(48%, then 94%) and only a parsed result reports 100. Measured in the browser: **15 distinct
samples, monotonic**, fill width tracking the percentage.
⚠️ SSE only when the client asks (`stream: true`), on both twins, with `X-Accel-Buffering: no`
— without it a proxy buffers the whole stream into one jump at the end, which is the exact
thing the bar exists to prevent.

**3. THE PROMPT STOPPED BEING TIMID, which is half the feature.** The old voice section was
accurate and defensive: it named the fields and then forbade the interesting edits — *"leave
them alone unless the user is changing which areas are served"* on `informSteps`, and *"THE
OPENING QUESTION IS TWO-WAY AND STAYS THAT WAY"*. Both were written to stop a WEAK model
wrecking a working agent, and both stopped a strong one doing what was asked. **The guards that
matter are in code** — `editGuard` refuses locked chrome and type flips, `specWithConfig`
validates the voice, `toSteps` normalises a shape — so the prompt now describes how a call is
actually assembled and lets the model use it. It also names the six real voice ids from
`voiceOptions`, so "make it a man's voice" resolves rather than inventing one. `audit:ai` fails
if either fence returns.

**Measured end to end, on the real drawer against the user's own Avi & Co state:**

| asked | what landed |
|---|---|
| "ask whether this is their first Rolex, and if so slow down and be reassuring; switch to a calm mature female voice" | step 1 rewritten, **2 new rules**, `First Rolex` appended to all three sales paths, `agent.voice: "athena"` — all four original rules carried across verbatim, one undo step |
| "add a use case for callers wanting a valuation on a watch they own, route to the trade desk" | a **new path** with its own route and five chips, the **opening question widened to three ways** so callers can reach it, a closing step, and a rule that it never estimates a value on the call |

That second one is the whole point: nobody mentioned the qualifying question, and a new use
case is unreachable without it.

⚠️⚠️ **THE `chips` "BUG" WAS MY PROBE, AND IT IS THE SIXTH TIME IN THIS FILE.** A run appeared to
show the model replacing a path's chips wholesale and deleting the prospect's collected fields.
The chips it had been shown were `undefined`: `scripts/askai-voice.ts` read `u.chips` where the
field is **`u.collect`** (one list, two names — "Its pills, AND what the agent asks for"). Given
real chips it appends per path and keeps each path's own distinct set. The whole-list contract
in the prompt was kept anyway — a short array is indistinguishable from a deliberate removal to
`editGuard`, so instruction is the only lever — but it is a GUARD, not a fix for a bug that
existed.

⚠️ **`scripts/askai-voice.ts` HAD BEEN DEAD SINCE 8/27/2026** and nobody noticed, because it is
only run by hand: it built its tree from `spec.segments`, which stopped existing when the fixed
pair of sales segments became `useCases`. It now takes the use cases from the real
`deriveUseCases` and streams like the drawer does, so it exercises the director path and the SSE
transport rather than a shape and a transport nothing uses. ⚠️ The chrome around them is still
spelled out there: `deriveTree` is private to `AgentWorkflow.tsx`, which reaches `profiles.ts`
and its Vite-only `import.meta.glob`, so Node cannot import it — the same wall that sent the
chrome constants to `workflowChrome.ts`.

**`npm run audit:ai` gained 15 checks**, and each was broken on purpose and seen to fire:
downgrading the model, reverting thinking display, dropping the whole-list contract, restoring
either fence, breaking one twin's buffering header, and letting a dropped stream fall through.
⚠️ That last one matters most: a stream that ends with neither `done` nor `error` must throw,
or the drawer reports success having changed nothing — the silent no-op this file has now
recorded five times.

### The voice Preview Workflow drawer has its own Ask AI + undo, on the LEFT (9/16/2026)
Asked for directly, pointing at the SMS chat drawer's pair: *"just like how the SMS Agent preview
workflow has a Ask AI and undo button in the preview workflow, do it for the Voice Agent preview
workflow as well."*
⚠️ **THE SIDE WAS CORRECTED ON THE SPOT.** It was first asked for "from the right" and built that
way, then immediately corrected to *"the drawer should come on the left side of the screen"* —
which is also what the existing `.aiad--left` note argues for, and the reason is the same one it
records: the thing being configured sits on the right, so a right-hand panel lands on top of it
and its backdrop dims and blocks it.

The SMS chat has carried a sparkle and an undo in its header since 8/26. The voice Preview
Workflow drawer had neither, so the only way to change what the voice agent says was the top-bar
sparkle on the page BEHIND the drawer — reachable only by closing the thing you were looking at.

⚠️⚠️ **IT TARGETS THIS PAGE'S OWN SCOPE, AND THAT IS THE ONE REAL DIFFERENCE FROM THE SMS PAIR.**
`WorkflowChatPreview` has to carry a scope key, `registerBase` it, and keep its own undo stack,
because the SMS agent's config lives on ANOTHER page (Preview Agent) and is shared by both
previews. On a voice workflow there is no such split: `baseAgent` is merged into the very object
the diagram is registered with, precisely so one instruction can reshape the tree and configure
the agent together (see the 8/27 section above). So this pair registers nothing and synthesises
nothing — `pageKey` is `${profileId}::${pathname}`, the same string `usePageData` builds, and the
buttons are a second door onto the scope the top-bar sparkle already edits, opened from where the
SE is actually standing. A pair that grew its own key would be editing a scope nothing renders,
which is the silent no-op this file records six times.
⚠️ **UNDO THEREFORE SHARES THE PAGE'S STACK, which is correct rather than a compromise.** One
scope has one history, and a voice instruction lands on the tree AND the agent at once — two
stacks could undo half of one instruction. Verified: the drawer's undo cleared `agent.greeting`
and all five rules in a single step and went back to "Nothing to undo".

⚠️ **`side: "left"` HAS TO BE PASSED, because the platform default is the right.** Omitting it is
not a neutral choice — `AssistantFocus.side` is `"left"`-only and everything else in the app wants
the right-hand panel with its backdrop — so the audit asserts the left POSITIVELY rather than by
the absence of anything. On the left there is no backdrop, `pointer-events` sit only on the panel,
and the voice drawer beside it stays lit and clickable, including mid-call.

⚠️⚠️ **THE LEFT PANEL RESERVED 412px FOR A 400px CHAT, AND THE VOICE DRAWER IS 500px — so below
about 920px it covered the very thing it had been moved left to keep visible.** Measured before
the fix: 0 overlap at 1092 and 1024, **20px at 900** and **88px at 800**. `body:has(.vp-root)
.aiad--left .aiad-panel` reserves 512 instead, which is 0 overlap at all four widths (at 800 the
panel sits on its own 300px floor and the drawer starts at exactly 300; at 900 there are 12px of
clearance).
⚠️ **KEYED ON THE VOICE DRAWER BEING ON SCREEN, NOT ON WIDENING THE RESERVE FOR EVERYONE.** A
global 512 would have changed the SMS chat's panel at every width under ~924 — a screen that is
signed off. Verified on the SMS page at exactly 900px, the width where the two rules diverge:
`.vp-root` absent, panel still 420, chat at 500, overlap 0. `:has()` is already used in this app
for `HiddenTileStyles`, and it works here regardless of where the two drawers sit relative to each
other in the DOM, which a sibling selector would not.

⚠️ **GATED ON THE REGISTERED DATA'S SHAPE, NOT THE PATHNAME** — the same signal `pageHint` keys
its empty state off. A CREATED workflow deliberately registers no `agent` half, so a sparkle there
would offer to change what an agent says on a page whose whole state is that nothing is
configured, inside a preview that is the minimal greet-classify-hand-off flow. Verified on a real
created Voice workflow: its drawer header has ONLY the close button and zero sparkles.

⚠️ **ITS OWN `.vp-icon-*` PREFIX, not the chat's `.wcp-icon-*`.** Every value is identical today,
which is exactly what makes sharing tempting; one prefix per screen is what stops a value changed
for one drawer restyling the other, and this repo has already paid for that once (79 `.cd-` rules
deleted as collateral by a component rebuild). The blast radius was measured rather than assumed:
rule counts per prefix across `app.css` show `vp` 16 -> 28 and **every other prefix unchanged**.
⚠️ `.vp-title` gained `flex: 1`, because `.vp-head` is `justify-content: space-between` and
without it four children spread themselves across the header instead of grouping the icons at the
right.
⚠️ **HIDDEN UNTIL THE HEADER IS HOVERED**, like the chat's: close is part of the captured drawer
and these two are ours, so at rest the replica still reads as the capture.

**`npm run audit:ai` gained 18 checks** (the pair renders, it targets the page's own key, that key
still matches what `usePageData` builds, it opens an agent focus, it passes `side: "left"`, `left`
is still the opt-in the focus offers, a left drawer still lets the preview take clicks, the 512px
reserve exists and is keyed on the voice drawer, the chat's 412px is untouched, the SMS chat still
opens left, the gate exists AND wraps the buttons, undo respects `readOnly`, no `.wcp-` borrowing,
and the four CSS rules).
⚠️ Six were broken on purpose and each fired: dropping `side`, ungating the pair, giving it a
bespoke key, making it always visible, putting the reserve back to 412, and un-keying the rule.
⚠️ **ONE CHECK WAS WRONG FIRST AND FAILED ON CORRECT CODE — the thirteenth probe fault in this
file.** It tried to match `calc(100vw - 412px)` from the `.aiad--left .aiad-panel` selector
onwards within a 400-character window, and that rule's own explanatory comment is longer than
that. `412px` appears nowhere else in the stylesheet, so counting its occurrences is the honest
test.

**Verified in the browser with real hovers and clicks**, not by construction: at rest both are
opacity 0 and only close is visible; hovering the header brings them to 1 and 0.35 (disabled undo)
in `#2666f9` and `#15243e`, matching the chat's pair exactly; the sparkle opens
`aiad aiad--open aiad--left` with **no backdrop**, the panel flush to the LEFT edge at 420px with
the root's `pointer-events: none` and the panel's `auto`, sub-heading "Aptive voice agent" and the
empty state "Build Aptive's voice agent". One instruction ("open with … and add a rule that it
never quotes a price") **landed in the store** — `agent.greeting` set and `agent.rules` at 5 under
`aptive::/agent-studio/agent/workflow/voice`, undo depth 1 — and the drawer's own undo took it
back to nothing. Untouched and checked afterwards: the SMS chat's sparkle still opens LEFT at x=0
with no backdrop and its panel still 420 at 900px, the voice diagram is still 12 nodes / 15 chips,
the SMS diagram 6 / 2 with its minimap, and `/dashboards/marketing` is 17 cards / 5 donuts / KPI
64,004 with **zero `.vp-` elements**.

## The search location is one the business actually has, and an SE can set it by ZIP (9/8/2026)

Asked for from the Google Search screen, which was showing "Phoenix, AZ": *"In the past i
asked you to default to Santa Barbara, CA for the location, i no longer want you to do that,
the location has to be one of the locations where the business actually is."*

⚠️⚠️ **MEASURING ALL 27 PROFILES FOUND TWO DEFECTS, AND THE SECOND WAS THE WORSE ONE.**

| | measured before the change |
|---|---|
| fell back to a hardcoded Santa Barbara | **12 of 27** — every one with real locations sitting two fields away (Reyes Law: Dallas, Houston, Fort Worth; Vector Security: Pittsburgh, Philadelphia; Roto-Rooter: Chicago) |
| showed the SCREENPOP CALLER'S city as the company's | **14 of 23** — Mattress Firm rendered "Portland, OR" while its stores are Houston, Dallas and Atlanta |

The caller's city was the SECOND source in the preference order, and a caller is a CUSTOMER.
It is dropped as a location source entirely. Aptive, the prospect on screen when this was
reported, happened to look right — Phoenix IS one of its branches — but the value had come
from its caller, so the mechanism was wrong even where the answer was not.

**`opsDashboard.locationHandling` is the right source and was already on every profile:** a
complete partition of call volume by site, four rows each, the same names the Location
Comparison dashboard renders. New order in `companyPlace()`: the prospect's own location rows,
then its own `serviceArea`, then the fallback. **Measured after: 20 of 23 resolve from their
own data**, each traceable to the row that answered.

⚠️ **THE FALLBACK IS KEPT, AND IS NOW REACHABLE BY THREE PROFILES.** Put to the user when the
measurement turned them up: Marriott, whose "locations" are reservation centres rather than
hotels, and the two fictional healthcare demos, whose clinic names are invented. Their names
are listed in `audit:place`, so a FOURTH prospect appearing there means one lost its real
location.

⚠️ **`serviceArea` IS SCANNED, NOT TRIMMED.** `shortArea`'s 34-character cap threw away
Reynolds Lake Oconee's whole area string — "the Reynolds Lake Oconee community in Greensboro,
Georgia, ZIP code 30642, about 85 miles east of Atlanta" — even though the city it needs is
right there. Scanning it resolves Greensboro, GA.

### The sponsored ad is the prospect's own campaign, and its keyword is a real search
Asked for in the same conversation: *"just like a sponsored ad on google, lets change the top
title to a creative campaign personalized to the prospect. and same for the search term, like
now it says 'best quarterly near me' which make no sense for this aptive prospect."*

⚠️⚠️ **THE KEYWORD BUG HAD ALREADY BEEN FOUND AND FIXED ONCE, ON ANOTHER SCREEN, AND NEVER
CARRIED ACROSS.** The query was `best <callReview.searchSuggestions[0]> near me`, and those
are CALL REVIEW TRANSCRIPT WORDS — so Aptive read **"best quarterly near me"** (quarterly is
how often its plans run), American Home Shield **"best gold near me"** (a plan TIER), Avi & Co
**"best daytona near me"**, Orlando Health **"best cancer institute near me"** on an ER search.
This module's own comment even warned the list "is just as likely to hold a process word", and
guarded with a hardcoded list of process words that "quarterly" is not on. The Google Ads
console note in this file already records the fix in full: use the top **Calls by Search Term**
row, "a real phrase somebody types". Now `query` is that row VERBATIM — measured across all 23
prospects and better every single time ("pest control near me", "home warranty", "buy rolex
daytona", "emergency room near me"). The old construction survives only as the fallback for a
profile with no Search Term breakdown; every profile on disk has one.

⚠️ **THE HEADLINE IS THE PROSPECT'S OWN CAMPAIGN NAME, because nothing we invent beats it.**
`Calls by Campaign` rows are human-written advertiser creative specific to the business:
"Freedom From Glasses", "Elevating the Human Spirit", "Smart Home. Smarter Decision.",
"Turn 62", "$1B+ Recovered", "Buy 3 Get 1 Free Tire Event", "Cruise Ship on Land". It replaced
`${hero} in ${city} | ${bookingTerm}s This Week` — one sentence with three words swapped, for
every business on the platform. `adCreative()` builds Google's own three-slot shape: the
campaign's creative (or the product), a promotional hook, then a locality CTA, capped at 90
characters and trimmed from the RIGHT so the creative always survives.

⚠️ **THE CAMPAIGN IS PAIRED TO THE QUERY BY WORD OVERLAP, two significant words minimum** —
the same threshold `google-ads-demo.js` settled on for keyword-to-ad-group after one shared
word matched "continuing CARE" to "Memory Care". `utm_campaign` then carries that campaign's
FULL row name, match type and all, so the copy and the tracking agree about which campaign
served the ad and the click is still traceable to a row on the Marketing dashboard.

⚠️⚠️ **AN UNGATED HERO PRODUCT ADVERTISED THE WRONG SERVICE, measured.** When the matched
campaign is a bare keyword ("ER Near Me", "Tires Near Me Search"), the first version fell back
to the hero product — and Orlando Health's biggest category is its Cancer Institute, so an
"emergency room near me" search was headlined **"Cancer Institute"**. Plausible-looking and
wrong is the worst combination on a screen a prospect reads. The product now leads only when
it shares a significant word with the query; otherwise the campaign's own name does, which by
construction is the one that matched.

⚠️ **TWO SLOT-2 EXTRACTIONS WERE TOO LOOSE AND BOTH RENDERED.** A bare
`free\s+(\w+…)` over the offer text gave Big O Tires **"Free With A Free"** and Discount Tire
**"Free On Qualifying Sets"** — it swallowed prepositions and stopped before the noun. It now
requires the named thing to be CAPITALISED ("a free ProAct Inspection"), which is how these
offers are actually written, and produces nothing rather than nonsense when it is not. It also
still refuses "Free <bookingTerm>", the false claim `offer` already guards against.

⚠️⚠️ **A `\b` WAS SAVED AS A LITERAL BACKSPACE BYTE AGAIN, IN THIS VERY CHANGE.** Writing
`isKeywordish`'s regex through a Python heredoc collapsed nine `\b` word boundaries into 0x08
bytes. `tsc` accepts it (a backspace between two slashes IS a valid regex), `grep` renders it
invisibly, and the classifier silently matched nothing. This file already documents the trap
from the `\bfull name\b` incident; **it is now checked as BYTES by `audit:place`**, so the
next occurrence reddens instead of hiding. Verified by reproducing it exactly.

**`audit:place` gained 8 checks** covering both halves, over every profile: the query is the
prospect's own top search term and is never the old template, the headline fits 90 characters,
has more than one slot, is not the old template, leads with the prospect's own campaign or
product, is RELEVANT to the query, never promises a free booking, and the utm names the
campaign the headline used — plus the byte check above. Each was broken on purpose and seen to
fire: reverting the query (47 red), ungating the hero (2), removing the cap (15), and saving a
backspace (1).

### The city table carries its own state now
⚠️⚠️ **`GoogleSearch` WAS STILL COMBINING A CITY FROM THE TABLE WITH `voiceScreenpop.state` —
the CALLER's state.** That is the "Santa Barbara, TX" bug this file recorded for Reyes Law,
still live in the screen months later, because the fix at the time was to make `derive` fall
back label-and-all and nothing stopped a caller re-deriving the half it wanted. Each entry is
now `{ ll, st }` and `derive` returns the state that BELONGS to the city, so there is nothing
to recombine.

⚠️⚠️ **DO NOT BULK-REPLACE THOSE COORDINATES FROM A GEOCODER — measured, and the geocoder was
the one that was wrong.** All 41 keys were geocoded through the Google Places API to pick up
authoritative states: 39 agreed to within 0.05 degrees, and the two that disagreed showed a
bare city name is ambiguous. "washington" came back as Washington **STATE** and "duluth" as
Duluth **MINNESOTA**, where this app means Washington **DC** and Duluth **GEORGIA** (metro
Atlanta, the same place `ZIP_PLACE` maps 30097 to). Their states are set by hand and both are
pinned by the audit. The hand-checked coordinates were right and stayed.

⚠️ **AMBIGUITY IS THE STANDING LIMIT OF SUBSTRING MATCHING HERE.** Keys cannot be qualified by
state, so "greensboro" means Georgia because that is where the one prospect naming it actually
is, and a future Greensboro NC office would get Georgia. Add a key only when a real prospect
needs one; the ZIP override below is the general answer.

### "Use precise location" takes a ZIP (asked for in the same breath)
*"for all prospects let add a feature, allow users to click on the 'Use precise location'
button and give a zipcode to change the location."* Google's own pill was inert chrome in the
capture; it now re-points the whole screen.

⚠️ **PLACES, NOT THE GEOCODING API — measured rather than assumed.** The obvious call is
`maps.googleapis.com/maps/api/geocode/json`, and on this project's key it returns
`REQUEST_DENIED: This API is not activated`. Places Text Search IS enabled (`fetchPlace`
already uses it) and resolves a bare ZIP: "85001" comes back "Phoenix, AZ 85001, USA" with
real coordinates. **No new key and nothing to enable in the Cloud Console.**
⚠️ **A RETURNED ZIP THAT DIFFERS FROM THE ONE TYPED IS REFUSED.** Places answers a nearby
place for a ZIP it does not know, which would move the map somewhere the SE never asked for.
Unresolvable is an error on screen, never an approximation — the same refusal as the rejected
ZIP3 guess in the pre-call artifacts, one level up, because here the ZIP moves a MAP.
⚠️ **THE RESTING PILL IS BYTE-FOR-BYTE AS CAPTURED** — same 32px height, same 9999px radius,
same 14px Roboto, same words, and Reset appears only once a ZIP is in force. Making it look
like a form would add a control Google does not show. A `<button>` needs the browser's own
button styling removed, the same reset `button.nav-item` needed.
⚠️ **BOTH SCREENS HONOUR ONE CHOICE.** `prospectPlace` exists because "the same prospect must
land in the same city against the same competitors on both", so `ChatGptAd` reads the same
override; an SE re-pointing one and not the other would reintroduce exactly that drift.
Verified: ZIP 02108 moved the search screen's label, map coordinates, ad headline, competitor
names and footer to Boston together, and the ChatGPT screen to the same coordinates.
⚠️ Per prospect, persisted, **no TTL** — a captured conversation is a session artifact, a
deliberate location choice is a setting. localStorage, so it does not follow a demo to a
colleague; that is right for re-pointing a screen for one conversation.

⚠️ **`prospectPlace.ts` COULD NOT BE AUDITED AT ALL until its Mapbox token read was
optional-chained.** `import.meta.env` is a Vite builtin and is `undefined` under plain Node, so
importing the shared source of truth for two screens threw at module load. One `?.` unlocked
`npm run audit:place`.

**`npm run audit:place` is 15 checks**, run over every profile, and each was broken on purpose
and seen to fire: emptying the location scan (17 red), resolving from the caller again (5),
setting washington to WA (1), restoring the screen's caller-state read (2), and accepting a
mismatched ZIP (1).
⚠️ One check was wrong first and **fired on its own documentation** — it forbade
`maps/api/geocode`, which `geocodeZip`'s comment legitimately NAMES to record that it is not
enabled. Comments are stripped before matching, the same fix the vendor scan needed. Seventh
probe-not-code fault in this file; three more happened while measuring this change (reading
`r.name` where location rows are `{cells:[...]}`, a curl subprocess with no `-d @-`, and
`tsc --noEmit | head; echo $?` reporting **head's** exit code, which hid a real compile error
behind a green "tsc=0").

## Three environments: local, staging, production (9/8/2026)

Asked for: *"currently i have local host and production environment, i want to create a sandbox
environment as a redundancy how should i go about doing that"* — and when the two readings of
"redundancy" were put to the user (a pre-production gate vs a hot standby), the answer was
**both, staging first**. **The full runbook is `docs/ENVIRONMENTS.md`**; this records the code
side and the traps.

⚠️ **`engine/appEnv.ts` IS THE SINGLE DEFINITION, AND IT IS DERIVED FROM THE SERVICE NAME.**
Render sets `RENDER_SERVICE_NAME` for free, so a service called `…-staging` is staging by
construction. Keying off an `APP_ENV` flag alone means a service created without it looks
EXACTLY like production — no badge, a nightly canary billing a full Opus generation, and real
email to real colleagues — so the safe answer had to be the automatic one. `APP_ENV` still
overrides. `local` is "no `RENDER_GIT_COMMIT`", the same signal `/api/status` already used to
tell a dev server from a deploy.

⚠️⚠️ **THE ONE THAT WOULD HAVE CONTAMINATED PRODUCTION SILENTLY: `AGENT_NAME` WAS A HARDCODED
`"invoca-voice"` ON BOTH SIDES.** There is one LiveKit project, and LiveKit hands a job to ANY
worker registered under the requested name. With a second deployed service asking for the same
name:
  - a staging test call is answered by the **production worker**, so staging can never exercise
    a worker change and its test calls spend production capacity;
  - and the moment a staging worker is deployed under that name it joins the same pool and can
    answer a **real demo call** with untested code, mid-sentence.
Neither shows up as an error anywhere. The name is now environment-derived
(`invoca-voice-staging` off production) and both sides read `VOICE_AGENT_NAME` with the same
fallback, which `audit:voice` asserts along with staging and production differing.
⚠️ **CONSEQUENCE, STATED: staging voice sits on the warming notice until a second agent is
deployed** under its own name. That is the safe failure and `docs/ENVIRONMENTS.md` gives the
three commands.
⚠️⚠️ **LOCAL KEEPS THE PRODUCTION NAME, AND THE FIRST VERSION GOT THIS WRONG.** Giving `local`
its own name meant no worker ever answered a laptop's call — a silent regression in the daily
loop, since user memory records the hosted worker is "always on" precisely so local can
exercise a real call without deploying. Caught by measuring the derivation across all five
cases rather than by reading it.

⚠️ **THE CANARY AND THE MAILER NOW DEFAULT TO OFF OUTSIDE PRODUCTION**, because both costs are
silent and recurring. The canary runs a FULL `generateProfile()` nightly (~2.5 min of Opus
across 20 phases) and publishes to `/api/canary`, which two claude.ai routines read — a second
service answering that route is a second source of truth for "did last night pass". Feedback
completion mail goes to the SUBMITTER's real address, so a staging service built by copying
production's env vars would email real colleagues about test items. `CANARY=on` and
`ALLOW_EMAIL=1` force either.

⚠️ **THE BADGE RENDERS NOTHING IN PRODUCTION — not a hidden node, not the class string.**
Verified: 0 `.envbadge` nodes and `envbadge` absent from the HTML, with the dashboard still at
17 cards / 5 donuts / KPI 64,004. It asks `/api/status` at runtime rather than reading a
`VITE_` variable, because that would be one more build-time value to forget on a new service —
the mistake this file already documents for the Mapbox token.
⚠️⚠️ **AND IT WAS MOUNTED IN THE WRONG PLACE FIRST, in a way its own comment denied.** The
edit landed inside `LaunchCorner`, which returns `null` unless the pathname is the launch form
— so the badge appeared only on the one screen that is obviously our own tool, and on every
replica screen (where it matters) it rendered nothing, while the comment beside it claimed
"APP LEVEL". It is now inside `<BrowserRouter>` and outside `<Routes>`, which also covers the
standalone screens a TopBar chip would have missed (the phone preview, Google Search, the
Salesforce pages). **A comment asserting placement is not evidence of placement.**

⚠️ **`/api/status` GAINED `environment` AND `canaryArmed`.** Both are labels or booleans, so
they are safe on a public endpoint by the same rule as `service` and `branch`: no prospect, no
demo id, no key value. `environment` is what lets you confirm from outside the gate that a
push reached staging rather than production, which is the entire point of having two.

⚠️ **A STAGING SERVICE IS NOT A FAILOVER TARGET, and cannot be made one from the app side.**
The demo library is a Render persistent disk and a disk attaches to ONE instance at a time, so
a standby cannot see production's 219 demos. Failover needs the store moved off the disk behind
`engine/demoStore.ts` — the same migration this file already names as the real fix for
zero-downtime deploys. It needs a store provisioned, which is the user's to do.

## ⚠️ OPEN ITEMS as of 9/9/2026

**0. THE STAGING SERVICE IS STILL MID-CREATION; `main` HAS SINCE MOVED PAST IT AND IS NOW TWO
COMMITS UNPUSHED.** ⚠️ **The paragraph this replaces is STALE — corrected here rather than
left to mislead:** it said "production is still on `68c602c`". Production has since been
pushed to and is now on **`3cc7ef0`** (the workflow-tree symmetry fix), confirmed live via
`/api/status`. Current split:
- `origin/main` = `3cc7ef0`. Local `main` is **two commits ahead, unpushed**:
  `a0651d1` (the SMS thread header's toll-free number) and `c847814` (the "2026 Dallas Invoca
  Summit" Launch dropdown). Neither is destructive or environment-sensitive; both are waiting
  only because nobody has said "push it" for them yet.
- `origin/staging` is still at **9628972** and has not moved since 9/8. It has not caught up
  to `main` at all — everything from 9/8 onward (the ER workflows, the tree symmetry fix, the
  toll-free number, the Dallas dropdown) is on `main`/production but NOT on `staging`.
- ⚠️ **`staging` IS A DEPLOY POINTER, NOT A BRANCH TO DEVELOP ON.** Keep working on `main`
  locally; `git push origin HEAD:staging` deploys, `git push origin main` promotes. Do not
  `git checkout staging`.
- The Render Web Service itself was still being filled in as of 9/8 and its state has not been
  checked since. Every field value, the four autofills to correct, and the env vars to set and
  omit are in **`docs/ENVIRONMENTS.md`** — read that before touching the dashboard.
- ⚠️ **AN OPEN DECISION, STILL UNRESOLVED:** the user said they are **not** adding Google auth
  to staging. That leaves every `/api/*` route reachable by anyone with the URL, and the
  exposure is COST (our Anthropic, LiveKit and Places keys) rather than prospect data. The
  runbook gives the two safe shapes — omit `ANTHROPIC_API_KEY` too (14 bundled prospects still
  render in full), or add the two Google vars. **Do not assume either.**

## ⚠️ OPEN ITEMS carried from 9/3/2026 (NOT yet fixed)

**1. ⚠️⚠️ AN ENDED CALL LEAVES THE AGENT IN THE ROOM, AND IT BILLS.** Measured live, twice.
Navigating away from the call drops the CALLER (`hangUp` -> `destroyLive`) and the room goes
from 2 participants to 1 — the agent stays, publishing, retrying STT against a room nobody
will ever speak in (`session closed due to agent inactivity`, code 2007, on repeat). LiveKit
bills participant-minutes, so an SE who opens Preview Workflow, hears the greeting and closes
the drawer leaves one running. The room's empty-timeout cannot rescue it, because the agent
itself keeps the room non-empty. Two rooms were found orphaned this way and deleted by hand
(`lk room delete <name>`).
⚠️ **Nothing in the UI or the logs reads as an error** — you only find it in `lk room list` or
on the bill. The fix is worker-side (end the session when the last non-agent participant
disconnects) and therefore needs its own `lk agent deploy`. Flagged rather than fixed: it was
outside what was asked, and the disconnect event should be verified firing before claiming it
works.
⚠️ **Diagnosing it:** `lk room list` — 1 participant with 1 publisher and a `voice-<slug>-…`
name is an orphaned agent, not a live call. 2 publishers means a real human is on it; do NOT
`lk agent deploy` then, it restarts the worker and drops the call mid-sentence.

**2. `agent/livekit.toml` sets a `loadThreshold` LiveKit Cloud ignores.** Every worker start
logs `custom loadThreshold is not supported when deploying to Cloud`. Harmless, and it will
keep appearing in every log until the key is removed.

**3. ✅ DONE 9/3/2026 — the live Avi & Co record was patched.** Kept here for the procedure,
which was WRONG in one detail and is now measured against the live API.
- Both workflows were missing on live: `extraWorkflows` was `[]`, so neither `sms-new`
  ("Avi & Co - New") nor `voice-booking` ("Avi & Co - booking") existed there. Patched to
  both; `customizations` (overrides + tiles) preserved, `creator` unchanged, `updatedAt`
  bumped to 20:10Z.
- ⚠️ **`GET /api/demos/:id` RETURNS `{ demo, canEdit }`, NOT the record.** The procedure
  written from the handler source said the record came back directly, and a read-modify-write
  built on that would have sent `profile: undefined` — which `body?.profile ?? rec.profile`
  accepts silently, so it would have reported 200 and changed nothing. The read-modify-write
  is against `json.demo.profile`.
- The PATCH still takes `{ profile }` ONLY, as documented: omitting `customizations` preserves
  the AI override layer by construction rather than by care.
- ⚠️ **The sign-in wall is passable through the user's own Chrome** (`claude-in-chrome`), which
  holds their live Okta session — the Browser pane does not. That is what unblocked this.
- The stale `"Does the workflow chat restart?"` test questions are in the LOCAL record only
  (`.data/demos/avi-co.json`, scope `/agent-studio/agent/preview`). Live has no preview
  override at all, so nothing to clear there.

⚠️⚠️ **WHY THE SALESFORCE WORK LOOKED UNPUSHED WHEN IT WAS DEPLOYED ALL ALONG (9/3/2026).**
Reported as "the salesforce stuff is not pushed in the live instance". It was: `620d8eb` (lead
+ calendar chip) and `c469ada` (the booking agent) are both ancestors of `origin/main`, and
live was running `d16c9de`. **Deployed code and a reachable feature are different claims**, and
this one needed THREE things to line up:
  1. the code — deployed;
  2. a workflow that can produce `outcome.booked` — the live record had none (see above);
  3. a captured booking call **in that viewer's own browser**, because `liveBookedLead` and
     `bookedEvent` derive from localStorage captures and both fail closed.
The user's Chrome held two Avi & Co captures, and both were ROUTING calls
(`transferred: true`, `routedTo: "Boutique Appointment, New Client"`) from the older voice
agent — `isBooked` requires `booked === true` plus a day and a time, so neither produced a
lead. ⚠️ **The lesson: for anything gated on a captured call, "is it live?" is answered by
checking the record AND the browser's captures, never by the commit alone.**

**4. ✅ RESOLVED — `src/data/generated/denver-health.json` is now tracked in git.** This item
previously said it was untracked; checked 9/9/2026 and `git ls-files` confirms it is in the
repo. Whoever decided it belonged in git did so at some point between then and now; nothing
left to do.

## Deferred polish (TODO)
0. **ZERO-DOWNTIME DEPLOYS — route B built 2026-08-20, ONE CHECK OUTSTANDING.**
   Goal: a push must not interrupt the live site, even for someone hitting refresh
   mid-deploy.
   ⚠️ **The blocker is the PERSISTENT DISK, not the plan or the health check.** A Render
   disk attaches to ONE instance at a time, so the old instance must stop to release it
   before the new one boots. **MEASURED on the 2026-08-20 deploy: ~40 seconds where the
   origin answered nothing at all** (two consecutive 20s polls got no response; the new
   instance reported 42s uptime when it answered). Do not re-investigate the health check.
   Route B (no infra change) is now built:
   - **SIGTERM/SIGINT drain in `server.ts`.** `/healthz` returns 503 once draining, idle
     keep-alive sockets are dropped at once (`closeIdleConnections`, or an idle browser
     socket holds the drain open for the whole budget), in-flight requests finish, and a
     10s `DRAIN_TIMEOUT_MS` forces exit so an open SSE stream cannot outlast the host's
     patience. **Proven:** SIGTERM sent 1.2s into a throttled 3.5s bundle download — the
     download completed WHOLE (1,850,317 bytes, HTTP 200) while a NEW request during the
     drain was refused, so the test could have failed.
   - **`public/sw.js` + prod-only registration in `main.tsx`.** Navigations are
     network-first and cache the shell; `/assets/*` is cache-first (safe only because the
     names are content-hashed); `/api/*`, `/auth/*`, `/healthz` are never cached. A
     refresh inside the window renders the cached shell instead of the browser error page.
     `npm run test:sw` drives the real handlers against stubs — 10 checks including the two
     traps that would hurt production: a 302 auth redirect must NOT become the shell, and
     nothing under `/api` may ever be cached. Verified the suite FAILS when the guard is
     removed. **KILL switch at the top of sw.js** — set `KILL = true` and deploy to make
     every client unregister and drop its caches. Do that instead of deleting the file;
     deleting it leaves registered workers running forever.
   - **GET-only retry + self-heal in `DemoLibraryContext`.** Three retries with backoff,
     and ⚠️ **only for idempotent requests** — the same `api()` helper also carries
     createDemo/duplicateDemo/deleteDemo/saveCustomizations, and a retried POST that
     actually succeeded would duplicate a demo or re-send a delete. Plus a bounded 3s poll
     while the library is unavailable, so a page loaded mid-deploy heals itself instead of
     waiting for someone to refresh.
   ✅ **THE DRAIN IS LIVE (`5e00316`, 2026-08-20).** Split out and pushed on its own,
   deliberately: it changes no client behaviour and adds no caching, so a misbehaving
   deploy after it cannot be it. ⚠️ The commit that first contained it (`b4d0708`) also
   carried sw.js, the registration and the retry — pushing "the drain" by that ref would
   have shipped the service worker in its broken-first-load state, with the precache fix
   stranded in the NEXT commit. Check what a commit actually contains before pushing it as
   one thing.
   ⚠️ **PRODUCTION ONLY, FOUND ON THIS DEPLOY: `/sw.js` RETURNS 302, BEHIND THE AUTH GATE.**
   The auth middleware is registered before `express.static`, so the worker SCRIPT is
   gated. Harmless for a signed-in user — registration happens after the app loads, and a
   same-origin fetch carries the session — but it cannot be reproduced locally, where the
   gate is off and it returns 200. It also means a browser's periodic worker-update fetch
   fails once a session expires, leaving the OLD worker in place; the kill switch would not
   land on such a client until it signs in again.
   ✅ **VERIFIED END TO END BY THE USER IN CHROME, AGAINST A REALLY DEAD ORIGIN** (server
   killed, not DevTools offline emulation): the app reloads and renders WITH ITS DESIGN
   INTACT. That is the whole goal of route B.
   ⚠️ **CACHING ONLY `/assets/*` WAS NOT ENOUGH, and the failure looked worse than an error
   page.** The first working version rendered the app during an outage but UNSTYLED —
   `/fonts/lato-400.woff2`, `/fonts/lato-700.woff2`, `/fonts/material-icons.woff2`,
   `/logo.png` and `/favicon.svg` all hit ERR_CONNECTION_REFUSED, so every icon showed as
   its literal name ("more_vert", "add", "file_download") and the type fell back. The
   comment in sw.js had asserted the browser's HTTP cache would cover them; it does not.
   The precache list is now DERIVED — the hashed assets from the shell HTML, then the fonts
   and sprites from `url(...)` inside the built CSS — so it stays correct as those change.
   Only `/logo.png` and `/icons.svg` are named explicitly, because JS reaches them.
   Fonts and images additionally use STALE-WHILE-REVALIDATE: they are not content-hashed,
   so cache-first would pin a stale logo forever and network-first breaks in an outage.
   Deliberately NOT applied to non-hashed .js/.css, where a stale copy could disagree with
   the bundle.
   ⚠️ **STALE HASHED ASSETS ACCUMULATED FOREVER.** `activate` only dropped caches by NAME,
   so `assets-v1` held every bundle ever served — observed three, including
   `index-BRVdQA4i.js` from an earlier build, at ~1.85MB each. Left alone that creeps toward
   the storage quota until `put()` starts failing, which would look like the worker randomly
   breaking weeks later. Install now derives the complete set this build needs and deletes
   any other `/assets/*` entry; non-hashed files are left alone since they are cached at
   runtime rather than install.
   ⚠️ **BOTH OF THOSE BUGS CAME FROM THE USER'S SCREENSHOTS, NOT THE TEST SUITE** — and
   getting the suite to 23 checks took SIX bugs in the harness itself (a stub `fetch` that
   could not resolve relative URLs; awaiting the lifecycle handler instead of the promise it
   hands to `event.waitUntil()`; asserting against caches a previous test had cleared, twice;
   a missing `waitUntil` on the fake fetch event; and one check that passed while asserting
   only a fetch count). Treat a green suite here as weak evidence until a human has looked
   at the real thing.
   ⚠️ **A `sw.js` CHANGE NEEDS Unregister + CACHE DELETE, NOT A RELOAD.** Hit three times
   tonight. `caches.delete()` matters as much as unregistering: unregistering leaves Cache
   Storage intact, so a check reading the caches still sees the old contents. DevTools →
   Application → Service workers → **"Update on reload"** is the switch to leave on while
   iterating.
   ✅ **VERIFIED IN REAL CHROME (2026-08-20).** `register()` OK, worker `activated`,
   `shell-v1` holding `/index.html` and `assets-v1` holding both hashed assets. Getting
   there exposed two things worth keeping:
   ⚠️ **PRECACHE ON INSTALL — the first version cached nothing there and that was wrong.**
   It assumed the first load would populate the caches lazily. It does not: the navigation
   that REGISTERS a worker, and the bundle fetch it triggers, both complete before the
   worker exists, so there is nothing to intercept, and `clients.claim()` cannot
   retroactively cache what already loaded. Observed: worker active, Cache Storage EMPTY.
   Install now fetches the shell and parses the hashed asset names out of its HTML — the
   names ARE knowable from inside sw.js, contrary to the comment the first version carried.
   ⚠️ **A DEPLOYED sw.js CHANGE IS NOT PICKED UP BY A RELOAD ALONE.** An already-registered
   worker keeps serving until the browser re-checks the script. This looked exactly like
   "the fix does not work" — an old worker was installed and caching nothing, and only an
   explicit `register()` from the console pulled the new file. Consequence for deploys: the
   FIRST deploy carrying a service-worker change is itself unprotected, and clients pick the
   change up on a later navigation. When testing a sw.js edit, Unregister first.
   ⚠️ **Three of the four failures while building the test suite were IN THE SUITE, not the
   worker** — a stub `fetch` that could not resolve `"/index.html"` (a real worker resolves
   against scope; `new URL(relative)` throws, and the precache died inside its own `try`);
   awaiting the lifecycle HANDLER instead of the promise it hands to `event.waitUntil()`, so
   assertions ran before the precache finished; and measuring cache-first against an asset
   install had already precached, which passed while proving nothing. An early "10/10
   passed" was partly passing because it never reached the code it claimed to test.
   ⚠️ **Claude in Chrome cannot verify this — it is not a localhost problem.** Navigation and
   JS are refused on `localhost`, on `127.0.0.1`, AND on the production onrender.com domain,
   so it is the extension's per-site permission layer, not Chrome and not a hostname rule.
   The in-app Browser pane cannot register a worker at all. Verification here has to be a
   human in DevTools, or the domain granted in the extension.
   The self-heal poll in DemoLibraryContext is still only verified by construction: The
   in-app browser pane fails with "unknown error occurred when fetching the script" even
   though the server returns 200 `application/javascript`, and the Chrome tool refuses
   localhost. The logic is tested; the registration is not. Check once on the deployed
   site: DevTools → Application → Service Workers shows sw.js activated, then Network →
   Offline → reload should still render the app. The self-heal poll is likewise only
   verified by construction — the poll correctly stays idle while the library is
   reachable, which is also why it could not be exercised without an actual outage.
   ⚠️ **THE SINGLE BUNDLE IS LOAD-BEARING, AND THE SERVICE WORKER MAKES IT MORE SO.** The
   build is one hashed JS file with NO code splitting, so a cached shell and a cached
   bundle are always a consistent pair. Introduce code splitting and a cached shell could
   ask for a lazy chunk that was never cached and no longer exists — a white screen
   mid-demo, worse than the problem this solves.
   ✅ **CORRECTED: the boot migrations were NOT a problem.** This file previously called
   them "synchronous fs loops over 117 demos" delaying `/healthz`. Both are marker-guarded
   and the markers were written 2026-07-29, so they cost **0.1ms and 0.3ms** (timed). The
   117-demo loop ran once, months ago. Nothing to fix; do not "optimise" it.
   Route **A (structural)** is still the real fix if the window must go to zero: move demo
   storage off the disk (Postgres or S3/R2 behind `engine/demoStore.ts`, already a narrow
   read/write/list interface), then remove the disk and get real rolling deploys. Requires
   the user to provision the store — the assistant cannot create accounts or keys.
   For "I say push and it deploys": a **Render Deploy Hook URL** in git-ignored `.env`
   (single-purpose; cannot read env vars or delete services), then poll `/api/status`
   until `commitShort` matches. A full Render API key was declined as too broad.
1. **Engine revenue-example leak**: the generation prompt uses "$945,910" as an example,
   and generated customers copy it verbatim as Total Revenue. Fix in `engine/generate.ts`
   (dashboard prompt) — use a placeholder or instruct it to compute from calls × rate × price.
2. **Duplicate Mavis**: both the hand-authored seed `mavis` and the engine-generated
   `mavis-tires-and-brakes` show "Invoca for Automotive" in the switcher. Remove the seed
   (`src/data/profiles/mavis.ts` + its entry in `profiles.ts`) now that the engine works —
   OR keep mavis as a hand-tuned reference. (Note: schema requires all profiles to have both
   reports; if removing mavis, ensure nothing else references it.)
3. Optional: dashboard donut small-slice label crowding; dashed trend line on the stacked bar.

## Next steps (options)
- **More screens** — extract from the live app and templatize (ask the user for the URL first).
  Candidates: AI Agents / Signal, other report types, Call Review.
- **"New Demo" in-app UI** — a form (name + URL) that runs the engine and adds the customer
  to the switcher, so SEs never touch the terminal (Phase 4).
- Fully offline exact-copy pages (localize GT America + logo assets) if needed.

## Gotchas
- ⚠️ **A STALE `nohup npm run dev` HOLDS PORT 5173 FOR DAYS, and killing it needs the
  LISTENER, not every socket on the port.** Hit twice on 9/8/2026 (one process was 4d17h
  old, another 7h28m). `lsof -ti tcp:5173` also lists a **Google Chrome network-service
  helper** that merely has a connection open, so `kill $(lsof -ti tcp:5173)` takes out a
  Chrome subprocess along with the server. Filter for the listener:
  `lsof -nP -iTCP:5173 -sTCP:LISTEN -t`. Prefer `preview_start` over `nohup` so the server is
  managed and does not outlive the work.

- **Structured-output "grammar too large"**: generating the full profile in one structured
  call fails. The engine splits into separate calls (report, then dashboard). Keep any new
  screen's generation as its own call.
- **Exact-copy pages need internet** (CDN fonts/logos) and render desktop layout at ≥992px.
- **Dev server** is long-running; if navigation fails, restart `npm run dev`.
- Reference: the original single-page report clone lives at `/Users/ddesai/invoca-report-clone/`
  (plain HTML/JS) — the proof-of-concept before this React platform.

- ⚠️ **`.fbb-page` is the board's full-page wrapper** (`min-height: 100vh`). Reusing that
  class name for a small meta span gave it a viewport-tall minimum, stretched the flex row
  it sat in, and left a ~900px hole in every card with a `page` value. The meta span is
  `.fbb-from`. Check for an existing class before reusing a name in `app.css`.
