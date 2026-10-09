/* support-sim.ts — generate a customer Support playbook for a bundled profile and talk to it.

   npx tsx scripts/support-sim.ts <slug> [--fallback] [--json]

   Prints the scenarios, then runs three scripted SMS conversations through the REAL /api/chat
   code path (chatReply + the support prompt), so what an SE will hear is what is judged here:
   an issue the agent should CONTAIN, an issue that should ESCALATE, and an upset customer who
   should be offered a person straight away. Costs a few cents of model time. */
import fs from "node:fs";
import path from "node:path";
import { generateSupportPlaybook } from "../engine/supportGen.ts";
import { chatReply, voiceSystemPrompt } from "../engine/chat.ts";
import { fallbackSupportPlaybook, supportBrain } from "../src/data/supportPlaybook.ts";

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith("--"))!;
const profile = JSON.parse(fs.readFileSync(path.resolve("src/data/generated", `${slug}.json`), "utf8"));
const apiKey = process.env.ANTHROPIC_API_KEY;

const t0 = Date.now();
const cacheFile = path.join(process.env.TMPDIR || "/tmp", `support-sim-${slug}.json`);
const gen = args.includes("--reuse") && fs.existsSync(cacheFile)
  ? { playbook: JSON.parse(fs.readFileSync(cacheFile, "utf8")), source: "model" as const, error: "cached" }
  : args.includes("--fallback")
  ? { playbook: fallbackSupportPlaybook(profile), source: "fallback" as const, error: "forced" }
  : await generateSupportPlaybook(profile, apiKey);
if (gen.source === "model" && gen.error !== "cached") fs.writeFileSync(cacheFile, JSON.stringify(gen.playbook));
console.log(`\n=== ${profile.customerName} — ${gen.source} in ${((Date.now() - t0) / 1000).toFixed(0)}s${gen.error ? ` (${gen.error})` : ""} ===`);
const pb = gen.playbook;
if (args.includes("--json")) console.log(JSON.stringify(pb, null, 2));
console.log(`Customer: ${pb.customer.name} | ${pb.customer.account}`);
pb.customer.summary.forEach((x) => console.log(`   · ${x}`));
console.log(`Systems: ${pb.systems.join(", ")}`);
for (const s of pb.scenarios) {
  console.log(`\n▸ ${s.title}  (${s.whoCalls})`);
  console.log(`   customer says: "${s.opener}"`);
  console.log(`   agent pulls up: ${s.lookup}`);
  s.resolve.forEach((r, i) => console.log(`   ${i + 1}. ${r}`));
  console.log(`   escalate if: ${s.escalateWhen.join(" / ")}`);
}
console.log(`\nEscalation: ${pb.escalation.directLine} | ${pb.escalation.hours} | callback ${pb.escalation.callbackWindow}`);

const brain: any = supportBrain(profile, pb, "sms");
async function talk(title: string, lines: string[]) {
  console.log(`\n--- SMS: ${title} ---`);
  const msgs: { role: "user" | "assistant"; content: string }[] = [];
  const open = await chatReply(brain, [], apiKey, { voice: false });
  console.log(`AGENT: ${open}`); msgs.push({ role: "user", content: "(conversation started)" } as any); msgs.length = 0;
  let last = open;
  const history: { role: "user" | "assistant"; content: string }[] = [{ role: "assistant", content: open }];
  for (const l of lines) {
    console.log(`CUSTOMER: ${l}`);
    history.push({ role: "user", content: l });
    last = await chatReply(brain, history, apiKey, { voice: false });
    console.log(`AGENT: ${last}`);
    history.push({ role: "assistant", content: last });
  }
}
if (!args.includes("--no-chat")) {
  const s = pb.scenarios;
  const want = (args.find((a) => a.startsWith("--chats="))?.slice(8) ?? "contain,escalate,upset,callback,live").split(",");
  if (want.includes("contain")) await talk(`contain: ${s[0].title}`, [s[0].opener, "Ok that makes sense, thanks."]);
  if (want.includes("escalate")) await talk(`escalate: ${s[1].title}`, [s[1].opener, "No, I'm done with you guys, I want to talk to a person."]);
  if (want.includes("upset")) await talk("upset customer", ["This is the third time this has gone wrong and I'm really frustrated.", "Can someone call me back?", "Sure, my number is 555-0134, tomorrow morning is best."]);
  if (want.includes("callback")) await talk("asks for a callback outright", ["I have a complicated billing problem, can I get a call back?", "555-0134, tomorrow around 10"]);
  if (want.includes("live")) await talk("wants a person now", ["I want to speak to a human right now."]);
}
const v = voiceSystemPrompt(supportBrain(profile, pb, "voice") as any);
console.log(`\n(voice prompt built: ${v.length} chars; routes-only language present: ${/ONLY job is to QUALIFY and ROUTE/.test(v)})`);
