// ============================================================
// SUBSCRIPTION & WORKSPACE ENTITLEMENT ROUTES
// ============================================================

import { Router } from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { workspaceRepo } from '../repositories/firestoreRepository.js';
import {
  getEntitlementForUser,
  getSubscriptionHistory,
} from '../services/subscriptionEntitlementService.js';

const router = Router();

// GET /api/subscriptions/current
router.get(
  '/current',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const [workspace, entitlement] = await Promise.all([
      workspaceRepo.findById(user.workspaceId),
      getEntitlementForUser(user),
    ]);

    res.json({
      success: true,
      data: {
        workspace,
        entitlement,
      },
    });
  })
);

// GET /api/subscriptions/history
router.get(
  '/history',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const history = await getSubscriptionHistory(user.workspaceId);
    res.json({ success: true, data: history });
  })
);

export default router;
