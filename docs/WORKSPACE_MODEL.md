# Workspace Multi-Tenant Model

## Overview

Every organization running on TaskFlow operates inside an isolated `Workspace` (`workspaces/{workspaceId}`). All users, tasks, task members, queries, notifications, chat threads, status requests, meetings, payments, subscriptions, and OAuth tokens are strictly bound to a single `workspaceId`.

## Canonical Role Mapping

To maintain seamless routing compatibility across existing frontend portals while enforcing strict multi-tenant RBAC:

- **`admin`** (Workspace Administrator): Owns or administers the Workspace, manages employee accounts, assigns/approves tasks, connects Workspace Google OAuth, manages Razorpay subscriptions, triggers IST reminders, and dispatches Premium Status Requests & Google Meet spaces.
- **`employee`** (Employee): Assigned to tasks within the Workspace, transitions individual execution states, participates in task team chat and queries, and responds to Premium Status Requests / joins published meetings when the Workspace subscription is active.

## First-Time Bootstrap Lifecycle

1. Unauthenticated clients call `GET /api/bootstrap/status` to determine whether `systemConfig/bootstrap` has been initialized and whether backend Firestore Admin SDK connectivity is healthy.
2. When `firestoreConnected: true` and `initialized: false`, `LoginPage` displays the **Initialize Your Workspace** onboarding form.
3. Submitting `POST /api/bootstrap` (optionally gated by `BOOTSTRAP_SETUP_SECRET`) executes an atomic Firestore transaction (`bootstrapInitialWorkspace`) that:
   - Verifies `systemConfig/bootstrap` is not already initialized (returns `409 ALREADY_BOOTSTRAPPED` otherwise).
   - Creates `workspaces/{workspaceId}`.
   - Creates the first `admin` user in `users/{uid}` (and Firebase Auth when applicable).
   - Initializes a `FREE` subscription (`subscriptions/{workspaceId}`, initial `subscriptionPeriods/{periodId}`, `subscriptionUsage/{periodId}`).
   - Sets `systemConfig/bootstrap` `{ initialized: true }`.
   - Opens an initial single-device session (`activeSessions/{uid}`) and returns an HMAC-signed token.

## Data Isolation Guarantees

- Backend middleware populates `req.authUser` from the verified token/user record in Firestore and verifies `active === true` and `accountStatus === 'active'`.
- All repository lookups use `findByIdInWorkspace(id, req.authUser.workspaceId)` or filter queries by `['workspaceId', workspaceId]`.
- `firestore.rules` validates `sameWorkspace(workspaceId)` for direct client reads and blocks direct client writes to protected tenant collections.
