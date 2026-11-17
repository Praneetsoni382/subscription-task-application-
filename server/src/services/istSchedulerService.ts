// ============================================================
// INDIAN STANDARD TIME (IST) CLOCK & AUTOMATED SCHEDULER
// File: server/src/services/istSchedulerService.ts
// ============================================================

import { isAdminSdkConfigured } from '../firebase.js';
import {
  taskRepo,
  taskMemberRepo,
  userRepo,
  reminderRepo,
} from '../repositories/firestoreRepository.js';
import { createNotification } from './notificationService.js';
import { format } from 'date-fns';

export interface ISTClockState {
  iso: string;
  time24: string;
  time12: string;
  timeWithSeconds: string;
  date: string;
  dateFormatted: string;
  timezone: string;
  offset: string;
  epoch: number;
  hour: number;
  minute: number;
  second: number;
}

export interface ISTSchedulerStats {
  active: boolean;
  intervalSeconds: number;
  lastCheckAt: string | null;
  totalDispatchesToday: number;
  lastDispatchedSummary: string | null;
  activePendingTasksCount: number;
}

const dispatchedCache = new Set<string>();
let lastCleanedDate = '';
let totalDispatchesToday = 0;
let lastCheckAt: string | null = null;
let lastDispatchedSummary: string | null = null;
let schedulerTimer: NodeJS.Timeout | null = null;

export function getISTClock(): ISTClockState {
  const now = new Date();

  const time24Formatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const time12Formatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  const dateFormatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const fullDateFormatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const parts = time24Formatter.formatToParts(now);
  const hourStr = parts.find((p) => p.type === 'hour')?.value || '00';
  const minStr = parts.find((p) => p.type === 'minute')?.value || '00';
  const secStr = parts.find((p) => p.type === 'second')?.value || '00';

  const time24 = `${hourStr}:${minStr}`;
  const timeWithSeconds = time12Formatter.format(now);
  const time12 = timeWithSeconds.replace(/:\d{2}(\s|$)/, '$1');

  const dateParts = dateFormatter.formatToParts(now);
  const dYear = dateParts.find((p) => p.type === 'year')?.value || '';
  const dMonth = dateParts.find((p) => p.type === 'month')?.value || '';
  const dDay = dateParts.find((p) => p.type === 'day')?.value || '';
  const date = `${dYear}-${dMonth}-${dDay}`;
  const dateFormatted = fullDateFormatter.format(now);

  return {
    iso: now.toISOString(),
    time24,
    time12,
    timeWithSeconds,
    date,
    dateFormatted,
    timezone: 'Asia/Kolkata',
    offset: '+05:30',
    epoch: now.getTime(),
    hour: parseInt(hourStr, 10),
    minute: parseInt(minStr, 10),
    second: parseInt(secStr, 10),
  };
}

export async function getISTSchedulerStats(workspaceId: string): Promise<ISTSchedulerStats> {
  const allTasks = await taskRepo.findAllInWorkspace(workspaceId);
  const activePendingTasks = allTasks.filter(
    (t) => t.status !== 'cancelled' && t.status !== 'approved' && t.reminderEnabled
  );

  return {
    active: schedulerTimer !== null,
    intervalSeconds: 30,
    lastCheckAt,
    totalDispatchesToday,
    lastDispatchedSummary,
    activePendingTasksCount: activePendingTasks.length,
  };
}

export interface DispatchResult {
  dispatchedCount: number;
  tasksChecked: number;
  matchedTasks: number;
  details: Array<{
    taskId: string;
    taskTitle: string;
    recipientUserId: string;
    recipientName: string;
    memberStatus: string;
    slot: string;
    type: string;
  }>;
}

