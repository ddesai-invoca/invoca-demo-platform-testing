import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CUSTOMER } from "../customer/mode";
import { getByPath, isLockedEdit, isStructuralChange } from "./editGuard";

/* Global state for the "Ask AI" dashboard assistant. Holds:
   • the drawer open state + its FOCUS (whole dashboard, or one tile);
   • per-"<profileId>::<pathname>" EDITS to the dashboard's data (a non-destructive
     overlay — never rewrites the profile), AI-generated tiles, and a per-dashboard
     UNDO stack (one AI action = one undo step). All persisted to localStorage.

   The dashboard registers its BASE data via registerScope; the effective data
   shown/edited is (override ?? base). Edits are path-based ({path,value}); tiles
   are added/replaced/removed. Every mutation snapshots first so Undo can restore. */

export interface GeneratedTile {
  id: string;
  /* "table" is the Report templates' tile: Details / Summary / Transactions are
     tables, not charts. */
  /**
   * ⚠️ "dual" IS DELIBERATELY ABSENT FROM TILE_PROPS in engine/assistant.ts, like the render
   * hints below. Only buildTile sets it, from the Dual Y-Axis template's two measure fields.
   */
  tileType: "kpi" | "line" | "bar" | "pie" | "table" | "dual" | "geo";
  title: string;
  note: string;
  kpis: { label: string; value: string }[];
  xLabels: string[];
  series: { name: string; values: number[] }[];
  slices: { label: string; value: number }[];
  /* Axis titles, rendered as HTML beside the chart (the real ones are not svg text).
     Same optional-and-absent-from-TILE_PROPS contract as the table fields below. */
  xTitle?: string;
  yTitle?: string;
  /* Dot the final segment: a new tile's last period is incomplete. */
  dashTail?: boolean;
  /* One kind PER SERIES, for a multi-line tile where each series has its own axis and
     therefore its own units. */
  seriesKinds?: string[];
  /* What KIND of number this tile holds, so the axis ticks carry $ / % / m:ss.
     A plain string rather than the MeasureKind union: this type is serialised into a
     saved demo, and a stored value outside the union must not fail to parse. */
  valueKind?: string;
  /**
   * A "bar" tile drawn as HORIZONTAL bars rather than vertical columns.
   *
   * ⚠️ THREE TEMPLATES SHARE `tileType: "bar"` — Stacked Bar, Calls by Hour and Calls by
   * Day of Week — and only Stacked Bar is the horizontal one (measured 2026-08-21). Without
   * this flag they cannot be told apart at render time. Optional, and deliberately absent
   * from TILE_PROPS in engine/assistant.ts like the other render hints, so the assistant
   * cannot set it.
   */
  horizontal?: boolean;
  /** Right-hand axis title for the dual-axis template — the LINE measure. */
  rightTitle?: string;
  /**
   * Map points for the Geo Heatmap.
   *
   * ⚠️ Also absent from TILE_PROPS: coordinates are geography, not a value the assistant
   * should be able to invent — a wrong lat/lon puts a prospect's calls in the ocean.
   */
  geo?: Array<{ lat: number; lon: number; value: number; label?: string }>;
  /**
   * KPI headline: the last bucket, the period, and the change against the bucket before.
   *
   * ⚠️ Absent from TILE_PROPS like the other render hints. The delta is DERIVED from the
   * series, so letting the assistant set it would allow a percentage that contradicts the
   * sparkline beneath it.
   */
  trend?: {
    value: string; period: string; delta: number; previous: string; previousPeriod: string;
  };
  /** Totals row for a pivot table. */
  tableFooter?: string[];
  /** Whether the pivot paints its heat ramp — the template's "Show heatmap" option. */
  heatmap?: boolean;
  /**
   * ⚠️ "table" NORMALISES THE RAMP ACROSS THE WHOLE GRID; "column" per column. The Details
   * Report measured per-column, the Calls-by-Hour pivot measured global, so this is a real
   * per-template difference and not a preference.
   */
  heatScope?: "column" | "table";
  /** Saturation point for a table-scoped ramp — it clamps rather than stretching. */
  heatMax?: number;
  /** The pivot's first header row: the measure, then the column dimension's name. */
  pivotHeader?: { measure: string; columnDimension: string };
  /**
   * A Report tile's pinned aggregation row — UNIQUE COUNT / TOTAL / TABLE AGGREGATE per
   * column, decided by the column's own kind. Its presence also selects the ag-Grid
   * chrome, which is a different typeface and row height from the pivot's.
   */
  reportFooter?: { label: string; value: string }[];
  /** "Showing 200 of many rows", printed under a Report grid. */
  caption?: string;
  /* OPTIONAL ON PURPOSE, and deliberately absent from the model's output schema
     (TILE_PROPS in engine/assistant.ts). `toSchema()` marks every property of a
     generated type REQUIRED, so adding these there would force the assistant to
     invent a table on every kpi/line/bar/pie it creates. The column picker fills
     them; the model never touches them. */
  columns?: string[];
  rows?: string[][];
}

