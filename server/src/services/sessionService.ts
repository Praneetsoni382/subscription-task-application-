// ============================================================
// SINGLE-DEVICE SESSION MANAGEMENT SERVICE (PART 10)
// Enforce one active session per individual account via activeSessions/{uid}
// ============================================================

import crypto from 'crypto';
import {
  SESSION_SECRET,
  SESSION_INACTIVITY_TIMEOUT_MS,
} from '../config.js';
import { runFirestoreTransaction } from '../firebase.js';
import { HttpError } from '../middleware/errorHandler.js';
import type { ActiveSession, UserRole } from '../types/index.js';

export interface SignedTokenPayload {
  uid: string;
  workspaceId: string;
  role: UserRole;
  sessionId: string;
  iat: number;
  exp: number;
}

function signHmac(dataB64: string): string {
  return crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(dataB64)
    .digest('base64url');
}

export function issueSignedSessionToken(payload: Omit<SignedTokenPayload, 'iat' | 'exp'>): string {
  const now = Date.now();
  const fullPayload: SignedTokenPayload = {
    ...payload,
    iat: now,
    exp: now + 24 * 60 * 60 * 1000, // hard 24h outer cap; inactivity enforced via activeSessions/{uid}
  };
  const encoded = Buffer.from(JSON.stringify(fullPayload), 'utf8').toString('base64url');
  const sig = signHmac(encoded);
  return `${encoded}.${sig}`;
}

export function verifySignedSessionToken(token: string): SignedTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;

  const expectedSig = signHmac(encoded);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedTokenPayload;
    if (!parsed || !parsed.uid || !parsed.workspaceId || !parsed.sessionId) return null;
    if (parsed.exp && parsed.exp <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function sanitizeDeviceLabel(rawLabel?: string, userAgent?: string): string {
  const candidate = (rawLabel || '').trim();
  if (candidate.length > 0) {
    return candidate.slice(0, 120);
  }
  const ua = (userAgent || '').trim();
  if (!ua) return 'Web Browser';
  if (ua.includes('Edg/')) return 'Microsoft Edge';
  if (ua.includes('Chrome/')) return 'Google Chrome';
  if (ua.includes('Firefox/')) return 'Mozilla Firefox';
  if (ua.includes('Safari/') && !ua.includes('Chrome/')) return 'Apple Safari';
  return ua.slice(0, 80);
}

/**
 * Atomically creates or reuses an active session for a user in `activeSessions/{uid}`.
 * - If an unexpired ACTIVE session exists for another sessionId, denies login with 409 Conflict.
 * - Expired, released, or matching-sessionId records allow establishing/refreshing the session.
 */
export async function createOrValidateSingleDeviceSession(params: {
  uid: string;
  workspaceId: string;
  requestedSessionId?: string;
  deviceLabel?: string;
}): Promise<ActiveSession> {
  const { uid, workspaceId, requestedSessionId, deviceLabel } = params;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const expiresAtIso = new Date(nowMs + SESSION_INACTIVITY_TIMEOUT_MS).toISOString();
  const nextSessionId = crypto.randomUUID();
  const label = sanitizeDeviceLabel(deviceLabel);

  return runFirestoreTransaction(async (tx, db) => {
    const ref = db.collection('activeSessions').doc(uid);
    const snap = await tx.get(ref);

    if (snap.exists) {
      const existing = snap.data() as ActiveSession;
      const existingExpiresMs = existing.expiresAt ? Date.parse(existing.expiresAt) : 0;
      const isExpired = !existingExpiresMs || existingExpiresMs <= nowMs;

      if (existing.status === 'ACTIVE' && !isExpired) {
        if (requestedSessionId && existing.sessionId === requestedSessionId) {
          const refreshed: ActiveSession = {
            ...existing,
            deviceLabel: label || existing.deviceLabel,
            lastActivityAt: nowIso,
            expiresAt: expiresAtIso,
          };
          tx.set(ref, refreshed);
          return refreshed;
        }

        throw new HttpError(
          409,
          `Account is already signed in on another active device (${existing.deviceLabel || 'another browser'}). Sign out from the active device or wait for the session inactivity timeout before signing in here.`,
          'ACTIVE_SESSION_CONFLICT'
        );
      }
    }

    const sessionDoc: ActiveSession = {
      id: uid,
      uid,
      workspaceId,
      sessionId: nextSessionId,
      deviceLabel: label,
      status: 'ACTIVE',
      createdAt: nowIso,
      lastActivityAt: nowIso,
      expiresAt: expiresAtIso,
    };

    tx.set(ref, sessionDoc);
    return sessionDoc;
  }, 'createOrValidateSingleDeviceSession');
}

/**
 * Validates an existing session on protected requests and refreshes sliding inactivity expiry.
 */
export async function validateAndTouchSession(params: {
  uid: string;
  sessionId: string;
}): Promise<ActiveSession> {
  const { uid, sessionId } = params;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const nextExpiresIso = new Date(nowMs + SESSION_INACTIVITY_TIMEOUT_MS).toISOString();

  return runFirestoreTransaction(async (tx, db) => {
    const ref = db.collection('activeSessions').doc(uid);
    const snap = await tx.get(ref);

    if (!snap.exists) {
      throw new HttpError(401, 'Session is invalid or has been signed out.', 'SESSION_NOT_FOUND');
    }

    const existing = snap.data() as ActiveSession;
    if (existing.status !== 'ACTIVE') {
      throw new HttpError(401, 'Session has been released or expired. Please sign in again.', 'SESSION_INACTIVE');
    }

    if (existing.sessionId !== sessionId) {
      throw new HttpError(
        401,
        'Session identifier does not match the active device session.',
        'SESSION_MISMATCH'
      );
    }

    const expiresMs = existing.expiresAt ? Date.parse(existing.expiresAt) : 0;
    if (!expiresMs || expiresMs <= nowMs) {
      tx.set(
        ref,
        {
          status: 'EXPIRED',
          lastActivityAt: nowIso,
        },
        { merge: true }
      );
      throw new HttpError(401, 'Session expired due to inactivity. Please sign in again.', 'SESSION_EXPIRED');
    }

    const updated: ActiveSession = {
      ...existing,
      lastActivityAt: nowIso,
      expiresAt: nextExpiresIso,
    };
    tx.set(ref, updated);
    return updated;
  }, 'validateAndTouchSession');
}

/**
 * Explicitly releases an active session on logout (only if sessionId matches, or forced for same uid).
 */
export async function releaseActiveSession(uid: string, sessionId?: string): Promise<void> {
  await runFirestoreTransaction(async (tx, db) => {
    const ref = db.collection('activeSessions').doc(uid);
    const snap = await tx.get(ref);
    if (!snap.exists) return;

    const existing = snap.data() as ActiveSession;
    if (sessionId && existing.sessionId !== sessionId) {
      return;
    }

    tx.set(
      ref,
      {
        status: 'RELEASED',
        lastActivityAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      },
      { merge: true }
    );
  }, 'releaseActiveSession');
}
