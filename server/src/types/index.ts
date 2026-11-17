// ============================================================
// SHARED TYPES — TaskFlow Multi-Tenant & Subscription Platform
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

export type QueryPriority = 'low' | 'medium' | 'high';
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
  | 'CHAT_MESSAGE_RECEIVED'
  | 'SUBSCRIPTION_UPDATED';

export type AuditEventType =
  | 'WORKSPACE_CREATED'
  | 'TASK_CREATED'
  | 'TASK_ASSIGNED'
  | 'TASK_UPDATED'
  | 'TASK_CANCELLED'
  | 'STATUS_CHANGED'
  | 'MEMBER_SUBMITTED'
  | 'MEMBER_APPROVED'
  | 'REVISION_REQUESTED'
  | 'STATUS_REQUEST_SENT'
  | 'STATUS_RESPONSE_GIVEN'
  | 'QUERY_CREATED'
  | 'QUERY_ANSWERED'
  | 'QUERY_RESOLVED'
  | 'QUERY_REOPENED'
  | 'BLOCKER_REPORTED'
  | 'BLOCKER_RESOLVED'
  | 'DEADLINE_CHANGED'
  | 'EMPLOYEE_CREATED'
  | 'EMPLOYEE_UPDATED'
  | 'EMPLOYEE_STATUS_CHANGED'
  | 'CHAT_MESSAGE_SENT'
  | 'MEET_CREDIT_RESERVED'
  | 'MEET_CREATED'
  | 'MEET_GENERATION_FAILED'
  | 'GOOGLE_OAUTH_CONNECTED'
  | 'GOOGLE_OAUTH_DISCONNECTED'
  | 'SUBSCRIPTION_ACTIVATED'
  | 'PAYMENT_VERIFIED'
  | 'SESSION_CREATED'
  | 'SESSION_RELEASED';

// ============================================================
// WORKSPACE & USER ENTITIES
// ============================================================

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

export interface User {
  id: string;
  uid: string;
  workspaceId: string;
  employeeId: string;
  fullName: string;
  email: string;
  department: string;
  designation: string;
  role: UserRole;
  active: boolean;
  accountStatus: AccountStatus;
  passwordHash: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SafeUser = Omit<User, 'passwordHash'>;

// ============================================================
// CORE OPERATIONAL ENTITIES (WORKSPACE-SCOPED)
// ============================================================

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
  assignedEmployeeIds?: string[];
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  meetingId?: string | null;
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
  assignedAt?: string;
  updatedAt?: string;
}

export interface StatusRequest {
  id: string;
  workspaceId: string;
  taskId: string;
  createdBy: string;
  recipientUserId: string;
  question: string;
  requestType?: string;
  status: StatusRequestStatus;
  createdAt: string;
  updatedAt: string;
  responseDeadline: string | null;
  meetingId?: string | null;
}

export interface StatusResponse {
  id: string;
  workspaceId: string;
  statusRequestId: string;
  responderUserId: string;
  responseText: string;
  createdAt: string;
  updatedAt: string;
}

