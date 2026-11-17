// ============================================================
// QUERY ROUTES (WORKSPACE-SCOPED ASYNC FIRESTORE)
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import {
  queryRepo,
  queryMessageRepo,
  taskRepo,
  taskMemberRepo,
  userRepo,
} from '../repositories/firestoreRepository.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createAuditEvent, createNotification, notifTemplates } from '../services/notificationService.js';
import type { Query } from '../types/index.js';

async function enrichQuery(query: Query) {
  const [task, creator, rawMessages] = await Promise.all([
    taskRepo.findByIdInWorkspace(query.taskId, query.workspaceId),
    userRepo.findByIdInWorkspace(query.createdBy, query.workspaceId),
    queryMessageRepo.findByQueryInWorkspace(query.id, query.workspaceId),
  ]);

  const messages = await Promise.all(
    rawMessages.map(async (m) => {
      const sender = await userRepo.findByIdInWorkspace(m.senderUserId, query.workspaceId);
      return { ...m, senderName: sender?.fullName ?? 'Unknown', senderRole: sender?.role };
    })
  );

  return {
    ...query,
    task: task ? { id: task.id, title: task.title, referenceNumber: task.referenceNumber } : null,
    creatorName: creator?.fullName ?? 'Unknown',
    messages,
  };
}

const router = Router();

// GET /api/queries
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;
    const { status, category, search } = req.query;
    const isAdmin = user.role === 'admin';

    let queries = isAdmin
      ? await queryRepo.findAllInWorkspace(workspaceId)
      : await queryRepo.findByUserInWorkspace(user.id, workspaceId);

    if (status && typeof status === 'string') {
      queries = queries.filter((q) => q.status === status);
    }
    if (category && typeof category === 'string') {
      queries = queries.filter((q) => q.category === category);
    }
    if (search && typeof search === 'string') {
      const q = search.toLowerCase();
      queries = queries.filter(
        (query) =>
          query.title.toLowerCase().includes(q) ||
          query.description.toLowerCase().includes(q)
      );
    }

    queries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const enriched = await Promise.all(queries.map((q) => enrichQuery(q)));

    res.json({ success: true, data: enriched });
  })
);

// GET /api/queries/:id
router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;

    const query = await queryRepo.findByIdInWorkspace(req.params.id, workspaceId);
    if (!query) {
      res.status(404).json({ success: false, error: 'Query not found' });
      return;
    }

    if (user.role !== 'admin' && query.createdBy !== user.id) {
      const member = await taskMemberRepo.findByTaskAndUser(query.taskId, user.id, workspaceId);
      if (!member) {
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
      }
    }

    res.json({ success: true, data: await enrichQuery(query) });
  })
);

// POST /api/queries/:id/messages
router.post(
  '/:id/messages',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;

    const query = await queryRepo.findByIdInWorkspace(req.params.id, workspaceId);
    if (!query) {
      res.status(404).json({ success: false, error: 'Query not found' });
      return;
    }

    if (query.status === 'resolved') {
      res.status(400).json({ success: false, error: 'Cannot message on resolved query' });
      return;
    }

    if (user.role !== 'admin' && query.createdBy !== user.id) {
      res.status(403).json({ success: false, error: 'Access denied' });
      return;
    }

    const schema = z.object({ message: z.string().min(1, 'Message is required') });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const qm = await queryMessageRepo.create({
      workspaceId,
      queryId: query.id,
      senderUserId: user.id,
      message: parse.data.message,
      createdAt: new Date().toISOString(),
    });

    const task = await taskRepo.findByIdInWorkspace(query.taskId, workspaceId);

    if (user.role === 'admin' && query.createdBy !== user.id) {
      const tmpl = notifTemplates.queryAnswered(task?.title ?? 'Unknown Task');
      await createNotification({
        workspaceId,
        recipientUserId: query.createdBy,
        eventType: 'QUERY_ANSWERED',
        title: tmpl.title,
        body: tmpl.body,
        relatedTaskId: query.taskId,
        relatedQueryId: query.id,
      });

      if (query.status === 'open') {
        await queryRepo.update(query.id, { status: 'answered' });
      }
    }

    await createAuditEvent({
      workspaceId,
      actorUserId: user.id,
      entityType: 'query',
      entityId: query.id,
      eventType: 'QUERY_ANSWERED',
      message: `${user.fullName} added a message to the query`,
    });

    res.status(201).json({ success: true, data: qm });
  })
);

