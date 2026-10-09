/* =============================================================================
   core.ts — the reusable demo generation pipeline
   -----------------------------------------------------------------------------
   Input:  a customer name + website URL (+ optional API key / progress hook)
   Output: a validated CustomerProfile object.

   Both the CLI (engine/generate.ts) and the dev-server endpoint
   (POST /api/generate, wired in vite.config.ts) call generateProfile().

   Pipeline:
     1. RESEARCH  — Claude reads the customer's site (web_fetch + web_search)
                    and writes a business brief.
     2. GENERATE  — Claude turns the brief into demo data, constrained to the
                    schema via structured outputs, then Zod-validated.
   ============================================================================= */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { CustomerProfile, DigitalInsightsReport, InteractionRow, DashboardView, KpiGroup, Breakdown, MultiSeriesChart, CallReviewView, CallDetailView, OpsDashboardView, AiAgentConversionView, AiMessagingImpactView, ConversationIntelligenceView, SmsConversationIntelligenceView, SmsConversation, VoiceConversationIntelligenceView, VoiceConversation, AgentConfigView, VoiceScreenpop, SmsScreenpop, VoiceRoutingDemo, QualityManagementView, QmInstantInsightsView, SignalManagerView } from "../src/data/schema.ts";
import { sweepValue } from "./dashSweep.ts";

const QM_SCORE_MEAN = 71;   // true mean of the agent scorecard series
export const MODEL = "claude-opus-4-8";
const FAST_MODEL = "claude-haiku-4-5-20251001";

/* Identity + canonical terminology, chosen FAST up-front (a tiny call before the pool)
   since bookingTerm/customerNoun/qualifiedCallTerm/conversionTerm are reused by every
   section. The heavy Digital Insights table is generated SEPARATELY as a pool phase
   (generateDigitalInsights) — nothing else reads it, so it needn't block the pool. */
const TermsOutput = z.object({
  networkName: z.string(),
  industry: z.string(),
  bookingTerm: z.string(),
  customerNoun: z.string(),
  qualifiedCallTerm: z.string(),
  conversionTerm: z.string(),
  monthlyCalls: z.number(),      // enterprise-scale inbound calls for ONE month
  avgSaleAmount: z.number(),     // realistic won-deal value for THIS vertical
  purchaseRatePct: z.number(),   // % of all calls that end in a won sale
});

/* ---- Canonical scale ------------------------------------------------------
   ONE month, ONE call volume, ONE revenue figure, shared by every screen.

   Before this existed each phase invented its own period and volume, so the
   demo told the prospect they had 628 calls on one dashboard and 5,139 on the
   next — across two different years. Now the volume is chosen ONCE (by the
   terms phase, which has read the business brief and can judge what's credible
   for the vertical) and every phase is handed the same anchors. */
export const DATE_RANGE = "1/1/2026-1/31/2026";
export const DATE_RANGE_LONG = "Jan 1, 2026 - Jan 31, 2026";
/* Weekly buckets covering the month exactly (4+7+7+7+6 = 31 days). Charts use
   these instead of an arbitrary 6-day window, so no chart can cover a period
   the date filter above it doesn't. */
export const WEEK_LABELS = ["Jan 1-4", "Jan 5-11", "Jan 12-18", "Jan 19-25", "Jan 26-31"];

export interface Scale {
  calls: number; salesPct: number; purchases: number; purchasePct: number;
  revenue: number; avgSale: number; revPerCall: number;
  consultations: number; consultPct: number;
  nonSalesCalls: number; answered: number; notAnswered: number; answerRatePct: number;
}

export function buildScale(t: z.infer<typeof TermsOutput>, name = ""): Scale {
  /* Real reporting never lands on a round number, and a round total is the
     fastest way for a prospect to spot invented data. So nothing here is
     rounded to a boundary: the volume keeps whatever odd tail the model gave
     it (only nudged off a multiple of 100 if it arrived tidy), and revenue
     carries a deterministic residual because a month's revenue is the sum of
     thousands of different ticket sizes, never an exact multiple of the mean. */
  /* Nudge by a deterministic, name-derived amount (<1.5%). Both of the first
     two live generations came back with a volume copied verbatim from this
     prompt's examples, so two unrelated prospects shared a call count. The
     examples are gone now, but this makes a collision structurally impossible:
     the offset is stable per prospect (same name -> same number) and far too
     small to disturb a volume the model chose deliberately. */
  let seed = 0;
  for (const ch of name) seed = (seed * 31 + ch.charCodeAt(0)) % 100003;
  const asked = Math.round(t.monthlyCalls || 48293);
  let calls = Math.max(1153, asked);
  // Warn only when the FLOOR actually bit -- compare before applying the
  // per-prospect offset below, or every prospect trips a warning about a
  // clamp that never happened.
  if (calls !== asked) {
    console.warn(`[scale] raised monthly calls ${asked} -> ${calls}: below this the breakdown tables
      round to zero rows. Revenue for this prospect will read high — a very-low-volume,
      very-high-ticket business does not fit these dashboards cleanly.`);
  }
  calls += seed % Math.max(7, Math.round(calls * 0.014));
  // Nudge by 1-9, never 10: `7 + (n % 7)` can land on exactly 10 and carry a
  // multiple of ten straight onto the next one (47,560 -> 47,570).
  if (calls % 10 === 0) calls += 1 + ((calls / 10) % 9);
  const salesPct = 84;
  const purchasePct = Math.min(45, Math.max(2, Math.round(t.purchaseRatePct || 25)));
  const purchases = Math.round((calls * purchasePct) / 100);
  const avgSale = Math.max(150, Math.round(t.avgSaleAmount || 3000));
  const gross = purchases * avgSale;
  let revenue = gross + Math.round(gross * (0.0003 + ((calls % 89) / 89) * 0.0009));
  if (revenue % 10 === 0) revenue += 3 + (calls % 7);   // never let it settle on a round total
  const consultPct = Math.min(salesPct - 5, purchasePct + 20);
  const answered = Math.round(calls * 0.92);
  return {
    calls, salesPct, purchases, purchasePct, revenue, avgSale,
    revPerCall: revenue / calls,
    consultations: Math.round((calls * consultPct) / 100), consultPct,
    nonSalesCalls: Math.round((calls * (100 - salesPct)) / 100),
    answered, notAnswered: calls - answered,
    answerRatePct: Math.round((answered / calls) * 100),
  };
}

const n = (v: number) => v.toLocaleString("en-US");
const $ = (v: number) => "$" + Math.round(v).toLocaleString("en-US");

/* Prepended to every DATA prompt. These are the rules that stop a prospect
   finding an impossible number in a live demo. */
function scaleRules(s: Scale, bookingTerm: string): string {
  return (
    `CANONICAL NUMBERS — every screen in this demo describes the SAME month and the SAME business. Use these EXACT figures:\n` +
    `- dateRange: "${DATE_RANGE}" (one calendar month). NEVER invent a different period, year, or window.\n` +
    `- Total calls for the month: ${n(s.calls)}. Total revenue: ${$(s.revenue)}. Won sales: ${n(s.purchases)} (${s.purchasePct}% of calls, ${$(s.avgSale)} average).\n` +
    `- ${bookingTerm}s scheduled: ${n(s.consultations)} (${s.consultPct}% of calls). Calls answered by an agent: ${n(s.answered)} (${s.answerRatePct}%).\n` +
    `ARITHMETIC RULES (a prospect WILL add these up):\n` +
    `1. A breakdown that is a COMPLETE partition of the calls (e.g. Line of Business, Region, Product Category, New vs Existing) MUST have its Call Count column sum to EXACTLY ${n(s.calls)} and its revenue column sum to EXACTLY ${$(s.revenue)}.\n` +
    `2. A "top 5" breakdown of a long tail (Campaign, Search Term) must sum to LESS than the total — never more. No subset may ever exceed its parent (a search term cannot have more calls than the whole paid-search channel).\n` +
    `3. Percentages of mutually exclusive categories must sum to exactly 100%. No percentage may exceed 100%.\n` +
    `4. Funnel order must hold on EVERY row: calls >= ${bookingTerm}s scheduled >= won sales. Never show more completed sales than scheduled visits.\n` +
    `5. count x percent must equal the count shown elsewhere for the same thing, and revenue / won-sales must land near ${$(s.avgSale)} on every row (no row at $800 next to a row at $4,000).\n` +
    `6. Never pair a non-zero conversion percent with $0 revenue, or a 0 count with revenue.\n` +
    `7. Chart series must sum to the KPI tile they roll up into, and a chart must cover the SAME period as the date range — use the weekly buckets ${JSON.stringify(WEEK_LABELS)} as xLabels unless told otherwise.\n` +
    `8. Use "${bookingTerm}" for the scheduled-visit metric EVERYWHERE. Never drift to "Appointment"/"Consultation" if that is not the bookingTerm.\n` +
    `9. NO ROUND NUMBERS, and this applies to EVERY ROW, not just the totals. Real reporting never lands on 22,000 calls or $4,750,000 — every count and every dollar figure needs its own odd tail (22,417 / 11,864 / 6,952 / $4,755,155).\n` +
    `   In particular do NOT build a table out of round rows plus one odd row that absorbs the remainder — "22,000 / 11,000 / 7,000 / 3,000 / 4,318" is exactly the pattern that gives a demo away. Vary every row independently, then make them sum to the required total.`
  );
}

/* The "volume is not value" story the SE tells on every Call Outcome Summary.

   ⚠️ THIS WAS BEING IGNORED, and in the worst cases INVERTED. Audited across the ten
   profiles on disk: four of them (autonation, continuing-life, key-whitman,
   orlando-health) had the biggest row carrying the BEST rate on all six breakdowns —
   exactly backwards, so the tile said "your biggest channel is also your best" and the
   SE's line does not land. Two recent profiles still missed it on ONE breakdown each
   (Product Category, Region).

   The likely reason is ambiguity: every breakdown has TWO percent columns, so "the
   WORST rate" did not say which one. It now names the column explicitly, spells out
   the comparison as a rule about the first and last row of a descending table, and
   says it applies to EVERY breakdown rather than leaving Product Category and Region
   to be inferred. Paired with a canary check (engine/canary.ts) — prompt-only was not
   holding, which is the same instruct-then-enforce lesson as the dashes and rule 2. */
function outcomeStory(): string {
  return (
    `STORY REQUIREMENT — applies to EVERY breakdown you produce, WITHOUT EXCEPTION, including Product Category and Region, not just the marketing channels:\n` +
    `Rows are ordered by Call Count DESCENDING. The metric this rule is about is the CONVERSION column — the third column, "<conversion term> (Percent)" — NOT the "Quote Discussed" or "Set (Industry)" column beside it.\n` +
    `- The FIRST row (the largest Call Count) MUST have the LOWEST conversion percent of all the rows in that table.\n` +
    `- The LAST row (the smallest Call Count) MUST have the HIGHEST conversion percent of all the rows in that table.\n` +
    `- Aim for roughly a 2-3x spread between those two, and let the middle rows fall between them.\n` +
    `CHECK EACH TABLE BEFORE YOU RETURN IT: read the conversion column top to bottom and confirm it ends higher than it starts. Getting this backwards — biggest row with the best rate — breaks the whole point of the tile, which is the seller being able to say "your biggest channel is not your best channel." Revenue still scales with volume, so the biggest row can and should still hold the most revenue; it is the RATE that must be worst.`
  );
}

/* Prepended to every generation prompt: force the model to re-skin ALL wording to
   the prospect's vertical, while keeping each section's structure identical. */
/* Injected into EVERY phase via reskin(), which all 17 of them call. SEs show
   this text to real prospects, and dash-joined clauses are the clearest
   "written by an AI" tell. The live agents in engine/chat.ts additionally strip
   dashes from output, because a prompt rule alone gets ignored; here there is no
   equivalent post-step, so generated profiles get swept by
   scripts/strip-dashes.ts instead. */
const NO_DASH_RULE =
  ` NEVER use an em dash, an en dash, or a hyphen joining two clauses, in ANY ` +
  `text you produce: labels, summaries, transcripts, descriptions. Use a comma, ` +
  `a full stop, or a new sentence. Hyphens INSIDE a compound word are fine ` +
  `("pre-owned", "rear-ended", "24-48h"). This is not stylistic: dashes make the ` +
  `demo read as machine-generated.`;

/* =============================================================================
   The Marketing SOURCE rows name the two channels this platform can actually SHOW
   -----------------------------------------------------------------------------
   Asked for directly (9/12/2026): *"replace Youtube and facebook in the marketing source in
   all the dashboards and replace it Google LSA and ChatGPT."* The demo now has a Google Local
   Services ad screen and a ChatGPT sponsored-ad screen, and neither channel appeared in the
   attribution data an SE opens straight afterwards.

   ⚠️⚠️ **ONE STRING, THREE PROMPTS.** The Marketing Source rows are generated in three
   separate phases — `dashboardChannels`, `opsDashboard` and `aiAgentConversion` — and a rule
   pasted into two of them is how a prospect ends up with Google LSA on one dashboard and
   Facebook on another, which is exactly the drift this file already records for the
   conversion-term labels.

   ⚠️ **SOURCE ONLY — Facebook is still a perfectly good MEDIUM**, and the rename layer in
   `src/data/marketingSources.ts` is scoped the same way for the same reason (measured: those
   words appear 370 times as a medium and 366 times inside a landing-page URL, against 97 as a
   source). Say so explicitly or the model helpfully scrubs them everywhere.

   ⚠️ Generation is instruct-then-enforce, as everywhere else here: this ASKS, and the load-time
   rename makes sure — including for the ~380 profiles that already exist and for the shared
   library on the server, which no prompt can reach. */