export interface AssistantFocus {
  /* "agent" is opened by a PREVIEW's own sparkle, not the page's. The page sparkle
     always edits the page you are looking at; the agent lives in a different scope
     and is shared by both previews, so the two must not be the same button. This
     focus carries the scope with it, which is what lets a chat drawer sitting on the
     workflow page edit the agent while the page's own sparkle still edits the
     diagram. */
  scope: "dashboard" | "tile" | "agent";
  tileKind?: "builtin" | "generated";
  id?: string;        // generated-tile id (tileKind "generated")
  label?: string;     // tile title, or the agent's name in the heading
  preview?: string;   // short text preview of the tile
  key?: string;       // scope "agent": the scope key its data lives under
  questionPath?: string; // scope "agent": where the question list sits in it
  /* The focused tile's OWN data path, e.g. "breakdowns.4". Optional: a tile that
     does not declare one behaves exactly as before, with the model locating the
     path itself. Supplying it removes the guess, because the model reasons about
     the page as RENDERED and picks the wrong index wherever render order and array
     order disagree -- see constrainToFocus() in editGuard.ts for the case that
     forced this. */
  path?: string | string[];
  /* Open on the LEFT, with no backdrop. For a drawer opened FROM something the user
     needs to keep watching: the preview chat lives on the right, and the whole point
     of editing the agent is seeing the chat pick the change up. A right-hand drawer
     would cover it and a backdrop would dim and block it. */
  side?: "left";
}

export interface AssistantEdit { path: string; value: string }

/* `questionPath` is an OPT-IN. Four screens register `agentConfig` as their scope,
   so every one of them has `smsPlaybook.qualifyingQuestions` sitting in its data;
   keying the drawer's question tools off "the data happens to contain a question
   list" would light them up on Agent Config, AI Recommendations and Knowledge
   Sources too. Only the page whose JOB is those questions passes this, which keeps
   the change to the one screen it was asked for. */
