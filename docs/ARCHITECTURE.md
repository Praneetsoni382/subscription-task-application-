# TaskFlow System Architecture

## Overview

TaskFlow is a multi-tenant Workspace Task Operations and Subscription SaaS platform built with:

- **Frontend**: React 19, Vite, TypeScript, Tailwind CSS v4, TanStack React Query, Axios, Firebase Web SDK (`firebase/auth`, `firebase/firestore`, `firebase/messaging`).
- **Backend**: Express 5, TypeScript (`server/src/*`), Firebase Admin SDK (`firebase-admin`), `express-session`, `bcryptjs`, `googleapis`, `node-cron`, and Razorpay REST + Webhook verification.
- **Database**: Cloud Firestore (Enterprise/Standard database `ai-studio-subscriptiontask-992983c8-db4b-4b78-98e3-4f6d1adf9bac` in Firebase project `gen-lang-client-0707937978`, region `asia-south1`).
- **Hosting**: Render Web Service (`npm run build` followed by `NODE_ENV=production node server.ts` on `PORT` / default `3000`), serving both the REST API (`/api/*`) and built Vite SPA (`client/dist`).

## Architectural Principles

1. **Authoritative Server Persistence**: No in-memory database or mock fallback exists. Every operational, billing, session, and OAuth operation reads and writes directly to Cloud Firestore via the Firebase Admin SDK (`server/src/repositories/firestoreRepository.ts`). Missing Admin SDK credentials return an explicit HTTP `503 FirebaseConfigurationError` instead of falling back to transient memory.
2. **Strict Multi-Tenant Workspace Isolation**: Every domain document includes `workspaceId`. Every authenticated API route scopes queries and ownership checks to `req.authUser.workspaceId`. Cross-workspace ID access returns `404` or `403`.
3. **Centralized Subscription & Entitlement Engine**: Plan capabilities (`FREE` vs 30-day `PREMIUM`), billing period rollover/expiration against server UTC time, and Meet generation credit quotas (`5` per 30-day cycle) are computed server-side in `subscriptionEntitlementService.ts`.
4. **Centralized Workspace OAuth for Google Meet**: One Workspace Administrator authorizes Google OAuth 2.0 via the server Authorization Code flow (`/api/admin/google/auth-url` → `/api/admin/google/callback`). Tokens are encrypted at rest with AES-256-GCM (`googleAuthTokens/{workspaceId}`) and refreshed server-side when creating Meet REST API v2 spaces (`POST https://meet.googleapis.com/v2/spaces`).
5. **Single-Device Session Enforcement**: Authenticated users hold at most one active session (`activeSessions/{uid}`) with a 30-minute sliding inactivity TTL. Concurrent sign-ins from a second device fail with `409 ACTIVE_SESSION_CONFLICT`.
6. **Zero-Secret Bootstrap & Verified Billing**: First-time setup happens interactively via `POST /api/bootstrap` guarded by `systemConfig/bootstrap` and optional `BOOTSTRAP_SETUP_SECRET`. Premium upgrades require genuine Razorpay Checkout HMAC-SHA256 verification and raw-body Webhook signature validation.
