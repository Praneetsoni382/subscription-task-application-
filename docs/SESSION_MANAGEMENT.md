# Single-Device Session Management

## Policy

Each TaskFlow user (`admin` or `employee`) may maintain **at most one active authenticated session** across devices at a time (`server/src/services/sessionService.ts`).

## Firestore State (`activeSessions/{uid}`)

```json
{
  "uid": "...",
  "workspaceId": "...",
  "sessionId": "...",
  "deviceLabel": "Google Chrome",
  "status": "ACTIVE",
  "createdAt": "2026-11-15T...",
  "lastActivityAt": "2026-11-15T...",
  "expiresAt": "2026-11-15T..."
}
```

## Lifecycle & Conflict Handling

1. **Login / Bootstrap (`createOrValidateSingleDeviceSession`)**:
   - Executes inside a Firestore transaction on `activeSessions/{uid}`.
   - If no active session exists, or if the existing session has `status !== 'ACTIVE'` or `expiresAt <= nowMs`, or if `requestedSessionId === existing.sessionId` (re-login on same browser), a fresh or refreshed 30-minute active session is written.
   - If another device currently holds an unexpired `ACTIVE` session with a different `sessionId`, the transaction aborts with **HTTP `409 ACTIVE_SESSION_CONFLICT`**.
2. **Sliding 30-Minute Inactivity Timeout (`validateAndTouchSession`)**:
   - Every authenticated request (`requireAuth` middleware) validates the token's `sessionId` (or `x-session-id` header for Firebase ID tokens) against `activeSessions/{uid}`.
   - If expired (`expiresAt <= now`), the session is marked `EXPIRED` and the API returns `401 SESSION_EXPIRED`.
   - If valid, `lastActivityAt` is updated and `expiresAt` slides forward by 30 minutes (`1,800,000 ms`, throttled in Firestore writes when >60s has elapsed to conserve write quota).
3. **Sign-Out (`POST /api/auth/logout`)**:
   - Marks `activeSessions/{uid}` `status: 'REVOKED'` if `sessionId` matches, releases the Express session cookie, deactivates the device's FCM registration, and allows immediate sign-in from another device.
