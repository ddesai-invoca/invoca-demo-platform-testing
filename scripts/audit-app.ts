/* =============================================================================
   audit-app.ts — OUR OWN chrome: the launch menu and the release notes
   -----------------------------------------------------------------------------
   Everything else in this repo replicates Invoca's product. These two screens are
   the tool's own, and they have their own quiet failure modes:

     • `RELEASES[0]` is assumed to be the NEWEST entry — `LATEST_RELEASE` and the
       "New" chip are both derived from it. Add an entry in the wrong place and the
       chip either never fires again or fires forever, with nothing to notice.
     • the menu is now the ONLY way to reach Support, the admin inbox, the docs and
       the notes. A row that stops rendering does not error, it just goes missing.
     • the three floating pills it replaced were deleted; a stray `.readme-fab` or
       `.corner-stack` left in the markup would render an invisible orphan.
   ============================================================================= */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";

let fail = 0;
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => { console.log(`  FAIL  ${m}`); fail++; };
const read = (p: string) => readFileSync(p, "utf8");
/* Comments stripped before any source match — an audit in this repo has fired on
   its own documentation before, and a check that reddens on correct code gets
   deleted as a nuisance. */
const code = (p: string) => read(p).replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

/* ── release notes ───────────────────────────────────────────────────────── */
console.log("\nRelease notes\n");

const { RELEASES, LATEST_RELEASE, unseenRelease } = await import("../src/data/releaseNotes.ts");

RELEASES.length >= 20
  ? ok(`${RELEASES.length} dated releases`)
  : bad(`only ${RELEASES.length} releases — the backfill looks truncated`);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const badDates = RELEASES.filter((r) => !ISO.test(r.date) || Number.isNaN(+new Date(`${r.date}T12:00:00`)));
badDates.length === 0
  ? ok("every date is a valid ISO date")
  : bad(`invalid date(s): ${badDates.map((r) => r.date).join(", ")}`);

const dates = RELEASES.map((r) => r.date);
new Set(dates).size === dates.length
  ? ok("no duplicate dates")
  : bad("two releases share a date — merge them into one entry");

/* ⚠️ THE ORDERING CHECK IS THE POINT OF THIS FILE. Strictly descending, because
   `RELEASES[0]` IS the newest release everywhere else in the app. */
const sorted = dates.every((d, k) => k === 0 || dates[k - 1] > d);
sorted
  ? ok("releases are strictly newest-first")
  : bad("releases are not newest-first — LATEST_RELEASE and the \"New\" chip both read RELEASES[0]");

LATEST_RELEASE === [...dates].sort().reverse()[0]
  ? ok(`LATEST_RELEASE (${LATEST_RELEASE}) is the newest date`)
  : bad(`LATEST_RELEASE is ${LATEST_RELEASE}, but the newest date is ${[...dates].sort().reverse()[0]}`);

const thin = RELEASES.filter((r) => !r.title?.trim() || !r.changes?.length);
thin.length === 0
  ? ok("every release has a title and at least one change")
  : bad(`empty release(s): ${thin.map((r) => r.date).join(", ")}`);

const KINDS = new Set(["new", "improved", "fixed"]);
const badChanges = RELEASES.flatMap((r) =>
  r.changes.filter((c) => !KINDS.has(c.kind) || !c.text?.trim()).map((c) => `${r.date}: ${c.kind}`));
badChanges.length === 0
  ? ok(`all ${RELEASES.reduce((n, r) => n + r.changes.length, 0)} changes have a valid kind and text`)
  : bad(`malformed change(s): ${badChanges.join(", ")}`);

/* ⚠️ "FROM THE VERY BEGINNING" WAS THE ASK, so the oldest entry is pinned to the
   repo's first commit. Without this, trimming the list to "the recent stuff"
   silently rewrites what the page claims to be. Skipped where git is unavailable
   (a build container), rather than failing for the wrong reason. */
