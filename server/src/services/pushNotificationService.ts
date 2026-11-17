// ============================================================
// PUSH NOTIFICATION SERVICE (Firebase Cloud Messaging)
// File: server/src/services/pushNotificationService.ts
// ============================================================

import { adminMessaging } from '../firebase.js';
import {
  deviceRepo,
  pushPrefRepo,
  userRepo,
  notificationRepo,
} from '../repositories/firestoreRepository.js';
import type { Notification, NotificationEventType, PushPreferences } from '../types/index.js';

function mapEventToCategory(
  eventType: NotificationEventType
): keyof PushPreferences['categories'] {
  switch (eventType) {
    case 'TASK_ASSIGNED':
    case 'TASK_UPDATED':
    case 'DEADLINE_CHANGED':
    case 'TASK_REASSIGNED':
    case 'TASK_CANCELLED':
      return 'taskAssignments';
    case 'STATUS_REQUESTED':
    case 'STATUS_RESPONSE_RECEIVED':
      return 'statusRequests';
    case 'QUERY_CREATED':
    case 'QUERY_ANSWERED':
    case 'QUERY_RESOLVED':
      return 'queries';
    case 'REMINDER_DUE':
    case 'TASK_OVERDUE':
      return 'reminders';
    case 'CHAT_MESSAGE_RECEIVED':
      return 'messages';
    case 'TASK_SUBMITTED':
    case 'TASK_APPROVED':
    case 'REVISION_REQUESTED':
    case 'BLOCKER_REPORTED':
    case 'BLOCKER_RESOLVED':
    case 'GROUP_MEMBER_SUBMITTED':
    case 'GROUP_READY_FOR_REVIEW':
    default:
      return 'approvals';
  }
}

const testPushTimestamps = new Map<string, number[]>();

