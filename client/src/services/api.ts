// ============================================================
// API CLIENT — Axios instance
// ============================================================

import axios from 'axios';
import type { ApiResponse } from '../types';
import { auth } from '../firebase';
import { getCachedMeetAccessToken } from './googleMeet';

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

function getDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Web Browser';
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'Microsoft Edge';
  if (ua.includes('Chrome/')) return 'Google Chrome';
  if (ua.includes('Firefox/')) return 'Mozilla Firefox';
  if (ua.includes('Safari/') && !ua.includes('Chrome/')) return 'Apple Safari';
  return 'Web Browser';
}

function setHeader(config: any, name: string, value: string) {
  if (typeof config.headers?.set === 'function') {
    config.headers.set(name, value);
  } else {
    config.headers[name] = value;
  }
}

// Request interceptor: ALWAYS attach the authoritative TaskFlow session token & session headers
api.interceptors.request.use(async (config) => {
  const sessionId = localStorage.getItem('auth_session_id');
  if (sessionId) {
    setHeader(config, 'x-session-id', sessionId);
  }
  setHeader(config, 'x-device-label', getDeviceLabel());

  const meetAccessToken = getCachedMeetAccessToken();
  if (meetAccessToken) {
    setHeader(config, 'x-google-meet-token', meetAccessToken);
  }

  const token = localStorage.getItem('auth_token');
  if (token) {
    setHeader(config, 'Authorization', `Bearer ${token}`);
    return config;
  }

  // Fallback to Firebase ID token only if no primary TaskFlow session token exists
  if (auth.currentUser) {
    try {
      const firebaseToken = await auth.currentUser.getIdToken();
      if (firebaseToken) {
        setHeader(config, 'Authorization', `Bearer ${firebaseToken}`);
      }
    } catch {
      // Continue without token
    }
  }
  return config;
});

// Response interceptor: safely handle 401 expiration without misclassifying 402/409 or auth/bootstrap calls
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      const requestUrl = error.config?.url || '';
      const isPublicOrInitialEndpoint =
        requestUrl.includes('/auth/login') ||
        requestUrl.includes('/auth/me') ||
        requestUrl.includes('/bootstrap');

      if (!isPublicOrInitialEndpoint) {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_session_id');
        localStorage.removeItem('auth_user');
        localStorage.removeItem('auth_workspace');
        localStorage.removeItem('auth_entitlement');
        if (!window.location.pathname.includes('/login')) {
          window.location.href = '/login';
        }
      }
    }
    return Promise.reject(error);
  }
);

export default api;

// ============================================================
// API SERVICE FUNCTIONS
// ============================================================

// Workspace First-Time Bootstrap
export const bootstrapApi = {
  getStatus: () => api.get<ApiResponse>('/bootstrap/status'),
  initializeWorkspace: (data: {
    workspaceName: string;
    adminFullName: string;
    adminEmail: string;
    adminPassword?: string;
    firebaseIdToken?: string;
    department?: string;
    designation?: string;
    timezone?: string;
    setupSecret?: string;
  }) => api.post<ApiResponse>('/bootstrap', data),
};

// Auth
export const authApi = {
  login: (email: string, password: string, sessionId?: string, forceTakeover?: boolean) =>
    api.post<ApiResponse>('/auth/login', { email, password, sessionId, forceTakeover }),
  loginWithFirebase: (firebaseIdToken: string, sessionId?: string, forceTakeover?: boolean) =>
    api.post<ApiResponse>('/auth/login', { firebaseIdToken, sessionId, forceTakeover }),
  logout: (deviceId?: string) => api.post<ApiResponse>('/auth/logout', { deviceId }),
  me: () => api.get<ApiResponse>('/auth/me'),
  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    api.post<ApiResponse>('/auth/change-password', data),
};

// Subscriptions & Entitlements
export const subscriptionApi = {
  getCurrent: () => api.get<ApiResponse>('/subscriptions/current'),
  getHistory: () => api.get<ApiResponse>('/subscriptions/history'),
};

// Razorpay Payments
export const paymentApi = {
  getConfig: () => api.get<ApiResponse>('/payments/config'),
  list: () => api.get<ApiResponse>('/payments'),
  createRazorpayOrder: (data?: { idempotencyKey?: string }) =>
    api.post<ApiResponse>('/payments/razorpay/order', data || {}),
  verifyRazorpayPayment: (data: {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }) => api.post<ApiResponse>('/payments/razorpay/verify', data),
};

