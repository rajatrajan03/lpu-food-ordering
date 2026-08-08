import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BellRing,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Flame,
  Hourglass,
  IndianRupee,
  ListChecks,
  MessageSquareText,
  Plus,
  Receipt,
  ShieldAlert,
  Star,
  Tag,
  Target,
  Timer,
  Trash2,
  TrendingUp,
  UserX,
  Users,
  XCircle,
} from "lucide-react";
import { api, downloadFile } from "../api/client";
import {
  AnimatedNumber,
  BarChart,
  EmptyState,
  PageHead,
  Shell,
  Skeleton,
  StatCard,
  TrendLine,
  relativeTime,
  useUndoToast,
  type NavItem,
} from "../components/Shell";

interface Stall {
  id: string;
  name: string;
  block: string;
  status: "active" | "paused";
}

interface OrderItem {
  id: string;
  itemNameSnapshot: string;
  quantity: number;
  unitPrice: string;
}

interface Order {
  id: string;
  displayId: string;
  status: "placed" | "accepted" | "rejected" | "preparing" | "ready" | "completed" | "cancelled";
  totalAmount: string;
  placedAt: string;
  updatedAt: string;
  items: OrderItem[];
  pickupSlot: { startTime: string; endTime: string };
  student: { whatsappNumber: string; name: string | null };
  // Order SLA & Accountability
  acceptDeadline: string | null;
  acceptedAt: string | null;
  autoRejected: boolean;
  readyAt: string | null;
  slaViolation: boolean;
  slaViolationMinutes: number | null;
  noShow: boolean;
}

interface SlaMetrics {
  totalOrders: number;
  avgAcceptanceSeconds: number | null;
  missedAcceptanceDeadlines: number;
  slaViolations: number;
  onTimePreparationRate: number | null;
  customerNoShows: number;
}

const RATING_REASON_LABEL: Record<string, string> = {
  food_quality: "🍔 Food Quality",
  service: "👨‍🍳 Service",
  pickup_delay: "⏱ Pickup Delay",
  wrong_order: "📦 Wrong Order",
  other: "💬 Other",
};

interface RatingDetail {
  average: number | null;
  count: number;
  breakdown: { reason: string; count: number }[];
  recentComments: { stars: number; reason: string | null; comment: string | null; createdAt: string }[];
}

