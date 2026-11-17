// ============================================================
// TASK ROUTES (WORKSPACE-SCOPED ASYNC FIRESTORE)
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import {
  taskRepo,
  taskMemberRepo,
  userRepo,
  auditRepo,
  nextTaskRef,
} from '../repositories/firestoreRepository.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  createAuditEvent,
  createNotification,
  notifTemplates,
} from '../services/notificationService.js';
import type { TaskStatus, MemberStatus, Task } from '../types/index.js';
import { format } from 'date-fns';

const router = Router();

function formatDeadline(deadline: string): string {
  try {
    return format(new Date(deadline), 'dd/MM/yyyy');
  } catch {
    return deadline;
  }
}

async function enrichTask(task: Task) {
  const rawMembers = await taskMemberRepo.findByTask(task.id, task.workspaceId);
  const members = await Promise.all(
    rawMembers.map(async (tm) => {
      const user = await userRepo.findByIdInWorkspace(tm.userId, task.workspaceId);
      if (!user) {
        return {
          ...tm,
          user: {
            id: tm.userId,
            uid: tm.userId,
            workspaceId: task.workspaceId,
            fullName: 'Unknown',
            employeeId: '',
            email: '',
            department: '',
            designation: '',
            role: 'employee' as const,
            active: false,
            accountStatus: 'deactivated' as const,
            lastLoginAt: null,
            createdAt: '',
            updatedAt: '',
          },
        };
      }
      const { passwordHash: _, ...safeUser } = user;
      return { ...tm, user: safeUser };
    })
  );
  return { ...task, members };
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['blocked', 'submitted_for_review', 'cancelled'],
  blocked: ['in_progress', 'submitted_for_review', 'cancelled'],
  submitted_for_review: ['approved', 'revision_requested', 'cancelled'],
  revision_requested: ['in_progress', 'blocked', 'cancelled'],
  approved: [],
  cancelled: [],
};

function isValidTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

const createTaskSchema = z.object({
  title: z.string().min(2, 'Title is required'),
  description: z.string().min(5, 'Description is required'),
  assignmentType: z.enum(['solo', 'group']),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  category: z.string().optional().default(''),
  department: z.string().optional().default(''),
  deadline: z.string().min(1, 'Deadline is required'),
  startDate: z.string().nullable().optional(),
  timezone: z.string().default('Asia/Kolkata'),
  reminderEnabled: z.boolean().default(true),
  reminderTimes: z.array(z.string()).default(['12:00', '15:00']),
  managerNote: z.string().optional().default(''),
  assignedUserIds: z.array(z.string()).min(1, 'At least one employee must be assigned'),
});

// GET /api/tasks
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;
    const { status, priority, assignmentType, search } = req.query;
    const isAdmin = user.role === 'admin';

    let tasks = isAdmin
      ? await taskRepo.findAllInWorkspace(workspaceId)
      : await taskRepo.findByMemberInWorkspace(user.id, workspaceId);

    if (status && typeof status === 'string') {
      tasks = tasks.filter((t) => t.status === status);
    }
    if (priority && typeof priority === 'string') {
      tasks = tasks.filter((t) => t.priority === priority);
    }
    if (assignmentType && typeof assignmentType === 'string') {
      tasks = tasks.filter((t) => t.assignmentType === assignmentType);
    }
    if (search && typeof search === 'string') {
      const q = search.toLowerCase();
      tasks = tasks.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.referenceNumber.toLowerCase().includes(q)
      );
    }

    tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const enriched = await Promise.all(tasks.map((t) => enrichTask(t)));

    res.json({ success: true, data: enriched });
  })
);

