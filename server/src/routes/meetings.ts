// ============================================================
// GOOGLE MEET & CENTRALIZED OAUTH API ROUTES
// File: server/src/routes/meetings.ts
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import {
  meetingRepo,
  statusRequestRepo,
  taskRepo,
  taskMemberRepo,
  userRepo,
} from '../repositories/firestoreRepository.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/errorHandler.js';
import {
  createNotification,
  createAuditEvent,
  notifTemplates,
} from '../services/notificationService.js';
import {
  consumeOAuthState,
  createOAuthState,
  disconnectWorkspaceGoogleOAuth,
  exchangeCodeForTokens,
  generateMeetForWorkspace,
  getGoogleOAuthUrl,
  getWorkspaceGoogleStatus,
  resolveRedirectUri,
} from '../services/meetGenerationService.js';
import {
  assertEntitlement,
  canCreateStatusRequest,
  canJoinPremiumMeeting,
} from '../services/subscriptionEntitlementService.js';

const router = Router();

// ============================================================
// 1. ADMIN GOOGLE OAUTH MANAGEMENT ENDPOINTS (WORKSPACE-SCOPED)
// ============================================================

// GET /api/admin/google/status
router.get(
  '/google/status',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const status = await getWorkspaceGoogleStatus(req.authUser!.workspaceId);
    res.json({ success: true, data: status });
  })
);

// GET /api/admin/google/auth-url
router.get(
  '/google/auth-url',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const explicitUri = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : undefined;
    const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    const redirectUri = resolveRedirectUri(explicitUri, host, proto);

    const state = await createOAuthState({
      workspaceId: req.authUser!.workspaceId,
      adminUid: req.authUser!.id,
      redirectUri,
      returnTo: '/admin/status-requests',
    });
    const authUrl = getGoogleOAuthUrl(state, redirectUri);

    res.json({
      success: true,
      data: {
        authUrl,
        redirectUri,
        state,
      },
    });
  })
);

// GET /api/admin/google/authorize (requires authenticated admin; never uses hardcoded uid)
router.get(
  '/google/authorize',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const explicitUri = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : undefined;
    const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    const redirectUri = resolveRedirectUri(explicitUri, host, proto);

    const state = await createOAuthState({
      workspaceId: req.authUser!.workspaceId,
      adminUid: req.authUser!.id,
      redirectUri,
      returnTo: '/admin/status-requests',
    });
    const authUrl = getGoogleOAuthUrl(state, redirectUri);

    res.redirect(authUrl);
  })
);

// GET /api/admin/google/callback
router.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      const errDetail = error_description || error;
      res.redirect(`/admin/status-requests?oauth_error=${encodeURIComponent(String(errDetail))}`);
      return;
    }

    if (!code || typeof code !== 'string') {
      res.redirect('/admin/status-requests?oauth_error=Missing+authorization+code+from+Google');
      return;
    }

    const stateStr = typeof state === 'string' ? state : '';

    try {
      const statePayload = await consumeOAuthState(stateStr);
      await exchangeCodeForTokens({
        code,
        workspaceId: statePayload.workspaceId,
        adminUid: statePayload.adminUid,
        redirectUri: statePayload.redirectUri,
      });

      const returnTo = statePayload.returnTo || '/admin/status-requests';
      const separator = returnTo.includes('?') ? '&' : '?';
      res.redirect(`${returnTo}${separator}google_connected=true`);
    } catch (err) {
      console.error('OAuth Callback Error:', err);
      const errMsg = err instanceof Error ? err.message : 'Google OAuth authentication failed';
      res.redirect(`/admin/status-requests?oauth_error=${encodeURIComponent(errMsg)}`);
    }
  })
);

// POST /api/admin/google/disconnect
router.post(
  '/google/disconnect',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await disconnectWorkspaceGoogleOAuth(req.authUser!.workspaceId, req.authUser!.id);
    res.json({ success: true, message: 'Workspace Google account disconnected successfully' });
  })
);

