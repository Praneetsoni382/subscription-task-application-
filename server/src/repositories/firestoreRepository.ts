// ============================================================
// AUTHORITATIVE CLOUD FIRESTORE REPOSITORY LAYER
// Zero in-memory fallback, strict workspaceId isolation
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import {
  requireAdminDb,
  wrapFirestoreError,
  FieldValue,
} from '../firebase.js';
import type {
  Workspace,
  User,
  Task,
  TaskMember,
  StatusRequest,
  StatusResponse,
  Query,
  QueryMessage,
  ChatMessage,
  Notification,
  Device,
  PushPreferences,
  ReminderOccurrence,
  AuditEvent,
  Meeting,
  GoogleAuthTokens,
  OAuthState,
  Subscription,
  SubscriptionPeriod,
  SubscriptionUsage,
  SubscriptionEvent,
  Payment,
  PaymentEvent,
  MeetGenerationOperation,
  ActiveSession,
} from '../types/index.js';

export function newId(): string {
  return uuidv4();
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function getDocById<T>(col: string, id: string): Promise<T | null> {
  const db = requireAdminDb();
  try {
    const snap = await db.collection(col).doc(id).get();
    if (!snap.exists) return null;
    return { id: snap.id, ...(snap.data() as object) } as T;
  } catch (err) {
    wrapFirestoreError(err, `getDoc(${col}/${id})`);
  }
}

async function queryEquals<T>(
  col: string,
  filters: Array<[string, unknown]>
): Promise<T[]> {
  const db = requireAdminDb();
  try {
    let q: FirebaseFirestore.Query = db.collection(col);
    for (const [field, value] of filters) {
      q = q.where(field, '==', value);
    }
    const snap = await q.get();
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as object) }) as T);
  } catch (err) {
    wrapFirestoreError(err, `query(${col})`);
  }
}

async function setDocData<T extends object>(
  col: string,
  id: string,
  data: T,
  merge = false
): Promise<T> {
  const db = requireAdminDb();
  try {
    await db.collection(col).doc(id).set(data, { merge });
    return data;
  } catch (err) {
    wrapFirestoreError(err, `setDoc(${col}/${id})`);
  }
}

async function updateDocData<T>(
  col: string,
  id: string,
  updates: Partial<T>
): Promise<T | null> {
  const db = requireAdminDb();
  try {
    const ref = db.collection(col).doc(id);
    const snap = await ref.get();
    if (!snap.exists) return null;
    await ref.set(updates as Record<string, unknown>, { merge: true });
    const fresh = await ref.get();
    return { id: fresh.id, ...(fresh.data() as object) } as T;
  } catch (err) {
    wrapFirestoreError(err, `updateDoc(${col}/${id})`);
  }
}

async function deleteDocData(col: string, id: string): Promise<void> {
  const db = requireAdminDb();
  try {
    await db.collection(col).doc(id).delete();
  } catch (err) {
    wrapFirestoreError(err, `deleteDoc(${col}/${id})`);
  }
}

export async function nextTaskRef(workspaceId: string): Promise<string> {
  const db = requireAdminDb();
  try {
    const counterRef = db.collection('workspaces').doc(workspaceId).collection('counters').doc('tasks');
    const nextNum = await db.runTransaction(async (tx) => {
      const snap = await tx.get(counterRef);
      const current = snap.exists ? Number(snap.data()?.seq || 0) : 0;
      const next = current + 1;
      tx.set(counterRef, { seq: next, updatedAt: nowIso() }, { merge: true });
      return next;
    });
    return `TSK-${String(nextNum).padStart(3, '0')}`;
  } catch (err) {
    wrapFirestoreError(err, 'nextTaskRef');
  }
}

// ============================================================
// WORKSPACES
// ============================================================
export const workspaceRepo = {
  findById: (id: string) => getDocById<Workspace>('workspaces', id),
  findAll: async (): Promise<Workspace[]> => {
    const db = requireAdminDb();
    try {
      const snap = await db.collection('workspaces').get();
      return snap.docs.map((d) => ({ id: d.id, ...(d.data() as object) }) as Workspace);
    } catch (err) {
      wrapFirestoreError(err, 'workspaceRepo.findAll');
    }
  },
  findByOwnerUid: (ownerUid: string) =>
    queryEquals<Workspace>('workspaces', [['ownerUid', ownerUid]]),
  create: async (data: Omit<Workspace, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<Workspace> => {
    const id = data.id || newId();
    const now = nowIso();
    const ws: Workspace = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
    };
    return setDocData('workspaces', id, ws);
  },
  update: (id: string, updates: Partial<Workspace>) =>
    updateDocData<Workspace>('workspaces', id, { ...updates, updatedAt: nowIso() }),
};

