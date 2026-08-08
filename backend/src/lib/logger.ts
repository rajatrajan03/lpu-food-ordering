/**
 * Minimal structured logger — single-line JSON per event, no external
 * dependency. Sits alongside the existing plain console.log/console.error
 * calls throughout the app (left as-is, per this app's "no redesign"
 * convention) rather than replacing them; use this specifically for
 * security-relevant and audit events so they're easy to grep/parse in
 * Render's log viewer.
 */
type Level = "info" | "warn" | "error";

function write(level: Level, event: string, meta: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (event: string, meta?: Record<string, unknown>) => write("info", event, meta),
  warn: (event: string, meta?: Record<string, unknown>) => write("warn", event, meta),
  error: (event: string, meta?: Record<string, unknown>) => write("error", event, meta),
};

/**
 * Audit trail for sensitive/administrative actions (logins, OTP, offer
 * CRUD, owner creation, stall status changes, etc.) — always `info` level
 * (an audit entry isn't itself an error) but tagged `audit: true` so it's
 * trivially filterable from routine request logs.
 */
export function auditLog(event: string, meta: Record<string, unknown>): void {
  write("info", event, { ...meta, audit: true });
}
