import type { LucideIcon } from "lucide-react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "framer-motion";
import { CornerDownLeft, LogOut, Menu, Moon, Search, Sun, Undo2, UtensilsCrossed, X } from "lucide-react";
import { clearAuth, getAuth } from "../api/client";

export interface NavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

export function Shell({
  navItems,
  activeKey,
  onNavigate,
  roleLabel,
  children,
}: {
  navItems: NavItem[];
  activeKey: string;
  onNavigate: (key: string) => void;
  roleLabel: string;
  children: ReactNode;
}) {
  const auth = getAuth();
  const navigate = useNavigate();
  const initial = (auth?.name ?? "?").trim().charAt(0).toUpperCase();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  function logout() {
    clearAuth();
    navigate("/");
  }

  return (
    <div className="shell">
      <AmbientBackground />
      <header className="topnav">
        <div className="brand">
          <div className="brand-mark">
            <UtensilsCrossed size={17} strokeWidth={2.25} />
          </div>
          <div className="topnav-brand-text">
            <div className="brand-text">LPU Food</div>
          </div>
        </div>

        <nav className="topnav-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                className={`topnav-nav-item ${item.key === activeKey ? "active" : ""}`}
                onClick={() => onNavigate(item.key)}
              >
                <Icon size={16} strokeWidth={2} />
                {item.label}
                {typeof item.badge === "number" && item.badge > 0 && <span className="badge">{item.badge}</span>}
              </button>
            );
          })}
        </nav>

        <button
          className="ghost small topnav-burger"
          onClick={() => setMobileNavOpen((v) => !v)}
          aria-label={mobileNavOpen ? "Close menu" : "Open menu"}
        >
          {mobileNavOpen ? <X size={18} strokeWidth={2} /> : <Menu size={18} strokeWidth={2} />}
        </button>

        <div className="topnav-actions">
          <CommandPalette navItems={navItems} onNavigate={onNavigate} onLogout={logout} />
          <ThemeToggle />
          <div className="topnav-user">
            <div className="avatar">{initial}</div>
            <div className="topnav-user-text">
              <div className="user-name">{auth?.name ?? "Guest"}</div>
              <div className="user-role">{roleLabel}</div>
            </div>
          </div>
          <button className="ghost small" onClick={logout} aria-label="Log out">
            <LogOut size={15} strokeWidth={2} />
          </button>
        </div>
      </header>

      <AnimatePresence>
        {mobileNavOpen && (
          <motion.nav
            className="topnav-mobile-panel"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  className={`nav-item ${item.key === activeKey ? "active" : ""}`}
                  onClick={() => {
                    onNavigate(item.key);
                    setMobileNavOpen(false);
                  }}
                >
                  <span className="icon-wrap" aria-hidden>
                    <Icon size={17} strokeWidth={2} />
                  </span>
                  {item.label}
                  {typeof item.badge === "number" && item.badge > 0 && <span className="badge">{item.badge}</span>}
                </button>
              );
            })}
            <button className="ghost small row" style={{ width: "100%", justifyContent: "flex-start", gap: "0.5rem" }} onClick={logout}>
              <LogOut size={15} strokeWidth={2} />
              Log out
            </button>
          </motion.nav>
        )}
      </AnimatePresence>

      <main className="content">
        {/* `popLayout` (not `wait`) — the new page mounts immediately in normal flow while
            the outgoing one animates out of layout, so nothing blocks on the exit
            animation resolving (which could hang if the tab loses rAF mid-transition). */}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={activeKey}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}

type Theme = "light" | "dark";

function getInitialTheme(): Theme {
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Applies the theme to <html data-theme> and persists it — every color in the
 * app is a CSS variable, so this one attribute is the whole dark-mode switch. */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  return (
    <button
      className="theme-toggle"
      onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
      aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
    >
      {theme === "light" ? <Moon size={15} strokeWidth={2} /> : <Sun size={15} strokeWidth={2} />}
    </button>
  );
}