function sourceRows(): string {
  return `MARKETING SOURCE ROWS: two of the Marketing Source rows must be EXACTLY "Google LSA" `
    + `and EXACTLY "ChatGPT" — this business advertises through Google Local Services Ads and `
    + `through ChatGPT's sponsored answers, and both drive calls. The remaining source rows are `
    + `this business's own real channels (e.g. Google, Bing, Direct, Organic Search, Referral). `
    + `NEVER use "Facebook" or "YouTube" as a Marketing SOURCE. They remain fine as a Marketing `
    + `MEDIUM and inside a landing-page URL's utm_source, which you must NOT change.`;
}

function reskin(name: string): string {
  return (
    `RE-SKIN EVERYTHING to ${name}'s industry. Use the exact terminology THIS business/vertical uses for: what it calls its customers (customer/patient/member/client/guest/rider…), its products & services, its locations (store/branch/showroom/clinic/dealership/gym…), its call reasons, and its conversion events. ` +
    `Keep each section's STRUCTURE identical (same number of columns, KPI tiles/groups, rows, and chart series) — only the wording and the numbers change to fit ${name}. ` +
    `Never leave a generic or wrong-industry label (e.g. don't say "Purchase"/"Warranty"/"Showroom"/"Customer" if a different word fits ${name} better). ` +
    `Keep ONLY these platform-fixed labels verbatim: "Marketing Source", "Marketing Medium", "Marketing Campaign", "Marketing Search Term(s)", "Call Count", and "Total Revenue (Sale Amount)".` +
    NO_DASH_RULE
  );
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
export function domainOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

/* ---- JSON Schema for structured outputs ----------------------------------
   Convert the Zod schema, then force Anthropic's requirements: every object
   gets additionalProperties:false and a complete `required` list. */
function sanitize(node: any): any {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) node[k] = sanitize(node[k]);
    if (node.type === "object" && node.properties) {
      node.additionalProperties = false;
      node.required = Object.keys(node.properties);
    }
  }
  return node;
}
function toSchema(zodType: any): any {
  const raw = z.toJSONSchema(zodType, { target: "draft-2020-12" }) as any;
  delete raw.$schema;
  return sanitize(raw);
}

/* Run async task thunks with at most `limit` in flight at once, preserving result
   order + types (tuple in → tuple out). Beats fixed Promise.all batches: a freed
   slot immediately starts the next task instead of waiting for a whole batch's
   slowest member, so fast phases never leave a slot idle. Peak concurrency == limit
   (same rate-limit headroom as the old batches). */
async function runPool<T extends readonly (() => Promise<unknown>)[] | []>(
  tasks: T,
  limit: number,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const results: any[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const idx = next++;
      results[idx] = await tasks[idx]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

type Progress = (e: { phase: string; status: "start" | "done" }) => void;

/* ---- The pipeline (parameterized; no module-level globals) ----------------
   Uses STREAMING: with large max_tokens + high effort a phase can exceed the
   SDK's 10-minute non-streaming ceiling (which throws before the request is even
   sent), so we stream and await the final message. */
export async function structured<T>(client: Anthropic, zodType: any, prompt: string, maxTokens: number, model: string = MODEL): Promise<T> {
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    // `thinking: adaptive` and `output_config.effort` are Opus-only — Haiku
    // (FAST_MODEL) 400s on either, so gate both to MODEL.
    ...(model === MODEL ? { thinking: { type: "adaptive" } } : {}),
    output_config: {
      ...(model === MODEL ? { effort: "high" } : {}),
      format: { type: "json_schema", schema: toSchema(zodType) },
    },
    messages: [{ role: "user", content: prompt }],
  } as any);
  const response = await stream.finalMessage();
  const text = (response.content.find((b: any) => b.type === "text") as any)?.text;
  if (!text) {
    // Almost always max_tokens exhausted by adaptive thinking before any text
    // was emitted — say so, instead of sending the next reader prompt-hunting.
    throw new Error(
      `Generation produced no output (stop_reason=${response.stop_reason}, max_tokens=${maxTokens}, ` +
      `used=${response.usage?.output_tokens}). If stop_reason is "max_tokens", raise the budget for this phase.`);
  }
  return zodType.parse(JSON.parse(text)) as T;
}

export async function research(client: Anthropic, name: string, url: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Research the company "${name}" whose website is ${url}. ` +
            `Fetch that URL and search the web as needed. Produce a concise brief covering:\n` +
            `- what the business sells and its industry\n` +
            `- their main product/service CATEGORIES and 8–15 specific product/service NAMES with realistic US price points\n` +
            `- for each product, a one-line "components/features" description\n` +
            `- the marketing channels they likely use (Paid Search, Social Media, Organic, etc.) and plausible campaign names\n` +
            `- realistic search terms a customer would use\n` +
            `- their site's navigation structure (for "Home / Category / Subcategory" journeys)\n` +
            `Prioritize the homepage plus 1–2 key product/service/category pages (and a targeted search only if needed); STOP as soon as you have enough to write the brief — do NOT exhaustively crawl the site.\n` +
            `Base it on their ACTUAL site content where possible. Return prose, no preamble.`,
          // The prompt is identical every pause_turn iteration, so cache it —
          // a resumed turn re-reads it instead of re-processing it.
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ];
  const tools = [
    // max_content_tokens is a guard against a pathologically large page, NOT a
    // speed lever — measured on a heavy retail SPA, capping at 8k changed the
    // wall clock by <10% (201s -> 182s). It's set well above what a normal page
    // returns (~11k) so it only bites runaway documents.
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3, max_content_tokens: 30000 },
    { type: "web_search_20260209", name: "web_search", max_uses: 2 },
  ] as any;

  /* effort:"low" is THE performance lever here, worth ~3.5x: research is
     extraction and summarisation, not reasoning, and the default `high` had the
     model deliberating over pages it had already read. Measured on the same
     prospect: 201s at the default vs 58s at low — and the low-effort brief came
     back LONGER and no less specific (6.7k vs 5.8k chars), because the time was
     going into deliberation rather than coverage. Streaming keeps a long
     tool-loop turn from tripping the SDK's request timeout. */
  const req = {
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" as const },
    output_config: { effort: "low" },
    tools,
  };

  let response = await client.messages.stream({ ...req, messages } as any).finalMessage();
  let guard = 0;
  while (response.stop_reason === "pause_turn" && guard++ < 4) {
    messages.push({ role: "assistant", content: response.content as any });
    response = await client.messages.stream({ ...req, messages } as any).finalMessage();
  }

  /* Take only the TRAILING run of text blocks. Joining every text block sweeps
     up the model's interstitial narration ("Let me fetch the homepage...") into
     the brief, which then leaks into all 15 downstream phases. */
  const blocks = response.content;
  const tail: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === "text") tail.unshift((blocks[i] as any).text);
    else break;
  }
  const brief = tail.join("\n").trim();
  if (!brief) throw new Error("Research produced no brief.");
  return brief;
}

/* FAST prefix call: pick the identity + canonical terminology only (tiny output).
   Runs before the pool because every pool phase reuses these terms. */
export function generateTerms(client: Anthropic, name: string, brief: string) {
  return structured<z.infer<typeof TermsOutput>>(
    client,
    TermsOutput,
    `Using this business brief, choose the canonical identity + terminology for ${name}'s Invoca demo.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n` +
      `Requirements:\n` +
      `- networkName: "Invoca for <vertical>" (e.g. "Invoca for Automotive").\n` +
      `- industry: short phrase.\n` +
      `- bookingTerm: the industry-appropriate word for what THIS business schedules with a new customer — a short, Title-Case, SINGULAR noun. Pick what truly fits: e.g. "Consultation", "Appointment", "Estimate", "Tour", "Test Drive", "Service Appointment", "Demo". This term is reused across the whole platform.\n` +
      `- customerNoun: the Title-Case SINGULAR word THIS business uses for a customer ("Customer", "Patient", "Member", "Client", "Guest", "Rider", …). Reused across the platform.\n` +
      `- qualifiedCallTerm: what THIS business calls a sales-QUALIFIED inbound call in its dashboards — the "Sales Call" equivalent (e.g. "Sales Call", "Residency Inquiry", "New Patient Call", "Sales Inquiry"). Title-Case. Reused VERBATIM across every dashboard so terminology stays consistent.\n` +
      `- conversionTerm: the Title-Case noun for a WON, revenue-generating conversion for THIS business — the "Purchase / Job Complete" equivalent (the closed sale/outcome), e.g. "Purchase", "Reservation Booked", "Membership Sold", "New Patient", "Move-In", "Job Won". This is DISTINCT from the bookingTerm (which is only the scheduled visit). Reused VERBATIM across every dashboard.\n` +
      `- monthlyCalls: inbound marketing-driven calls in ONE month for an ENTERPRISE-scale version of this business (Invoca sells to large brands, so the demo should look like one). Default to the 25,000–90,000 range. It MUST NOT be a round number — real call volume is never exactly 48,000 or 60,000, and a round total is the fastest way for a prospect to tell the data is invented. Derive the figure from THIS business's actual scale (store/branch/location count, market coverage, category demand) and give it an irregular tail down to the last digit. Do NOT reuse any number written in these instructions — a figure copied from the prompt is not sized to this business. Go LOWER only if that volume is genuinely not credible for this vertical — a business with a small buyer pool or a very high ticket (private aviation, enterprise B2B, luxury real estate) should get a believable number instead of a big one; credibility beats size.\n` +
      `- avgSaleAmount: the realistic dollar value of ONE won sale for this business. Also NOT round: a figure ending in 00 reads invented, an irregular one reads like a real average. Derive it from this vertical's actual ticket, and do not copy a number from these instructions. Be honest to the vertical (a window-treatment job ~$3,000; a dental implant ~$4,500; a car ~$38,000; a gym membership ~$700; a senior-living move-in ~$5,000/mo).\n` +
      `- purchaseRatePct: the share of ALL inbound calls that end in a won sale, 2–45. High-ticket, considered purchases sit low (15–25); transactional or service businesses sit higher (30–45); an ultra-high-ticket business with a tiny buyer pool (private aviation, yachts, enterprise capital equipment) belongs at 2–6 with a correspondingly SMALL monthlyCalls — do not force it into the enterprise range. monthlyCalls x purchaseRatePct x avgSaleAmount must produce a MONTHLY revenue figure that is credible for this business — sanity-check it before answering.`,
    4000
  );
}

/* The Digital Journey & Call Attribution report table — the heavy part of the old
   report call, now generated as its own pool phase (needs only brief + bookingTerm). */
/* THE GENERATION SHAPE, which is NOT the storage shape.

   toSchema()'s sanitize() marks every property required, because strict structured
   output has no optionals. That is correct for real content and wrong for a field
   the app writes later: `InteractionRow.cells` is written by columnEdits when a
   column is added, and forcing it here made the model invent one. It produced two
   metric-looking strings per row against six dimension columns, and the table then
   rendered those instead of the six real values it had generated correctly.

   Omitting it is the fix at source. Any row-level field the APP owns rather than the
   model belongs in this omit list, not in the prompt. */
const DIGITAL_INSIGHTS_GEN = DigitalInsightsReport.extend({
  rows: z.array(InteractionRow.omit({ cells: true })),
});

/* AND STRIP IT ANYWAY, whatever comes back.

   The omit above is the fix; this is the seatbelt. A model can return a field the
   schema did not ask for, a future edit can widen the type by accident, and the cost
   of this line is nothing while the cost of missing it was 39 demos in the shared
   library rendering an interaction count under "Marketing Source".

   Any field the APP owns rather than the model gets deleted here. */
function stripAppOwnedFields(r: z.infer<typeof DigitalInsightsReport>): z.infer<typeof DigitalInsightsReport> {
  return { ...r, rows: r.rows.map(({ cells, ...row }) => row) };
}

function generateDigitalInsights(client: Anthropic, name: string, brandDomain: string, brief: string, bookingTerm: string, sc: Scale) {
  return structured<z.infer<typeof DigitalInsightsReport>>(
    client,
    DIGITAL_INSIGHTS_GEN,
    `Using this business brief, produce the Invoca "Digital Journey & Call Attribution Report" table for ${name}.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n${scaleRules(sc, bookingTerm)}\n\n` +
      `Requirements:\n` +
      `- title: exactly → "Digital Journey & Call Attribution Report"\n` +
      `- dateRange: "${DATE_RANGE_LONG}". filterLabel: "Marketing Source: 3 selected". chartLegend: "Total Interactions".\n` +
      `- chart: 5 points, one per weekly bucket, dates EXACTLY ${JSON.stringify(WEEK_LABELS)}. These are total INTERACTIONS (web sessions + calls), so they MUST sum to MORE than the ${n(sc.calls)} calls — target about ${n(Math.round(sc.calls * 1.275))}. yMax = clean round number above the tallest bar; yTicks = 5 evenly spaced values ending at yMax.\n` +
      `- dimensionColumns: exactly ["Marketing Source","Marketing Medium","Marketing Campaign","Marketing Search Term","Full Landing Page URL","Website Journey"].\n` +
      `- signalColumns: exactly [{label:"Answered by Agent",badges:["Rule"]},{label:"${bookingTerm} Discussed (Industry)",badges:["Keyword Spotting","Rule"]},{label:"${bookingTerm} Booked (Conversion)",badges:["Keyword Spotting","Rule"]}].\n` +
      `- rows: 18–24 realistic interactions specific to THIS business. Sources: Paid Search / Social Media / Organic; mediums: cpc / Bing / Instagram / Facebook / Organic. Search terms "—" for social/organic. Landing page URLs must use the domain ${brandDomain} with utm params. Website Journey like "Home / Category / Subcategory". Each row's "signals" is 3 booleans aligned to signalColumns; make most rows' first signal (Answered by Agent) true and order the rows so the true ones come first (the table is sorted by that column descending), and vary the other two realistically.`,
    16000
  );
}

