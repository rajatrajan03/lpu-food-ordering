import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  IndianRupee,
  KeyRound,
  LayoutGrid,
  List,
  MapPin,
  Moon,
  PauseCircle,
  Play,
  Receipt,
  Search,
  Star,
  Store,
  Tags,
  Timer,
  TrendingUp,
  UserX,
  UtensilsCrossed,
  X,
} from "lucide-react";
import { api } from "../api/client";
import { AnimatedNumber, EmptyState, PageHead, Shell, Skeleton, StatCard, relativeTime, type NavItem } from "../components/Shell";

interface Stall {
  id: string;
  name: string;
  block: string;
  area: string | null;
  status: string;
  nightOpen: boolean;
  pickupNote: string | null;
  owners: { id: string; name: string; phone: string }[];
}

interface StallInsight {
  ordersToday: number;
  revenueToday: number;
  menuItemCount: number;
  primaryCategory: string | null;
  lastActivityAt: string | null;
}

interface CanonicalCategory {
  id: string;
  name: string;
}

interface UnmappedCategory {
  id: string;
  rawLabel: string;
  stall: { name: string; block: string };
}

interface Overview {
  ordersToday: number;
  revenueToday: number;
  activeStalls: number;
  pausedStalls: number;
  unassignedStalls: number;
  pendingCategoryReviews: number;
  stuckOrders: number;
  avgFulfillmentMinutes: number | null;
  peakHour: { label: string; orders: number } | null;
  popularFoodsToday: { name: string; quantity: number }[];
  categoryDistribution: { category: string; quantity: number }[];
}

interface ActivityItem {
  id: string;
  status: string;
  totalAmount: number;
  placedAt: string;
  updatedAt: string;
  stallName: string;
  stallBlock: string;
  studentLabel: string;
}

const LIVE_STATUSES = new Set(["placed", "accepted", "preparing", "ready"]);

const NAV_ITEMS: NavItem[] = [
  { key: "overview", label: "Overview", icon: LayoutGrid },
  { key: "stalls", label: "Stalls", icon: Store },
  { key: "categories", label: "Category review", icon: Tags },
  { key: "owners", label: "Assign owners", icon: KeyRound },
];

type Tab = "overview" | "stalls" | "categories" | "owners";

