/* =============================================================================
   feedbackStore.ts — where feedback and feature requests live
   -----------------------------------------------------------------------------
   One JSON file per item under DATA_DIR/feedback/<id>.json, written atomically
   (temp file then rename), exactly like demoStore. Same disk, so it inherits the
   Render persistent mount and needs no new infrastructure.

   Deliberately not a database. The volume is a handful of items a week from one
   team; a directory of JSON is inspectable with `cat`, survives a deploy, and
   costs nothing to operate.
   ============================================================================= */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./demoStore.ts";

const FEEDBACK_DIR = path.join(DATA_DIR, "feedback");
const FILES_DIR = path.join(DATA_DIR, "feedback-files");

/* WHAT MAY BE UPLOADED.

   A screenshot is the single most useful thing someone can attach to "this looks
   wrong", so images lead the list. Everything else is capped and stored, never
   executed: see readAttachment's caller in feedbackApi for the serving rules. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10MB each
export const MAX_FILES = 5;
const ALLOWED = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/svg+xml",
  "application/pdf", "text/plain", "text/csv",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
/* SVG is an image people genuinely paste, and it is also a script container. It is
   accepted for storage but NEVER served with its own type; the API downgrades it to
   an attachment download so a browser cannot execute it on our origin. */
export const isInlineSafeImage = (type: string) =>
  type.startsWith("image/") && type !== "image/svg+xml";
export const isAllowedType = (type: string) => ALLOWED.has((type || "").toLowerCase());

export type FeedbackKind = "feedback" | "feature" | "callback";

/* What a CUSTOMER asked for on a shared demo. See engine/callbacks.ts.
   ⚠️ A callback is stored as a feedback record so it appears in the Inbox the maintainer
   already reads, with no second board to build or remember to check. Its `submitter` is a
   synthetic `share:<slug>` identity (never a real address, so no completion email can be
   sent to it), and `ownerEmail` is who shared the demo, which is what lets a non-admin SE see
   the callbacks from THEIR OWN demos and nobody else's. */
export interface CallbackInfo {
  demoId: string;
  prospect: string;
  ownerEmail: string;
  channel: "sms" | "voice";
  want: "callback" | "live";        // a scheduled callback, or "connect me to a person now"
  phone?: string;                   // as the customer gave it, best effort
  confirmation: string;             // what the agent read back, which carries the time
}

/* The workflow, in order. `STATUSES[0]` is where everything starts.

   TERMINAL is what triggers the submitter's email: reaching it is the moment the
   person who asked actually wants to hear from you. "Declined" is deliberately NOT
   terminal-with-email — a rejection is worth a conversation rather than an
   automated note; flip it by adding it to TERMINAL if you disagree. */
export const STATUSES = ["New", "In review", "Planned", "In progress", "Complete", "Declined"] as const;
export type FeedbackStatus = (typeof STATUSES)[number];
export const TERMINAL: FeedbackStatus[] = ["Complete"];

export interface FeedbackUser { email: string; name: string }

export interface Attachment {
  name: string;      // the ORIGINAL name, shown to humans, never used as a path
  type: string;      // validated against ALLOWED on upload
  size: number;
  file: string;      // the sanitised on-disk name
}

export interface FeedbackRecord {
  id: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  /* Which screen they were on when they opened the form. Costs the submitter
     nothing and saves the "where did you see this?" round trip. */
  page?: string;
  submitter: FeedbackUser;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
  /* Every status change, so the trail survives even though only the current
     status is shown. Also what stops a double-save re-sending the email. */
  history: { at: string; status: FeedbackStatus; by: FeedbackUser }[];
  /* Set once the completion email actually goes out, so re-saving a Complete
     item, or a deploy that replays anything, cannot mail the person twice. */
  notifiedAt?: string;
  /* Optional note from whoever triaged it; shown to the submitter. */
  note?: string;
  attachments?: Attachment[];
  /* Present only on a `callback` record. */
  callback?: CallbackInfo;
}

function ensureDir() {
  fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
}

const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;
export const isValidFeedbackId = (id: string) => VALID_ID.test(id) && id.length <= 64;

/** Sortable, collision-resistant, and readable in a directory listing. */
export function newFeedbackId(): string {
  const t = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const r = Math.random().toString(36).slice(2, 8);
  return `${t}-${r}`;
}

export function listFeedback(): FeedbackRecord[] {
  ensureDir();
  const out: FeedbackRecord[] = [];
  for (const f of fs.readdirSync(FEEDBACK_DIR)) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(FEEDBACK_DIR, f), "utf8"))); }
    catch { /* a half-written file should not take the whole list down */ }
  }
  // newest first: the board is read top-down
  return out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

export function getFeedback(id: string): FeedbackRecord | null {
  if (!isValidFeedbackId(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(FEEDBACK_DIR, `${id}.json`), "utf8")); }
  catch { return null; }
}

export function saveFeedback(rec: FeedbackRecord): FeedbackRecord {
  ensureDir();
  const file = path.join(FEEDBACK_DIR, `${rec.id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);   // atomic: a reader never sees a partial file
  return rec;
}

export function deleteFeedback(id: string): boolean {
  if (!isValidFeedbackId(id)) return false;
  try { fs.unlinkSync(path.join(FEEDBACK_DIR, `${id}.json`)); return true; }
  catch { return false; }
}


/* ---- attachments ------------------------------------------------------------

   Stored beside the records, one directory per item, so deleting an item can take
   its files with it and nothing orphans.

   THE FILENAME IS NEVER TRUSTED. The name a browser sends is attacker-controlled:
   "../../server.ts" or a 300-character unicode string are both things you receive
   eventually. The stored name is rebuilt from scratch (index + sanitised stem +
   sanitised extension), and the original is kept only as a display label. */
function safeName(name: string, index: number): string {
  const base = (name || "file").split(/[\\/]/).pop() || "file";     // strip any path
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60) || "file";
  const ext = (dot > 0 ? base.slice(dot + 1) : "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
  return `${index}-${stem}${ext ? "." + ext : ""}`;
}

export function saveAttachment(id: string, index: number, name: string, data: Buffer): string {
  const dir = path.join(FILES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = safeName(name, index);
  /* resolve() then a prefix check: belt and braces against a traversal that somehow
     survived safeName. Writing outside the item's own directory is never valid. */
  const full = path.resolve(dir, file);
  if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error("Invalid file name.");
  fs.writeFileSync(full, data);
  return file;
}

export function readAttachment(id: string, file: string): Buffer | null {
  const dir = path.resolve(FILES_DIR, id);
  const full = path.resolve(dir, file);
  if (!full.startsWith(dir + path.sep)) return null;   // traversal attempt
  try { return fs.readFileSync(full); } catch { return null; }
}

/** Remove an item's whole file directory. Called when the item is deleted. */
export function deleteAttachments(id: string): void {
  try { fs.rmSync(path.join(FILES_DIR, id), { recursive: true, force: true }); } catch { /* nothing to do */ }
}
