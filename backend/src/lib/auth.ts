import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger";

type Role = "super_admin" | "stall_owner";

export interface AuthPayload {
  id: string;
  role: Role;
  jti: string;
  exp: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-only-secret-change-me";
// Scopes tokens to this app specifically — a token minted for some other
// service (or forged without knowing to set these) is rejected outright,
// on top of the signature check.
const JWT_ISSUER = "lpu-food-ordering";
const JWT_AUDIENCE = "lpu-food-dashboard";

/**
 * In-memory revoked-token set for logout support. Deliberately not a DB
 * table or Redis — this app is a single Node process with no queue/worker
 * infra (see slaMonitor.ts for the same reasoning), and a JWT's own 12h
 * expiry already bounds how long a leaked-but-unrevoked token matters.
 * Known limitation: revocations are lost on process restart and wouldn't
 * be shared across instances if this service is ever scaled horizontally
 * — acceptable for the current single-instance Render deployment, same
 * caveat already documented for the SLA sweep.
 */
const revoked = new Map<string, number>(); // jti -> expiry (epoch seconds)

function pruneRevoked(): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [jti, exp] of revoked) {
    if (exp < now) revoked.delete(jti);
  }
}
setInterval(pruneRevoked, 10 * 60 * 1000).unref();

export function revokeToken(payload: Pick<AuthPayload, "jti" | "exp">): void {
  revoked.set(payload.jti, payload.exp);
}

export function signToken(payload: { id: string; role: Role }): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: "12h",
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    jwtid: randomUUID(),
  });
}

export function requireAuth(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid Authorization header." });
    }
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      }) as AuthPayload;

      if (revoked.has(payload.jti)) {
        return res.status(401).json({ error: "This session has been signed out — please log in again." });
      }
      if (allowedRoles.length > 0 && !allowedRoles.includes(payload.role)) {
        return res.status(403).json({ error: "Not permitted for this role." });
      }
      req.auth = payload;
      next();
    } catch (err) {
      logger.warn("auth.token_rejected", { reason: err instanceof Error ? err.message : "unknown", path: req.path });
      return res.status(401).json({ error: "Invalid or expired token." });
    }
  };
}
