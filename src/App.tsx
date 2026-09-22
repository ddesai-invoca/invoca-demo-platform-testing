import { useEffect, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { ScreenBoundary } from "./components/DashboardBoundary";
import { ProfileProvider } from "./data/ProfileContext";
import { SmsCaptureProvider } from "./data/SmsCaptureContext";
import { VoiceCaptureProvider } from "./data/VoiceCaptureContext";
import { QuoteCaptureProvider } from "./data/QuoteCaptureContext";
import { AiAssistantProvider } from "./data/AiAssistantContext";
import { DemoLibraryProvider } from "./data/DemoLibraryContext";
import { AppShell } from "./layout/AppShell";
import { DigitalInsights } from "./screens/DigitalInsights";
import { MyReports } from "./screens/MyReports";
import { ConversationIntelligence } from "./screens/ConversationIntelligence";
import { SmsConversationIntelligence } from "./screens/SmsConversationIntelligence";
import { VoiceConversationIntelligence } from "./screens/VoiceConversationIntelligence";
import { ArtifactView } from "./screens/ArtifactView";
import { MarketingDashboard } from "./screens/MarketingDashboard";
import { MarketingOpsDashboard } from "./screens/MarketingOpsDashboard";
import { AiAgentConversionDashboard } from "./screens/AiAgentConversionDashboard";
import { AiMessagingImpactDashboard } from "./screens/AiMessagingImpactDashboard";
import { QualityManagementDashboard } from "./screens/QualityManagementDashboard";
import { QmInstantInsightsDashboard } from "./screens/QmInstantInsightsDashboard";
import { LocationComparisonDashboard } from "./screens/LocationComparisonDashboard";
import { FranchiseAiDashboard } from "./screens/FranchiseAiDashboard";
import { ManageDashboards } from "./screens/ManageDashboards";
import { InsightsAnalytics } from "./screens/InsightsAnalytics";
import { InsightsReport } from "./screens/InsightsReport";
import { InsightsAddTile } from "./screens/InsightsAddTile";
import { InsightsColumnPicker } from "./screens/InsightsColumnPicker";
import { TsGallery } from "./screens/TsGallery";
import { InsightsCallDetail } from "./screens/InsightsCallDetail";
import { CallReview } from "./screens/CallReview";
import { CallDetail } from "./screens/CallDetail";
import { AgentStudio } from "./screens/AgentStudio";
import { AgentConfig } from "./screens/AgentConfig";
import { KnowledgeSources } from "./screens/KnowledgeSources";
import { AiRecommendations } from "./screens/AiRecommendations";
import { AgentWorkflow } from "./screens/AgentWorkflow";
import { SignalManager } from "./screens/SignalManager";
import { SignalTypeSelect } from "./screens/SignalTypeSelect";
import { SemanticSignalLibrary } from "./screens/SemanticSignalLibrary";
import { SemanticSignalActivate } from "./screens/SemanticSignalActivate";
import { SignalAiStudio } from "./screens/SignalAiStudio";
import { VerifyLabels } from "./screens/VerifyLabels";
import { EditRuleSignal } from "./screens/EditRuleSignal";
import { Launch } from "./screens/Launch";
import { SmsPreviewPage } from "./screens/SmsPreviewPage";
import { ChatGptAd } from "./screens/ChatGptAd";
import { Integrations } from "./screens/Integrations";
import { SalesforceHome } from "./screens/SalesforceHome";
import { SalesforceCalendar } from "./screens/SalesforceCalendar";
import { SalesforceLeads } from "./screens/SalesforceLeads";
import { SalesforceCallLog } from "./screens/SalesforceCallLog";
import { SalesforceLeadDetail } from "./screens/SalesforceLeadDetail";
import { SalesforceCallLogDetail } from "./screens/SalesforceCallLogDetail";
import { ReplicaPageScreen } from "./screens/ReplicaPage";
import { GoogleSearch } from "./screens/GoogleSearch";
import { Placeholder } from "./screens/Placeholder";
import { EnvBadge } from "./components/EnvBadge";
import { AdminNoticeModal } from "./components/AdminNoticeModal";
import { LaunchMenu } from "./components/LaunchMenu";
import { FeedbackBoard } from "./screens/FeedbackBoard";
import { ReleaseNotes } from "./screens/ReleaseNotes";
import { IngestOMatic } from "./screens/IngestOMatic";
import { NAV } from "./components/nav";

/* Some screens are EXACT static copies of real pages (the Invoca Exchange and
   the Shady Blinds Google Ads console), served from public/*.html so the real
   HTML/CSS/assets render untouched. We hand off via a full-page load. */
function StaticRedirect({ to }: { to: string }) {
  useEffect(() => { window.location.replace(to); }, [to]);
  return null;
}

/* Screens we've built get real components; everything else in the nav routes
   to a Placeholder for now (so the nav is fully clickable end-to-end). */
const BUILT: Record<string, ReactNode> = {
  "/reports": <MyReports />,
  "/insights": <InsightsAnalytics />,
  "/dashboards": <ManageDashboards />,
  "/call-review": <CallReview />,
  "/agent-studio": <AgentStudio />,
  "/signal": <SignalManager />,
};

/* Standalone screens render OUTSIDE the app shell (their own full-page chrome). */
/* The in-platform Integrations page renders INSIDE the app shell now, so it is no longer
   standalone; the exact-copy marketing page still is. */
const STANDALONE = new Set(["/invoca-exchange"]);

/* WHERE OUR OWN CHROME MAY APPEAR: the launch form only. Past it every screen is
   a replica of Invoca's product shown to a prospect, and our buttons do not
   belong on top of that. Unchanged when the bottom-right stack of three pills
   became one top-right hamburger (9/10/2026) — if anything the rule matters MORE
   there, since the top right of a replica is where real product chrome sits. */
const MENU_ON = ["/", "/launch", "/feedback", "/release-notes"];
function LaunchCorner() {
  const { pathname } = useLocation();
  if (!MENU_ON.includes(pathname)) return null;
  /* Read.Me, Support and the admin Inbox all live inside it now. Add the next one
     as an entry in its `items` array, not as a second button out here. */
  return <LaunchMenu />;
}

export default function App() {
  return (
    <ProfileProvider>
      <DemoLibraryProvider>
      <SmsCaptureProvider>
      <VoiceCaptureProvider>
      <QuoteCaptureProvider>
      <AiAssistantProvider>
      <BrowserRouter>
        {/* ⚠️⚠️ INSIDE THE ROUTER BUT OUTSIDE `<Routes>`, and NOT inside `LaunchCorner`.
            A first attempt put it in that stack, which returns null unless the pathname is
            the launch form — so the badge existed only on the one screen that is already
            obviously our own tool, and on every replica screen (where it actually matters)
            it rendered nothing. It must be identifiable on the standalone screens too: the
            phone preview, Google Search and the Salesforce pages all render outside the
            shell, so a TopBar chip would miss them as well. */}
        <EnvBadge />
        {/* ⚠️ SAME REASONING AS `EnvBadge` DIRECTLY ABOVE: inside the router but
            outside `<Routes>`, so it can render whichever route someone lands on
            right after signing in — including the standalone ones a route-scoped
            mount would miss entirely. It renders nothing until the server says
            there is a notice to show (`DemoLibraryContext.adminNotice`). */}
        <AdminNoticeModal />
        {/* ⚠️⚠️ **EVERY ROUTE GETS A NET, INCLUDING THE SHELL'S OWN CHROME (9/16/2026).**
            `DashboardBoundary` lives INSIDE `AppShell`, around its `<Outlet/>` — so it
            catches a screen, and catches nothing thrown by the TopBar, the Sidebar, or any
            of the standalone routes above (Launch, the phone preview, Google Search, the
            four Salesforce screens, `/replica`). Any of those throwing blanked the whole
            app and reported nothing.
            ⚠️ Nesting is deliberate: React uses the NEAREST boundary, so an in-shell screen
            still gets `DashboardBoundary`'s Undo fallback and this one only ever handles
            what that cannot reach. */}
        <ScreenBoundary>
        <Routes>
          {/* Launch screen (new prospect / revisit) — full-page, outside the shell */}
          <Route path="/" element={<Launch />} />
          <Route path="/launch" element={<Launch />} />

          {/* Feedback board. Full-page like Launch (outside the shell): it is about
              the TOOL, not about a prospect's demo, so wrapping it in the Invoca
              replica chrome would misrepresent what you are looking at. */}
          <Route path="/feedback" element={<FeedbackBoard />} />

          {/* Release notes. Full-page and outside the shell for the same reason as
              the feedback board — it is about the tool, not a prospect's demo. */}
          <Route path="/release-notes" element={<ReleaseNotes />} />

          {/* Demo Call Ingest-O-Matic. Full-page and outside the shell, same reason
              as the feedback board and release notes — it's an admin tool about the
              platform itself, not a prospect-facing replica screen. Admin-gated
              server-side (every /api/ingest/* route checks isAdmin); reachable only
              from the hamburger menu, which is itself hidden for non-admins. */}
          <Route path="/ingest-o-matic" element={<IngestOMatic />} />

          {/* Standalone full-page routes (no sidebar/topbar) — exact static copies */}
          {/* ⚠️ THE OLD EXACT-COPY OF invoca.com/integrations IS NOT DELETED — it still
              serves at /invoca-exchange and as the static file. It is a working replica of
              a DIFFERENT (marketing-site) page and the Google Ads tile inside it still
              works; the sidebar simply opens the in-platform page now. */}
          <Route path="/invoca-exchange" element={<StaticRedirect to="/invoca-exchange.html" />} />
          <Route path="/integrations/google-ads" element={<StaticRedirect to="/google-ads.html" />} />

          {/* ⚠️ SALESFORCE IS STANDALONE — no Invoca sidebar or top bar. It is a different
              product's console, the same call the Google Ads page makes; wrapping it in
              Invoca chrome would misrepresent what the SE is looking at. Reached from the
              Sales Cloud tile on Integrations. */}
          <Route path="/salesforce" element={<SalesforceHome />} />
          <Route path="/salesforce/calendar" element={<SalesforceCalendar />} />
          <Route path="/salesforce/leads" element={<SalesforceLeads />} />
          <Route path="/salesforce/call-log" element={<SalesforceCallLog />} />
          <Route path="/salesforce/leads/:slug" element={<SalesforceLeadDetail />} />
          <Route path="/salesforce/call-log/:name" element={<SalesforceCallLogDetail />} />

          {/* ChatGPT sponsored placement — the AI-channel counterpart to the
              Google Ads page: where the call starts, before Invoca sees it.
              Profile-driven, so it re-skins per prospect like the app screens. */}
          <Route path="/integrations/chatgpt" element={<ChatGptAd />} />

          {/* Google results page, opened from the "Network" chip in the top bar.
              The other half of the same story: the prospect holds the top
              sponsored slot, and the click carries the paid parameters into
              their site. Standalone, because it is not an Invoca screen. */}
          <Route path="/google-search" element={<GoogleSearch />} />
          {/* The prospect's own booking page, replicated — opened by Replicate in the
              Book online menu. Standalone like the search screen: it is somebody else's
              site, so it must not render inside Invoca chrome. */}
          <Route path="/replica" element={<ReplicaPageScreen />} />
          <Route path="/replica/:slug" element={<ReplicaPageScreen />} />

          {/* Preview Agent (SMS) — opens in its own browser tab from Agent Workflow */}
          <Route path="/agent-studio/agent/preview" element={<SmsPreviewPage />} />

          {/* Everything else lives inside the app shell */}
          <Route element={<AppShell />}>
            {/* ⚠️ IN-SHELL, unlike the exact-copy page it replaced. This one is Invoca's
                own in-platform screen, so it carries the sidebar and top bar; the previous
                route was in the standalone group and rendering it there left the page
                floating with no chrome. */}
            <Route path="/integrations" element={<Integrations />} />
            {/* Reports nav → My Reports list; individual reports open from there */}
            {/* A saved Insights dashboard. The real URL carries a uuid; we pass
                the name so the title matches the row that was clicked. */}
            <Route path="/insights/dashboard/:name" element={<InsightsReport />} />
            {/* The one call reachable from the interaction drawer. NOT the Call Review
                detail page (/call-review/detail) — different Invoca screen, left alone. */}
            <Route path="/insights/add-tile" element={<InsightsAddTile />} />
            <Route path="/insights/add-tile/:report" element={<InsightsColumnPicker />} />
            <Route path="/ts-gallery" element={<TsGallery />} />
            <Route path="/insights/call" element={<InsightsCallDetail />} />
            <Route path="/reports/digital-insights" element={<DigitalInsights />} />
            <Route path="/reports/conversation-intelligence" element={<ConversationIntelligence />} />
            {/* The Signal AI tier pair — same screen, same template, different engine.
                Health Spring only; the screen itself refuses on any other prospect. */}
            <Route path="/reports/conversation-intelligence/silver" element={<ConversationIntelligence tier="silver" />} />
            <Route path="/reports/conversation-intelligence/gold" element={<ConversationIntelligence tier="gold" />} />
            <Route path="/reports/sms-conversation-intelligence" element={<SmsConversationIntelligence />} />
            {/* The quote-request threads, listed as "AI SMS Conversation Intelligence (LSA)".
                Same component, opt-in filter — see its own header. */}
            <Route path="/reports/sms-conversation-intelligence/lsa" element={<SmsConversationIntelligence only="lsa" />} />
            <Route path="/reports/voice-conversation-intelligence" element={<VoiceConversationIntelligence />} />
            <Route path="/reports/artifact/:id" element={<ArtifactView />} />
            {/* Dashboards nav → Manage list; individual dashboards open from there */}
            {/* Agent Studio → agent configuration editor (opened from a workflow row) */}
            <Route path="/agent-studio/agent" element={<AgentConfig />} />
            <Route path="/agent-studio/agent/knowledge" element={<KnowledgeSources />} />
            <Route path="/agent-studio/agent/recommendations" element={<AiRecommendations />} />
            <Route path="/agent-studio/agent/workflow/:channel" element={<AgentWorkflow />} />
            {/* A workflow the SE created with the Create Workflow modal. Its own path segment,
                so `:channel` can never swallow it and the two built-in pages are unaffected. */}
            <Route path="/agent-studio/agent/workflow/new/:id" element={<AgentWorkflow />} />
            <Route path="/dashboards/marketing" element={<MarketingDashboard />} />
            <Route path="/dashboards/marketing-ops" element={<MarketingOpsDashboard />} />
            <Route path="/dashboards/ai-agent-conversion" element={<AiAgentConversionDashboard />} />
            <Route path="/dashboards/ai-messaging-impact" element={<AiMessagingImpactDashboard />} />
            <Route path="/dashboards/quality-management" element={<QualityManagementDashboard />} />
            <Route path="/dashboards/qm-instant-insights" element={<QmInstantInsightsDashboard />} />
            <Route path="/dashboards/location-comparison" element={<LocationComparisonDashboard />} />
            <Route path="/dashboards/ai-conversion-by-location" element={<FranchiseAiDashboard />} />
            <Route path="/call-review/detail" element={<CallDetail />} />
            {/* Signal's flyout offers three destinations. Manage Signals is /signal
                (SignalManager, via the NAV loop below); these two are not built yet. */}
            <Route path="/signal/rule" element={<EditRuleSignal />} />
            <Route path="/signal/new" element={<SignalTypeSelect />} />
            <Route path="/signal/new/semantic" element={<SemanticSignalLibrary />} />
            {/* Activating one of the library's templates. The real page identifies the
                template by standardDataFieldName, so the query string matches it. */}
            <Route path="/signal/new/semantic/activate" element={<SemanticSignalActivate />} />
            <Route path="/signal/ai-studio" element={<SignalAiStudio />} />
            <Route path="/signal/ai-studio/verify/:modelId" element={<VerifyLabels />} />
            <Route path="/signal/discovery" element={<Placeholder name="Signal Discovery" />} />
            {NAV.filter((item) => !STANDALONE.has(item.path)).map((item) => (
              <Route
                key={item.path}
                path={item.path}
                element={BUILT[item.path] ?? <Placeholder name={item.label} />}
              />
            ))}
          </Route>
        </Routes>
        </ScreenBoundary>
        {/* Outside <Routes> so it renders on every screen, Launch included -- but inside
            <BrowserRouter>, because they read the path to stay off the prospect-facing
            pages. Both live in one fixed corner stack so they cannot overlap. */}
        <LaunchCorner />
      </BrowserRouter>
      </AiAssistantProvider>
      </QuoteCaptureProvider>
      </VoiceCaptureProvider>
      </SmsCaptureProvider>
      </DemoLibraryProvider>
    </ProfileProvider>
  );
}
