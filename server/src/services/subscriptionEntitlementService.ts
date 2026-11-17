// ============================================================
// CENTRALIZED SUBSCRIPTION & ENTITLEMENT ENGINE (PARTS 5 & 9)
// Authoritative server-side plan evaluation, 30-day calculations,
// renewal stacking, expiration handling, and Meet credit status.
// ============================================================

import {
  PREMIUM_MEET_CREDIT_LIMIT,
  PREMIUM_PERIOD_DURATION_MS,
  PREMIUM_PERIOD_DURATION_SECONDS,
} from '../config.js';
import { runFirestoreTransaction } from '../firebase.js';
import { HttpError } from '../middleware/errorHandler.js';
import {
  subscriptionRepo,
  subscriptionPeriodRepo,
  subscriptionUsageRepo,
  subscriptionEventRepo,
  newId,
} from '../repositories/firestoreRepository.js';
import type {
  EntitlementSummary,
  SafeUser,
  Subscription,
  SubscriptionPeriod,
  SubscriptionUsage,
  User,
} from '../types/index.js';

export type ActorLike = Pick<User | SafeUser, 'id' | 'workspaceId' | 'role' | 'active'>;

export interface EntitlementDecision {
  allowed: boolean;
  reason?: string;
  code?: string;
  entitlement: EntitlementSummary;
}

/**
 * Reconciles workspace subscription state against authoritative server UTC time.
 * - Rolls over to a pre-purchased SCHEDULED renewal period if the current period expired and a scheduled one starts.
 * - Marks PREMIUM subscription EXPIRED when currentPeriodEnd <= server now and no scheduled renewal covers now.
 */
export async function reconcileAndGetEntitlement(
  workspaceId: string
): Promise<EntitlementSummary> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  let sub = await subscriptionRepo.findByWorkspace(workspaceId);
  if (!sub) {
    // Initialize default FREE subscription if workspace exists without one
    sub = {
      id: workspaceId,
      workspaceId,
      plan: 'FREE',
      status: 'ACTIVE',
      currentPeriodId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      autoRenew: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await subscriptionRepo.set(sub);
  }

  let currentPeriod: SubscriptionPeriod | null = sub.currentPeriodId
    ? await subscriptionPeriodRepo.findById(sub.currentPeriodId)
    : null;
  let usage: SubscriptionUsage | null = currentPeriod
    ? await subscriptionUsageRepo.findByPeriodId(currentPeriod.id)
    : null;

  // Check expiration or rollover for PREMIUM subscriptions
  if (sub.plan === 'PREMIUM' && sub.status === 'ACTIVE') {
    const currentEndMs = sub.currentPeriodEnd ? Date.parse(sub.currentPeriodEnd) : 0;

    if (currentEndMs > 0 && nowMs >= currentEndMs) {
      // Check if an early renewal SCHEDULED period covers now
      const allPeriods = await subscriptionPeriodRepo.findByWorkspace(workspaceId);
      const activeOrNext = allPeriods.find((p) => {
        if (p.plan !== 'PREMIUM') return false;
        const startMs = Date.parse(p.startAt);
        const endMs = p.endAt ? Date.parse(p.endAt) : 0;
        return startMs <= nowMs && nowMs < endMs && p.status !== 'CANCELLED';
      });

      if (activeOrNext) {
        await runFirestoreTransaction(async (tx, db) => {
          if (currentPeriod && currentPeriod.id !== activeOrNext.id && currentPeriod.status === 'ACTIVE') {
            tx.set(
              db.collection('subscriptionPeriods').doc(currentPeriod.id),
              { status: 'EXPIRED' },
              { merge: true }
            );
          }
          tx.set(
            db.collection('subscriptionPeriods').doc(activeOrNext.id),
            { status: 'ACTIVE' },
            { merge: true }
          );
          tx.set(
            db.collection('subscriptions').doc(sub!.id),
            {
              status: 'ACTIVE',
              currentPeriodId: activeOrNext.id,
              currentPeriodStart: activeOrNext.startAt,
              currentPeriodEnd: activeOrNext.endAt,
              updatedAt: nowIso,
            },
            { merge: true }
          );
          const evId = newId();
          tx.set(db.collection('subscriptionEvents').doc(evId), {
            id: evId,
            workspaceId,
            subscriptionId: sub!.id,
            periodId: activeOrNext.id,
            eventType: 'SCHEDULED_PERIOD_ROLLED_OVER',
            previousStatus: 'ACTIVE',
            newStatus: 'ACTIVE',
            paymentId: activeOrNext.paymentId,
            metadata: { previousPeriodId: currentPeriod?.id || null },
            createdAt: nowIso,
          });
        }, 'rolloverScheduledPeriod');

        sub = (await subscriptionRepo.findByWorkspace(workspaceId)) || sub;
        currentPeriod = await subscriptionPeriodRepo.findById(activeOrNext.id);
        usage = await subscriptionUsageRepo.findByPeriodId(activeOrNext.id);
      } else {
        // Mark expired cleanly on server
        await runFirestoreTransaction(async (tx, db) => {
          tx.set(
            db.collection('subscriptions').doc(sub!.id),
            { status: 'EXPIRED', updatedAt: nowIso },
            { merge: true }
          );
          if (currentPeriod && currentPeriod.status === 'ACTIVE') {
            tx.set(
              db.collection('subscriptionPeriods').doc(currentPeriod.id),
              { status: 'EXPIRED' },
              { merge: true }
            );
          }
          const evId = newId();
          tx.set(db.collection('subscriptionEvents').doc(evId), {
            id: evId,
            workspaceId,
            subscriptionId: sub!.id,
            periodId: currentPeriod?.id || null,
            eventType: 'PERIOD_EXPIRED',
            previousStatus: 'ACTIVE',
            newStatus: 'EXPIRED',
            paymentId: null,
            metadata: { expiredAt: nowIso },
            createdAt: nowIso,
          });
        }, 'expirePremiumSubscription');

        sub = { ...sub, status: 'EXPIRED', updatedAt: nowIso };
      }
    }
  }

  const periodEndMs = sub.currentPeriodEnd ? Date.parse(sub.currentPeriodEnd) : 0;
  const isPremiumActive =
    sub.plan === 'PREMIUM' &&
    sub.status === 'ACTIVE' &&
    Boolean(sub.currentPeriodId) &&
    periodEndMs > nowMs;

  const meetCreditLimit = isPremiumActive
    ? currentPeriod?.meetCreditLimit ?? PREMIUM_MEET_CREDIT_LIMIT
    : 0;
  const meetCreditsUsed = isPremiumActive
    ? usage?.meetCreditsUsed ?? currentPeriod?.meetCreditsUsed ?? 0
    : 0;
  const meetCreditsReserved = isPremiumActive
    ? usage?.meetCreditsReserved ?? currentPeriod?.meetCreditsReserved ?? 0
    : 0;
  const meetCreditsRemaining = isPremiumActive
    ? Math.max(0, meetCreditLimit - (meetCreditsUsed + meetCreditsReserved))
    : 0;
  const statusQueriesUsed = usage?.statusQueriesUsed ?? 0;

  return {
    workspaceId,
    plan: sub.plan,
    status: sub.status,
    isPremiumActive,
    currentPeriodId: sub.currentPeriodId,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    meetCreditLimit,
    meetCreditsUsed,
    meetCreditsReserved,
    meetCreditsRemaining,
    statusQueriesUsed,
    capabilities: {
      canCreateStatusRequest: isPremiumActive,
      canRespondToStatusRequest: isPremiumActive,
      canUseStatusQueries: isPremiumActive,
      canGenerateMeet: isPremiumActive && meetCreditsRemaining > 0,
      canJoinPremiumMeeting: isPremiumActive,
      canManageSubscription: false,
    },
    serverTimeUtc: nowIso,
  };
}