// ============================================================
// USERS
// ============================================================
export const userRepo = {
  findById: (id: string) => getDocById<User>('users', id),
  findByIdInWorkspace: async (id: string, workspaceId: string): Promise<User | null> => {
    const user = await getDocById<User>('users', id);
    if (!user || user.workspaceId !== workspaceId) return null;
    return user;
  },
  findByEmail: async (email: string): Promise<User | null> => {
    const matches = await queryEquals<User>('users', [['email', normalizeEmail(email)]]);
    return matches[0] || null;
  },
  findByEmailInWorkspace: async (email: string, workspaceId: string): Promise<User | null> => {
    const matches = await queryEquals<User>('users', [
      ['workspaceId', workspaceId],
      ['email', normalizeEmail(email)],
    ]);
    return matches[0] || null;
  },
  findByEmployeeIdInWorkspace: async (employeeId: string, workspaceId: string): Promise<User | null> => {
    const matches = await queryEquals<User>('users', [
      ['workspaceId', workspaceId],
      ['employeeId', employeeId.trim()],
    ]);
    return matches[0] || null;
  },
  findAllInWorkspace: (workspaceId: string) =>
    queryEquals<User>('users', [['workspaceId', workspaceId]]),
  findAdminsInWorkspace: (workspaceId: string) =>
    queryEquals<User>('users', [
      ['workspaceId', workspaceId],
      ['role', 'admin'],
    ]),
  create: async (
    data: Omit<User, 'id' | 'uid' | 'createdAt' | 'updatedAt' | 'lastLoginAt' | 'accountStatus'> & {
      id?: string;
      uid?: string;
      accountStatus?: 'active' | 'deactivated';
      lastLoginAt?: string | null;
    }
  ): Promise<User> => {
    const id = data.uid || data.id || newId();
    const now = nowIso();
    const user: User = {
      ...data,
      id,
      uid: id,
      email: normalizeEmail(data.email),
      accountStatus: data.accountStatus || (data.active ? 'active' : 'deactivated'),
      lastLoginAt: data.lastLoginAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    return setDocData('users', id, user);
  },
  update: (id: string, updates: Partial<User>) => {
    const cleanUpdates: Partial<User> = { ...updates, updatedAt: nowIso() };
    if (typeof cleanUpdates.email === 'string') {
      cleanUpdates.email = normalizeEmail(cleanUpdates.email);
    }
    if (typeof cleanUpdates.active === 'boolean' && !cleanUpdates.accountStatus) {
      cleanUpdates.accountStatus = cleanUpdates.active ? 'active' : 'deactivated';
    }
    return updateDocData<User>('users', id, cleanUpdates);
  },
};

// ============================================================
// TASKS
// ============================================================
export const taskRepo = {
  findById: (id: string) => getDocById<Task>('tasks', id),
  findByIdInWorkspace: async (id: string, workspaceId: string): Promise<Task | null> => {
    const task = await getDocById<Task>('tasks', id);
    if (!task || task.workspaceId !== workspaceId) return null;
    return task;
  },
  findAllInWorkspace: (workspaceId: string) =>
    queryEquals<Task>('tasks', [['workspaceId', workspaceId]]),
  findAllReminderEnabled: () =>
    queryEquals<Task>('tasks', [['reminderEnabled', true]]),
  findByMemberInWorkspace: async (userId: string, workspaceId: string): Promise<Task[]> => {
    const memberships = await queryEquals<TaskMember>('taskMembers', [
      ['workspaceId', workspaceId],
      ['userId', userId],
    ]);
    if (memberships.length === 0) return [];
    const taskIds = [...new Set(memberships.map((m) => m.taskId))];
    const tasks = await Promise.all(taskIds.map((tid) => getDocById<Task>('tasks', tid)));
    return tasks.filter((t): t is Task => Boolean(t && t.workspaceId === workspaceId));
  },
  create: async (data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<Task> => {
    const id = data.id || newId();
    const now = nowIso();
    const task: Task = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
    };
    return setDocData('tasks', id, task);
  },
  update: (id: string, updates: Partial<Task>) =>
    updateDocData<Task>('tasks', id, { ...updates, updatedAt: nowIso() }),
};

// ============================================================
// TASK MEMBERS
// ============================================================
export const taskMemberRepo = {
  findById: (id: string) => getDocById<TaskMember>('taskMembers', id),
  findByTask: (taskId: string, workspaceId?: string) => {
    const filters: Array<[string, unknown]> = [['taskId', taskId]];
    if (workspaceId) filters.push(['workspaceId', workspaceId]);
    return queryEquals<TaskMember>('taskMembers', filters);
  },
  findByUserInWorkspace: (userId: string, workspaceId: string) =>
    queryEquals<TaskMember>('taskMembers', [
      ['workspaceId', workspaceId],
      ['userId', userId],
    ]),
  findByTaskAndUser: async (
    taskId: string,
    userId: string,
    workspaceId?: string
  ): Promise<TaskMember | null> => {
    const filters: Array<[string, unknown]> = [
      ['taskId', taskId],
      ['userId', userId],
    ];
    if (workspaceId) filters.push(['workspaceId', workspaceId]);
    const list = await queryEquals<TaskMember>('taskMembers', filters);
    return list[0] || null;
  },
  create: async (data: Omit<TaskMember, 'id'>): Promise<TaskMember> => {
    const id = newId();
    const now = nowIso();
    const member: TaskMember = {
      ...data,
      id,
      assignedAt: data.assignedAt || now,
      updatedAt: now,
    };
    const db = requireAdminDb();
    try {
      await db.collection('taskMembers').doc(id).set(member);
      await db
        .collection('tasks')
        .doc(member.taskId)
        .collection('members')
        .doc(member.userId)
        .set(member);
      return member;
    } catch (err) {
      wrapFirestoreError(err, 'taskMemberRepo.create');
    }
  },
  update: async (id: string, updates: Partial<TaskMember>): Promise<TaskMember | null> => {
    const now = nowIso();
    const updated = await updateDocData<TaskMember>('taskMembers', id, {
      ...updates,
      updatedAt: now,
    });
    if (updated) {
      const db = requireAdminDb();
      await db
        .collection('tasks')
        .doc(updated.taskId)
        .collection('members')
        .doc(updated.userId)
        .set(updated, { merge: true });
    }
    return updated;
  },
};

// ============================================================
// STATUS REQUESTS & RESPONSES
// ============================================================
export const statusRequestRepo = {
  findById: (id: string) => getDocById<StatusRequest>('statusRequests', id),
  findByIdInWorkspace: async (id: string, workspaceId: string): Promise<StatusRequest | null> => {
    const sr = await getDocById<StatusRequest>('statusRequests', id);
    if (!sr || sr.workspaceId !== workspaceId) return null;
    return sr;
  },
  findAllInWorkspace: (workspaceId: string) =>
    queryEquals<StatusRequest>('statusRequests', [['workspaceId', workspaceId]]),
  findByRecipientInWorkspace: (userId: string, workspaceId: string) =>
    queryEquals<StatusRequest>('statusRequests', [
      ['workspaceId', workspaceId],
      ['recipientUserId', userId],
    ]),
  findByTaskInWorkspace: (taskId: string, workspaceId: string) =>
    queryEquals<StatusRequest>('statusRequests', [
      ['workspaceId', workspaceId],
      ['taskId', taskId],
    ]),
  create: async (
    data: Omit<StatusRequest, 'id' | 'updatedAt'> & { id?: string }
  ): Promise<StatusRequest> => {
    const id = data.id || newId();
    const sr: StatusRequest = {
      ...data,
      id,
      updatedAt: data.createdAt || nowIso(),
    };
    return setDocData('statusRequests', id, sr);
  },
  update: (id: string, updates: Partial<StatusRequest>) =>
    updateDocData<StatusRequest>('statusRequests', id, { ...updates, updatedAt: nowIso() }),
};

export const statusResponseRepo = {
  findByRequestInWorkspace: (requestId: string, workspaceId: string) =>
    queryEquals<StatusResponse>('statusResponses', [
      ['workspaceId', workspaceId],
      ['statusRequestId', requestId],
    ]),
  create: async (
    data: Omit<StatusResponse, 'id' | 'updatedAt'>
  ): Promise<StatusResponse> => {
    const id = newId();
    const resp: StatusResponse = {
      ...data,
      id,
      updatedAt: data.createdAt || nowIso(),
    };
    return setDocData('statusResponses', id, resp);
  },
};

// ============================================================
// QUERIES & QUERY MESSAGES
// ============================================================
export const queryRepo = {
  findById: (id: string) => getDocById<Query>('queries', id),
  findByIdInWorkspace: async (id: string, workspaceId: string): Promise<Query | null> => {
    const q = await getDocById<Query>('queries', id);
    if (!q || q.workspaceId !== workspaceId) return null;
    return q;
  },
  findAllInWorkspace: (workspaceId: string) =>
    queryEquals<Query>('queries', [['workspaceId', workspaceId]]),
  findByTaskInWorkspace: (taskId: string, workspaceId: string) =>
    queryEquals<Query>('queries', [
      ['workspaceId', workspaceId],
      ['taskId', taskId],
    ]),
  findByUserInWorkspace: (userId: string, workspaceId: string) =>
    queryEquals<Query>('queries', [
      ['workspaceId', workspaceId],
      ['createdBy', userId],
    ]),
  create: async (data: Omit<Query, 'id' | 'createdAt' | 'updatedAt'>): Promise<Query> => {
    const id = newId();
    const now = nowIso();
    const q: Query = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
    };
    return setDocData('queries', id, q);
  },
  update: (id: string, updates: Partial<Query>) =>
    updateDocData<Query>('queries', id, { ...updates, updatedAt: nowIso() }),
};

