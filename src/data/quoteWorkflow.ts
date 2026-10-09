import type { CustomerProfile, ExtraWorkflow } from "./schema";
import { CUSTOMER } from "../customer/mode";
import { useQuoteCaptures, type LsaQuote } from "./QuoteCaptureContext";

/* =============================================================================
   The SMS workflow a submitted LSA quote request creates (9/12/2026)
   -----------------------------------------------------------------------------
   Asked for directly: *"When send is click… also create a SMS Workflow based on what is
   shared in the form. Duplicate the SMS workflow, keep everything the same, the only
   difference will be the Preview Agent and Preview Workflow. the opening message and follow
   up messages are customized based on what was typed in the form fields: Your message,
   Service and Name."*

   ⚠️⚠️ **SO THE TREE IS DELIBERATELY THE STANDARD ONE.** `branches: []` makes `extraTree`
   render exactly the four locked chrome boxes and the two locked leaves with their default
   actions — i.e. the same shape the built-in SMS workflow draws. The instruction was "keep
   everything the same"; inventing use cases here would be the one thing that made it NOT a
   duplicate. Everything that differs is conversation: `openingMessage` and `playbookSteps`.

   ⚠️ **THE FORM'S THREE FIELDS EACH DO A DIFFERENT JOB, and none is dropped:**
     • NAME    — the agent greets them by name, so the first text is addressed to a person.
     • MESSAGE — quoted back in the opener (that is what makes it read as a reply rather than
                 a broadcast) and given to the model as the job to be scoped.
     • SERVICE — the line of work, so the follow-ups ask the right qualifying questions. It is
                 OPTIONAL on the form, so every use of it is guarded and the flow still reads
                 correctly when it is absent.

   ⚠️ **THE OPENER IS NOT A TEMPLATE WITH A NAME SLOTTED IN.** It quotes the SE's own words
   back, which is the whole reason the beat lands: the SE types a real problem into Google and
   the agent's first text is visibly about THAT problem.

   ⚠️ **`{name}` IS NOT USED HERE, and that is a deliberate difference from every authored
   workflow.** That token exists because an authored opener has to work for whoever turns up;
   this one is written for a person who just typed their own name into the form, so the name is
   baked in. `resolveGreeting` leaves a token-free string alone, so nothing downstream changes.
   ============================================================================= */

/** A short, human rendering of the message for the opener — never the whole essay. */
function shorten(raw: string, max = 120): string {
  const s = raw.trim().replace(/\s+/g, " ");
  if (s.length <= max) return s;
  /* Cut on a word boundary; an ellipsis mid-word reads as a bug rather than as a quote. */
  return `${s.slice(0, s.lastIndexOf(" ", max) || max).replace(/[,.;:]$/, "")}…`;
}

/** "Dana Whitfield" -> "Dana". The agent uses a first name, as every SMS opener here does. */
function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? "";
}

export const QUOTE_WF_PREFIX = "lsa-quote-";

/**
 * The ONE slug every quote-request workflow uses.
 *
 * ⚠️⚠️ **THERE IS AT MOST ONE OF THESE AT A TIME, AND IT USED TO BE ONE PER SUBMISSION
 * (9/15/2026).** Reported with a screenshot of the Agent Studio sub-nav carrying ELEVEN
 * "Aptive - SMS - Quote Request (…)" rows — one per quote submitted while rehearsing, test
 * names and all: *"it looks like a new workflow is being created every time, what i want is
 * that it replace the Quote Request workflow if another one already exists."* Every one of
 * them was Live, and the newest was not obviously the real one.
 *
 * ⚠️ **A STABLE SLUG RATHER THAN SLICING THE LIST TO ONE, and the difference is what an SE
 * sees mid-demo.** Keeping the per-quote `lsa-quote-<id>` slug and rendering only the newest
 * would mean the row an SE is LOOKING AT changes URL on the next submission: the store updates,
 * the page re-renders, the slug no longer resolves and the canvas they were presenting turns
 * into "Workflow not found". One canonical slug makes the page re-render with the new content
 * in place, which is what "replace" actually means here.
 *
 * ⚠️ **CONSEQUENCE, STATED: Ask AI edits made against this page now outlive the submission
 * they were made for.** Overrides are keyed by `<profileId>::<pathname>`, so an edited opener
 * persists onto the NEXT person's workflow — and it would still quote the previous person's
 * words. It takes a deliberate edit of an auto-generated workflow to hit, and it is the same
 * per-path persistence every other screen has, so it is recorded rather than designed around.
 *
 * ⚠️ It still begins with `QUOTE_WF_PREFIX`, so `isQuoteWorkflow` keeps recognising both this
 * and any legacy `lsa-quote-<id>` slug sitting in a seven-day-old capture store.
 */