export async function checkAndDispatchPendingReminders(options?: {
  workspaceId?: string;
  targetSlot?: string;
  forceAll?: boolean;
  taskId?: string;
}): Promise<DispatchResult> {
  const ist = getISTClock();
  lastCheckAt = ist.timeWithSeconds + ' IST (' + ist.date + ')';

  if (lastCleanedDate !== ist.date) {
    dispatchedCache.clear();
    lastCleanedDate = ist.date;
    totalDispatchesToday = 0;
  }

  if (!isAdminSdkConfigured) {
    return {
      dispatchedCount: 0,
      tasksChecked: 0,
      matchedTasks: 0,
      details: [],
    };
  }

  const currentSlot = options?.targetSlot || ist.time24;
  const forceAll = Boolean(options?.forceAll);

  const allTasks = options?.workspaceId
    ? await taskRepo.findAllInWorkspace(options.workspaceId)
    : await taskRepo.findAllReminderEnabled();

  const eligibleTasks = allTasks.filter((t) => {
    if (t.status === 'cancelled' || t.status === 'approved') return false;
    if (!t.reminderEnabled && !forceAll) return false;
    if (options?.taskId && t.id !== options.taskId) return false;
    return true;
  });

  const details: DispatchResult['details'] = [];
  let dispatchedCount = 0;
  let matchedTasks = 0;

  for (const task of eligibleTasks) {
    const reminderSlots = task.reminderTimes || [];
    const slotMatches = forceAll || reminderSlots.includes(currentSlot);
    if (!slotMatches) continue;

    matchedTasks++;
    const members = await taskMemberRepo.findByTask(task.id, task.workspaceId);
    const deadline = new Date(task.deadline);
    const isOverdue = deadline < new Date();

    for (const member of members) {
      if (member.memberStatus === 'approved' || member.memberStatus === 'submitted_for_review') {
        continue;
      }

      const user = await userRepo.findByIdInWorkspace(member.userId, task.workspaceId);
      if (!user || !user.active) continue;

      const cacheKey = `${task.id}::${member.userId}::${currentSlot}::${ist.date}`;
      if (!forceAll && dispatchedCache.has(cacheKey)) continue;

      const eventType = isOverdue ? 'TASK_OVERDUE' : 'REMINDER_DUE';
      const deadlineStr = format(deadline, 'dd MMM yyyy, hh:mm a');
      const title = isOverdue
        ? `Overdue Task Alert: ${task.title}`
        : `Pending Task Reminder: ${task.title}`;
      const body = isOverdue
        ? `[IST ${ist.time12}] Your assigned task "${task.title}" is overdue (${member.memberStatus.replace('_', ' ')}). Deadline was ${deadlineStr}. Please submit your pending deliverables.`
        : `[IST ${ist.time12} Reminder] Pending work on "${task.title}" (${member.memberStatus.replace('_', ' ')}). Deadline: ${deadlineStr}. Please review and update your progress.`;

      try {
        await createNotification({
          workspaceId: task.workspaceId,
          recipientUserId: member.userId,
          eventType,
          title,
          body,
          relatedTaskId: task.id,
          navigationUrl: `/employee/tasks/${task.id}`,
        });

        await reminderRepo.create({
          workspaceId: task.workspaceId,
          taskId: task.id,
          recipientUserId: member.userId,
          scheduledFor: new Date().toISOString(),
          timezone: 'Asia/Kolkata',
          reminderType: isOverdue ? 'overdue' : 'submission',
          status: 'delivered',
          skippedReason: null,
        });

        dispatchedCache.add(cacheKey);
        dispatchedCount++;
        totalDispatchesToday++;

        details.push({
          taskId: task.id,
          taskTitle: task.title,
          recipientUserId: member.userId,
          recipientName: user.fullName,
          memberStatus: member.memberStatus,
          slot: currentSlot,
          type: isOverdue ? 'overdue' : 'pending_reminder',
        });
      } catch (sendErr) {
        console.error(`[IST Scheduler] Error dispatching to ${user.email}:`, sendErr);
      }
    }
  }

  if (dispatchedCount > 0) {
    lastDispatchedSummary = `Dispatched ${dispatchedCount} alerts for ${matchedTasks} task(s) at ${currentSlot} IST`;
  }

  return {
    dispatchedCount,
    tasksChecked: eligibleTasks.length,
    matchedTasks,
    details,
  };
}

export function startISTClockAndScheduler(): void {
  if (schedulerTimer) return;

  const initial = getISTClock();
  console.log(`[IST Clock] Active: ${initial.timeWithSeconds} | Date: ${initial.dateFormatted}`);

  if (isAdminSdkConfigured) {
    checkAndDispatchPendingReminders().catch((err) => {
      console.warn('[IST Clock Scheduler] Initial evaluation notice:', err);
    });
  }

  schedulerTimer = setInterval(() => {
    if (!isAdminSdkConfigured) return;
    checkAndDispatchPendingReminders().catch((err) => {
      console.warn('[IST Clock Scheduler] Periodic check notice:', err);
    });
  }, 30_000);
}

export function stopISTClockAndScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
