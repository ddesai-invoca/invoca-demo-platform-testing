/* =============================================================================
   brandCheck — a cheap pre-flight on the Launch form's name + website, run BEFORE
   the ~4-minute build starts.

   Why it exists: the build trusts the URL. A one-letter typo ("halstedplumbing.com"
   for "Halstead Plumbing") is usually still a REAL site, so nothing fails: the
   demo is built around the wrong domain, and the brand-logo lookup happily returns
   that other company's (here, solid white) favicon, which renders as a blank tile.
   By then the SE has waited minutes and shipped a demo with the wrong brand data.

   This only ever WARNS. Bot-blocked and slow sites are normal, so the Launch form
   shows the findings and lets the SE continue anyway; it never blocks a build.
   `compareBrand` is pure so scripts/audit-brand-check.ts can pin it offline.
   ============================================================================= */
import dns from "node:dns/promises";
import net from "node:net";

export type BrandWarning = { code: "unreachable" | "name-mismatch" | "likely-typo" | "bad-url"; message: string };
export type BrandCheckResult = {
  ok: boolean;
  warnings: BrandWarning[];
  /** Hostname the URL really lands on after redirects, e.g. "halstedplumbing.com". */
  resolvedDomain?: string;
  /** What the site calls itself (og:site_name or <title>), so the SE can eyeball it. */
  siteName?: string;
};

/* Words that say what a business DOES, not who it IS. A name whose only words are
   these has nothing distinctive to match, so the name check is skipped for it. */
const GENERIC = new Set([
  "the", "and", "inc", "llc", "ltd", "corp", "company", "co", "group", "services", "service",
  "solutions", "plumbing", "heating", "cooling", "hvac", "air", "electric", "electrical",
  "roofing", "construction", "contractors", "contracting", "restoration", "cleaning",
  "law", "legal", "firm", "attorneys", "dental", "health", "healthcare", "medical",
  "insurance", "home", "homes", "auto", "automotive", "repair", "pest", "control",
  "realty", "financial", "bank", "care", "center", "centre", "clinic", "of", "for",
]);

const words = (s: string) =>
  s.toLowerCase().replace(/['’]s\b/g, "").normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

export function distinctiveTokens(name: string): string[] {
  return words(name).filter((w) => w.length >= 3 && !GENERIC.has(w));
}

/* Plain Levenshtein: tokens are short, so no optimisation needed. */
function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/* Is `token` (a word from the prospect name) in `haystack`, or within one edit of a
   same-length window of it? The second half is how a typo gets caught and named. */
function nearMiss(token: string, haystack: string): boolean {
  if (token.length < 5) return false;
  for (const len of [token.length - 1, token.length, token.length + 1])
    for (let i = 0; i + len <= haystack.length; i++)
      if (lev(token, haystack.slice(i, i + len)) === 1) return true;
  return false;
}

/** Compare the prospect name against what the site says about itself. */
export function compareBrand(name: string, host: string, siteText: string): BrandWarning[] {
  const tokens = distinctiveTokens(name);
  if (!tokens.length) return [];
  const hostBare = host.toLowerCase().replace(/^www\./, "").replace(/\.[a-z.]+$/, "");
  const hay = words(`${hostBare} ${siteText}`).join("");
  /* A token also counts if it is a possessive/plural of something on the page
     ("halsteads" vs "Halstead's"): words() strips 's but the compact haystack keeps it. */
  const hit = (t: string) => hay.includes(t) || (t.endsWith("s") && hay.includes(t.slice(0, -1)));
  if (tokens.some(hit)) return [];
  const typo = tokens.find((t) => nearMiss(t, hay));
  const shown = siteText.trim() ? `"${siteText.trim().slice(0, 80)}"` : host;
  return typo
    ? [{ code: "likely-typo", message: `"${typo}" is almost, but not exactly, what ${host} says it is (${shown}). The website or the name may have a typo.` }]
    : [{ code: "name-mismatch", message: `${host} doesn't mention "${tokens.join(" ")}" (it says ${shown}). Is this the right website?` }];
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) return ip === "::1" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

const decode = (t: string) =>
  t.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#8217;/g, "\u2019").replace(/&nbsp;/g, " ");

const meta = (html: string, prop: string) =>
  html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i"))?.[1]
  ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i"))?.[1];

export async function brandCheck(name: string, rawUrl: string): Promise<BrandCheckResult> {
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`); }
  catch { return { ok: false, warnings: [{ code: "bad-url", message: "That doesn't look like a valid website address." }] }; }

  /* The server fetches whatever the user typed, so keep it off internal addresses. */
  try {
    const addrs = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address)))
      return { ok: false, warnings: [{ code: "bad-url", message: "That address isn't a public website." }] };
  } catch {
    return { ok: false, warnings: [{ code: "unreachable", message: `${url.hostname} doesn't exist (no DNS record). Check the spelling of the website.` }] };
  }

  let html = "";
  let finalHost = url.hostname;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; InvocaDemoBrandCheck/1.0)", Accept: "text/html" },
    });
    finalHost = new URL(res.url).hostname;
    if (!res.ok) throw new Error(String(res.status));
    html = (await res.text()).slice(0, 300_000);
  } catch {
    /* Bot walls and slow sites are common; say so softly and let the SE decide. */
    return {
      ok: false, resolvedDomain: finalHost.replace(/^www\./, ""),
      warnings: [{ code: "unreachable", message: `Couldn't open ${url.hostname} to confirm it matches "${name}". It may block automated checks. Double-check the address.` }],
    };
  }

  const siteName = decode(meta(html, "og:site_name") || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "").replace(/<[^>]+>/g, " ");
  const warnings = compareBrand(name, finalHost, `${siteName} ${meta(html, "og:title") ?? ""} ${h1}`);
  return { ok: warnings.length === 0, warnings, resolvedDomain: finalHost.replace(/^www\./, ""), siteName };
}
