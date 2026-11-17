// ============================================================
// CHAT ROUTES (WORKSPACE-SCOPED ASYNC FIRESTORE)
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import {
  chatMessageRepo,
  taskRepo,
  taskMemberRepo,
  userRepo,
} from '../repositories/firestoreRepository.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createAuditEvent } from '../services/notificationService.js';

const router = Router();

// GET /api/tasks/:taskId/messages
router.get(
  '/:taskId/messages',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;

    const task = await taskRepo.findByIdInWorkspace(req.params.taskId, workspaceId);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    if (user.role !== 'admin') {
      const member = await taskMemberRepo.findByTaskAndUser(task.id, user.id, workspaceId);
      if (!member) {
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
      }
    }

    const rawMessages = await chatMessageRepo.findByTaskInWorkspace(task.id, workspaceId);
    const messages = await Promise.all(
      rawMessages.map(async (m) => {
        const sender = await userRepo.findByIdInWorkspace(m.senderUserId, workspaceId);
        return {
          ...m,
          senderName: sender?.fullName ?? 'Unknown',
          senderRole: sender?.role ?? 'employee',
        };
      })
    );

    res.json({ success: true, data: messages });
  })
);

// POST /api/tasks/:taskId/messages
router.post(
  '/:taskId/messages',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;

    const task = await taskRepo.findByIdInWorkspace(req.params.taskId, workspaceId);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    if (task.status === 'cancelled') {
      res.status(400).json({ success: false, error: 'Cannot post to cancelled task chat' });
      return;
    }

    if (user.role !== 'admin') {
      const member = await taskMemberRepo.findByTaskAndUser(task.id, user.id, workspaceId);
      if (!member) {
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
      }
    }

    const schema = z.object({ message: z.string().min(1, 'Message cannot be empty') });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const cm = await chatMessageRepo.create({
      workspaceId,
      taskId: task.id,
      senderUserId: user.id,
      message: parse.data.message,
      createdAt: new Date().toISOString(),
    });

    await createAuditEvent({
      workspaceId,
      actorUserId: user.id,
      entityType: 'chat',
      entityId: task.id,
      eventType: 'CHAT_MESSAGE_SENT',
      message: `${user.fullName} sent a message in task chat`,
    });

    res.status(201).json({
      success: true,
      data: {
        ...cm,
        senderName: user.fullName,
        senderRole: user.role,
      },
    });
  })
);

export default router;