interface Scope {
  key: string; customerName: string; baseTitle: string; questionPath?: string;
  /* ⚠️ WHAT THE AGENT ACTUALLY OPENS WITH WHEN NOTHING IS STORED (9/3/2026).
     An extra workflow carries its own scripted opener, and the drawer had no way to know it —
     so on such a page the row showed a DERIVED default, the model was told that was the
     "current" opening message, and both were wrong. Opt-in metadata rather than seeded into
     the base, because the agent scope key is SHARED by every Preview Agent regardless of
     `?wf=`: seeding it would leak one workflow's opener into the built-in agent and into
     every other workflow's chat. */
  greetingFallback?: string;
  /* ⚠️⚠️ **THE FALLBACK OUTRANKS THE STORED GREETING FOR ONE WORKFLOW KIND (9/15/2026).**
     `buildSmsBrain` lets a workflow that sets `openingMessageWins` jump ahead of
     `smsPlaybook.greeting`, because its opener quotes what somebody typed into a form seconds
     ago. The drawer re-implements that precedence to decide which line to SHOW, and it did not
     know about the jump — so on the three profiles that ship a stored greeting (Aptive, Denver
     Health, Marriott) the OPENING MESSAGE row read the generic line while the phone sent the
     LSA one. Caught in the browser: the phone said "Hi Harold… You told us: 'Wasp nest…'" and
     the row said "Hi, this is Aptive's AI agent." That is the drawer-shows-a-line-nobody-sends
     defect this file already records twice; this flag is what keeps the two in step. */
  greetingWins?: boolean;
  /**
   * ANOTHER scope this page may also edit, and the prefix its data appears under.
   *
   * ⚠️⚠️ **THIS IS WHAT MAKES ASK AI BI-DIRECTIONAL (9/17/2026).** Asked for directly: "if i use
   * ask AI to make changes, it should make those changes in the workflow." The Preview Agent's
   * drawer edits `agentConfig` in its OWN scope, so before this an instruction like "ask about
   * termites first" could only ever move the agent's playbook — never the diagram.
   * ⚠️ **A SECOND KEY, NOT A COPY FOLDED INTO THIS ONE.** Registering the workflow's fields in
   * the preview's scope would store a SECOND copy of every question, and two homes for one value
   * is the duplicated-field trap behind all three of the 8/27 voice bugs. Edits whose path starts
   * with `linkAs` are stripped of that prefix and applied to `linkKey`, so they land on the one
   * place that owns them and the diagram redraws from it.
   */
  linkKey?: string;
  linkAs?: string;
}
/* `hidden` is part of the snapshot so Undo restores a tile you removed. Hiding is
   never destructive: the data stays exactly where it was and only the card stops
   rendering, which is what makes "put it back" free. */
interface Snapshot { override: unknown | undefined; tiles: GeneratedTile[]; hidden: string[] }

interface AiAssistantCtx {
  open: boolean;
  focus: AssistantFocus | null;
  openDrawer: (focus?: AssistantFocus) => void;
  closeDrawer: () => void;
  active: Scope | null;
  registerScope: (scope: { key: string; customerName: string; baseTitle: string; baseData: unknown; questionPath?: string; greetingFallback?: string; greetingWins?: boolean; linkKey?: string; linkAs?: string }) => void;
  /* Make a key EDITABLE without making it the active scope. applyEdits refuses a
     key with no base, so a page editing another page's data must ensure that base
     exists first; a second registerScope would do it but is last-write-wins and
     would silently repoint this page's sparkle. Never overwrites an existing base. */
  registerBase: (key: string, data: unknown) => void;
  effectiveData: (key: string) => unknown;
  tilesFor: (key: string) => GeneratedTile[];
  applyEdits: (key: string, edits: AssistantEdit[]) => number;
  addTile: (key: string, tile: GeneratedTile) => void;
  replaceTile: (key: string, id: string, tile: Omit<GeneratedTile, "id">) => void;
  removeTile: (key: string, id: string) => void;
  hideTile: (key: string, target: string) => void;
  showTile: (key: string, target: string) => void;
  hiddenFor: (key: string) => string[];
  undo: (key: string) => void;
  canUndo: (key: string) => boolean;
  undoDepth: (key: string) => number;
  /* Shared-library wiring: which demo is open, whether the signed-in user may
     edit it, and how to load one in. Null for built-in/local samples, which stay
     purely local and editable as before. */
  activeDemo: ActiveDemo | null;
  hydrateDemo: (id: string, customizations: DemoCustomizations, canEdit: boolean, creator: { name: string; email: string }) => void;
  readOnly: boolean;
}

export interface ActiveDemo { id: string; canEdit: boolean; creator: { name: string; email: string } }
export interface DemoCustomizations { overrides: Record<string, unknown>; tiles: Record<string, unknown[]> }

const Ctx = createContext<AiAssistantCtx | null>(null);

const LS = "invoca-demo:ai-state";
const UNDO_CAP = 50;

