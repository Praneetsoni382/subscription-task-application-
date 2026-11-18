// ============================================================
// CENTRALIZED GOOGLE MEET & OAUTH SERVICE (PART 7)
// - Admin-only, Workspace-scoped OAuth 2.0 Authorization Code flow
// - AES-256-GCM encrypted token persistence in Firestore
// - Firestore-persisted one-time OAuth state tokens (15m TTL)
// - Transactional Meet Credit reservation (meetCreditsUsed + meetCreditsReserved < 5)
// - Official Google Meet REST API v2 space creation ONLY (no fake URLs)
// ============================================================

import crypto from 'crypto';
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  OAUTH_STATE_TTL_MS,
  OAUTH_TOKEN_ENCRYPTION_KEY,
  PREMIUM_MEET_CREDIT_LIMIT,
} from '../config.js';
import { firebaseConfig, runFirestoreTransaction } from '../firebase.js';
import { HttpError } from '../middleware/errorHandler.js';
import {
  auditRepo,
  googleAuthRepo,
  meetingRepo,
  newId,
  oauthStateRepo,
} from '../repositories/firestoreRepository.js';
import {
  assertEntitlement,
  canGenerateMeet,
} from './subscriptionEntitlementService.js';
import type {
  GoogleAuthTokens,
  MeetGenerationOperation,
  Meeting,
  OAuthState,
  SafeUser,
  SubscriptionPeriod,
  SubscriptionUsage,
  User,
} from '../types/index.js';

export const MEET_SCOPE = 'https://www.googleapis.com/auth/meetings.space.created';
export const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

export function getEffectiveGoogleClientId(): string {
  return GOOGLE_CLIENT_ID || firebaseConfig.oAuthClientId || '';
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(getEffectiveGoogleClientId() && GOOGLE_CLIENT_SECRET);
}

// ============================================================
// AES-256-GCM TOKEN ENCRYPTION
// ============================================================

function deriveEncryptionKey(): Buffer {
  if (!OAUTH_TOKEN_ENCRYPTION_KEY || OAUTH_TOKEN_ENCRYPTION_KEY.trim().length < 16) {
    throw new HttpError(
      503,
      'OAUTH_TOKEN_ENCRYPTION_KEY is not configured on the backend server (minimum 16 characters / 32-byte key required before persisting Google OAuth tokens).',
      'ENCRYPTION_KEY_MISSING'
    );
  }
  return crypto.createHash('sha256').update(OAUTH_TOKEN_ENCRYPTION_KEY).digest();
}

