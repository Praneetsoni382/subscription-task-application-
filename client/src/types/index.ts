// ============================================================
// SHARED TYPES — Frontend
// ============================================================

export type UserRole = 'admin' | 'employee';
export type AccountStatus = 'active' | 'deactivated';
export type TaskAssignmentType = 'solo' | 'group';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'submitted_for_review'
  | 'revision_requested'
  | 'approved'
  | 'cancelled';

export type MemberStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'submitted_for_review'
  | 'revision_requested'
  | 'approved';

export type QueryCategory =
  | 'clarification'
  | 'blocker'
  | 'dependency'
  | 'deadline_concern'
  | 'assignment_issue'
  | 'technical_issue'
  | 'other';

export type QueryStatus = 'open' | 'answered' | 'resolved' | 'reopened';
export type StatusRequestStatus = 'pending' | 'answered';

export type NotificationEventType =
  | 'TASK_ASSIGNED'
  | 'TASK_UPDATED'
  | 'DEADLINE_CHANGED'
  | 'TASK_REASSIGNED'
  | 'TASK_CANCELLED'
  | 'STATUS_REQUESTED'
  | 'STATUS_RESPONSE_RECEIVED'
  | 'QUERY_CREATED'
  | 'QUERY_ANSWERED'
  | 'QUERY_RESOLVED'
  | 'BLOCKER_REPORTED'
  | 'BLOCKER_RESOLVED'
  | 'TASK_SUBMITTED'
  | 'TASK_APPROVED'
  | 'REVISION_REQUESTED'
  | 'REMINDER_DUE'
  | 'TASK_OVERDUE'
  | 'GROUP_MEMBER_SUBMITTED'
  | 'GROUP_READY_FOR_REVIEW'
  | 'CHAT_MESSAGE_RECEIVED';

export type SubscriptionPlan = 'FREE' | 'PREMIUM';
export type SubscriptionStatus = 'ACTIVE' | 'EXPIRED' | 'CANCELLED' | 'PENDING_PAYMENT';
export type PeriodStatus = 'ACTIVE' | 'SCHEDULED' | 'EXPIRED' | 'CANCELLED';
export type PaymentStatus = 'PENDING' | 'VERIFIED' | 'FAILED' | 'REFUNDED';

export interface Workspace {
  id: string;
  name: string;
  ownerUid: string;
  status: 'active' | 'suspended';
  subscriptionId: string;
  timezone: string;
  onboardingStatus: 'pending' | 'completed';
  createdAt: string;
  updatedAt: string;
}

export interface EntitlementSummary {
  workspaceId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  isPremiumActive: boolean;
  currentPeriodId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  meetCreditLimit: number;
  meetCreditsUsed: number;
  meetCreditsReserved: number;
  meetCreditsRemaining: number;
  statusQueriesUsed: number;
  capabilities: {
    canCreateStatusRequest: boolean;
    canRespondToStatusRequest: boolean;
    canUseStatusQueries: boolean;
    canGenerateMeet: boolean;
    canJoinPremiumMeeting: boolean;
    canManageSubscription: boolean;
  };
  serverTimeUtc: string;
}

export interface BootstrapStatus {
  initialized: boolean;
  requiresSetupSecret: boolean;
  isAdminSdkConfigured: boolean;
  firestoreConnected: boolean;
  projectId: string;
  databaseId: string;
  error?: string;
}

export interface SubscriptionPeriod {
  id: string;
  workspaceId: string;
  subscriptionId: string;
  periodNumber: number;
  plan: SubscriptionPlan;
  startAt: string;
  endAt: string | null;
  durationSeconds: number;
  paymentId: string | null;
  meetCreditLimit: number;
  meetCreditsUsed: number;
  meetCreditsReserved: number;
  status: PeriodStatus;
  createdAt: string;
}