export const QUOTE_WF_SLUG = `${QUOTE_WF_PREFIX}request`;

/** Is this one of ours (as opposed to a workflow authored into the profile)? */
export function isQuoteWorkflow(slug: string): boolean {
  return slug.startsWith(QUOTE_WF_PREFIX);
}

/**
 * The quote a quote-request workflow was written from.
 *
 * ⚠️ The canonical slug carries no id, so it resolves to the most recent submission — which
 * IS the one the workflow renders. A legacy `lsa-quote-<id>` slug still matches by id while
 * that quote is in the store, and falls back to the newest rather than resolving to nothing:
 * a Preview Agent that silently loses its LSA lead-in message is worse than one showing the
 * current caller's.
 */
export function quoteForWorkflow(slug: string, quotes: LsaQuote[]): LsaQuote | undefined {
  if (!isQuoteWorkflow(slug)) return undefined;
  const id = slug.slice(QUOTE_WF_PREFIX.length);
  return quotes.find((q) => q.id === id) ?? quotes[0];
}

/* =============================================================================
   The LSA lead payload — the FIRST message of an LSA conversation (9/12/2026)
   -----------------------------------------------------------------------------
   Asked for directly, with a capture of the real thing (an Interactions report for a pest
   control advertiser): *"for the LSA submission, when setting up the SMS agent the first
   message only in the interaction report should always be 'You have received a new message
   from a customer via Google Local Services Ads. Customer Name: …, Location: …, Service: …,
   Message: … [Notes from LSA: This customer has requested a quote].'"*

   ⚠️⚠️ **THIS IS AN INBOUND MESSAGE, NOT THE AGENT'S GREETING — read off the capture, not the
   screenshot.** It sits on the CONSUMER side of the thread and the agent's own first reply
   follows it ("Thank you for contacting <business>. Reply STOP at any time to opt out…"). It
   has to: the text is addressed to the BUSINESS ("You have received…"), so sending it as the
   agent's opener would be texting the customer a notification about themselves. Only the first
   message changes, exactly as asked — `quoteWorkflow`'s opener is untouched.

   ⚠️⚠️ **AN EMPTY SLOT KEEPS ITS LABEL, AND THAT IS MEASURED RATHER THAN TIDIED.** The captured
   payload reads `Customer Name: , Location: Lowell` — that advertiser's feed carried no name
   and the label stayed with nothing after it. So a missing value renders as nothing and the
   shape is preserved, which is also what makes this correct for a quote captured before
   `location` existed (the store is persisted for seven days).

   ⚠️ **THE STRING IS THE CAPTURE'S, CHARACTER FOR CHARACTER**, including the bracketed note and
   the full stop AFTER it. Extracted from the saved HTML rather than transcribed from the
   screenshot, per the standing rule about screenshot-derived values.
   ============================================================================= */
export function lsaLeadMessage(q: LsaQuote): string {
  /* ⚠️⚠️ **THE LSA WORDING IS MEASURED AND MUST NOT MOVE** — it is asserted character-for-
     character against the captured Interactions report. The web-form variant is AUTHORED, by
     the same structure, because no capture of one exists; it is flagged rather than presented
     as measured. Everything after the channel phrase is shared, so the two can never drift
     apart in the fields that carry the form's own data. */
  const web = q.source === "web";
  const channel = web ? "the website lead form" : "Google Local Services Ads";
  const note = web ? "Notes from Web" : "Notes from LSA";
  return `You have received a new message from a customer via ${channel}. `
    + `Customer Name: ${q.name.trim()}, `
    + `Location: ${(q.location ?? "").trim()}, `
    + `Service: ${q.service.trim()}, `
    + `Message: ${q.message.trim().replace(/\s+/g, " ")} `
    + `[${note}: This customer has requested a quote].`;
}

