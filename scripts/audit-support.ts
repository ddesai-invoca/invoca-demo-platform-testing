/* audit-support.ts — the customer Support agent: playbook, prompt, and the guards around them.
   No network and no key: the model call is not exercised, only what surrounds it (the deterministic
   fallback, the fields the model is never allowed to choose, and what the prompt tells the agent). */
import fs from "node:fs";
import path from "node:path";
import { ExtraWorkflow, SupportPlaybook } from "../src/data/schema.ts";
import {
  demoCustomerName, demoDirectLine, fallbackSupportPlaybook, supportBrain, supportWorkflows, SUPPORT_BRAIN_KEYS,
} from "../src/data/supportPlaybook.ts";
import { finalizePlaybook, profileDigest } from "../engine/supportGen.ts";
import { smsSystemPromptForAudit, voiceSystemPrompt } from "../engine/chat.ts";
import { SUPPORT_LINES } from "../engine/supportPrompt.ts";

let bad = 0;
const ok = (c: boolean, msg: string) => { if (!c) { bad++; console.log("FAIL", msg); } else console.log("ok  ", msg); };
const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const dir = path.resolve("src/data/generated");
const profiles = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
ok(profiles.length >= 10, `read ${profiles.length} real profiles`);

let allValid = true, all555 = true, allNamed = true, allBranches = true, allWfValid = true, digestOk = true;
for (const p of profiles) {
  const pb = fallbackSupportPlaybook(p);
  if (!SupportPlaybook.safeParse(pb).success) { allValid = false; console.log("   invalid playbook:", p.id); }
  if (!/^\(\d{3}\) 555-01\d\d$/.test(pb.escalation.directLine)) { all555 = false; console.log("   bad line:", p.id, pb.escalation.directLine); }
  if (pb.customer.name !== demoCustomerName(p)) allNamed = false;
  const wfs = supportWorkflows(p, pb);
  if (wfs.length !== 2 || wfs.some((w) => w.branches.length !== pb.scenarios.length + 1)) allBranches = false;
  if (wfs.some((w) => !ExtraWorkflow.safeParse(w).success)) { allWfValid = false; console.log("   invalid workflow:", p.id); }
  if (!profileDigest(p).includes(p.customerName)) digestOk = false;
}
ok(allValid, "the fallback playbook is valid for every real profile");
ok(all555, "the direct line is a reserved 555-01xx number for every profile");
ok(allNamed, "the invented customer is the person the rest of the demo already names");
ok(allBranches && allWfValid, "each profile yields an SMS and a Voice workflow that validate, one branch per scenario plus escalation");
ok(digestOk, "the digest the model reads always names the business");

/* prompts */
const p0 = profiles.find((x) => x.id === "aptive") ?? profiles[0];
const pb = fallbackSupportPlaybook(p0);
const sms = smsSystemPromptForAudit(supportBrain(p0, pb, "sms") as any);
const voice = voiceSystemPrompt(supportBrain(p0, pb, "voice") as any);
for (const [name, t] of [["SMS", sms], ["voice", voice]] as const) {
  ok(/CONTAINMENT/.test(t) && /solve it yourself/.test(t), `${name}: told to contain, not hand off`);
  ok(/do not know yet/i.test(t) && /Do NOT assume they are an existing customer/.test(t) && !/EXISTING customer who needs help/.test(t), `${name}: does not assume an existing customer with a problem`);
  ok(/use only once it is an account matter/.test(t), `${name}: the account record is used only once it is an account matter`);
  ok(t.includes(pb.escalation.directLine) && /live agent/i.test(t) && /callback/i.test(t), `${name}: offers a person, a callback and the direct line`);
  ok(t.includes(SUPPORT_LINES.live) && t.includes(SUPPORT_LINES.callback), `${name}: has the exact lines a reader can detect an escalation by`);
  ok(pb.scenarios.every((s) => t.includes(s.title.toUpperCase()) && t.includes(s.lookup)), `${name}: carries every scenario and its invented lookup`);
  ok(t.includes(pb.customer.name) && pb.customer.summary.every((x) => t.includes(x)), `${name}: carries the whole account record`);
  const supportHalf = t.split("THE SUPPORT PATH.")[1] ?? "";
  ok(supportHalf.length > 500 && !/ONLY job is to QUALIFY/.test(supportHalf) && !/do NOT sell, quote prices, or resolve/.test(supportHalf) && !/never attempt to resolve/i.test(supportHalf), `${name}: the support path has no routing-only language that would forbid resolving`);
  ok(/EVERY NEW OPPORTUNITY IS SERVICEABLE/.test(t) && /EXISTING CUSTOMERS ON THE SALES PATH/.test(t) && !/we do not serve|outside our service area|out-of-area/i.test((t.split("SALES INSTRUCTIONS START")[1] ?? "").split("SALES INSTRUCTIONS END")[0]), `${name}: new prospects are always serviceable (no area gate in the sales path), and existing customers can be handled or handed to support`);
  ok(/TWO kinds of conversation/.test(t) && /=== SALES INSTRUCTIONS START ===/.test(t) && t.indexOf("SALES INSTRUCTIONS START") < t.indexOf("THE SUPPORT PATH."), `${name}: a two-path agent, sales instructions first and the support path after`);
  ok(/ignore that: your opening is described at the end/.test(t) && !/Thanks for calling .* support\./.test(t), `${name}: one opening for both paths, not the sales agent's own`);
  ok(/IF THEY ASK FOR A PERSON, A MANAGER OR A CALLBACK, DO IT AT ONCE/.test(t) && /NEVER ask what the problem is/.test(t), `${name}: never makes someone justify wanting a person`);
  ok(/never contradict/i.test(t) && /sample data/i.test(t), `${name}: honest about being a demo if sincerely asked`);
}
ok(/SPOKEN call/.test(voice) && /digit by digit/.test(voice) && !/FORMAT \(always\)/.test(voice), "voice: spoken style, number read digit by digit, no SMS formatting rules");
ok(/FORMAT \(always\)/.test(sms) && !/digit by digit/.test(sms), "SMS: text formatting rules, no spoken-only instructions");
ok(/OPEN with exactly this line/.test(voice) && /OPEN with exactly this message/.test(sms), "each channel opens with its own scripted line");

