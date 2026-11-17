// ============================================================
// AUTHENTICATION, AUTHORIZATION & SINGLE-DEVICE SESSION MIDDLEWARE
// ============================================================

import type { Request, Response, NextFunction } from 'express';
import { adminAuth } from '../firebase.js';
import { userRepo } from '../repositories/firestoreRepository.js';
import { HttpError } from './errorHandler.js';
import {
  validateAndTouchSession,
  verifySignedSessionToken,
} from '../services/sessionService.js';
import type { ActiveSession, User, UserRole } from '../types/index.js';

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      authUser?: User;
      activeSession?: ActiveSession;
    }
  }
}

declare module 'express-session' {
  interface SessionData {
    userId: string;
    workspaceId: string;
    role: UserRole;
    fullName: string;
    sessionId: string;
  }
}

function getHeaderSessionId(req: Request): string {
  const h = req.headers['x-session-id'];
  if (Array.isArray(h)) return (h[0] || '').trim();
  return typeof h === 'string' ? h.trim() : '';
}

async function authenticateRequest(req: Request): Promise<{ user: User; session: ActiveSession }> {
  let candidateUid: string | null = null;
  let candidateEmail: string | null = null;
  let candidateSessionId: string | null = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const rawToken = authHeader.slice('Bearer '.length).trim();
    if (rawToken) {
      // 1. Signed HMAC backend session token
      const signedPayload = verifySignedSessionToken(rawToken);
      if (signedPayload) {
        candidateUid = signedPayload.uid;
        candidateSessionId = signedPayload.sessionId;
      } else if (adminAuth) {
        // 2. Firebase ID token (for Google Sign-In / Firebase Email Auth sessions)
        try {
          const decoded = await adminAuth.verifyIdToken(rawToken);
          candidateUid = decoded.uid;
          candidateEmail = decoded.email ? decoded.email.trim().toLowerCase() : null;
          candidateSessionId = getHeaderSessionId(req) || req.session?.sessionId || null;
        } catch {
          throw new HttpError(401, 'Invalid or expired authentication token.', 'INVALID_TOKEN');
        }
      }
    }
  }

  // 3. Fallback to Express session cookie
  if (!candidateUid && req.session?.userId) {
    candidateUid = req.session.userId;
    candidateSessionId = req.session.sessionId || getHeaderSessionId(req) || null;
  }

  if (!candidateUid) {
    throw new HttpError(401, 'Authentication required', 'UNAUTHENTICATED');
  }

  let user = await userRepo.findById(candidateUid);
  if (!user && candidateEmail) {
    user = await userRepo.findByEmail(candidateEmail);
  }

  if (!user) {
    throw new HttpError(401, 'Authenticated user record was not found.', 'USER_NOT_FOUND');
  }

  if (!user.active || user.accountStatus === 'deactivated') {
    throw new HttpError(403, 'Account is deactivated. Contact your Workspace Administrator.', 'ACCOUNT_DEACTIVATED');
  }

  if (!user.workspaceId) {
    throw new HttpError(403, 'Account is not assigned to any active Workspace.', 'WORKSPACE_MISSING');
  }

  if (!candidateSessionId) {
    throw new HttpError(401, 'Active session identifier is required. Please sign in again.', 'SESSION_ID_MISSING');
  }

  // Authoritative Firestore single-device & 30-min inactivity enforcement
  const activeSession = await validateAndTouchSession({
    uid: user.id,
    sessionId: candidateSessionId,
  });

  req.authUser = user;
  req.activeSession = activeSession;
  if (req.session) {
    req.session.userId = user.id;
    req.session.workspaceId = user.workspaceId;
    req.session.role = user.role;
    req.session.fullName = user.fullName;
    req.session.sessionId = activeSession.sessionId;
  }

  return { user, session: activeSession };
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    await authenticateRequest(req);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: UserRole[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const { user } = await authenticateRequest(req);
      if (!roles.includes(user.role)) {
        throw new HttpError(403, 'Insufficient permissions', 'FORBIDDEN');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export async function requireAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const { user } = await authenticateRequest(req);
    if (user.role !== 'admin') {
      throw new HttpError(403, 'Workspace Administrator access required', 'ADMIN_REQUIRED');
    }
    next();
  } catch (err) {
    next(err);
  }
}