// POST /api/tasks
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const admin = req.authUser!;
    const workspaceId = admin.workspaceId;

    const parse = createTaskSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const data = parse.data;
    const uniqueUserIds = [...new Set(data.assignedUserIds)];

    if (data.assignmentType === 'group' && uniqueUserIds.length < 2) {
      res.status(400).json({ success: false, error: 'Group tasks require at least 2 employees' });
      return;
    }
    if (data.assignmentType === 'solo' && uniqueUserIds.length !== 1) {
      res.status(400).json({ success: false, error: 'Solo tasks require exactly 1 employee' });
      return;
    }

    const employees: { id: string; fullName: string }[] = [];
    for (const userId of uniqueUserIds) {
      const user = await userRepo.findByIdInWorkspace(userId, workspaceId);
      if (!user || user.role !== 'employee') {
        res.status(400).json({ success: false, error: `Employee ${userId} not found in workspace` });
        return;
      }
      if (!user.active) {
        res.status(400).json({ success: false, error: `Employee ${user.fullName} is inactive` });
        return;
      }
      employees.push({ id: user.id, fullName: user.fullName });
    }

    const referenceNumber = await nextTaskRef(workspaceId);
    const task = await taskRepo.create({
      workspaceId,
      referenceNumber,
      title: data.title,
      description: data.description,
      assignmentType: data.assignmentType,
      priority: data.priority,
      status: 'pending',
      category: data.category ?? '',
      department: data.department ?? '',
      deadline: data.deadline,
      startDate: data.startDate ?? null,
      timezone: data.timezone,
      reminderEnabled: data.reminderEnabled,
      reminderTimes: data.reminderTimes,
      managerNote: data.managerNote ?? '',
      createdBy: admin.id,
      cancelledAt: null,
    });

    const now = new Date().toISOString();
    for (const userId of uniqueUserIds) {
      await taskMemberRepo.create({
        workspaceId,
        taskId: task.id,
        userId,
        memberStatus: 'pending',
        submissionNote: '',
        submittedAt: null,
        approvedAt: null,
        revisionRequestedAt: null,
        revisionReason: '',
        lastStatusUpdateAt: now,
        reminderEligible: true,
        assignedAt: now,
        updatedAt: now,
      });

      const tmpl = notifTemplates.taskAssigned(task.title, formatDeadline(task.deadline));
      await createNotification({
        workspaceId,
        recipientUserId: userId,
        eventType: 'TASK_ASSIGNED',
        title: tmpl.title,
        body: tmpl.body,
        relatedTaskId: task.id,
        navigationUrl: `/employee/tasks/${task.id}`,
      });
    }

    const memberNames = employees.map((e) => e.fullName).join(', ');
    await createAuditEvent({
      workspaceId,
      actorUserId: admin.id,
      entityType: 'task',
      entityId: task.id,
      eventType: 'TASK_CREATED',
      newState: 'pending',
      message: `Task created and assigned to ${memberNames}`,
    });

    const enriched = await enrichTask(task);
    res.status(201).json({ success: true, data: enriched });
  })
);

// GET /api/tasks/:id
router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;

    const task = await taskRepo.findByIdInWorkspace(req.params.id, workspaceId);
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

    const enriched = await enrichTask(task);
    res.json({ success: true, data: enriched });
  })
);

// PATCH /api/tasks/:id
router.patch(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const admin = req.authUser!;
    const workspaceId = admin.workspaceId;

    const task = await taskRepo.findByIdInWorkspace(req.params.id, workspaceId);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    if (task.status === 'cancelled') {
      res.status(400).json({ success: false, error: 'Cannot edit cancelled task' });
      return;
    }

    const allowedFields = z.object({
      title: z.string().min(2).optional(),
      description: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      category: z.string().optional(),
      department: z.string().optional(),
      deadline: z.string().optional(),
      managerNote: z.string().optional(),
      reminderEnabled: z.boolean().optional(),
      reminderTimes: z.array(z.string()).optional(),
    });

    const parse = allowedFields.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const deadlineChanged = Boolean(parse.data.deadline && parse.data.deadline !== task.deadline);
    const updated = await taskRepo.update(task.id, parse.data);
    if (!updated) {
      res.status(500).json({ success: false, error: 'Update failed' });
      return;
    }

    await createAuditEvent({
      workspaceId,
      actorUserId: admin.id,
      entityType: 'task',
      entityId: task.id,
      eventType: 'TASK_UPDATED',
      message: `Task "${task.title}" updated`,
    });

    if (deadlineChanged) {
      const members = await taskMemberRepo.findByTask(task.id, workspaceId);
      for (const m of members) {
        const tmpl = notifTemplates.deadlineChanged(
          updated.title,
          formatDeadline(updated.deadline)
        );
        await createNotification({
          workspaceId,
          recipientUserId: m.userId,
          eventType: 'DEADLINE_CHANGED',
          title: tmpl.title,
          body: tmpl.body,
          relatedTaskId: task.id,
        });
      }
    }

    const enriched = await enrichTask(updated);
    res.json({ success: true, data: enriched });
  })
);

