// ============================================================
// CLIENT GOOGLE MEET AUTHENTICATION HELPER
// File: client/src/services/googleMeet.ts
// Obtains a Google Meet OAuth access token strictly in memory.
// Uses Google Identity Services (GIS) Token Client with the
// provisioned OAuth Client ID (works reliably inside embedded
// preview iframes without firebaseapp.com storage partitioning),
// with Firebase Auth signInWithPopup as fallback.
// Access tokens are NEVER written to localStorage or sessionStorage.
// ============================================================

import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup } from 'firebase/auth';
import { auth } from '../firebase';
import firebaseConfig from '../firebase-applet-config.json';
import { meetingApi } from './api';

export const GOOGLE_MEET_SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.created',
] as const;

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface GisErrorCallbackPayload {
  type?: string;
  message?: string;
}

interface GisTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string; hint?: string }) => void;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            prompt?: string;
            callback: (response: GisTokenResponse) => void;
            error_callback?: (error: GisErrorCallbackPayload) => void;
          }) => GisTokenClient;
        };
      };
    };
  }
}

// Strictly in-memory cache (cleared automatically on sign-out)
let cachedMeetAccessToken: string | null = null;
let cachedMeetEmail: string | null = null;

onAuthStateChanged(auth, (firebaseUser) => {
  if (!firebaseUser) {
    cachedMeetAccessToken = null;
    cachedMeetEmail = null;
  }
});

function loadGisScript(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.google?.accounts?.oauth2?.initTokenClient) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src^="https://accounts.google.com/gsi/client"]'
    );
    if (existing) {
      let attempts = 0;
      const timer = window.setInterval(() => {
        attempts += 1;
        if (window.google?.accounts?.oauth2?.initTokenClient) {
          window.clearInterval(timer);
          resolve(true);
        } else if (attempts >= 30) {
          window.clearInterval(timer);
          resolve(false);
        }
      }, 100);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(Boolean(window.google?.accounts?.oauth2?.initTokenClient));
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

function requestGisAccessToken(clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2?.initTokenClient) {
      reject(new Error('Google Identity Services is unavailable.'));
      return;
    }

    let settled = false;
    const finishResolve = (token: string) => {
      if (settled) return;
      settled = true;
      resolve(token);
    };
    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const tokenClient = oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_MEET_SCOPES.join(' '),
      callback: (response) => {
        if (response.error) {
          finishReject(
            new Error(response.error_description || `Google authorization error: ${response.error}`)
          );
          return;
        }
        if (!response.access_token) {
          finishReject(
            new Error('Google authorization did not return a Meet access token. Please try again.')
          );
          return;
        }
        finishResolve(response.access_token);
      },
      error_callback: (err) => {
        if (err?.type === 'popup_closed') {
          finishReject(
            new Error(
              isEmbeddedInIframe()
                ? 'Google sign-in popup could not complete inside the embedded preview frame (blocked by browser third-party storage partitioning). Click "Open in New Tab" below and connect from the standalone tab.'
                : 'Google sign-in popup was closed before completing authorization. Please try again.'
            )
          );
          return;
        }
        if (err?.type === 'popup_failed_to_open') {
          finishReject(
            new Error('Your browser blocked the Google sign-in popup. Please allow popups for this site and try again.')
          );
          return;
        }
        finishReject(
          new Error(err?.message || 'Google authorization could not be completed. Please try again.')
        );
      },
    });

    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

export function isEmbeddedInIframe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Authorizes Google Meet space creation via Google OAuth popup
 * and caches the OAuth access token strictly in memory.
 */
export async function authorizeGoogleMeetPopup(): Promise<{
  accessToken: string;
  email: string | null;
}> {
  const oauthClientId = (firebaseConfig as { oAuthClientId?: string }).oAuthClientId;

  // Primary path: Google Identity Services Token Client (direct postMessage to opener,
  // immune to Chrome's cross-origin iframe storage partitioning on firebaseapp.com).
  if (oauthClientId) {
    const gisReady =
      Boolean(window.google?.accounts?.oauth2?.initTokenClient) || (await loadGisScript());
    if (gisReady) {
      const accessToken = await requestGisAccessToken(oauthClientId);
      cachedMeetAccessToken = accessToken;
      cachedMeetEmail = auth.currentUser?.email || null;
      return {
        accessToken: cachedMeetAccessToken,
        email: cachedMeetEmail,
      };
    }
  }

  // Fallback path: Firebase Auth GoogleAuthProvider popup
  const provider = new GoogleAuthProvider();
  for (const scope of GOOGLE_MEET_SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({ prompt: 'consent' });

  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Google authorization did not return a Meet access token. Please try again.');
    }

    cachedMeetAccessToken = credential.accessToken;
    cachedMeetEmail = result.user.email || null;

    return {
      accessToken: cachedMeetAccessToken,
      email: cachedMeetEmail,
    };
  } catch (err: any) {
    const code = err?.code || '';
    if (code === 'auth/popup-closed-by-user') {
      throw new Error('Google sign-in popup was closed before completing authorization. Please try again.');
    }
    if (code === 'auth/popup-blocked') {
      throw new Error('Your browser blocked the Google sign-in popup. Please allow popups for this site and try again.');
    }
    if (code === 'auth/cancelled-popup-request') {
      throw new Error('Another Google sign-in window is already open. Please complete or close it and try again.');
    }
    if (code === 'auth/unauthorized-domain') {
      throw new Error('This preview domain is not yet authorized for Google Sign-In.');
    }
    throw err;
  }
}

export function getCachedMeetAccessToken(): string | null {
  return cachedMeetAccessToken;
}

export function getCachedMeetEmail(): string | null {
  return cachedMeetEmail;
}

export function clearMeetAccessToken(): void {
  cachedMeetAccessToken = null;
  cachedMeetEmail = null;
}

/**
 * Optional server-side OAuth redirect flow (when backend GOOGLE_CLIENT_SECRET is configured).
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
 * Checks URL query parameters after a server-side OAuth redirect back to the app
 * and cleans status query params from browser history.
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
