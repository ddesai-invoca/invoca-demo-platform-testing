import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { voiceAgentName } from "./appEnv.ts";
import { RoomConfiguration, RoomAgentDispatch } from "@livekit/protocol";
import { liveKitVoiceModel } from "../src/data/voiceOptions.ts";
import { voiceSystemPrompt } from "./chat.ts";
import type { ChatBrain } from "./chat.ts";

/* =============================================================================
   livekitToken.ts — mints the token that starts a LiveKit voice call
   -----------------------------------------------------------------------------
   Replaces the Deepgram request/response voice pipeline, which was MEASURED at ~4.5-6s
   before the agent said a word: browser STT finalize, then a FULL `/api/chat` round trip
   (1.0-1.2s), then a FULL `/api/tts` synthesis (3.0-3.6s), each waiting for the whole of the
   one before it. Nothing streamed and nothing overlapped. LiveKit fixes the ARCHITECTURE, not
   the vendor — streaming STT, token-streaming LLM and streaming TTS, so the agent starts
   speaking on the first sentence instead of the last.

   Everything the browser needs comes from here: the server URL, a short-lived JWT, and the
   room to join. **The API secret never leaves the server** — the browser only ever sees a
   token minted from it, which is the whole point of doing this server-side.

   ⚠️ **A FRESH ROOM PER CALL, ALWAYS.** LiveKit dispatches an agent from a token only when
   the room is FIRST CREATED. Reuse a room name and the second call connects to a room that
   already exists, no agent joins, and the caller sits in silence with no error anywhere —
   the worst kind of failure on a projector. `roomName()` is therefore unique per call.

   ⚠️ **THE PROMPT IS BUILT HERE AND SHIPPED AS METADATA, NOT REBUILT IN THE WORKER.** The
   agent worker is a separate process; if it built its own prompt it would need the profile,
   the vocabulary and `engine/chat.ts`, and the two would drift the first time someone tuned
   the routing flow. Instead this mints `voiceSystemPrompt(brain)` — the SAME function
   `/api/chat` uses — and hands the finished string to the agent through the dispatch
   metadata. The worker stays dumb and generic: it speaks whatever instructions it is given.

   ⚠️ **DISPATCH METADATA IS CAPPED AT 512 KiB**, so only the finished prompt and a few labels
   travel — never the whole `agentConfig` with its Q&A pairs and knowledge sources. Measured
   payload is a few KB.
   ============================================================================= */

export interface LiveKitEnv {
  url: string;        // wss://<project>.livekit.cloud
  apiKey: string;     // LIVEKIT_API_KEY
  apiSecret: string;  // LIVEKIT_API_SECRET
}

export interface VoiceTokenRequest {
  brain: ChatBrain;
  /** Prospect id, so a captured call can be filed against the right demo. */
  profileId: string;
  /** What the agent opens the call with; blank lets the agent greet on its own. */
  greeting?: string;
  /**
   * A `VOICE_OPTIONS` id ("thalia", "arcas", ...) chosen on the workflow's Details tab.
   *
   * ⚠️ **A PER-CALL FIELD, LIKE `greeting`, NOT PART OF THE BRAIN.** The brain is what
   * `voiceSystemPrompt` turns into words; this is how those words are spoken. Unknown or
   * absent resolves to the default, so an old client that sends nothing keeps today's voice.
   */
  voice?: string;
  /** Token lifetime, e.g. "5m". Defaults to ten minutes. A SHARED demo passes its call length. */
  ttl?: string;
}

export interface VoiceTokenResult {
  url: string;
  token: string;
  room: string;
  /** Echoed back for the transcript header and for debugging a silent call. */
  agentName: string;
}

/** The worker registers under this name; the dispatch below asks for it by name.
    ⚠️ ENVIRONMENT-DERIVED since 9/8/2026 — production keeps "invoca-voice"; a staging service
    asks for "invoca-voice-staging" so it can never be answered by the production worker, and
    a staging worker can never answer a real demo call. See engine/appEnv.ts. */
export const AGENT_NAME = voiceAgentName();