/* ---- The Marketing Performance dashboard: THREE concurrent phases -----------

   This was ONE structured call and it WAS the makespan: 180s of a 258s
   generation, with all fifteen other phases sitting idle behind it (measured on
   Roto-Rooter, 2026-07-30). It is by far the biggest output in the pipeline —
   3 KPI groups, SIX breakdowns of 5 rows x 4 metric columns (120 cells) and two
   multi-series charts — and `effort: "high"` has to hold every arithmetic rule in
   scaleRules() across all of it in a single pass.

   Splitting it is safe BECAUSE THE NUMBERS ARE PINNED BEFORE THE POOL STARTS:
   buildScale() fixes total calls, total revenue, won sales, bookings and the
   answer rate, and scaleRules() hands the SAME exact figures to every phase. The
   three pieces therefore agree by construction, not by luck — which is the only
   reason this can be parallel at all. If you ever make a dashboard number depend
   on another phase's OUTPUT rather than on Scale, these have to merge back.

   The split follows the real internal dependencies, so nothing that must match is
   ever separated:
     • core     — the KPI tiles and the breakout line chart that rolls up INTO them
     • channels — the four marketing breakdowns (Source/Medium/Campaign/Search Term)
     • segments — the Product Category breakdown AND the chart that plots the SAME
                  categories, plus Region

   ⚠️ `breakdowns` is ORDER-SENSITIVE, in two different ways. MarketingDashboard
   splits the array BY FLAG — `filter(hasDonut)` renders the donut+table tiles in
   ARRAY ORDER, and `find(!hasDonut)` pulls the single Product Category one out to
   sit beside productCategoryGraph — while `prospectPlace.derive()` and
   google-ads-demo.js look rows up BY TITLE. So position drives the visual sequence
   of the donut tiles and the flag decides which section a breakdown lands in.
   assembleDashboard below rebuilds the canonical order; do not append. */
const DashboardCore = z.object({
  title: z.string(),
  dateRange: z.string(),
  kpiGroups: z.array(KpiGroup),
  salesCallBreakoutGraph: MultiSeriesChart,
});
const DashboardChannels = z.object({
  /* Source, Medium, Campaign, Search Term — IN THAT ORDER. */
  breakdowns: z.array(Breakdown),
});
/* Named rather than an array: these two are consumed at different positions in the
   final order, and a positional array would make a silent swap possible. */
const DashboardSegments = z.object({
  productCategory: Breakdown,
  productCategoryGraph: MultiSeriesChart,
  region: Breakdown,
});

/* The metric columns every "Call Outcome Summary" breakdown shares. Built once so
   the two breakdown phases cannot drift into different column sets — which would
   render as a table whose headers don't match the one above it. */
const metricCols = (conversionTerm: string) =>
  `["Call Count","Quote Discussed (Percent)","${conversionTerm} (Percent)","Total Revenue (Sale Amount)"]`;

export function generateDashboardCore(client: Anthropic, name: string, brief: string, bookingTerm: string, qualifiedCallTerm: string, conversionTerm: string, sc: Scale) {
  return structured<z.infer<typeof DashboardCore>>(
    client,
    DashboardCore,
    `Using this business brief, produce the KPI TILES and the breakout line chart of the Invoca "Marketing Performance Dashboard" for ${name}.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n${scaleRules(sc, bookingTerm)}\n\n` +
      `The metric labels below are a TEMPLATE — keep the same count/shape. Two conversion terms are GIVEN and MUST be used VERBATIM everywhere they appear: the sales-qualified inbound call is "${qualifiedCallTerm}", and a won revenue conversion is "${conversionTerm}". Re-skin only the OTHER outcome words that don't fit ${name} (e.g. "Warranty Call" → a real call type; "Quote Discussed" → "Estimate Discussed"/"Pricing Discussed"; "Unqualified Lead" → the fitting term). Keep "Call Count" and "Total Revenue (Sale Amount)" verbatim.\n\n` +
      `- title: "Marketing Performance Dashboard (${name})". dateRange: "${DATE_RANGE}".\n` +
      `- kpiGroups: exactly these 3, each 4 tiles (values as strings; percents like "84%"; currency like "${$(sc.revenue)}"; counts use commas):\n` +
      `  1) "Call Performance Summary": Call Count, ${qualifiedCallTerm} (Percent), ${conversionTerm} (Percent), Total Revenue (Sale Amount)\n` +
      `  2) "Non-Sales Inquiries": Call Count = ONLY the non-sales calls (${n(sc.nonSalesCalls)}, NOT the ${n(sc.calls)} total — repeating the total here is wrong), then three non-sales call types whose percents are shares of ALL calls and MUST sum to exactly ${100 - sc.salesPct}% (e.g. 8% + 5% + 3%), so sales + non-sales = 100%.\n` +
      `  3) "${qualifiedCallTerm} Breakout Metrics": ${qualifiedCallTerm} (Percent), Quote Discussed (Percent), Unqualified Lead (Percent), ${conversionTerm} (Percent)\n` +
      `- salesCallBreakoutGraph: yLabel "${qualifiedCallTerm} (Count)", xLabels EXACTLY ${JSON.stringify(WEEK_LABELS)}, series in order "${qualifiedCallTerm} (Count)","Quote Discussed (Count)","Unqualified Lead (Count)","${conversionTerm} (Count)", each one weekly count per label (${qualifiedCallTerm} highest). These series roll up INTO group 3's percents, so they must be consistent with them.\n` +
      `All numbers plausible for THIS business.`,
    8000
  );
}

export function generateDashboardChannels(client: Anthropic, name: string, brief: string, bookingTerm: string, conversionTerm: string, sc: Scale) {
  return structured<z.infer<typeof DashboardChannels>>(
    client,
    DashboardChannels,
    `Using this business brief, produce the FOUR marketing "Call Outcome Summary" breakdowns of the Invoca "Marketing Performance Dashboard" for ${name}.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n${scaleRules(sc, bookingTerm)}\n\n${outcomeStory()}\n\n` +
      `- breakdowns: EXACTLY these 4, IN THIS ORDER, each metricColumns=${metricCols(conversionTerm)} with 5 rows ordered by Call Count DESCENDING:\n` +
      `  1) title "Calls by Source" / tableTitle "Source: Call Outcome Summary" / dimensionColumn "Marketing Source" / hasDonut:true\n` +
      `  2) title "Calls by Medium" / tableTitle "Medium: Call Outcome Summary" / dimensionColumn "Marketing Medium" / hasDonut:true\n` +
      `  3) title "Calls by Campaign" / tableTitle "Campaign: Call Outcome Summary" / dimensionColumn "Marketing Campaign" / hasDonut:true\n` +
      `  4) title "Calls by Search Term" / tableTitle "Search Term: Call Outcome Summary" / dimensionColumn "Marketing Search Term" / hasDonut:true\n` +
      `- Source and Medium are COMPLETE partitions of the month: each one's Call Count column must sum to EXACTLY ${n(sc.calls)} and its revenue column to EXACTLY ${$(sc.revenue)}.\n` +
      `- Campaign and Search Term are the TOP 5 of a long tail, so each must sum to LESS than ${n(sc.calls)} calls and less than ${$(sc.revenue)} — never more, and never exactly the total.\n` +
      `- Search Term rows must be phrases a real customer would TYPE INTO GOOGLE (lowercase, e.g. "emergency plumber near me"), not product names or transcript words.\n` +
      `${sourceRows()}\n` +
      `All numbers plausible for THIS business.`,
    12000
  );
}

export function generateDashboardSegments(client: Anthropic, name: string, brief: string, bookingTerm: string, conversionTerm: string, sc: Scale) {
  return structured<z.infer<typeof DashboardSegments>>(
    client,
    DashboardSegments,
    `Using this business brief, produce the Product Category and Region sections of the Invoca "Marketing Performance Dashboard" for ${name}.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n${scaleRules(sc, bookingTerm)}\n\n${outcomeStory()}\n\n` +
      `- productCategory: title "Conversions by Product Category" / tableTitle "Conversions by Product Category" / dimensionColumn "Product Category" / hasDonut:false / 5 rows ordered by Call Count DESCENDING, rows = THIS business's real product or service categories. metricColumns=["Call Count","${bookingTerm} Set (Industry) (Percent)","${conversionTerm} (Percent)","Total Revenue (Sale Amount)"] (note column 2 differs from the other breakdowns).\n` +
      `- region: title "Calls by Region" / tableTitle "Region Summary" / dimensionColumn "Location Region" / hasDonut:true / metricColumns=${metricCols(conversionTerm)} / 5 rows ordered by Call Count DESCENDING. Use US regions (South/West/Northeast/Midwest and one more).\n` +
      `- BOTH are COMPLETE partitions of the month: each one's Call Count column must sum to EXACTLY ${n(sc.calls)} and its revenue column to EXACTLY ${$(sc.revenue)}.\n` +
      `- productCategoryGraph: yLabel "${conversionTerm} (Count)", xLabels EXACTLY ${JSON.stringify(WEEK_LABELS)}, series = THE SAME product categories as productCategory's rows above, in the same order and named IDENTICALLY (this chart sits beside that table, so a name that differs reads as a bug), each one weekly ${conversionTerm} count per label.\n` +
      `All numbers plausible for THIS business.`,
    10000
  );
}

/* Reassemble the three phases into the ONE DashboardView the screen expects.
   `breakdowns` order is the contract: the dashboard renders them in order and both
   prospectPlace.derive() and google-ads-demo.js look rows up by title. */
export function assembleDashboard(
  core: z.infer<typeof DashboardCore>,
  channels: z.infer<typeof DashboardChannels>,
  segments: z.infer<typeof DashboardSegments>,
): z.infer<typeof DashboardView> {
  /* Source, Medium, Campaign, Search Term, THEN Product Category, THEN Region —
     the order the single-call version emitted. Pick the four channel breakdowns by
     title so a model that reorders its own array still lands them correctly, and
     fall back to positional order if a title was re-skinned unexpectedly. */
  const want = [/source/i, /medium/i, /campaign/i, /search term/i];
  const pool = [...channels.breakdowns];
  const ordered = want.map((re, i) => {
    const hit = pool.findIndex((b) => re.test(b.title));
    return hit >= 0 ? pool.splice(hit, 1)[0] : pool[0] ?? channels.breakdowns[i];
  }).filter(Boolean);
  return {
    title: core.title,
    dateRange: core.dateRange,
    kpiGroups: core.kpiGroups,
    salesCallBreakoutGraph: core.salesCallBreakoutGraph,
    breakdowns: [...ordered, segments.productCategory, segments.region],
    productCategoryGraph: segments.productCategoryGraph,
  };
}

function generateCallReview(client: Anthropic, name: string, brief: string, bookingTerm: string, sc: Scale) {
  const bt = bookingTerm.toLowerCase();
  return structured<z.infer<typeof CallReviewView>>(
    client,
    CallReviewView,
    `Using this business brief, produce Invoca "Call Review" demo data for ${name} — a list of scored, AI-summarized inbound phone calls.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n${scaleRules(sc, bookingTerm)}\n\n` +
      `- shownCount: MUST equal the number of call objects you actually return, written as "<N> Calls" (15 calls returned → "15 Calls"). totalNote: "total of ${n(sc.calls)} calls from Jan 1 to Jan 31". scoreDisplay: "Quality Score". sortBy: "Highest Score". dateRange: "01/01/2026-01/31/2026".\n` +
      `- calls: exactly 15 items, each a realistic inbound phone call to THIS business, SORTED BY score DESCENDING (highest first):\n` +
      `  • scoreLabel: "Quality Score" for every call.\n` +
      `  • score: integer 34–92, strictly descending across the 15 calls, with a realistic spread.\n` +
      `  • summary: 2–4 sentences naming a specific caller (first + last name), their reason for calling tied to THIS business's actual products/services, what the agent did, and the outcome. Vary scenarios: consultations/quotes, scheduling, order status, delivery/installation issues, warranty/repair, billing disputes, cancellations, complaints. Higher scores read smoother/positive; lower scores have more friction/dissatisfaction.\n` +
      `  • date: like "Jun 3, 2:42 PM" (vary months Jan–Oct and times). duration: like "1m 30s" (0m 40s–3m 30s).\n` +
      `  • agent: a first name (Oscar, Lila, Rosey, Lee, Mary, Sue, Mike, Jennifer, Rose…); use "No Agent" for exactly ONE call that rolled to voicemail.\n` +
      `  • scorecards: 7 or 8. comments: usually 0, with 1–2 on a couple of calls. negativeSentiment: 6–40, LOWER for high-score calls and HIGHER for low-score/negative calls.\n` +
      `  • evaluated: true for 2–3 calls, false for the rest.\n` +
      `  • converted: boolean. TRUE only when the caller booked/scheduled a NEW ${bt} on this call; FALSE for order status, delivery/installation issues, warranty/repair, billing disputes, cancellations, complaints, and the voicemail. 5–7 of the 15 should be true. This drives the "${bookingTerm}: Scheduled" Signals filter, so it MUST be consistent with each summary.\n` +
      `  • IMPORTANT: the 4th call (calls[3]) MUST be a NEW-CUSTOMER consultation/scheduling intake call (they call to schedule and the agent collects their details), with evaluated:true, converted:true, and a score in the 70s (70–79). It drills into the Call Detail page.\n` +
      `- searchSuggestions: EXACTLY 6 short lowercase Global-Transcript-Search demo terms for a manager to click (products, services, or common call reasons for THIS business — e.g. a product line, "warranty", "installation", "cancel"). CRITICAL: each term MUST literally appear (as a substring) in AT LEAST TWO of the call summaries you wrote above, so clicking it always returns results.`,
    12000
  );
}

