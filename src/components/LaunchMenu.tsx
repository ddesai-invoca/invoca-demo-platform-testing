import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SupportModal } from "./SupportModal";
import { unseenRelease } from "../data/releaseNotes";

/* =============================================================================
   LaunchMenu — one hamburger, top right, replacing the bottom-right stack
   -----------------------------------------------------------------------------
   Asked for 9/10/2026: *"the buttons on the bottom [are] good, but there are
   more things that i want to add so i dont want multiple buttons on the bottom,
   lets do a Hamburger Menu with these on the top right"*. Read.Me, Support and
   the admin Inbox were three separate floating pills in `.corner-stack`; a fourth
   and fifth would have crowded the corner and started competing for attention.

   ⚠️ ADDING AN ITEM IS ONE ENTRY IN `items` BELOW — that is the whole point of
   this component. Every row goes through `activate()`, so a new item picks its
   behaviour by which field it sets and needs no new mechanics:
     href      → opens in a new tab (an external doc, a dashboard elsewhere)
     to        → client-side navigation within the app
     onSelect  → anything else (open a modal, copy something, fire a request)
   plus optional `hint`, `badge` and `hidden`. Do NOT add a second bespoke
   button beside the hamburger; that is the thing this replaced.

   ⚠️ WHERE IT APPEARS is still the launch form only (`MENU_ON` in App.tsx).
   Everything past that form is a replica of Invoca's product shown to a
   prospect, and our own chrome does not belong on top of it — the same rule the
   corner stack followed, unchanged. A top-right hamburger would be MORE
   intrusive there, not less, since that is where real product chrome lives.
   ============================================================================= */

interface MenuItem {
  key: string;
  /** Material Icons ligature. */
  icon: string;
  label: string;
  hint?: string;
  /** External — opens in a new tab. */
  href?: string;
  /** In-app route. */
  to?: string;
  /** Anything else. Runs after the menu closes. */
  onSelect?: () => void;
  /** A count chip on the row, and folded into the hamburger's own dot. */
  badge?: number;
  /** A short word chip on the row ("New"), for state a count cannot express. */
  tag?: string;
  hidden?: boolean;
}

interface Summary { admin: boolean; total: number; open: { feedback: number; feature: number } }

