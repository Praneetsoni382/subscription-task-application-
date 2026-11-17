# Centralized Workspace Google Meet Architecture

## Overview

TaskFlow uses a single, centralized **Workspace Administrator Google OAuth 2.0 Authorization Code flow** managed exclusively on the backend (`server/src/services/meetGenerationService.ts`). Client-side Google Identity Services (GIS) scripts, hardcoded OAuth client IDs, manual token endpoints, and synthetic Meet URLs are completely eliminated.

## End-to-End OAuth 2.0 Flow

1. **Initiate Authorization (`GET /api/admin/google/auth-url` or `/api/admin/google/authorize`)**:
   - Requires an authenticated Workspace `admin`.
   - Generates a random cryptographic `state` stored in Firestore `oauthStates/{stateId}` with `{ workspaceId, adminUid, redirectUri, returnTo, expiresAt }` (15-minute TTL).
   - Redirects to Google OAuth (`https://accounts.google.com/o/oauth2/v2/auth`) requesting `access_type=offline`, `prompt=consent`, and scopes:
     - `https://www.googleapis.com/auth/meetings.space.created`
     - `https://www.googleapis.com/auth/userinfo.email`
2. **OAuth Callback (`GET /api/admin/google/callback`)**:
   - Consumes and deletes the one-time `oauthStates/{stateId}` document (rejecting expired or replayed states).
   - Exchanges the authorization `code` with Google's token endpoint using `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
   - Encrypts `access_token` and `refresh_token` using **AES-256-GCM** (`OAUTH_TOKEN_ENCRYPTION_KEY`) and stores them in `googleAuthTokens/{workspaceId}` (strictly locked against client reads/writes in `firestore.rules`).
3. **Automatic Token Refresh**:
   - Before calling the Google Meet API, `getValidWorkspaceAccessToken(workspaceId)` decrypts stored tokens; if expiring within 60 seconds, it automatically exchanges the encrypted `refresh_token` for a fresh `access_token`, re-encrypts, and persists it in `googleAuthTokens/{workspaceId}`.
   - If the refresh token was revoked (`invalid_grant`), the workspace token record is marked `revoked` and an error (`400 GOOGLE_TOKEN_REFRESH_FAILED`) prompts the Admin to reconnect.

## Creating Genuine Google Meet Spaces

- Meet creation is strictly gated behind:
  1. Authenticated Workspace `admin`.
  2. Active `PREMIUM` subscription (`canGenerateMeet`).
  3. Atomic Meet credit reservation (`meetCreditsUsed + meetCreditsReserved < 5`).
- The backend calls `POST https://meet.googleapis.com/v2/spaces` with `{ config: { accessType: 'OPEN' } }` using the Workspace's valid OAuth access token.
- Only if Google returns a genuine `meetingUri` and `name` does the transaction commit the credit and persist `meetings/{meetingId}`.
