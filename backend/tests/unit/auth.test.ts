import { describe, it, expect, vi } from "vitest";
import jwt from "jsonwebtoken";
import { signToken, requireAuth, revokeToken } from "../../src/lib/auth";

function mockReqRes(authHeader?: string) {
  const req: any = { headers: authHeader ? { authorization: authHeader } : {}, path: "/test" };
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

describe("lib/auth", () => {
  it("signs a token that requireAuth accepts and attaches req.auth", () => {
    const token = signToken({ id: "owner-1", role: "stall_owner" });
    const { req, res, next } = mockReqRes(`Bearer ${token}`);
    requireAuth("stall_owner")(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.auth).toMatchObject({ id: "owner-1", role: "stall_owner" });
    expect(req.auth.jti).toBeTypeOf("string");
  });

  it("rejects a request with no Authorization header", () => {
    const { req, res, next } = mockReqRes();
    requireAuth()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("rejects a malformed token", () => {
    const { req, res, next } = mockReqRes("Bearer not-a-real-jwt");
    requireAuth()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token signed with a different secret", () => {
    const forged = jwt.sign({ id: "hacker", role: "super_admin" }, "wrong-secret", { expiresIn: "1h" });
    const { req, res, next } = mockReqRes(`Bearer ${forged}`);
    requireAuth()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("enforces role restriction — a stall_owner token is rejected on a super_admin-only route", () => {
    const token = signToken({ id: "owner-2", role: "stall_owner" });
    const { req, res, next } = mockReqRes(`Bearer ${token}`);
    requireAuth("super_admin")(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("allows a role-unrestricted check (requireAuth()) for any authenticated role", () => {
    const token = signToken({ id: "admin-1", role: "super_admin" });
    const { req, res, next } = mockReqRes(`Bearer ${token}`);
    requireAuth()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects a revoked token even though its signature and role are valid", () => {
    const token = signToken({ id: "owner-3", role: "stall_owner" });
    const first = mockReqRes(`Bearer ${token}`);
    requireAuth("stall_owner")(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledOnce();

    revokeToken(first.req.auth);

    const second = mockReqRes(`Bearer ${token}`);
    requireAuth("stall_owner")(second.req, second.res, second.next);
    expect(second.next).not.toHaveBeenCalled();
    expect(second.res.statusCode).toBe(401);
  });

  it("two tokens signed for the same user get distinct jti values", () => {
    const a = signToken({ id: "same-user", role: "stall_owner" });
    const b = signToken({ id: "same-user", role: "stall_owner" });
    const ra = mockReqRes(`Bearer ${a}`);
    const rb = mockReqRes(`Bearer ${b}`);
    requireAuth()(ra.req, ra.res, ra.next);
    requireAuth()(rb.req, rb.res, rb.next);
    expect(ra.req.auth.jti).not.toBe(rb.req.auth.jti);
  });
});
