// ============================================================
// AUTH ROUTES (WORKSPACE-SCOPED + SINGLE-DEVICE SESSION)
// ============================================================

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { adminAuth } from '../firebase.js';
import { userRepo, deviceRepo, workspaceRepo } from '../repositories/firestoreRepository.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/errorHandler.js';
import { createAuditEvent } from '../services/notificationService.js';
import {
  createOrValidateSingleDeviceSession,
  issueSignedSessionToken,
  releaseActiveSession,
  sanitizeDeviceLabel,
  verifySignedSessionToken,
} from '../services/sessionService.js';
import { getEntitlementForUser } from '../services/subscriptionEntitlementService.js';

const router = Router();

const loginSchema = z
  .object({
    email: z.string().email('Invalid email').optional(),
    password: z.string().min(1, 'Password is required').optional(),
    firebaseIdToken: z.string().min(1).optional(),
    sessionId: z.string().optional(),
  })
  .refine(
    (d) => Boolean(d.firebaseIdToken) || Boolean(d.email && d.password),
    'Either email and password or a Firebase ID token is required'
  );

// POST /api/auth/login
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const parse = loginSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const { email, password, firebaseIdToken, sessionId } = parse.data;
    let user = null;

    if (firebaseIdToken) {
      if (!adminAuth) {
        throw new HttpError(
          503,
          'Firebase Admin Auth is not configured for ID token verification.',
          'AUTH_UNCONFIGURED'
        );
      }
      const decoded = await adminAuth.verifyIdToken(firebaseIdToken);
      user = await userRepo.findById(decoded.uid);
      if (!user && decoded.email) {
        user = await userRepo.findByEmail(decoded.email);
      }
      if (!user) {
        res.status(401).json({
          success: false,
          error:
            'No TaskFlow Workspace account matches this Google/Firebase identity. Contact your Workspace Administrator.',
          code: 'USER_NOT_PROVISIONED',
        });
        return;
      }
    } else if (email && password) {
      user = await userRepo.findByEmail(email);
      if (!user) {
        res.status(401).json({ success: false, error: 'Invalid email or password' });
        return;
      }
      if (!user.passwordHash) {
        res.status(401).json({
          success: false,
          error: 'This account uses Google Sign-In. Please sign in with Google or ask your Administrator to set a password.',
        });
        return;
      }
      const passwordMatch = await bcrypt.compare(password, user.passwordHash);
      if (!passwordMatch) {
        res.status(401).json({ success: false, error: 'Invalid email or password' });
        return;
      }
    }

    if (!user) {
      res.status(401).json({ success: false, error: 'Authentication failed' });
      return;
    }

    if (!user.active || user.accountStatus === 'deactivated') {
      res.status(403).json({ success: false, error: 'Account is deactivated' });
      return;
    }

    const headerSessionId =
      typeof req.headers['x-session-id'] === 'string' ? req.headers['x-session-id'] : undefined;
    const deviceLabel = sanitizeDeviceLabel(
      typeof req.headers['x-device-label'] === 'string' ? req.headers['x-device-label'] : undefined,
      req.headers['user-agent']
    );

    // Enforce one active session per user via Firestore transaction (throws 409 on conflict)
    const activeSession = await createOrValidateSingleDeviceSession({
      uid: user.id,
      workspaceId: user.workspaceId,
      requestedSessionId: sessionId || headerSessionId,
      deviceLabel,
    });

    await userRepo.update(user.id, { lastLoginAt: new Date().toISOString() });

    const token = issueSignedSessionToken({
      uid: user.id,
      workspaceId: user.workspaceId,
      role: user.role,
      sessionId: activeSession.sessionId,
    });

    const [workspace, entitlement] = await Promise.all([
      workspaceRepo.findById(user.workspaceId),
      getEntitlementForUser(user),
    ]);

    if (req.session) {
      req.session.userId = user.id;
      req.session.workspaceId = user.workspaceId;
      req.session.role = user.role;
      req.session.fullName = user.fullName;
      req.session.sessionId = activeSession.sessionId;
    }

    const { passwordHash: _, ...safeUser } = user;
    res.json({
      success: true,
      data: safeUser,
      workspace,
      entitlement,
      sessionId: activeSession.sessionId,
      token,
    });
  })
);

// POST /api/auth/logout
router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    let uid = req.session?.userId || '';
    let sessionId = req.session?.sessionId || '';

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const rawToken = authHeader.slice('Bearer '.length).trim();
      const verified = verifySignedSessionToken(rawToken);
      if (verified) {
        uid = verified.uid;
        sessionId = verified.sessionId;
      } else if (adminAuth && !uid) {
        try {
          const decoded = await adminAuth.verifyIdToken(rawToken);
          const u =
            (await userRepo.findById(decoded.uid)) ||
            (decoded.email ? await userRepo.findByEmail(decoded.email) : null);
          if (u) uid = u.id;
        } catch {
          // ignore invalid token on logout
        }
      }
    }

    if (!sessionId && typeof req.headers['x-session-id'] === 'string') {
      sessionId = req.headers['x-session-id'].trim();
    }

    const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId : '';
    if (deviceId) {
      if (uid) {
        await deviceRepo.deactivateDevice(uid, deviceId);
      } else {
        const dev = await deviceRepo.findByDeviceId(deviceId);
        if (dev) {
          await deviceRepo.deactivateDevice(dev.userId, deviceId);
        }
      }
    }

    if (uid) {
      await releaseActiveSession(uid, sessionId || undefined);
    }

    if (req.session) {
      req.session.destroy(() => {});
    }
    res.clearCookie('tid');
    res.json({ success: true, message: 'Logged out successfully' });
  })
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters long'),
});

// POST /api/auth/change-password
router.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parse = changePasswordSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const { currentPassword, newPassword } = parse.data;
    const user = req.authUser!;

    if (!user.passwordHash) {
      res.status(400).json({
        success: false,
        error: 'This account uses Google Sign-In and does not have a local password to change.',
      });
      return;
    }

    const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isMatch) {
      res.status(400).json({ success: false, error: 'Current password is incorrect' });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await userRepo.update(user.id, { passwordHash: newHash });

    if (adminAuth) {
      try {
        await adminAuth.updateUser(user.id, { password: newPassword });
      } catch (authErr) {
        console.warn('Firebase Auth password update notice:', authErr instanceof Error ? authErr.message : authErr);
      }
    }

    await createAuditEvent({
      workspaceId: user.workspaceId,
      actorUserId: user.id,
      entityType: 'user',
      entityId: user.id,
      eventType: 'EMPLOYEE_UPDATED',
      message: `Password changed for user ${user.fullName} (${user.email})`,
    });

    res.json({ success: true, message: 'Password updated successfully' });
  })
);

// GET /api/auth/me
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const [workspace, entitlement] = await Promise.all([
      workspaceRepo.findById(user.workspaceId),
      getEntitlementForUser(user),
    ]);
    const { passwordHash: _, ...safeUser } = user;
    res.json({
      success: true,
      data: safeUser,
      workspace,
      entitlement,
      sessionId: req.activeSession?.sessionId,
    });
  })
);

export default router;
