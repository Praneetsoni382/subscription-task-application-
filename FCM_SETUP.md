# Firebase Cloud Messaging (FCM) Web Push Setup

TaskFlow supports real-time browser & mobile Web Push notifications via Firebase Cloud Messaging (`firebase-messaging-sw.js` and `server/src/services/pushNotificationService.ts`).

## Project Identifiers

- **Project ID**: `gen-lang-client-0707937978`
- **Messaging Sender ID**: `759056051727`
- **Service Worker**: `/client/public/firebase-messaging-sw.js`

## Required Configuration

1. Open Firebase Console → Project `gen-lang-client-0707937978` → **Project Settings** → **Cloud Messaging** → **Web configuration**.
2. Generate or copy your **Web Push certificate (VAPID public key)**.
3. Set both environment variables (keeping the VAPID private key only in Firebase):
   ```env
   FIREBASE_VAPID_KEY=<your-public-vapid-key>
   VITE_FIREBASE_VAPID_KEY=<your-public-vapid-key>
   ```
4. Ensure backend Firebase Admin SDK credentials (`FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`) are configured so the server can dispatch FCM multicast payloads to active devices stored in `devices` and `/users/{uid}/devices`.

## Verification

- Sign in on `/login`, accept the browser notification prompt, and check registered devices in your notification settings.
- Use `POST /api/push/test` (authenticated) to send a live test push notification to your active device tokens.