interface Persisted {
  overrides: Record<string, unknown>;
  tiles: Record<string, GeneratedTile[]>;
  /* Per scope key, the tile ids (their data paths) the SE has removed from view. */
  hidden: Record<string, string[]>;
  undo: Record<string, Snapshot[]>;
}
function load(): Persisted {
  try {
    const raw = localStorage.getItem(LS);
    const o = raw ? JSON.parse(raw) : {};
    return { overrides: o.overrides ?? {}, tiles: o.tiles ?? {}, hidden: o.hidden ?? {}, undo: o.undo ?? {} };
  } catch {
    return { overrides: {}, tiles: {}, hidden: {}, undo: {} };
  }
}

/* Immutable deep-set: clones only along `path` (dot notation, numeric array
   indices) and sets the leaf. Never mutates the source (which may be React
   state). Returns the source unchanged if the path can't be traversed. */
function setByPath<T>(source: T, path: string, value: unknown): T {
  // Accept both dot and bracket notation ("a.0.b" or "a[0].b").
  const keys = path.replace(/\[(\w+)\]/g, ".$1").split(".").filter(Boolean);
  if (!keys.length) return source;
  const clone = (v: any) => (Array.isArray(v) ? [...v] : v && typeof v === "object" ? { ...v } : v);
  const root: any = clone(source);
  let cur: any = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur == null || typeof cur !== "object" || !(k in cur)) return source; // bad path → no-op
    cur[k] = clone(cur[k]);
    cur = cur[k];
  }
  const last = keys[keys.length - 1];
  if (cur == null || typeof cur !== "object") return source;
  cur[last] = value;
  return root;
}