export default function AdminDashboard() {
  const [tab, setTab] = useState<Tab>("overview");
  const [stalls, setStalls] = useState<Stall[] | null>(null);
  const [categories, setCategories] = useState<CanonicalCategory[]>([]);
  const [unmapped, setUnmapped] = useState<UnmappedCategory[] | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [insights, setInsights] = useState<Record<string, StallInsight>>({});
  const [error, setError] = useState<string | null>(null);

  const refreshAll = useCallback(() => {
    setError(null);
    api<Stall[]>("/api/admin/stalls").then(setStalls).catch((e) => setError(e.message));
    api<CanonicalCategory[]>("/api/admin/categories").then(setCategories).catch((e) => setError(e.message));
    api<UnmappedCategory[]>("/api/admin/menu-categories/unmapped").then(setUnmapped).catch((e) => setError(e.message));
    api<Overview>("/api/admin/overview").then(setOverview).catch((e) => setError(e.message));
    api<ActivityItem[]>("/api/admin/activity?limit=12").then(setActivity).catch((e) => setError(e.message));
    api<Record<string, StallInsight>>("/api/admin/stalls/insights").then(setInsights).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    refreshAll();
    const interval = setInterval(refreshAll, 20_000);
    return () => clearInterval(interval);
  }, [refreshAll]);

  async function assignCategory(menuCategoryId: string, canonicalCategoryId: string) {
    if (!canonicalCategoryId || !unmapped) return;
    const removed = unmapped.find((c) => c.id === menuCategoryId);
    setUnmapped(unmapped.filter((c) => c.id !== menuCategoryId));
    try {
      await api(`/api/admin/menu-categories/${menuCategoryId}`, {
        method: "PATCH",
        body: { canonicalCategoryId },
      });
    } catch (err) {
      if (removed) setUnmapped((prev) => [...(prev ?? []), removed]);
      setError(err instanceof Error ? err.message : "Could not assign category — restored to the queue.");
    }
  }

  function setStallStatusLocally(stallId: string, status: string) {
    setStalls((prev) => prev?.map((s) => (s.id === stallId ? { ...s, status } : s)) ?? null);
  }

  async function toggleStallStatus(stall: Stall) {
    const nextStatus = stall.status === "active" ? "paused" : "active";
    setStallStatusLocally(stall.id, nextStatus);
    try {
      await api(`/api/admin/stalls/${stall.id}`, { method: "PATCH", body: { status: nextStatus } });
    } catch (err) {
      setStallStatusLocally(stall.id, stall.status);
      setError(err instanceof Error ? err.message : "Could not update stall status.");
    }
  }

  async function toggleStallNightOpen(stall: Stall) {
    const nextNightOpen = !stall.nightOpen;
    setStalls((prev) => prev?.map((s) => (s.id === stall.id ? { ...s, nightOpen: nextNightOpen } : s)) ?? null);
    try {
      await api(`/api/admin/stalls/${stall.id}`, { method: "PATCH", body: { nightOpen: nextNightOpen } });
    } catch (err) {
      setStalls((prev) => prev?.map((s) => (s.id === stall.id ? { ...s, nightOpen: stall.nightOpen } : s)) ?? null);
      setError(err instanceof Error ? err.message : "Could not update night-hours setting.");
    }
  }

  async function bulkSetStallStatus(status: "active" | "paused") {
    const label = status === "paused" ? "pause" : "resume";
    if (!window.confirm(`${label === "pause" ? "Pause" : "Resume"} every stall? This affects all ${stalls?.length ?? 0} stalls.`)) return;
    const previous = stalls;
    setStalls((prev) => prev?.map((s) => ({ ...s, status })) ?? null);
    try {
      await api("/api/admin/stalls/bulk-status", { method: "POST", body: { status } });
    } catch (err) {
      setStalls(previous);
      setError(err instanceof Error ? err.message : `Could not ${label} all stalls.`);
    }
  }

  const navItems = NAV_ITEMS.map((item) =>
    item.key === "categories" ? { ...item, badge: unmapped?.length ?? 0 } : item,
  );

  return (
    <Shell navItems={navItems} activeKey={tab} onNavigate={(k) => setTab(k as Tab)} roleLabel="Super Admin">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {tab === "overview" && <OverviewTab overview={overview} activity={activity} onNavigate={setTab} />}
      {tab === "stalls" && (
        <StallsTab
          stalls={stalls}
          insights={insights}
          onChanged={refreshAll}
          onToggleStatus={toggleStallStatus}
          onToggleNightOpen={toggleStallNightOpen}
          onBulkStatus={bulkSetStallStatus}
          onSavedStall={(updated) =>
            setStalls((prev) => prev?.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)) ?? null)
          }
        />
      )}
      {tab === "categories" && (
        <CategoriesTab unmapped={unmapped} categories={categories} onAssign={assignCategory} />
      )}
      {tab === "owners" && <AssignOwnerForm stalls={stalls ?? []} onAssigned={refreshAll} />}
    </Shell>
  );
}

