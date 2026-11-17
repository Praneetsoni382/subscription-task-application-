// ============================================================
// STATUS REQUESTS ROUTES (PREMIUM ENTITLEMENT GATED)
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import {
  statusRequestRepo,
  statusResponseRepo,
  taskRepo,
  taskMemberRepo,
  userRepo,
  meetingRepo,
} from '../repositories/firestoreRepository.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/errorHandler.js';
import { createAuditEvent, createNotification, notifTemplates } from '../services/notificationService.js';
import { generateMeetForWorkspace } from '../services/meetGenerationService.js';
import {
  assertEntitlement,
  canCreateStatusRequest,
  canRespondToStatusRequest,
  canUseStatusQueries,
  trackStatusQueryUsage,
} from '../services/subscriptionEntitlementService.js';

const PRESET_QUESTIONS = [
  'What is the current update?',
  'How much progress has been made?',
  'Are you facing any blockers?',
  'Is the task progressing according to the plan?',
  'What remains before completion?',
  'Has the issue been resolved?',
  'Will the task be completed before the deadline?',
];

const router = Router();

// GET /api/status-requests/presets
router.get(
  '/presets',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    assertEntitlement(await canUseStatusQueries(user, user.workspaceId));
    res.json({ success: true, data: PRESET_QUESTIONS });
  })
);

// GET /api/status-requests
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;
    assertEntitlement(await canUseStatusQueries(user, workspaceId));

    const isAdmin = user.role === 'admin';
    const requests = isAdmin
      ? await statusRequestRepo.findAllInWorkspace(workspaceId)
      : await statusRequestRepo.findByRecipientInWorkspace(user.id, workspaceId);

    requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (req.query.track === '1') {
      await trackStatusQueryUsage(workspaceId);
    }

    const enriched = await Promise.all(
      requests.map(async (sr) => {
        const [task, responses, creator, recipient] = await Promise.all([
          taskRepo.findByIdInWorkspace(sr.taskId, workspaceId),
          statusResponseRepo.findByRequestInWorkspace(sr.id, workspaceId),
          userRepo.findByIdInWorkspace(sr.createdBy, workspaceId),
          userRepo.findByIdInWorkspace(sr.recipientUserId, workspaceId),
        ]);

        let meeting = sr.meetingId
          ? await meetingRepo.findByIdInWorkspace(sr.meetingId, workspaceId)
          : await meetingRepo.findByStatusRequestInWorkspace(sr.id, workspaceId);

        if (meeting && meeting.status === 'draft' && !isAdmin) {
          meeting = null;
        }

        return {
          ...sr,
          task: task ? { id: task.id, title: task.title, referenceNumber: task.referenceNumber } : null,
          responses,
          creatorName: creator?.fullName ?? 'Unknown',
          recipientName: recipient?.fullName ?? 'Unknown',
          meeting: meeting || null,
        };
      })
    );

    res.json({ success: true, data: enriched });
  })
);

// POST /api/status-requests/:id/respond
router.post(
  '/:id/respond',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;
    assertEntitlement(await canRespondToStatusRequest(user, workspaceId));

    const sr = await statusRequestRepo.findByIdInWorkspace(req.params.id, workspaceId);
    if (!sr) {
      res.status(404).json({ success: false, error: 'Status request not found' });
      return;
    }

    if (user.role !== 'admin' && sr.recipientUserId !== user.id) {
      res.status(403).json({ success: false, error: 'Access denied' });
      return;
    }

    const schema = z.object({
      responseText: z.string().min(1, 'Response is required'),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const response = await statusResponseRepo.create({
      workspaceId,
      statusRequestId: sr.id,
      responderUserId: user.id,
      responseText: parse.data.responseText,
      createdAt: new Date().toISOString(),
    });

    await statusRequestRepo.update(sr.id, { status: 'answered' });

    const task = await taskRepo.findByIdInWorkspace(sr.taskId, workspaceId);
    if (task) {
      const tmpl = notifTemplates.statusResponseReceived(user.fullName, task.title);
      await createNotification({
        workspaceId,
        recipientUserId: sr.createdBy,
        eventType: 'STATUS_RESPONSE_RECEIVED',
        title: tmpl.title,
        body: tmpl.body,
        relatedTaskId: sr.taskId,
        relatedStatusRequestId: sr.id,
      });
    }

    await createAuditEvent({
      workspaceId,
      actorUserId: user.id,
      entityType: 'status_request',
      entityId: sr.id,
      eventType: 'STATUS_RESPONSE_GIVEN',
      message: 'Status response submitted',
    });

    res.status(201).json({ success: true, data: response });
  })
);

export const taskStatusRequestRouter = Router();

