# TaskFlow Application Status, Security & Setup Report

> **Who is this guide for?**  
> This report explains—in plain, everyday language—what has already been built and verified in your **TaskFlow** application, how your security checks work, and what steps you need to complete on your side before using every feature or launching live.

---

## 1. Current Live Status (Checked Right Now)

| Component | Current Status | Details |
| --- | --- | --- |
| **Web App & Backend Server** | Running & Healthy | `/api/health` responds with `status: "ok"` (`TaskFlow Multi-Tenant SaaS API v2.0.0`). |
| **Firebase Project** | Connected | `gen-lang-client-0707937978` |
| **Cloud Firestore Database** | Connected | `ai-studio-subscriptiontask-992983c8-db4b-4b78-98e3-4f6d1adf9bac` (Region: `asia-south1`) |
| **Firebase Admin Credentials** | Configured | `hasServiceAccount: true`, `connected: true` |
| **Workspace Onboarding** | Already Initialized | `initialized: true` (a Workspace + Admin account already exist in Firestore) |
| **Firestore Security Rules** | ESLint Checked & Deployed | Verified with `@firebase/eslint-plugin-security-rules` (0 errors) and deployed to your database |
| **TypeScript Build & Client Lint** | Passing | Server & client TypeScript builds succeed; client `oxlint` reports 0 errors |

---

## 2. What Has Been Built & Is Working Inside Your App

### A. Company Workspace & First-Time Setup
- **Multi-Tenant Design:** Every organization has its own isolated **Workspace** (`workspaces`), so tasks, employees, queries, payments, and meetings never leak across different companies.
- **No Hardcoded Passwords:** Old default/demo passwords (`admin@company.com` / `Admin@2024!`) and fake in-memory seed data have been completely removed.
- **Onboarding Screen (`/login` → `POST /api/bootstrap`):** On a fresh database, the app automatically shows an **Initialize Your Workspace** form where the first Administrator creates the company workspace and admin account (using Email/Password or Google Sign-In). Once done, `systemConfig/bootstrap` locks onboarding so nobody else can re-run it.

### B. Accounts, Login & Single-Device Protection
- **Login Methods (`/api/auth/login`):**
  - **Email & Password:** Passwords are encrypted one-way using `bcrypt` (12 salt rounds)—meaning nobody can read or reverse-engineer a user’s password from the database.
  - **Google Sign-In:** Users can sign in via Google Firebase popup if their Workspace email is already provisioned.
- **Single-Device Session Rule (`activeSessions/{uid}`):**
  - Only **one active browser/device session** is allowed per user at a time.
  - Sessions automatically expire after **30 minutes of inactivity** (configurable via `SESSION_INACTIVITY_TIMEOUT_MINUTES`).
  - If someone tries to log into the same account from a second browser while the first is active, the server blocks it (`409 ACTIVE_SESSION_CONFLICT`) until the first user logs out or times out.
- **No Plaintext Password Exposure:** Employees’ passwords are never returned in API responses or CSV exports (`/api/employees/export-csv` exports only directory info like Name, Email, Department, Role, Status).

### C. Core Task Management & Team Collaboration (Included in FREE Plan)
- **Employee Management (`/admin/employees`):** Admins can add employees, edit profiles, filter by department, export directory CSVs, and activate/deactivate accounts.
- **Task Assignment (`/admin/tasks`, `/employee/tasks`):** Supports **Solo** tasks and **Group** tasks with priorities (`low`, `medium`, `high`, `critical`), deadlines, reference numbers (`TSK-...`), and member-by-member status tracking (`pending` → `in_progress` / `blocked` → `submitted_for_review` → `approved` or `revision_requested`).
- **Task Chat & Queries (`/api/tasks/:taskId/messages`, `/api/queries`):** Real team comments on tasks plus structured employee queries (`clarification`, `blocker`, `dependency`, `deadline_concern`, etc.) with open/answered/resolved/reopened tracking.
- **IST Scheduler & Reminders (`server/src/services/istSchedulerService.ts`):** Automatic Asia/Kolkata (`IST`) clock and reminder checks for pending tasks, approaching deadlines, and overdue tasks.
- **Reports & Audit History (`/admin/reports`):** Filterable task/member completion reports and workspace audit trail (`auditEvents`).
- **In-App Notifications & Web Push (FCM):** Notification center + optional browser push notifications (`devices` and `pushPreferences`).

### D. Subscription Plans & Billing (`/admin/subscription`)
- **Two Plans:**
  - **FREE Plan (Default):** Full access to Employees, Tasks, Chat, Queries, Reminders, Notifications, and Reports.
  - **PREMIUM Plan (30 Days = `2,592,000` seconds):** Unlocks **Status Requests**, **Status Queries**, and **Google Meet Integration** (includes **5 Google Meet generation credits** per 30-day billing period).
