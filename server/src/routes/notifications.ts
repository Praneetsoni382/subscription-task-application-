// ============================================================
// NOTIFICATION ROUTES (WORKSPACE-SCOPED ASYNC FIRESTORE)
// ============================================================

import { Router } from 'express';
import { notificationRepo } from '../repositories/firestoreRepository.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

// GET /api/notifications
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const notifications = await notificationRepo.findByRecipientInWorkspace(
      user.id,
      user.workspaceId
    );
    const unreadCount = notifications.filter((n) => !n.readAt).length;
    res.json({ success: true, data: { notifications, unreadCount } });
  })
);

// PATCH /api/notifications/:id/read
router.patch(
  '/:id/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const notif = await notificationRepo.findById(req.params.id);
    if (!notif || notif.workspaceId !== user.workspaceId) {
      res.status(404).json({ success: false, error: 'Notification not found' });
      return;
    }

    if (notif.recipientUserId !== user.id) {
      res.status(403).json({ success: false, error: 'Access denied' });
      return;
    }

    const updated = await notificationRepo.update(req.params.id, {
      readAt: new Date().toISOString(),
      deliveryState: 'read',
    });

    res.json({ success: true, data: updated });
  })
);

// POST /api/notifications/read-all
router.post(
  '/read-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    await notificationRepo.markAllRead(user.id, user.workspaceId);
    res.json({ success: true, message: 'All notifications marked as read' });
  })
);

export default router;