export function checkTestPushRateLimit(userId: string): {
  allowed: boolean;
  retryAfterSeconds?: number;
} {
  const now = Date.now();
  const windowMs = 60_000;
  const maxRequests = 5;

  const timestamps = (testPushTimestamps.get(userId) || []).filter((t) => now - t < windowMs);

  if (timestamps.length >= maxRequests) {
    const oldest = timestamps[0];
    const retryAfterSeconds = Math.ceil((oldest + windowMs - now) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  timestamps.push(now);
  testPushTimestamps.set(userId, timestamps);
  return { allowed: true };
}

export interface PushResult {
  attempted: boolean;
  status: 'sent' | 'failed' | 'no_active_devices' | 'skipped' | 'unconfigured';
  recipientUserId: string;
  deviceCount: number;
  successCount: number;
  failureCount: number;
  error?: string;
}

export async function sendPushForNotification(notification: Notification): Promise<PushResult> {
  const recipientId = notification.recipientUserId;

  try {
    const user = await userRepo.findById(recipientId);
    if (!user || !user.active || user.workspaceId !== notification.workspaceId) {
      if (!notification.id.startsWith('test-')) {
        await notificationRepo.update(notification.id, {
          pushStatus: 'skipped',
          pushErrorCode: 'USER_INACTIVE_OR_NOT_FOUND',
        });
      }
      return {
        attempted: false,
        status: 'skipped',
        recipientUserId: recipientId,
        deviceCount: 0,
        successCount: 0,
        failureCount: 0,
        error: 'User account is inactive or not found',
      };
    }

    const prefs = await pushPrefRepo.getPreferences(recipientId, notification.workspaceId);
    if (!prefs.enabled) {
      if (!notification.id.startsWith('test-')) {
        await notificationRepo.update(notification.id, { pushStatus: 'skipped' });
      }
      return {
        attempted: false,
        status: 'skipped',
        recipientUserId: recipientId,
        deviceCount: 0,
        successCount: 0,
        failureCount: 0,
      };
    }

    const category = mapEventToCategory(notification.eventType);
    if (prefs.categories && prefs.categories[category] === false) {
      if (!notification.id.startsWith('test-')) {
        await notificationRepo.update(notification.id, { pushStatus: 'skipped' });
      }
      return {
        attempted: false,
        status: 'skipped',
        recipientUserId: recipientId,
        deviceCount: 0,
        successCount: 0,
        failureCount: 0,
      };
    }

    const activeDevices = await deviceRepo.findActiveByUser(recipientId);
    if (activeDevices.length === 0) {
      if (!notification.id.startsWith('test-')) {
        await notificationRepo.update(notification.id, { pushStatus: 'no_active_devices' });
      }
      return {
        attempted: false,
        status: 'no_active_devices',
        recipientUserId: recipientId,
        deviceCount: 0,
        successCount: 0,
        failureCount: 0,
      };
    }

    const validDevices = activeDevices.filter((d) => d.fcmToken && d.fcmToken.length > 20);
    if (!adminMessaging || validDevices.length === 0) {
      if (!notification.id.startsWith('test-')) {
        await notificationRepo.update(notification.id, {
          pushStatus: 'skipped',
          pushErrorCode: !adminMessaging ? 'FCM_ADMIN_UNCONFIGURED' : 'NO_VALID_TOKENS',
        });
      }
      return {
        attempted: false,
        status: 'unconfigured',
        recipientUserId: recipientId,
        deviceCount: activeDevices.length,
        successCount: 0,
        failureCount: 0,
        error: !adminMessaging
          ? 'Firebase Admin Messaging is not configured with service account credentials.'
          : 'No valid FCM tokens found.',
      };
    }

    const targetUrl = notification.navigationUrl || '/';
    const tag = notification.relatedTaskId
      ? `task-${notification.relatedTaskId}`
      : `notif-${notification.id}`;

    const payloadData = {
      notificationId: String(notification.id),
      workspaceId: String(notification.workspaceId),
      eventType: String(notification.eventType),
      title: String(notification.title),
      body: String(notification.body),
      url: targetUrl,
      relatedTaskId: String(notification.relatedTaskId || ''),
      relatedQueryId: String(notification.relatedQueryId || ''),
      relatedStatusRequestId: String(notification.relatedStatusRequestId || ''),
      timestamp: String(Date.now()),
    };

    const now = new Date().toISOString();
    const tokens = validDevices.map((d) => d.fcmToken);

    const response = await adminMessaging.sendEachForMulticast({
      tokens,
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: payloadData,
      webpush: {
        headers: {
          Urgency: 'high',
          TTL: '86400',
        },
        notification: {
          title: notification.title,
          body: notification.body,
          icon: '/favicon.svg',
          badge: '/favicon.svg',
          tag,
          data: payloadData,
          requireInteraction: true,
          vibrate: [200, 100, 200],
        },
        fcmOptions: {
          link: targetUrl,
        },
      },
    });

    await Promise.all(
      response.responses.map(async (resp, idx) => {
        const device = validDevices[idx];
        if (resp.success) {
          await deviceRepo.updateDevice(recipientId, device.deviceId, {
            lastSuccessfulSendAt: now,
            lastSeenAt: now,
          });
        } else {
          const errCode = resp.error?.code || 'UNKNOWN_ERROR';
          if (
            errCode === 'messaging/invalid-registration-token' ||
            errCode === 'messaging/registration-token-not-registered' ||
            errCode === 'messaging/invalid-argument'
          ) {
            await deviceRepo.deactivateDevice(recipientId, device.deviceId);
          } else {
            await deviceRepo.updateDevice(recipientId, device.deviceId, {
              lastErrorAt: now,
            });
          }
        }
      })
    );

    if (!notification.id.startsWith('test-')) {
      await notificationRepo.update(notification.id, {
        pushStatus: response.successCount > 0 ? 'sent' : 'failed',
        pushSentAt: response.successCount > 0 ? now : undefined,
      });
    }

    return {
      attempted: true,
      status: response.successCount > 0 ? 'sent' : 'failed',
      recipientUserId: recipientId,
      deviceCount: validDevices.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
    };
  } catch (err) {
    console.error('Unhandled push notification delivery error:', err);
    return {
      attempted: false,
      status: 'failed',
      recipientUserId: recipientId,
      deviceCount: 0,
      successCount: 0,
      failureCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function sendTestPushToUser(
  userId: string,
  workspaceId: string
): Promise<PushResult> {
  const activeDevices = await deviceRepo.findActiveByUser(userId);
  if (activeDevices.length === 0) {
    return {
      attempted: false,
      status: 'no_active_devices',
      recipientUserId: userId,
      deviceCount: 0,
      successCount: 0,
      failureCount: 0,
      error:
        'No active registered browser push device found for this account. Please enable notifications in your browser first.',
    };
  }

  const testNotif: Notification = {
    id: `test-${Date.now()}`,
    workspaceId,
    recipientUserId: userId,
    eventType: 'TASK_UPDATED',
    title: 'TaskFlow Push Notification Verified',
    body: 'Your device is successfully registered to receive real-time push alerts and task updates.',
    relatedTaskId: null,
    relatedQueryId: null,
    relatedStatusRequestId: null,
    readAt: null,
    createdAt: new Date().toISOString(),
    deliveryState: 'delivered',
    navigationUrl: '/',
  };

  return sendPushForNotification(testNotif);
}
