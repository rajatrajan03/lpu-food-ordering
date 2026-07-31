import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Coffee,
  Eye,
  EyeOff,
  Lock,
  Mail,
  MessageCircle,
  Phone,
  Pizza,
  Radio,
  Sandwich,
  ShieldCheck,
  Soup,
  Sparkles,
  UtensilsCrossed,
  Zap,
} from "lucide-react";
import { api, setAuth, type Role } from "../api/client";

const DEMO_STATUSES: { label: string; color: string; soft: string }[] = [
  { label: "placed", color: "var(--warn)", soft: "var(--warn-soft)" },
  { label: "accepted", color: "var(--info)", soft: "var(--info-soft)" },
  { label: "preparing", color: "var(--warn)", soft: "var(--warn-soft)" },
  { label: "ready", color: "var(--success)", soft: "var(--success-soft)" },
];

function LiveOrderMockup() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % DEMO_STATUSES.length), 1800);
    return () => clearInterval(id);
  }, []);
  const current = DEMO_STATUSES[step];
  return (
    <div className="mini-order-card">
      <div className="head">
        <strong>Order #482 · Khao Piyo</strong>
        <AnimatePresence mode="wait">
          <motion.span
            key={current.label}
            className="mini-status-pill"
            style={{ background: current.soft, color: current.color }}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.25 }}
          >
            {current.label}
          </motion.span>
        </AnimatePresence>
      </div>
      <div className="rows">
        <div className="row-line"><span>2 × Veg Momos</span><span>₹160</span></div>
        <div className="row-line"><span>1 × Cold Coffee</span><span>₹90</span></div>
        <div className="row-line" style={{ color: "#14181b", fontWeight: 700, marginTop: "0.15rem" }}>
          <span>Total</span><span>₹250</span>
        </div>
      </div>
    </div>
  );
}

export default function Login() {
  const [role, setRole] = useState<Role>("stall_owner");
  const [identifier, setIdentifier] = useState(""); // phone or email
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const path = role === "stall_owner" ? "/api/auth/owner/login" : "/api/auth/admin/login";
      const body = role === "stall_owner" ? { phone: identifier, password } : { email: identifier, password };
      const data = await api<{ token: string; name: string }>(path, { method: "POST", body });
      setAuth(data.token, role, data.name);
      navigate(role === "stall_owner" ? "/owner" : "/admin");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-hero">
        {[
          { Icon: Pizza, top: "12%", left: "78%", size: 34, delay: 0 },
          { Icon: Coffee, top: "68%", left: "8%", size: 28, delay: 1.2 },
          { Icon: Soup, top: "82%", left: "72%", size: 30, delay: 0.6 },
          { Icon: Sandwich, top: "30%", left: "4%", size: 26, delay: 1.8 },
        ].map(({ Icon, top, left, size, delay }, i) => (
          <motion.div
            key={i}
            className="login-hero-float-icon"
            style={{ top, left }}
            animate={{ y: [0, -14, 0] }}
            transition={{ duration: 6, delay, repeat: Infinity, ease: "easeInOut" }}
          >
            <Icon size={size} strokeWidth={1.5} />
          </motion.div>
        ))}

        <div className="login-hero-content">
          <div className="brand" style={{ marginBottom: "2.2rem" }}>
            <div className="brand-mark" style={{ background: "rgba(255,255,255,0.18)", boxShadow: "none" }}>
              <UtensilsCrossed size={18} strokeWidth={2.25} />
            </div>
            <div className="brand-text" style={{ color: "white" }}>
              LPU Food Ordering
            </div>
          </div>
          <motion.h2
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          >
            Run your campus stall without lifting a menu.
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1, ease: "easeOut" }}
          >
            Students order entirely over WhatsApp. You just manage what comes in — accept, prepare, and hand it
            over.
          </motion.p>

          <motion.div
            className="chat-bubble-stack"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.25 }}
          >
            <div className="chat-bubble in">"Show me what's open near CSE Block"</div>
            <div className="chat-bubble out">Khao Piyo, Kitchen Ette, and 4 more are open. What are you in the mood for? 🍽️</div>
            <div className="chat-bubble in">"2 veg momos and a cold coffee, 6:30 pickup"</div>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.4 }}>
            <LiveOrderMockup />
          </motion.div>

          <div className="feature-chip-row">
            <span className="feature-chip"><MessageCircle size={13} strokeWidth={2.25} /> WhatsApp-native</span>
            <span className="feature-chip"><Sparkles size={13} strokeWidth={2.25} /> AI-powered ordering</span>
            <span className="feature-chip"><Radio size={13} strokeWidth={2.25} /> Live order queue</span>
          </div>
        </div>

        <div className="login-hero-foot">
          <ShieldCheck size={14} strokeWidth={2} />
          Secured with JWT sessions & hashed credentials
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
            <Zap size={13} strokeWidth={2.25} /> Built for LPU campus food stalls
          </span>
        </div>
      </div>

      <div className="login-form-side">
        <motion.div
          className="card login-card"
          initial={{ opacity: 0, y: 16, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          <div className="login-brand">
            <div className="brand-mark">
              <UtensilsCrossed size={18} strokeWidth={2.25} />
            </div>
            <div>
              <div className="brand-text">Welcome back</div>
              <div className="brand-sub">Sign in to continue</div>
            </div>
          </div>

          <div className="tabs" role="tablist" aria-label="Sign in as">
            <button
              type="button"
              role="tab"
              aria-selected={role === "stall_owner"}
              className={role === "stall_owner" ? "active" : ""}
              onClick={() => setRole("stall_owner")}
            >
              Stall Owner
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={role === "super_admin"}
              className={role === "super_admin" ? "active" : ""}
              onClick={() => setRole("super_admin")}
            >
              Super Admin
            </button>
          </div>

          <form onSubmit={handleSubmit} className="stack">
            <div className="field">
              <label>{role === "stall_owner" ? "Phone number" : "Email"}</label>
              <div className="field-icon-wrap">
                <span className="field-icon" aria-hidden>
                  {role === "stall_owner" ? <Phone size={15} strokeWidth={2} /> : <Mail size={15} strokeWidth={2} />}
                </span>
                <input
                  placeholder={role === "stall_owner" ? "e.g. 9876543210" : "you@example.com"}
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="field">
              <label>Password</label>
              <div className="field-icon-wrap">
                <span className="field-icon" aria-hidden>
                  <Lock size={15} strokeWidth={2} />
                </span>
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="toggle-visibility"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={15} strokeWidth={2} /> : <Eye size={15} strokeWidth={2} />}
                </button>
              </div>
            </div>
            {error && (
              <motion.div
                className="error-banner"
                role="alert"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
              >
                {error}
              </motion.div>
            )}
            <button type="submit" className="primary big" disabled={loading} style={{ marginTop: "0.35rem" }}>
              {loading && <span className="spinner" />}
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </motion.div>
      </div>
    </div>
  );
}
