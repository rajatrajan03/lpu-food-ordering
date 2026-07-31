import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async route handler so a rejected promise is forwarded to Express's
 * error handling instead of becoming an unhandled rejection — which, left
 * unwrapped, crashes the entire Node process on any transient failure (e.g. a
 * momentary DB connection blip), not just the one request.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
