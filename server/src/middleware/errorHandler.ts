// ============================================================
// ERROR MIDDLEWARE
// ============================================================

import type { Request, Response, NextFunction } from 'express';

export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly code?: string;

  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = 'HttpError';
  }
}

export function errorHandler(
  err: Error & { statusCode?: number; code?: string },
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode =
    typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 500;

  if (statusCode >= 500) {
    console.error('[Error]', err.message, err.stack);
  } else {
    console.warn(`[HTTP ${statusCode}]`, err.message);
  }

  res.status(statusCode).json({
    success: false,
    error: err.message || 'Internal server error',
    ...(err.code ? { code: err.code } : {}),
  });
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ success: false, error: 'Route not found' });
}

// Async wrapper to catch errors in async route handlers
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