// POST /api/tasks/:id/cancel
router.post(
  '/:id/cancel',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const admin = req.authUser!;
    const workspaceId = admin.workspaceId;

    const task = await taskRepo.findByIdInWorkspace(req.params.id, workspaceId);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    if (task.status === 'cancelled') {
      res.status(400).json({ success: false, error: 'Task already cancelled' });
      return;
    }

    const updated = await taskRepo.update(task.id, {
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
    });

    const members = await taskMemberRepo.findByTask(task.id, workspaceId);
    for (const m of members) {
      await taskMemberRepo.update(m.id, { reminderEligible: false });
      const tmpl = notifTemplates.taskCancelled(task.title);
      await createNotification({
        workspaceId,
        recipientUserId: m.userId,
        eventType: 'TASK_CANCELLED',
        title: tmpl.title,
        body: tmpl.body,
        relatedTaskId: task.id,
      });
    }

    await createAuditEvent({
      workspaceId,
      actorUserId: admin.id,
      entityType: 'task',
      entityId: task.id,
      eventType: 'TASK_CANCELLED',
      previousState: task.status,
      newState: 'cancelled',
      message: `Task "${task.title}" cancelled by administrator`,
    });

    const enriched = await enrichTask(updated || task);
    res.json({ success: true, data: enriched });
  })
);

// GET /api/tasks/:id/history
router.get(
  '/:id/history',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;

    const task = await taskRepo.findByIdInWorkspace(req.params.id, workspaceId);
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

    const history = await auditRepo.findByEntityInWorkspace(task.id, workspaceId);
    const enriched = await Promise.all(
      history.map(async (e) => {
        const actor = await userRepo.findByIdInWorkspace(e.actorUserId, workspaceId);
        return { ...e, actorName: actor?.fullName ?? 'System' };
      })
    );

    res.json({ success: true, data: enriched });
  })
);

// GET /api/tasks/:id/members
router.get(
  '/:id/members',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;

    const task = await taskRepo.findByIdInWorkspace(req.params.id, workspaceId);
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

    const enriched = await enrichTask(task);
    res.json({ success: true, data: enriched.members });
  })
);

// PATCH /api/tasks/:id/members/:memberId/status
router.patch(
  '/:id/members/:memberId/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = req.authUser!;
    const workspaceId = actor.workspaceId;

    const task = await taskRepo.findByIdInWorkspace(req.params.id, workspaceId);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    const member = await taskMemberRepo.findById(req.params.memberId);
    if (!member || member.taskId !== task.id || member.workspaceId !== workspaceId) {
      res.status(404).json({ success: false, error: 'Member record not found' });
      return;
    }

    if (actor.role !== 'admin' && member.userId !== actor.id) {
      res.status(403).json({ success: false, error: "Cannot modify another member's status" });
      return;
    }

    const schema = z.object({
      status: z.enum(['pending', 'in_progress', 'blocked', 'submitted_for_review', 'revision_requested']),
      explanation: z.string().optional().default(''),
    });

    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const newStatus = parse.data.status as MemberStatus;
    const oldStatus = member.memberStatus;

    if (!isValidTransition(oldStatus, newStatus)) {
      res.status(400).json({
        success: false,
        error: `Invalid status transition from ${oldStatus} to ${newStatus}`,
      });
      return;
    }

    const updatedMember = await taskMemberRepo.update(member.id, {
      memberStatus: newStatus,
      lastStatusUpdateAt: new Date().toISOString(),
    });

    if (newStatus === 'blocked') {
      const tmpl = notifTemplates.blockerReported(actor.fullName, task.title);
      await createNotification({
        workspaceId,
        recipientUserId: task.createdBy,
        eventType: 'BLOCKER_REPORTED',
        title: tmpl.title,
        body: tmpl.body,
        relatedTaskId: task.id,
      });
    }
    if (oldStatus === 'blocked' && newStatus === 'in_progress') {
      const tmpl = notifTemplates.blockerResolved(actor.fullName, task.title);
      await createNotification({
        workspaceId,
        recipientUserId: task.createdBy,
        eventType: 'BLOCKER_RESOLVED',
        title: tmpl.title,
        body: tmpl.body,
        relatedTaskId: task.id,
      });
    }

    await createAuditEvent({
      workspaceId,
      actorUserId: actor.id,
      entityType: 'task',
      entityId: task.id,
      eventType: 'STATUS_CHANGED',
      previousState: oldStatus,
      newState: newStatus,
      message: `${actor.fullName} updated status from ${oldStatus} to ${newStatus}${parse.data.explanation ? ': ' + parse.data.explanation : ''}`,
    });

    await updateOverallTaskStatus(task.id, workspaceId);
    res.json({ success: true, data: updatedMember });
  })
);

