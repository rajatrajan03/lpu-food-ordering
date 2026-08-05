import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Flame,
  Hourglass,
  IndianRupee,
  ListChecks,
  Receipt,
  ShieldAlert,
  Target,
  Timer,
  TrendingUp,
  UserX,
  XCircle,
} from "lucide-react";
import { api } from "../api/client";
import {
  AnimatedNumber,
  PageHead,
  Shell,
  Skeleton,
  StatCard,
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
const NAV_ITEMS: NavItem[] = [{ key: "orders", label: "Orders", icon: Receipt }];

export default function OwnerDashboard() {
  const [stalls, setStalls] = useState<Stall[] | null>(null);
  const [stallId, setStallId] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [completedToday, setCompletedToday] = useState<Order[] | null>(null);
  const [slaMetrics, setSlaMetrics] = useState<SlaMetrics | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);
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

  useEffect(() => {
    if (!stallId) return;
    loadOrders(stallId);
    const interval = setInterval(() => loadOrders(stallId), 10_000);
    return () => clearInterval(interval);
  }, [stallId, loadOrders]);

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

  return (
    <Shell navItems={NAV_ITEMS} activeKey="orders" onNavigate={() => {}} roleLabel="Stall Owner">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <div className="page-hero">
        <div className="page-hero-row">
          <div className="row" style={{ gap: "0.9rem", alignItems: "flex-start" }}>
            <PageHead
              title={currentStall ? currentStall.name : "Orders"}
              subtitle={currentStall ? `${currentStall.block} · live order queue` : undefined}
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
