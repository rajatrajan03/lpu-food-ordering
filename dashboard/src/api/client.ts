const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

export type Role = "stall_owner" | "super_admin";

export function getAuth(): { token: string; role: Role; name: string } | null {
  const raw = localStorage.getItem("auth");
  return raw ? JSON.parse(raw) : null;
}

export function setAuth(token: string, role: Role, name: string) {
  localStorage.setItem("auth", JSON.stringify({ token, role, name }));
}

export function clearAuth() {
  localStorage.removeItem("auth");
}

async function request<T>(path: string, options: { method?: string; body?: unknown }): Promise<T> {
  const auth = getAuth();
  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

// GET requests are safe to retry silently — a free-tier pooled DB connection
// occasionally has a momentary blip, and there's no reason to surface that to
// the user if a single retry clears it. Writes (POST/PATCH/...) are never
// retried here since re-sending one that actually succeeded could double it up.
export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const isGet = !options.method || options.method === "GET";
  try {
    return await request<T>(path, options);
  } catch (err) {
    if (!isGet) throw err;
    await new Promise((r) => setTimeout(r, 400));
    return request<T>(path, options);
  }
}