/* Call Detail — the drill-in for the 4th (evaluated) call: a new-customer intake
   call with scorecard, signals, prompts, transcript, AI summary, and a comment. */
function generateCallDetail(client: Anthropic, name: string, brief: string, bookingTerm: string) {
  const bt = bookingTerm.toLowerCase();
  return structured<z.infer<typeof CallDetailView>>(
    client,
    CallDetailView,
    `Produce Invoca "Call Detail" demo data for ${name} — the drill-in for ONE evaluated inbound call: a NEW-CUSTOMER ${bt}/intake call where the caller schedules and the agent collects their details.\n\n` +
      `BRIEF:\n${brief}\n\n${reskin(name)}\n\n` +
      `- callId "0597-627F62F2570D". agent a full name (e.g. "Marcus Bell"). date INSIDE the demo month during business hours, e.g. "Jan 12, 2:28 PM". duration MUST match the transcript: set it a few seconds past the LAST turn timestamp (a transcript ending at 02:14 means duration "2m 26s", never "4m 12s").\n` +
      `- scorecardName "BASE SKILLS". scorecardPercent 78. scorecardPoints "70/90 Points".\n` +
      `- scorecardRows: EXACTLY 10. Names specific to THIS business's intake ("(QA) Proper Greeting", "(QA) Proper Close", "Capture Full Name", capture steps for what this business qualifies on, "Capture Email", etc.). EXACTLY 7 rows status "met" points "10/10", 2 rows status "unmet" points "0/10", 1 row status "na" points "—/—".\n` +
      `- signalsMet 13, signalsUnmet 26, signalsNa 25. metSignals: ~13 signal names grounded in the call; unmetSignals: ~10 names; naSignals: ~7 names not applicable to an intake (order/delivery/billing/return).\n` +
      `- prompts: EXACTLY 3 — "Is the customer trying to solve a specific problem?", "What are the customer's expectations?", "How could the agent handle the call better?" — each with a 1–2 sentence answer specific to this call.\n` +
      `- convStart "00:16". transcript: 16–20 turns { speaker "agent" or "caller", time (mm:ss ascending 00:00→~02:14), text }. A realistic ${bt} intake: greet → get name → qualify (specific to THIS business) → confirm service area/ZIP → capture contact (use "****" for a redacted phone/email turn) → book the ${bt} → close. Start and end with the agent.\n` +
      `- aiSummary: 3–5 sentences summarizing the call.\n` +
      `- comment: { author "Kyle Paklaian", audience "Everyone", date "Oct 22, 2:55 PM", text a coaching note addressed to "@<agent's first name>" praising the structure and suggesting 1–2 improvements (empathy, capturing the email, setting expectations for the visit) }.`,
    9000,
    FAST_MODEL
  );
}

function generateOpsDashboard(client: Anthropic, name: string, brief: string, bookingTerm: string, customerNoun: string, sc: Scale) {
  return structured<z.infer<typeof OpsDashboardView>>(
    client,
    OpsDashboardView,
    `Using this business brief, produce the Invoca "Marketing and Operations Performance with Revenue" dashboard for ${name}.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n${scaleRules(sc, bookingTerm)}\n\n${outcomeStory()}\n\n` +
      `Everywhere below: <BOOK> = "${bookingTerm}" (<BOOK>s = plural); <CUST> = "${customerNoun}" (<CUST>s = plural). Use them consistently, uppercasing inside ALL-CAPS group titles.\n` +
      `- title: "Marketing and Operations Performance with Revenue". dateRange: "${DATE_RANGE}".\n` +
      `- kpiGroups: exactly 3 (values are strings):\n` +
      `  1) "MARKETING DRIVEN CALLS": Call Count "${n(sc.calls)}", "Avg. Duration" "2:56", "Avg. Revenue (Sale Amount)" "$${sc.revPerCall.toFixed(2)}", "Total Revenue (Sale Amount)" "${$(sc.revenue)}" — these four are FIXED, copy them exactly.\n` +
      `  2) "NEW <CUST> ACQUISITION": "Caller Type: New <CUST>s (Count)", "Caller Type: New <CUST>s (Percent)", "<BOOK>: Scheduled (Count)", "<BOOK>: Scheduled (Percent)".\n` +
      `  3) "EXISTING <CUST>s & RESCHEDULING": "Caller Type: Existing <CUST> (Count)", "Caller Type: Existing <CUST> (Percent)", "<BOOK>: Canceled (Percent)".\n` +
      `- marketingSections: exactly 4 — Source, Medium, Campaign, Search Terms. Each = { chartTitle, chart, tableTitle, table }. chart = { legend, axisMax, axisTicks (evenly spaced, ending at axisMax), axisSuffix, bars:[{name,value,display}] } where display is the drawn label ("55%" or "1,880"):\n` +
      `  • Source: chartTitle "MARKETING: Source (<BOOK>s)"; legend "<BOOK>: Scheduled (Percent)", axisMax 60, axisTicks [0,10,20,30,40,50,60], axisSuffix "%", 4 bars (sources by scheduled %, desc). tableTitle "MARKETING: Source (Calls resulting in <BOOK>s)"; columns ["Marketing Source","Call Count","<BOOK>: Scheduled (Percent)","Total Revenue (Sale Amount)"], 5 rows.\n` +
      `  • Medium: chartTitle "MARKETING: Medium (Calls)"; legend "Call Count", axisSuffix "", 5 bars by call count. tableTitle "MARKETING: Medium (Calls resulting in <BOOK>s)"; columns ["Marketing Medium","Call Count","<BOOK>: Scheduled (Percent)"], 5 rows.\n` +
      `  • Campaign: chartTitle "MARKETING: Campaign (Calls)"; legend "Call Count", 5 bars by call count (this business's campaign names). tableTitle "MARKETING: Campaign (Calls resulting in <BOOK>s)"; columns ["Marketing Campaign","Call Count","<BOOK>: Scheduled (Percent)","Total Revenue (Sale Amount)"], 4 rows.\n` +
      `  • Search Terms: chartTitle "MARKETING: Search Terms (Calls)"; legend "Call Count", 5 bars by call count (business-specific search terms). tableTitle "MARKETING: Search Terms (Calls resulting in <BOOK>s)"; columns ["Marketing Search Terms","<BOOK>: Scheduled (Percent)"], 4 rows.\n` +
      `- webpagesTitle "Webpages driving New <CUST>s"; webpages.columns ["Product Category","Call Count","<BOOK>: Scheduled (Percent)","Caller Type: New <CUST>s (Percent)"], 4 rows = this business's product/service categories.\n` +
      `- locationTitle "Location Call Handling"; locationHandling.columns ["Location","Call Count","Call Not Answered (Count)","Voice Mail (Percent)","<BOOK>: Scheduled (Percent)"], 4 rows = this business's actual location type (stores/branches/showrooms/clinics/dealerships/gyms — use real-sounding location names for ${name}).\n` +
      `- noBookingChart: yLabel "Call Count", xLabels ${JSON.stringify(WEEK_LABELS)}, series = the 5 top reasons calls do NOT book for THIS business — each must be a genuine REASON (e.g. Price Above Budget, Comparing Providers, Timing Not Right, Needs Partner Approval, Outside Service Area), never the name of the booking itself. Values are weekly counts, and all 5 series together MUST sum to EXACTLY ${n(sc.calls - sc.consultations)} — the calls that did NOT book. Never more.\n` +
      `${sourceRows()}\n` +
      `All numbers plausible and specific to ${name}. Every bar's value must be ≤ its chart's axisMax.`,
    22000
  );
}

/* AI Agent Conversion Dashboard (3rd dashboard) — how AI-agent interactions
   convert. Reuses the KpiGroup/Breakdown/MultiSeriesChart shapes; adds the six
   conversion cards. FAST_MODEL keeps it quick. */
function generateAiAgentConversionDashboard(client: Anthropic, name: string, brief: string, bookingTerm: string, _customerNoun: string, _qualifiedCallTerm: string, conversionTerm: string, sc: Scale) {
  return structured<z.infer<typeof AiAgentConversionView>>(
    client,
    AiAgentConversionView,
    `Using this business brief, produce Invoca "AI Agent Conversion Dashboard" demo data for ${name} — how AI-agent interactions convert into ${bookingTerm}s and revenue.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n${scaleRules(sc, bookingTerm)}\n\n${outcomeStory()}\n\n` +
      `- title "AI Agent Conversion Dashboard". dateRange "${DATE_RANGE}".\n` +
      `- This dashboard covers ONLY the AI agent slice of the month, NOT the whole business: ${n(Math.round(sc.calls * 0.4))} interactions and ${$(Math.round(sc.revenue * 0.57))} revenue. Its breakdowns must sum to THOSE figures, not the platform totals, and must NOT reuse the Marketing dashboard rows verbatim.\n` +
      `- summary: title "AI Agent Performance Summary", tiles EXACTLY [ {label:"Interactions", value "${n(Math.round(sc.calls * 0.4))}"}, {label:"${bookingTerm} Scheduled (Percent)", value like "56%"}, {label:"${conversionTerm} (Percent)", value like "33%"}, {label:"Total Revenue (Sale Amount)", value "${$(Math.round(sc.revenue * 0.57))}"} ] — the AI agent converts BETTER than the blended ${sc.purchasePct}% rate, which is the point of the dashboard. Every breakdown on this page rolls up to THESE two figures.\n` +
      `- conversionCards: EXACTLY 6. Titles in this order: "LEAD FORM (Conversions): Live Agent", "LEAD FORM (Conversions): SMS Agent & Live Agent", "LEAD FORM (Conversions): SMS Agent Assist", "Voice Agent (Conversions): Live Agent", "Voice Agent (Conversions): Voice Agent & Live Agent", "Voice Agent (Conversions): Voice Agent". chips first value: LEAD FORM cards (1–3) use "Interaction Type: Form Fill"; Voice Agent cards (4–6) use "Interaction Type: Voice". The other two chips follow the pattern: cards 1&4 [..., "SMS Engaged: No","Live Agent Call: Yes"]; cards 2&5 [..., "SMS Engaged: Yes","Live Agent Call: Yes"]; cards 3&6 [..., "SMS Engaged: Yes","Live Agent Call: No"]. Each card tiles EXACTLY [ {label:"${conversionTerm} (Percent)", value like "21%"}, {label:"Total Revenue (Sale Amount)", value like "$27,760"} ]. ${conversionTerm} % should INCREASE across each group (agent-assisted / agent-only convert best).\n` +
      `- breakdowns: EXACTLY 5.\n` +
      `  • Four with hasDonut:true: "Calls by Source"/"Source: Interaction Outcome Summary"/dimension "Marketing Source"; "Calls by Medium"/"Medium: Call Outcome Summary"/"Marketing Medium"; "Calls by Campaign"/"Campaign: Call Outcome Summary"/"Marketing Campaign" (campaign names SPECIFIC to ${name}); "Calls by Search Term"/"Search Term: Call Outcome Summary"/"Marketing Search Term" (real search queries a ${name} customer would type).\n` +
      `    Each: metricColumns ["Call Count","${bookingTerm} Scheduled (Percent)","${conversionTerm} (Percent)","Total Revenue (Sale Amount)"]; exactly 5 rows sorted by Call Count DESC (metrics aligned as [count, a %, a %, "$"+amount]); and donutTotal = an integer 15-30% LARGER than the sum of the 5 rows' Call Counts.\n` +
      `  • One with hasDonut:false: title & tableTitle "Conversions by Product Category", dimension "Product Category", metricColumns ["Call Count","${bookingTerm} Scheduled (Percent)","${conversionTerm} (Percent)","Total Revenue (Sale Amount)"], exactly 5 product/service-category rows for ${name}.\n` +
      `- productCategoryGraph: stacked bar. yLabel "${conversionTerm} (Count)". xLabels ${JSON.stringify(WEEK_LABELS)}. series = one per product category, SAME names and SAME ORDER as the Product Category table rows, and each series MUST sum to that row own ${conversionTerm} count (its Call Count x its percent). A series total that contradicts its table row is the most common bug here.\n` +
      `${sourceRows()}\n` +
      `All numbers realistic and internally consistent. Re-skin every campaign, search term, and product category to ${name}'s actual business.`,
    9000,
    FAST_MODEL
  );
}

/* AI Messaging Impact dashboard (4th) — Human-vs-AI story. Keeps the reference
   layout/labels; re-skins the Common Topics categories + amounts to the prospect. */
