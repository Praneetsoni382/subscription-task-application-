# TaskFlow — Multi-Tenant Workspace Task Operations & Subscription Platform

TaskFlow is a Vite + React + TypeScript + Express + Cloud Firestore enterprise task operations SaaS platform featuring strict Workspace multi-tenant isolation, Free vs 30-day Paid Premium entitlements, centralized AES-256-GCM Google Workspace OAuth + Google Meet REST API v2 integration, Razorpay checkout/webhook billing, single-device active session locking, IST automated task reminders, and FCM Web Push notifications.

## Core Architecture

- **Frontend**: `client/` (Vite, React 19, TypeScript, Tailwind CSS v4, TanStack Query)
- **Backend**: `server/` & `/server.ts` (Express 5, TypeScript, Firebase Admin SDK, `node-cron`)
- **Database**: Cloud Firestore (`gen-lang-client-0707937978` / `ai-studio-subscriptiontask-992983c8-db4b-4b78-98e3-4f6d1adf9bac` in `asia-south1`)
- **Hosting**: Render Web Service (`render.yaml`)

## Plan Capabilities

- **Free Plan**: Unlimited task creation, solo/group assignments, member status lifecycle, task clarification queries, team chat, notifications, automated IST deadline reminders, and operational reports.
- **Premium Plan (30-day cycles)**: Unlocks manager Status Requests, Status Queries, up to **5 Google Meet REST API v2 links per 30-day billing period** with atomic reservation & rollover chaining, and joining published Google Meet rooms.

## Quick Start (Local Development)

1. Copy `/.env.example` to `.env` and fill in your credentials (`FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `SESSION_SECRET`, `OAUTH_TOKEN_ENCRYPTION_KEY`, Google OAuth credentials, Razorpay keys, and `PREMIUM_PLAN_AMOUNT`). See `/docs/ENVIRONMENT_SETUP.md`.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build server & client:
   ```bash
   npm run build
   ```
4. Start the server on port `3000`:
   ```bash
   npm start
   ```
5. Visit `http://localhost:3000/login` to complete the interactive first-time Workspace & Administrator setup.

## Documentation

Full architectural documentation is available under `/docs/`:
- `/docs/ARCHITECTURE.md`
- `/docs/FIRESTORE_SCHEMA.md`
- `/docs/WORKSPACE_MODEL.md`
- `/docs/SUBSCRIPTION_MODEL.md`
- `/docs/GOOGLE_MEET_ARCHITECTURE.md`
- `/docs/RAZORPAY_PAYMENT_ARCHITECTURE.md`
- `/docs/SECURITY_MODEL.md`
- `/docs/SESSION_MANAGEMENT.md`
- `/docs/ENVIRONMENT_SETUP.md`
- `/docs/IMPLEMENTATION_ROADMAP.md`