export async function getEntitlementForUser(user: ActorLike): Promise<EntitlementSummary> {
  const base = await reconcileAndGetEntitlement(user.workspaceId);
  const isAdmin = user.role === 'admin';
  const isActiveUser = Boolean(user.active);

  return {
    ...base,
    capabilities: {
      canCreateStatusRequest: isActiveUser && isAdmin && base.isPremiumActive,
      canRespondToStatusRequest: isActiveUser && base.isPremiumActive,
      canUseStatusQueries: isActiveUser && base.isPremiumActive,
      canGenerateMeet: isActiveUser && isAdmin && base.isPremiumActive && base.meetCreditsRemaining > 0,
      canJoinPremiumMeeting: isActiveUser && base.isPremiumActive,
      canManageSubscription: isActiveUser && isAdmin,
    },
  };
}

function buildDenied(
  entitlement: EntitlementSummary,
  reason: string,
  code: string
): EntitlementDecision {
  return { allowed: false, reason, code, entitlement };
}

export async function canCreateStatusRequest(
  user: ActorLike,
  workspaceId: string
): Promise<EntitlementDecision> {
  const entitlement = await getEntitlementForUser({ ...user, workspaceId });
  if (!user.active || user.workspaceId !== workspaceId) {
    return buildDenied(entitlement, 'Workspace membership is inactive or unauthorized.', 'WORKSPACE_ACCESS_DENIED');
  }
  if (user.role !== 'admin') {
    return buildDenied(entitlement, 'Only Workspace Administrators can create Status Requests.', 'ADMIN_ONLY');
  }
  if (!entitlement.isPremiumActive) {
    return buildDenied(
      entitlement,
      'Status Requests require an active Premium subscription for your Workspace.',
      'PREMIUM_REQUIRED'
    );
  }
  return { allowed: true, entitlement };
}

