// ============================================================
// WORKSPACE BOOTSTRAP SERVICE (PART 13)
// Idempotent, secure first-time Workspace + Admin initialization.
// Zero hardcoded admin passwords, zero dummy/fake user seeding.
// ============================================================

import bcrypt from 'bcryptjs';
import { BOOTSTRAP_SETUP_SECRET } from '../config.js';
import {
  adminAuth,
  isAdminSdkConfigured,
  runFirestoreTransaction,
  verifyFirestoreConnectivity,
} from '../firebase.js';
import { HttpError } from '../middleware/errorHandler.js';
import {
  newId,
  systemConfigRepo,
} from '../repositories/firestoreRepository.js';
import {
  createOrValidateSingleDeviceSession,
  issueSignedSessionToken,
} from './sessionService.js';
import type {
  Subscription,
  SubscriptionPeriod,
  SubscriptionUsage,
  User,
  Workspace,
} from '../types/index.js';

export async function getBootstrapStatus() {
  const connectivity = await verifyFirestoreConnectivity();
  if (!connectivity.connected) {
    return {
      initialized: false,
      requiresSetupSecret: Boolean(BOOTSTRAP_SETUP_SECRET),
      isAdminSdkConfigured,
      firestoreConnected: false,
      projectId: connectivity.projectId,
      databaseId: connectivity.databaseId,
      error: connectivity.error,
    };
  }

  try {
    const marker = await systemConfigRepo.getBootstrapMarker();
    return {
      initialized: Boolean(marker?.initialized),
      requiresSetupSecret: Boolean(BOOTSTRAP_SETUP_SECRET),
      isAdminSdkConfigured,
      firestoreConnected: true,
      projectId: connectivity.projectId,
      databaseId: connectivity.databaseId,
    };
  } catch (err) {
    return {
      initialized: false,
      requiresSetupSecret: Boolean(BOOTSTRAP_SETUP_SECRET),
      isAdminSdkConfigured,
      firestoreConnected: false,
      projectId: connectivity.projectId,
      databaseId: connectivity.databaseId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface BootstrapWorkspaceInput {
  workspaceName: string;
  adminFullName: string;
  adminEmail: string;
  adminPassword?: string;
  firebaseIdToken?: string;
  employeeId?: string;
  department?: string;
  designation?: string;
  timezone?: string;
  setupSecret?: string;
  deviceLabel?: string;
}

/**
 * Creates the initial Workspace, first Administrator, and default Free subscription atomically.
 * Protected against repeated execution by `systemConfig/bootstrap`.
 */
export async function bootstrapInitialWorkspace(input: BootstrapWorkspaceInput) {
  if (BOOTSTRAP_SETUP_SECRET) {
    if (!input.setupSecret || input.setupSecret !== BOOTSTRAP_SETUP_SECRET) {
      throw new HttpError(
        403,
        'Invalid or missing bootstrap setup secret.',
        'INVALID_BOOTSTRAP_SECRET'
      );
    }
  }

  let verifiedFirebaseUid: string | null = null;
  let verifiedEmail = input.adminEmail.trim().toLowerCase();

  if (input.firebaseIdToken) {
    if (!adminAuth) {
      throw new HttpError(503, 'Firebase Admin Auth is not configured.', 'AUTH_UNCONFIGURED');
    }
    const decoded = await adminAuth.verifyIdToken(input.firebaseIdToken);
    if (!decoded.email) {
      throw new HttpError(400, 'Google/Firebase account did not include an email address.', 'EMAIL_REQUIRED');
    }
    verifiedFirebaseUid = decoded.uid;
    verifiedEmail = decoded.email.trim().toLowerCase();
  } else {
    if (!input.adminPassword || input.adminPassword.length < 8) {
      throw new HttpError(
        400,
        'Administrator password must be at least 8 characters long.',
        'WEAK_PASSWORD'
      );
    }
  }

  const passwordHash = input.adminPassword
    ? await bcrypt.hash(input.adminPassword, 12)
    : '';

  const nowIso = new Date().toISOString();
  const workspaceId = newId();
  const adminUid = verifiedFirebaseUid || newId();
  const freePeriodId = newId();

  // If password-based setup and Firebase Auth Admin SDK is available, create Firebase Auth user
  if (!verifiedFirebaseUid && adminAuth && input.adminPassword) {
    try {
      await adminAuth.createUser({
        uid: adminUid,
        email: verifiedEmail,
        password: input.adminPassword,
        displayName: input.adminFullName.trim(),
        emailVerified: true,
      });
    } catch (authErr: any) {
      // Do not fail silently if Auth provider is disabled; log notice so Firestore onboarding still records cleanly
      console.warn(
        'Firebase Auth admin user creation notice during bootstrap:',
        authErr?.message || authErr
      );
    }
  }

  const result = await runFirestoreTransaction(async (tx, db) => {
    const markerRef = db.collection('systemConfig').doc('bootstrap');
    const markerSnap = await tx.get(markerRef);
    if (markerSnap.exists && markerSnap.data()?.initialized === true) {
      throw new HttpError(
        409,
        'TaskFlow workspace has already been initialized. Please sign in with your Administrator credentials.',
        'ALREADY_BOOTSTRAPPED'
      );
    }

    const workspace: Workspace = {
      id: workspaceId,
      name: input.workspaceName.trim(),
      ownerUid: adminUid,
      status: 'active',
      subscriptionId: workspaceId,
      timezone: input.timezone || 'Asia/Kolkata',
      onboardingStatus: 'completed',
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const adminUser: User = {
      id: adminUid,
      uid: adminUid,
      workspaceId,
      employeeId: (input.employeeId || 'ADM-001').trim(),
      fullName: input.adminFullName.trim(),
      email: verifiedEmail,
      department: (input.department || 'Administration').trim(),
      designation: (input.designation || 'Workspace Administrator').trim(),
      role: 'admin',
      active: true,
      accountStatus: 'active',
      passwordHash,
      lastLoginAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const freeSub: Subscription = {
      id: workspaceId,
      workspaceId,
      plan: 'FREE',
      status: 'ACTIVE',
      currentPeriodId: freePeriodId,
      currentPeriodStart: nowIso,
      currentPeriodEnd: null,
      autoRenew: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const freePeriod: SubscriptionPeriod = {
      id: freePeriodId,
      workspaceId,
      subscriptionId: workspaceId,
      periodNumber: 1,
      plan: 'FREE',
      startAt: nowIso,
      endAt: null,
      durationSeconds: 0,
      paymentId: null,
      meetCreditLimit: 0,
      meetCreditsUsed: 0,
      meetCreditsReserved: 0,
      status: 'ACTIVE',
      createdAt: nowIso,
    };

    const freeUsage: SubscriptionUsage = {
      id: freePeriodId,
      workspaceId,
      subscriptionId: workspaceId,
      periodId: freePeriodId,
      statusQueriesUsed: 0,
      meetCreditsUsed: 0,
      meetCreditsReserved: 0,
      meetCreditLimit: 0,
      updatedAt: nowIso,
    };

    tx.set(markerRef, {
      id: 'bootstrap',
      initialized: true,
      defaultWorkspaceId: workspaceId,
      ownerUid: adminUid,
      initializedAt: nowIso,
    });
    tx.set(db.collection('workspaces').doc(workspaceId), workspace);
    tx.set(db.collection('users').doc(adminUid), adminUser);
    tx.set(db.collection('subscriptions').doc(workspaceId), freeSub);
    tx.set(db.collection('subscriptionPeriods').doc(freePeriodId), freePeriod);
    tx.set(db.collection('subscriptionUsage').doc(freePeriodId), freeUsage);

    const subEventId = newId();
    tx.set(db.collection('subscriptionEvents').doc(subEventId), {
      id: subEventId,
      workspaceId,
      subscriptionId: workspaceId,
      periodId: freePeriodId,
      eventType: 'WORKSPACE_FREE_INITIALIZED',
      previousStatus: null,
      newStatus: 'ACTIVE',
      paymentId: null,
      metadata: { plan: 'FREE' },
      createdAt: nowIso,
    });

    const auditId = newId();
    tx.set(db.collection('auditEvents').doc(auditId), {
      id: auditId,
      workspaceId,
      actorUserId: adminUid,
      entityType: 'workspace',
      entityId: workspaceId,
      eventType: 'WORKSPACE_CREATED',
      previousState: null,
      newState: 'active',
      message: `Workspace "${workspace.name}" initialized with FREE plan and Administrator ${adminUser.fullName} (${adminUser.email}).`,
      createdAt: nowIso,
    });

    return { workspace, adminUser, freeSub };
  }, 'bootstrapInitialWorkspace');

  const activeSession = await createOrValidateSingleDeviceSession({
    uid: result.adminUser.id,
    workspaceId: result.workspace.id,
    deviceLabel: input.deviceLabel,
  });

  const token = issueSignedSessionToken({
    uid: result.adminUser.id,
    workspaceId: result.workspace.id,
    role: 'admin',
    sessionId: activeSession.sessionId,
  });

  const { passwordHash: _, ...safeUser } = result.adminUser;
  return {
    workspace: result.workspace,
    user: safeUser,
    sessionId: activeSession.sessionId,
    token,
  };
}