let firstCommit = "";
try { firstCommit = execSync("git log --reverse --format=%ad --date=short", { encoding: "utf8" }).split("\n")[0].trim(); }
catch { /* no git here */ }
if (!firstCommit) console.log("  note  git unavailable — skipping the first-commit check");
else {
  const oldest = [...dates].sort()[0];
  oldest === firstCommit
    ? ok(`the oldest entry (${oldest}) is the repo's first commit`)
    : bad(`oldest entry is ${oldest} but the first commit is ${firstCommit} — the history no longer starts at the beginning`);
}

/* ⚠️⚠️ NO ENTRY MAY NAME A PROSPECT. Release notes are product-wide by request
   (9/10/2026): an entry has to be true for anyone using the tool, whichever demo
   they open, so the capability belongs here and the instance built on one demo
   does not. The name list is DERIVED from the profiles and demos actually on
   disk rather than hardcoded, so it covers prospects added later — a note
   written next month naming a demo generated next month still fails.

   ⚠️ THIS CHECKS THE NAME, NOT THE SCOPE, and the difference is the real trap.
   Three entries were pulled from the backfill that named nobody and were still
   about one demo (a dashboard gated to a single prospect; a report that shipped
   for one account before it was derived for all). No static check can see that;
   the rule is in the data file's header for whoever writes the next entry. */
const prospectNames = new Set<string>();
for (const dir of ["src/data/generated", "engine/event-seeds"]) {
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const name = JSON.parse(read(`${dir}/${file}`))?.customerName;
      if (typeof name === "string" && name.trim()) prospectNames.add(name.trim());
    } catch { /* a malformed profile is another audit's problem */ }
  }
}
/* Local demos too when they are there — git-ignored, so absent on a fresh clone
   and in a build container. Their absence must not weaken the check silently,
   which is why the count is printed. */
if (existsSync(".data/demos")) {
  for (const file of readdirSync(".data/demos").filter((f) => f.endsWith(".json"))) {
    try {
      const rec = JSON.parse(read(`.data/demos/${file}`));
      const name = rec?.prospect ?? rec?.profile?.customerName;
      if (typeof name === "string" && name.trim()) prospectNames.add(name.trim());
    } catch { /* skip */ }
  }
}
prospectNames.add("Shady Blinds");   // the code-defined seed, not a JSON file

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const named: string[] = [];
for (const r of RELEASES) {
  for (const [where, text] of [["title", r.title] as const, ...r.changes.map((c, k) => [`change ${k + 1}`, c.text] as const)]) {
    for (const name of prospectNames) {
      if (new RegExp(`\\b${esc(name)}\\b`, "i").test(text)) named.push(`${r.date} ${where} names "${name}"`);
    }
  }
}
named.length === 0
  ? ok(`no entry names any of the ${prospectNames.size} known prospects`)
  : bad(`prospect-specific entr${named.length === 1 ? "y" : "ies"}:\n        ${named.join("\n        ")}`);

/* The chip must be derivable at all — `unseenRelease` reads localStorage, which
   does not exist under node, so it has to survive that rather than throw on a
   screen the launch page renders. */
try {
  typeof unseenRelease() === "boolean"
    ? ok("unseenRelease() survives having no localStorage (returns a boolean)")
    : bad("unseenRelease() did not return a boolean");
} catch (e) {
  bad(`unseenRelease() threw without localStorage: ${(e as Error).message}`);
}

/* ── the launch menu ─────────────────────────────────────────────────────── */
console.log("\nLaunch menu\n");

const app = code("src/App.tsx");
const menu = code("src/components/LaunchMenu.tsx");
const modal = code("src/components/SupportModal.tsx");

/\bLaunchMenu\b/.test(app)
  ? ok("App renders the launch menu")
  : bad("App no longer renders LaunchMenu");

for (const [route, label] of [["/release-notes", "release notes"], ["/feedback", "the feedback board"]] as const) {
  new RegExp(`path="${route}"`).test(app)
    ? ok(`${label} route is registered`)
    : bad(`${label} route (${route}) is missing`);
  new RegExp(`MENU_ON[^;]*"${route}"`).test(app)
    ? ok(`the menu renders on ${route}`)
    : bad(`${route} is not in MENU_ON, so the menu vanishes there`);
}

