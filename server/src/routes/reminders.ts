// ============================================================
// REMINDERS & IST SCHEDULER ROUTES (WORKSPACE-SCOPED ASYNC)
// ============================================================

import { Router } from 'express';
import {
  taskRepo,
  taskMemberRepo,
  userRepo,
  reminderRepo,
} from '../repositories/firestoreRepository.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createNotification } from '../services/notificationService.js';
import {
  getISTClock,
  getISTSchedulerStats,
  checkAndDispatchPendingReminders,
} from '../services/istSchedulerService.js';
import { format } from 'date-fns';

const router = Router();

// GET /api/reminders/ist-status
router.get(
  '/ist-status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const workspaceId = req.authUser!.workspaceId;
    const istClock = getISTClock();
    const [stats, allTasks] = await Promise.all([
      getISTSchedulerStats(workspaceId),
      taskRepo.findAllInWorkspace(workspaceId),
    ]);

    const scheduledTasks = await Promise.all(
      allTasks
        .filter((t) => t.status !== 'cancelled' && t.status !== 'approved' && t.reminderEnabled)
        .map(async (t) => {
          const members = await taskMemberRepo.findByTask(t.id, workspaceId);
          const pendingMembers = members.filter(
            (m) => m.memberStatus !== 'approved' && m.memberStatus !== 'submitted_for_review'
          );
          const enrichedPending = await Promise.all(
            pendingMembers.map(async (pm) => {
              const u = await userRepo.findByIdInWorkspace(pm.userId, workspaceId);
              return {
                userId: pm.userId,
                fullName: u?.fullName || 'Employee',
                memberStatus: pm.memberStatus,
              };
            })
          );
          return {
            id: t.id,
            referenceNumber: t.referenceNumber,
            title: t.title,
            deadline: t.deadline,
            reminderTimes: t.reminderTimes || [],
            pendingMembersCount: pendingMembers.length,
            pendingMembers: enrichedPending,
          };
        })
    );

    res.json({
      success: true,
      data: {
        clock: istClock,
        stats,
        scheduledTasks,
      },
    });
  })
);

// POST /api/reminders/trigger-ist
router.post(
  '/trigger-ist',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const workspaceId = req.authUser!.workspaceId;
    const { slot, forceAll, taskId } = req.body || {};
    const result = await checkAndDispatchPendingReminders({
      workspaceId,
      targetSlot: slot,
      forceAll: forceAll !== undefined ? Boolean(forceAll) : true,
      taskId,
    });

    res.json({
      success: true,
      message: `Triggered pending task notification dispatch (${result.dispatchedCount} notification(s) sent)`,
      data: result,
    });
  })
);

interface ReminderResult {
  taskId: string;
  taskTitle: string;
  userId: string;
  userName: string;
  reminderType: string;
  eligible: boolean;
  reason?: string;
}

async function evaluateReminders(workspaceId: string): Promise<ReminderResult[]> {
  const now = new Date();
  const results: ReminderResult[] = [];

  const tasks = (await taskRepo.findAllInWorkspace(workspaceId)).filter(
    (t) => t.status !== 'cancelled' && t.reminderEnabled
  );

  for (const task of tasks) {
    const members = await taskMemberRepo.findByTask(task.id, workspaceId);
    const deadline = new Date(task.deadline);

    for (const member of members) {
      const user = await userRepo.findByIdInWorkspace(member.userId, workspaceId);
      if (!user) continue;

      if (member.memberStatus === 'approved') {
        results.push({
          taskId: task.id,
          taskTitle: task.title,
          userId: member.userId,
          userName: user.fullName,
          reminderType: 'submission',
          eligible: false,
          reason: 'Task already approved',
        });
        continue;
      }

      if (!member.reminderEligible) {
        results.push({
          taskId: task.id,
          taskTitle: task.title,
          userId: member.userId,
          userName: user.fullName,
          reminderType: 'submission',
          eligible: false,
          reason: 'Reminder eligibility disabled (submitted or inactive)',
        });
        continue;
      }

      if (member.memberStatus === 'submitted_for_review') {
        results.push({
          taskId: task.id,
          taskTitle: task.title,
          userId: member.userId,
          userName: user.fullName,
          reminderType: 'submission',
          eligible: false,
          reason: 'Already submitted for review',
        });
        continue;
      }

      if (deadline < now) {
        results.push({
          taskId: task.id,
          taskTitle: task.title,
          userId: member.userId,
          userName: user.fullName,
          reminderType: 'overdue',
          eligible: true,
        });
        continue;
      }

      const hoursToDeadline = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);
      if (hoursToDeadline <= 24) {
        results.push({
          taskId: task.id,
          taskTitle: task.title,
          userId: member.userId,
          userName: user.fullName,
          reminderType: 'deadline',
          eligible: true,
        });
        continue;
      }

      results.push({
        taskId: task.id,
        taskTitle: task.title,
        userId: member.userId,
        userName: user.fullName,
        reminderType: 'submission',
        eligible: true,
      });
    }
  }

  return results;
}

// GET /api/reminders/preview
router.get(
  '/preview',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const results = await evaluateReminders(req.authUser!.workspaceId);
    res.json({ success: true, data: results });
  })
);

// POST /api/reminders/evaluate
router.post(
  '/evaluate',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const workspaceId = req.authUser!.workspaceId;
    const results = await evaluateReminders(workspaceId);
    const eligible = results.filter((r) => r.eligible);

    for (const reminder of eligible) {
      const task = await taskRepo.findByIdInWorkspace(reminder.taskId, workspaceId);
      if (!task) continue;

      let title = '';
      let body = '';

      if (reminder.reminderType === 'overdue') {
        title = 'Task Overdue';
        body = `Your task "${task.title}" is overdue. Please submit or update your status.`;
      } else if (reminder.reminderType === 'deadline') {
        title = 'Deadline Approaching';
        body = `Your task "${task.title}" deadline is approaching (${format(new Date(task.deadline), 'dd/MM/yyyy')}).`;
      } else {
        title = 'Task Submission Reminder';
        body = `Please update your progress on "${task.title}".`;
      }

      await createNotification({
        workspaceId,
        recipientUserId: reminder.userId,
        eventType: reminder.reminderType === 'overdue' ? 'TASK_OVERDUE' : 'REMINDER_DUE',
        title,
        body,
        relatedTaskId: reminder.taskId,
        navigationUrl: `/employee/tasks/${reminder.taskId}`,
      });

      await reminderRepo.create({
        workspaceId,
        taskId: reminder.taskId,
        recipientUserId: reminder.userId,
        scheduledFor: new Date().toISOString(),
        timezone: task.timezone,
        reminderType: reminder.reminderType as 'submission' | 'deadline' | 'overdue',
        status: 'delivered',
        skippedReason: null,
      });
    }

    res.json({
      success: true,
      data: {
        total: results.length,
        eligible: eligible.length,
        skipped: results.length - eligible.length,
        results,
      },
    });
  })
);

export default router;