// POST /api/tasks/:id/members/:memberId/submit
router.post(
  '/:id/members/:memberId/submit',
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = req.authUser!;
    const workspaceId = actor.workspaceId;

    const task = await taskRepo.findByIdInWorkspace(req.params.id, workspaceId);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    const member = await taskMemberRepo.findById(req.params.memberId);
    if (!member || member.taskId !== task.id || member.workspaceId !== workspaceId) {
      res.status(404).json({ success: false, error: 'Member record not found' });
      return;
    }

    if (actor.role !== 'admin' && member.userId !== actor.id) {
      res.status(403).json({ success: false, error: 'Access denied' });
      return;
    }

    if (member.memberStatus === 'submitted_for_review' || member.memberStatus === 'approved') {
      res.status(400).json({ success: false, error: 'Already submitted' });
      return;
    }

    const schema = z.object({ submissionNote: z.string().optional().default('') });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const now = new Date().toISOString();
    const updatedMember = await taskMemberRepo.update(member.id, {
      memberStatus: 'submitted_for_review',
      submissionNote: parse.data.submissionNote,
      submittedAt: now,
      reminderEligible: false,
      lastStatusUpdateAt: now,
    });

    const tmpl = notifTemplates.taskSubmitted(actor.fullName, task.title);
    await createNotification({
      workspaceId,
      recipientUserId: task.createdBy,
      eventType: 'TASK_SUBMITTED',
      title: tmpl.title,
      body: tmpl.body,
      relatedTaskId: task.id,
    });

    await createAuditEvent({
      workspaceId,
      actorUserId: actor.id,
      entityType: 'task',
      entityId: task.id,
      eventType: 'MEMBER_SUBMITTED',
      previousState: member.memberStatus,
      newState: 'submitted_for_review',
      message: `${actor.fullName} submitted task for review`,
    });

    if (task.assignmentType === 'group') {
      const allMembers = await taskMemberRepo.findByTask(task.id, workspaceId);
      const allSubmitted = allMembers.every(
        (m) => m.memberStatus === 'submitted_for_review' || m.memberStatus === 'approved'
      );

      if (allSubmitted) {
        for (const m of allMembers) {
          if (m.userId !== actor.id) {
            const grpTmpl = notifTemplates.groupMemberSubmitted(actor.fullName, task.title);
            await createNotification({
              workspaceId,
              recipientUserId: m.userId,
              eventType: 'GROUP_MEMBER_SUBMITTED',
              title: grpTmpl.title,
              body: grpTmpl.body,
              relatedTaskId: task.id,
            });
          }
        }

        const readyTmpl = notifTemplates.groupReadyForReview(task.title);
        await createNotification({
          workspaceId,
          recipientUserId: task.createdBy,
          eventType: 'GROUP_READY_FOR_REVIEW',
          title: readyTmpl.title,
          body: readyTmpl.body,
          relatedTaskId: task.id,
        });
      }
    }

    await updateOverallTaskStatus(task.id, workspaceId);
    res.json({ success: true, data: updatedMember });
  })
);

