/* =============================================================================
   shareDeps.ts — the real model / voice calls behind engine/share.ts
   -----------------------------------------------------------------------------
   share.ts takes these as an argument rather than importing them, so its policy (caps,
   lockouts, sessions) can be audited without a network or a key. This file is the one place
   they are wired to the real functions, and both the production server and the Vite dev twin
   build them here so the two cannot drift.
   ============================================================================= */

import { chatReply } from "./chat.ts";
import { analyzeSms } from "./analyze.ts";
import { livekitEnv, mintVoiceToken, endRoomAfter } from "./livekitToken.ts";
import { recordEscalation } from "./callbacks.ts";
import type { ShareDeps } from "./share.ts";

export function realShareDeps(apiKey: string | undefined): ShareDeps {
  return {
    aiConfigured: () => !!apiKey,
    voiceConfigured: () => !!livekitEnv(),
    chat: (brain, messages, voice) => chatReply(brain, messages, apiKey, { voice }),
    analyze: (input) => analyzeSms(input, apiKey),
    mintVoice: (req) => mintVoiceToken(req as any, livekitEnv()!),
    escalate: (input) => recordEscalation(input),
    endRoomAfter: (room, ms) => { const cfg = livekitEnv(); if (cfg) endRoomAfter(room, ms, cfg); },
  };
}