export async function canRespondToStatusRequest(
  user: ActorLike,
  workspaceId: string
): Promise<EntitlementDecision> {
  const entitlement = await getEntitlementForUser({ ...user, workspaceId });
  if (!user.active || user.workspaceId !== workspaceId) {
    return buildDenied(entitlement, 'Workspace membership is inactive or unauthorized.', 'WORKSPACE_ACCESS_DENIED');
  }
  if (!entitlement.isPremiumActive) {
    return buildDenied(
      entitlement,
      'Responding to Status Requests requires an active Premium subscription for your Workspace.',
      'PREMIUM_REQUIRED'
    );
  }
  return { allowed: true, entitlement };
}

export async function canUseStatusQueries(
  user: ActorLike,
  workspaceId: string
): Promise<EntitlementDecision> {
  const entitlement = await getEntitlementForUser({ ...user, workspaceId });
  if (!user.active || user.workspaceId !== workspaceId) {
    return buildDenied(entitlement, 'Workspace membership is inactive or unauthorized.', 'WORKSPACE_ACCESS_DENIED');
  }
  if (!entitlement.isPremiumActive) {
    return buildDenied(
      entitlement,
      'Status Queries require an active Premium subscription for your Workspace.',
      'PREMIUM_REQUIRED'
    );
  }
  return { allowed: true, entitlement };
}

export async function canGenerateMeet(
  user: ActorLike,
  workspaceId: string
): Promise<EntitlementDecision> {
  const entitlement = await getEntitlementForUser({ ...user, workspaceId });
  if (!user.active || user.workspaceId !== workspaceId) {
    return buildDenied(entitlement, 'Workspace membership is inactive or unauthorized.', 'WORKSPACE_ACCESS_DENIED');
  }
  if (user.role !== 'admin') {
    return buildDenied(entitlement, 'Only Workspace Administrators can generate Google Meet links.', 'ADMIN_ONLY');
  }
  if (!entitlement.isPremiumActive) {
    return buildDenied(
      entitlement,
      'Google Meet link generation requires an active Premium subscription for your Workspace.',
      'PREMIUM_REQUIRED'
    );
  }
  if (entitlement.meetCreditsUsed + entitlement.meetCreditsReserved >= entitlement.meetCreditLimit) {
    return buildDenied(
      entitlement,
      `Workspace has exhausted all ${entitlement.meetCreditLimit} Google Meet generation credits for the current 30-day billing period.`,
      'MEET_CREDITS_EXHAUSTED'
    );
  }
  return { allowed: true, entitlement };
}

export async function canJoinPremiumMeeting(
  user: ActorLike,
  workspaceId: string
): Promise<EntitlementDecision> {
  const entitlement = await getEntitlementForUser({ ...user, workspaceId });
  if (!user.active || user.workspaceId !== workspaceId) {
    return buildDenied(entitlement, 'Workspace membership is inactive or unauthorized.', 'WORKSPACE_ACCESS_DENIED');
  }
  if (!entitlement.isPremiumActive) {
    return buildDenied(
      entitlement,
      'Accessing TaskFlow-generated Google Meet rooms requires an active Premium subscription for your Workspace.',
      'PREMIUM_REQUIRED'
    );
  }
  return { allowed: true, entitlement };
}

export function assertEntitlement(decision: EntitlementDecision): void {
  if (!decision.allowed) {
    const status = decision.code === 'ADMIN_ONLY' || decision.code === 'WORKSPACE_ACCESS_DENIED' ? 403 : 402;
    throw new HttpError(status, decision.reason || 'Subscription entitlement denied', decision.code);
  }
}

export async function trackStatusQueryUsage(workspaceId: string): Promise<void> {
  const entitlement = await reconcileAndGetEntitlement(workspaceId);
  if (entitlement.isPremiumActive && entitlement.currentPeriodId) {
    await subscriptionUsageRepo.incrementStatusQueries(entitlement.currentPeriodId);
  }
}

/**
 * Atomically activates a 30-day (2,592,000 seconds) Premium period inside an existing Firestore transaction
 * after payment signature / webhook verification succeeds.
 */