export function encryptTokenValue(plaintext: string): string {
  const key = deriveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptTokenValue(ciphertext: string): string {
  const key = deriveEncryptionKey();
  const parts = ciphertext.split('.');
  if (parts.length !== 3) {
    throw new HttpError(500, 'Stored Google OAuth token ciphertext format is invalid.', 'TOKEN_DECRYPT_ERROR');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// ============================================================
// GOOGLE OAUTH STATE & CODE EXCHANGE
// ============================================================

export function resolveRedirectUri(
  explicitUri?: string,
  hostHeader?: string,
  protoHeader = 'https'
): string {
  if (GOOGLE_REDIRECT_URI && GOOGLE_REDIRECT_URI.trim().length > 0) {
    return GOOGLE_REDIRECT_URI.trim();
  }
  if (explicitUri && explicitUri.trim().length > 0) {
    return explicitUri.trim();
  }
  if (hostHeader) {
    const isLocal = hostHeader.includes('localhost') || hostHeader.includes('127.0.0.1');
    const proto = isLocal ? 'http' : protoHeader || 'https';
    return `${proto}://${hostHeader}/api/admin/google/callback`;
  }
  return 'http://localhost:3000/api/admin/google/callback';
}

export async function createOAuthState(params: {
  workspaceId: string;
  adminUid: string;
  redirectUri: string;
  returnTo?: string;
}): Promise<string> {
  const stateId = `st_${crypto.randomBytes(24).toString('hex')}`;
  const nowMs = Date.now();
  const doc: OAuthState = {
    id: stateId,
    workspaceId: params.workspaceId,
    adminUid: params.adminUid,
    redirectUri: params.redirectUri,
    returnTo: params.returnTo || '/admin/status-requests',
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + OAUTH_STATE_TTL_MS).toISOString(),
    consumedAt: null,
  };
  await oauthStateRepo.create(doc);
  return stateId;
}

export async function consumeOAuthState(
  stateId: string,
  expectedAdminUid?: string,
  expectedWorkspaceId?: string
): Promise<OAuthState> {
  if (!stateId || stateId.trim().length === 0) {
    throw new HttpError(400, 'Missing Google OAuth state parameter.', 'OAUTH_STATE_MISSING');
  }

  return runFirestoreTransaction(async (tx, db) => {
    const ref = db.collection('oauthStates').doc(stateId);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpError(400, 'Invalid or unknown Google OAuth state parameter.', 'OAUTH_STATE_INVALID');
    }

    const record = snap.data() as OAuthState;
    if (record.consumedAt) {
      throw new HttpError(400, 'Google OAuth state parameter has already been consumed.', 'OAUTH_STATE_REUSED');
    }

    const expiresMs = Date.parse(record.expiresAt);
    if (!expiresMs || Date.now() > expiresMs) {
      tx.delete(ref);
      throw new HttpError(400, 'Google OAuth authorization state has expired. Please try connecting again.', 'OAUTH_STATE_EXPIRED');
    }

    if (expectedAdminUid && record.adminUid !== expectedAdminUid) {
      throw new HttpError(403, 'OAuth state does not belong to the authenticated administrator.', 'OAUTH_STATE_UID_MISMATCH');
    }
    if (expectedWorkspaceId && record.workspaceId !== expectedWorkspaceId) {
      throw new HttpError(403, 'OAuth state does not belong to the active workspace.', 'OAUTH_STATE_WORKSPACE_MISMATCH');
    }

    tx.set(ref, { consumedAt: new Date().toISOString() }, { merge: true });
    return record;
  }, 'consumeOAuthState');
}

export function getGoogleOAuthUrl(stateId: string, redirectUri: string): string {
  const clientId = getEffectiveGoogleClientId();
  if (!clientId) {
    throw new HttpError(
      503,
      'GOOGLE_CLIENT_ID is not configured. Configure Google OAuth environment variables first.',
      'GOOGLE_OAUTH_UNCONFIGURED'
    );
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: `${MEET_SCOPE} ${EMAIL_SCOPE}`,
    access_type: 'offline',
    prompt: 'consent',
    state: stateId,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(params: {
  code: string;
  workspaceId: string;
  adminUid: string;
  redirectUri: string;
}): Promise<{ email?: string; connectedAt: string }> {
  const clientId = getEffectiveGoogleClientId();
  if (!clientId || !GOOGLE_CLIENT_SECRET) {
    throw new HttpError(
      503,
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured on the backend server to exchange Google OAuth codes.',
      'GOOGLE_OAUTH_UNCONFIGURED'
    );
  }

  // Ensure encryption key is valid before exchanging authorization code
  deriveEncryptionKey();

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: clientId,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const data = (await response.json()) as Record<string, any>;
  if (!response.ok || !data.access_token) {
    throw new HttpError(
      400,
      data.error_description || data.error || 'Failed to exchange Google OAuth authorization code',
      'GOOGLE_OAUTH_EXCHANGE_FAILED'
    );
  }

  let email = '';
  try {
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (userRes.ok) {
      const userData = (await userRes.json()) as Record<string, any>;
      email = userData.email || '';
    }
  } catch {
    // non-fatal
  }

  const nowIso = new Date().toISOString();
  const existing = await googleAuthRepo.getTokensByWorkspace(params.workspaceId);

  const encryptedAccessToken = encryptTokenValue(String(data.access_token));
  const encryptedRefreshToken = data.refresh_token
    ? encryptTokenValue(String(data.refresh_token))
    : existing?.encryptedRefreshToken || null;

  const record: GoogleAuthTokens = {
    id: params.workspaceId,
    workspaceId: params.workspaceId,
    connectedBy: params.adminUid,
    encryptedAccessToken,
    encryptedRefreshToken,
    tokenExpiry: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    scopes: typeof data.scope === 'string' ? data.scope.split(' ') : [MEET_SCOPE, EMAIL_SCOPE],
    email: email || existing?.email,
    connectedAt: existing?.connectedAt || nowIso,
    updatedAt: nowIso,
  };

  await googleAuthRepo.saveTokensForWorkspace(record);

  await auditRepo.create({
    workspaceId: params.workspaceId,
    actorUserId: params.adminUid,
    entityType: 'workspace',
    entityId: params.workspaceId,
    eventType: 'GOOGLE_OAUTH_CONNECTED',
    previousState: null,
    newState: email || params.adminUid,
    message: `Workspace Google Meet OAuth connected by administrator (${email || params.adminUid}).`,
    createdAt: nowIso,
  });

  return { email: record.email, connectedAt: record.connectedAt };
}

export async function disconnectWorkspaceGoogleOAuth(
  workspaceId: string,
  adminUid: string
): Promise<void> {
  await googleAuthRepo.clearTokensForWorkspace(workspaceId);
  await auditRepo.create({
    workspaceId,
    actorUserId: adminUid,
    entityType: 'workspace',
    entityId: workspaceId,
    eventType: 'GOOGLE_OAUTH_DISCONNECTED',
    previousState: 'connected',
    newState: 'disconnected',
    message: 'Workspace Google Meet OAuth connection revoked by administrator.',
    createdAt: new Date().toISOString(),
  });
}

async function refreshWorkspaceAccessToken(workspaceId: string): Promise<string> {
  const stored = await googleAuthRepo.getTokensByWorkspace(workspaceId);
  if (!stored || !stored.encryptedRefreshToken) {
    throw new HttpError(
      400,
      'No Google OAuth refresh token is stored for this workspace. Please reconnect Google Meet in Google Settings.',
      'GOOGLE_OAUTH_RECONNECT_REQUIRED'
    );
  }

  const clientId = getEffectiveGoogleClientId();
  if (!clientId || !GOOGLE_CLIENT_SECRET) {
    throw new HttpError(
      503,
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required to refresh Google OAuth tokens.',
      'GOOGLE_OAUTH_UNCONFIGURED'
    );
  }

  const refreshToken = decryptTokenValue(stored.encryptedRefreshToken);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const data = (await response.json()) as Record<string, any>;
  if (!response.ok || !data.access_token) {
    throw new HttpError(
      401,
      data.error_description || data.error || 'Failed to refresh Google OAuth token. Please reconnect Google Account.',
      'GOOGLE_OAUTH_REFRESH_FAILED'
    );
  }

  const updated: GoogleAuthTokens = {
    ...stored,
    encryptedAccessToken: encryptTokenValue(String(data.access_token)),
    tokenExpiry: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    updatedAt: new Date().toISOString(),
  };

  await googleAuthRepo.saveTokensForWorkspace(updated);
  return String(data.access_token);
}

async function getWorkspaceGoogleAccessToken(workspaceId: string): Promise<string> {
  const stored = await googleAuthRepo.getTokensByWorkspace(workspaceId);
  if (!stored || !stored.encryptedAccessToken) {
    throw new HttpError(
      400,
      'Google Meet account is not connected for this Workspace. Please connect an authorized Google account via Google Settings first.',
      'GOOGLE_OAUTH_NOT_CONNECTED'
    );
  }

  if (stored.tokenExpiry && Date.now() > stored.tokenExpiry - 300_000) {
    if (stored.encryptedRefreshToken) {
      return await refreshWorkspaceAccessToken(workspaceId);
    }
  }

  return decryptTokenValue(stored.encryptedAccessToken);
}

async function callGoogleMeetCreateSpaceApi(
  workspaceId: string,
  delegatedAccessToken?: string
): Promise<{
  googleSpaceName: string;
  meetingUri: string;
  meetingCode: string;
}> {
  const usingDelegated = Boolean(delegatedAccessToken && delegatedAccessToken.trim().length > 0);
  let token = usingDelegated
    ? delegatedAccessToken!.trim()
    : await getWorkspaceGoogleAccessToken(workspaceId);

  const invoke = async (accessToken: string) =>
    fetch('https://meet.googleapis.com/v2/spaces', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          accessType: 'OPEN',
        },
      }),
    });

  let res = await invoke(token);
  if (res.status === 401) {
    if (usingDelegated) {
      throw new HttpError(
        401,
        'Your Google Meet authorization has expired. Please reconnect with Google to create a meeting link.',
        'GOOGLE_OAUTH_NOT_CONNECTED'
      );
    }
    token = await refreshWorkspaceAccessToken(workspaceId);
    res = await invoke(token);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new HttpError(
      res.status >= 500 ? 502 : 400,
      `Google Meet REST API v2 returned HTTP ${res.status}${errText ? `: ${errText}` : ''}`,
      'GOOGLE_MEET_API_ERROR'
    );
  }

  const data = (await res.json()) as Record<string, any>;
  if (!data.meetingUri && !data.name) {
    throw new HttpError(
      502,
      'Google Meet API response did not include a meetingUri or space name.',
      'GOOGLE_MEET_INVALID_RESPONSE'
    );
  }

  const googleSpaceName = String(data.name || '');
  const meetingCode = String(
    data.meetingCode || googleSpaceName.replace('spaces/', '') || ''
  );
  const meetingUri = String(
    data.meetingUri || `https://meet.google.com/${meetingCode}`
  );

  return { googleSpaceName, meetingUri, meetingCode };
}