export const queryMessageRepo = {
  findByQueryInWorkspace: async (queryId: string, workspaceId: string): Promise<QueryMessage[]> => {
    const list = await queryEquals<QueryMessage>('queryMessages', [
      ['workspaceId', workspaceId],
      ['queryId', queryId],
    ]);
    return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  create: async (data: Omit<QueryMessage, 'id'>): Promise<QueryMessage> => {
    const id = newId();
    const msg: QueryMessage = { ...data, id };
    const db = requireAdminDb();
    try {
      await db.collection('queryMessages').doc(id).set(msg);
      await db.collection('queries').doc(msg.queryId).collection('messages').doc(id).set(msg);
      return msg;
    } catch (err) {
      wrapFirestoreError(err, 'queryMessageRepo.create');
    }
  },
};

// ============================================================
// TASK CHAT MESSAGES
// ============================================================
export const chatMessageRepo = {
  findByTaskInWorkspace: async (taskId: string, workspaceId: string): Promise<ChatMessage[]> => {
    const list = await queryEquals<ChatMessage>('chatMessages', [
      ['workspaceId', workspaceId],
      ['taskId', taskId],
    ]);
    return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  create: async (data: Omit<ChatMessage, 'id'>): Promise<ChatMessage> => {
    const id = newId();
    const msg: ChatMessage = { ...data, id };
    const db = requireAdminDb();
    try {
      await db.collection('chatMessages').doc(id).set(msg);
      await db.collection('tasks').doc(msg.taskId).collection('messages').doc(id).set(msg);
      return msg;
    } catch (err) {
      wrapFirestoreError(err, 'chatMessageRepo.create');
    }
  },
};

// ============================================================
// NOTIFICATIONS
// ============================================================
export const notificationRepo = {
  findById: (id: string) => getDocById<Notification>('notifications', id),
  findByRecipientInWorkspace: async (
    userId: string,
    workspaceId: string
  ): Promise<Notification[]> => {
    const list = await queryEquals<Notification>('notifications', [
      ['workspaceId', workspaceId],
      ['recipientUserId', userId],
    ]);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  create: async (data: Omit<Notification, 'id'>): Promise<Notification> => {
    const id = newId();
    const notif: Notification = { ...data, id };
    return setDocData('notifications', id, notif);
  },
  update: (id: string, updates: Partial<Notification>) =>
    updateDocData<Notification>('notifications', id, updates),
  markAllRead: async (userId: string, workspaceId: string): Promise<void> => {
    const db = requireAdminDb();
    try {
      const list = await queryEquals<Notification>('notifications', [
        ['workspaceId', workspaceId],
        ['recipientUserId', userId],
        ['readAt', null],
      ]);
      const now = nowIso();
      const batch = db.batch();
      let count = 0;
      for (const n of list) {
        batch.set(
          db.collection('notifications').doc(n.id),
          { readAt: now, deliveryState: 'read' },
          { merge: true }
        );
        count++;
        if (count >= 400) break; // safe batch limit
      }
      if (count > 0) await batch.commit();
    } catch (err) {
      wrapFirestoreError(err, 'notificationRepo.markAllRead');
    }
  },
};

// ============================================================
// DEVICES & PUSH PREFERENCES
// ============================================================
export const deviceRepo = {
  findByDeviceId: (deviceId: string) => getDocById<Device>('devices', deviceId),
  findByUserInWorkspace: (userId: string, workspaceId: string) =>
    queryEquals<Device>('devices', [
      ['workspaceId', workspaceId],
      ['userId', userId],
    ]),
  findActiveByUser: (userId: string) =>
    queryEquals<Device>('devices', [
      ['userId', userId],
      ['isActive', true],
    ]),
  registerDevice: async (
    input: Omit<
      Device,
      'createdAt' | 'updatedAt' | 'lastSeenAt' | 'isActive' | 'lastSuccessfulSendAt' | 'lastErrorAt' | 'tokenVersion'
    >
  ): Promise<Device> => {
    const db = requireAdminDb();
    const now = nowIso();
    try {
      // Deactivate any stale registrations claiming the same fcmToken for other users
      const sameToken = await queryEquals<Device>('devices', [['fcmToken', input.fcmToken]]);
      for (const dev of sameToken) {
        if (dev.userId !== input.userId && dev.isActive) {
          await db.collection('devices').doc(dev.deviceId).set({ isActive: false, updatedAt: now }, { merge: true });
          await db
            .collection('users')
            .doc(dev.userId)
            .collection('devices')
            .doc(dev.deviceId)
            .set({ isActive: false, updatedAt: now }, { merge: true });
        }
      }

      const existing = await getDocById<Device>('devices', input.deviceId);
      const record: Device = {
        ...input,
        isActive: true,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        lastSeenAt: now,
        lastSuccessfulSendAt: existing?.lastSuccessfulSendAt ?? null,
        lastErrorAt: existing?.lastErrorAt ?? null,
        tokenVersion: 'v1',
      };

      await db.collection('devices').doc(record.deviceId).set(record);
      await db
        .collection('users')
        .doc(record.userId)
        .collection('devices')
        .doc(record.deviceId)
        .set(record);
      return record;
    } catch (err) {
      wrapFirestoreError(err, 'deviceRepo.registerDevice');
    }
  },
  updateDevice: async (
    userId: string,
    deviceId: string,
    updates: Partial<Device>
  ): Promise<Device | null> => {
    const existing = await getDocById<Device>('devices', deviceId);
    if (!existing || existing.userId !== userId) return null;
    const now = nowIso();
    const updated = await updateDocData<Device>('devices', deviceId, {
      ...updates,
      updatedAt: now,
    });
    if (updated) {
      const db = requireAdminDb();
      await db
        .collection('users')
        .doc(userId)
        .collection('devices')
        .doc(deviceId)
        .set(updated, { merge: true });
    }
    return updated;
  },
  deactivateDevice: async (userId: string, deviceId: string): Promise<boolean> => {
    const existing = await getDocById<Device>('devices', deviceId);
    if (!existing || existing.userId !== userId) return false;
    await deviceRepo.updateDevice(userId, deviceId, { isActive: false });
    return true;
  },
};

export const pushPrefRepo = {
  getPreferences: async (userId: string, workspaceId = ''): Promise<PushPreferences> => {
    const existing = await getDocById<PushPreferences>('pushPreferences', userId);
    if (existing) return existing;
    const defaults: PushPreferences = {
      workspaceId,
      userId,
      enabled: true,
      categories: {
        taskAssignments: true,
        statusRequests: true,
        queries: true,
        reminders: true,
        messages: true,
        approvals: true,
      },
      updatedAt: nowIso(),
    };
    return setDocData('pushPreferences', userId, defaults);
  },
  updatePreferences: async (
    userId: string,
    workspaceId: string,
    updates: { enabled?: boolean; categories?: Partial<PushPreferences['categories']> }
  ): Promise<PushPreferences> => {
    const current = await pushPrefRepo.getPreferences(userId, workspaceId);
    const merged: PushPreferences = {
      ...current,
      ...updates,
      workspaceId: workspaceId || current.workspaceId,
      categories: {
        ...current.categories,
        ...(updates.categories || {}),
      },
      updatedAt: nowIso(),
    };
    const db = requireAdminDb();
    try {
      await db.collection('pushPreferences').doc(userId).set(merged);
      await db.collection('users').doc(userId).collection('preferences').doc('push').set(merged);
      return merged;
    } catch (err) {
      wrapFirestoreError(err, 'pushPrefRepo.updatePreferences');
    }
  },
};

// ============================================================
// AUDIT EVENTS & REMINDER OCCURRENCES
// ============================================================
export const auditRepo = {
  findByEntityInWorkspace: async (
    entityId: string,
    workspaceId: string
  ): Promise<AuditEvent[]> => {
    const list = await queryEquals<AuditEvent>('auditEvents', [
      ['workspaceId', workspaceId],
      ['entityId', entityId],
    ]);
    return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  create: async (data: Omit<AuditEvent, 'id'>): Promise<AuditEvent> => {
    const id = newId();
    const ev: AuditEvent = { ...data, id };
    return setDocData('auditEvents', id, ev);
  },
};

export const reminderRepo = {
  create: async (data: Omit<ReminderOccurrence, 'id'>): Promise<ReminderOccurrence> => {
    const id = newId();
    const occ: ReminderOccurrence = { ...data, id };
    return setDocData('reminderOccurrences', id, occ);
  },
};

// ============================================================
// MEETINGS & GOOGLE OAUTH (WORKSPACE-SCOPED)
// ============================================================
export const meetingRepo = {
  findById: (id: string) => getDocById<Meeting>('meetings', id),
  findByIdInWorkspace: async (id: string, workspaceId: string): Promise<Meeting | null> => {
    const m = await getDocById<Meeting>('meetings', id);
    if (!m || m.workspaceId !== workspaceId) return null;
    return m;
  },
  findByStatusRequestInWorkspace: async (
    statusRequestId: string,
    workspaceId: string
  ): Promise<Meeting | null> => {
    const list = await queryEquals<Meeting>('meetings', [
      ['workspaceId', workspaceId],
      ['statusRequestId', statusRequestId],
    ]);
    return list[0] || null;
  },
  create: async (
    data: Omit<Meeting, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
  ): Promise<Meeting> => {
    const id = data.id || newId();
    const now = nowIso();
    const meeting: Meeting = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
    };
    return setDocData('meetings', id, meeting);
  },
  update: (id: string, updates: Partial<Meeting>) =>
    updateDocData<Meeting>('meetings', id, { ...updates, updatedAt: nowIso() }),
};

export const googleAuthRepo = {
  getTokensByWorkspace: (workspaceId: string) =>
    getDocById<GoogleAuthTokens>('googleAuthTokens', workspaceId),
  saveTokensForWorkspace: (tokens: GoogleAuthTokens) =>
    setDocData('googleAuthTokens', tokens.workspaceId, tokens),
  clearTokensForWorkspace: (workspaceId: string) =>
    deleteDocData('googleAuthTokens', workspaceId),
};

export const oauthStateRepo = {
  get: (id: string) => getDocById<OAuthState>('oauthStates', id),
  create: (state: OAuthState) => setDocData('oauthStates', state.id, state),
  delete: (id: string) => deleteDocData('oauthStates', id),
};

// ============================================================
// SUBSCRIPTIONS, USAGE, PERIODS, PAYMENTS & MEET OPERATIONS
// ============================================================
export const subscriptionRepo = {
  findById: (id: string) => getDocById<Subscription>('subscriptions', id),
  findByWorkspace: async (workspaceId: string): Promise<Subscription | null> => {
    const byId = await getDocById<Subscription>('subscriptions', workspaceId);
    if (byId) return byId;
    const list = await queryEquals<Subscription>('subscriptions', [['workspaceId', workspaceId]]);
    return list[0] || null;
  },
  set: (sub: Subscription) => setDocData('subscriptions', sub.id, sub),
  update: (id: string, updates: Partial<Subscription>) =>
    updateDocData<Subscription>('subscriptions', id, { ...updates, updatedAt: nowIso() }),
};

export const subscriptionPeriodRepo = {
  findById: (id: string) => getDocById<SubscriptionPeriod>('subscriptionPeriods', id),
  findByWorkspace: async (workspaceId: string): Promise<SubscriptionPeriod[]> => {
    const list = await queryEquals<SubscriptionPeriod>('subscriptionPeriods', [
      ['workspaceId', workspaceId],
    ]);
    return list.sort((a, b) => a.periodNumber - b.periodNumber);
  },
  set: (period: SubscriptionPeriod) =>
    setDocData('subscriptionPeriods', period.id, period),
};

export const subscriptionUsageRepo = {
  findByPeriodId: (periodId: string) =>
    getDocById<SubscriptionUsage>('subscriptionUsage', periodId),
  set: (usage: SubscriptionUsage) => setDocData('subscriptionUsage', usage.id, usage),
  incrementStatusQueries: async (periodId: string): Promise<void> => {
    const db = requireAdminDb();
    try {
      await db
        .collection('subscriptionUsage')
        .doc(periodId)
        .set(
          {
            statusQueriesUsed: FieldValue.increment(1),
            updatedAt: nowIso(),
          },
          { merge: true }
        );
    } catch (err) {
      wrapFirestoreError(err, 'subscriptionUsageRepo.incrementStatusQueries');
    }
  },
};

export const subscriptionEventRepo = {
  findByWorkspace: async (workspaceId: string): Promise<SubscriptionEvent[]> => {
    const list = await queryEquals<SubscriptionEvent>('subscriptionEvents', [
      ['workspaceId', workspaceId],
    ]);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  create: async (data: Omit<SubscriptionEvent, 'id' | 'createdAt'>): Promise<SubscriptionEvent> => {
    const id = newId();
    const ev: SubscriptionEvent = {
      ...data,
      id,
      createdAt: nowIso(),
    };
    return setDocData('subscriptionEvents', id, ev);
  },
};

export const paymentRepo = {
  findById: (id: string) => getDocById<Payment>('payments', id),
  findByGatewayOrderId: async (gatewayOrderId: string): Promise<Payment | null> => {
    const list = await queryEquals<Payment>('payments', [
      ['gatewayOrderId', gatewayOrderId],
    ]);
    return list[0] || null;
  },
  findByWorkspace: async (workspaceId: string): Promise<Payment[]> => {
    const list = await queryEquals<Payment>('payments', [['workspaceId', workspaceId]]);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  set: (payment: Payment) => setDocData('payments', payment.id, payment),
  update: (id: string, updates: Partial<Payment>) =>
    updateDocData<Payment>('payments', id, { ...updates, updatedAt: nowIso() }),
};

export const paymentEventRepo = {
  findByGatewayEventId: (gatewayEventId: string) =>
    getDocById<PaymentEvent>('paymentEvents', gatewayEventId),
  set: (ev: PaymentEvent) => setDocData('paymentEvents', ev.gatewayEventId, ev),
};

export const meetOperationRepo = {
  findById: (id: string) => getDocById<MeetGenerationOperation>('meetGenerationOperations', id),
  findByWorkspace: async (workspaceId: string): Promise<MeetGenerationOperation[]> => {
    const list = await queryEquals<MeetGenerationOperation>('meetGenerationOperations', [
      ['workspaceId', workspaceId],
    ]);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
};

export const activeSessionRepo = {
  findByUid: (uid: string) => getDocById<ActiveSession>('activeSessions', uid),
};

export const systemConfigRepo = {
  getBootstrapMarker: () =>
    getDocById<{ id: string; initialized: boolean; defaultWorkspaceId: string; initializedAt: string }>(
      'systemConfig',
      'bootstrap'
    ),
};
