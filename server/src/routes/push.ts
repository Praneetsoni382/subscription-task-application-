// ============================================================
// PUSH NOTIFICATION ROUTES (FCM — WORKSPACE-SCOPED)
// File: server/src/routes/push.ts
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { deviceRepo, pushPrefRepo } from '../repositories/firestoreRepository.js';
import {
  checkTestPushRateLimit,
  sendTestPushToUser,
} from '../services/pushNotificationService.js';
import { firebaseConfig } from '../firebase.js';

const router = Router();

const registerDeviceSchema = z.object({
  deviceId: z.string().min(1, 'Device ID is required').max(128),
  fcmToken: z.string().min(1, 'FCM registration token is required').max(1024),
  browserName: z.string().max(64).optional(),
  userAgent: z.string().max(512).optional(),
  permissionStatus: z.enum(['default', 'granted', 'denied']).optional(),
});

const updateDeviceSchema = z.object({
  permissionStatus: z.enum(['default', 'granted', 'denied']).optional(),
  browserName: z.string().max(64).optional(),
  userAgent: z.string().max(512).optional(),
  isActive: z.boolean().optional(),
});

const updatePreferencesSchema = z.object({
  enabled: z.boolean().optional(),
  categories: z
    .object({
      taskAssignments: z.boolean().optional(),
      statusRequests: z.boolean().optional(),
      queries: z.boolean().optional(),
      reminders: z.boolean().optional(),
      messages: z.boolean().optional(),
      approvals: z.boolean().optional(),
    })
    .optional(),
});

// GET /api/push/config
router.get('/config', (_req, res) => {
  const vapidKey =
    process.env.VITE_FIREBASE_VAPID_KEY ||
    process.env.FIREBASE_VAPID_KEY ||
    '';

  res.json({
    success: true,
    data: {
      projectId: firebaseConfig.projectId,
      messagingSenderId: firebaseConfig.messagingSenderId || '',
      vapidKey,
      isConfigured: Boolean(vapidKey && vapidKey.length > 10),
    },
  });
});

// POST /api/push/register
router.post(
  '/register',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parse = registerDeviceSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const user = req.authUser!;
    const { deviceId, fcmToken, browserName, userAgent, permissionStatus } = parse.data;

    const registeredDevice = await deviceRepo.registerDevice({
      workspaceId: user.workspaceId,
      deviceId,
      userId: user.id,
      fcmToken,
      platform: 'WEB',
      browserName: browserName || 'Web Browser',
      userAgent: userAgent || req.headers['user-agent'] || '',
      permissionStatus: permissionStatus || 'granted',
    });

    res.status(201).json({
      success: true,
      data: registeredDevice,
      message: 'Device successfully registered for push notifications',
    });
  })
);

// GET /api/push/devices
router.get(
  '/devices',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const devices = await deviceRepo.findByUserInWorkspace(user.id, user.workspaceId);
    res.json({ success: true, data: devices });
  })
);

// PATCH /api/push/devices/:deviceId
router.patch(
  '/devices/:deviceId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parse = updateDeviceSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const user = req.authUser!;
    const updated = await deviceRepo.updateDevice(user.id, req.params.deviceId, parse.data);
    if (!updated) {
      res.status(404).json({ success: false, error: 'Device registration not found' });
      return;
    }

    res.json({ success: true, data: updated });
  })
);

// DELETE /api/push/devices/:deviceId
router.delete(
  '/devices/:deviceId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const deactivated = await deviceRepo.deactivateDevice(user.id, req.params.deviceId);
    if (!deactivated) {
      res.status(404).json({ success: false, error: 'Device registration not found' });
      return;
    }

    res.json({ success: true, message: 'Device unregistered successfully' });
  })
);

// GET /api/push/preferences
router.get(
  '/preferences',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const preferences = await pushPrefRepo.getPreferences(user.id, user.workspaceId);
    res.json({ success: true, data: preferences });
  })
);

// PATCH /api/push/preferences
router.patch(
  '/preferences',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parse = updatePreferencesSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const user = req.authUser!;
    const updated = await pushPrefRepo.updatePreferences(user.id, user.workspaceId, parse.data);
    res.json({ success: true, data: updated, message: 'Preferences updated successfully' });
  })
);

// POST /api/push/test
router.post(
  '/test',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const rateCheck = checkTestPushRateLimit(user.id);
    if (!rateCheck.allowed) {
      res.status(429).json({
        success: false,
        error: `Rate limit reached. Please wait ${rateCheck.retryAfterSeconds} seconds before requesting another test push.`,
      });
      return;
    }

    const result = await sendTestPushToUser(user.id, user.workspaceId);
    res.json({
      success: result.status === 'sent',
      data: result,
      message:
        result.status === 'sent'
          ? `Test push dispatched to ${result.deviceCount} registered device(s).`
          : result.error || 'Test push delivery could not complete.',
    });
  })
);

export default router;
