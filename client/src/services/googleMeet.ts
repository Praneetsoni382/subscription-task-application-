// ============================================================
// CLIENT GOOGLE MEET OAUTH HELPER
// File: client/src/services/googleMeet.ts
// Centralized backend Authorization Code Flow only.
// Zero client-held Google OAuth tokens, zero GIS scripts, zero fallback client IDs.
// ============================================================

import { meetingApi } from './api';

/**
 * Initiates the Workspace Administrator Google OAuth 2.0 Authorization Code flow
 * via the authenticated backend `/api/admin/google/auth-url` endpoint.
 */
export async function startWorkspaceGoogleOAuth(): Promise<void> {
  const res = await meetingApi.getAuthUrl();
  const authUrl = (res.data?.data as { authUrl?: string } | undefined)?.authUrl;
  if (!authUrl) {
    throw new Error(
      res.data?.error || 'Backend Google OAuth authorization URL is unavailable.'
    );
  }
  window.location.href = authUrl;
}

/**
 * Checks URL query parameters after an OAuth redirect back to the app
 * and cleans sensitive/status query params from browser history.
 */
export function checkOAuthUrlParams(): { connected?: boolean; error?: string } {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get('google_connected') === 'true';
  const error = params.get('oauth_error') || undefined;

  if (connected || error) {
    const url = new URL(window.location.href);
    url.searchParams.delete('google_connected');
    url.searchParams.delete('oauth_error');
    window.history.replaceState({}, '', url.pathname + url.search);
  }

  return { connected, error };
}
