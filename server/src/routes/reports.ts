// ============================================================
// REPORTS ROUTES (WORKSPACE-SCOPED ASYNC FIRESTORE)
// ============================================================

import { Router } from 'express';
import {
  taskRepo,
  taskMemberRepo,
  userRepo,
  queryRepo,
} from '../repositories/firestoreRepository.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { format } from 'date-fns';

const router = Router();

// GET /api/reports
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.authUser!;
    const workspaceId = user.workspaceId;
    const { startDate, endDate, department, employeeId, status, priority, assignmentType } =
      req.query;

    const isAdmin = user.role === 'admin';

    let tasks = isAdmin
      ? await taskRepo.findAllInWorkspace(workspaceId)
      : await taskRepo.findByMemberInWorkspace(user.id, workspaceId);

    if (startDate && typeof startDate === 'string') {
      tasks = tasks.filter((t) => new Date(t.createdAt) >= new Date(startDate));
    }
    if (endDate && typeof endDate === 'string') {
      tasks = tasks.filter((t) => new Date(t.createdAt) <= new Date(endDate));
    }
    if (department && typeof department === 'string' && isAdmin) {
      tasks = tasks.filter((t) => t.department === department);
    }
    if (status && typeof status === 'string') {
      tasks = tasks.filter((t) => t.status === status);
    }
    if (priority && typeof priority === 'string') {
      tasks = tasks.filter((t) => t.priority === priority);
    }
    if (assignmentType && typeof assignmentType === 'string') {
      tasks = tasks.filter((t) => t.assignmentType === assignmentType);
    }

    const now = new Date();

    const report = await Promise.all(
      tasks.map(async (task) => {
        const [rawMembers, taskQueries] = await Promise.all([
          taskMemberRepo.findByTask(task.id, workspaceId),
          queryRepo.findByTaskInWorkspace(task.id, workspaceId),
        ]);

        const members = await Promise.all(
          rawMembers.map(async (tm) => {
            const memberUser = await userRepo.findByIdInWorkspace(tm.userId, workspaceId);
            const queries = taskQueries.filter((q) => q.createdBy === tm.userId);
            return {
              userId: tm.userId,
              fullName: memberUser?.fullName ?? 'Unknown',
              department: memberUser?.department ?? '',
              memberStatus: tm.memberStatus,
              submittedAt: tm.submittedAt
                ? format(new Date(tm.submittedAt), 'dd/MM/yyyy HH:mm')
                : null,
              approvedAt: tm.approvedAt
                ? format(new Date(tm.approvedAt), 'dd/MM/yyyy HH:mm')
                : null,
              openQueries: queries.filter((q) => q.status !== 'resolved').length,
            };
          })
        );

        const isOverdue = new Date(task.deadline) < now && task.status !== 'approved';

        return {
          taskId: task.id,
          referenceNumber: task.referenceNumber,
          title: task.title,
          assignmentType: task.assignmentType,
          priority: task.priority,
          status: task.status,
          deadline: format(new Date(task.deadline), 'dd/MM/yyyy'),
          isOverdue,
          category: task.category,
          department: task.department,
          createdAt: format(new Date(task.createdAt), 'dd/MM/yyyy'),
          members,
        };
      })
    );

    let filteredReport = report;
    if (employeeId && typeof employeeId === 'string' && isAdmin) {
      filteredReport = report.filter((r) => r.members.some((m) => m.userId === employeeId));
    }

    res.json({
      success: true,
      data: {
        total: filteredReport.length,
        tasks: filteredReport,
        generatedAt: format(now, 'dd/MM/yyyy HH:mm'),
      },
    });
  })
);

export default router;
