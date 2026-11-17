# Environment Setup & Configuration Guide

## Provisioned Firebase Identifiers

- **Project ID**: `gen-lang-client-0707937978`
- **Firestore Database ID**: `ai-studio-subscriptiontask-992983c8-db4b-4b78-98e3-4f6d1adf9bac`
- **Region**: `asia-south1`
- **OAuth Web Client ID**: `759056051727-lt462gtk7bth0s7mg6tpahhpd868c1fc.apps.googleusercontent.com`

## Required Environment Variables

All variable names are declared without secrets in `/.env.example`.

### 1. Server Core & Firebase Admin SDK
- `BACKEND_PORT` / `PORT`: Port for Express server (default `3000`).
- `CLIENT_URL`: Public frontend origin (e.g., `https://your-service.onrender.com`).
- `SESSION_SECRET`: 32+ character random secret for signing `taskflow` session tokens and cookies.
- `FIREBASE_PROJECT_ID`: `gen-lang-client-0707937978`
- `FIRESTORE_DATABASE_ID`: `ai-studio-subscriptiontask-992983c8-db4b-4b78-98e3-4f6d1adf9bac`
- `FIREBASE_STORAGE_BUCKET`: `gen-lang-client-0707937978.firebasestorage.app`
- `FIREBASE_CLIENT_EMAIL`: Service account `client_email` from Firebase Console → Project Settings → Service Accounts.
- `FIREBASE_PRIVATE_KEY`: Service account `private_key` (preserve `\n` escapes in single-line env vars).
- `BOOTSTRAP_SETUP_SECRET` *(optional recommended)*: Shared secret required by `POST /api/bootstrap` during first-time Workspace setup.

### 2. Google Meet Centralized Workspace OAuth
- `GOOGLE_CLIENT_ID`: OAuth 2.0 Web Client ID (`759056051727-lt462gtk7bth0s7mg6tpahhpd868c1fc.apps.googleusercontent.com`).
- `GOOGLE_CLIENT_SECRET`: Corresponding OAuth 2.0 Client Secret from Google Cloud Console.
- `GOOGLE_REDIRECT_URI`: Registered redirect URI (`https://<your-domain>/api/admin/google/callback`).
- `OAUTH_TOKEN_ENCRYPTION_KEY`: 32-byte encryption key (64 hex chars, 32-byte base64, or passphrase hashed via SHA-256) used for AES-256-GCM token encryption at rest.

### 3. Razorpay Billing & Webhook Verification
- `RAZORPAY_KEY_ID`: Razorpay API Key ID.
- `RAZORPAY_KEY_SECRET`: Razorpay API Key Secret (used for Orders API + Checkout HMAC verification).
- `RAZORPAY_WEBHOOK_SECRET`: Razorpay Webhook signing secret (configure webhook URL `https://<your-domain>/api/payments/razorpay/webhook` for `payment.captured`, `order.paid`, `payment.failed`).
- `PREMIUM_PLAN_AMOUNT`: Positive integer in smallest currency unit (e.g., `49900` for ₹499.00 INR).
- `PREMIUM_PLAN_CURRENCY`: Currency code (defaults to `INR`).

### 4. Client Vite Build & Push Notifications (FCM)
- `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIRESTORE_DATABASE_ID` (also bundled in `client/src/firebase-applet-config.json`).
- `FIREBASE_VAPID_KEY` & `VITE_FIREBASE_VAPID_KEY`: Web Push certificate key pair from Firebase Console → Cloud Messaging.