function OverviewTab({
  overview,
  activity,
  onNavigate,
}: {
  overview: Overview | null;
  activity: ActivityItem[] | null;
  onNavigate: (tab: Tab) => void;
}) {
  const attentionItems = overview
    ? [
        overview.stuckOrders > 0 && {
          icon: AlertTriangle,
          text: `${overview.stuckOrders} order${overview.stuckOrders === 1 ? "" : "s"} waiting over 15 minutes with no response`,
          count: overview.stuckOrders,
        },
        overview.unassignedStalls > 0 && {
          icon: UserX,
          text: `${overview.unassignedStalls} stall${overview.unassignedStalls === 1 ? "" : "s"} with no owner assigned`,
          count: overview.unassignedStalls,
          onClick: () => onNavigate("owners"),
        },
        overview.pausedStalls > 0 && {
          icon: PauseCircle,
          text: `${overview.pausedStalls} stall${overview.pausedStalls === 1 ? "" : "s"} currently paused`,
          count: overview.pausedStalls,
          onClick: () => onNavigate("stalls"),
        },
        overview.pendingCategoryReviews > 0 && {
          icon: Tags,
          text: `${overview.pendingCategoryReviews} categor${overview.pendingCategoryReviews === 1 ? "y" : "ies"} awaiting review`,
          count: overview.pendingCategoryReviews,
          onClick: () => onNavigate("categories"),
        },
      ].filter(Boolean as unknown as (v: unknown) => v is { icon: typeof AlertTriangle; text: string; count: number; onClick?: () => void })
    : [];

  return (
    <>
      <PageHead title="Overview" subtitle="Campus food operations, today and right now." />

      <div className="stat-row">
        <StatCard
          icon={Receipt}
          label="Orders today"
          tone="accent"
          value={overview ? <AnimatedNumber value={overview.ordersToday} /> : <Skeleton width={40} height={28} />}
        />
        <StatCard
          icon={IndianRupee}
          label="Revenue today"
          tone="success"
          value={
            overview ? <AnimatedNumber value={overview.revenueToday} prefix="₹" /> : <Skeleton width={60} height={28} />
          }
        />
        <StatCard
          icon={Store}
          label="Active stalls"
          tone="info"
          value={overview ? <AnimatedNumber value={overview.activeStalls} /> : <Skeleton width={40} height={28} />}
          sub={overview ? `${overview.pausedStalls} paused` : undefined}
        />
        <StatCard
          icon={Timer}
          label="Avg. fulfillment"
          tone="warn"
          value={
            overview
              ? overview.avgFulfillmentMinutes != null
                ? `${overview.avgFulfillmentMinutes}m`
                : "—"
              : <Skeleton width={40} height={28} />
          }
        />
      </div>

      {overview && attentionItems.length > 0 && (
        <motion.div
          className="card attention-panel"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
        >
          <div className="card-title">Needs attention</div>
          <div className="attention-list">
            {attentionItems.map((item, i) => {
              const Icon = item.icon;
              const Tag = item.onClick ? "button" : "div";
              return (
                <Tag
                  key={i}
                  className={`attention-item${item.onClick ? " clickable" : ""}`}
                  onClick={item.onClick}
                >
                  <span className="attn-icon">
                    <Icon size={16} strokeWidth={2} />
                  </span>
                  <span className="attn-text">{item.text}</span>
                  <span className="attn-count">{item.count}</span>
                </Tag>
              );
            })}
          </div>
        </motion.div>
      )}

      <div className="overview-grid">
        <div className="stack">
          <div className="card">
            <div className="card-title">Peak ordering hour</div>
            {!overview ? (
              <Skeleton height={28} width={140} />
            ) : overview.peakHour ? (
              <div className="peak-hour-display">
                <TrendingUp size={20} strokeWidth={2} color="var(--accent)" />
                <span className="value">{overview.peakHour.label}</span>
                <span className="muted">{overview.peakHour.orders} orders</span>
              </div>
            ) : (
              <span className="muted">No orders placed yet today.</span>
            )}
          </div>

          <div className="card">
            <div className="card-title">Most ordered today</div>
            {!overview ? (
              <div className="stack" style={{ marginTop: "0.4rem" }}>
                <Skeleton height={14} />
                <Skeleton height={14} width="70%" />
              </div>
            ) : (
              <BarList
                data={overview.popularFoodsToday.map((f) => ({ label: f.name, value: f.quantity }))}
                emptyText="No orders placed yet today."
              />
            )}
          </div>

          <div className="card">
            <div className="card-title">Category mix today</div>
            {!overview ? (
              <div className="stack" style={{ marginTop: "0.4rem" }}>
                <Skeleton height={14} />
                <Skeleton height={14} width="60%" />
              </div>
            ) : (
              <BarList
                data={overview.categoryDistribution.map((c) => ({ label: c.category, value: c.quantity }))}
                emptyText="No orders placed yet today."
              />
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-title">Live activity</div>
          {!activity ? (
            <div className="stack" style={{ marginTop: "0.5rem" }}>
              <Skeleton height={18} />
              <Skeleton height={18} />
              <Skeleton height={18} />
            </div>
          ) : (
            <ActivityFeed items={activity} />
          )}
        </div>
      </div>
    </>
  );
}

function BarList({ data, emptyText }: { data: { label: string; value: number }[]; emptyText: string }) {
  if (data.length === 0) return <div className="muted" style={{ padding: "0.4rem 0" }}>{emptyText}</div>;
  const max = Math.max(...data.map((d) => d.value));
  return (
    <div className="bar-list">
      {data.map((d) => (
        <div className="bar-row" key={d.label}>
          <span className="bar-label" title={d.label}>{d.label}</span>
          <div className="bar-track">
            <motion.div
              className="bar-fill"
              initial={{ width: 0 }}
              animate={{ width: `${max === 0 ? 0 : (d.value / max) * 100}%` }}
              transition={{ duration: 0.5, ease: "easeOut" }}
            />
          </div>
          <span className="bar-value">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) return <EmptyState icon={Activity} text="No order activity yet." />;
  return (
    <ul className="activity-list">
      {items.map((item, i) => (
        <motion.li
          key={item.id}
          className="activity-row"
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.25, delay: Math.min(i * 0.03, 0.3) }}
        >
          <span className={`activity-dot${LIVE_STATUSES.has(item.status) ? " live" : ""}`} />
          <div className="activity-body">
            <div className="activity-top row between">
              <span style={{ fontWeight: 600 }}>
                {item.stallName} <span className="muted">· {item.stallBlock}</span>
              </span>
              <span className={`pill ${item.status}`}>{item.status}</span>
            </div>
            <div className="activity-meta">
              {item.studentLabel} · ₹{item.totalAmount.toFixed(0)} · {relativeTime(item.updatedAt)}
            </div>
          </div>
        </motion.li>
      ))}
    </ul>
  );
}

const STALL_MARK_GRADIENTS = [
  "linear-gradient(135deg, #7c3aed, #4338ca)",
  "linear-gradient(135deg, #0f9d58, #0b7a44)",
  "linear-gradient(135deg, #b7791f, #92600f)",
  "linear-gradient(135deg, #1b5199, #123a70)",
  "linear-gradient(135deg, #d7373f, #a12027)",
  "linear-gradient(135deg, #0891b2, #0e7490)",
];

function stallGradient(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return STALL_MARK_GRADIENTS[hash % STALL_MARK_GRADIENTS.length];
}

function StallsTab({
  stalls,
  insights,
  onChanged,
  onToggleStatus,
  onToggleNightOpen,
  onBulkStatus,
  onSavedStall,
}: {
  stalls: Stall[] | null;
  insights: Record<string, StallInsight>;
  onChanged: () => void;
  onToggleStatus: (stall: Stall) => void;
  onToggleNightOpen: (stall: Stall) => void;
  onBulkStatus: (status: "active" | "paused") => void;
  onSavedStall: (updated: Stall) => void;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = stalls?.find((s) => s.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    if (!stalls) return null;
    const q = query.trim().toLowerCase();
    if (!q) return stalls;
    return stalls.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.block.toLowerCase().includes(q) ||
        (s.area ?? "").toLowerCase().includes(q),
    );
  }, [stalls, query]);

  const activeCount = stalls?.filter((s) => s.status === "active").length ?? 0;
  const assignedCount = stalls?.filter((s) => s.owners.length > 0).length ?? 0;

  return (
    <>
      <PageHead title="Stalls" subtitle="Every food stall imported from the campus dataset." />

      <div className="stat-row">
        <StatCard icon={Store} label="Total stalls" tone="accent" value={stalls ? stalls.length : <Skeleton width={40} height={28} />} />
        <StatCard icon={CheckCircle2} label="Active" tone="success" value={stalls ? activeCount : <Skeleton width={40} height={28} />} />
        <StatCard icon={KeyRound} label="Owner assigned" tone="info" value={stalls ? assignedCount : <Skeleton width={40} height={28} />} />
      </div>

      <div className="row between" style={{ marginBottom: "1rem", flexWrap: "wrap", gap: "0.75rem" }}>
        <div className="search-wrap" style={{ margin: 0 }}>
          <span className="search-icon"><Search size={15} strokeWidth={2} /></span>
          <input
            aria-label="Search stalls"
            placeholder="Search by name, block, or area…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="row" style={{ gap: "0.5rem" }}>
          <button className="ghost small" onClick={() => onBulkStatus("paused")}>
            <PauseCircle size={14} strokeWidth={2} /> Pause all
          </button>
          <button className="ghost small" onClick={() => onBulkStatus("active")}>
            <Play size={14} strokeWidth={2} /> Resume all
          </button>
        </div>
        <div className="view-toggle">
          <button
            className={view === "grid" ? "active" : ""}
            onClick={() => setView("grid")}
            aria-label="Grid view"
            aria-pressed={view === "grid"}
          >
            <LayoutGrid size={16} strokeWidth={2} />
          </button>
          <button
            className={view === "list" ? "active" : ""}
            onClick={() => setView("list")}
            aria-label="List view"
            aria-pressed={view === "list"}
          >
            <List size={16} strokeWidth={2} />
          </button>
        </div>
      </div>

      {!stalls && (
        <div className="stall-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div className="card" key={i} style={{ height: 168 }}>
              <Skeleton height={18} width="60%" />
              <div style={{ marginTop: "0.7rem" }}><Skeleton height={14} width="40%" /></div>
            </div>
          ))}
        </div>
      )}

      {stalls && filtered && filtered.length === 0 && (
        <div className="card"><EmptyState icon={Search} text={`No stalls match "${query}"`} /></div>
      )}

      {stalls && filtered && filtered.length > 0 && view === "grid" && (
        <div className="stall-grid">
          {filtered.map((s, i) => (
            <StallCard
              key={s.id}
              stall={s}
              insight={insights[s.id]}
              index={i}
              onOpen={() => setSelectedId(s.id)}
              onToggleStatus={() => onToggleStatus(s)}
              onToggleNightOpen={() => onToggleNightOpen(s)}
            />
          ))}
        </div>
      )}

      {stalls && filtered && filtered.length > 0 && view === "list" && (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Stall</th>
                  <th>Block / Area</th>
                  <th>Status</th>
                  <th>Owner(s)</th>
                  <th>Orders today</th>
                  <th>Revenue today</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const insight = insights[s.id];
                  return (
                    <tr key={s.id} onClick={() => setSelectedId(s.id)} style={{ cursor: "pointer" }}>
                      <td style={{ fontWeight: 600 }}>{s.name}</td>
                      <td className="muted">
                        {s.block}
                        {s.area ? ` · ${s.area}` : ""}
                      </td>
                      <td>
                        <span className={`pill ${s.status === "active" ? "active" : "paused"}`}>{s.status}</span>
                      </td>
                      <td>{s.owners.map((o) => o.name).join(", ") || <span className="muted">Unassigned</span>}</td>
                      <td>{insight?.ordersToday ?? 0}</td>
                      <td>₹{(insight?.revenueToday ?? 0).toFixed(0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <AnimatePresence>
        {selected && (
          <StallDetailPanel
            stall={selected}
            insight={insights[selected.id]}
            onClose={() => setSelectedId(null)}
            onToggleStatus={() => onToggleStatus(selected)}
            onToggleNightOpen={() => onToggleNightOpen(selected)}
            onSaved={(updated) => {
              onSavedStall(updated);
              onChanged();
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function StallCard({
  stall,
  insight,
  index,
  onOpen,
  onToggleStatus,
  onToggleNightOpen,
}: {
  stall: Stall;
  insight: StallInsight | undefined;
  index: number;
  onOpen: () => void;
  onToggleStatus: () => void;
  onToggleNightOpen: () => void;
}) {
  const isActive = stall.status === "active";
  return (
    <motion.div
      className={`stall-card${isActive ? "" : " paused"}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index * 0.02, 0.25) }}
      onClick={onOpen}
    >
      <div className="stall-card-top">
        <div className="stall-mark" style={{ background: stallGradient(stall.name) }}>
          {stall.name.charAt(0).toUpperCase()}
        </div>
        <div className="stall-card-title">
          <div className="name">{stall.name}</div>
          <div className="loc">
            <MapPin size={12} strokeWidth={2} />
            {stall.block}
            {stall.area ? ` · ${stall.area}` : ""}
          </div>
        </div>
        <span className={`pill ${isActive ? "active" : "paused"}`}>{isActive ? "active" : "paused"}</span>
      </div>

      <div className="stall-card-badges">
        {insight?.primaryCategory && <span className="chip">{insight.primaryCategory}</span>}
        <span className="chip"><UtensilsCrossed size={11} strokeWidth={2} /> {insight?.menuItemCount ?? "—"} items</span>
        {stall.nightOpen ? (
          <span className="chip"><Moon size={11} strokeWidth={2} /> Night open</span>
        ) : (
          <span className="chip"><Star size={11} strokeWidth={2} /> No ratings yet</span>
        )}
      </div>

      <div className="stall-card-metrics">
        <div className="stall-card-metric">
          <div className="metric-value">{insight?.ordersToday ?? 0}</div>
          <div className="metric-label">Orders today</div>
        </div>
        <div className="stall-card-metric">
          <div className="metric-value">₹{insight?.revenueToday ?? 0}</div>
          <div className="metric-label">Revenue today</div>
        </div>
      </div>

      <div className="stall-card-foot">
        <span className="muted">
          {stall.owners.length > 0 ? stall.owners.map((o) => o.name).join(", ") : "Unassigned"}
        </span>
        <div className="row" style={{ gap: "0.4rem" }}>
          <button
            className={`ghost small${stall.nightOpen ? " active" : ""}`}
            title={stall.nightOpen ? "Serves late night — tap to unmark" : "Mark as open late at night"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleNightOpen();
            }}
          >
            <Moon size={14} strokeWidth={2} />
          </button>
          <button
            className="ghost small"
            onClick={(e) => {
              e.stopPropagation();
              onToggleStatus();
            }}
          >
            {isActive ? <PauseCircle size={14} strokeWidth={2} /> : <Play size={14} strokeWidth={2} />}
            {isActive ? "Pause" : "Resume"}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function StallDetailPanel({
  stall,
  insight,
  onClose,
  onToggleStatus,
  onToggleNightOpen,
  onSaved,
}: {
  stall: Stall;
  insight: StallInsight | undefined;
  onClose: () => void;
  onToggleStatus: () => void;
  onToggleNightOpen: () => void;
  onSaved: (updated: Stall) => void;
}) {
  const [name, setName] = useState(stall.name);
  const [pickupNote, setPickupNote] = useState(stall.pickupNote ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await api(`/api/admin/stalls/${stall.id}`, { method: "PATCH", body: { name, pickupNote } });
      onSaved({ ...stall, name, pickupNote });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <motion.div
        className="slide-over-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.div
        className="slide-over"
        role="dialog"
        aria-modal="true"
        aria-label={`${stall.name} details`}
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ duration: 0.28, ease: "easeOut" }}
      >
        <div className="slide-over-header">
          <div className="stall-mark" style={{ background: stallGradient(stall.name) }}>
            {stall.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>{stall.name}</div>
            <div className="muted">
              {stall.block}
              {stall.area ? ` · ${stall.area}` : ""}
            </div>
          </div>
          <button className="ghost small close-btn" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="slide-over-body">
          <div className="detail-metric-row">
            <div className="detail-metric">
              <div className="metric-value">{insight?.ordersToday ?? 0}</div>
              <div className="metric-label">Orders today</div>
            </div>
            <div className="detail-metric">
              <div className="metric-value">₹{insight?.revenueToday ?? 0}</div>
              <div className="metric-label">Revenue today</div>
            </div>
            <div className="detail-metric">
              <div className="metric-value">{insight?.menuItemCount ?? 0}</div>
              <div className="metric-label">Menu items</div>
            </div>
          </div>

          <div className="row between">
            <span className={`pill ${stall.status === "active" ? "active" : "paused"}`}>{stall.status}</span>
            <button className="small" onClick={onToggleStatus}>
              {stall.status === "active" ? "Pause stall" : "Resume stall"}
            </button>
          </div>

          <div className="row between" style={{ marginTop: "0.6rem" }}>
            <span className="row" style={{ gap: "0.4rem" }}>
              <Moon size={14} strokeWidth={2} className="muted" />
              <span className="muted">Open late at night</span>
            </span>
            <button className="small" onClick={onToggleNightOpen}>
              {stall.nightOpen ? "Remove night hours" : "Mark night open"}
            </button>
          </div>

          <button className="row between" style={{ width: "100%" }} onClick={() => setMenuOpen(true)}>
            <span className="row" style={{ gap: "0.5rem" }}>
              <UtensilsCrossed size={15} strokeWidth={2} /> Manage menu
            </span>
            <span className="muted">{insight?.menuItemCount ?? 0} items →</span>
          </button>

          <div className="muted" style={{ fontSize: "0.82rem" }}>
            Last activity: {insight?.lastActivityAt ? relativeTime(insight.lastActivityAt) : "No orders yet"}
          </div>

          <div className="field">
            <label>Owner(s)</label>
            <div className="muted">
              {stall.owners.length > 0 ? stall.owners.map((o) => `${o.name} (${o.phone})`).join(", ") : "Unassigned"}
            </div>
          </div>

          <div className="field">
            <label>Stall name</label>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
            />
          </div>

          <div className="field">
            <label>Pickup note</label>
            <input
              placeholder="e.g. Collect from the side counter"
              value={pickupNote}
              onChange={(e) => {
                setPickupNote(e.target.value);
                setSaved(false);
              }}
            />
          </div>
        </div>

        <div className="slide-over-foot">
          <button className="ghost" onClick={onClose}>Close</button>
          <button className="primary" style={{ flex: 1 }} disabled={saving} onClick={save}>
            {saving && <span className="spinner" />}
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save changes"}
          </button>
        </div>
      </motion.div>

      <AnimatePresence>
        {menuOpen && <MenuEditorModal stallId={stall.id} stallName={stall.name} onClose={() => setMenuOpen(false)} />}
      </AnimatePresence>
    </>
  );
}

interface ItemVariant {
  id: string;
  label: string;
  price: string;
  available: boolean;
}

interface MenuItemRow {
  id: string;
  name: string;
  description: string | null;
  basePrice: string;
  isVeg: boolean | null;
  available: boolean;
  category: { id: string; rawLabel: string } | null;
  variants: ItemVariant[];
}

function MenuEditorModal({ stallId, stallName, onClose }: { stallId: string; stallName: string; onClose: () => void }) {
  const [items, setItems] = useState<MenuItemRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<MenuItemRow[]>(`/api/admin/stalls/${stallId}/items`)
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load menu."));
  }, [stallId]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.name.toLowerCase().includes(q) || i.category?.rawLabel.toLowerCase().includes(q));
  }, [items, query]);

  async function patchItem(itemId: string, patch: Partial<Pick<MenuItemRow, "available" | "isVeg" | "basePrice">>) {
    if (!items) return;
    const prev = items;
    setItems(items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)));
    try {
      await api(`/api/admin/items/${itemId}`, {
        method: "PATCH",
        body: "basePrice" in patch ? { basePrice: Number(patch.basePrice) } : patch,
      });
    } catch (err) {
      setItems(prev);
      setError(err instanceof Error ? err.message : "Could not save that change.");
    }
  }

  return (
    <>
      <motion.div
        className="slide-over-backdrop"
        style={{ zIndex: 70 }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.div
        className="menu-editor"
        role="dialog"
        aria-modal="true"
        aria-label={`${stallName} menu`}
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.98 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        <div className="menu-editor-head">
          <div>
            <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>{stallName} — menu</div>
            <div className="muted">{items ? `${items.length} items` : "Loading…"}</div>
          </div>
          <button className="ghost small" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="search-wrap" style={{ margin: "0.9rem 1.3rem 0" }}>
          <span className="search-icon"><Search size={15} strokeWidth={2} /></span>
          <input
            aria-label="Search menu items"
            placeholder="Search items or category…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {error && (
          <div className="error-banner" role="alert" style={{ margin: "0.8rem 1.3rem 0" }}>
            {error}
          </div>
        )}

        <div className="menu-editor-list">
          {!items &&
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="menu-item-row">
                <Skeleton height={16} width="50%" />
              </div>
            ))}
          {filtered && filtered.length === 0 && (
            <EmptyState icon={Search} text={`No items match "${query}"`} />
          )}
          {filtered?.map((item) => (
            <div key={item.id} className={`menu-item-row${item.available ? "" : " unavailable"}`}>
              <div className="menu-item-main">
                <div className="menu-item-name">{item.name}</div>
                {item.category && <span className="chip">{item.category.rawLabel}</span>}
              </div>
              <div className="menu-item-controls">
                <button
                  className={`veg-toggle ${item.isVeg === true ? "veg" : item.isVeg === false ? "nonveg" : "unknown"}`}
                  onClick={() => patchItem(item.id, { isVeg: item.isVeg === true ? false : true })}
                  title="Toggle veg / non-veg"
                >
                  {item.isVeg === true ? "Veg" : item.isVeg === false ? "Non-veg" : "Unset"}
                </button>
                <div className="price-input-wrap">
                  ₹
                  <input
                    type="number"
                    aria-label={`Price for ${item.name}`}
                    value={item.basePrice}
                    onChange={(e) => patchItem(item.id, { basePrice: e.target.value })}
                  />
                </div>
                <button
                  className={`availability-toggle ${item.available ? "on" : "off"}`}
                  onClick={() => patchItem(item.id, { available: !item.available })}
                  aria-pressed={item.available}
                >
                  {item.available ? "Available" : "Unavailable"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </motion.div>
    </>
  );
}

function CategoriesTab({
  unmapped,
  categories,
  onAssign,
}: {
  unmapped: UnmappedCategory[] | null;
  categories: CanonicalCategory[];
  onAssign: (menuCategoryId: string, canonicalCategoryId: string) => void;
}) {
  return (
    <>
      <PageHead
        title="Category review"
        subtitle="These raw category labels didn't match the default taxonomy — assign each to a real category so students can browse by it."
      />

      <div className="card" style={{ padding: 0 }}>
        {unmapped === null ? (
          <div style={{ padding: "1.1rem 1.3rem" }} className="stack">
            <Skeleton height={18} />
            <Skeleton height={18} />
            <Skeleton height={18} />
          </div>
        ) : unmapped.length === 0 ? (
          <EmptyState icon={CheckCircle2} text="Nothing left to review — every category is mapped." />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Raw label</th>
                  <th>Stall</th>
                  <th>Assign to</th>
                </tr>
              </thead>
              <tbody>
                {unmapped.map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.rawLabel}</td>
                    <td className="muted">
                      {c.stall.name} ({c.stall.block})
                    </td>
                    <td>
                      <select
                        className="inline-select"
                        defaultValue=""
                        onChange={(e) => onAssign(c.id, e.target.value)}
                      >
                        <option value="" disabled>
                          Choose category…
                        </option>
                        {categories.map((cat) => (
                          <option key={cat.id} value={cat.id}>
                            {cat.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function AssignOwnerForm({ stalls, onAssigned }: { stalls: Stall[]; onAssigned: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [stallId, setStallId] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    setSubmitting(true);
    try {
      await api("/api/admin/owners", {
        method: "POST",
        body: { name, phone, email: email || undefined, password, stallIds: [stallId] },
      });
      setStatus({ ok: true, text: `Owner login created for ${name}.` });
      setName("");
      setPhone("");
      setEmail("");
      setPassword("");
      setStallId("");
      onAssigned();
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : "Failed to create owner." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHead title="Assign owners" subtitle="Create a phone + password login for a stall's owner." />
      <div className="card" style={{ maxWidth: 420 }}>
        <form onSubmit={handleSubmit} className="stack">
          <div className="field">
            <label>Stall</label>
            <select value={stallId} onChange={(e) => setStallId(e.target.value)} required>
              <option value="" disabled>
                Choose stall…
              </option>
              {stalls.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.block})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Owner name</label>
            <input placeholder="e.g. Ramesh Kumar" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label>Phone number</label>
            <input placeholder="e.g. 9876543210" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          </div>
          <div className="field">
            <label>Email (optional — needed for Google sign-in)</label>
            <input
              type="email"
              placeholder="owner@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Temporary password</label>
            <input
              type="password"
              placeholder="At least 6 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? "Creating…" : "Create owner login"}
          </button>
          {status && (
            <div
              className={status.ok ? "muted" : "error-banner"}
              role={status.ok ? "status" : "alert"}
              style={status.ok ? { color: "var(--success)" } : undefined}
            >
              {status.text}
            </div>
          )}
        </form>
      </div>
    </>
  );
}