/** Slow-drifting, near-invisible accent blobs behind the page — reads as "alive"
 * without competing with content; pointer-events: none, so it never intercepts clicks. */
function AmbientBackground() {
  return (
    <div className="ambient-bg" aria-hidden>
      <motion.div
        className="ambient-blob ambient-blob-1"
        animate={{ x: [0, 60, -30, 0], y: [0, -40, 30, 0] }}
        transition={{ duration: 28, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="ambient-blob ambient-blob-2"
        animate={{ x: [0, -50, 40, 0], y: [0, 50, -20, 0] }}
        transition={{ duration: 34, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="ambient-blob ambient-blob-3"
        animate={{ x: [0, 30, -60, 0], y: [0, -30, 20, 0] }}
        transition={{ duration: 40, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}

interface PaletteAction {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
}

/** Ctrl/Cmd+K quick-nav — every nav item plus log out, filterable, arrow-key + Enter driven. */
function CommandPalette({
  navItems,
  onNavigate,
  onLogout,
}: {
  navItems: NavItem[];
  onNavigate: (key: string) => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const actions: PaletteAction[] = useMemo(
    () => [
      ...navItems.map((item) => ({
        id: `nav:${item.key}`,
        label: `Go to ${item.label}`,
        icon: item.icon,
        run: () => onNavigate(item.key),
      })),
      { id: "logout", label: "Log out", icon: LogOut, run: onLogout },
    ],
    [navItems, onNavigate, onLogout],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q));
  }, [actions, query]);

  useEffect(() => {
    function onKeydown(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, []);

  const hasOpenedRef = useRef(false);
  useEffect(() => {
    if (open) {
      hasOpenedRef.current = true;
      setQuery("");
      setActiveIndex(0);
      const id = setTimeout(() => inputRef.current?.focus(), 10);
      return () => clearTimeout(id);
    }
    // Closing (via Escape, backdrop, or selecting an action) returns focus to
    // the trigger so keyboard users aren't dropped at the top of the page —
    // but skip this on the initial mount, when it was never open.
    if (hasOpenedRef.current) triggerRef.current?.focus();
  }, [open]);

  useEffect(() => setActiveIndex(0), [query]);

  function runAction(action: PaletteAction) {
    action.run();
    setOpen(false);
  }

  function onInputKeydown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[activeIndex]) {
      e.preventDefault();
      runAction(filtered[activeIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <>
      <button ref={triggerRef} className="command-trigger" onClick={() => setOpen(true)}>
        <Search size={14} strokeWidth={2} />
        <span>Quick search</span>
        <span className="kbd">Ctrl K</span>
      </button>
      <AnimatePresence>
        {open && [
          <motion.div
            key="cmdk-backdrop"
            className="cmdk-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
          />,
          <motion.div
            key="cmdk-panel"
            className="cmdk-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
          >
            <div className="cmdk-input-row">
              <Search size={16} strokeWidth={2} />
              <input
                ref={inputRef}
                aria-label="Jump to a page or action"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKeydown}
                placeholder="Jump to a page or action…"
              />
            </div>
            <div className="cmdk-list">
              {filtered.length === 0 && <div className="cmdk-empty muted">No matches.</div>}
              {filtered.map((action, i) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.id}
                    className={`cmdk-item${i === activeIndex ? " active" : ""}`}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => runAction(action)}
                  >
                    <Icon size={15} strokeWidth={2} />
                    <span>{action.label}</span>
                    {i === activeIndex && <CornerDownLeft size={13} strokeWidth={2} className="cmdk-enter-hint" />}
                  </button>
                );
              })}
            </div>
          </motion.div>,
        ]}
      </AnimatePresence>
    </>
  );
}

export function PageHead({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}

export function EmptyState({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="empty-state">
      <div className="icon" aria-hidden>
        <Icon size={28} strokeWidth={1.5} />
      </div>
      <div>{text}</div>
    </div>
  );
}

export function Skeleton({ height = 16, width = "100%" }: { height?: number; width?: string | number }) {
  return <div className="skeleton" style={{ height, width }} />;
}

/** Counts up from its previous value to `value` whenever it changes — used for every headline stat. */
export function AnimatedNumber({
  value,
  prefix = "",
  decimals = 0,
}: {
  value: number;
  prefix?: string;
  decimals?: number;
}) {
  const motionValue = useMotionValue(0);
  const formatted = useTransform(motionValue, (v) =>
    `${prefix}${v.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`,
  );
  const [display, setDisplay] = useState(formatted.get());

  useEffect(() => {
    const controls = animate(motionValue, value, { duration: 0.6, ease: "easeOut" });
    const unsubscribe = formatted.on("change", setDisplay);
    return () => {
      controls.stop();
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return <span>{display}</span>;
}

const STAT_TONE_VARS: Record<string, { "--tone": string; "--tone-grad": string }> = {
  accent: { "--tone": "var(--accent)", "--tone-grad": "var(--accent-grad)" },
  success: { "--tone": "var(--success)", "--tone-grad": "var(--grad-success)" },
  warn: { "--tone": "var(--warn)", "--tone-grad": "var(--grad-warn)" },
  info: { "--tone": "var(--info)", "--tone-grad": "var(--grad-info)" },
  danger: { "--tone": "var(--danger)", "--tone-grad": "var(--grad-danger)" },
};

export function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = "accent",
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: "accent" | "success" | "warn" | "info" | "danger";
}) {
  return (
    <div className="stat-card" style={STAT_TONE_VARS[tone] as CSSProperties}>
      <div className="stat-icon">
        <Icon size={20} strokeWidth={2} />
      </div>
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">
          {label}
          {sub && <span className="stat-sub"> · {sub}</span>}
        </div>
      </div>
    </div>
  );
}

/** Coarse relative-time label ("3m ago") for activity feeds — not meant for precision. */
export function relativeTime(input: string | Date): string {
  const date = typeof input === "string" ? new Date(input) : input;
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface PendingUndo {
  id: number;
  message: string;
  onUndo: () => void;
  onCommit: () => void;
}

/**
 * For actions the backend can't reverse once committed (e.g. rejecting an
 * order — there's no "un-reject" transition): apply the UI change immediately,
 * but hold off calling the API until the undo window passes. Undo just drops
 * the pending commit; letting it expire fires `onCommit`.
 */
export function useUndoToast(durationMs = 5000) {
  const [pending, setPending] = useState<PendingUndo | null>(null);
  // Side-effecting callbacks must not run inside a setState updater (React
  // doesn't guarantee those stay pure/single-invocation) — this ref is the
  // actual source of truth for "what's pending"; `pending` state is only for
  // rendering the toast.
  const pendingRef = useRef<PendingUndo | null>(null);
  const timerRef = useRef<number | null>(null);

  function show(message: string, onUndo: () => void, onCommit: () => void) {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    const entry: PendingUndo = { id: Date.now(), message, onUndo, onCommit };
    pendingRef.current = entry;
    setPending(entry);
    timerRef.current = window.setTimeout(() => {
      if (pendingRef.current?.id === entry.id) {
        pendingRef.current.onCommit();
        pendingRef.current = null;
        setPending(null);
      }
    }, durationMs);
  }

  function undo() {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    if (pendingRef.current) {
      pendingRef.current.onUndo();
      pendingRef.current = null;
      setPending(null);
    }
  }

  const node = (
    <AnimatePresence>
      {pending && (
        <motion.div
          className="undo-toast"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.97 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
          <span>{pending.message}</span>
          <button className="ghost small" onClick={undo}>
            <Undo2 size={13} strokeWidth={2.25} /> Undo
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return { show, node };
}