- **Early Renewal & Rollover:** Purchasing Premium again while a period is still active schedules the next 30-day period to begin right when the current one ends (no lost days). When a period ends without renewal, the server automatically marks it `EXPIRED` and enforces Free-tier limits.
- **Razorpay Payment Integration (`server/src/services/razorpayPaymentService.ts`):**
  - Plan price (`PREMIUM_PLAN_AMOUNT`) is controlled **only on the server**—users cannot tamper with prices from the browser.
  - Verifies Razorpay Checkout signatures and background Razorpay Webhooks (`paymentEvents` deduplication ensures a user is never charged or credited twice for the same webhook).

### E. Google Meet Generation (`server/src/services/meetGenerationService.ts`)
- **Centralized Workspace OAuth:** Only the Workspace **Admin** connects a Google account once (`GET /api/admin/google/auth-url` → Google callback).
- **Real Google Meet API v2:** Calls `POST https://meet.googleapis.com/v2/spaces` on the server to generate genuine Google Meet links (never fake/placeholder links).
- **Safe Credit Accounting (`meetGenerationOperations`):** Before calling Google, the server reserves 1 credit inside a database transaction (`RESERVED`). If Google succeeds, the credit becomes `SUCCESS`; if Google fails, the credit is automatically returned (`FAILED`) so you never lose a credit on an error.

---

## 3. Security & Error-Handler Inspection Results

We inspected the backend middleware, route guards, database rules, and frontend handlers. Here is what is protecting your app:

| Security Layer | Where It Lives | How It Protects Your App |
| --- | --- | --- |
| **Auth & Role Guards** | `server/src/middleware/auth.ts` | Checks signed HMAC Bearer token (or Firebase ID token) + verifies the user is `active` in Firestore on **every** protected API call. Admin-only routes enforce `requireAdmin`. |
| **Timing-Safe Signature Checks** | `sessionService.ts`, `razorpayPaymentService.ts` | Uses `crypto.timingSafeEqual` for session tokens, Razorpay checkout signatures, and Razorpay webhook signatures to prevent cryptographic timing attacks. |
| **Encrypted OAuth Tokens** | `meetGenerationService.ts` | Encrypts Google Access & Refresh tokens with **AES-256-GCM** (random IV + auth tag) before saving to `googleAuthTokens`. Raw tokens are never sent to the browser. |
| **One-Time OAuth State** | `meetGenerationService.ts` (`oauthStates`) | Uses random single-use state tokens that expire in **15 minutes** and are deleted/marked consumed inside a transaction to block CSRF/replay attacks. |
| **Multi-Tenant Workspace Lock** | `server/src/routes/*.ts` | Every query (`taskRepo`, `queryRepo`, `employee`, `meeting`, `payment`) filters strictly by `req.authUser.workspaceId`. Users in one workspace cannot read or edit another workspace's data. |
| **Zero-Trust Firestore Rules** | `firestore.rules` | Uses a global `allow read, write: if false;` catch-all. Client SDKs **cannot** write directly to tasks, users, subscriptions, payments, sessions, or tokens (`systemConfig`, `googleAuthTokens`, `oauthStates`, `paymentEvents` have `allow read, write: if false`). |
| **Central Error Middleware** | `server/src/middleware/errorHandler.ts` & `server/src/firebase.ts` | Catches all async route errors cleanly (`asyncHandler`), returns clean JSON HTTP status codes (`400`, `401`, `402` Upgrade Required, `403`, `409` Session Conflict, `503` Firebase Config Error), and never crashes the server on unhandled promises. |
| **Frontend API & Firebase Error Handling** | `client/src/services/api.ts` & `client/src/firebase.ts` | `api.ts` clears expired local auth cleanly on `401` without mis-redirecting `402` or `409` errors. `firebase.ts` includes `handleFirestoreError` and `experimentalForceLongPolling: true` for stable preview iframe connections. |

### Two Important Security Things to Keep in Mind (Honest Audit Notes)
1. **Always set a permanent `SESSION_SECRET`:** In `server/src/config.ts`, if `SESSION_SECRET` is missing, the server generates a temporary random secret every time it starts—which logs everyone out whenever the server restarts. Always keep a fixed 64-character `SESSION_SECRET` set.
2. **Email/Password Login vs Direct Client Firestore Access:** Users who log in with **Email/Password** authenticate via TaskFlow’s Express backend session token (not a Firebase Client Auth session). That works seamlessly because the UI reads/writes data through Express `/api/*` routes. Only users who click **Sign in with Google** also hold a client Firebase Auth session.

---

## 4. What You Still Need to Do (Step-by-Step User Checklist)