// POST /api/tasks/:taskId/status-requests
taskStatusRequestRouter.post(
  '/:taskId/status-requests',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const admin = req.authUser!;
    const workspaceId = admin.workspaceId;

    assertEntitlement(await canCreateStatusRequest(admin, workspaceId));

    const task = await taskRepo.findByIdInWorkspace(req.params.taskId, workspaceId);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    const schema = z.object({
      question: z.string().min(5, 'Question is required'),
      recipientUserIds: z.array(z.string()).min(1, 'At least one recipient required'),
      isPreset: z.boolean().optional().default(false),
      responseDeadline: z.string().nullable().optional(),
      includeMeet: z.boolean().optional().default(false),
      meetDate: z.string().optional().default(''),
      meetTime: z.string().optional().default(''),
      meetDescription: z.string().optional().default(''),
      idempotencyKey: z.string().optional(),
    });

    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const {
      question,
      recipientUserIds,
      responseDeadline,
      includeMeet,
      meetDate,
      meetTime,
      meetDescription,
      idempotencyKey,
    } = parse.data;

    // Resolve valid recipients assigned to this task within the workspace BEFORE generating Meet
    const validRecipientIds: string[] = [];
    for (const userId of [...new Set(recipientUserIds)]) {
      const member = await taskMemberRepo.findByTaskAndUser(task.id, userId, workspaceId);
      if (member) validRecipientIds.push(userId);
    }

    if (validRecipientIds.length === 0) {
      throw new HttpError(400, 'No valid task-assigned recipients selected.');
    }

    let scheduledAtIso: string | null = null;
    let meetingStatus: 'draft' | 'scheduled' = 'draft';
    let dateFormatted = '';
    let timeFormatted = '';
    let isToday = false;

    if (includeMeet && meetDate && meetTime) {
      const dateObj = new Date(`${meetDate}T${meetTime}:00+05:30`);
      if (isNaN(dateObj.getTime())) {
        throw new HttpError(400, 'Invalid meeting date or time provided.');
      }
      if (dateObj.getTime() < Date.now() - 60_000) {
        throw new HttpError(400, 'Cannot schedule a Google Meet discussion in the past.');
      }
      meetingStatus = 'scheduled';
      scheduledAtIso = dateObj.toISOString();

      const istNowStr = new Date().toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const meetingDateIstStr = dateObj.toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      isToday = istNowStr === meetingDateIstStr;
      dateFormatted = dateObj.toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
      timeFormatted = dateObj
        .toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        })
        .toUpperCase();
    }

    // If Meet requested, generate ONE authoritative Google Meet space & consume 1 credit BEFORE creating status requests
    let sharedMeeting: any = null;
    if (includeMeet) {
      const generated = await generateMeetForWorkspace({
        actor: admin,
        taskId: task.id,
        meetingTitle: `Google Meet Discussion: Status Request on ${task.title}`,
        description: meetDescription,
        statusRequestIds: [],
        invitedEmployeeIds: validRecipientIds,
        scheduledAt: scheduledAtIso,
        status: meetingStatus,
        idempotencyKey,
      });
      sharedMeeting = generated.meeting;
    }

    const now = new Date().toISOString();
    const created = [];

    for (const userId of validRecipientIds) {
      const sr = await statusRequestRepo.create({
        workspaceId,
        taskId: task.id,
        createdBy: admin.id,
        recipientUserId: userId,
        question,
        status: 'pending',
        createdAt: now,
        responseDeadline: responseDeadline ?? null,
        meetingId: sharedMeeting ? sharedMeeting.id : undefined,
      });

      if (sharedMeeting && !sharedMeeting.statusRequestId) {
        sharedMeeting.statusRequestId = sr.id;
        await meetingRepo.update(sharedMeeting.id, { statusRequestId: sr.id });
      }

      const tmpl = notifTemplates.statusRequested(task.title);
      await createNotification({
        workspaceId,
        recipientUserId: userId,
        eventType: 'STATUS_REQUESTED',
        title: tmpl.title,
        body: tmpl.body,
        relatedTaskId: task.id,
        relatedStatusRequestId: sr.id,
        navigationUrl: `/employee/tasks/${task.id}`,
      });

      if (sharedMeeting && sharedMeeting.status === 'scheduled' && dateFormatted && timeFormatted) {
        const meetTmpl = notifTemplates.meetingScheduled(dateFormatted, timeFormatted, isToday);
        await createNotification({
          workspaceId,
          recipientUserId: userId,
          eventType: 'STATUS_REQUESTED',
          title: meetTmpl.title,
          body: meetTmpl.body,
          relatedTaskId: task.id,
          relatedStatusRequestId: sr.id,
          navigationUrl: `/employee/tasks/${task.id}`,
        });
      }

      created.push(sharedMeeting ? { ...sr, meeting: sharedMeeting } : sr);
    }

    await trackStatusQueryUsage(workspaceId);

    await createAuditEvent({
      workspaceId,
      actorUserId: admin.id,
      entityType: 'status_request',
      entityId: task.id,
      eventType: 'STATUS_REQUEST_SENT',
      message: `Status request sent to ${validRecipientIds.length} recipient(s)${sharedMeeting ? ` with Google Meet (${sharedMeeting.meetingUri})` : ''}`,
    });

    res.status(201).json({ success: true, data: created });
  })
);

export default router;