function generateAiMessagingImpact(client: Anthropic, name: string, brief: string, bookingTerm: string, _customerNoun: string, sc: Scale) {
  return structured<z.infer<typeof AiMessagingImpactView>>(
    client,
    AiMessagingImpactView,
    `Using this business brief, produce Invoca "AI Messaging Impact on Lead Capture & Revenue (Human vs AI)" demo data for ${name} — contrasting AI-agent messaging (this month) vs human-only (last month). AI must dramatically outperform human on EVERY metric.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n${scaleRules(sc, bookingTerm)}\n\n` +
      `- title "AI Messaging Impact on Lead Capture & Revenue (Human vs AI)". dateRange "${DATE_RANGE}".\n` +
      `- AI is THIS month, Human is LAST month. AI must win on EVERY metric a prospect could derive — including revenue PER ${bookingTerm}: AI revenue/count must come out HIGHER than the human one, not just the totals.\n` +
      `- aiLeadEngagement: title "AI Agent Lead Engagement (This Month)", tiles [{label:"Form Submits", value ~1000-1600}, {label:"Avg. Speed to Lead", value "0:01"}, {label:"AI SMS Engagement Rate", value ~"80-90%"}].\n` +
      `- aiAppointmentPerformance: title "AI Agent ${bookingTerm} Performance (This Month)", tiles [{label:"${bookingTerm} Scheduled (Percent)", ~"20-30%"}, {label:"${bookingTerm} Scheduled (Count)", ~250-400}, {label:"Total Revenue (Sale Amount)", a large "$" amount like "$1,743,824"}].\n` +
      `- humanLeadEngagement: title "Human-Only Lead Engagement (Last Month)", chip "Last Month", tiles [{label:"Form Submits", ~700-1000}, {label:"Avg. Speed to Lead", a SLOW time like "19:23:20"}, {label:"Human SMS Engagement Rate", ~"30-40%"}].\n` +
      `- humanAppointmentPerformance: title "Human ${bookingTerm} Performance (Last Month)", chip "Last Month", tiles [{label:"${bookingTerm} Scheduled (Percent)", LOW ~"2-5%"}, {label:"${bookingTerm} Scheduled (Count)", LOW ~20-40}, {label:"Total Revenue (Sale Amount)", a much smaller "$" like "$168,673"}].\n` +
      `- trendTitle "AI-Assisted ${bookingTerm} Trend". trendChip "AI-Assisted Conversions". trendChart: yLabel "Count", xLabels = 49 daily dates from "07/01" to "08/18", series ONE named "${bookingTerm} Scheduled" whose 49 integer values are flat ~70-85 through 08/01, then JUMP to ~170-190 from 08/02 onward (AI turned on), with small day-to-day wobble and one small dip.\n` +
      `- aiOpportunities: title "AI-Assisted Opportunities", tiles [{label:"SMS Opt-In Count", ~1000-1400}, {label:"SMS Opt-In Rate", ~"85-90%"}, {label:"Total Messages", ~9000-12000}].\n` +
      `- aiLeadNurture: title "AI Lead Nurture", tiles [{label:"AI SMS Callback Scheduled (Count)", ~600-800}, {label:"AI SMS Callback Scheduled (Percent)", ~"55-65%"}, {label:"AI SMS Callback Completed (Count)", slightly below the scheduled count}, {label:"AI SMS Callback Completed (Percent)", ~"95-98%"}].\n` +
      `- commonTopicsTitle "Common Topics". commonTopicsChart: yLabel "${bookingTerm} Scheduled (Count)", xLabels 6 recent daily dates like "04/18".."04/23", series = 5 topic categories SPECIFIC to ${name} (what customers message about), each with 6 small integer values (0-12); make one day near-zero and one the tallest.\n` +
      `All numbers realistic and internally consistent. Re-skin every topic to ${name}'s business.`,
    7000,
    FAST_MODEL
  );
}

function generateConversationIntelligence(client: Anthropic, name: string, brief: string, bookingTerm: string, customerNoun: string, sc: Scale) {
  return structured<z.infer<typeof ConversationIntelligenceView>>(
    client,
    ConversationIntelligenceView,
    `Using this business brief, produce Invoca "Conversation Intelligence" demo data for ${name} — the deep-dive analysis of ONE inbound phone call.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n${scaleRules(sc, bookingTerm)}\n\n` +
      `- title: exactly "Conversation intelligence". dateRange: "${DATE_RANGE_LONG}". callCount: "${n(sc.calls)} calls". pagerLabel: "1 of ${n(Math.round(sc.calls / 10))}" (10 rows per page, so pages = calls / 10).\n` +
      `- calls: exactly 10 items for the left-hand list, each { time like "1/12/26 10:41 am" — all inside the demo month AND during BUSINESS HOURS (8am-6pm), ascending, no two identical. A rule-based "Business Hours: Inside" signal cannot fire on a 12:02 am call. id like "F57B-817F0292530D" (4 hex chars, dash, 12 hex chars, uppercase) }.\n` +
      `- duration: the selected call's length like "2:22" (between 1:30 and 3:00).\n` +
      `- transcript: 20–24 turns of a realistic inbound call to THIS business, alternating speaker "agent" and "caller" (start and end with "agent"). Each turn { speaker, time (mm:ss, strictly increasing, last ≈ duration), text, highlights }. The call: a NEW customer inquires about THIS business's actual products/services, the agent gathers name + needs, recommends specific products, offers the business's booking (consultation/appointment/quote), and SCHEDULES it, closing politely. highlights = array of 0–3 EXACT substrings from that turn's text to emphasize (greeting phrases, the booking being scheduled, product names, closing phrases); use [] when none.\n` +
      /* ⚠️⚠️ **THE CALL MUST CARRY SALES TENSION, OR THE SILVER / GOLD COMPARISON HAS NOTHING
         TO SHOW (8/27/2026).** Reported against a generated pest-control prospect: its call was
         a clean happy path — no price question, no competitor, no objection — so the only
         signals a phrase library could be shown to miss were weak ones like "this caller has a
         need", which costs nobody any money. The Signal AI tier reports derive their misses
         from the CALLER'S OWN WORDS, so the words have to be there.
         ⚠️ AND THEY MUST BE SIDEWAYS. If the caller says "that's too expensive" or "I'm
         getting a quote from a competitor", a keyword library catches it and there is no gap
         to demonstrate — the whole point is that real callers do NOT talk in phrase-list
         terms. Hence the worked examples, and `npm run audit:tiers` checks the result. */
      `- ⚠️ THE CALL MUST INCLUDE SALES TENSION, spoken by the CALLER, in these THREE places (they are what makes the call worth analysing):\n` +
      `    a) a PRICE or BUDGET concern,\n` +
      `    b) a COMPETITOR comparison (they are shopping, or they had another provider),\n` +
      `    c) ONE of: a commitment/contract worry, a second service they raise themselves, a deadline, or needing to check with a partner.\n` +
      `  Write all three the way a real person says them, NOT in the words a keyword list would hold. Say "what does that run?" or "I want to keep it manageable", NEVER "that's too expensive" / "what does it cost" / "my budget is". Say "I'm getting a couple of quotes" or "the guys down the street said…", NEVER "your competitor". Say "I don't want to be locked in", NEVER "contract terms". The agent should handle each one and still book the ${bookingTerm.toLowerCase()}.\n` +
      `- signals: 8–10 MET SIGNALS specific to THIS business, each { name, badges (subset of ["Keyword Spotting","Rule","Keypress"]), count (0 to hide, else 2–4) }. Include quality signals like "(QA) Proper Greeting" and "(QA) Proper Close" (both with a count), "Answered by Agent" (["Rule"], count 0), a "Caller Type: New ${customerNoun}" signal (["Keyword Spotting","Rule","Keypress"], count 2), a "${bookingTerm}: Scheduled" signal, and 2–3 product/intent signals.\n` +
      `- scoreValue: integer 70–90. scoreLabel: "BASE SKILLS".\n` +
      `- aiSummary: an AI recap of THE TRANSCRIPT ABOVE (must be consistent with it): { summary: 3–4 sentences naming the caller, their need, the products recommended, and the ${bookingTerm.toLowerCase()} that was scheduled; keyPoints: 4–6 short bullet highlights (new ${customerNoun.toLowerCase()}, needs, products, the booking, contact captured); sentiment: "Positive" | "Neutral" | "Negative" (Positive for a smooth booked call); outcome: a short disposition line like "${bookingTerm} booked — Thursday 10 AM" }.\n` +
      `All content plausible and specific to ${name}.`,
    16000
  );
}

/**
 * ⚠️ The SMS sibling of `VOICE_CI_GEN`, and it exists for the identical reason: `sanitize()`
 * marks every property required, so `SmsConversation.lsa` — which the APP sets when a thread
 * opened with a quote-request lead-in — would be forced onto the model and seeded
 * conversations would file themselves under the LSA report. Omit it here.
 */
const SMS_CI_GEN = SmsConversationIntelligenceView.extend({
  conversations: z.array(SmsConversation.omit({ lsa: true })),
});

function generateSmsConversationIntelligence(client: Anthropic, name: string, brief: string, bookingTerm: string, customerNoun: string, sc: Scale) {
  return structured<z.infer<typeof SmsConversationIntelligenceView>>(
    client,
    SMS_CI_GEN,
    `Using this business brief, produce Invoca "AI SMS Conversation Intelligence" demo data for ${name} — a list of AI-SMS text conversations.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n${scaleRules(sc, bookingTerm)}\n\n` +
      `- countLabel "${n(Math.round(sc.calls * 0.63))} conversations". dateRange "${DATE_RANGE_LONG}". pagerLabel "1 of ${n(Math.round(sc.calls * 0.63 / 10))}".\n` +
      `- conversations: exactly 4.\n` +
      `  • conversations[0] is ACTIVE (active:true) — a full realistic AI-SMS conversation for THIS business:\n` +
      `    - id like "C516-117FE212560D" (4 hex chars, dash, 12 hex chars, UPPERCASE). time like "8/16/25 10:55 pm". date "March 10, 2026".\n` +
      `    - transcript: 12–18 turns, each { speaker: "agent" or "consumer", time (like "6:21 AM", ascending), text }. NO emojis, plain SMS text. The agent runs the qualify→(estimate or recap)→book flow toward a ${bookingTerm}: intro + any offer, ask ONE qualifying question at a time, then propose a specific day/time, and confirm with a reminder + a callback number. Alternate speakers; start and end with the agent.\n` +
      `    - signals: 6–8 { name, badges (subset of ["Keyword Spotting","Rule","Keypress"]), count (0–2) } grounded in the conversation. Include "${bookingTerm}: Scheduled", "Caller Type: New ${customerNoun}", "Qualified Lead", and 3–5 signals for what the AI agent actually established (the qualifying answers it captured, the product or service the customer named, an estimate or offer it gave, a service area it confirmed).\n` +
      /* ⚠️ NO "(QA) …" SIGNALS HERE. This report is an AI-handled conversation: agent-quality scoring
         implies a human took it, and passes on every call by construction. Requested 9/3/2026; the two
         AI CI screens also strip them on read, which is what fixes demos generated before this.
         See src/data/aiSignals.ts. The HUMAN call-log CI above keeps them, deliberately. */
      `    - smsInfo: realistic metadata → callRecordId (=id), smsStartTime ("3/10/26 6:21 am"), destinationPhone ("877-936-2933"), totalMessages (the message count as a string), source (same phone), promoNumberDescription "SMS", smsEngaged "Yes", smsOptIn "Yes", smsOptOut "No", sessionStatus "Active", callerId (a real-looking phone), repeatCaller "No", city + region (a real US city + 2-letter state), phoneType "Mobile", displayName/firstName/lastName (a plausible customer name), gender, destinationTimeZone ("Pacific Time (US & Canada)"), finalCampaign "Default: SMS Campaign", finalCampaignId "9970305".\n` +
      `  • conversations[1..3] are INACTIVE shells: active:false, a unique id (same hex format), time (like "8/16/25 10:5X pm"), date "", transcript [], signals [], and smsInfo with all fields set to empty strings "".\n`,
    7000,
    FAST_MODEL
  );
}

/**
 * ⚠️ **THE GENERATION SCHEMA OMITS `outcome`, WHICH THE APP WRITES.**
 *
 * `toSchema()` runs `sanitize()`, which marks every property required — so an `.optional()`
 * field in a generated type is FORCED onto the model. `VoiceConversation.outcome` is written
 * after a real call by `/api/analyze`, and a generated one would be a fabricated routing
 * decision sitting on a seeded conversation, which the two (Voice AI) artifacts would then
 * render as if a call had happened. Same class of bug as `InteractionRow.cells`, and the same
 * fix: omit it here, and add anything else app-written to this omit in the same commit.
 */
const VOICE_CI_GEN = VoiceConversationIntelligenceView.extend({
  conversations: z.array(VoiceConversation.omit({ outcome: true })),
});

/* AI Voice Conversation Intelligence — the voice sibling of the SMS report: a
   list of AI-voice phone calls (1 active example + 3 inactive shells). */
