/* =============================================================================
   CustomerApp — the customer's whole world: /d/<slug>
   -----------------------------------------------------------------------------
   Password screen -> the demo, read-only, with the two live Support agents. Built by
   vite.customer.config.ts as its OWN bundle: the staff app, the Launch screen, the demo library
   and every bundled prospect are not in it (audit:customer proves it). The demo arrives from
   /api/share/<slug>/demo after sign-in and is the only profile this page ever holds.

   Ask AI is off everywhere: openDrawer is a no-op in this build (AiAssistantContext), the
   sparkles are hidden in customer.css, hydrateDemo(canEdit=false) makes the store read-only,
   and the top bar here has none.
   ============================================================================= */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { CustomerProfile } from "../data/schema";
import { ProfileProvider } from "./CustomerProfileContext";
import { SmsCaptureProvider } from "../data/SmsCaptureContext";
import { VoiceCaptureProvider } from "../data/VoiceCaptureContext";
import { QuoteCaptureProvider } from "../data/QuoteCaptureContext";
import { AiAssistantProvider, useAiAssistant } from "../data/AiAssistantContext";
import { ScreenBoundary, DashboardBoundary } from "../components/DashboardBoundary";
import { Sidebar } from "../components/Sidebar";
import { NAV } from "../components/nav";
import { installCustomerApi, type CustomerEvent } from "./api";
import { MyReports } from "../screens/MyReports";
import { SmsConversationIntelligence } from "../screens/SmsConversationIntelligence";
import { VoiceConversationIntelligence } from "../screens/VoiceConversationIntelligence";
import { AgentStudio } from "../screens/AgentStudio";
import { AgentConfig } from "../screens/AgentConfig";
import { KnowledgeSources } from "../screens/KnowledgeSources";
import { KnowledgeDoc } from "../screens/KnowledgeDoc";
import { AiRecommendations } from "../screens/AiRecommendations";
import { AgentWorkflow } from "../screens/AgentWorkflow";
import { SmsPreviewPage } from "../screens/SmsPreviewPage";

/** The rail a customer sees. Everything else in the product is not part of this demo. */
const ALLOWED_NAV = NAV.filter((n) => ["/agent-studio", "/reports"].includes(n.path));

interface Loaded {
  state: "live" | "soft-expired";
  softExpiresAt: string;
  hardCutoffAt: string;
  profile: CustomerProfile;
  customizations: { overrides: Record<string, unknown>; tiles: Record<string, unknown[]> };
  callSeconds: number;
}
type Phase =
  | { kind: "loading" }
  | { kind: "login"; error?: string; busy?: boolean }
  | { kind: "gone" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: Loaded };

const slugOf = () => decodeURIComponent(location.pathname.split("/")[2] ?? "");
const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

async function fetchDemo(slug: string): Promise<Phase> {
  try {
    const res = await fetch(`/api/share/${encodeURIComponent(slug)}/demo`);
    if (res.status === 401) return { kind: "login" };
    if (res.status === 404 || res.status === 410) return { kind: "gone" };
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) return { kind: "error", message: j?.error || "This demo could not be loaded." };
    const parsed = CustomerProfile.safeParse(j.profile);
    if (!parsed.success) return { kind: "error", message: "This demo could not be loaded." };
    return { kind: "ready", data: {
      state: j.state === "soft-expired" ? "soft-expired" : "live",
      softExpiresAt: j.softExpiresAt, hardCutoffAt: j.hardCutoffAt,
      profile: parsed.data, customizations: j.customizations ?? { overrides: {}, tiles: {} },
      callSeconds: j.limits?.voiceCallSeconds ?? 300,
    } };
  } catch {
    return { kind: "error", message: "Could not reach the demo. Check your connection and try again." };
  }
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="cust-gate">
      <div className="cust-card">
        <img className="cust-logo" src="/logo.png" alt="Invoca" />
        {children}
      </div>
    </div>
  );
}

function Login({ error, busy, onSubmit }: { error?: string; busy?: boolean; onSubmit: (pw: string) => void }) {
  const [pw, setPw] = useState("");
  const go = (e: FormEvent) => { e.preventDefault(); if (pw.trim() && !busy) onSubmit(pw); };
  return (
    <Frame>
      <h1 className="cust-h">Your Invoca demo</h1>
      <p className="cust-p">Enter the password you were given to open this demo.</p>
      <form onSubmit={go}>
        <input className="cust-input" type="password" autoFocus autoComplete="off" placeholder="Password"
          value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Password" />
        {error ? <div className="cust-err" role="alert">{error}</div> : null}
        <button className="cust-btn" type="submit" disabled={busy || !pw.trim()}>{busy ? "Checking…" : "Open demo"}</button>
      </form>
    </Frame>
  );
}

