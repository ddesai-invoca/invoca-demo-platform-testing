/* knowledgeDocs.ts — the readable "document" behind each Knowledge Sources row.
   -----------------------------------------------------------------------------
   The Knowledge Sources table lists what the agent learned from (a playbook PDF, a few web pages).
   Those rows carry only a NAME, so there was nothing to open. This builds each source's contents
   from the same profile data the agent itself reads (its playbook, rules, Q&A, service area and the
   prospect's own products and locations), so the document and the agent cannot disagree. Pure and
   deterministic: opening one twice shows the same thing, and no model call is made. */
import type { CustomerProfile, KnowledgeSource } from "./schema";

export interface KnowledgeDoc {
  title: string;
  kind: "Document" | "Web Link";
  sections: { heading: string; lines: string[] }[];
  /** The real page, for a web link: opened in a new tab. */
  liveUrl?: string;
}

/** The rows the table shows: the profile's own, else derived from the brand name and domain. */
export function knowledgeSourcesFor(profile: CustomerProfile, configured?: KnowledgeSource[]): KnowledgeSource[] {
  if (configured?.length) return configured;
  const doc = `${profile.customerName.replace(/[^A-Za-z0-9]+/g, "_")}_Sales_Playbook.pdf`;
  const base = `https://www.${profile.brandDomain}`;
  return [
    { name: doc, type: "Document", lastUpdated: "03/11/2026 10:21 AM" },
    { name: base, type: "Web Link", lastUpdated: "03/11/2026 10:02 AM" },
    { name: `${base}/services/`, type: "Web Link", lastUpdated: "03/11/2026 10:02 AM" },
    { name: `${base}/contact/`, type: "Web Link", lastUpdated: "03/11/2026 10:02 AM" },
  ];
}

const words = (s: string) => (s.toLowerCase().match(/[a-z]{4,}/g) ?? []);

export function knowledgeDocFor(profile: CustomerProfile, src: KnowledgeSource): KnowledgeDoc {
  const ac: any = profile.reports.agentConfig ?? {};
  const pb = ac.smsPlaybook;
  const qa: { question: string; answer: string }[] = ac.aiRecommendations?.find((r: any) => r.qaPairs?.length)?.qaPairs ?? [];
  const rules: string[] = ac.brandConversationRules ?? [];
  const base = `https://www.${profile.brandDomain}`;
  const products: string[] = profile.reports.marketingDashboard?.breakdowns
    ?.find((b) => /Product Category/i.test(b.title))?.rows.map((r) => r.name) ?? [];
  const sites: string[] = (profile.reports.opsDashboard?.locationHandling?.rows ?? []).map((r: any) => String(r.cells?.[0] ?? "")).filter(Boolean);
  const area: string = ac.serviceArea ?? "";
  const qaFor = (name: string) => {
    const w = words(name);
    const hits = qa.filter((x) => w.some((t) => (x.question + " " + x.answer).toLowerCase().includes(t)));
    return (hits.length ? hits : qa).slice(0, 8);
  };
  const qaLines = (xs: typeof qa) => xs.flatMap((x) => [`Q: ${x.question}`, `A: ${x.answer}`]);

  if (src.type === "Document") {
    const sections: KnowledgeDoc["sections"] = [
      { heading: "About", lines: [`${profile.customerName} is a ${profile.industry} business. Customers are called ${profile.customerNoun.toLowerCase()}s, and the conversion this playbook drives toward is a ${profile.bookingTerm.toLowerCase()}.`] },
    ];
    if (pb) {
      sections.push({ heading: "Goal of every conversation", lines: [pb.goal, `Book: ${pb.bookingType}.`] });
      if (pb.offer) sections.push({ heading: "Current offer", lines: [pb.offer] });
      if (pb.qualifyingQuestions?.length) sections.push({ heading: "Qualifying questions, in order", lines: pb.qualifyingQuestions.map((q: string, i: number) => `${i + 1}. ${q}`) });
      sections.push({ heading: "Pricing", lines: [pb.providesEstimate ? "A rough price or estimate may be given over text once the needs are known." : "Do not quote prices; offer to book so a specialist can."] });
    }
    if (rules.length) sections.push({ heading: "How we talk to customers", lines: rules });
    if (area) sections.push({ heading: "Where we serve", lines: [area] });
    if (qa.length) sections.push({ heading: "Common questions", lines: qaLines(qa.slice(0, 12)) });
    return { title: src.name, kind: "Document", sections };
  }

  const isUrl = /^https?:\/\//i.test(src.name);
  const lname = src.name.toLowerCase();
  const sections: KnowledgeDoc["sections"] = [];
  if (/area|location|coverage|region|where/.test(lname)) {
    if (area) sections.push({ heading: "Where we serve", lines: [area] });
    if (sites.length) sections.push({ heading: "Locations", lines: sites });
  } else if (/plan|pric|product|service|offer|package|shop|buy|online/.test(lname) && !/availab|check/.test(lname)) {
    if (products.length) sections.push({ heading: "What we offer", lines: products });
    if (pb?.offer) sections.push({ heading: "Current offer", lines: [pb.offer] });
  } else if (/availab|check|contact/.test(lname)) {
    sections.push({ heading: "Get started", lines: [`To check availability or get started, ${profile.customerName} ${pb ? `books an ${pb.bookingType}` : `schedules a ${profile.bookingTerm.toLowerCase()}`}. Have your address ready.`] });
    if (area) sections.push({ heading: "Where we serve", lines: [area] });
  } else {
    sections.push({ heading: "Overview", lines: [`${profile.customerName} is a ${profile.industry} business.`, ...(pb ? [pb.goal] : [])] });
    if (products.length) sections.push({ heading: "What we offer", lines: products });
    if (pb?.offer) sections.push({ heading: "Current offer", lines: [pb.offer] });
  }
  const related = qaFor(src.name);
  if (related.length) sections.push({ heading: "What customers ask about this page", lines: qaLines(related) });
  return { title: isUrl ? src.name : src.name, kind: "Web Link", sections, liveUrl: isUrl ? src.name : base };
}