export async function activatePremiumPeriodInTransaction(params: {
  tx: FirebaseFirestore.Transaction;
  db: FirebaseFirestore.Firestore;
  workspaceId: string;
  paymentId: string;
  verifiedAtMs: number;
}): Promise<{ period: SubscriptionPeriod; subscription: Subscription }> {
  const { tx, db, workspaceId, paymentId, verifiedAtMs } = params;
  const nowIso = new Date(verifiedAtMs).toISOString();

  const subRef = db.collection('subscriptions').doc(workspaceId);
  const subSnap = await tx.get(subRef);

  const periodsQuery = await tx.get(
    db.collection('subscriptionPeriods').where('workspaceId', '==', workspaceId)
  );
  const existingPeriods = periodsQuery.docs
    .map((d) => d.data() as SubscriptionPeriod)
    .sort((a, b) => a.periodNumber - b.periodNumber);

  const lastPeriod = existingPeriods[existingPeriods.length - 1] || null;
  const nextPeriodNumber = lastPeriod ? lastPeriod.periodNumber + 1 : 1;

  const existingSub: Subscription = subSnap.exists
    ? (subSnap.data() as Subscription)
    : {
        id: workspaceId,
        workspaceId,
        plan: 'FREE',
        status: 'ACTIVE',
        currentPeriodId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        autoRenew: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

  // Determine startAt:
  // - Early renewal: if an active or scheduled premium period ends strictly in the future, chain seamlessly from the latest future endAt!
  // - Initial purchase or late renewal: start at verifiedAtMs (do NOT backdate).
  let latestFutureEndMs = 0;
  for (const p of existingPeriods) {
    if (p.plan === 'PREMIUM' && p.status !== 'CANCELLED' && p.endAt) {
      const endMs = Date.parse(p.endAt);
      if (endMs > verifiedAtMs && endMs > latestFutureEndMs) {
        latestFutureEndMs = endMs;
      }
    }
  }

  const isEarlyRenewal = latestFutureEndMs > verifiedAtMs;
  const startMs = isEarlyRenewal ? latestFutureEndMs : verifiedAtMs;
  const endMs = startMs + PREMIUM_PERIOD_DURATION_MS;
  const startAt = new Date(startMs).toISOString();
  const endAt = new Date(endMs).toISOString();

  const periodId = newId();
  const periodStatus = isEarlyRenewal ? 'SCHEDULED' : 'ACTIVE';

  const newPeriod: SubscriptionPeriod = {
    id: periodId,
    workspaceId,
    subscriptionId: workspaceId,
    periodNumber: nextPeriodNumber,
    plan: 'PREMIUM',
    startAt,
    endAt,
    durationSeconds: PREMIUM_PERIOD_DURATION_SECONDS,
    paymentId,
    meetCreditLimit: PREMIUM_MEET_CREDIT_LIMIT,
    meetCreditsUsed: 0,
    meetCreditsReserved: 0,
    status: periodStatus,
    createdAt: nowIso,
  };

  const newUsage: SubscriptionUsage = {
    id: periodId,
    workspaceId,
    subscriptionId: workspaceId,
    periodId,
    statusQueriesUsed: 0,
    meetCreditsUsed: 0,
    meetCreditsReserved: 0,
    meetCreditLimit: PREMIUM_MEET_CREDIT_LIMIT,
    updatedAt: nowIso,
  };

  const updatedSub: Subscription = {
    ...existingSub,
    plan: 'PREMIUM',
    status: 'ACTIVE',
    currentPeriodId: isEarlyRenewal && existingSub.currentPeriodId ? existingSub.currentPeriodId : periodId,
    currentPeriodStart:
      isEarlyRenewal && existingSub.currentPeriodStart ? existingSub.currentPeriodStart : startAt,
    currentPeriodEnd:
      isEarlyRenewal && existingSub.currentPeriodEnd ? existingSub.currentPeriodEnd : endAt,
    updatedAt: nowIso,
  };

  tx.set(subRef, updatedSub);
  tx.set(db.collection('subscriptionPeriods').doc(periodId), newPeriod);
  tx.set(db.collection('subscriptionUsage').doc(periodId), newUsage);

  const eventId = newId();
  tx.set(db.collection('subscriptionEvents').doc(eventId), {
    id: eventId,
    workspaceId,
    subscriptionId: workspaceId,
    periodId,
    eventType: isEarlyRenewal ? 'PREMIUM_EARLY_RENEWAL_SCHEDULED' : 'PREMIUM_PERIOD_ACTIVATED',
    previousStatus: existingSub.status,
    newStatus: 'ACTIVE',
    paymentId,
    metadata: {
      startAt,
      endAt,
      durationSeconds: PREMIUM_PERIOD_DURATION_SECONDS,
      meetCreditLimit: PREMIUM_MEET_CREDIT_LIMIT,
    },
    createdAt: nowIso,
  });

  return { period: newPeriod, subscription: updatedSub };
}

export async function getSubscriptionHistory(workspaceId: string) {
  const [entitlement, periods, events] = await Promise.all([
    reconcileAndGetEntitlement(workspaceId),
    subscriptionPeriodRepo.findByWorkspace(workspaceId),
    subscriptionEventRepo.findByWorkspace(workspaceId),
  ]);
  return { entitlement, periods, events };
}
