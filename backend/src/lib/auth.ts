import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

type Role = "super_admin" | "stall_owner";

export interface AuthPayload {
  id: string;
  role: Role;
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

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}

export function requireAuth(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid Authorization header." });
    }
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET) as AuthPayload;
      if (allowedRoles.length > 0 && !allowedRoles.includes(payload.role)) {
        return res.status(403).json({ error: "Not permitted for this role." });
      }
      req.auth = payload;
      next();
    } catch {
      return res.status(401).json({ error: "Invalid or expired token." });
    }
  };
}