export function quoteWorkflow(profile: CustomerProfile, q: LsaQuote): ExtraWorkflow {
  const first = firstName(q.name);
  const svc = q.service.trim();
  const booking = profile.bookingTerm.toLowerCase();
  const quoted = shorten(q.message);

  /* The opener: who it is from, that it is answering THIS request, the request itself in
     their own words, and one question. One question, because every SMS rule in this repo
     says so and because two in a first text is what makes a bot obvious. */
  /* ⚠️⚠️ **TWO THINGS VARY BY SOURCE, AND BOTH WOULD READ AS A BUG IF THEY DID NOT.**
     A quote submitted on the prospect's OWN replicated booking page did not come "on Google",
     and those forms often have no free-text box at all (measured: Aptive's has five fields and
     none of them is a message) — so a fixed opener would greet a real person with
     `You told us: ""`. The quote is included only when there IS one, and the channel phrase
     names where they actually came from. */
  const web = q.source === "web";
  /* ⚠️ THE TWO INTROS ARE WHOLE SENTENCES, NOT A SHARED STEM WITH A SWAPPED TAIL. Built as
     `this is <name> ${from}.` the web variant reads "this is AutoNation thanks for reaching
     out through our website" — the LSA tail happens to work as an appositive and the web one
     does not. Cheaper to write both than to find a phrasing that fits both. */
  const intro = web
    ? `Hi ${first}, this is ${profile.customerName}. Thanks for reaching out through our website. `
    : `Hi ${first}, this is ${profile.customerName} replying to your quote request on Google. `;
  const openingMessage =
    intro
    + (quoted ? `You told us: "${quoted}" ` : "")
    + (svc ? `We handle ${svc.toLowerCase()} every day and can help. ` : `We can help with that. `)
    + `What day works best for a ${booking}?`;

  /* The follow-ups. Ordered, one question at a time, and every one of them is downstream of
     something the SE actually typed — which is what makes this workflow different from the
     prospect's standing SMS agent. */
  const playbookSteps = [
    `Open with the message above, verbatim.${quoted ? ` It already quotes ${first}'s own request, so do not restate it.` : ""}`,
    (quoted
      ? `The request they submitted was: "${q.message.trim()}"${svc ? ` They selected the service "${svc}".` : " They did not pick a service."} Treat that as the job to be scoped, and never ask them to repeat it.`
      /* No free-text box on this form, so there is no request to scope yet — say so plainly
         rather than letting the model infer one from nothing. */
      : `They submitted ${web ? "the enquiry form on our website" : "a quote request"} and left no message${svc ? `, selecting the service "${svc}"` : ""}, so you do not yet know what the job is. Establish that first.`),
    svc
      ? `Confirm the specifics of the ${svc.toLowerCase()} job — what is affected, how long it has been going on, and whether it is urgent. One question per message.`
      : `Establish what kind of work it is before anything else, then the specifics — what is affected, how long it has been going on, and whether it is urgent. One question per message.`,
    `Ask for the service address or ZIP code so the right team is sent.`,
    `Offer two concrete ${booking} windows and let ${first} pick one.`,
    `Confirm the agreed day and time back in one short message, and tell them they will get a reminder.`,
    `If they ask what it will cost, give a range if the profile has one and be explicit that the firm price comes after the ${booking}. Never invent a figure.`,
  ];

  const systemPrompt =
    `You are ${profile.customerName}'s AI messaging assistant, replying by SMS to a quote `
    + `request that ${q.name} submitted through ${profile.customerName}'s Google Local Services `
    + `ad moments ago.\n\n`
    + `THE REQUEST, IN THEIR OWN WORDS: "${q.message.trim()}"\n`
    + (svc ? `SERVICE SELECTED: ${svc}\n` : `SERVICE SELECTED: none — they left it blank.\n`)
    + `NAME: ${q.name}\n`
    + `THEY ASKED TO BE CONTACTED BY: ${q.how === "sms" ? "SMS or phone call" : "email"} (${q.contact})\n\n`
    + `GROUND RULES\n`
    + `1. They have ALREADY told you what they need. Never make them repeat it, and never open `
    + `as though this is a cold first contact.\n`
    + `2. One question per message. Keep every message under about 25 words, plain text, no `
    + `markdown and no emoji.\n`
    + `3. Your job is to scope the work, get a service address, and book a ${booking}.\n`
    + `4. Never quote a firm price over text and never invent one. A range is fine only if `
    + `${profile.customerName} already publishes one; the firm price follows the ${booking}.\n`
    + `5. Never invent an address, a technician's name, or an arrival time you have not agreed.\n`
    + `6. If they ask for a human, hand off and say someone will call them on ${q.contact}.`;

  return {
    /* ⚠️ ONE slug for every submission — see `QUOTE_WF_SLUG`. The LABEL still names the
       current person, so the sub-nav says whose request this is; only the row no longer
       multiplies. */
    slug: QUOTE_WF_SLUG,
    label: `${profile.customerName} - SMS - Quote Request (${first})`,
    channel: "SMS",
    status: "Live",
    /* ⚠️ **THE TRIGGER NAMES WHERE THE SUBMISSION ACTUALLY CAME FROM.** This was pinned to the
       LSA wording, so a lead filled in on the prospect's OWN replicated booking page listed in
       Agent Studio under "Google Local Services ad" — a Triggered By column contradicting the
       page the SE had just submitted in front of the room. `q.source` already decides the
       opener's channel phrase two functions up; this is the same fact, so it reads the same
       flag rather than a second one that can drift out of step with it. */
    triggeredBy: q.source === "web"
      ? `${profile.customerName} website form — quote request submitted`
      : "Google Local Services ad — quote request submitted",
    startLabel: "SMS · reply to a quote request",
    /* See the header: empty on purpose, so the tree is the standard SMS one. */
    branches: [],
    systemPrompt,
    openingMessage,
    playbookSteps,
    /* ⚠️⚠️ **THIS IS WHY THE OPENER ACTUALLY REACHES THE PHONE.** `buildSmsBrain` ranks a
       stored `smsPlaybook.greeting` ABOVE a workflow's own `openingMessage` — the correct fix
       for the 9/3 silent no-op, where an SE's edited greeting was being beaten by an authored
       workflow's scripted line. But this opener is not authored-in-advance: it was written
       from a form submitted seconds ago and quotes that person's own words, so on the three
       profiles that DO ship a stored greeting (Aptive, Denver Health, Marriott — measured) the
       whole feature would silently open with the generic line instead. Flagged rather than
       re-ordering the precedence for everyone, so every existing workflow is untouched. */
    openingMessageWins: true,
  };
}