/* precedence: support wins over every other prompt-selecting field */
const forced = smsSystemPromptForAudit({ ...(supportBrain(p0, pb, "sms") as any), customSystem: "SALES PLAYBOOK", voiceMinimal: true, voiceBooking: true });
ok(/CONTAINMENT/.test(forced) && !/SALES PLAYBOOK/.test(forced), "a support brain beats customSystem, minimal and booking flows");
ok(!/CONTAINMENT/.test(smsSystemPromptForAudit({ customerName: "X", industry: "Y" } as any)), "a brain without a playbook is unchanged");

/* what the model is not allowed to choose */
const hostile: any = {
  customer: { name: "Attacker", account: "A—1", summary: ["one — two"] },
  systems: ["Billing"],
  scenarios: Array.from({ length: 9 }, () => ({ id: "Same ID!!", title: "Billing — question", whoCalls: "x", opener: "y", lookup: "z", resolve: ["a"], escalateWhen: ["b"] })),
  escalation: { directLine: "(212) 555-1234", hours: "H".repeat(400), callbackWindow: "soon" },
};
const fin = finalizePlaybook(hostile, p0);
ok(fin.escalation.directLine === demoDirectLine(p0) && /555-01\d\d/.test(fin.escalation.directLine), "a model-chosen phone number is replaced with the reserved demo line");
ok(fin.customer.name === demoCustomerName(p0), "a model-chosen customer name is replaced");
ok(fin.scenarios.length === 6 && new Set(fin.scenarios.map((s) => s.id)).size === 6, "scenarios are capped and ids made unique");
ok(!/[—–]/.test(JSON.stringify(fin)) && fin.escalation.hours.length <= 140, "dashes are swept and free text is bounded");

/* share integration */
const share = await import("../engine/share.ts");
const brains = share.cleanBrains({
  [SUPPORT_BRAIN_KEYS.sms]: { brain: supportBrain(p0, pb, "sms"), greeting: "Hi" },
  [SUPPORT_BRAIN_KEYS.voice]: { brain: supportBrain(p0, pb, "voice"), greeting: "Hi" },
});
ok(typeof brains !== "string" && /voice/.test(SUPPORT_BRAIN_KEYS.voice), "the support brains are accepted as share snapshots, and the voice key routes as voice");

/* wiring */
const chat = read("engine/chat.ts");
ok(chat.indexOf("supportSystemPrompt(") > 0 && chat.indexOf("supportSystemPrompt(") < chat.indexOf("brain.customSystem"), "chat.ts checks for a support playbook before any other prompt");
ok(!/supportGen/.test(read("engine/core.ts")), "generation is NOT a phase of generateProfile (the 5 minute budget stays untouched)");
ok(/wf\?\.support/.test(read("src/data/smsBrain.ts")) && /opts\?\.support\?\.playbook/.test(read("src/data/voiceSession.ts")), "the SMS and voice brain builders pass the playbook through");
ok(/finalizePlaybook\(raw, profile\)/.test(read("engine/supportGen.ts")) && /source: "fallback"/.test(read("engine/supportGen.ts")), "the generator always finalizes, and falls back instead of failing");

console.log(bad ? `\n${bad} FAILED` : "\nall support checks ok");
process.exit(bad ? 1 : 0);