// POST /api/tasks/:id/members/:memberId/approve
router.post(
  '/:id/members/:memberId/approve',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const admin = req.authUser!;
    const workspaceId = admin.workspaceId;

    const task = await taskRepo.findByIdInWorkspace(req.params.id, workspaceId);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    const member = await taskMemberRepo.findById(req.params.memberId);
    if (!member || member.taskId !== task.id || member.workspaceId !== workspaceId) {
      res.status(404).json({ success: false, error: 'Member record not found' });
      return;
    }

    if (member.memberStatus !== 'submitted_for_review') {
      res.status(400).json({ success: false, error: 'Can only approve submitted work' });
      return;
    }

    const now = new Date().toISOString();
    const updatedMember = await taskMemberRepo.update(member.id, {
      memberStatus: 'approved',
      approvedAt: now,
      reminderEligible: false,
    });

    const tmpl = notifTemplates.taskApproved(task.title);
    await createNotification({
      workspaceId,
      recipientUserId: member.userId,
      eventType: 'TASK_APPROVED',
      title: tmpl.title,
      body: tmpl.body,
      relatedTaskId: task.id,
    });

    await createAuditEvent({
      workspaceId,
      actorUserId: admin.id,
      entityType: 'task',
      entityId: task.id,
      eventType: 'MEMBER_APPROVED',
      previousState: 'submitted_for_review',
      newState: 'approved',
      message: 'Submission approved',
    });

    await updateOverallTaskStatus(task.id, workspaceId);
    res.json({ success: true, data: updatedMember });
  })
);

// POST /api/tasks/:id/members/:memberId/request-revision
router.post(
  '/:id/members/:memberId/request-revision',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const admin = req.authUser!;
    const workspaceId = admin.workspaceId;

    const task = await taskRepo.findByIdInWorkspace(req.params.id, workspaceId);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    const member = await taskMemberRepo.findById(req.params.memberId);
    if (!member || member.taskId !== task.id || member.workspaceId !== workspaceId) {
      res.status(404).json({ success: false, error: 'Member record not found' });
      return;
    }

    const schema = z.object({
      reason: z.string().min(5, 'Revision reason is required (min 5 chars)'),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const now = new Date().toISOString();
    const updatedMember = await taskMemberRepo.update(member.id, {
      memberStatus: 'revision_requested',
      revisionRequestedAt: now,
      revisionReason: parse.data.reason,
      reminderEligible: true,
    });

    const tmpl = notifTemplates.revisionRequested(task.title);
    await createNotification({
      workspaceId,
      recipientUserId: member.userId,
      eventType: 'REVISION_REQUESTED',
      title: tmpl.title,
      body: tmpl.body,
      relatedTaskId: task.id,
    });

    await createAuditEvent({
      workspaceId,
      actorUserId: admin.id,
      entityType: 'task',
      entityId: task.id,
      eventType: 'REVISION_REQUESTED',
      previousState: 'submitted_for_review',
      newState: 'revision_requested',
      message: `Revision requested: ${parse.data.reason}`,
    });

    await updateOverallTaskStatus(task.id, workspaceId);
    res.json({ success: true, data: updatedMember });
  })
);

async function updateOverallTaskStatus(taskId: string, workspaceId: string) {
  const task = await taskRepo.findByIdInWorkspace(taskId, workspaceId);
  if (!task || task.status === 'cancelled') return;

  const members = await taskMemberRepo.findByTask(taskId, workspaceId);
  if (members.length === 0) return;

  const statuses = members.map((m) => m.memberStatus);
  let newStatus: TaskStatus = task.status;

  if (statuses.every((s) => s === 'approved')) {
    newStatus = 'approved';
  } else if (statuses.every((s) => s === 'submitted_for_review' || s === 'approved')) {
    newStatus = 'submitted_for_review';
  } else if (statuses.some((s) => s === 'in_progress')) {
    newStatus = 'in_progress';
  } else if (statuses.some((s) => s === 'blocked')) {
    newStatus = 'in_progress';
  } else if (statuses.some((s) => s === 'revision_requested')) {
    newStatus = 'revision_requested';
  } else if (statuses.every((s) => s === 'pending')) {
    newStatus = 'pending';
  }

  if (newStatus !== task.status) {
    await taskRepo.update(taskId, { status: newStatus });
  }
}

export default router;
