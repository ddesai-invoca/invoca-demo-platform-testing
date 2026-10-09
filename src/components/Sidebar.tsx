import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { NAV, type NavItem } from "./nav";

/* The left rail. Most items are plain links; an item with a `submenu` opens a dark
   flyout panel beside the rail instead of navigating, which is what the real nav does
   for Signal.

   MEASURED off the capture "Signal /Singal Box.html": the panel is 230px wide, sits
   82px from the left edge (clear of the rail), background #2c3951, white text, 5px
   radius, shadow 0 2px 4px rgba(12,0,51,.2), 12px of padding at the bottom only. Its
   heading is an uppercased 20px/28px bold, padded 24px 24px 12px, and each link is
   16px/16px at 6px 24px. */

function SubMenu({ item, anchorTop, onClose }: {
  item: NavItem; anchorTop: number; onClose: () => void;
}) {
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  /* Escape and any click outside close it — the two things a real menu does and a
     hand-built one forgets. The click listener is on `pointerdown` in the CAPTURE phase
     so it runs before the rail button's own onClick, otherwise clicking the Signal item
     again would close the panel here and immediately reopen it there. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  /* FIXED, not absolute. `.nav-scroll` is `overflow-x: hidden`, so a panel positioned
     inside the rail would be clipped the moment it extended past 86px. Fixed positioning
     from the button's own rect puts it beside the item at any scroll position. */
  return (
    <div ref={ref} className="navsub" role="menu" style={{ top: anchorTop }}
      aria-label={item.label}>
      <h2 className="navsub-head">{item.label}</h2>
      {item.submenu!.map((s) => (
        <button key={s.path} type="button" role="menuitem" className="navsub-link"
          onClick={() => { navigate(s.path); onClose(); }}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

export function Sidebar({ items = NAV }: { items?: NavItem[] } = {}) {
  const [open, setOpen] = useState<string | null>(null);
  const [anchorTop, setAnchorTop] = useState(0);
  const { pathname } = useLocation();
  /* The rail button the panel is pinned to, and the rail's scroll container. */
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* Navigating away closes the panel. Without this it would hang over the new screen
     after a submenu item was picked. */
  useEffect(() => { setOpen(null); }, [pathname]);

  /* THE PANEL FOLLOWS ITS RAIL ITEM. The top was read once, at click time, so scrolling
     the rail slid the Signal button away and left the panel behind at the old offset.
     Re-reading the button's rect on every scroll and resize keeps them on the same line.

     useLayoutEffect, not useEffect: this runs before paint, so the panel is never drawn at
     a stale offset for a frame. The rail listener is on the scroll CONTAINER (.nav-scroll
     is what actually scrolls, not the window), and window scroll/resize are covered too
     for the page-level case. */
  useLayoutEffect(() => {
    if (!open) return;
    const sync = () => {
      const el = anchorRef.current;
      if (el) setAnchorTop(el.getBoundingClientRect().top);
    };
    sync();
    const rail = scrollRef.current;
    rail?.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    return () => {
      rail?.removeEventListener("scroll", sync);
      window.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, [open]);

  return (
    <nav className="sidebar">
      <div className="nav-scroll" ref={scrollRef}>
        {items.map((item) => {
          if (!item.submenu) {
            return (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
              >
                {item.svg ? (
                  <span className="nav-svg">{item.svg()}</span>
                ) : (
                  <span className="material-icons">{item.icon}</span>
                )}
                <span className="nav-label">{item.label}</span>
                {item.badge && <span className="nav-new">{item.badge}</span>}
              </NavLink>
            );
          }

          /* A submenu parent highlights for ANY route beneath it, so the rail still shows
             where you are when you are on /signal/discovery. */
          const active = pathname === item.path || pathname.startsWith(`${item.path}/`);
          return (
            <button
              key={item.path}
              type="button"
              aria-haspopup="menu"
              aria-expanded={open === item.path}
              className={"nav-item" + (active ? " active" : "")}
              onClick={(e) => {
                /* Remember the BUTTON, not just its offset — the layout effect above
                   re-reads it on every scroll so the panel keeps its line. */
                anchorRef.current = e.currentTarget;
                setAnchorTop(e.currentTarget.getBoundingClientRect().top);
                setOpen(open === item.path ? null : item.path);
              }}
            >
              {item.svg ? (
                <span className="nav-svg">{item.svg()}</span>
              ) : (
                <span className="material-icons">{item.icon}</span>
              )}
              <span className="nav-label">{item.label}</span>
              {item.badge && <span className="nav-new">{item.badge}</span>}
            </button>
          );
        })}
      </div>

      {open && (
        <SubMenu
          item={items.find((n) => n.path === open)!}
          anchorTop={anchorTop}
          onClose={() => setOpen(null)}
        />
      )}
    </nav>
  );
}