/* ⚠️ THE ROUTE GATING IS AN ALLOW-LIST, and it must stay one: a deny-list means a
   new replica screen carries our chrome by default. */
/const MENU_ON = \[/.test(app) && /MENU_ON\.includes\(pathname\)/.test(app)
  ? ok("the menu is gated by an allow-list, not a deny-list")
  : bad("MENU_ON is no longer an allow-list checked with .includes");

const rows = ["support", "inbox", "releases", "readme"];
const missing = rows.filter((k) => !new RegExp(`key: "${k}"`).test(menu));
missing.length === 0
  ? ok(`all four rows present (${rows.join(", ")})`)
  : bad(`menu row(s) missing: ${missing.join(", ")}`);

/* ⚠️⚠️ THE MODAL MUST BE A SIBLING OF THE PANEL, NOT INSIDE IT. Selecting a row
   closes the menu, which unmounts the panel — a modal rendered in there is
   destroyed by the click that opened it. Asserted structurally: the SupportModal
   element must appear AFTER the panel's closing markup. */
const panelEnd = menu.lastIndexOf("</div>");
const modalAt = menu.indexOf("<SupportModal");
modalAt > 0 && modalAt > menu.indexOf('className="lm-panel"')
  && !menu.slice(menu.indexOf('className="lm-panel"'), panelEnd).includes("<SupportModal")
  ? ok("SupportModal is rendered outside the menu panel")
  : bad("SupportModal is inside the panel — closing the menu would unmount it mid-open");

/\{\s*open,\s*onClose\s*\}/.test(modal) && !/useState\(false\)[^\n]*\/\/?\s*open/.test(modal)
  ? ok("SupportModal is controlled by its parent")
  : bad("SupportModal is no longer controlled — the menu could not open it");
!/className="fb-fab"/.test(modal)
  ? ok("SupportModal carries no trigger button of its own")
  : bad("SupportModal still renders the old .fb-fab pill");

/* ⚠️ CAPTURE PHASE. On bubble the hamburger closes the panel and its own onClick
   reopens it, so the trigger can never dismiss the menu — documented twice
   already in this repo (the Signal flyout, the Create Workflow combobox). */
/addEventListener\("pointerdown",\s*onDown,\s*true\)/.test(menu)
  ? ok("outside-click uses pointerdown in the capture phase")
  : bad("the outside-click listener is not capture-phase pointerdown");
/e\.key === "Escape"/.test(menu) && /ArrowDown/.test(menu)
  ? ok("Escape closes and arrow keys move through the rows")
  : bad("keyboard handling (Escape / arrows) is missing");

/* The three deleted pills must not reappear anywhere in the app's own source. */
const deadClasses = ["corner-stack", "readme-fab", "inbox-fab", "fb-fab"];
const cssText = read("src/styles/app.css");
const cssDead = deadClasses.filter((c) => new RegExp(`^\\.${c}[\\s:,{]`, "m").test(cssText));
cssDead.length === 0
  ? ok("no CSS rules left for the three replaced pills")
  : bad(`dead CSS still defined: ${cssDead.join(", ")}`);

/* z-order: the menu must sit UNDER the Support overlay and the env badge, or it
   competes with a modal it opened. Read from the stylesheet, not assumed. */
const zOf = (sel: string) => {
  const m = new RegExp(`\\.${sel}\\s*\\{[^}]*z-index:\\s*(\\d+)`, "m").exec(cssText);
  return m ? Number(m[1]) : NaN;
};
const [zMenu, zOverlay, zBadge] = [zOf("lm-root"), zOf("fb-overlay"), zOf("envbadge")];
zMenu < zOverlay && zMenu < zBadge
  ? ok(`z-order holds: menu ${zMenu} < support overlay ${zOverlay} < env badge ${zBadge}`)
  : bad(`z-order wrong: menu ${zMenu}, support overlay ${zOverlay}, env badge ${zBadge}`);

existsSync("src/components/ReadmeButton.tsx") || existsSync("src/components/InboxButton.tsx")
  ? bad("a replaced pill component is back on disk — it should be a menu row, not a button")
  : ok("the replaced pill components are gone, not merely unmounted");

/* ── the feedback notification ───────────────────────────────────────────── */
console.log("\nFeedback notification\n");

/* ⚠️⚠️ WHY THIS SECTION EXISTS. Until 9/10/2026 the only mail this app sent was
   the COMPLETION notice, to the SUBMITTER. Nothing told the maintainer anything,
   so the sole signal that feedback had arrived was the Inbox badge on the LIVE
   launch screen — per-instance, so working on localhost showed the local store's
   count instead. Three colleagues' reports sat In review for over two weeks.
   A notification that silently stops is indistinguishable from nobody writing
   in, which is exactly the failure that has to stay checked. */
const { newItemEmail: newMail } = await import("../engine/mailer.ts");
const { adminEmails } = await import("../engine/demoApi.ts");

adminEmails().length > 0
  ? ok(`${adminEmails().length} admin address(es) to notify`)
  : bad("no admin addresses — a new submission would notify nobody");

const sample = newMail({
  to: "admin@invoca.com", kind: "feedback", title: "A title", body: "Line one.\nLine two.",
  submitterName: "Jane Doe", submitterEmail: "jane@invoca.com",
  page: "/launch", boardUrl: "https://example.com/feedback",
});
sample.subject === "Feedback: A title"
  ? ok("the subject carries the kind and the title")
  : bad(`unexpected subject: ${sample.subject}`);
newMail({ ...{ to: "a", kind: "feature", title: "T", body: "b", submitterName: "n", submitterEmail: "e", boardUrl: "u" } }).subject === "Feature request: T"
  ? ok("a feature request says so in the subject")
  : bad("the feature-request subject is wrong");
/* ⚠️ REPLY GOES TO THE SUBMITTER. This app sends FROM the maintainer's own
   address, so without an explicit Reply-To, hitting Reply mails yourself. */
sample.replyTo === "jane@invoca.com"
  ? ok("Reply-To is the submitter, not the sending account")
  : bad(`Reply-To is ${sample.replyTo} — replying would not reach the submitter`);
sample.text.includes("Line one.") && sample.text.includes("Line two.")
  ? ok("the full body is in the email, so it is readable without opening the board")
  : bad("the submission body is missing from the email");
sample.text.includes("https://example.com/feedback")
  ? ok("the email links the board")
  : bad("the email does not link the board");
/* Submission text is user input rendered into HTML mail. */
!/<script/i.test(newMail({
  to: "a", kind: "feedback", title: "<script>alert(1)</script>", body: "<script>alert(2)</script>",
  submitterName: "<script>3</script>", submitterEmail: "e", boardUrl: "u",
}).html ?? "")
  ? ok("title, body and name are HTML-escaped in the email")
  : bad("submission text reaches the email's HTML unescaped");

/* Both transports must honour it, or the header is set and dropped. */
const mailerSrc = code("engine/mailer.ts");
/Reply-To: \$\{mail\.replyTo \|\|/.test(mailerSrc) && /replyTo: mail\.replyTo \|\|/.test(mailerSrc)
  ? ok("both the Gmail and SMTP paths honour mail.replyTo")
  : bad("one transport ignores mail.replyTo, so Reply-To depends on which route sends");

const fbSrc = code("engine/feedbackApi.ts");
/newItemEmail\(/.test(fbSrc)
  ? ok("the POST path sends the new-item notice")
  : bad("a new submission notifies nobody — the defect this section exists for");
/await sendMail\(newItemEmail\(/.test(fbSrc)
  ? ok("the send is awaited, so the SIGTERM drain cannot kill it mid-deploy")
  : bad("the notification is fire-and-forget and can be dropped by a deploy");
/* ⚠️ NEVER MAIL THE SUBMITTER THEIR OWN ITEM — the maintainer files most of the
   feature requests, and an inbox of your own notes trains you to ignore it. */
/adminEmails\(\)\.filter\(/.test(fbSrc) && /!==\s*\(user\.email/.test(fbSrc)
  ? ok("the submitter is excluded from their own notification")
  : bad("the submitter would be emailed about their own submission");
/* The item is saved before the mail, so a mail failure cannot lose a submission. */
fbSrc.indexOf("saveFeedback(rec)") < fbSrc.indexOf("newItemEmail(")
  ? ok("the item is saved before the notice is attempted")
  : bad("the notice is attempted before the item is saved — a mail failure could lose it");

/* ---- the completion comment goes out WITH the email -------------------------
   Asked for directly (9/16/2026): "allow me to add a comment when i change status of
   any Feedback & feature requests to complete before the email gets send out, and the
   email includes the comment."

   ⚠️⚠️ **THE ORDERING IS THE WHOLE CORRECTNESS ARGUMENT, and it is one line apart in
   the handler.** `rec.note` is assigned from the request body BEFORE the terminal-status
   block builds the mail, so the comment and the email are one atomic PATCH. Move the
   note assignment below that block and the feature still "works" — the comment saves,
   the board shows it, the status changes — and the email goes out WITHOUT it, every
   time, silently. That is the only way this can break, so it is what these checks pin. */
console.log("\nThe completion comment reaches the email");
{
  const api = code("engine/feedbackApi.ts");
  const iNote = api.indexOf("rec.note = body.note");
  const iMail = api.indexOf("completionEmail(");
  iNote > 0 && iMail > 0 && iNote < iMail
    ? ok("the note is stored BEFORE the completion email is built")
    : bad("the note is assigned after the mail is built — the email would go out without the comment");

  /* One field, not two. The plumbing already existed end to end; a second
     `completionComment` would have duplicated a working path. */
  /note: rec\.note/.test(api)
    ? ok("and that same note is what the email is handed")
    : bad("completionEmail is no longer given rec.note");

  const mail = read("engine/mailer.ts");
  /\.\.\.\(opts\.note \? \[``, opts\.note\] : \[\]\)/.test(mail)
    ? ok("the text body includes it, and omits the line entirely when it is blank")
    : bad("the plain-text email no longer carries the note");
  /opts\.note \? `<br><span[^`]*\$\{esc\(opts\.note\)\}/.test(mail)
    ? ok("the HTML body includes it, escaped")
    : bad("the HTML email no longer carries the note, or stopped escaping it");

  const board = code("src/screens/FeedbackBoard.tsx");
  /if \(next === "Complete" && !i\.notifiedAt( && i\.kind !== "callback")?\)/.test(board)
    ? ok("picking Complete opens the composer instead of saving straight through")
    : bad("the board no longer asks for a comment when completing");
  /* ⚠️ Already-notified items must NOT offer a comment: no second email is sent, so the
     panel would be promising something that cannot happen. */
  /!i\.notifiedAt/.test(board)
    ? ok("but not for an item whose submitter has already been emailed")
    : bad("it would offer a comment on an item that will send no email");
  /JSON\.stringify\(note === undefined \? \{ status \} : \{ status, note \}\)/.test(board)
    ? ok("every other status change omits `note`, so an existing one is never wiped")
    : bad("the board may send note: \"\" on an unrelated status change and erase a comment");
  /* The panel must not promise an email on a server that has no mailer — all three
     lines (label, button, hint) branch on `emailEnabled`. The hint did not, at first. */
  (board.match(/emailEnabled/g) || []).length >= 4
    ? ok("its copy honours whether email is actually configured")
    : bad("some of the composer's copy promises an email regardless of configuration");
}

console.log(fail ? `\n${fail} check(s) failed\n` : "\nAll app-chrome checks passed\n");
process.exit(fail ? 1 : 0);
