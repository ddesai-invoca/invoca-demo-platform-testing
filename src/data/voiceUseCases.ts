import type { CustomerProfile } from "./schema.ts";

/* =============================================================================
   voiceUseCases.ts — the branches under the two user-group nodes
   -----------------------------------------------------------------------------
   Agreed 8/27/2026. The four chrome nodes stay locked because the real Invoca page does not
   let anyone rename them, but the row BELOW "All Sales Inquiry Users" and "All Support Users"
   is configuration: as many branches as the SE wants, each one a USE CASE with its own fields
   to collect and its own destination.

   ⚠️ **DERIVED, NOT GENERATED.** No engine phase and no schema slice, so generation time is
   unchanged and every demo already on disk gets these the moment it renders. Same call
   `deriveVoiceSpec`, `leadFormFacts` and `franchiseAi` already make.

   ⚠️ **SALES BRANCHES ARE BUYING STAGE, NOT PRODUCT LINE.** The alternative was one branch per
   "Conversions by Product Category" row, which reads well on a slide and is wrong on a phone:
   a caller does not ring up having already sorted themselves into the prospect's product
   taxonomy. Where they are in the decision ("ready to book", "still comparing", "booking for a
   group") is something they CAN answer, and it is the split that changes how the call is
   routed.

   ⚠️ **SUPPORT BRANCHES ARE ACTIONS**, for the same reason: an existing customer rings up to
   DO something (change it, cancel it, query a charge), and each of those wants a different
   reference number and a different team.

   ⚠️⚠️ **`vocabFor` IS NOT EXTENDED HERE, DELIBERATELY.** That helper feeds the Insights column
   catalogue, the tile Configuration drawer and the question catalogue; adding voice words to it
   would change screens nobody asked about. The same reasoning is recorded at `franchiseAi.ts`,
   which overrides its noun locally rather than upstream. This file keeps its own vocabulary and
   touches nothing else.
   ============================================================================= */

/** One branch under a user-group node. */
export interface VoiceUseCase {
  /** The node's title, and the answer the caller gives. */
  title: string;
  /** Its pills, AND what the agent asks for on that path. One list, two renderings. */
  collect: string[];
  /**
   * The team it hands off to, named aloud on transfer.
   *
   * ⚠️ **OPTIONAL, AND THAT IS LOAD-BEARING.** Comfort Keepers' spec is SE-authored and names
   * no destinations; leaving this undefined keeps its diagram and its call byte-identical.
   * Opt-in props defaulted to today's behaviour is the standing rule for shared components.
   */
  route?: string;
}

export interface VoiceUseCases {
  sales: VoiceUseCase[];
  support: VoiceUseCase[];
}

/**
 * Voice-specific vocabulary, keyed off the prospect's industry.
 *
 * ⚠️ MOST SPECIFIC VERTICAL FIRST, the same ordering trap `vocabFor` documents: an industry
 * string frequently names two verticals ("Window treatments & home services") and whichever
 * test runs first wins.
 */
