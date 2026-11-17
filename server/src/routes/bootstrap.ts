// ============================================================
// WORKSPACE BOOTSTRAP ROUTES
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { sanitizeDeviceLabel } from '../services/sessionService.js';
import {
  bootstrapInitialWorkspace,
  getBootstrapStatus,
} from '../services/workspaceBootstrapService.js';
import { getEntitlementForUser } from '../services/subscriptionEntitlementService.js';

const router = Router();

const bootstrapSchema = z.object({
  workspaceName: z.string().min(2, 'Workspace name must be at least 2 characters').max(100),
  adminFullName: z.string().min(2, 'Administrator full name is required').max(100),
  adminEmail: z.string().email('Valid email address is required'),
  adminPassword: z.string().min(8, 'Password must be at least 8 characters').optional(),
  firebaseIdToken: z.string().optional(),
  employeeId: z.string().optional(),
  department: z.string().optional(),
  designation: z.string().optional(),
  timezone: z.string().optional(),
  setupSecret: z.string().optional(),
});

// GET /api/bootstrap/status
router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const status = await getBootstrapStatus();
    res.json({ success: true, data: status });
  })
);

// POST /api/bootstrap
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const parse = bootstrapSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const deviceLabel = sanitizeDeviceLabel(
      typeof req.headers['x-device-label'] === 'string' ? req.headers['x-device-label'] : undefined,
      req.headers['user-agent']
    );

    const result = await bootstrapInitialWorkspace({
      ...parse.data,
      deviceLabel,
    });

    const entitlement = await getEntitlementForUser(result.user);

    if (req.session) {
      req.session.userId = result.user.id;
      req.session.workspaceId = result.workspace.id;
      req.session.role = result.user.role;
      req.session.fullName = result.user.fullName;
      req.session.sessionId = result.sessionId;
    }

    res.status(201).json({
      success: true,
      data: {
        user: result.user,
        workspace: result.workspace,
        entitlement,
        sessionId: result.sessionId,
      },
      token: result.token,
    });
  })
);

export default router;