/**
 * Every extra workflow this prospect has: the ones submitted during the demo first, then the
 * ones authored into the profile.
 *
 * ⚠️⚠️ **ONE DEFINITION, SIX READERS.** The Agent Studio table, the left sub-nav, the workflow
 * page, the Preview Agent tab, the Preview Workflow drawer and the preview page's title all
 * resolve a workflow, and a slug that lists in one but resolves in none is a dead row mid-demo
 * — the same class of failure `leadSlug` is kept single to avoid. Newest first, matching what
 * the SMS and Voice CI reports already do with their captures.
 */
export function extraWorkflowsFor(profile: CustomerProfile, quotes: LsaQuote[]): ExtraWorkflow[] {
  /* ⚠️⚠️ **THE NEWEST SUBMISSION ONLY — this was `quotes.map(...)` and it produced one Live
     workflow per quote** (reported at eleven of them; see `QUOTE_WF_SLUG`). Rehearsing the LSA
     beat means submitting the form repeatedly, so the list grew every run and the sub-nav
     filled with test names.

     ⚠️ **AND IT NOW MATCHES WHAT THE LEAD SIDE ALREADY DID.** `liveQuoteLead` reads `quotes[0]`
     and has from the start, so a second submission always replaced the Salesforce lead while
     adding another workflow — one store, two behaviours. The store itself is left alone: it
     keeps its seven-day history, which is what lets `quoteForWorkflow` resolve a legacy slug. */
  const latest = quotes[0];
  return [
    ...(latest ? [quoteWorkflow(profile, latest)] : []),
    ...(profile.reports.extraWorkflows ?? []),
  ];
}

/**
 * The hook every one of those six readers actually calls.
 *
 * ⚠️ The dependency points ONE WAY — this file imports the capture context, and the context
 * imports nothing back. The reverse (putting the hook beside the store) would have made a
 * runtime cycle of exactly the kind `leadSlug` was moved to kill.
 */
export function useExtraWorkflows(profile: CustomerProfile): ExtraWorkflow[] {
  const all = extraWorkflowsFor(profile, useQuoteCaptures().capturedFor(profile.id));
  /* Customer build: no extra workflows (see src/customer/mode.ts). Dead code in the staff app. */
  return CUSTOMER ? [] : all;
}