export function voiceVocab(profile: CustomerProfile) {
  const ind = (profile.industry || "").toLowerCase();
  /* ⚠️ **WORD BOUNDARIES, NOT `includes`.** A substring test matched "car" inside "In-home
     senior CARE", so Comfort Keepers derived a "Fleet or business enquiry" branch routed to
     Fleet Sales and asked callers for a "Purchase Timeline". Its own industry string turned a
     senior-care agent into a car dealership, and nothing failed. `vocabFor` gets away with
     `includes` because none of its keywords are substrings of another vertical's word; these
     are, so they cannot. */
  const has = (...w: string[]) =>
    w.some((x) => new RegExp(`(^|[^a-z])${x}[a-z]*([^a-z]|$)`, "i").test(ind));
  /* ⚠️ AND THE KEYWORD "car" IS BANNED FROM THE LISTS BELOW. The boundary fixed the front of
     the word but the trailing `[a-z]*` still let "car" swallow "care", so Comfort Keepers was
     STILL a car dealership after the first fix. "auto" already covers "Automotive", so the
     keyword bought nothing and cost a whole vertical. Suffix wildcards are needed for
     automotive/insurance/cleaning, so the discipline is on the keyword list, not the regex. */

  /* WHERE the service happens. For a hotel this is the DESTINATION, not the caller's own ZIP —
     a guest's home postcode tells you nothing about which property they want, which is exactly
     what the generic template got wrong on Marriott. */
  const where =
    has("hotel", "lodging", "resort", "travel", "vacation") ? "Destination"
    : has("home service", "plumb", "hvac", "roof", "restoration", "clean", "pest") ? "Service Address"
    : has("senior", "care", "living") ? "Care Location"
    : "Consumer Zip";

  /* WHEN they want it. */
  const when =
    has("hotel", "lodging", "resort", "travel", "vacation") ? "Travel Dates"
    : has("health", "medical", "clinic", "hospital", "dental") ? "Preferred Date"
    : has("auto", "vehicle", "dealer", "tire") ? "Purchase Timeline"
    : "Timeline";

  /* The reference an EXISTING customer quotes. This is the single biggest reason the support
     branches need their own fields: none of them want a ZIP. */
  const ref =
    has("hotel", "lodging", "resort", "travel", "vacation") ? "Confirmation Number"
    : has("insur", "policy") ? "Policy Number"
    : has("health", "medical", "clinic", "hospital", "dental") ? "Patient ID"
    : has("retail", "store", "mattress", "blind", "window", "furnish") ? "Order Number"
    : `${profile.bookingTerm} Reference`;

  /* The larger-than-one-caller enquiry, which is a different desk in every vertical. */
  const bulk =
    has("hotel", "lodging", "resort", "travel", "vacation") ? { title: "Group or event booking", team: "Group Sales" }
    : has("auto", "vehicle", "dealer", "tire") ? { title: "Fleet or business enquiry", team: "Fleet Sales" }
    : has("retail", "store", "mattress", "blind", "window", "furnish") ? { title: "Bulk or trade order", team: "Trade Sales" }
    : has("senior", "care", "living") ? { title: "Multiple family members", team: "Care Coordination" }
    : has("health", "medical", "clinic", "hospital", "dental") ? { title: "Employer or group health", team: "Group Health" }
    : { title: "Large or multi-site enquiry", team: "Key Accounts" };

  return { where, when, ref, bulk };
}

/**
 * A destination, taken from the prospect's own routing queue.
 *
 * ⚠️ **THE QUEUE NAME IS USED WHOLE.** An earlier version cut it at the first separator, the
 * way the intent NODE titles do, and that is right for a node title and wrong for a team:
 * "Reservation, New Booking" became "Reservation" and "Test Drive" stayed "Test Drive", so the
 * agent announced it was transferring the caller to a booking term rather than to a desk. The
 * qualifier after the comma is the part that makes it read as a queue.
 */
function queueName(name: string | undefined, fallback: string): string {
  return (name ?? "").trim() || fallback;
}

/**
 * The default branches for a prospect, from data it already carries.
 *
 * ⚠️ **DESTINATIONS COME FROM THE PROSPECT'S OWN ROUTING QUEUES** (`voiceRoutingDemo.queues`),
 * which every profile carries and which the diagram used to draw before those nodes became
 * locked chrome. Inventing team names when real ones are sitting in the profile would put
 * words in the prospect's mouth on the one screen that is about their routing.
 */
export function deriveUseCases(profile: CustomerProfile): VoiceUseCases {
  const v = voiceVocab(profile);
  const booking = (profile.bookingTerm || "Reservation").toLowerCase();
  const queues = profile.reports.voiceRoutingDemo?.queues ?? [];
  const newTeam = queueName(queues[0]?.name, `New ${profile.bookingTerm} Team`);
  const supTeam = queueName(queues[1]?.name, `${profile.customerName} Support`);

  return {
    sales: [
      {
        title: `Ready to book now`,
        collect: ["Consumer Name", v.where, v.when],
        route: newTeam,
      },
      {
        title: `Comparing options`,
        /* A researcher will not commit to a date, so asking for one stalls the call. An email
           is the thing worth capturing from someone who is not ready yet. */
        collect: ["Consumer Name", "Consumer Email", v.where],
        route: newTeam,
      },
      {
        title: v.bulk.title,
        collect: ["Consumer Name", "Group Size", v.when],
        route: v.bulk.team,
      },
    ],
    support: [
      {
        title: `Change or reschedule`,
        collect: [v.ref, "Consumer Name"],
        route: supTeam,
      },
      {
        title: `Cancel ${/^[aeiou]/i.test(booking) ? "an" : "a"} ${booking}`,
        collect: [v.ref, "Consumer Name"],
        route: supTeam,
      },
      {
        title: `Billing question`,
        collect: [v.ref, "Consumer Name"],
        route: "Billing",
      },
    ],
  };
}