/** Exact placed-at timestamp for staff-facing views (order cards, KOT) — students only ever see the order number, never this. */
function formatPlacedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function formatAcceptanceTime(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Today's date as "YYYY-MM-DD" in IST — matches the backend's date-picker query format. */
function todayIstStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

const NEXT_ACTIONS: Record<Order["status"], { label: string; status: string; variant: string }[]> = {
  placed: [
    { label: "Accept", status: "accepted", variant: "secondary" },
    { label: "Reject", status: "rejected", variant: "danger" },
  ],
  accepted: [{ label: "Start preparing", status: "preparing", variant: "secondary" }],
  preparing: [{ label: "Mark ready", status: "ready", variant: "secondary" }],
  ready: [{ label: "Mark completed", status: "completed", variant: "primary" }],
  completed: [],
  rejected: [],
  cancelled: [],
};

// An unanswered order past this age gets flagged as urgent in the "Needs attention" group.
const URGENT_MINUTES = 10;
const NAV_ITEMS: NavItem[] = [
  { key: "orders", label: "Orders", icon: Receipt },
  { key: "offers", label: "Offers", icon: Tag },
  { key: "analytics", label: "Analytics", icon: BarChart3 },
  { key: "ai", label: "Ask AI", icon: Bot },
];

const OWNER_AI_SUGGESTIONS = [
  "How was today's business?",
  "Which item sells the most?",
  "Which item sells the least?",
  "Why are my ratings decreasing?",
  "Which hour is my busiest?",
  "What should I prepare tomorrow?",
];

interface Offer {
  id: string;
  name: string;
  description: string | null;
  type: string;
  active: boolean;
  validFrom: string;
  validUntil: string;
  minOrderValue: string | null;
  maxDiscount: string | null;
  discountPercent: number | null;
  discountFlat: string | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  happyHourStart: string | null;
  happyHourEnd: string | null;
}

interface OfferAnalytic {
  id: string;
  name: string;
  type: string;
  status: "active" | "scheduled" | "expired" | "inactive";
  usageCount: number;
  totalDiscountGiven: number;
}

const OFFER_TYPE_LABEL: Record<string, string> = {
  percentage_discount: "Percentage Discount",
  flat_discount: "Flat Discount",
  buy_x_get_y: "Buy X Get Y",
  free_item: "Free Item",
  combo: "Combo Offer",
  happy_hour: "Happy Hour",
  festival: "Festival Offer",
  min_order_value: "Minimum Order Value Offer",
};

export default function OwnerDashboard() {
  const [tab, setTab] = useState<"orders" | "offers" | "analytics" | "ai">("orders");
  const [stalls, setStalls] = useState<Stall[] | null>(null);
  const [stallId, setStallId] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [completedToday, setCompletedToday] = useState<Order[] | null>(null);
  const [slaMetrics, setSlaMetrics] = useState<SlaMetrics | null>(null);
  const [ratingDetail, setRatingDetail] = useState<RatingDetail | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);
  // Date-picker history view — when this isn't today, the live queue/polling
  // is replaced by a read-only snapshot of that day's orders.
  const [selectedDate, setSelectedDate] = useState(todayIstStr());
  const [historyOrders, setHistoryOrders] = useState<Order[] | null>(null);
  const [historySla, setHistorySla] = useState<SlaMetrics | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const isToday = selectedDate === todayIstStr();
  const { show: showUndo, node: undoToastNode } = useUndoToast();
  // Orders rejected within the undo window — held out of poll results so they
  // don't reappear in the queue before the reject is actually committed.
  const pendingRejectIds = useRef<Set<string>>(new Set());

  const loadOrders = useCallback(async (id: string) => {
    try {
      const [active, completed, sla] = await Promise.all([
        api<Order[]>(`/api/owner/stalls/${id}/orders`),
        api<Order[]>(`/api/owner/stalls/${id}/orders/completed-today`),
        api<SlaMetrics>(`/api/owner/stalls/${id}/sla-metrics`),
      ]);
      setOrders(active.filter((o) => !pendingRejectIds.current.has(o.id)));
      setCompletedToday(completed);
      setSlaMetrics(sla);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orders.");
    }
  }, []);

  useEffect(() => {
    api<Stall[]>("/api/owner/stalls/mine")
      .then((data) => {
        setStalls(data);
        if (data[0]) setStallId(data[0].id);
      })
      .catch((err) => setError(err.message));
  }, []);

  const loadHistory = useCallback(async (id: string, date: string) => {
    setHistoryLoading(true);
    try {
      const [dayOrders, sla] = await Promise.all([
        api<Order[]>(`/api/owner/stalls/${id}/orders/history?date=${date}`),
        api<SlaMetrics>(`/api/owner/stalls/${id}/sla-metrics?date=${date}`),
      ]);
      setHistoryOrders(dayOrders);
      setHistorySla(sla);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load that day's orders.");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // Live queue + polling only while looking at today — a past date is a
  // static snapshot, re-polling it every 10s would just repeat the same request.
  useEffect(() => {
    if (!stallId || !isToday) return;
    loadOrders(stallId);
    const interval = setInterval(() => loadOrders(stallId), 10_000);
    return () => clearInterval(interval);
  }, [stallId, isToday, loadOrders]);

  useEffect(() => {
    if (!stallId || isToday) return;
    loadHistory(stallId, selectedDate);
  }, [stallId, isToday, selectedDate, loadHistory]);

  // Ratings aren't day-scoped, so this loads once per stall selection —
  // independent of both the live-order polling and the date picker.
  useEffect(() => {
    if (!stallId) return;
    api<RatingDetail>(`/api/owner/stalls/${stallId}/ratings`)
      .then(setRatingDetail)
      .catch(() => setRatingDetail(null));
  }, [stallId]);

  async function act(orderId: string, status: string) {
    if (!stallId || !orders) return;
    const order = orders.find((o) => o.id === orderId);
    if (!order) return;

    // Rejecting has no server-side undo (no "un-reject" transition), so the
    // API call itself is deferred until the undo window passes — undo just
    // means the request never happens.
    if (status === "rejected") {
      pendingRejectIds.current.add(orderId);
      setOrders(orders.filter((o) => o.id !== orderId));
      showUndo(
        `Rejected order for ${order.student.name ?? order.student.whatsappNumber}.`,
        () => {
          pendingRejectIds.current.delete(orderId);
          setOrders((prev) =>
            prev
              ? [...prev, order].sort((a, b) => new Date(a.placedAt).getTime() - new Date(b.placedAt).getTime())
              : prev,
          );
        },
        () => {
          pendingRejectIds.current.delete(orderId);
          api(`/api/owner/stalls/${stallId}/orders/${orderId}/status`, {
            method: "POST",
            body: { status: "rejected" },
          }).catch((err) => {
            setError(err instanceof Error ? err.message : "Failed to reject order.");
            loadOrders(stallId);
          });
        },
      );
      return;
    }

    const prevOrders = orders;
    const prevCompleted = completedToday;
    setActingOn(`${orderId}:${status}`);

    // Optimistic: apply the transition locally so the card moves group (or
    // drops out of the active queue) instantly — reconciled with the server
    // response in the background, rolled back if the request fails.
    if (status === "completed") {
      setOrders(orders.filter((o) => o.id !== orderId));
      setCompletedToday((prev) => [
        { ...order, status: "completed", updatedAt: new Date().toISOString() },
        ...(prev ?? []),
      ]);
    } else {
      setOrders(orders.map((o) => (o.id === orderId ? { ...o, status: status as Order["status"] } : o)));
    }

    try {
      await api(`/api/owner/stalls/${stallId}/orders/${orderId}/status`, { method: "POST", body: { status } });
      loadOrders(stallId);
    } catch (err) {
      setOrders(prevOrders);
      setCompletedToday(prevCompleted);
      setError(err instanceof Error ? err.message : "Action failed — the order has been restored.");
    } finally {
      setActingOn(null);
    }
  }

  async function toggleStall(currentStatus: Stall["status"]) {
    if (!stallId) return;
    const nextStatus = currentStatus === "active" ? "paused" : "active";
    const action = currentStatus === "active" ? "pause" : "resume";

    setStalls((prev) => prev?.map((s) => (s.id === stallId ? { ...s, status: nextStatus } : s)) ?? null);
    try {
      await api(`/api/owner/stalls/${stallId}/${action}`, { method: "POST" });
    } catch (err) {
      setStalls((prev) => prev?.map((s) => (s.id === stallId ? { ...s, status: currentStatus } : s)) ?? null);
      setError(err instanceof Error ? err.message : "Could not update stall status.");
    }
  }

  const currentStall = stalls?.find((s) => s.id === stallId);

  const needsAttention = orders?.filter((o) => o.status === "placed") ?? [];
  const preparing = orders?.filter((o) => o.status === "accepted" || o.status === "preparing") ?? [];
  const ready = orders?.filter((o) => o.status === "ready") ?? [];

  const nextPickup = useMemo(() => {
    if (!orders || orders.length === 0) return null;
    const times = orders.map((o) => new Date(o.pickupSlot.startTime).getTime());
    return new Date(Math.min(...times));
  }, [orders]);

  const revenueToday = useMemo(() => {
    if (!orders || !completedToday) return 0;
    const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
    const activeToday = orders.filter((o) => isToday(o.placedAt)).reduce((sum, o) => sum + Number(o.totalAmount), 0);
    const completed = completedToday.reduce((sum, o) => sum + Number(o.totalAmount), 0);
    return activeToday + completed;
  }, [orders, completedToday]);

  const avgPrepMinutes = useMemo(() => {
    if (!completedToday || completedToday.length === 0) return null;
    const total = completedToday.reduce(
      (sum, o) => sum + (new Date(o.updatedAt).getTime() - new Date(o.placedAt).getTime()),
      0,
    );
    return Math.round(total / completedToday.length / 60_000);
  }, [completedToday]);

  const peakHour = useMemo(() => {
    if (!orders || !completedToday) return null;
    const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
    const todaysOrders = [...orders.filter((o) => isToday(o.placedAt)), ...completedToday];
    if (todaysOrders.length === 0) return null;
    const counts = new Map<number, number>();
    for (const o of todaysOrders) {
      const hour = new Date(o.placedAt).getHours();
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
    }
    let best: { hour: number; count: number } | null = null;
    for (const [hour, count] of counts) {
      if (!best || count > best.count) best = { hour, count };
    }
    if (!best) return null;
    const label = (h: number) => {
      const period = h < 12 ? "AM" : "PM";
      const displayHour = h % 12 === 0 ? 12 : h % 12;
      return `${displayHour}${period}`;
    };
    return `${label(best.hour)}–${label((best.hour + 1) % 24)}`;
  }, [orders, completedToday]);

  const completionRate = useMemo(() => {
    if (!orders || !completedToday) return null;
    const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
    const totalToday = orders.filter((o) => isToday(o.placedAt)).length + completedToday.length;
    if (totalToday === 0) return null;
    return Math.round((completedToday.length / totalToday) * 100);
  }, [orders, completedToday]);

  const recentActivity = useMemo(() => {
    if (!orders || !completedToday) return [];
    return [...orders, ...completedToday]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 6);
  }, [orders, completedToday]);

  // Stats for the selected past date — every order for that day is already
  // in a terminal state, so this is a straight reduce over historyOrders
  // rather than the active+completed split the live view needs.
  const historyCompleted = useMemo(() => historyOrders?.filter((o) => o.status === "completed") ?? [], [historyOrders]);
  const historyRevenue = useMemo(
    () => historyCompleted.reduce((sum, o) => sum + Number(o.totalAmount), 0),
    [historyCompleted],
  );
  const historyAvgPrepMinutes = useMemo(() => {
    if (historyCompleted.length === 0) return null;
    const total = historyCompleted.reduce(
      (sum, o) => sum + (new Date(o.updatedAt).getTime() - new Date(o.placedAt).getTime()),
      0,
    );
    return Math.round(total / historyCompleted.length / 60_000);
  }, [historyCompleted]);
  const historyCompletionRate = useMemo(() => {
    if (!historyOrders || historyOrders.length === 0) return null;
    return Math.round((historyCompleted.length / historyOrders.length) * 100);
  }, [historyOrders, historyCompleted]);

  return (
    <Shell navItems={NAV_ITEMS} activeKey={tab} onNavigate={(k) => setTab(k as "orders" | "offers" | "analytics" | "ai")} roleLabel="Stall Owner">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {tab === "analytics" ? (
        <OwnerAnalyticsTab stallId={stallId} stallName={currentStall?.name} />
      ) : tab === "ai" ? (
        <AskAiPanel
          title="Ask AI about your stall"
          subtitle={currentStall ? `Answers use only ${currentStall.name}'s own data.` : undefined}
          suggestions={OWNER_AI_SUGGESTIONS}
          disabled={!stallId}
          ask={(question) => api<{ answer: string }>(`/api/owner/stalls/${stallId}/ai-assistant`, { method: "POST", body: { question } })}
        />
      ) : tab === "offers" ? (
        <OffersTab stallId={stallId} stallName={currentStall?.name} />
      ) : (
      <>
      <div className="page-hero">
        <div className="page-hero-row">
          <div className="row" style={{ gap: "0.9rem", alignItems: "flex-start" }}>
            <PageHead
              title={currentStall ? currentStall.name : "Orders"}
              subtitle={currentStall ? `${currentStall.block} · ${isToday ? "live order queue" : `orders on ${selectedDate}`}` : undefined}
            />
            {currentStall && (
              <span
                className={`pill ${currentStall.status === "active" ? "active" : "paused"}`}
                style={{ marginTop: "0.3rem" }}
              >
                {currentStall.status === "active" ? "Live" : "Paused"}
              </span>
            )}
          </div>
          <div className="row" style={{ gap: "0.6rem" }}>
            <input
              type="date"
              value={selectedDate}
              max={todayIstStr()}
              onChange={(e) => setSelectedDate(e.target.value || todayIstStr())}
              style={{ width: "auto" }}
              aria-label="View orders for date"
            />
            {!isToday && (
              <button type="button" onClick={() => setSelectedDate(todayIstStr())}>
                Today
              </button>
            )}
            {stalls && stalls.length > 1 && (
              <select
                value={stallId ?? ""}
                onChange={(e) => setStallId(e.target.value)}
                style={{ width: "auto", minWidth: 200 }}
              >
                {stalls.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.block})
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {isToday ? (
      <>
      <div className="stat-row">
        <StatCard
          icon={Clock3}
          label="Needs attention"
          tone="warn"
          value={orders ? needsAttention.length : <Skeleton width={32} height={28} />}
        />
        <StatCard
          icon={Flame}
          label="Preparing"
          tone="accent"
          value={orders ? preparing.length : <Skeleton width={32} height={28} />}
        />
        <StatCard
          icon={BellRing}
          label="Ready for pickup"
          tone="success"
          value={orders ? ready.length : <Skeleton width={32} height={28} />}
        />
        <StatCard
          icon={Timer}
          label="Next pickup"
          tone="info"
          value={nextPickup ? nextPickup.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
        />
        <StatCard
          icon={IndianRupee}
          label="Revenue today"
          tone="success"
          value={<AnimatedNumber value={revenueToday} prefix="₹" />}
        />
        <StatCard
          icon={ListChecks}
          label="Completed today"
          tone="accent"
          value={completedToday ? completedToday.length : <Skeleton width={32} height={28} />}
          sub={avgPrepMinutes != null ? `~${avgPrepMinutes}m avg` : undefined}
        />
      </div>

      <div className="section-label">Order SLA &amp; Accountability</div>
      <div className="stat-row">
        <StatCard
          icon={Hourglass}
          label="Avg. acceptance time"
          tone="info"
          value={slaMetrics ? formatAcceptanceTime(slaMetrics.avgAcceptanceSeconds) : <Skeleton width={48} height={28} />}
        />
        <StatCard
          icon={XCircle}
          label="Missed acceptance deadlines"
          tone={slaMetrics && slaMetrics.missedAcceptanceDeadlines > 0 ? "warn" : "accent"}
          value={slaMetrics ? slaMetrics.missedAcceptanceDeadlines : <Skeleton width={32} height={28} />}
        />
        <StatCard
          icon={ShieldAlert}
          label="SLA violations"
          tone={slaMetrics && slaMetrics.slaViolations > 0 ? "warn" : "accent"}
          value={slaMetrics ? slaMetrics.slaViolations : <Skeleton width={32} height={28} />}
        />
        <StatCard
          icon={CheckCircle2}
          label="On-time preparation rate"
          tone="success"
          value={
            slaMetrics
              ? slaMetrics.onTimePreparationRate != null
                ? `${slaMetrics.onTimePreparationRate}%`
                : "—"
              : <Skeleton width={48} height={28} />
          }
        />
        <StatCard
          icon={UserX}
          label="Customer no-shows"
          tone="accent"
          value={slaMetrics ? slaMetrics.customerNoShows : <Skeleton width={32} height={28} />}
        />
      </div>

      <div className="owner-layout">
        <div className="owner-main">
          {orders === null && (
            <div className="card stack">
              <Skeleton height={20} />
              <Skeleton height={20} width="70%" />
            </div>
          )}

          {orders !== null && (
            <>
              <QueueSection
                title="Needs attention"
                tone="attention"
                icon={AlertTriangle}
                orders={needsAttention}
                actingOn={actingOn}
                onAct={act}
                emptyText="No orders waiting on a response."
              />
              <QueueSection
                title="Preparing"
                tone="default"
                icon={Flame}
                orders={preparing}
                actingOn={actingOn}
                onAct={act}
                emptyText="Nothing in the kitchen right now."
              />
              <QueueSection
                title="Ready for pickup"
                tone="ready"
                icon={BellRing}
                orders={ready}
                actingOn={actingOn}
                onAct={act}
                emptyText="Nothing ready and waiting yet."
              />
            </>
          )}

          {completedToday !== null && completedToday.length > 0 && (
            <div className="queue-section">
              <button className="completed-toggle" onClick={() => setShowCompleted((v) => !v)}>
                <span className="row" style={{ gap: "0.6rem" }}>
                  <ListChecks size={16} strokeWidth={2} />
                  <strong>Completed today</strong>
                  <span className="queue-section-head ready" style={{ margin: 0 }}>
                    <span className="count">{completedToday.length}</span>
                  </span>
                </span>
                <motion.span
                  animate={{ rotate: showCompleted ? 180 : 0 }}
                  transition={{ duration: 0.2 }}
                  style={{ display: "flex" }}
                >
                  <ChevronDown size={16} strokeWidth={2} />
                </motion.span>
              </button>
              <AnimatePresence initial={false}>
                {showCompleted && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: "easeOut" }}
                    style={{ overflow: "hidden" }}
                  >
                    <div className="stack" style={{ marginTop: "0.7rem" }}>
                      {completedToday.map((order) => (
                        <OrderCard key={order.id} order={order} muted />
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>

        <aside className="owner-sidebar">
          {currentStall && (
            <div className="card">
              <div className="card-title">Store status</div>
              <div className="row between" style={{ marginTop: "0.3rem" }}>
                <span className={`pill ${currentStall.status === "active" ? "active" : "paused"}`}>
                  {currentStall.status === "active" ? "Taking orders" : "Paused"}
                </span>
              </div>
              <div className="muted" style={{ fontSize: "0.82rem", margin: "0.5rem 0 0.8rem" }}>
                Students can{currentStall.status === "active" ? "" : "not"} currently order from you.
              </div>
              <button
                className={currentStall.status === "active" ? "" : "primary"}
                style={{ width: "100%" }}
                onClick={() => toggleStall(currentStall.status)}
              >
                {currentStall.status === "active" ? "Pause stall" : "Resume stall"}
              </button>
            </div>
          )}

          <div className="card">
            <div className="card-title">Today at a glance</div>
            <div className="sidebar-metric-row" style={{ marginTop: "0.5rem" }}>
              <div className="sidebar-metric">
                <div className="value">
                  <TrendingUp size={16} strokeWidth={2} color="var(--accent)" />
                  {peakHour ?? "—"}
                </div>
                <div className="label">Peak hour</div>
              </div>
              <div className="sidebar-metric">
                <div className="value">
                  <Target size={16} strokeWidth={2} color="var(--success)" />
                  {completionRate != null ? `${completionRate}%` : "—"}
                </div>
                <div className="label">Completion rate</div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-title row" style={{ gap: "0.35rem" }}>
              <Activity size={12} strokeWidth={2.5} /> Recent activity
            </div>
            {recentActivity.length === 0 ? (
              <div className="muted" style={{ fontSize: "0.85rem", marginTop: "0.4rem" }}>
                Nothing yet today.
              </div>
            ) : (
              <div className="recent-activity-list">
                {recentActivity.map((order) => (
                  <div className="recent-activity-row" key={order.id}>
                    <span
                      className="recent-activity-dot"
                      style={{
                        background:
                          order.status === "completed" ? "var(--success)" : "var(--accent)",
                      }}
                    />
                    <div className="recent-activity-body">
                      <div className="recent-activity-top">
                        <span>{order.student.name ?? order.student.whatsappNumber}</span>
                        <span className={`pill ${order.status}`}>{order.status}</span>
                      </div>
                      <div className="recent-activity-meta">
                        ₹{Number(order.totalAmount).toFixed(0)} · {relativeTime(order.updatedAt)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
      </>
      ) : (
      <>
        <div className="stat-row">
          <StatCard
            icon={ListChecks}
            label="Orders"
            tone="accent"
            value={historyOrders ? historyOrders.length : <Skeleton width={32} height={28} />}
          />
          <StatCard
            icon={IndianRupee}
            label="Revenue"
            tone="success"
            value={historyOrders ? <AnimatedNumber value={historyRevenue} prefix="₹" /> : <Skeleton width={48} height={28} />}
          />
          <StatCard
            icon={CheckCircle2}
            label="Completed"
            tone="accent"
            value={historyOrders ? historyCompleted.length : <Skeleton width={32} height={28} />}
            sub={historyAvgPrepMinutes != null ? `~${historyAvgPrepMinutes}m avg` : undefined}
          />
          <StatCard
            icon={Target}
            label="Completion rate"
            tone="success"
            value={historyCompletionRate != null ? `${historyCompletionRate}%` : historyOrders ? "—" : <Skeleton width={48} height={28} />}
          />
        </div>

        <div className="section-label">Order SLA &amp; Accountability</div>
        <div className="stat-row">
          <StatCard
            icon={Hourglass}
            label="Avg. acceptance time"
            tone="info"
            value={historySla ? formatAcceptanceTime(historySla.avgAcceptanceSeconds) : <Skeleton width={48} height={28} />}
          />
          <StatCard
            icon={XCircle}
            label="Missed acceptance deadlines"
            tone={historySla && historySla.missedAcceptanceDeadlines > 0 ? "warn" : "accent"}
            value={historySla ? historySla.missedAcceptanceDeadlines : <Skeleton width={32} height={28} />}
          />
          <StatCard
            icon={ShieldAlert}
            label="SLA violations"
            tone={historySla && historySla.slaViolations > 0 ? "warn" : "accent"}
            value={historySla ? historySla.slaViolations : <Skeleton width={32} height={28} />}
          />
          <StatCard
            icon={CheckCircle2}
            label="On-time preparation rate"
            tone="success"
            value={
              historySla
                ? historySla.onTimePreparationRate != null
                  ? `${historySla.onTimePreparationRate}%`
                  : "—"
                : <Skeleton width={48} height={28} />
            }
          />
          <StatCard
            icon={UserX}
            label="Customer no-shows"
            tone="accent"
            value={historySla ? historySla.customerNoShows : <Skeleton width={32} height={28} />}
          />
        </div>

        <div className="owner-main">
          {historyLoading && historyOrders === null && (
            <div className="card stack">
              <Skeleton height={20} />
              <Skeleton height={20} width="70%" />
            </div>
          )}
          {historyOrders !== null && historyOrders.length === 0 && (
            <div className="card muted" style={{ textAlign: "center", padding: "2rem" }}>
              No orders were placed on {selectedDate}.
            </div>
          )}
          {historyOrders !== null && historyOrders.length > 0 && (
            <div className="stack">
              {historyOrders.map((order) => (
                <OrderCard key={order.id} order={order} muted />
              ))}
            </div>
          )}
        </div>
      </>
      )}
      </>
      )}

      {tab === "orders" && (
      <>
      <div className="section-label">Ratings &amp; Feedback</div>
      <div className="stat-row">
        <StatCard
          icon={Star}
          label="Average rating"
          tone="success"
          value={ratingDetail ? (ratingDetail.average != null ? `${ratingDetail.average} ★` : "—") : <Skeleton width={48} height={28} />}
        />
        <StatCard
          icon={ListChecks}
          label="Total ratings"
          tone="accent"
          value={ratingDetail ? ratingDetail.count : <Skeleton width={32} height={28} />}
        />
        {["food_quality", "service", "pickup_delay"].map((key) => (
          <StatCard
            key={key}
            icon={AlertTriangle}
            label={RATING_REASON_LABEL[key]}
            tone="warn"
            value={ratingDetail ? ratingDetail.breakdown.find((b) => b.reason === key)?.count ?? 0 : <Skeleton width={32} height={28} />}
          />
        ))}
      </div>

      <div className="card">
        <div className="card-title row" style={{ gap: "0.35rem" }}>
          <MessageSquareText size={12} strokeWidth={2.5} /> Recent feedback
        </div>
        {!ratingDetail || ratingDetail.recentComments.length === 0 ? (
          <div className="muted" style={{ fontSize: "0.85rem", marginTop: "0.4rem" }}>
            No comments yet.
          </div>
        ) : (
          <div className="stack" style={{ marginTop: "0.6rem" }}>
            {ratingDetail.recentComments.map((c, i) => (
              <div key={i} className="card" style={{ padding: "0.7rem 0.9rem" }}>
                <div className="row between">
                  <span>{"⭐".repeat(c.stars)}</span>
                  <span className="muted" style={{ fontSize: "0.78rem" }}>{relativeTime(c.createdAt)}</span>
                </div>
                {c.reason && (
                  <div className="muted" style={{ fontSize: "0.8rem", marginTop: "0.2rem" }}>
                    {RATING_REASON_LABEL[c.reason] ?? c.reason}
                  </div>
                )}
                {c.comment && <div style={{ marginTop: "0.3rem" }}>{c.comment}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
      </>
      )}

      {undoToastNode}
    </Shell>
  );
}

function QueueSection({
  title,
  tone,
  icon: Icon,
  orders,
  actingOn,
  onAct,
  emptyText,
}: {
  title: string;
  tone: "attention" | "ready" | "default";
  icon: typeof AlertTriangle;
  orders: Order[];
  actingOn: string | null;
  onAct: (orderId: string, status: string) => void;
  emptyText: string;
}) {
  return (
    <div className="queue-section">
      <div className={`queue-section-head${tone !== "default" ? ` ${tone}` : ""}`}>
        <span className="icon">
          <Icon size={16} strokeWidth={2} />
        </span>
        <span className="title">{title}</span>
        <span className="count">{orders.length}</span>
      </div>
      {orders.length === 0 ? (
        <div className="queue-empty-row">{emptyText}</div>
      ) : (
        <div className="stack">
          <AnimatePresence>
            {orders.map((order, i) => (
              <OrderCard key={order.id} order={order} index={i} actingOn={actingOn} onAct={onAct} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function OrderCard({
  order,
  index = 0,
  actingOn,
  onAct,
  muted = false,
}: {
  order: Order;
  index?: number;
  actingOn?: string | null;
  onAct?: (orderId: string, status: string) => void;
  muted?: boolean;
}) {
  // Prefer the real accept deadline (exact SLA commitment) when present;
  // older rows created before this field existed fall back to the old
  // age-based approximation.
  const isUrgent =
    order.status === "placed" &&
    (order.acceptDeadline
      ? Date.now() > new Date(order.acceptDeadline).getTime()
      : Date.now() - new Date(order.placedAt).getTime() > URGENT_MINUTES * 60_000);

  return (
    <motion.div
      layout
      key={order.id}
      className={`card order-card status-${order.status}${isUrgent ? " urgent" : ""}`}
      style={muted ? { opacity: 0.75 } : undefined}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: muted ? 0.75 : 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.04, 0.3) }}
      whileHover={muted ? undefined : { y: -3, boxShadow: "0 12px 28px rgba(20,24,27,0.1)" }}
    >
      <div className="row between">
        <span className="row" style={{ gap: "0.5rem" }}>
          <span className={`pill ${order.status}`}>{order.status}</span>
          {isUrgent && (
            <span className="urgent-badge">
              <AlertTriangle size={12} strokeWidth={2.5} /> Waiting {relativeTime(order.placedAt)}
            </span>
          )}
          {order.slaViolation && (
            <span className="sla-badge violation" title="Marked ready after the pickup slot ended">
              <ShieldAlert size={12} strokeWidth={2.5} />
              SLA {order.slaViolationMinutes != null ? `+${order.slaViolationMinutes}m` : "violation"}
            </span>
          )}
          {order.noShow && (
            <span className="sla-badge no-show" title="Never collected within the pickup slot + grace period">
              <UserX size={12} strokeWidth={2.5} /> No-show
            </span>
          )}
        </span>
        <span className="pickup-badge">
          <Clock3 size={13} strokeWidth={2.25} />
          {new Date(order.pickupSlot.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      <div className="row between order-meta-row">
        <span className="order-display-id">#{order.displayId}</span>
        <span className="muted">Placed At: {formatPlacedAt(order.placedAt)}</span>
      </div>
      <ul className="order-item-list">
        {order.items.map((item) => (
          <li key={item.id} className="order-item-row">
            <span className="row" style={{ gap: 0 }}>
              <span className="order-item-qty">{item.quantity}×</span>
              {item.itemNameSnapshot}
            </span>
            <span>₹{Number(item.unitPrice) * item.quantity}</span>
          </li>
        ))}
      </ul>
      <div className="row between">
        <span className="order-total-chip">₹{Number(order.totalAmount).toFixed(2)}</span>
        <span className="muted">{order.student.name ?? order.student.whatsappNumber}</span>
      </div>
      {onAct && NEXT_ACTIONS[order.status].length > 0 && (
        <div className="row" style={{ marginTop: "0.9rem" }}>
          {NEXT_ACTIONS[order.status].map((action) => {
            const key = `${order.id}:${action.status}`;
            const isActing = actingOn === key;
            return (
              <button
                key={action.status}
                className={`${action.variant} big`}
                disabled={actingOn !== null}
                onClick={() => onAct(order.id, action.status)}
              >
                {isActing && <span className="spinner" />}
                {isActing ? "Updating…" : action.label}
              </button>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}

type Period = "today" | "week" | "month" | "custom";

interface OwnerAnalytics {
  stall: { name: string; block: string };
  range: { period: Period; since: string; until: string };
  revenue: number;
  totalOrders: number;
  avgOrderValue: number;
  newCustomers: number;
  returningCustomers: number;
  repeatCustomerRatePct: number;
  bestSellingItems: { name: string; qty: number; revenue: number }[];
  worstSellingItems: { name: string; qty: number; revenue: number }[];
  categoryPerformance: { category: string; qty: number; revenue: number }[];
  comboPerformance: { id: string; name: string; usageCount: number; totalDiscountGiven: number }[];
  peakHours: { hour: number; count: number }[];
  sla: {
    avgAcceptanceSeconds: number | null;
    missedAcceptanceDeadlines: number;
    slaViolations: number;
    onTimePreparationRate: number | null;
    customerNoShows: number;
  };
  avgPrepMinutes: number | null;
  cancellationRatePct: number;
  noShowRatePct: number;
  ratingTrend: { day: string; average: number; count: number }[];
  rating: { average: number | null; count: number };
  revenueTrend: { day: string; revenue: number; orders: number }[];
  offers: {
    performance: { id: string; name: string; usageCount: number; totalDiscountGiven: number }[];
    revenueGeneratedByOffers: number;
    discountGiven: number;
    bestPerformingOffer: { name: string; usageCount: number } | null;
  };
}

function hourLabel(utcHour: number): string {
  // Owner/admin analytics buckets by UTC hour internally; display converts to IST (UTC+5:30) for readability.
  const istHour = Math.floor((utcHour * 60 + 330) / 60) % 24;
  const period = istHour < 12 ? "AM" : "PM";
  const display = istHour % 12 === 0 ? 12 : istHour % 12;
  return `${display}${period}`;
}

function PeriodPicker({
  period,
  setPeriod,
  from,
  setFrom,
  to,
  setTo,
}: {
  period: Period;
  setPeriod: (p: Period) => void;
  from: string;
  setFrom: (v: string) => void;
  to: string;
  setTo: (v: string) => void;
}) {
  return (
    <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
      {(["today", "week", "month", "custom"] as Period[]).map((p) => (
        <button key={p} className={period === p ? "primary small" : "ghost small"} onClick={() => setPeriod(p)}>
          {p === "today" ? "Today" : p === "week" ? "Week" : p === "month" ? "Month" : "Custom"}
        </button>
      ))}
      {period === "custom" && (
        <>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: "auto" }} />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: "auto" }} />
        </>
      )}
    </div>
  );
}

function ExportButtons({ onExport }: { onExport: (format: "csv" | "xlsx" | "pdf") => void }) {
  return (
    <div className="row" style={{ gap: "0.4rem" }}>
      <button className="ghost small" onClick={() => onExport("csv")}>Export CSV</button>
      <button className="ghost small" onClick={() => onExport("xlsx")}>Export Excel</button>
      <button className="ghost small" onClick={() => onExport("pdf")}>Export PDF</button>
    </div>
  );
}

function OwnerAnalyticsTab({ stallId, stallName }: { stallId: string | null; stallName: string | undefined }) {
  const [period, setPeriod] = useState<Period>("today");
  const [from, setFrom] = useState(() => new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<OwnerAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = period === "custom" ? `period=custom&from=${from}&to=${to}` : `period=${period}`;

  useEffect(() => {
    if (!stallId) return;
    if (period === "custom" && (!from || !to)) return;
    setData(null);
    api<OwnerAnalytics>(`/api/owner/stalls/${stallId}/analytics?${query}`).then(setData).catch((e) => setError(e.message));
  }, [stallId, query, period, from, to]);

  async function handleExport(format: "csv" | "xlsx" | "pdf") {
    if (!stallId) return;
    try {
      await downloadFile(`/api/owner/stalls/${stallId}/analytics/export?${query}&format=${format}`, `analytics.${format}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    }
  }

  return (
    <>
      <div className="page-hero">
        <div className="page-hero-row">
          <PageHead title="Analytics" subtitle={stallName ? `Deep-dive metrics for ${stallName}` : undefined} />
          <ExportButtons onExport={handleExport} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <PeriodPicker period={period} setPeriod={setPeriod} from={from} setFrom={setFrom} to={to} setTo={setTo} />
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <div className="stat-row">
        <StatCard icon={IndianRupee} label="Revenue" tone="success" value={data ? <AnimatedNumber value={data.revenue} prefix="₹" /> : <Skeleton width={60} height={28} />} />
        <StatCard icon={Receipt} label="Total orders" tone="accent" value={data ? data.totalOrders : <Skeleton width={32} height={28} />} />
        <StatCard icon={IndianRupee} label="Avg order value" tone="info" value={data ? `₹${data.avgOrderValue}` : <Skeleton width={48} height={28} />} />
        <StatCard icon={Users} label="New / Returning" tone="accent" value={data ? `${data.newCustomers} / ${data.returningCustomers}` : <Skeleton width={48} height={28} />} sub={data ? `${data.repeatCustomerRatePct}% repeat` : undefined} />
        <StatCard icon={Star} label="Avg rating" tone="success" value={data ? (data.rating.average ?? "—") : <Skeleton width={32} height={28} />} sub={data ? `${data.rating.count} ratings` : undefined} />
      </div>

      <div className="stat-row">
        <StatCard icon={Hourglass} label="Avg acceptance" tone="info" value={data ? formatAcceptanceTime(data.sla.avgAcceptanceSeconds) : <Skeleton width={48} height={28} />} />
        <StatCard icon={Flame} label="Avg prep time" tone="accent" value={data ? (data.avgPrepMinutes != null ? `${data.avgPrepMinutes}m` : "—") : <Skeleton width={32} height={28} />} />
        <StatCard icon={CheckCircle2} label="On-time prep rate" tone="success" value={data ? (data.sla.onTimePreparationRate != null ? `${data.sla.onTimePreparationRate}%` : "—") : <Skeleton width={48} height={28} />} />
        <StatCard icon={XCircle} label="Cancellation rate" tone={data && data.cancellationRatePct > 0 ? "warn" : "accent"} value={data ? `${data.cancellationRatePct}%` : <Skeleton width={32} height={28} />} />
        <StatCard icon={UserX} label="No-show rate" tone={data && data.noShowRatePct > 0 ? "warn" : "accent"} value={data ? `${data.noShowRatePct}%` : <Skeleton width={32} height={28} />} />
      </div>

      <div className="overview-grid">
        <div className="stack">
          <div className="card">
            <div className="card-title">Revenue trend</div>
            <TrendLine data={data?.revenueTrend.map((d) => ({ day: d.day, value: d.revenue })) ?? []} valueFormatter={(v) => `₹${v}`} />
          </div>
          <div className="card">
            <div className="card-title">Peak hours</div>
            <BarChart data={data?.peakHours.map((h) => ({ label: hourLabel(h.hour), value: h.count })) ?? []} />
          </div>
          <div className="card">
            <div className="card-title">Category performance (by revenue)</div>
            <BarChart data={data?.categoryPerformance.map((c) => ({ label: c.category, value: c.revenue })) ?? []} valueFormatter={(v) => `₹${v}`} />
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-title">Best selling items</div>
            <BarChart data={data?.bestSellingItems.map((i) => ({ label: i.name, value: i.qty })) ?? []} />
          </div>
          <div className="card">
            <div className="card-title">Worst selling items</div>
            <BarChart data={data?.worstSellingItems.map((i) => ({ label: i.name, value: i.qty })) ?? []} />
          </div>
          <div className="card">
            <div className="card-title">Rating trend</div>
            <TrendLine data={data?.ratingTrend.map((r) => ({ day: r.day, value: r.average })) ?? []} valueFormatter={(v) => `${v}★`} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Offer performance</div>
        <div className="stat-row" style={{ marginTop: "0.5rem" }}>
          <StatCard icon={IndianRupee} label="Revenue from offers" tone="success" value={data ? `₹${data.offers.revenueGeneratedByOffers}` : <Skeleton width={48} height={28} />} />
          <StatCard icon={Tag} label="Discount given" tone="warn" value={data ? `₹${data.offers.discountGiven}` : <Skeleton width={48} height={28} />} />
          <StatCard icon={Star} label="Best performing offer" tone="accent" value={data ? (data.offers.bestPerformingOffer?.name ?? "—") : <Skeleton width={64} height={28} />} sub={data?.offers.bestPerformingOffer ? `${data.offers.bestPerformingOffer.usageCount} uses` : undefined} />
        </div>
        {data?.comboPerformance && data.comboPerformance.length > 0 && (
          <>
            <div className="muted" style={{ fontSize: "0.85rem", margin: "0.8rem 0 0.4rem" }}>Combo offers</div>
            <BarChart data={data.comboPerformance.map((c) => ({ label: c.name, value: c.usageCount }))} />
          </>
        )}
      </div>
    </>
  );
}

function AskAiPanel({
  title,
  subtitle,
  suggestions,
  disabled,
  ask,
}: {
  title: string;
  subtitle?: string;
  suggestions: string[];
  disabled?: boolean;
  ask: (question: string) => Promise<{ answer: string }>;
}) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<{ question: string; answer: string }[]>([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(q: string) {
    const trimmed = q.trim();
    if (!trimmed || asking) return;
    setAsking(true);
    setError(null);
    setQuestion("");
    try {
      const { answer } = await ask(trimmed);
      setMessages((prev) => [...prev, { question: trimmed, answer }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not get an answer — please try again.");
    } finally {
      setAsking(false);
    }
  }

  return (
    <>
      <div className="page-hero">
        <PageHead title={title} subtitle={subtitle} />
      </div>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
          {suggestions.map((s) => (
            <button key={s} className="ghost small" disabled={disabled || asking} onClick={() => submit(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <div className="stack" style={{ marginBottom: "1rem" }}>
        {messages.map((m, i) => (
          <div key={i} className="card">
            <div style={{ fontWeight: 600 }}>{m.question}</div>
            <div className="muted" style={{ marginTop: "0.5rem", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
              {m.answer}
            </div>
          </div>
        ))}
        {asking && (
          <div className="card muted">
            <span className="spinner" /> Thinking…
          </div>
        )}
        {messages.length === 0 && !asking && (
          <div className="card"><EmptyState icon={Bot} text="Ask a question above to get started." /></div>
        )}
      </div>

      <div className="row" style={{ gap: "0.6rem" }}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit(question)}
          placeholder="Ask a business question…"
          disabled={disabled || asking}
          style={{ flex: 1 }}
        />
        <button className="primary" onClick={() => submit(question)} disabled={disabled || asking || !question.trim()}>
          Ask
        </button>
      </div>
    </>
  );
}

function offerStatus(o: Offer): "active" | "scheduled" | "expired" | "inactive" {
  if (!o.active) return "inactive";
  const now = Date.now();
  if (new Date(o.validFrom).getTime() > now) return "scheduled";
  if (new Date(o.validUntil).getTime() < now) return "expired";
  return "active";
}

function OffersTab({ stallId, stallName }: { stallId: string | null; stallName: string | undefined }) {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [analytics, setAnalytics] = useState<OfferAnalytic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Offer | "new" | null>(null);

  const load = useCallback(() => {
    if (!stallId) return;
    api<Offer[]>(`/api/owner/stalls/${stallId}/offers`).then(setOffers).catch((e) => setError(e.message));
    api<OfferAnalytic[]>(`/api/owner/stalls/${stallId}/offers/analytics`).then(setAnalytics).catch((e) => setError(e.message));
  }, [stallId]);

  useEffect(() => {
    setOffers(null);
    setAnalytics(null);
    load();
  }, [load]);

  async function toggleActive(offer: Offer) {
    if (!stallId) return;
    const action = offer.active ? "deactivate" : "activate";
    setOffers((prev) => prev?.map((o) => (o.id === offer.id ? { ...o, active: !offer.active } : o)) ?? null);
    try {
      await api(`/api/owner/stalls/${stallId}/offers/${offer.id}/${action}`, { method: "POST" });
    } catch (err) {
      setOffers((prev) => prev?.map((o) => (o.id === offer.id ? { ...o, active: offer.active } : o)) ?? null);
      setError(err instanceof Error ? err.message : "Could not update offer.");
    }
  }

  async function removeOffer(offerId: string) {
    if (!stallId || !window.confirm("Delete this offer? This cannot be undone.")) return;
    const prev = offers;
    setOffers((p) => p?.filter((o) => o.id !== offerId) ?? null);
    try {
      await api(`/api/owner/stalls/${stallId}/offers/${offerId}`, { method: "DELETE" });
    } catch (err) {
      setOffers(prev);
      setError(err instanceof Error ? err.message : "Could not delete offer.");
    }
  }

  const totalUsage = analytics?.reduce((s, a) => s + a.usageCount, 0) ?? 0;
  const totalDiscount = analytics?.reduce((s, a) => s + a.totalDiscountGiven, 0) ?? 0;
  const activeCount = offers?.filter((o) => offerStatus(o) === "active").length ?? 0;
  const scheduledCount = offers?.filter((o) => offerStatus(o) === "scheduled").length ?? 0;
  const expiredCount = offers?.filter((o) => offerStatus(o) === "expired").length ?? 0;
  const analyticsById = new Map((analytics ?? []).map((a) => [a.id, a]));

  return (
    <>
      <div className="page-hero">
        <div className="page-hero-row">
          <PageHead title="Offers & Promotions" subtitle={stallName ? `Manage discounts and deals for ${stallName}` : undefined} />
          <button className="primary" onClick={() => setEditing("new")} disabled={!stallId}>
            <Plus size={15} strokeWidth={2} /> New offer
          </button>
        </div>
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <div className="stat-row">
        <StatCard icon={Tag} label="Active offers" tone="success" value={offers ? activeCount : <Skeleton width={32} height={28} />} />
        <StatCard icon={Clock3} label="Scheduled" tone="info" value={offers ? scheduledCount : <Skeleton width={32} height={28} />} />
        <StatCard icon={XCircle} label="Expired" tone="warn" value={offers ? expiredCount : <Skeleton width={32} height={28} />} />
        <StatCard icon={ListChecks} label="Orders from offers" tone="accent" value={analytics ? totalUsage : <Skeleton width={32} height={28} />} />
        <StatCard icon={IndianRupee} label="Total discount given" tone="success" value={analytics ? <AnimatedNumber value={totalDiscount} prefix="₹" /> : <Skeleton width={48} height={28} />} />
      </div>

      {!offers && (
        <div className="card stack">
          <Skeleton height={20} />
          <Skeleton height={20} width="70%" />
        </div>
      )}

      {offers && offers.length === 0 && (
        <div className="card"><EmptyState icon={Tag} text="No offers yet — create one to start attracting more orders." /></div>
      )}

      {offers && offers.length > 0 && (
        <div className="stack">
          {offers.map((o) => {
            const status = offerStatus(o);
            const a = analyticsById.get(o.id);
            return (
              <div key={o.id} className="card">
                <div className="row between">
                  <span className="row" style={{ gap: "0.5rem" }}>
                    <strong>{o.name}</strong>
                    <span className={`pill ${status === "active" ? "active" : status === "expired" ? "cancelled" : "paused"}`}>{status}</span>
                  </span>
                  <div className="row" style={{ gap: "0.4rem" }}>
                    <button className="ghost small" onClick={() => setEditing(o)}>Edit</button>
                    <button className="ghost small" onClick={() => toggleActive(o)}>{o.active ? "Deactivate" : "Activate"}</button>
                    <button className="ghost small" onClick={() => removeOffer(o.id)} aria-label="Delete offer">
                      <Trash2 size={14} strokeWidth={2} />
                    </button>
                  </div>
                </div>
                <div className="muted" style={{ fontSize: "0.85rem", marginTop: "0.3rem" }}>
                  {OFFER_TYPE_LABEL[o.type] ?? o.type}
                  {o.description ? ` — ${o.description}` : ""}
                </div>
                <div className="muted" style={{ fontSize: "0.8rem", marginTop: "0.3rem" }}>
                  Valid {new Date(o.validFrom).toLocaleDateString()} – {new Date(o.validUntil).toLocaleDateString()}
                  {a ? ` · Used ${a.usageCount}× · ₹${a.totalDiscountGiven.toFixed(0)} discounted` : ""}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && stallId && (
        <OfferFormModal
          stallId={stallId}
          offer={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

const OFFER_TYPES = Object.keys(OFFER_TYPE_LABEL);

function OfferFormModal({
  stallId,
  offer,
  onClose,
  onSaved,
}: {
  stallId: string;
  offer: Offer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(offer?.name ?? "");
  const [description, setDescription] = useState(offer?.description ?? "");
  const [type, setType] = useState(offer?.type ?? "percentage_discount");
  const [validFrom, setValidFrom] = useState(offer?.validFrom ? offer.validFrom.slice(0, 10) : new Date().toISOString().slice(0, 10));
  const [validUntil, setValidUntil] = useState(offer?.validUntil ? offer.validUntil.slice(0, 10) : new Date().toISOString().slice(0, 10));
  const [minOrderValue, setMinOrderValue] = useState(offer?.minOrderValue ?? "");
  const [maxDiscount, setMaxDiscount] = useState(offer?.maxDiscount ?? "");
  const [discountPercent, setDiscountPercent] = useState(offer?.discountPercent?.toString() ?? "");
  const [discountFlat, setDiscountFlat] = useState(offer?.discountFlat ?? "");
  const [buyQuantity, setBuyQuantity] = useState(offer?.buyQuantity?.toString() ?? "");
  const [getQuantity, setGetQuantity] = useState(offer?.getQuantity?.toString() ?? "");
  const [happyHourStart, setHappyHourStart] = useState(offer?.happyHourStart ?? "");
  const [happyHourEnd, setHappyHourEnd] = useState(offer?.happyHourEnd ?? "");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const usesPercent = ["percentage_discount", "combo", "festival", "happy_hour"].includes(type);
  const usesFlat = ["flat_discount", "min_order_value"].includes(type);
  const usesBuyGet = type === "buy_x_get_y";
  const usesHappyHour = type === "happy_hour";

  async function save() {
    setFormError(null);
    if (!name.trim()) return setFormError("Name is required.");
    setSaving(true);
    try {
      const body = {
        name,
        description: description || undefined,
        type,
        validFrom: new Date(validFrom).toISOString(),
        validUntil: new Date(validUntil).toISOString(),
        minOrderValue: minOrderValue === "" ? null : Number(minOrderValue),
        maxDiscount: maxDiscount === "" ? null : Number(maxDiscount),
        discountPercent: discountPercent === "" ? null : Number(discountPercent),
        discountFlat: discountFlat === "" ? null : Number(discountFlat),
        buyQuantity: buyQuantity === "" ? null : Number(buyQuantity),
        getQuantity: getQuantity === "" ? null : Number(getQuantity),
        happyHourStart: happyHourStart || null,
        happyHourEnd: happyHourEnd || null,
      };
      if (offer) {
        await api(`/api/owner/stalls/${stallId}/offers/${offer.id}`, { method: "PATCH", body });
      } else {
        await api(`/api/owner/stalls/${stallId}/offers`, { method: "POST", body });
      }
      onSaved();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not save offer.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <motion.div className="slide-over-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div
        className="slide-over"
        role="dialog"
        aria-modal="true"
        aria-label={offer ? "Edit offer" : "New offer"}
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ duration: 0.28, ease: "easeOut" }}
      >
        <div className="slide-over-header">
          <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>{offer ? "Edit offer" : "New offer"}</div>
        </div>
        <div className="slide-over-body">
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekend 20% Off" />
          </div>
          <div className="field">
            <label>Description</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </div>
          <div className="field">
            <label>Offer type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {OFFER_TYPES.map((t) => (
                <option key={t} value={t}>{OFFER_TYPE_LABEL[t]}</option>
              ))}
            </select>
          </div>
          <div className="row" style={{ gap: "0.6rem" }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Valid from</label>
              <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Valid until</label>
              <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          </div>
          {usesPercent && (
            <div className="field">
              <label>Discount percent</label>
              <input type="number" min={0} max={100} value={discountPercent} onChange={(e) => setDiscountPercent(e.target.value)} />
            </div>
          )}
          {usesFlat && (
            <div className="field">
              <label>Flat discount (₹)</label>
              <input type="number" min={0} value={discountFlat} onChange={(e) => setDiscountFlat(e.target.value)} />
            </div>
          )}
          {usesBuyGet && (
            <div className="row" style={{ gap: "0.6rem" }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Buy quantity</label>
                <input type="number" min={1} value={buyQuantity} onChange={(e) => setBuyQuantity(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Get quantity free</label>
                <input type="number" min={1} value={getQuantity} onChange={(e) => setGetQuantity(e.target.value)} />
              </div>
            </div>
          )}
          {usesHappyHour && (
            <div className="row" style={{ gap: "0.6rem" }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Happy hour start</label>
                <input type="time" value={happyHourStart} onChange={(e) => setHappyHourStart(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Happy hour end</label>
                <input type="time" value={happyHourEnd} onChange={(e) => setHappyHourEnd(e.target.value)} />
              </div>
            </div>
          )}
          <div className="field">
            <label>Minimum order value (₹, optional)</label>
            <input type="number" min={0} value={minOrderValue} onChange={(e) => setMinOrderValue(e.target.value)} />
          </div>
          <div className="field">
            <label>Maximum discount (₹, optional)</label>
            <input type="number" min={0} value={maxDiscount} onChange={(e) => setMaxDiscount(e.target.value)} />
          </div>
          {formError && <div className="field-error">{formError}</div>}
        </div>
        <div className="slide-over-foot">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" style={{ flex: 1 }} disabled={saving} onClick={save}>
            {saving && <span className="spinner" />}
            {saving ? "Saving…" : "Save offer"}
          </button>
        </div>
      </motion.div>
    </>
  );
}