export interface Query {
  id: string;
  workspaceId: string;
  taskId: string;
  createdBy: string;
  assignedTo?: string | null;
  title: string;
  description: string;
  category: QueryCategory;
  priority: QueryPriority;
  status: QueryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface QueryMessage {
  id: string;
  workspaceId: string;
  queryId: string;
  senderUserId: string;
  message: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  workspaceId: string;
  taskId: string;
  senderUserId: string;
  message: string;
  createdAt: string;
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
  workspaceId: string;
  userId: string;
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
  workspaceId: string;
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

export interface ReminderOccurrence {
  id: string;
  workspaceId: string;
  taskId: string;
  recipientUserId: string;
  scheduledFor: string;
  timezone: string;
  reminderType: 'submission' | 'deadline' | 'overdue';
  status: 'pending' | 'delivered' | 'skipped';
  skippedReason: string | null;
  processedAt?: string | null;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  actorUserId: string;
  entityType:
    | 'workspace'
    | 'task'
    | 'user'
    | 'query'
    | 'status_request'
    | 'chat'
    | 'meeting'
    | 'subscription'
    | 'payment'
    | 'session';
  entityId: string;
  eventType: AuditEventType;
  previousState: string | null;
  newState: string | null;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type MeetingStatus = 'draft' | 'scheduled' | 'cancelled';

export interface Meeting {
  id: string;
  workspaceId: string;
  statusRequestId: string;
  taskId: string;
  createdByAdminUid: string;
  invitedEmployeeIds: string[];
  provider: 'GOOGLE_MEET';
  googleSpaceName?: string;
  meetingUri: string;
  meetingTitle: string;
  description?: string;
  status: MeetingStatus;
  createdAt: string;
  scheduledAt?: string | null;
  timezone: string;
  publishedAt?: string | null;
  updatedAt: string;
  cancelledAt?: string | null;
}

export interface GoogleAuthTokens {
  id: string; // workspaceId
  workspaceId: string;
  connectedBy: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string | null;
  tokenExpiry?: number | null;
  scopes: string[];
  email?: string;
  connectedAt: string;
  updatedAt: string;
}

export interface OAuthState {
  id: string;
  workspaceId: string;
  adminUid: string;
  redirectUri: string;
  returnTo: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

// ============================================================
// SUBSCRIPTION, BILLING & MEET CREDIT ENTITIES
// ============================================================

export type SubscriptionPlan = 'FREE' | 'PREMIUM';
export type SubscriptionStatus = 'ACTIVE' | 'EXPIRED' | 'CANCELLED' | 'PENDING';

export interface Subscription {
  id: string;
  workspaceId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  currentPeriodId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  autoRenew: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SubscriptionPeriodStatus = 'ACTIVE' | 'SCHEDULED' | 'EXPIRED' | 'CANCELLED';

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
  status: SubscriptionPeriodStatus;
  createdAt: string;
}

export interface SubscriptionUsage {
  id: string; // periodId or workspaceId_periodId
  workspaceId: string;
  subscriptionId: string;
  periodId: string;
  statusQueriesUsed: number;
  meetCreditsUsed: number;
  meetCreditsReserved: number;
  meetCreditLimit: number;
  updatedAt: string;
}

export interface SubscriptionEvent {
  id: string;
  workspaceId: string;
  subscriptionId: string;
  periodId: string | null;
  eventType: string;
  previousStatus: string | null;
  newStatus: string;
  paymentId: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type PaymentStatus = 'PENDING' | 'VERIFIED' | 'FAILED';

export interface Payment {
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

export interface PaymentEvent {
  id: string; // gatewayEventId
  workspaceId: string;
  paymentId: string;
  gateway: 'RAZORPAY';
  gatewayEventId: string;
  eventType: string;
  verificationStatus: 'VERIFIED' | 'REJECTED';
  receivedAt: string;
  processedAt: string;
  metadata?: Record<string, unknown>;
}

export type MeetGenerationStatus =
  | 'RESERVED'
  | 'SUCCESS'
  | 'FAILED'
  | 'RECONCILIATION_REQUIRED';

export interface MeetGenerationOperation {
  id: string;
  workspaceId: string;
  periodId: string;
  requestedBy: string;
  idempotencyKey: string;
  operationStatus: MeetGenerationStatus;
  meetingId: string | null;
  providerMeetingId: string | null;
  reservedAt: string;
  completedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// SINGLE-DEVICE SESSION MANAGEMENT (PART 10)
// ============================================================

export interface ActiveSession {
  id: string; // uid
  uid: string;
  workspaceId: string;
  sessionId: string;
  deviceLabel: string;
  status: 'ACTIVE' | 'EXPIRED' | 'RELEASED';
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
}

// ============================================================
// ENTITLEMENT SUMMARY (COMPUTED SERVER-SIDE)
// ============================================================

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

// ============================================================
// API RESPONSE TYPES
// ============================================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TaskWithMembers extends Task {
  members: Array<TaskMember & { user: SafeUser }>;
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
  openQueries: Query[];
  recentSubmissions: Array<TaskMember & { task: Task; user: SafeUser }>;
}

export interface EmployeeDashboardData {
  totalAssigned: number;
  inProgress: number;
  submitted: number;
  approved: number;
  myTasks: TaskWithMembers[];
  pendingStatusRequests: Array<StatusRequest & { task: Task }>;
  openQueries: Query[];
  recentNotifications: Notification[];
}