function generateVoiceConversationIntelligence(client: Anthropic, name: string, brief: string, bookingTerm: string, customerNoun: string, sc: Scale) {
  return structured<z.infer<typeof VoiceConversationIntelligenceView>>(
    client,
    VOICE_CI_GEN,
    `Using this business brief, produce Invoca "AI Voice Conversation Intelligence" demo data for ${name} — a list of AI-voice phone calls.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n${scaleRules(sc, bookingTerm)}\n\n` +
      `- countLabel "${n(sc.calls)} calls". dateRange "${DATE_RANGE_LONG}". pagerLabel "1 of ${n(Math.round(sc.calls / 10))}".\n` +
      `- conversations: exactly 4.\n` +
      `  • conversations[0] is ACTIVE (active:true) — a full realistic AI-voice phone call for THIS business:\n` +
      `    - id like "A417-2C9FE314770D" (4 hex chars, dash, 12 hex chars, UPPERCASE). time like "8/16/25 4:12 pm". date "March 10, 2026".\n` +
      `    - transcript: 12–18 turns, each { speaker: "agent" or "consumer", time (like "4:12 PM", ascending), text }. SPOKEN, natural phone-call language (contractions, e.g. "Yeah, sure."), NO emojis. Say numbers/prices/times the way they'd be spoken aloud (e.g. "ten percent", "thirty-six by forty-eight inches", a phone number as "eight oh five, eight eight eight, two four two four"). The agent runs the qualify→(estimate or recap)→book flow toward a ${bookingTerm}: greet + any offer, ask ONE qualifying question at a time, then propose a specific day/time, and confirm with a reminder + a callback number. Alternate speakers; start and end with the agent.\n` +
      `    - signals: 6–8 { name, badges (subset of ["Keyword Spotting","Rule","Keypress"]), count (0–2) } grounded in the call. Include "${bookingTerm}: Scheduled", "Caller Type: New ${customerNoun}", "Qualified Lead", and 3–5 signals for what the AI agent actually established (the qualifying answers it captured, the product or service the customer named, an estimate or offer it gave, a service area it confirmed).\n` +
      /* ⚠️ NO "(QA) …" SIGNALS HERE. This report is an AI-handled call: agent-quality scoring
         implies a human took it, and passes on every call by construction. Requested 9/3/2026; the two
         AI CI screens also strip them on read, which is what fixes demos generated before this.
         See src/data/aiSignals.ts. The HUMAN call-log CI above keeps them, deliberately. */
      `    - voiceInfo: realistic metadata → callRecordId (=id), callStartTime ("3/10/26 4:12 pm"), duration (like "5:47"), destinationPhone ("877-936-2933"), source (a real-looking promo phone), promoNumberDescription "Voice — Paid Search", connectionStatus "Connected", callerId (a real-looking phone), repeatCaller "No", city + region (a real US city + 2-letter state), phoneType "Mobile", displayName/firstName/lastName (a plausible customer name), gender, destinationTimeZone ("Pacific Time (US & Canada)"), finalCampaign "Default: Voice Campaign", finalCampaignId "9970118".\n` +
      `  • conversations[1..3] are INACTIVE shells: active:false, a unique id (same hex format), time (like "8/16/25 3:5X pm"), date "", transcript [], signals [], and voiceInfo with all fields set to empty strings "".\n`,
    7000,
    FAST_MODEL
  );
}

/* The two CTI "screen pop" leave-behinds (Voice + SMS), generated together so the
   caller data is coherent and it's a single fast call. Rendered client-side by
   src/artifacts into self-contained HTML shown in My Reports. */
const ScreenpopsOutput = z.object({
  voiceScreenpop: VoiceScreenpop,
  smsScreenpop: SmsScreenpop,
});
function generateScreenpops(client: Anthropic, name: string, brief: string, bookingTerm: string, _customerNoun: string) {
  return structured<z.infer<typeof ScreenpopsOutput>>(
    client,
    ScreenpopsOutput,
    `Using this business brief, produce data for two Invoca CTI "screen pop" demo artifacts for ${name}: a Voice Screenpop (inbound phone lead) and an SMS Screenpop (inbound text lead). Each is an agent-desktop pop showing Invoca Pre-Call Intelligence about the caller.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n` +
      `Both objects: brandName = "${name}". Invent TWO DIFFERENT plausible local leads (different people, phones, addresses) for THIS business, each in a realistic city/state/ZIP inside a service area this business would cover.\n` +
      `For EACH of voiceScreenpop and smsScreenpop set every field:\n` +
      `- callerName (a person's full name), callerPhone (like "(805) 555-0142").\n` +
      `- campaign: a realistic marketing campaign name for THIS business (e.g. "<product/service> - <city> Acquisition").\n` +
      `- tagGreen "✓ In Service Area". tagBlue "New ${bookingTerm} Lead".\n` +
      `- estimatedValue: a plausible dollar deal value for THIS business, NOT a round number (e.g. "$2,485", never "$2,400" or "$3,000").\n` +
      `- googleSearch + websiteSearch: realistic search queries a customer of THIS business would type.\n` +
      `- callingWebpage: a plausible path on this business's site (e.g. "/<product-or-service>").\n` +
      `- products: 2 real product/service names this business offers, comma-separated.\n` +
      `- cartId: like "XX-4827K" (2–3 letters from the brand + dash + 4 alnum).\n` +
      `- serviceable "Yes". email (from the caller name). street, city, state (2-letter), zip (matching the city).\n` +
      `- digitalJourney: a "/home › /a › /b › /a" style path of 3–4 pages on this site.\n` +
      `- intent: one line — the caller's specific need for THIS business.\n` +
      `- coverage: "ZIP <zip> confirmed - <city> serviceable".\n` +
      `voiceScreenpop.switchIntent: one line on urgency / likelihood to switch/buy now (e.g. "High - remodeling now, wants an in-home ${bookingTerm.toLowerCase()} this week").\n` +
      `voiceScreenpop.greeting: a natural SPOKEN suggested greeting the agent would say, naming the caller + ${name} + their need + offering to book a ${bookingTerm.toLowerCase()}.\n` +
      `smsScreenpop.appointment: a ${bookingTerm} the SMS agent ALREADY booked, with a specific day/time (e.g. "In-home ${bookingTerm.toLowerCase()} w/ specialist - Thu Jul 17, 10:00 AM").\n` +
      `smsScreenpop.greeting: a suggested SMS reply from a named rep at ${name}, referencing the already-booked ${bookingTerm.toLowerCase()} and offering to answer questions.\n` +
      `Keep everything specific to ${name}'s actual products/services and consistent within each lead.`,
    4000,
    FAST_MODEL
  );
}

/* ---- Quality Management dashboard (5th) -----------------------------------
   The model generates only the compact re-skinnable content (KPI values, agent
   names/rows, weekly stacks); the engine composes the fixed chart scaffolding
   and deterministic daily points, so the long daily arrays are reliable. */
/* One point per day of the canonical month, so a QM chart can never cover a
   different window than the date filter above it. Each series is re-centred on
   the mean it was asked for (and a count/revenue series can be pinned to an
   exact monthly TOTAL), which is what lets a tile claim an average or a total
   and have it be literally true of the points underneath. The previous version
   drifted ~2 points high because its `(i % 5)` sawtooth wasn't zero-mean. */
const QM_DAYS = 31;
function qmDays(
  barMean: number, barAmp: number, lineMean: number, lineAmp: number,
  withLine: boolean, lineTotal?: number,
) {
  const build = (mean: number, amp: number, phase: number, total?: number) => {
    const raw = Array.from({ length: QM_DAYS }, (_, i) =>
      mean + amp * Math.sin(i * 0.8 + phase) + amp * 0.28 * Math.sin(i * 2.3 + phase));
    const shift = mean - raw.reduce((sum, v) => sum + v, 0) / QM_DAYS;
    const out = raw.map((v) => Math.max(0, Math.round(v + shift)));
    const target = Math.round(total ?? mean * QM_DAYS);
    out[QM_DAYS - 1] += target - out.reduce((sum, v) => sum + v, 0);
    return out;
  };
  const bars = build(barMean, barAmp, 0);
  const lines = withLine ? build(lineMean, lineAmp, 1.2, lineTotal) : null;
  return Array.from({ length: QM_DAYS }, (_, i) => {
    const label = `01/${String(i + 1).padStart(2, "0")}`;
    const p: { label: string; bar: number; line?: number } = { label, bar: bars[i] };
    if (lines) p.line = lines[i];
    return p;
  });
}
const QmAgentRow = z.object({
  agent: z.string(),
  score: z.number(),      // scorecard average %
  conv: z.number(),       // conversion %
  revenue: z.string(),    // "$1,802"
  callCount: z.string(),  // "28"
});
const QmGen = z.object({
  conversionNoun: z.string(),        // the conversion event, Title Case, e.g. "Consultation Booked"
  salesOppCallCount: z.string(),
  salesOppBuyingIntent: z.string(),
  salesConvCount: z.string(),
  salesConvRevenue: z.string(),
  greetingPct: z.string(),
  askedForSalePct: z.string(),
  infoGatheringPct: z.string(),
  callEtiquettePct: z.string(),
  newCustomerSalesPct: z.string(),
  lostAgents: z.array(z.object({ name: z.string(), value: z.number() })), // 5, small ints (1–5)
  weeklyAgents: z.array(z.object({ name: z.string(), values: z.array(z.number()) })), // 4 agents × 5 weeks
  bottomRows: z.array(QmAgentRow), // 5–6, low scores (~40–42%)
  topRows: z.array(QmAgentRow),    // 5–6, higher scores (~46–49%)
});
function composeQm(g: z.infer<typeof QmGen>, sc: Scale): z.infer<typeof QualityManagementView> {
  const convCount = `${g.conversionNoun} (Count)`;
  const convPct = `${g.conversionNoun} (Percent)`;
  const scoreCol = "New Customer Sales Combination Scorecard (Average)";
  const cols = ["Agent", scoreCol, convPct, "Total Revenue (Sale Amount)", "Call Count"];
  const mkBars = (rows: z.infer<typeof QmAgentRow>[]) => ({
    legend: "New Customer Sales Combination Scorecard", axisMax: 100, axisTicks: [0, 25, 50, 75, 100], axisSuffix: "%",
    bars: rows.map((r) => ({ name: r.agent, value: r.score, display: `${r.score}%` })),
  });
  const mkTable = (rows: z.infer<typeof QmAgentRow>[]) => ({
    columns: cols,
    rows: rows.map((r) => ({ cells: [r.agent, `${r.score}%`, `${r.conv}%`, r.revenue, r.callCount] })),
  });
  const lostMax = Math.ceil(Math.max(5, ...g.lostAgents.map((a) => a.value)) / 50) * 50;
  const convRightMax = Math.ceil((sc.consultations / 31) * 1.4 / 100) * 100;
  const revRightMax = Math.ceil((sc.revenue / 31) * 1.4 / 100000) * 100000;
  return {
    title: "QM | Actionable Insights Dashboard",
    dateRange: DATE_RANGE,
    salesOpportunities: { title: "Sales Opportunities", chips: ["Answered by Agent: Yes"], tiles: [{ label: "Call Count", value: g.salesOppCallCount }, { label: "Buying Intent (Industry) (Count)", value: g.salesOppBuyingIntent }] },
    salesConversions: { title: "Sales Conversions", chips: ["2 Filters"], tiles: [{ label: convCount, value: g.salesConvCount }, { label: "Total Revenue (Sale Amount)", value: g.salesConvRevenue }] },
    callsNeedingReview: { title: "Calls Needing Review - Lost Sales Opportunities", chips: ["5 Filters"], chart: { legend: "New Customer Sales Fail (Range & Count)", axisMax: lostMax, axisTicks: [0, lostMax / 4, lostMax / 2, (lostMax * 3) / 4, lostMax], axisSuffix: "", bars: g.lostAgents.map((a) => ({ name: a.name, value: a.value, display: String(a.value) })) } },
    highestConvertingAgents: { yLabel: convCount, xLabels: WEEK_LABELS, series: g.weeklyAgents.map((a) => ({ name: a.name, values: a.values })) },
    baselineSkills: { title: "Baseline Skills", chips: [], tiles: [{ label: "Proper Greeting (Scorecard) (Percent)", value: g.greetingPct }, { label: "Asked for the Sale (Scorecard) (Percent)", value: g.askedForSalePct }] },
    scoredCalls: { title: "Scored Calls", chips: [], tiles: [{ label: "Information Gathering (Average)", value: g.infoGatheringPct }, { label: "Call Etiquette (Average)", value: g.callEtiquettePct }, { label: "New Customer Sales (Average)", value: g.newCustomerSalesPct }] },
    baselineQualityScore: { title: "Baseline Sales Quality Score", cadence: "Daily", barLabel: scoreCol, average: QM_SCORE_MEAN, yMax: 100, yTicks: [0, 25, 50, 75, 100], suffix: "%", points: qmDays(QM_SCORE_MEAN, 8, 0, 0, false) },
    bottomByAgentBar: { title: "Bottom Quality Scores by Agent", chips: ["New Customer Sales Combination Scorecard: Applied"], chart: mkBars(g.bottomRows), pager: "1 - 6 of 30" },
    bottomByAgentTable: { title: "Bottom Quality Scores by Agent", chips: ["New Customer Sales Combination Scorecard: Applied"], table: mkTable(g.bottomRows) },
    topByAgentBar: { title: "Top Quality Scores by Agent", chips: [], chart: mkBars(g.topRows), pager: "1 - 6 of 30" },
    qualityByAgentTable: { title: "Quality Scores by Agent", chips: [], table: mkTable(g.topRows) },
    trendingToConversion: { title: "Trending Sales Quality Score to Conversion", cadence: "Daily", barLabel: scoreCol, lineLabel: convCount, yMax: 100, yTicks: [0, 25, 50, 75, 100], suffix: "%", rightLabel: convCount, rightMax: convRightMax, rightTicks: [0, convRightMax / 4, convRightMax / 2, (convRightMax * 3) / 4, convRightMax], points: qmDays(QM_SCORE_MEAN, 8, Math.round(sc.consultations / 31), Math.round(sc.consultations / 31 / 8), true, sc.consultations) },
    trendingToRevenue: { title: "Trending Sales Quality Score to Revenue", cadence: "Daily", barLabel: scoreCol, lineLabel: "Total Revenue (Sale Amount)", yMax: 100, yTicks: [0, 25, 50, 75, 100], suffix: "%", rightLabel: "Total Revenue (Sale Amount)", rightMax: revRightMax, rightTicks: [0, revRightMax / 3, (revRightMax * 2) / 3, revRightMax], rightPrefix: "$", points: qmDays(QM_SCORE_MEAN, 8, Math.round(sc.revenue / 31), Math.round(sc.revenue / 31 / 8), true, sc.revenue) },
  };
}
async function generateQualityManagement(client: Anthropic, name: string, brief: string, bookingTerm: string, sc: Scale): Promise<z.infer<typeof QualityManagementView>> {
  const g = await structured<z.infer<typeof QmGen>>(
    client,
    QmGen,
    `Using this business brief, produce compact data for the Invoca "QM | Actionable Insights Dashboard" (a QA/scorecard dashboard) for ${name}.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n${scaleRules(sc, bookingTerm)}\n\n` +
      `- conversionNoun: the business's conversion event in Title Case, consistent with the booking term "${bookingTerm}" (e.g. "${bookingTerm} Booked").\n` +
      `- salesOppCallCount MUST be "${n(sc.answered)}" (answered calls) and salesConvCount MUST be "${n(sc.consultations)}", salesConvRevenue MUST be "${$(sc.revenue)}". salesOppBuyingIntent sits BETWEEN them (about "${n(Math.round((sc.answered + sc.consultations) / 2))}") so the funnel only ever narrows.\n` +
      `- greetingPct "95%", askedForSalePct "62%", infoGatheringPct "64.5%", callEtiquettePct "92.3%", newCustomerSalesPct "${QM_SCORE_MEAN}%" — newCustomerSalesPct MUST equal ${QM_SCORE_MEAN}% because that is the average of the agent scorecard scores below.\n` +
      `- lostAgents: EXACTLY 5 { name (a plausible agent full name), value (lost opportunities this month, 150–260) }.\n` +
      `- weeklyAgents: EXACTLY 5 { name (agent, reuse the topRows names), values (EXACTLY 5 ints — one per weekly bucket — trending UP; each agent total must roughly equal that agent callCount x conv% from topRows) }.\n` +
      `- bottomRows: EXACTLY 6 { agent, score (52–61, one decimal), conv (int %, 26–35), revenue, callCount (1,300–1,500) } — the LOWEST scoring agents.\n` +
      `- topRows: EXACTLY 6 { agent, score (87–94, one decimal), conv (int %, 58–67), revenue, callCount (1,400–1,550) } — the HIGHEST scoring agents.\n` +
      `- CRITICAL: higher quality score MUST mean higher conversion. Every topRows conv% must exceed every bottomRows conv% — the two "Trending Quality Score to Conversion/Revenue" tiles exist to prove coaching pays, and the data inverting that kills the story. revenue = callCount x conv% x ${$(sc.revenue / Math.max(1, sc.consultations))} per booking, rounded.\n` +
      `Use realistic agent names; keep everything specific to ${name}. Do NOT include daily time-series arrays.`,
    3500,
    FAST_MODEL
  );
  return composeQm(g, sc);
}