export function LaunchMenu() {
  const [open, setOpen] = useState(false);
  const [support, setSupport] = useState(false);
  const [sum, setSum] = useState<Summary | null>(null);
  const [unseen, setUnseen] = useState(unseenRelease);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  /* The open-feedback count, for the admin Inbox row AND the dot on the closed
     hamburger. Carried over from the old InboxButton, whose whole argument was
     that a count sitting in the corner is a passive signal you notice, which a
     menu hides — so the dot survives the folding-in even though the row does not.

     ⚠️ SHAPE-CHECKED, not just truthy. A server still running a cached older
     module answers this URL with the FULL LIST shape, which has `admin` but no
     `open`, and reading `.open.feedback` off that throws and takes the launch page
     down with it. It asks for `?summary=1` rather than the list because two
     numbers should not mean downloading everyone's submissions. */
  useEffect(() => {
    let alive = true;
    fetch("/api/feedback?summary=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.admin && d?.open) setSum(d); })
      /* A failure means no Inbox row and no dot, which is the right degradation:
         the board is still at /feedback and nothing else here is affected. */
      .catch(() => { /* stay hidden */ });
    return () => { alive = false; };
  }, []);

  /* Re-read on every open rather than once at mount: the menu stays mounted while
     you navigate to /release-notes and back (that route is in MENU_ON too), so a
     value computed once would still say "New" after you had just read them. */
  useEffect(() => { if (open) setUnseen(unseenRelease()); }, [open]);

  /* ⚠️ POINTERDOWN IN THE CAPTURE PHASE. On bubble, a click on the hamburger
     itself would close the panel here and then immediately reopen it in the
     button's own onClick, so the menu could never be dismissed by its own
     trigger — the exact trap the Signal flyout and the channel combobox in this
     repo already document. The panel is checked as well as the root because the
     panel is a child of the root today and may later be portalled out. */
  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setOpen(false); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      /* Arrow keys move through the rows, because a pointer-only menu is not
         reachable for anyone driving this from the keyboard. */
      e.preventDefault();
      const rows = [...(panelRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
      if (!rows.length) return;
      const i = rows.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "ArrowDown"
        ? rows[i < 0 || i === rows.length - 1 ? 0 : i + 1]
        : rows[i <= 0 ? rows.length - 1 : i - 1];
      next?.focus();
    }
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openCount = sum ? (sum.open?.feedback ?? 0) + (sum.open?.feature ?? 0) : 0;

  const items: MenuItem[] = [
    {
      key: "support",
      icon: "support_agent",
      label: "Support",
      hint: "Something broken, or a feature you want",
      onSelect: () => setSupport(true),
    },
    {
      key: "inbox",
      icon: "inbox",
      label: "Inbox",
      hint: sum
        ? (openCount
            ? `${openCount} open (${sum.open.feedback} feedback, ${sum.open.feature} feature) of ${sum.total}`
            : `Nothing open, ${sum.total} in total`)
        : undefined,
      to: "/feedback",
      /* Only when something is actually waiting. A permanent "0" is noise that
         trains you to stop reading the badge. */
      badge: openCount || undefined,
      /* Admin only — `sum` is null for everyone else, since the server decides. */
      hidden: !sum,
    },
    {
      key: "releases",
      icon: "campaign",
      label: "What's new",
      hint: "Everything that has shipped, newest first",
      to: "/release-notes",
      /* Cleared by opening the page, so this is "unread" rather than a permanent
         decoration. Read through a try/catch — see unseenRelease(). */
      tag: unseen ? "New" : undefined,
    },
    {
      key: "readme",
      icon: "menu_book",
      label: "Read.Me",
      hint: "How this works, what it costs, how to maintain it",
      /* Ships with the app (public/readme.html → dist/), so it works on Render,
         on a local `npm run serve` and in dev with no external host. New tab, so
         reading the docs never loses the demo an SE is mid-way through. */
      href: "/readme.html",
    },
    {
      key: "ingest-o-matic",
      icon: "call_merge",
      label: "Demo Call Ingest-O-Matic",
      hint: "Schedule and log bulk demo-call ingestion",
      to: "/ingest-o-matic",
      /* Admin only, same signal as the Inbox row above (`sum` is null for
         non-admins — the server decides, not the client). Reusing `sum.admin`
         rather than a second request for the same fact. */
      hidden: !sum?.admin,
    },
  ];

  const shown = items.filter((i) => !i.hidden);

  function activate(item: MenuItem) {
    setOpen(false);
    if (item.href) { window.open(item.href, "_blank", "noopener,noreferrer"); return; }
    if (item.to) { navigate(item.to); return; }
    item.onSelect?.();
  }

  return (
    <>
      <div className="lm-root" ref={rootRef}>
        <button
          className={"lm-toggle" + (open ? " lm-toggle-on" : "")}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Menu"
          title="Menu"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="material-icons">{open ? "close" : "menu"}</span>
          {/* ⚠️ ONE DOT, TWO SIGNALS, AND THEY CANNOT COLLIDE — which is why this
              is a conditional rather than two badges. A NUMBER always means open
              feedback items, and only an admin ever has those. A PLAIN dot means
              unread release notes, and it is shown only when there is no count to
              contradict it, so the number never has to mean two things. In
              practice each person gets the signal that is theirs: the admin their
              inbox, everyone else the thing that was just shipped to them.
              Both hide while the menu is open, where each row states its own. */}
          {!open && (openCount > 0
            ? <span className="lm-dot">{openCount}</span>
            : unseen ? <span className="lm-dot lm-dot--plain" /> : null)}
        </button>

        {open && (
          <div className="lm-panel" role="menu" aria-label="Menu" ref={panelRef}>
            {shown.map((item) => (
              <button
                key={item.key}
                role="menuitem"
                className="lm-item"
                onClick={() => activate(item)}
              >
                <span className="material-icons lm-item-icon">{item.icon}</span>
                <span className="lm-item-text">
                  <span className="lm-item-label">
                    {item.label}
                    {item.badge ? <span className="lm-item-n">{item.badge}</span> : null}
                    {item.tag ? <span className="lm-item-tag">{item.tag}</span> : null}
                  </span>
                  {item.hint && <span className="lm-item-hint">{item.hint}</span>}
                </span>
                {item.href && <span className="material-icons lm-item-ext">open_in_new</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ⚠️ OUTSIDE `.lm-panel` ON PURPOSE — see the note at the top of
          SupportModal. Selecting "Support" closes the menu, which unmounts the
          panel; a modal rendered inside it would be destroyed by the same click
          that asked for it. */}
      <SupportModal open={support} onClose={() => setSupport(false)} />
    </>
  );
}