// ============================================================
// 2. GOOGLE MEET FOR STATUS REQUESTS ENDPOINTS
// ============================================================

// POST /api/admin/status-requests/:requestId/meetings (Create genuine Meet Link via Backend + Consume 1 Credit)
router.post(
  '/status-requests/:requestId/meetings',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { requestId } = req.params;
    const workspaceId = req.authUser!.workspaceId;

    const sr = await statusRequestRepo.findByIdInWorkspace(requestId, workspaceId);
    if (!sr) {
      res.status(404).json({ success: false, error: 'Status Request not found' });
      return;
    }

    const task = await taskRepo.findByIdInWorkspace(sr.taskId, workspaceId);
    if (!task) {
      res.status(404).json({ success: false, error: 'Associated Task not found' });
      return;
    }

    // Check if meeting already exists for this statusRequest (do not charge credit twice)
    let existingMeeting = sr.meetingId
      ? await meetingRepo.findByIdInWorkspace(sr.meetingId, workspaceId)
      : null;
    if (!existingMeeting) {
      existingMeeting = await meetingRepo.findByStatusRequestInWorkspace(requestId, workspaceId);
    }

    if (existingMeeting) {
      if (!sr.meetingId) {
        await statusRequestRepo.update(sr.id, { meetingId: existingMeeting.id });
      }
      res.status(200).json({ success: true, data: existingMeeting });
      return;
    }

    const idempotencyKey =
      typeof req.body?.idempotencyKey === 'string' && req.body.idempotencyKey.trim()
        ? req.body.idempotencyKey.trim()
        : undefined;

    const googleAccessToken =
      typeof req.headers['x-google-meet-token'] === 'string' && req.headers['x-google-meet-token'].trim()
        ? req.headers['x-google-meet-token'].trim()
        : undefined;

    const { meeting } = await generateMeetForWorkspace({
      actor: req.authUser!,
      taskId: task.id,
      meetingTitle: `Google Meet Discussion: Status Request on ${task.title}`,
      description: typeof req.body?.description === 'string' ? req.body.description : '',
      statusRequestIds: [sr.id],
      invitedEmployeeIds: [sr.recipientUserId],
      status: 'draft',
      idempotencyKey,
      googleAccessToken,
    });

    await statusRequestRepo.update(sr.id, { meetingId: meeting.id });

    res.status(201).json({ success: true, data: meeting });
  })
);