/* Signal — the "Manage Signals" grid. Ten signals in the three groups an SE
   walks through: CONVERSIONS, QUALITY (scorecard-backed) and PRODUCT / INTENT.
   The `rules` string is real Signal syntax, so this reads as the product rather
   than a mock-up; only the spotted phrases re-skin to the vertical. */
function generateSignalManager(client: Anthropic, name: string, brief: string, bookingTerm: string) {
  return structured<z.infer<typeof SignalManagerView>>(
    client,
    SignalManagerView,
    `Produce the Invoca "Signal" (Manage Signals) grid for ${name} — the list of Signals this business has configured.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n` +
      `- title exactly "Signal". filterLabel "All Signals". rowsPerPage "100". pagerLabel "1 - 10 of 10".\n` +
      `- uploadTitle "Upload Signal Records"; uploadBody "Go here to upload Signal and/or revenue amounts to Invoca calls".\n` +
      `- apiTitle "View API Documentation"; apiBody "Learn about how to post Signals and revenue from another system".\n` +
      `- signals: EXACTLY 10, and they MUST cover all three groups so the seller can tell the whole story:\n` +
      `  • EXACTLY ONE CONVERSION — the single won outcome this business counts, named "${bookingTerm} Booked (Conversion)" and the ONLY row with taggedAs "Conversion". Give it usedIn "2 Signals". A later screen drills into this row, so it must be unmistakably the primary conversion.\n` +
      `    Do NOT tag a second row "Conversion". Steps along the way are NOT conversions — an earlier funnel step is "${bookingTerm} Discussed (Industry)" with taggedAs "", and a priced-but-not-won step is something like "Quote Provided" with taggedAs "Lead".\n` +
      `  • 3-4 QUALITY — scorecard-backed coaching signals. usedIn like "1 Scorecard" / "3 Scorecards", taggedAs "".\n` +
      `  • the REST are PRODUCT / INTENT — what the caller wanted or objected to (product interest, price sensitivity, a competitor named, an upsell interest). taggedAs "" or "Lead".\n` +
      `- Every row: status "ACTIVE". types is one of "Keyword Spotting, Rules" | "Keyword Spotting" | "Rules" | "Rules, Scorecard" | "Keypress". usedIn is "" or a count like "2 Signals" / "1 Campaign" / "1 Integration" / "1 Scorecard". description "" on all ten (the real grid leaves it blank). revenue "" on all ten.\n` +
      `- rules MUST use the real Invoca Signal expression syntax, with the spotted phrases re-skinned to THIS business and tagged (Agent) or (Caller):\n` +
      `    keyword rows:   voice_signal = any(1, ["phrase one (Agent)", "phrase two (Caller)", "phrase three"])\n` +
      `    scorecard rows: scorecard[<Scorecard Name>] < 60 and duration > 45 sec\n` +
      `    rule rows:      answered_by_agent   |   duration < 1 min   |   signal = "..." or signal = "..."\n` +
      `  Use 3–4 phrases per keyword row so the cell fills like the real one. Never write a generic phrase — they must be things a caller or agent of THIS business would actually say.\n` +
      `- createdAt / updatedAt: "MM/DD/YY h:mm am|pm", createdAt BEFORE updatedAt, all inside the last ~14 months and consistent with the ${DATE_RANGE} demo window.\n` +
      `- ORDER: the CONVERSION row goes FIRST, then the remaining 9 sorted by name ASCENDING. The real grid is purely name-sorted, but the conversion leads here because a later screen drills into it and it must not be buried mid-list. (The screen re-applies this order anyway, so it is belt-and-braces — but emit it in this order so the data reads the way it renders.)`,
    6000
  );
}

/* ---- QM Instant Insights dashboard (6th) ----------------------------------
   QA/contact-center metrics are generic across verticals, so the model just
   supplies realistic values + evaluator names; the engine composes the cards,
   table, and the two trend charts (deterministic points). */
