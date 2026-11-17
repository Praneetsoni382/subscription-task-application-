# Cloud Firestore Schema

- **Firebase Project ID**: `gen-lang-client-0707937978`
- **Firestore Database ID**: `ai-studio-subscriptiontask-992983c8-db4b-4b78-98e3-4f6d1adf9bac`
- **Region**: `asia-south1`
- **Canonical Blueprint**: `/firebase-blueprint.json`
- **Composite Indexes**: `/firestore.indexes.json`

## Collections Summary

| Collection | Document ID | Scope / Owner | Notes |
|---|---|---|---|
| `systemConfig` | `bootstrap` | Server-only | Stores `{ initialized, defaultWorkspaceId, ownerUid, initializedAt }`. Prevents duplicate initial bootstrap. |
| `workspaces` | `{workspaceId}` | Workspace | Root tenant entity `{ id, name, ownerUid, status, subscriptionId, timezone, onboardingStatus }`. |
| `users` | `{uid}` | Workspace | User profile & `passwordHash` (`bcrypt`). Zero plaintext password fields (`initialPassword`, `currentPasswordPlain` removed). |
| `activeSessions` | `{uid}` | User / Server | Single-device active session `{ uid, workspaceId, sessionId, deviceLabel, status, lastActivityAt, expiresAt }`. |
| `subscriptions` | `{workspaceId}` | Workspace / Server | Current plan state `{ plan: 'FREE' \| 'PREMIUM', status: 'ACTIVE' \| 'EXPIRED' \| ... , currentPeriodId, currentPeriodStart, currentPeriodEnd }`. |
| `subscriptionPeriods` | `{periodId}` | Workspace / Server | Immutable/rolled 30-day (`2,592,000s`) intervals with `periodNumber`, `startAt`, `endAt`, `meetCreditLimit: 5`, `meetCreditsUsed`, `meetCreditsReserved`, `status`. |
| `subscriptionUsage` | `{periodId}` | Workspace / Server | Real-time counters for `statusQueriesUsed`, `meetCreditsUsed`, `meetCreditsReserved`, `meetCreditLimit`. |
| `subscriptionEvents` | `{eventId}` | Workspace / Server | Lifecycle audit events (`WORKSPACE_FREE_INITIALIZED`, `PREMIUM_PERIOD_ACTIVATED`, `PREMIUM_EARLY_RENEWAL_SCHEDULED`, `SCHEDULED_PERIOD_ROLLED_OVER`, `PERIOD_EXPIRED`). |
| `payments` | `{paymentId}` | Workspace / Server | Server-priced Razorpay orders `{ gatewayOrderId, gatewayPaymentId, amount, currency, status, idempotencyKey, periodId }`. |
| `paymentEvents` | `{gatewayEventId}` | Server-only | Idempotent log of verified/rejected Checkout and Webhook events preventing double activation. |
| `meetGenerationOperations` | `{operationId}` | Workspace / Server | Transactional reservation/commit/rollback ledger (`RESERVED`, `COMMITTED`, `ROLLED_BACK`) guarding the 5 Meet credits/period limit. |
| `googleAuthTokens` | `{workspaceId}` | Server-only | AES-256-GCM encrypted `access_token` and `refresh_token` for the Workspace's authorized Google account. |
| `oauthStates` | `{stateId}` | Server-only | Single-use 15-minute CSRF state records binding OAuth callback to `{ workspaceId, adminUid, redirectUri }`. |
| `tasks` | `{taskId}` | Workspace | Task assignments (`solo`/`group`, priority, status, deadline, `reminderEnabled`, `reminderTimes`). Also maintains `/tasks/{taskId}/members` and `/tasks/{taskId}/messages`. |
| `taskMembers` | `{memberId}` | Workspace | Per-assignee status lifecycle (`pending`, `in_progress`, `blocked`, `submitted_for_review`, `revision_requested`, `approved`). |
| `statusRequests` | `{requestId}` | Workspace (Premium) | Manager inquiries dispatched to assigned task members; optionally linked via `meetingId`. |
| `statusResponses` | `{responseId}` | Workspace (Premium) | Employee responses to Status Requests. |
| `meetings` | `{meetingId}` | Workspace (Premium) | Google Meet REST API v2 spaces (`meetingUri`, `googleSpaceName`, `meetingCode`, `scheduledAt`, `status`). |
| `queries` | `{queryId}` | Workspace | Employee task clarification/blocker queries (`open`, `answered`, `resolved`, `reopened`). |
| `queryMessages` | `{messageId}` | Workspace | Discussion thread messages inside a Query (also synced to `/queries/{queryId}/messages`). |
| `chatMessages` | `{messageId}` | Workspace | Task team collaboration chat messages. |
| `notifications` | `{notificationId}` | Workspace / User | In-app notifications + FCM push delivery state. |
| `devices` & `/users/{uid}/devices` | `{deviceId}` | User | Registered Web Push FCM tokens. |
| `pushPreferences` & `/users/{uid}/preferences/push` | `{uid}` | User | Notification category opt-in flags. |
| `reminderOccurrences` | `{occurrenceId}` | Workspace / Server | Deduplicated IST daily slot reminder logs (`10:00`, `14:00`, `18:00`, `21:00`). |
| `auditEvents` | `{eventId}` | Workspace / Server | Domain & administrative audit trail. |