/* Live call countdown + escalation confirmation. Driven by the events the fetch shim emits. */
function Banners({ events, softExpired, softDate }: { events: CustomerEvent[]; softExpired: boolean; softDate: string }) {
  const [callEnds, setCallEnds] = useState<number | null>(null);
  const [left, setLeft] = useState(0);
  const [esc, setEsc] = useState<string | null>(null);
  const last = events[events.length - 1];
  useEffect(() => {
    if (!last) return;
    if (last.type === "voice") setCallEnds(Date.now() + last.maxSeconds * 1000);
    if (last.type === "escalation") {
      setEsc(last.kind === "callback"
        ? "Your callback request was received. Someone from the team will follow up."
        : "Your request to speak with a person was received. Someone from the team will follow up.");
      const t = setTimeout(() => setEsc(null), 12000);
      return () => clearTimeout(t);
    }
  }, [last]);
  useEffect(() => {
    if (!callEnds) return;
    const tick = () => { const s = Math.max(0, Math.ceil((callEnds - Date.now()) / 1000)); setLeft(s); if (!s) setCallEnds(null); };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [callEnds]);
  return (
    <div className="cust-banners" aria-live="polite">
      {softExpired ? <div className="cust-banner cust-banner-warn">The live agents in this demo turned off on {softDate}. The workflows and reports are still here to explore.</div> : null}
      {callEnds ? <div className="cust-banner">Demo calls last up to 5 minutes. Time left: {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</div> : null}
      {esc ? <div className="cust-banner cust-banner-ok">{esc}</div> : null}
    </div>
  );
}

function Shell({ data, events }: { data: Loaded; events: CustomerEvent[] }) {
  const { pathname } = useLocation();
  return (
    <div className="app customer-app">
      <header className="topbar">
        <img className="logo" src="/logo.png" alt="Invoca" />
        <span className="cust-name">{data.profile.customerName}</span>
        <span className="cust-until">{data.state === "live" ? `Live agents available until ${fmt(data.softExpiresAt)}` : "Read-only"}</span>
      </header>
      <div className="body">
        <Sidebar items={ALLOWED_NAV} />
        <main className="main">
          <DashboardBoundary key={pathname}><Outlet /></DashboardBoundary>
        </main>
      </div>
      <Banners events={events} softExpired={data.state === "soft-expired"} softDate={fmt(data.softExpiresAt)} />
    </div>
  );
}

/* Loads the saved data layer read-only BEFORE any screen renders, so nothing paints defaults first. */
function Hydrate({ data, children }: { data: Loaded; children: ReactNode }) {
  const { hydrateDemo } = useAiAssistant();
  const [done, setDone] = useState(false);
  useEffect(() => {
    hydrateDemo(data.profile.id, data.customizations as any, false, { name: "", email: "" });
    setDone(true);
  }, [data, hydrateDemo]);
  return done ? <>{children}</> : null;
}

function Demo({ data, slug }: { data: Loaded; slug: string }) {
  const [events, setEvents] = useState<CustomerEvent[]>([]);
  const emit = useCallback((e: CustomerEvent) => setEvents((p) => [...p, e]), []);
  useEffect(() => { installCustomerApi(slug, emit); }, [slug, emit]);
  return (
    <ProfileProvider profile={data.profile}>
      <SmsCaptureProvider><VoiceCaptureProvider><QuoteCaptureProvider><AiAssistantProvider>
        <Hydrate data={data}>
          <BrowserRouter basename={`/d/${slug}`}>
            <ScreenBoundary>
              <Routes>
                <Route path="/" element={<Navigate to="/agent-studio" replace />} />
                <Route path="/agent-studio/agent/preview" element={<SmsPreviewPage />} />
                <Route element={<Shell data={data} events={events} />}>








                  <Route path="/reports" element={<MyReports />} />
                  <Route path="/reports/sms-conversation-intelligence" element={<SmsConversationIntelligence />} />
                  <Route path="/reports/voice-conversation-intelligence" element={<VoiceConversationIntelligence />} />
                  <Route path="/agent-studio" element={<AgentStudio />} />
                  <Route path="/agent-studio/agent" element={<AgentConfig />} />
                  <Route path="/agent-studio/agent/knowledge" element={<KnowledgeSources />} />
                  <Route path="/agent-studio/agent/knowledge/doc" element={<KnowledgeDoc />} />
                  <Route path="/agent-studio/agent/recommendations" element={<AiRecommendations />} />
                  <Route path="/agent-studio/agent/workflow/sms" element={<AgentWorkflow />} />
                  <Route path="/agent-studio/agent/workflow/voice" element={<AgentWorkflow />} />
                  <Route path="*" element={<Navigate to="/agent-studio" replace />} />
                </Route>
              </Routes>
            </ScreenBoundary>
          </BrowserRouter>
        </Hydrate>
      </AiAssistantProvider></QuoteCaptureProvider></VoiceCaptureProvider></SmsCaptureProvider>
    </ProfileProvider>
  );
}

export function CustomerApp() {
  const slug = useMemo(slugOf, []);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  useEffect(() => { fetchDemo(slug).then(setPhase); }, [slug]);

  const login = useCallback(async (password: string) => {
    setPhase({ kind: "login", busy: true });
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(slug)}/login`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
      });
      if (res.status === 410) return setPhase({ kind: "gone" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        return setPhase({ kind: "login", error: j?.error || "That password didn't work." });
      }
      setPhase(await fetchDemo(slug));
    } catch {
      setPhase({ kind: "login", error: "Could not reach the demo. Check your connection and try again." });
    }
  }, [slug]);

  useEffect(() => { document.title = phase.kind === "ready" ? `${phase.data.profile.customerName} demo` : "Demo"; }, [phase]);

  if (phase.kind === "loading") return <Frame><p className="cust-p">Loading…</p></Frame>;
  if (phase.kind === "gone") return <Frame><h1 className="cust-h">This demo link is no longer available</h1><p className="cust-p">Please contact your Invoca representative for a new one.</p></Frame>;
  if (phase.kind === "error") return <Frame><h1 className="cust-h">Something went wrong</h1><p className="cust-p">{phase.message}</p></Frame>;
  if (phase.kind === "login") return <Login error={phase.error} busy={phase.busy} onSubmit={login} />;
  return <Demo data={phase.data} slug={slug} />;
}