// POST /api/admin/status-requests/:requestId/meetings/schedule
router.post(
  '/status-requests/:requestId/meetings/schedule',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const workspaceId = req.authUser!.workspaceId;
    assertEntitlement(await canCreateStatusRequest(req.authUser!, workspaceId));

    const { requestId } = req.params;
    const sr = await statusRequestRepo.findByIdInWorkspace(requestId, workspaceId);
    if (!sr) {
      res.status(404).json({ success: false, error: 'Status Request not found' });
      return;
    }

    let meeting = sr.meetingId
      ? await meetingRepo.findByIdInWorkspace(sr.meetingId, workspaceId)
      : null;
    if (!meeting) {
      meeting = await meetingRepo.findByStatusRequestInWorkspace(requestId, workspaceId);
    }
    if (!meeting) {
      res.status(400).json({ success: false, error: 'Please generate a Google Meet link first before scheduling.' });
      return;
    }

    const schema = z.object({
      date: z.string().min(1, 'Meeting date is required'),
      time: z.string().min(1, 'Meeting time is required'),
      description: z.string().optional().default(''),
    });

    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const { date, time, description } = parse.data;
    const scheduledDateObj = new Date(`${date}T${time}:00+05:30`);
    if (isNaN(scheduledDateObj.getTime())) {
      res.status(400).json({ success: false, error: 'Invalid date or time format provided.' });
      return;
    }
    if (scheduledDateObj.getTime() < Date.now() - 60_000) {
      res.status(400).json({ success: false, error: 'Cannot schedule a Google Meet discussion in the past.' });
      return;
    }

    const publishedAtStr = new Date().toISOString();
    const updatedMeeting = await meetingRepo.update(meeting.id, {
      status: 'scheduled',
      scheduledAt: scheduledDateObj.toISOString(),
      publishedAt: publishedAtStr,
      description: description || meeting.description,
      timezone: 'Asia/Kolkata',
    });

    const istNowStr = new Date().toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const meetingDateIstStr = scheduledDateObj.toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const isToday = istNowStr === meetingDateIstStr;

    const dateFormatted = scheduledDateObj.toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
    const timeFormatted = scheduledDateObj
      .toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
      .toUpperCase();

    const recipientUids = new Set<string>([sr.recipientUserId, ...(meeting.invitedEmployeeIds || [])]);
    const siblingRequests = await statusRequestRepo.findByTaskInWorkspace(sr.taskId, workspaceId);
    for (const sib of siblingRequests) {
      if (sib.meetingId === meeting.id) {
        recipientUids.add(sib.recipientUserId);
      }
    }

    const tmpl = notifTemplates.meetingScheduled(dateFormatted, timeFormatted, isToday);
    for (const uid of recipientUids) {
      const recipientUser = await userRepo.findByIdInWorkspace(uid, workspaceId);
      if (recipientUser) {
        await createNotification({
          workspaceId,
          recipientUserId: uid,
          eventType: 'STATUS_REQUESTED',
          title: tmpl.title,
          body: tmpl.body,
          relatedTaskId: sr.taskId,
          relatedStatusRequestId: sr.id,
          navigationUrl: `/employee/tasks/${sr.taskId}`,
        });
      }
    }

    await createAuditEvent({
      workspaceId,
      actorUserId: req.authUser!.id,
      entityType: 'status_request',
      entityId: sr.id,
      eventType: 'STATUS_REQUEST_SENT',
      message: `Google Meet discussion scheduled for ${dateFormatted} at ${timeFormatted} IST and published to ${recipientUids.size} employee(s).`,
    });

    res.status(200).json({ success: true, data: updatedMeeting });
  })
);

// PATCH /api/admin/status-requests/:requestId/meetings (Reschedule)
router.patch(
  '/status-requests/:requestId/meetings',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const workspaceId = req.authUser!.workspaceId;
    assertEntitlement(await canCreateStatusRequest(req.authUser!, workspaceId));

    const { requestId } = req.params;
    const sr = await statusRequestRepo.findByIdInWorkspace(requestId, workspaceId);
    if (!sr) {
      res.status(404).json({ success: false, error: 'Status Request not found' });
      return;
    }

    const meeting = sr.meetingId
      ? await meetingRepo.findByIdInWorkspace(sr.meetingId, workspaceId)
      : await meetingRepo.findByStatusRequestInWorkspace(requestId, workspaceId);
    if (!meeting) {
      res.status(404).json({ success: false, error: 'Meeting record not found' });
      return;
    }

    const { date, time, description } = req.body || {};
    let scheduledAt = meeting.scheduledAt;
    let dateFormatted = '';
    let timeFormatted = '';

    if (date && time) {
      const dateObj = new Date(`${date}T${time}:00+05:30`);
      if (isNaN(dateObj.getTime())) {
        throw new HttpError(400, 'Invalid date or time format provided.');
      }
      scheduledAt = dateObj.toISOString();
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

    const updatedMeeting = await meetingRepo.update(meeting.id, {
      scheduledAt,
      description: description !== undefined ? description : meeting.description,
      status: 'scheduled',
    });

    if (dateFormatted && timeFormatted) {
      const recipientUids = new Set<string>([sr.recipientUserId, ...(meeting.invitedEmployeeIds || [])]);
      const siblingRequests = await statusRequestRepo.findByTaskInWorkspace(sr.taskId, workspaceId);
      for (const sib of siblingRequests) {
        if (sib.meetingId === meeting.id) {
          recipientUids.add(sib.recipientUserId);
        }
      }

      const tmpl = notifTemplates.meetingRescheduled(dateFormatted, timeFormatted);
      for (const uid of recipientUids) {
        await createNotification({
          workspaceId,
          recipientUserId: uid,
          eventType: 'STATUS_REQUESTED',
          title: tmpl.title,
          body: tmpl.body,
          relatedTaskId: sr.taskId,
          relatedStatusRequestId: sr.id,
          navigationUrl: `/employee/tasks/${sr.taskId}`,
        });
      }
    }

    res.status(200).json({ success: true, data: updatedMeeting });
  })
);