/**
 * A room name that is unique per call.
 *
 * ⚠️ Not `Math.random()` alone: this runs server-side where two calls can start in the same
 * millisecond, and a collision means the second caller joins the first caller's room and
 * hears someone else's agent. Time + randomness + the prospect id makes that impossible in
 * practice, and keeps the name readable in the LiveKit dashboard when debugging a demo.
 */
function roomName(profileId: string): string {
  const slug = (profileId || "demo").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 24) || "demo";
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `voice-${slug}-${stamp}-${rand}`;
}

/**
 * Reads the LiveKit config from the environment, or returns null when it is not configured.
 *
 * ⚠️ Returns null rather than throwing, so the caller can answer 501 and the client can fall
 * back to the old pipeline. An unconfigured provider is a SUPPORTED STATE here, exactly as it
 * is for TTS — the demo must never be silent because somebody has not pasted a key yet.
 */
export function livekitEnv(env: Record<string, string | undefined> = process.env): LiveKitEnv | null {
  const url = env.LIVEKIT_URL?.trim();
  const apiKey = env.LIVEKIT_API_KEY?.trim();
  const apiSecret = env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

/** Mint a caller token that also dispatches the voice agent into a brand-new room. */
export async function mintVoiceToken(
  req: VoiceTokenRequest,
  env: LiveKitEnv,
): Promise<VoiceTokenResult> {
  const room = roomName(req.profileId);

  /* The finished prompt, from the one function /api/chat also uses. */
  const instructions = voiceSystemPrompt(req.brain);

  const at = new AccessToken(env.apiKey, env.apiSecret, {
    identity: `caller-${Math.random().toString(36).slice(2, 10)}`,
    /* The SE is the human on this call; the label shows up in the LiveKit dashboard. */
    name: "Caller",
    /* Short-lived on purpose: a token is only needed to join, and this one is handed to a
       browser. Ten minutes is comfortably longer than any demo call. */
    ttl: req.ttl ?? "10m",
  });

  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });

  /* ⚠️ THE AGENT IS DISPATCHED BY THE TOKEN, which is what lets one worker serve every
     prospect: the worker registers once under AGENT_NAME and is told per call who it is
     speaking for. Without this the worker would have to watch every room and guess. */
  at.roomConfig = new RoomConfiguration({
    agents: [
      new RoomAgentDispatch({
        agentName: AGENT_NAME,
        metadata: JSON.stringify({
          instructions,
          greeting: req.greeting ?? "",
          /* ⚠️ THE FULL INFERENCE STRING, RESOLVED HERE — not the bare id. The worker gets
             "deepgram/aura-2:thalia", which is the exact composite shape LiveKit documents and
             its own `inference.TTS.fromModelString()` parses, so the worker needs no table of
             our voices and cannot disagree with the picker about what "thalia" means. An
             unknown id resolves to the default rather than travelling as-is. */
          voice: liveKitVoiceModel(req.voice),
          customerName: req.brain.customerName ?? "",
          profileId: req.profileId,
        }),
      }),
    ],
  });

  return { url: env.url, token: await at.toJwt(), room, agentName: AGENT_NAME };
}


/**
 * End a room after `ms`, which is how a shared demo's call length is actually enforced.
 *
 * ⚠️ A token's `ttl` only limits JOINING; a participant already in the room stays in it past
 * expiry. Deleting the room disconnects the caller AND the agent, which also stops the agent
 * being left in an empty room and billing (see the orphaned-agent note in CLAUDE.md).
 * ⚠️ The timer lives in this process, so a restart inside the window loses it. The call is
 * still bounded by the token's ttl for anyone who tries to rejoin, and the per-day call cap.
 */
export function endRoomAfter(room: string, ms: number, env: LiveKitEnv): void {
  const host = env.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  const t = setTimeout(async () => {
    try { await new RoomServiceClient(host, env.apiKey, env.apiSecret).deleteRoom(room); }
    catch (e) { console.error(`[livekit] could not end room ${room}:`, (e as Error).message); }
  }, ms);
  t.unref?.();
}
