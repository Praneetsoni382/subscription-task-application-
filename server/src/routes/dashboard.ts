// ============================================================
// DASHBOARD ROUTES (WORKSPACE-SCOPED ASYNC FIRESTORE)
// ============================================================

import { Router } from 'express';
import {
  taskRepo,
  taskMemberRepo,
  userRepo,
  queryRepo,
  statusRequestRepo,
  notificationRepo,
} from '../repositories/firestoreRepository.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getEntitlementForUser } from '../services/subscriptionEntitlementService.js';
import type { Task } from '../types/index.js';

const router = Router();

async function enrichTask(task: Task) {
  const rawMembers = await taskMemberRepo.findByTask(task.id, task.workspaceId);
  const members = await Promise.all(
    rawMembers.map(async (tm) => {
      const user = await userRepo.findByIdInWorkspace(tm.userId, task.workspaceId);
      const safeUser = user
        ? (() => {
            const { passwordHash: _, ...rest } = user;
            return rest;
          })()
        : null;
      return { ...tm, user: safeUser };
    })
  );
  return { ...task, members };
}

// GET /api/dashboard/admin
router.get(
  '/admin',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const admin = req.authUser!;
    const workspaceId = admin.workspaceId;

    const [rawTasks, allQueries, entitlement] = await Promise.all([
      taskRepo.findAllInWorkspace(workspaceId),
      queryRepo.findAllInWorkspace(workspaceId),
      getEntitlementForUser(admin),
    ]);

    const allTasks = rawTasks.filter((t) => t.status !== 'cancelled');
    const now = new Date();

    const totalTasks = allTasks.length;
    const completedTasks = allTasks.filter((t) => t.status === 'approved').length;
    const pendingTasks = allTasks.filter(
      (t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked'
    ).length;
    const submittedForReview = allTasks.filter(
      (t) => t.status === 'submitted_for_review' || t.status === 'revision_requested'
    ).length;

    const activeQueriesList = allQueries.filter(
      (q) => q.status === 'open' || q.status === 'answered'
    );

    const recentTasks = await Promise.all(
      [...allTasks]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 5)
        .map((t) => enrichTask(t))
    );

    const in3Days = new Date();
    in3Days.setDate(in3Days.getDate() + 3);
    const approachingDeadlines = await Promise.all(
      allTasks
        .filter((t) => {
          const dl = new Date(t.deadline);
          return dl >= now && dl <= in3Days && t.status !== 'approved';
        })
        .map((t) => enrichTask(t))
    );

    const overdueTasks = await Promise.all(
      allTasks
        .filter((t) => {
          const dl = new Date(t.deadline);
          return dl < now && t.status !== 'approved' && t.status !== 'submitted_for_review';
        })
        .map((t) => enrichTask(t))
    );

    const openQueries = await Promise.all(
      [...activeQueriesList]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 5)
        .map(async (q) => {
          const [task, creator] = await Promise.all([
            taskRepo.findByIdInWorkspace(q.taskId, workspaceId),
            userRepo.findByIdInWorkspace(q.createdBy, workspaceId),
          ]);
          return {
            ...q,
            taskTitle: task?.title ?? '',
            creatorName: creator?.fullName ?? '',
          };
        })
    );

    const recentSubmissions: Array<Record<string, unknown>> = [];
    for (const task of allTasks) {
      if (recentSubmissions.length >= 5) break;
      const members = await taskMemberRepo.findByTask(task.id, workspaceId);
      for (const m of members) {
        if (m.memberStatus === 'submitted_for_review') {
          const user = await userRepo.findByIdInWorkspace(m.userId, workspaceId);
          if (user) {
            const { passwordHash: _, ...safeUser } = user;
            recentSubmissions.push({ ...m, task, user: safeUser });
            if (recentSubmissions.length >= 5) break;
          }
        }
      }
    }

    res.json({
      success: true,
      data: {
        totalTasks,
        completedTasks,
        pendingTasks,
        submittedForReview,
        activeQueries: activeQueriesList.length,
        recentTasks,
        approachingDeadlines,
        overdueTasks,
        openQueries,
        recentSubmissions,
        entitlement,
      },
    });
  })
);

// GET /api/dashboard/employee
router.get(
  '/employee',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;

    const [myMembers, rawMyTasks, allRequests, myQueries, recentNotifications, entitlement] =
      await Promise.all([
        taskMemberRepo.findByUserInWorkspace(user.id, workspaceId),
        taskRepo.findByMemberInWorkspace(user.id, workspaceId),
        statusRequestRepo.findByRecipientInWorkspace(user.id, workspaceId),
        queryRepo.findByUserInWorkspace(user.id, workspaceId),
        notificationRepo.findByRecipientInWorkspace(user.id, workspaceId),
        getEntitlementForUser(user),
      ]);

    const myTasks = rawMyTasks.filter((t) => t.status !== 'cancelled');
    const totalAssigned = myTasks.length;
    const inProgress = myMembers.filter(
      (m) => m.memberStatus === 'in_progress' || m.memberStatus === 'blocked'
    ).length;
    const submitted = myMembers.filter((m) => m.memberStatus === 'submitted_for_review').length;
    const approved = myMembers.filter((m) => m.memberStatus === 'approved').length;

    const myTasksEnriched = await Promise.all(
      [...myTasks]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((t) => enrichTask(t))
    );

    // Only expose status requests when Premium subscription is active
    const pendingStatusRequests = entitlement.isPremiumActive
      ? await Promise.all(
          allRequests
            .filter((sr) => sr.status === 'pending')
            .map(async (sr) => {
              const task = await taskRepo.findByIdInWorkspace(sr.taskId, workspaceId);
              return { ...sr, task };
            })
        )
      : [];

    const openQueries = myQueries.filter((q) => q.status !== 'resolved').slice(0, 5);

    res.json({
      success: true,
      data: {
        totalAssigned,
        inProgress,
        submitted,
        approved,
        myTasks: myTasksEnriched,
        pendingStatusRequests,
        openQueries,
        recentNotifications: recentNotifications.slice(0, 10),
        entitlement,
      },
    });
  })
);

export default router;