// POST /api/admin/status-requests/:requestId/meetings/cancel
router.post(
  '/status-requests/:requestId/meetings/cancel',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const workspaceId = req.authUser!.workspaceId;
    const { requestId } = req.params;
    const sr = await statusRequestRepo.findByIdInWorkspace(requestId, workspaceId);
    if (!sr) {
      res.status(404).json({ success: false, error: 'Status Request not found' });
      return;
    }

    const meeting = sr.meetingId
      ? await meetingRepo.findByIdInWorkspace(sr.meetingId, workspaceId)
      : await meetingRepo.findByStatusRequestInWorkspace(requestId, workspaceId);
    if (!meeting) {
      res.status(404).json({ success: false, error: 'Meeting record not found' });
      return;
    }

    const cancelledMeeting = await meetingRepo.update(meeting.id, {
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
    });

    const task = await taskRepo.findByIdInWorkspace(sr.taskId, workspaceId);
    const tmpl = notifTemplates.meetingCancelled(task ? task.title : 'Task');

    const recipientUids = new Set<string>([sr.recipientUserId, ...(meeting.invitedEmployeeIds || [])]);
    const siblingRequests = await statusRequestRepo.findByTaskInWorkspace(sr.taskId, workspaceId);
    for (const sib of siblingRequests) {
      if (sib.meetingId === meeting.id) {
        recipientUids.add(sib.recipientUserId);
      }
    }

    for (const uid of recipientUids) {
      await createNotification({
        workspaceId,
        recipientUserId: uid,
        eventType: 'STATUS_REQUESTED',
        title: tmpl.title,
        body: tmpl.body,
        relatedTaskId: sr.taskId,
        relatedStatusRequestId: sr.id,
        navigationUrl: `/employee/tasks/${sr.taskId}`,
      });
    }

    await createAuditEvent({
      workspaceId,
      actorUserId: req.authUser!.id,
      entityType: 'status_request',
      entityId: sr.id,
      eventType: 'STATUS_REQUEST_SENT',
      message: 'Google Meet discussion cancelled by administrator.',
    });

    res.status(200).json({ success: true, data: cancelledMeeting });
  })
);

// GET /api/status-requests/:requestId/meeting
router.get(
  '/status-requests/:requestId/meeting',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;

    // Premium subscription gate for Google Meet viewing/joining
    assertEntitlement(await canJoinPremiumMeeting(user, workspaceId));

    const { requestId } = req.params;
    const sr = await statusRequestRepo.findByIdInWorkspace(requestId, workspaceId);
    if (!sr) {
      res.status(404).json({ success: false, error: 'Status Request not found' });
      return;
    }

    const isRecipient = sr.recipientUserId === user.id;
    const isMember = Boolean(
      await taskMemberRepo.findByTaskAndUser(sr.taskId, user.id, workspaceId)
    );

    if (user.role !== 'admin' && !isRecipient && !isMember) {
      res.status(403).json({ success: false, error: 'Unauthorized to access meeting for this request' });
      return;
    }

    let meeting = sr.meetingId
      ? await meetingRepo.findByIdInWorkspace(sr.meetingId, workspaceId)
      : null;
    if (!meeting) {
      meeting = await meetingRepo.findByStatusRequestInWorkspace(requestId, workspaceId);
    }

    if (meeting && meeting.status === 'draft' && user.role !== 'admin') {
      res.json({ success: true, data: null });
      return;
    }

    res.json({ success: true, data: meeting || null });
  })
);

export default router;