Even though your core database (`gen-lang-client-0707937978`) is connected and initialized, complete the steps below depending on which features you want to turn on:

### Step 1 — Confirm Your Permanent Core Secrets (Required)
Make sure these are permanently saved in **Render → Environment** (for live hosting) and your active preview secrets:
- `FIREBASE_PROJECT_ID=gen-lang-client-0707937978`
- `FIRESTORE_DATABASE_ID=ai-studio-subscriptiontask-992983c8-db4b-4b78-98e3-4f6d1adf9bac`
- `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` *(already working in your preview!)*
- `SESSION_SECRET` → Use a fixed 64-character random hex string (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).

### Step 2 — Deploy Firestore Composite Indexes (Recommended)
Your queries filter by multiple fields (for example: `workspaceId` + `createdAt` or `taskId`). If indexes are not deployed yet, some list/filter queries may fail with a Firestore `"requires an index"` error.
- Run this once from a machine logged into Firebase CLI:
  ```bash
  firebase deploy --only firestore:indexes --project gen-lang-client-0707937978
  ```
- *(Tip: If you ever see an index error in server logs, Firebase also prints a direct 1-click URL to create that index in the console.)*

### Step 3 — Enable Google Sign-In in Firebase Console (If Using Google Login)
1. Open Firebase Console → **Authentication → Sign-in method** for `gen-lang-client-0707937978` and make sure **Google** is enabled.
2. Under **Authentication → Settings → Authorized domains**, add your app URLs:
   - `ais-dev-aqhhvzcusaqfmhzkc2rqtg-274227869132.asia-southeast1.run.app`
   - `ais-pre-aqhhvzcusaqfmhzkc2rqtg-274227869132.asia-southeast1.run.app`
   - Your Render domain (e.g., `your-app.onrender.com`) when deployed.

### Step 4 — Set Up Premium Payments with Razorpay (Optional — Needed Only for Paid Upgrades)
In your server environment / Render Dashboard, add:
- `RAZORPAY_KEY_ID` (from Razorpay Dashboard → Account & Settings → API Keys)
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `PREMIUM_PLAN_CURRENCY=INR`
- `PREMIUM_PLAN_AMOUNT=49900` *(Example: `49900` paise = ₹499.00. Choose whatever price you want.)*
- In **Razorpay Dashboard → Webhooks**, add endpoint:
  - URL: `https://<YOUR-DOMAIN>/api/payments/razorpay/webhook`
  - Events: `payment.captured`, `order.paid`, `payment.failed`

### Step 5 — Set Up Google Meet Link Creation (Optional — Needed Only for Meet Rooms)
1. In **Google Cloud Console** (project `gen-lang-client-0707937978`):
   - Enable the **Google Meet REST API**.
   - Configure OAuth Consent Screen and add scope `https://www.googleapis.com/auth/meetings.space.created`.
   - Create/update Web OAuth credentials and add authorized redirect URI:  
     `https://<YOUR-DOMAIN>/api/admin/google/callback`
2. Add these server environment variables:
   - `OAUTH_TOKEN_ENCRYPTION_KEY` → a **different** 64-character random hex string
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI=https://<YOUR-DOMAIN>/api/admin/google/callback`
3. Log into TaskFlow as Admin → open **Status Requests** → click **Connect Google Account**.

### Step 6 — Set Up Browser Push Notifications (Optional)
1. In Firebase Console → **Project Settings → Cloud Messaging → Web Push certificates**, generate a key pair (VAPID key).
2. Add both:
   - `FIREBASE_VAPID_KEY=<your-vapid-key>`
   - `VITE_FIREBASE_VAPID_KEY=<your-vapid-key>`

### Step 7 — Log In (or Reset Onboarding If Needed)
- Because `initialized: true` is already recorded in your database:
  - Log in at `/login` with the Admin email & password you initialized (or **Sign in with Google**).
  - If you do not remember which Admin email was initialized, open Firebase Console → Firestore (`ai-studio-subscriptiontask-992983c8-db4b-4b78-98e3-4f6d1adf9bac`) → `systemConfig/bootstrap` → check `ownerUid`, then look up `users/{ownerUid}`.
  - To wipe a fresh test setup and see the **Initialize Your Workspace** form again, delete `systemConfig/bootstrap` (and test docs in `users`, `workspaces`, `subscriptions`, `subscriptionPeriods`, `subscriptionUsage`, `activeSessions`) in Firestore Console and reload `/login`.

### Step 8 — Production Deployment (When Ready)
- Your `/render.yaml` is already configured (`npm install --include=dev && npm run build` and `npm start`) on branch `main`.
- When you are ready to go live, connect the repo to **Render**, paste your environment variables from Steps 1 & 4–6 into Render’s **Environment** tab, and deploy.
