/* Local fixture for trying the customer entry: one demo, shared, in whatever DATA_DIR is set.
   Usage: DATA_DIR=... npx tsx scripts/seed-customer-fixture.mts <profile-slug> */
import fs from "node:fs";
import { saveDemo } from "../engine/demoStore.ts";
import { buildShare, saveShare, derivePassword } from "../engine/share.ts";
import { fallbackSupportPlaybook, supportWorkflows, supportBrain, SUPPORT_BRAIN_KEYS } from "../src/data/supportPlaybook.ts";

const slug = process.argv[2] ?? "orlando-health";
const profile: any = JSON.parse(fs.readFileSync(`src/data/generated/${slug}.json`, "utf8"));
const pb = fallbackSupportPlaybook(profile);
profile.reports.extraWorkflows = [...(profile.reports.extraWorkflows ?? []), ...supportWorkflows(profile, pb)];
const creator = { email: "local@dev", name: "Local Dev" };
const now = new Date().toISOString();
let rec: any = saveDemo({ id: profile.id, prospect: profile.customerName, websiteUrl: "https://example.com", industry: profile.industry, creator, createdAt: now, updatedAt: now, profile, customizations: { overrides: {}, tiles: {} } } as any);
const share = buildShare(rec, creator, { brains: {
  [SUPPORT_BRAIN_KEYS.sms]: { brain: supportBrain(profile, pb, "sms"), greeting: "Hi" } as any,
  [SUPPORT_BRAIN_KEYS.voice]: { brain: supportBrain(profile, pb, "voice"), greeting: "Hello" } as any,
} });
saveShare(rec, share);
console.log(JSON.stringify({ id: rec.id, slug: share.slug, password: derivePassword(rec.prospect) }));