// ============================================================
// CENTRALIZED MEET GENERATION WITH TRANSACTIONAL CREDIT RESERVATION
// ============================================================

export interface GenerateMeetInput {
  actor: Pick<User | SafeUser, 'id' | 'workspaceId' | 'role' | 'active'>;
  taskId: string;
  meetingTitle: string;
  description?: string;
  statusRequestIds: string[];
  invitedEmployeeIds: string[];
  scheduledAt?: string | null;
  status?: 'draft' | 'scheduled';
  idempotencyKey?: string;
  googleAccessToken?: string;
}

/**
 * Generates ONE authoritative Google Meet room for a Workspace and atomically reserves/consumes
 * ONE credit from the active 30-day Premium period (`meetCreditsUsed + meetCreditsReserved < 5`).
 */
export async function generateMeetForWorkspace(input: GenerateMeetInput): Promise<{
  meeting: Meeting;
  operation: MeetGenerationOperation;
}> {
  const { actor, taskId, statusRequestIds, invitedEmployeeIds } = input;
  const workspaceId = actor.workspaceId;

  // 1. Centralized entitlement & role gate
  const decision = await canGenerateMeet(actor, workspaceId);
  assertEntitlement(decision);

  const periodId = decision.entitlement.currentPeriodId;
  if (!periodId) {
    throw new HttpError(402, 'No active Premium billing period found for Workspace.', 'PREMIUM_REQUIRED');
  }

  // Verify either a delegated Google Meet access token or stored Workspace OAuth token exists BEFORE reserving credit
  const delegatedToken = input.googleAccessToken?.trim() || undefined;
  if (!delegatedToken) {
    await getWorkspaceGoogleAccessToken(workspaceId);
  }

  const opId = newId();
  const idempotencyKey = input.idempotencyKey || opId;
  const nowIso = new Date().toISOString();

  // 2. Atomic Firestore Transaction: reserve 1 credit (`meetCreditsUsed + meetCreditsReserved < limit`)
  const operation = await runFirestoreTransaction(async (tx, db) => {
    // Check idempotency if caller provided a key
    if (input.idempotencyKey) {
      const existingOpSnap = await tx.get(
        db
          .collection('meetGenerationOperations')
          .where('workspaceId', '==', workspaceId)
          .where('idempotencyKey', '==', input.idempotencyKey)
      );
      if (!existingOpSnap.empty) {
        const existingOp = existingOpSnap.docs[0].data() as MeetGenerationOperation;
        if (existingOp.operationStatus === 'SUCCESS' && existingOp.meetingId) {
          return existingOp;
        }
        if (existingOp.operationStatus === 'RESERVED') {
          throw new HttpError(
            409,
            'A Google Meet generation request with this idempotency key is already in progress.',
            'MEET_OP_IN_PROGRESS'
          );
        }
      }
    }

    const periodRef = db.collection('subscriptionPeriods').doc(periodId);
    const usageRef = db.collection('subscriptionUsage').doc(periodId);
    const [periodSnap, usageSnap] = await Promise.all([tx.get(periodRef), tx.get(usageRef)]);

    if (!periodSnap.exists) {
      throw new HttpError(402, 'Active Premium period record not found.', 'PERIOD_NOT_FOUND');
    }

    const periodData = periodSnap.data() as SubscriptionPeriod;
    const usageData = usageSnap.exists ? (usageSnap.data() as SubscriptionUsage) : null;

    const used = usageData ? usageData.meetCreditsUsed : periodData.meetCreditsUsed;
    const reserved = usageData ? usageData.meetCreditsReserved : periodData.meetCreditsReserved;
    const limit = periodData.meetCreditLimit || PREMIUM_MEET_CREDIT_LIMIT;

    if (used + reserved >= limit) {
      throw new HttpError(
        402,
        `Workspace has reached its limit of ${limit} Google Meet generations for the current 30-day period.`,
        'MEET_CREDITS_EXHAUSTED'
      );
    }

    tx.set(periodRef, { meetCreditsReserved: reserved + 1 }, { merge: true });
    if (usageSnap.exists) {
      tx.set(usageRef, { meetCreditsReserved: reserved + 1, updatedAt: nowIso }, { merge: true });
    }

    const opDoc: MeetGenerationOperation = {
      id: opId,
      workspaceId,
      periodId,
      requestedBy: actor.id,
      idempotencyKey,
      operationStatus: 'RESERVED',
      meetingId: null,
      providerMeetingId: null,
      reservedAt: nowIso,
      completedAt: null,
      failureReason: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    tx.set(db.collection('meetGenerationOperations').doc(opId), opDoc);
    return opDoc;
  }, 'reserveMeetCredit');

  // If idempotent replay already succeeded, return existing meeting
  if (operation.operationStatus === 'SUCCESS' && operation.meetingId) {
    const existingMeeting = await meetingRepo.findByIdInWorkspace(operation.meetingId, workspaceId);
    if (existingMeeting) {
      return { meeting: existingMeeting, operation };
    }
  }

  // 3. Call official Google Meet REST API v2 outside transaction
  let spaceResult: { googleSpaceName: string; meetingUri: string; meetingCode: string };
  try {
    spaceResult = await callGoogleMeetCreateSpaceApi(workspaceId, delegatedToken);
  } catch (apiErr) {
    // 4a. Permanent provider failure -> release reserved credit atomically
    const failIso = new Date().toISOString();
    const reason = apiErr instanceof Error ? apiErr.message : 'Google Meet API failure';

    await runFirestoreTransaction(async (tx, db) => {
      const periodRef = db.collection('subscriptionPeriods').doc(periodId);
      const usageRef = db.collection('subscriptionUsage').doc(periodId);
      const opRef = db.collection('meetGenerationOperations').doc(operation.id);
      const [periodSnap, usageSnap] = await Promise.all([tx.get(periodRef), tx.get(usageRef)]);

      if (periodSnap.exists) {
        const p = periodSnap.data() as SubscriptionPeriod;
        tx.set(
          periodRef,
          { meetCreditsReserved: Math.max(0, (p.meetCreditsReserved || 0) - 1) },
          { merge: true }
        );
      }
      if (usageSnap.exists) {
        const u = usageSnap.data() as SubscriptionUsage;
        tx.set(
          usageRef,
          {
            meetCreditsReserved: Math.max(0, (u.meetCreditsReserved || 0) - 1),
            updatedAt: failIso,
          },
          { merge: true }
        );
      }
      tx.set(
        opRef,
        {
          operationStatus: 'FAILED',
          completedAt: failIso,
          failureReason: reason,
          updatedAt: failIso,
        },
        { merge: true }
      );
    }, 'releaseMeetCreditOnFailure');

    await auditRepo.create({
      workspaceId,
      actorUserId: actor.id,
      entityType: 'meeting',
      entityId: operation.id,
      eventType: 'MEET_GENERATION_FAILED',
      previousState: 'RESERVED',
      newState: 'FAILED',
      message: `Google Meet generation failed and reserved credit was released: ${reason}`,
      createdAt: failIso,
    });

    throw apiErr;
  }

  // 4b. Provider succeeded -> atomically convert reservation into 1 consumed credit & persist meeting
  const doneIso = new Date().toISOString();
  const meetingId = newId();
  const meetingStatus = input.status || (input.scheduledAt ? 'scheduled' : 'draft');

  const newMeeting: Meeting = {
    id: meetingId,
    workspaceId,
    statusRequestId: statusRequestIds[0] || '',
    taskId,
    createdByAdminUid: actor.id,
    invitedEmployeeIds: [...new Set(invitedEmployeeIds)],
    provider: 'GOOGLE_MEET',
    googleSpaceName: spaceResult.googleSpaceName,
    meetingUri: spaceResult.meetingUri,
    meetingTitle: input.meetingTitle,
    description: input.description || '',
    status: meetingStatus,
    scheduledAt: input.scheduledAt ?? null,
    publishedAt: meetingStatus === 'scheduled' ? doneIso : null,
    timezone: 'Asia/Kolkata',
    createdAt: doneIso,
    updatedAt: doneIso,
    cancelledAt: null,
  };

  try {
    const finalizedOp = await runFirestoreTransaction(async (tx, db) => {
      const periodRef = db.collection('subscriptionPeriods').doc(periodId);
      const usageRef = db.collection('subscriptionUsage').doc(periodId);
      const opRef = db.collection('meetGenerationOperations').doc(operation.id);
      const [periodSnap, usageSnap] = await Promise.all([tx.get(periodRef), tx.get(usageRef)]);

      if (periodSnap.exists) {
        const p = periodSnap.data() as SubscriptionPeriod;
        tx.set(
          periodRef,
          {
            meetCreditsUsed: (p.meetCreditsUsed || 0) + 1,
            meetCreditsReserved: Math.max(0, (p.meetCreditsReserved || 0) - 1),
          },
          { merge: true }
        );
      }
      if (usageSnap.exists) {
        const u = usageSnap.data() as SubscriptionUsage;
        tx.set(
          usageRef,
          {
            meetCreditsUsed: (u.meetCreditsUsed || 0) + 1,
            meetCreditsReserved: Math.max(0, (u.meetCreditsReserved || 0) - 1),
            updatedAt: doneIso,
          },
          { merge: true }
        );
      }

      tx.set(db.collection('meetings').doc(meetingId), newMeeting);

      const completedOp: MeetGenerationOperation = {
        ...operation,
        operationStatus: 'SUCCESS',
        meetingId,
        providerMeetingId: spaceResult.googleSpaceName || spaceResult.meetingCode,
        completedAt: doneIso,
        updatedAt: doneIso,
      };
      tx.set(opRef, completedOp);
      return completedOp;
    }, 'commitMeetSuccess');

    await auditRepo.create({
      workspaceId,
      actorUserId: actor.id,
      entityType: 'meeting',
      entityId: meetingId,
      eventType: 'MEET_CREATED',
      previousState: 'RESERVED',
      newState: 'SUCCESS',
      message: `Genuine Google Meet space created via Google Meet API (${newMeeting.meetingUri}). One Workspace Meet credit consumed.`,
      metadata: {
        periodId,
        operationId: operation.id,
        providerMeetingId: spaceResult.googleSpaceName,
      },
      createdAt: doneIso,
    });

    return { meeting: newMeeting, operation: finalizedOp };
  } catch (commitErr) {
    // Provider succeeded, commit failed -> mark operation RECONCILIATION_REQUIRED without silently dropping
    try {
      const errMsg = commitErr instanceof Error ? commitErr.message : 'Commit failure after space creation';
      await runFirestoreTransaction(async (tx, db) => {
        tx.set(
          db.collection('meetGenerationOperations').doc(operation.id),
          {
            operationStatus: 'RECONCILIATION_REQUIRED',
            providerMeetingId: spaceResult.googleSpaceName || spaceResult.meetingCode,
            failureReason: errMsg,
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      }, 'markMeetReconciliationRequired');
    } catch {
      // preserve original error
    }
    throw commitErr;
  }
}

export async function getWorkspaceGoogleStatus(workspaceId: string) {
  const stored = await googleAuthRepo.getTokensByWorkspace(workspaceId);
  const hasClientId = Boolean(getEffectiveGoogleClientId());
  const hasClientSecret = Boolean(GOOGLE_CLIENT_SECRET);
  const isEncryptionConfigured = Boolean(
    OAUTH_TOKEN_ENCRYPTION_KEY && OAUTH_TOKEN_ENCRYPTION_KEY.trim().length >= 16
  );
  return {
    isConnected: Boolean(stored && stored.encryptedAccessToken),
    connectedEmail: stored?.email || null,
    hasClientId,
    hasClientSecret,
    isEncryptionConfigured,
    hasOAuthConfig: hasClientId && hasClientSecret,
    hasEncryptionKey: isEncryptionConfigured,
    updatedAt: stored?.updatedAt || null,
  };
}
