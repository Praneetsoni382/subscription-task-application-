# Security Model & Hardening Controls

## Authentication & Credential Hygiene

- **Zero Hardcoded Credentials**: No default admin email/password pairs exist anywhere in client or server code. First-time initialization happens securely via `POST /api/bootstrap`.
- **No Plaintext Passwords**: `initialPassword` and `currentPasswordPlain` fields have been removed from all TypeScript types, Firestore documents, API responses, Employee Dashboard banners, and CSV exports. Passwords are hashed exclusively with `bcryptjs` (cost factor 12) and optionally synced to Firebase Auth via Admin SDK.
- **Token Verification**: Requests authenticate with either:
  - Server-issued HMAC-SHA256 signed session tokens (`SESSION_SECRET`) validated with `crypto.timingSafeEqual`, or
  - Verified Firebase Auth ID tokens (`adminAuth.verifyIdToken`) paired with an active single-device `x-session-id` header.

## Encryption & Webhook Verification

- **Google OAuth Token Encryption**: Workspace `access_token` and `refresh_token` payloads are encrypted at rest with **AES-256-GCM** using `OAUTH_TOKEN_ENCRYPTION_KEY` (96-bit random IV + 128-bit authentication tag).
- **OAuth CSRF Protection**: Authorization states are single-use random tokens stored server-side in `oauthStates/{stateId}` with a 15-minute expiration.
- **Razorpay Signatures**: Checkout signatures (`razorpay_order_id|razorpay_payment_id`) and raw-body webhooks (`x-razorpay-signature`) are verified using HMAC-SHA256 + `crypto.timingSafeEqual`.

## Firestore Security Rules (`/firestore.rules`)

- Global default-deny rule (`match /{document=**} { allow read, write: if false; }`) at the root of `match /databases/{database}/documents`.
- Server-only collections (`systemConfig`, `googleAuthTokens`, `oauthStates`, `paymentEvents`) deny all client reads and writes (`allow read, write: if false;`).
- Financial, subscription, usage, operation, audit, and active session collections (`subscriptions`, `subscriptionPeriods`, `subscriptionUsage`, `subscriptionEvents`, `payments`, `meetGenerationOperations`, `activeSessions`, `auditEvents`, `reminderOccurrences`) deny all client writes (`allow create, update, delete: if false;`) and enforce strict `workspaceId` / owner verification on `get`.
- Client `allow list` rules never invoke `get()`/`exists()` and always constrain `resource.data` directly to `request.auth.uid`.
- Verified continuously with `npx eslint firestore.rules` (`@firebase/eslint-plugin-security-rules`).