// PATCH /api/queries/:id/status
router.patch(
  '/:id/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;

    const query = await queryRepo.findByIdInWorkspace(req.params.id, workspaceId);
    if (!query) {
      res.status(404).json({ success: false, error: 'Query not found' });
      return;
    }

    const schema = z.object({
      status: z.enum(['open', 'answered', 'resolved', 'reopened']),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const newStatus = parse.data.status;

    if (newStatus === 'resolved' && user.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Only admin can resolve queries' });
      return;
    }
    if (newStatus === 'reopened' && query.createdBy !== user.id && user.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Access denied' });
      return;
    }

    const updated = await queryRepo.update(query.id, { status: newStatus });

    if (newStatus === 'resolved') {
      const task = await taskRepo.findByIdInWorkspace(query.taskId, workspaceId);
      const tmpl = notifTemplates.queryResolved(task?.title ?? 'Unknown Task');
      await createNotification({
        workspaceId,
        recipientUserId: query.createdBy,
        eventType: 'QUERY_RESOLVED',
        title: tmpl.title,
        body: tmpl.body,
        relatedTaskId: query.taskId,
        relatedQueryId: query.id,
      });

      await createAuditEvent({
        workspaceId,
        actorUserId: user.id,
        entityType: 'query',
        entityId: query.id,
        eventType: 'QUERY_RESOLVED',
        previousState: query.status,
        newState: 'resolved',
        message: 'Query resolved',
      });
    }

    res.json({ success: true, data: await enrichQuery(updated || query) });
  })
);

export const taskQueryRouter = Router();

// GET /api/tasks/:taskId/queries
taskQueryRouter.get(
  '/:taskId/queries',
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

    const queries = await queryRepo.findByTaskInWorkspace(task.id, workspaceId);
    const enriched = await Promise.all(queries.map((q) => enrichQuery(q)));
    res.json({ success: true, data: enriched });
  })
);

// POST /api/tasks/:taskId/queries
taskQueryRouter.post(
  '/:taskId/queries',
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
      res.status(400).json({ success: false, error: 'Cannot raise query on cancelled task' });
      return;
    }

    if (user.role !== 'admin') {
      const member = await taskMemberRepo.findByTaskAndUser(task.id, user.id, workspaceId);
      if (!member) {
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
      }
    }

    const schema = z.object({
      title: z.string().min(3, 'Query title is required'),
      description: z.string().min(10, 'Description is required'),
      category: z.enum([
        'clarification',
        'blocker',
        'dependency',
        'deadline_concern',
        'assignment_issue',
        'technical_issue',
        'other',
      ]),
      priority: z.enum(['low', 'medium', 'high']).default('medium'),
    });

    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const query = await queryRepo.create({
      workspaceId,
      taskId: task.id,
      createdBy: user.id,
      title: parse.data.title,
      description: parse.data.description,
      category: parse.data.category,
      priority: parse.data.priority,
      status: 'open',
    });

    await queryMessageRepo.create({
      workspaceId,
      queryId: query.id,
      senderUserId: user.id,
      message: parse.data.description,
      createdAt: new Date().toISOString(),
    });

    const tmpl = notifTemplates.queryCreated(user.fullName, task.title);
    await createNotification({
      workspaceId,
      recipientUserId: task.createdBy,
      eventType: 'QUERY_CREATED',
      title: tmpl.title,
      body: tmpl.body,
      relatedTaskId: task.id,
      relatedQueryId: query.id,
      navigationUrl: `/admin/queries`,
    });

    await createAuditEvent({
      workspaceId,
      actorUserId: user.id,
      entityType: 'query',
      entityId: query.id,
      eventType: 'QUERY_CREATED',
      newState: 'open',
      message: `Query "${parse.data.title}" raised by ${user.fullName}`,
    });

    res.status(201).json({ success: true, data: await enrichQuery(query) });
  })
);

export default router;