export function AiAssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<AssistantFocus | null>(null);
  const [active, setActive] = useState<Scope | null>(null);
  const [store, setStore] = useState<Persisted>(() => load());
  const baseRef = useRef<Record<string, unknown>>({}); // base data per key (not persisted; re-registered on mount)
  const [activeDemo, setActiveDemo] = useState<ActiveDemo | null>(null);
  const lastSyncedRef = useRef<string>("");   // guards against saving what we just loaded

  useEffect(() => {
    try { localStorage.setItem(LS, JSON.stringify(store)); } catch { /* ignore */ }
  }, [store]);

  /* Pull one library demo's saved AI layer into the store. Server keys are bare
     pathnames ("/dashboards/marketing"); the store keys them "<demoId>::<path>". */
  const hydrateDemo = useCallback((id: string, c: DemoCustomizations, canEdit: boolean, creator: { name: string; email: string }) => {
    setStore((prev) => {
      const overrides = { ...prev.overrides };
      const tiles = { ...prev.tiles };
      for (const [p, v] of Object.entries(c?.overrides ?? {})) overrides[`${id}::${p}`] = v;
      for (const [p, v] of Object.entries(c?.tiles ?? {})) tiles[`${id}::${p}`] = v as GeneratedTile[];
      return { ...prev, overrides, tiles };
    });
    lastSyncedRef.current = JSON.stringify(c ?? {});
    setActiveDemo({ id, canEdit, creator });
  }, []);

  /* Persist the active demo's slice back to the shared library (owner only),
     debounced so a burst of edits is one write. */
  useEffect(() => {
    const demo = activeDemo;
    if (!demo?.canEdit) return;
    const prefix = `${demo.id}::`;
    const slice: DemoCustomizations = { overrides: {}, tiles: {} };
    for (const [k, v] of Object.entries(store.overrides)) if (k.startsWith(prefix)) slice.overrides[k.slice(prefix.length)] = v;
    for (const [k, v] of Object.entries(store.tiles)) if (k.startsWith(prefix)) slice.tiles[k.slice(prefix.length)] = v;
    const payload = JSON.stringify(slice);
    if (payload === lastSyncedRef.current) return;   // nothing new since the last save/load
    const t = setTimeout(() => {
      lastSyncedRef.current = payload;
      fetch(`/api/demos/${demo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customizations: slice }),
      }).catch((e) => console.warn("[library] save failed:", e));
    }, 800);
    return () => clearTimeout(t);
  }, [store, activeDemo]);

  /* Customer build: no AI assist anywhere. The sparkles are also hidden in CSS, but this is the
     guarantee — no code path can open the drawer. Dead code in the staff app. */
  const openDrawer = useCallback((f?: AssistantFocus) => { if (CUSTOMER) return; setFocus(f ?? null); setOpen(true); }, []);
  const closeDrawer = useCallback(() => setOpen(false), []);

  const registerScope = useCallback((s: { key: string; customerName: string; baseTitle: string; baseData: unknown; questionPath?: string; greetingFallback?: string; greetingWins?: boolean; linkKey?: string; linkAs?: string }) => {
    baseRef.current[s.key] = s.baseData;
    /* ⚠️ EVERY FIELD HAS TO APPEAR TWICE HERE — in the equality test AND in the object — and
       forgetting the second half type-checks perfectly while silently dropping the field, which
       is how `linkKey` first arrived at the drawer as `undefined`. Caught by reading this body
       rather than by the compiler. */
    setActive((prev) => (
      prev && prev.key === s.key && prev.baseTitle === s.baseTitle && prev.questionPath === s.questionPath
        && prev.greetingFallback === s.greetingFallback && prev.greetingWins === s.greetingWins
        && prev.linkKey === s.linkKey && prev.linkAs === s.linkAs
        ? prev
        : { key: s.key, customerName: s.customerName, baseTitle: s.baseTitle, questionPath: s.questionPath,
            greetingFallback: s.greetingFallback, greetingWins: s.greetingWins,
            linkKey: s.linkKey, linkAs: s.linkAs }
    ));
  }, []);

  const registerBase = useCallback((key: string, data: unknown) => {
    /* Fill only. The owning page registers a richer object (it carries a title for
       the drawer heading); clobbering that here, just because the user reached the
       workflow page second, would quietly drop it. */
    if (data != null && !(key in baseRef.current)) baseRef.current[key] = data;
  }, []);

  const effectiveData = useCallback((key: string) => (key in store.overrides ? store.overrides[key] : baseRef.current[key]), [store.overrides]);
  const tilesFor = useCallback((key: string) => store.tiles[key] ?? [], [store.tiles]);
  const canUndo = useCallback((key: string) => (store.undo[key]?.length ?? 0) > 0, [store.undo]);
  const undoDepth = useCallback((key: string) => store.undo[key]?.length ?? 0, [store.undo]);

  /* Viewing someone else's library demo: everything is read-only. The server is
     the real authority (it 403s a PATCH from a non-owner) — this just stops the
     UI from showing changes that would never be saved. */
  const readOnly = !!activeDemo && !activeDemo.canEdit;

  // Push the current (override, tiles) as one undo step, then apply `mutate`.
  const mutate = useCallback((key: string, next: { override?: unknown | undefined; tiles?: GeneratedTile[]; hidden?: string[] }) => {
    if (readOnly) return;
    setStore((prev) => {
      const snap: Snapshot = {
        override: key in prev.overrides ? prev.overrides[key] : undefined,
        tiles: prev.tiles[key] ?? [],
        hidden: prev.hidden[key] ?? [],
      };
      const undoStack = [...(prev.undo[key] ?? []), snap].slice(-UNDO_CAP);
      const overrides = { ...prev.overrides };
      if ("override" in next) {
        if (next.override === undefined) delete overrides[key];
        else overrides[key] = next.override;
      }
      const tiles = { ...prev.tiles };
      if (next.tiles) tiles[key] = next.tiles;
      const hidden = { ...prev.hidden };
      if (next.hidden) hidden[key] = next.hidden;
      return { overrides, tiles, hidden, undo: { ...prev.undo, [key]: undoStack } };
    });
  }, [readOnly]);

  /* HIDE, NOT DELETE. `target` is the tile's data path — the same id rule 3 already
     gives every card — so "remove the lead form tile" needs no new identity scheme.
     Idempotent both ways so a repeated request is not an error. */
  const hideTile = useCallback((key: string, target: string) => {
    const cur = store.hidden[key] ?? [];
    if (cur.includes(target)) return;
    mutate(key, { hidden: [...cur, target] });
  }, [store.hidden, mutate]);

  const showTile = useCallback((key: string, target: string) => {
    const cur = store.hidden[key] ?? [];
    if (!cur.includes(target)) return;
    mutate(key, { hidden: cur.filter((t) => t !== target) });
  }, [store.hidden, mutate]);

  const hiddenFor = useCallback((key: string): string[] => store.hidden[key] ?? [], [store.hidden]);

  /* RULE 2 IS ENFORCED HERE, not only asked for in the prompt.

     Every edit is checked against the value it replaces and dropped if it would
     change the page's SHAPE rather than its content — a different array length
     (which adds or removes a row, series, column or tile, and in places drives
     the CSS grid itself) or a type flip (which breaks the component rendering
     it). The prompt already forbids both; this is what makes it true when the
     model does not listen. Same instruct-then-enforce pairing the dash rule
     needed. See editGuard.ts. */
  const applyEdits = useCallback((key: string, edits: AssistantEdit[]): number => {
    const base = key in store.overrides ? store.overrides[key] : baseRef.current[key];
    if (base == null || readOnly) return 0;
    let nextData: unknown = base;
    let applied = 0, blocked = 0;
    for (const e of edits) {
      let val: unknown;
      try { val = JSON.parse(e.value); } catch { val = e.value; }
      const before = getByPath(nextData, e.path);
      /* A label the product itself does not let a user rename (see editGuard). Counted with
         the structural blocks so the drawer reports a refusal rather than a clean success. */
      if (isLockedEdit(nextData, e.path)) {
        blocked++;
        console.warn(`[ai] refused a rename at "${e.path}" — that node is product chrome and cannot be renamed in the real page (see editGuard.ts)`);
        continue;
      }
      if (isStructuralChange(before, val, e.path)) {
        blocked++;
        console.warn(`[ai] blocked a structural edit at "${e.path}" (data only — see editGuard.ts)`);
        continue;
      }
      const after = setByPath(nextData, e.path, val);
      if (after !== nextData) { nextData = after; applied++; }
    }
    if (blocked && !applied) console.warn(`[ai] all ${blocked} edit(s) were structural; nothing changed.`);
    if (applied) mutate(key, { override: nextData });
    return applied;
  }, [store.overrides, mutate, readOnly]);

  const addTile = useCallback((key: string, tile: GeneratedTile) => {
    mutate(key, { tiles: [...(store.tiles[key] ?? []), tile] });
  }, [store.tiles, mutate]);

  const replaceTile = useCallback((key: string, id: string, tile: Omit<GeneratedTile, "id">) => {
    mutate(key, { tiles: (store.tiles[key] ?? []).map((t) => (t.id === id ? { ...tile, id } : t)) });
  }, [store.tiles, mutate]);

  const removeTile = useCallback((key: string, id: string) => {
    mutate(key, { tiles: (store.tiles[key] ?? []).filter((t) => t.id !== id) });
  }, [store.tiles, mutate]);

  const undo = useCallback((key: string) => {
    if (readOnly) return;
    setStore((prev) => {
      const stack = prev.undo[key] ?? [];
      if (!stack.length) return prev;
      const snap = stack[stack.length - 1];
      const overrides = { ...prev.overrides };
      if (snap.override === undefined) delete overrides[key];
      else overrides[key] = snap.override;
      /* Restores `hidden` as well, or Undo would bring a tile's data back while the
         card stayed invisible. `?? []` covers snapshots taken before hiding existed. */
      return {
        overrides,
        tiles: { ...prev.tiles, [key]: snap.tiles },
        hidden: { ...prev.hidden, [key]: snap.hidden ?? [] },
        undo: { ...prev.undo, [key]: stack.slice(0, -1) },
      };
    });
  }, [readOnly]);

  return (
    <Ctx.Provider value={{ open, focus, openDrawer, closeDrawer, active, registerScope, registerBase, effectiveData, tilesFor, applyEdits, addTile, replaceTile, removeTile, hideTile, showTile, hiddenFor, undo, canUndo, undoDepth, activeDemo, hydrateDemo, readOnly }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAiAssistant(): AiAssistantCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAiAssistant must be used within AiAssistantProvider");
  return v;
}