// Employees
export const employeeApi = {
  getAll: (params?: Record<string, string>) =>
    api.get<ApiResponse>('/employees', { params }),
  getById: (id: string) => api.get<ApiResponse>(`/employees/${id}`),
  create: (data: unknown) => api.post<ApiResponse>('/employees', data),
  update: (id: string, data: unknown) => api.patch<ApiResponse>(`/employees/${id}`, data),
  updateStatus: (id: string, active: boolean) =>
    api.patch<ApiResponse>(`/employees/${id}/status`, { active }),
  exportCsv: async () => {
    const response = await api.get('/employees/export-csv', { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'taskflow_employees_directory.csv');
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  },
};

// Tasks
export const taskApi = {
  getAll: (params?: Record<string, string>) =>
    api.get<ApiResponse>('/tasks', { params }),
  getById: (id: string) => api.get<ApiResponse>(`/tasks/${id}`),
  create: (data: unknown) => api.post<ApiResponse>('/tasks', data),
  update: (id: string, data: unknown) => api.patch<ApiResponse>(`/tasks/${id}`, data),
  cancel: (id: string) => api.post<ApiResponse>(`/tasks/${id}/cancel`),
  getHistory: (id: string) => api.get<ApiResponse>(`/tasks/${id}/history`),
  getMembers: (id: string) => api.get<ApiResponse>(`/tasks/${id}/members`),
  updateMemberStatus: (taskId: string, memberId: string, status: string, explanation?: string) =>
    api.patch<ApiResponse>(`/tasks/${taskId}/members/${memberId}/status`, { status, explanation }),
  submitTask: (taskId: string, memberId: string, submissionNote?: string) =>
    api.post<ApiResponse>(`/tasks/${taskId}/members/${memberId}/submit`, { submissionNote }),
  approveMember: (taskId: string, memberId: string) =>
    api.post<ApiResponse>(`/tasks/${taskId}/members/${memberId}/approve`),
  requestRevision: (taskId: string, memberId: string, reason: string) =>
    api.post<ApiResponse>(`/tasks/${taskId}/members/${memberId}/request-revision`, { reason }),
};

// Status Requests (Premium)
export const statusRequestApi = {
  getAll: () => api.get<ApiResponse>('/status-requests'),
  getPresets: () => api.get<ApiResponse>('/status-requests/presets'),
  send: (taskId: string, data: unknown) =>
    api.post<ApiResponse>(`/tasks/${taskId}/status-requests`, data),
  respond: (requestId: string, responseText: string) =>
    api.post<ApiResponse>(`/status-requests/${requestId}/respond`, { responseText }),
};

// Queries
export const queryApi = {
  getAll: (params?: Record<string, string>) =>
    api.get<ApiResponse>('/queries', { params }),
  getById: (id: string) => api.get<ApiResponse>(`/queries/${id}`),
  getByTask: (taskId: string) => api.get<ApiResponse>(`/tasks/${taskId}/queries`),
  create: (taskId: string, data: unknown) =>
    api.post<ApiResponse>(`/tasks/${taskId}/queries`, data),
  addMessage: (queryId: string, message: string) =>
    api.post<ApiResponse>(`/queries/${queryId}/messages`, { message }),
  updateStatus: (queryId: string, status: string) =>
    api.patch<ApiResponse>(`/queries/${queryId}/status`, { status }),
};

// Chat
export const chatApi = {
  getMessages: (taskId: string) => api.get<ApiResponse>(`/tasks/${taskId}/messages`),
  sendMessage: (taskId: string, message: string) =>
    api.post<ApiResponse>(`/tasks/${taskId}/messages`, { message }),
};

// Notifications
export const notificationApi = {
  getAll: () => api.get<ApiResponse>('/notifications'),
  markRead: (id: string) => api.patch<ApiResponse>(`/notifications/${id}/read`),
  markAllRead: () => api.post<ApiResponse>('/notifications/read-all'),
};

// Dashboard
export const dashboardApi = {
  admin: () => api.get<ApiResponse>('/dashboard/admin'),
  employee: () => api.get<ApiResponse>('/dashboard/employee'),
};

// Reports
export const reportApi = {
  getReport: (params?: Record<string, string>) =>
    api.get<ApiResponse>('/reports', { params }),
};

// Reminders & IST Automated Scheduler
export const reminderApi = {
  preview: () => api.get<ApiResponse>('/reminders/preview'),
  evaluate: () => api.post<ApiResponse>('/reminders/evaluate'),
  getISTStatus: () => api.get<ApiResponse>('/reminders/ist-status'),
  triggerIST: (data?: { slot?: string; forceAll?: boolean; taskId?: string }) =>
    api.post<ApiResponse>('/reminders/trigger-ist', data),
};

// Push Notifications (FCM)
export const pushApi = {
  getConfig: () => api.get<ApiResponse>('/push/config'),
  register: (data: {
    deviceId: string;
    fcmToken: string;
    browserName?: string;
    userAgent?: string;
    permissionStatus?: string;
  }) => api.post<ApiResponse>('/push/register', data),
  getDevices: () => api.get<ApiResponse>('/push/devices'),
  updateDevice: (deviceId: string, data: Record<string, unknown>) =>
    api.patch<ApiResponse>(`/push/devices/${deviceId}`, data),
  unregisterDevice: (deviceId: string) =>
    api.delete<ApiResponse>(`/push/devices/${deviceId}`),
  getPreferences: () => api.get<ApiResponse>('/push/preferences'),
  updatePreferences: (data: Record<string, unknown>) =>
    api.patch<ApiResponse>('/push/preferences', data),
  sendTestPush: () => api.post<ApiResponse>('/push/test'),
};

// Google Meet & Workspace-Scoped Centralized OAuth API
export const meetingApi = {
  getGoogleStatus: () => api.get<ApiResponse>('/admin/google/status'),
  getAuthUrl: () => api.get<ApiResponse>('/admin/google/auth-url'),
  disconnectGoogle: () => api.post<ApiResponse>('/admin/google/disconnect'),
  createMeeting: (
    requestId: string,
    data?: { idempotencyKey?: string; description?: string }
  ) => api.post<ApiResponse>(`/admin/status-requests/${requestId}/meetings`, data || {}),
  scheduleMeeting: (
    requestId: string,
    data: { date: string; time: string; description?: string }
  ) => api.post<ApiResponse>(`/admin/status-requests/${requestId}/meetings/schedule`, data),
  rescheduleMeeting: (
    requestId: string,
    data: { date?: string; time?: string; description?: string }
  ) => api.patch<ApiResponse>(`/admin/status-requests/${requestId}/meetings`, data),
  cancelMeeting: (requestId: string) =>
    api.post<ApiResponse>(`/admin/status-requests/${requestId}/meetings/cancel`),
  getMeetingByRequest: (requestId: string) =>
    api.get<ApiResponse>(`/status-requests/${requestId}/meeting`),
};