export interface SubscriptionEvent {
  id: string;
  workspaceId: string;
  subscriptionId: string;
  periodId: string | null;
  eventType: string;
  previousStatus: string | null;
  newStatus: string | null;
  paymentId: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface PaymentRecord {
  id: string;
  workspaceId: string;
  subscriptionId: string;
  periodId: string | null;
  gateway: 'RAZORPAY';
  gatewayOrderId: string;
  gatewayPaymentId: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  idempotencyKey: string;
  initiatedByUid: string;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RazorpayConfigStatus {
  gateway: 'RAZORPAY';
  isGatewayConfigured: boolean;
  isWebhookConfigured: boolean;
  isPricingConfigured: boolean;
  keyId: string | null;
  amount: number | null;
  currency: string;
}

export interface User {
  id: string;
  uid?: string;
  workspaceId: string;
  employeeId: string;
  fullName: string;
  email: string;
  department: string;
  designation: string;
  role: UserRole;
  active: boolean;
  accountStatus?: AccountStatus;
  lastLoginAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  workspaceId: string;
  referenceNumber: string;
  title: string;
  description: string;
  assignmentType: TaskAssignmentType;
  priority: TaskPriority;
  status: TaskStatus;
  category: string;
  department: string;
  deadline: string;
  startDate: string | null;
  timezone: string;
  reminderEnabled: boolean;
  reminderTimes: string[];
  managerNote: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
}

export interface TaskMember {
  id: string;
  workspaceId: string;
  taskId: string;
  userId: string;
  memberStatus: MemberStatus;
  submissionNote: string;
  submittedAt: string | null;
  approvedAt: string | null;
  revisionRequestedAt: string | null;
  revisionReason: string;
  lastStatusUpdateAt: string;
  reminderEligible: boolean;
  user: User;
}

export interface TaskWithMembers extends Task {
  members: TaskMember[];
}

export interface StatusRequest {
  id: string;
  workspaceId: string;
  taskId: string;
  createdBy: string;
  recipientUserId: string;
  question: string;
  status: StatusRequestStatus;
  meetingId?: string | null;
  createdAt: string;
  responseDeadline: string | null;
  task?: { id: string; title: string; referenceNumber: string } | null;
  responses?: StatusResponse[];
  creatorName?: string;
  recipientName?: string;
  meeting?: Meeting | null;
}

export type MeetingStatus = 'draft' | 'scheduled' | 'cancelled';

export interface Meeting {
  id: string;
  workspaceId: string;
  statusRequestId: string;
  taskId: string;
  createdByAdminUid: string;
  googleSpaceName?: string;
  meetingUri: string;
  meetingCode?: string;
  meetingTitle: string;
  description?: string;
  status: MeetingStatus;
  subscriptionPeriodId?: string | null;
  operationId?: string | null;
  createdAt: string;
  scheduledAt?: string | null;
  timezone: string;
  publishedAt?: string | null;
  updatedAt: string;
  cancelledAt?: string | null;
}

export interface StatusResponse {
  id: string;
  workspaceId: string;
  statusRequestId: string;
  responderUserId: string;
  responseText: string;
  createdAt: string;
}

export interface Query {
  id: string;
  workspaceId: string;
  taskId: string;
  createdBy: string;
  title: string;
  description: string;
  category: QueryCategory;
  priority: 'low' | 'medium' | 'high';
  status: QueryStatus;
  createdAt: string;
  updatedAt: string;
  task?: { id: string; title: string; referenceNumber: string } | null;
  creatorName?: string;
  messages?: QueryMessage[];
}

export interface QueryMessage {
  id: string;
  workspaceId: string;
  queryId: string;
  senderUserId: string;
  message: string;
  createdAt: string;
  senderName?: string;
  senderRole?: string;
}

export interface ChatMessage {
  id: string;
  workspaceId: string;
  taskId: string;
  senderUserId: string;
  message: string;
  createdAt: string;
  senderName?: string;
  senderRole?: string;
}

export interface Notification {
  id: string;
  workspaceId: string;
  recipientUserId: string;
  eventType: NotificationEventType;
  title: string;
  body: string;
  relatedTaskId: string | null;
  relatedQueryId: string | null;
  relatedStatusRequestId: string | null;
  readAt: string | null;
  createdAt: string;
  deliveryState: 'pending' | 'delivered' | 'read';
  navigationUrl: string | null;
  pushStatus?: 'pending' | 'sent' | 'failed' | 'no_active_devices' | 'skipped';
  pushSentAt?: string | null;
  pushErrorCode?: string | null;
}

export interface Device {
  deviceId: string;
  userId: string;
  workspaceId?: string;
  fcmToken: string;
  platform: 'WEB';
  browserName: string;
  userAgent: string;
  permissionStatus: 'default' | 'granted' | 'denied';
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  lastSuccessfulSendAt: string | null;
  lastErrorAt: string | null;
  tokenVersion: string;
}

export interface PushPreferences {
  userId: string;
  enabled: boolean;
  categories: {
    taskAssignments: boolean;
    statusRequests: boolean;
    queries: boolean;
    reminders: boolean;
    messages: boolean;
    approvals: boolean;
  };
  updatedAt: string;
}

export interface PushConfig {
  projectId: string;
  messagingSenderId: string;
  vapidKey: string;
  isConfigured: boolean;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  actorUserId: string;
  actorName?: string;
  entityType: string;
  entityId: string;
  eventType: string;
  previousState: string | null;
  newState: string | null;
  message: string;
  createdAt: string;
}

export interface AdminDashboardData {
  totalTasks: number;
  completedTasks: number;
  pendingTasks: number;
  submittedForReview: number;
  activeQueries: number;
  recentTasks: TaskWithMembers[];
  approachingDeadlines: TaskWithMembers[];
  overdueTasks: TaskWithMembers[];
  openQueries: Array<Query & { taskTitle?: string; creatorName?: string }>;
  recentSubmissions: Array<TaskMember & { task: Task }>;
}

export interface EmployeeDashboardData {
  totalAssigned: number;
  inProgress: number;
  submitted: number;
  approved: number;
  myTasks: TaskWithMembers[];
  pendingStatusRequests: Array<StatusRequest & { task?: Task }>;
  openQueries: Query[];
  recentNotifications: Notification[];
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  message?: string;
}
