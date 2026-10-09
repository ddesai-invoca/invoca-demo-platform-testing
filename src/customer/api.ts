/* =============================================================================
   api.ts — the customer build's ONLY door to the server
   -----------------------------------------------------------------------------
   The agent screens are the staff screens, unchanged, and they call /api/chat, /api/analyze and
   /api/livekit-token with a full `brain` in the body. A customer must never be able to send a
   brain (engine/share.ts pins one stored by staff), and must not reach any staff route. So the
   customer build wraps window.fetch ONCE:

     /api/chat          -> /api/share/<slug>/chat        { brainKey, messages }
     /api/analyze       -> /api/share/<slug>/analyze     { brainKey, channel, transcript, ... }
     /api/livekit-token -> /api/share/<slug>/voice-token { brainKey, voice }
     /api/share/...     -> passed through
     any other /api/... -> refused here (403), and would be refused by the gate anyway

   Non-/api requests (map tiles, fonts) pass through untouched. The shim also reports the two
   things the UI must show: an escalation was captured, and a voice call started (its limit).
   ============================================================================= */

export const SMS_KEY = "sms-support";
export const VOICE_KEY = "voice-support";

export type CustomerEvent =
  | { type: "escalation"; kind: "live" | "callback" }
  | { type: "voice"; maxSeconds: number };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function installCustomerApi(slug: string, emit: (e: CustomerEvent) => void) {
  const real = window.fetch.bind(window);
  const base = `/api/share/${encodeURIComponent(slug)}`;

  const post = (path: string, body: unknown) =>
    real(`${base}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let u: URL;
    try { u = new URL(raw, location.origin); } catch { return real(input, init); }
    if (u.origin !== location.origin || !u.pathname.startsWith("/api/")) return real(input, init);
    if (u.pathname.startsWith("/api/share/")) return real(input, init);

    let body: any = {};
    try { body = init?.body ? JSON.parse(String(init.body)) : {}; } catch { /* leave empty */ }

    if (u.pathname === "/api/chat") {
      const res = await post("chat", { brainKey: SMS_KEY, messages: body.messages });
      if (res.ok) {
        const j = await res.clone().json().catch(() => null);
        if (j?.escalation) emit({ type: "escalation", kind: j.escalation });
      }
      return res;
    }
    if (u.pathname === "/api/analyze") {
      const voice = body.channel === "voice";
      const res = await post("analyze", {
        brainKey: voice ? VOICE_KEY : SMS_KEY,
        channel: body.channel, transcript: body.transcript, destinations: body.destinations,
      });
      if (res.ok) {
        const j = await res.clone().json().catch(() => null);
        if (j?.escalation) emit({ type: "escalation", kind: j.escalation });
      }
      return res;
    }
    if (u.pathname === "/api/livekit-token") {
      /* The screens probe with an empty body to ask "is voice configured?" — a 400 is the
         positive answer. Answer it here so the probe never mints a room or spends a call. */
      if (!body.brain) return json(400, { error: "probe" });
      const res = await post("voice-token", { brainKey: VOICE_KEY, voice: body.voice });
      if (res.ok) {
        const j = await res.clone().json().catch(() => null);
        if (j?.maxSeconds) emit({ type: "voice", maxSeconds: j.maxSeconds });
      }
      return res;
    }
    return json(403, { error: "Not available in this demo." });
  };

  /* Preview Agent opens in a new tab with a root-relative path; under /d/<slug> that would
     land outside the demo. */
  const open = window.open.bind(window);
  window.open = (url?: string | URL, target?: string, features?: string) => {
    if (typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.startsWith(`/d/${slug}`))
      url = `/d/${slug}${url}`;
    return open(url as any, target, features);
  };
}