const QmInstantGen = z.object({
  callCount: z.string(),
  avgHandleTime: z.string(),   // "1:29"
  notAnswered: z.string(),
  negSentiment: z.string(),
  callerTalkPct: z.string(),
  agentTalkPct: z.string(),
  avgOvertalk: z.string(),     // "0:00"
  silencePct: z.string(),
  qaEvalAvg: z.string(),
  introAvg: z.string(),
  phoneEtiquetteAvg: z.string(),
  problemResolutionAvg: z.string(),
  evaluators: z.array(z.object({ name: z.string(), count: z.string(), intro: z.string(), phone: z.string(), problem: z.string() })), // 3
});
function composeQmInstant(g: z.infer<typeof QmInstantGen>): z.infer<typeof QmInstantInsightsView> {
  return {
    title: "QM | Instant Insights Dashboard",
    dateRange: DATE_RANGE,
    trendingEssentialMetrics: {
      title: "Trending Essential Metrics", cadence: "Daily", barLabel: "Negative Sentiment (Percent)", lineLabel: "Average Agent Handle Time",
      linePrimary: true, yMin: 78, yMax: 105, yTicks: [80, 88, 96, 104], suffix: "", tickLabels: ["1:20", "1:28", "1:36", "1:44"],
      rightLabel: "Negative Sentiment (Percent)", rightMax: 120, rightTicks: [0, 5, 10, 15, 20], rightSuffix: "%",
      points: (() => { const p = qmDays(4, 2, 90, 6, true); p[12].line = 101; p[12].bar = 50; return p; })(),
    },
    essentialMetrics: { title: "Essential Metrics", chips: [], tiles: [{ label: "Call Count", value: g.callCount }, { label: "Average Agent Handle Time", value: g.avgHandleTime }, { label: "Not Answered by Agent (Count)", value: g.notAnswered }, { label: "Negative Sentiment (Count)", value: g.negSentiment }] },
    trendingAnswerRate: {
      title: "Trending Answer Rate", cadence: "Daily", lineLabel: "Answered by Agent (Percent)",
      linePrimary: true, yMin: 65, yMax: 100, yTicks: [65, 70, 75, 80, 85, 90, 95, 100], suffix: "%",
      points: qmDays(0, 0, 79, 7, true).map((p) => ({ label: p.label, line: p.line })),
    },
    contactCenterMetrics: { title: "Contact Center Metrics", chips: [], tiles: [{ label: "Caller Talk Time %", value: g.callerTalkPct }, { label: "Agent Talk Time %", value: g.agentTalkPct }, { label: "Average Overtalk Time", value: g.avgOvertalk }, { label: "Silence Time %", value: g.silencePct }] },
    overallEvaluationScore: { title: "Overall Evaluation Score", chips: [], tiles: [{ label: "QA Evaluation Form (Average)", value: g.qaEvalAvg }] },
    evaluationRollup: { title: "Evaluation Rollup", chips: [], tiles: [{ label: "Introduction (Average)", value: g.introAvg }, { label: "Phone Etiquette (Average)", value: g.phoneEtiquetteAvg }, { label: "Problem Resolution (Average)", value: g.problemResolutionAvg }] },
    scoredCallsByEvaluator: { title: "Scored Calls by Evaluator", chips: [], table: { columns: ["Evaluated By", "Evaluated (Count)", "Introduction (Average)", "Phone Etiquette (Average)", "Problem Resolution (Average)"], rows: g.evaluators.map((e) => ({ cells: [e.name, e.count, e.intro, e.phone, e.problem] })) } },
  };
}
async function generateQmInstantInsights(client: Anthropic, name: string, brief: string, sc: Scale): Promise<z.infer<typeof QmInstantInsightsView>> {
  const g = await structured<z.infer<typeof QmInstantGen>>(
    client,
    QmInstantGen,
    `Produce compact data for the Invoca "QM | Instant Insights Dashboard" (a QA at-a-glance dashboard) for ${name}. These are generic contact-center QA metrics — supply realistic values.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `- callCount MUST be exactly "${n(sc.calls)}" and notAnswered exactly "${n(sc.notAnswered)}" (so the answer rate is ${sc.answerRatePct}%, which the trend chart is drawn to match). avgHandleTime (mm:ss like "1:29"). negSentiment about "${n(Math.round(sc.calls * 0.06))}".\n` +
      `- callerTalkPct "32%", agentTalkPct "59%", avgOvertalk "0:00", silencePct "9%" (realistic, similar).\n` +
      `- evaluators: EXACTLY 3 { name (a QA evaluator full name), count (how many calls they scored — hundreds, e.g. "412"), intro, phone, problem (percentages like "83.33%") }.\n` +
      `- introAvg / phoneEtiquetteAvg / problemResolutionAvg MUST each be the COUNT-WEIGHTED average of that column across the 3 evaluators — compute it, do not guess. An average can never fall outside the range of the three numbers it averages. qaEvalAvg = the mean of those three rollups, rounded to a whole percent.\n` +
      `Keep values realistic; vary them a little from the examples.`,
    1500,
    FAST_MODEL
  );
  return composeQmInstant(g);
}

/* The animated "live call routing" leave-behind: the AI voice agent qualifies a
   caller turn-by-turn and routes to the winning team (always queues[0]). */
function generateVoiceRoutingDemo(client: Anthropic, name: string, brandDomain: string, brief: string, bookingTerm: string) {
  return structured<z.infer<typeof VoiceRoutingDemo>>(
    client,
    VoiceRoutingDemo,
    `Using this business brief, produce data for the Invoca "AI Voice Agent — Live Call Routing" demo for ${name}: an animated inbound call where the AI qualifies the caller and routes them to the right team.\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n` +
      `- brandName "${name}". brandDomain "www.${brandDomain}". brandIcon: a SINGLE emoji that fits this business.\n` +
      `- callerPhone like "+1 (805) 555-0142". callerLocation "City, ST" (a realistic city in this business's service area).\n` +
      `- idBadge "New Visitor".\n` +
      `- attribution: EXACTLY 6 {label, value, highlight?} rows: Source ("Google"), Medium ("Paid Search"), Campaign (realistic for THIS business), Keyword (a real customer search, highlight:true), Calling Page (a path on the site, highlight:true), Device ("Mobile - iOS").\n` +
      `- visitorHistory: EXACTLY 3 {label, value, highlight?} rows: Pages Viewed (2 product/service names, highlight:true), Quote Started ("Yes - not submitted", highlight:true), Location (same city).\n` +
      `- queues: EXACTLY 3 {id, name}. id = short snake_case. queues[0] is the WINNING route and MUST be the high-value new-business path toward a ${bookingTerm.toLowerCase()} (e.g. name "${bookingTerm} - New Project"). queues[1] and [2] are other realistic routes for THIS business (e.g. existing-order/support, general support).\n` +
      `- convo: EXACTLY 5 turns, alternating starting with agent (agent, caller, agent, caller, agent). Each { role: "agent"|"caller", text (natural spoken phone language, re-skinned to THIS business; the agent qualifies toward booking a ${bookingTerm.toLowerCase()} and the LAST agent turn routes the caller to queues[0]'s team), sigs (array; agent turns usually [] , caller turns 2–3 { c, t }), q (an array of EXACTLY 3 percentages, positionally aligned to the queues array, summing ~100) }.\n` +
      `  • sigs: c is one of "green" | "blue" | "orange" | "purple"; t is a SHORT phrase that MAY wrap a key term in <strong>…</strong> (e.g. "<strong>New project</strong> - custom install"). Ground them in what the caller just said (product interest, quantity/scope, urgency, confirmed service area).\n` +
      `  • q: probabilities must trend so queues[0] climbs to ~95–96 by the final turn while the others fall.\n` +
      `- routedSubtitle "AI Agent qualified caller intent and matched to the right team".\n` +
      `Keep everything specific to ${name}'s actual products/services.`,
    5000,
    FAST_MODEL
  );
}

function generateAgentConfig(client: Anthropic, name: string, _brandDomain: string, brief: string, bookingTerm: string) {
  return structured<z.infer<typeof AgentConfigView>>(
    client,
    AgentConfigView,
    `Using this business brief, produce the Invoca Agent Studio configuration for ${name}'s AI agent (a scheduling/intake assistant that answers questions and books the business's ${bookingTerm.toLowerCase()}).\n\n` +
      `BRIEF:\n${brief}\n\n` +
      `${reskin(name)}\n\n` +
      `- brandConversationRules: exactly 3 rules, each ONE string of 1–2 sentences, each starting with a short label + colon. They describe how the AI SMS agent runs a qualify-then-book conversation (NO emojis). Make them specific to THIS business:\n` +
      `  1) Intro + offer: introduce yourself as ${name}'s AI agent helping with a personalized quote, mention a plausible current offer/incentive if one fits, and ask if they'd like to get started.\n` +
      `  2) Qualify one question at a time: list the 4–5 key qualifying questions for THIS business (quantity, sizes/measurements, material/type/model, timeline, and ZIP code to confirm service availability).\n` +
      `  3) Estimate then book: confirm you service their ZIP, give a preliminary price RANGE based on what they shared, recommend a consultation with a specialist for an exact quote, propose a specific day/time, and confirm they'll get a reminder text before the appointment with a number to call.\n` +
      `- knowledgeSources: exactly 5 items the agent "learned" the business from:\n` +
      `  • 1 Document named "${name.replace(/[^A-Za-z0-9]+/g, "_")}_Sales_Playbook.pdf", type "Document", lastUpdated "03/11/2026 10:21 AM".\n` +
      `  • 4 Web Links to THIS business's MAIN pages, type "Web Link", lastUpdated "03/11/2026 10:02 AM". Each "name" MUST be a SHORT human-readable page label (e.g. "Homepage", "Services & Specialties", "Locations", "Find a Provider", "Book an Appointment") specific to ${name} — NOT a raw URL.\n` +
      `- aiRecommendations: exactly 2 AI Q&A recommendation cards built from call transcripts:\n` +
      `  1) title "Qa pairs - 2026-03-11 13:12", updated "07/09/2026 3:29 PM", enabled true. payload = a JSON STRING of the form {"task_data_type":"application/json","EXISTING_CUSTOMER":[{"topic":"...","question":"...","answer":"..."}, ...]} with 2 realistic existing-customer Q&A pairs for THIS business (e.g. warranty/order status/reschedule), answers 1–2 sentences. ALSO include qaPairs: exactly 20 {question, answer} pairs = the most common customer questions from call transcripts for THIS business, each answer 1–2 sentences, on-brand, steering toward booking the consultation/appointment and never quoting exact pricing.\n` +
      `  2) title "Intent follow up - 2026-03-11 13:12", updated "07/09/2026 3:29 PM", enabled false. payload = a JSON STRING of the form {"task_data_type":"application/json","NEW_CUSTOMER":[{"intent":"...","follow_up_message":"..."}, ...]} with 2 realistic new-customer intents (e.g. schedule the booking, request a quote) whose follow_up_message confirms/advances toward the booking.\n` +
      `- smsPlaybook: the plan for the LIVE SMS agent conversation, chosen by SMART JUDGMENT from what THIS business actually does (use the brief above):\n` +
      `  • bookingType: the single most fitting thing this business would schedule with a new customer, INCLUDING modality — and it MUST be consistent with the platform booking term "${bookingTerm}" (you may add modality, e.g. if the term is "${bookingTerm}" use something like "virtual ${bookingTerm.toLowerCase()}" or "in-home ${bookingTerm.toLowerCase()}"). Examples of the shape: "virtual consultation", "in-home estimate", "showroom tour", "test drive", "service appointment".\n` +
      `  • providesEstimate: true ONLY if this business would realistically give a rough PRICE/ESTIMATE over text (quote-based trades: blinds, remodeling, roofing, HVAC, auto repair, movers). false for businesses that just book a visit/tour/appointment with no upfront pricing (gyms, salons/spas, dealerships booking a test drive, real estate tours, medical/dental).\n` +
      `  • offer: a plausible current incentive to book now (e.g. "Save 10% when you book today") ONLY if it fits this business; otherwise "".\n` +
      `  • goal: one sentence for what the conversation drives toward for THIS business.\n` +
      `  • qualifyingQuestions: 4–6 ordered, business-specific questions the agent asks ONE at a time to qualify the customer; end with asking for their ZIP code / location to confirm service availability where relevant.\n` +
      `- serviceArea: if ${name} is a LOCAL / in-home / regional service business with a limited geographic area, a short phrase naming that serviceable area including a ZIP hint (e.g. "the greater Austin, Texas area — ZIP codes starting with 787"). If ${name} serves nationally or is online/e-commerce with no geographic limit, set this to an EMPTY string "".\n` +
      `Keep everything realistic and specific to ${name}'s actual products/services.`,
    10000
  );
}

/* ---- Public entry point --------------------------------------------------- */
export async function generateProfile(
  name: string,
  url: string,
  opts: { apiKey?: string; onProgress?: Progress } = {}
): Promise<z.infer<typeof CustomerProfile>> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
  const progress = opts.onProgress ?? (() => {});
  // maxRetries lets the SDK back off + retry 429/529 ("overloaded") automatically —
  // important now that the post-report phases fire concurrently (see below).
  const client = new Anthropic({ apiKey, maxRetries: 4 });

  const slug = slugify(name);
  const brandDomain = domainOf(url);

  progress({ phase: "research", status: "start" });
  const brief = await research(client, name, url);
  progress({ phase: "research", status: "done" });
  progress({ phase: "terms", status: "start" });
  const terms = await generateTerms(client, name, brief);
  progress({ phase: "terms", status: "done" });
  const bookingTerm = terms.bookingTerm;
  const customerNoun = terms.customerNoun;
  const qualifiedCallTerm = terms.qualifiedCallTerm;
  const conversionTerm = terms.conversionTerm;
  const scale = buildScale(terms, name);
  console.log(`[scale] ${n(scale.calls)} calls/mo, ${n(scale.purchases)} sales @ ${$(scale.avgSale)} = ${$(scale.revenue)}`);
  /* Everything after the terms call depends ONLY on the brief + the 4 canonical terms
     (not on each other), so the 15 remaining phases — INCLUDING the heavy Digital
     Insights table (nothing reads it until final assembly) — run through a
     CONCURRENCY-LIMITED POOL, ordered LONGEST-PROCESSING-TIME FIRST so a heavy phase
     never starts late and tails the makespan. CONCURRENCY=6 fits the ~6 Opus phases in
     the first wave; the client's maxRetries + a small per-phase start jitter keep
     429/529 bursts down. `phase` retries ONCE on ANY rejection (rescues a one-off
     malformed-JSON/Zod failure) and logs each phase's wall-clock. */
  const CONCURRENCY = 6;
  const phase = <T,>(label: string, run: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    progress({ phase: label, status: "start" });
    const done = (r: T): T => {
      console.log(`[phase] ${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      progress({ phase: label, status: "done" });
      return r;
    };
    const retry = (e: any): Promise<T> => {
      console.log(`[phase] ${label} retry after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e?.message ?? e}`);
      progress({ phase: label, status: "start" });
      return run().then(done);
    };
    // small random stagger so the pool workers don't all hit the API in the same instant
    return new Promise<void>((res) => setTimeout(res, Math.floor(Math.random() * 350))).then(run).then(done, retry);
  };

  /* Ordered LONGEST-PROCESSING-TIME FIRST, from the timings the CLI logs
     (`[phase] <name>: <s>s`). Re-measure and re-sort if a phase's prompt grows —
     a heavy phase that starts late tails the whole makespan, which is exactly the
     failure the dashboard split above was fixing. */
  const [
    dashChannels, dashSegments, opsDashboard, callReview, agentConfig, signalManager,
    dashCore, digitalInsights, conversationIntelligence, callDetail, aiAgentConversion,
    voiceConversationIntelligence, smsConversationIntelligence, aiMessagingImpact,
    voiceRoutingDemo, screenpops, qualityManagement, qmInstantInsights,
  ] = await runPool([
    () => phase("dashboardChannels", () => generateDashboardChannels(client, name, brief, bookingTerm, conversionTerm, scale)),
    () => phase("dashboardSegments", () => generateDashboardSegments(client, name, brief, bookingTerm, conversionTerm, scale)),
    () => phase("opsDashboard", () => generateOpsDashboard(client, name, brief, bookingTerm, customerNoun, scale)),
    () => phase("callReview", () => generateCallReview(client, name, brief, bookingTerm, scale)),
    () => phase("agentConfig", () => generateAgentConfig(client, name, brandDomain, brief, bookingTerm)),
    () => phase("signalManager", () => generateSignalManager(client, name, brief, bookingTerm)),
    () => phase("dashboard", () => generateDashboardCore(client, name, brief, bookingTerm, qualifiedCallTerm, conversionTerm, scale)),
    () => phase("digitalInsights", async () => stripAppOwnedFields(await generateDigitalInsights(client, name, brandDomain, brief, bookingTerm, scale))),
    () => phase("conversationIntelligence", () => generateConversationIntelligence(client, name, brief, bookingTerm, customerNoun, scale)),
    () => phase("callDetail", () => generateCallDetail(client, name, brief, bookingTerm)),
    () => phase("aiAgentConversion", () => generateAiAgentConversionDashboard(client, name, brief, bookingTerm, customerNoun, qualifiedCallTerm, conversionTerm, scale)),
    () => phase("voiceConversationIntelligence", () => generateVoiceConversationIntelligence(client, name, brief, bookingTerm, customerNoun, scale)),
    () => phase("smsConversationIntelligence", () => generateSmsConversationIntelligence(client, name, brief, bookingTerm, customerNoun, scale)),
    () => phase("aiMessagingImpact", () => generateAiMessagingImpact(client, name, brief, bookingTerm, customerNoun, scale)),
    () => phase("voiceRoutingDemo", () => generateVoiceRoutingDemo(client, name, brandDomain, brief, bookingTerm)),
    () => phase("screenpops", () => generateScreenpops(client, name, brief, bookingTerm, customerNoun)),
    () => phase("qualityManagement", () => generateQualityManagement(client, name, brief, bookingTerm, scale)),
    () => phase("qmInstantInsights", () => generateQmInstantInsights(client, name, brief, scale)),
  ], CONCURRENCY);
  const dashboard = assembleDashboard(dashCore, dashChannels, dashSegments);

  /* Gumloop leave-behinds → clickable rows in My Reports. All three are rendered
     from the data above (src/artifacts), so every prospect gets them complete. */
  const artStamp = new Date()
    .toLocaleString("en-US", { month: "numeric", day: "numeric", year: "2-digit", hour: "numeric", minute: "2-digit", hour12: true })
    .replace(",", "")
    .toLowerCase();
  const gumloopArtifacts = [
    { id: "voice-screenpop", name: "Voice Screenpop", status: "complete" as const, createdAt: artStamp },
    { id: "sms-screenpop", name: "SMS Screenpop", status: "complete" as const, createdAt: artStamp },
    { id: "voice-routing-demo", name: "Voice Routing Demo", status: "complete" as const, createdAt: artStamp },
  ];

  const profile = {
    id: slug,
    customerName: name,
    websiteUrl: url,
    brandDomain,
    networkName: terms.networkName,
    industry: terms.industry,
    bookingTerm,
    customerNoun,
    reports: { digitalInsights, marketingDashboard: dashboard, callReview, callDetail, opsDashboard, aiAgentConversion, aiMessagingImpact, qualityManagement, qmInstantInsights, conversationIntelligence, smsConversationIntelligence, voiceConversationIntelligence, agentConfig, voiceScreenpop: screenpops.voiceScreenpop, smsScreenpop: screenpops.smsScreenpop, voiceRoutingDemo, signalManager, gumloopArtifacts },
  };
  /* DASH SWEEP AT THE SOURCE. NO_DASH_RULE tells the model not to join clauses
     with a dash, and it mostly listens, but "mostly" is not a guarantee: the two
     most recently generated prospects arrived with 24 of them between them, and
     they were only caught because someone ran scripts/strip-dashes.ts by hand
     weeks later. Two prospects had already been demoed with dash-joined copy.

     Sweeping HERE, at the single point every profile passes through, means the
     CLI, the dev endpoint, the prod endpoint and the library publish all get
     clean data without anyone remembering a script. Same rules as the boot
     migration and the script (engine/dashSweep.ts), so the three cannot drift:
     table placeholders and numeric/date ranges keep their dash, prose does not.

     This is the instruct-then-enforce pattern already used for the live agents'
     replies (stripDashes in engine/chat.ts). The prompt asks; the code makes sure. */
  const swept = sweepValue(profile, { n: 0 });

  // Final guardrail: validate against the canonical schema.
  return CustomerProfile.parse(swept);
}
