# Implementation Status & Operational Checklist

## Completed Architecture & Code

- [x] Provisioned fresh Firebase project (`gen-lang-client-0707937978`) and Firestore database (`ai-studio-subscriptiontask-992983c8-db4b-4b78-98e3-4f6d1adf9bac`) in `asia-south1`.
- [x] Replaced in-memory data store with authoritative Cloud Firestore Admin SDK repository (`server/src/repositories/firestoreRepository.ts`) with strict `workspaceId` multi-tenant isolation.
- [x] Implemented idempotent first-time Workspace & Administrator bootstrap (`POST /api/bootstrap`, `GET /api/bootstrap/status`) and removed all hardcoded/seed credentials and plaintext password fields.
- [x] Built centralized `subscriptionEntitlementService.ts` enforcing Free vs 30-day (`2,592,000s`) Paid Premium access, early renewal period stacking, server UTC expiration rollover, and 5 Meet credits per cycle with atomic reservation/commit/rollback.
- [x] Built centralized Admin-only Google OAuth 2.0 Authorization Code flow (`AES-256-GCM` token storage, one-time Firestore CSRF states, automatic token refresh) and real Google Meet REST API v2 space creation.
- [x] Built server-authoritative Razorpay order creation, Checkout HMAC-SHA256 verification, raw-body Webhook signature verification, and idempotent `paymentEvents` processing.
- [x] Implemented single-device active session locks (`activeSessions/{uid}`) with 30-minute sliding inactivity timeout and `409 ACTIVE_SESSION_CONFLICT` protection.
- [x] Updated React client (`LoginPage` bootstrap onboarding, `SubscriptionPage` Razorpay Checkout UI, `Sidebar`, `GoogleMeetCard`, `GoogleMeetAdminConnectModal`, `StatusRequestsPage`, `TaskDetailPage`, `EmployeeDashboard`).
- [x] Hardened & deployed `/firestore.rules` (validated with `@firebase/eslint-plugin-security-rules`), `/firebase-blueprint.json`, and `/firestore.indexes.json`.

## Pending External Credentials (Operator Action Required Before Live Production Traffic)

1. Provide `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` from Firebase Console Service Accounts for server-side Admin SDK connectivity.
2. Provide `SESSION_SECRET` and `OAUTH_TOKEN_ENCRYPTION_KEY` in environment variables.
3. Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` (matching Google Cloud Console OAuth 2.0 Web Client authorized redirect URIs).
4. Configure `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, and `PREMIUM_PLAN_AMOUNT` to enable live Razorpay Checkout & Webhooks.
5. Configure `FIREBASE_VAPID_KEY` / `VITE_FIREBASE_VAPID_KEY` for browser FCM Web Push delivery.
6. Deploy Firestore composite indexes (`firebase deploy --only firestore:indexes`) when deploying to Render/production.
