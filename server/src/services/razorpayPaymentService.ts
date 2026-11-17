// ============================================================
// RAZORPAY PAYMENT SERVICE (PART 8)
// - Server-authoritative configurable pricing (INR)
// - Pending payment record creation + Razorpay Order API
// - HMAC-SHA256 Checkout signature verification (timingSafeEqual)
// - Raw-body Webhook signature verification + idempotent event handling
// - Never trusts client-provided amount or activates without verified payment
// ============================================================

import crypto from 'crypto';
import {
  PREMIUM_PLAN_AMOUNT,
  PREMIUM_PLAN_CURRENCY,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
} from '../config.js';
import { runFirestoreTransaction } from '../firebase.js';
import { HttpError } from '../middleware/errorHandler.js';
import {
  auditRepo,
  newId,
  paymentEventRepo,
  paymentRepo,
} from '../repositories/firestoreRepository.js';
import { activatePremiumPeriodInTransaction } from './subscriptionEntitlementService.js';
import type { Payment, PaymentEvent, SafeUser, User } from '../types/index.js';

export function getRazorpayConfigStatus() {
  return {
    gateway: 'RAZORPAY' as const,
    isGatewayConfigured: Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET),
    isWebhookConfigured: Boolean(RAZORPAY_WEBHOOK_SECRET),
    isPricingConfigured: PREMIUM_PLAN_AMOUNT !== null,
    keyId: RAZORPAY_KEY_ID || null,
    amount: PREMIUM_PLAN_AMOUNT,
    currency: PREMIUM_PLAN_CURRENCY,
  };
}

function timingSafeHexEquals(expectedHex: string, actualHex: string): boolean {
  const a = Buffer.from(expectedHex, 'utf8');
  const b = Buffer.from(actualHex, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Step 1-3: Creates a pending payment record & Razorpay Order using backend-configured pricing.
 */
export async function createPremiumOrder(params: {
  actor: Pick<User | SafeUser, 'id' | 'workspaceId' | 'role' | 'active'>;
  idempotencyKey?: string;
}) {
  const { actor } = params;
  if (!actor.active || actor.role !== 'admin') {
    throw new HttpError(403, 'Only an active Workspace Administrator can initiate a subscription purchase.', 'ADMIN_ONLY');
  }

  if (!PREMIUM_PLAN_AMOUNT) {
    throw new HttpError(
      503,
      'PREMIUM_PLAN_AMOUNT is not configured on the backend server. Subscription pricing must be configured via environment variables before orders can be created.',
      'PRICING_NOT_CONFIGURED'
    );
  }

  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    throw new HttpError(
      503,
      'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not configured on the backend server.',
      'RAZORPAY_NOT_CONFIGURED'
    );
  }

  const paymentId = newId();
  const idempotencyKey = params.idempotencyKey || paymentId;
  const authBasic = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');

  // Create official Razorpay Order
  const razorpayRes = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authBasic}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: PREMIUM_PLAN_AMOUNT, // smallest currency unit (paise for INR) configured on server
      currency: PREMIUM_PLAN_CURRENCY,
      receipt: `tf_${actor.workspaceId.slice(0, 12)}_${paymentId.slice(0, 8)}`,
      notes: {
        workspaceId: actor.workspaceId,
        paymentId,
        initiatedByUid: actor.id,
        plan: 'PREMIUM',
      },
    }),
  });

  const orderData = (await razorpayRes.json()) as Record<string, any>;
  if (!razorpayRes.ok || !orderData.id) {
    throw new HttpError(
      502,
      orderData?.error?.description || 'Failed to create Razorpay order',
      'RAZORPAY_ORDER_FAILED'
    );
  }

  const nowIso = new Date().toISOString();
  const paymentRecord: Payment = {
    id: paymentId,
    workspaceId: actor.workspaceId,
    subscriptionId: actor.workspaceId,
    periodId: null,
    gateway: 'RAZORPAY',
    gatewayOrderId: String(orderData.id),
    gatewayPaymentId: null,
    amount: PREMIUM_PLAN_AMOUNT,
    currency: PREMIUM_PLAN_CURRENCY,
    status: 'PENDING',
    idempotencyKey,
    initiatedByUid: actor.id,
    paidAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await paymentRepo.set(paymentRecord);

  return {
    payment: paymentRecord,
    razorpayOrder: {
      id: String(orderData.id),
      amount: PREMIUM_PLAN_AMOUNT,
      currency: PREMIUM_PLAN_CURRENCY,
      keyId: RAZORPAY_KEY_ID,
    },
  };
}

/**
 * Step 5-6: Verifies Razorpay Checkout signature independently on backend
 * and atomically activates the 30-day Premium period (idempotently).
 */
export async function verifyCheckoutPayment(params: {
  actor: Pick<User | SafeUser, 'id' | 'workspaceId' | 'role' | 'active'>;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}) {
  const { actor, razorpayOrderId, razorpayPaymentId, razorpaySignature } = params;
  if (!actor.active || actor.role !== 'admin') {
    throw new HttpError(403, 'Only an active Workspace Administrator can verify subscription payments.', 'ADMIN_ONLY');
  }
  if (!RAZORPAY_KEY_SECRET) {
    throw new HttpError(503, 'RAZORPAY_KEY_SECRET is not configured.', 'RAZORPAY_NOT_CONFIGURED');
  }

  const payment = await paymentRepo.findByGatewayOrderId(razorpayOrderId);
  if (!payment || payment.workspaceId !== actor.workspaceId) {
    throw new HttpError(404, 'Pending payment order not found for this workspace.', 'PAYMENT_NOT_FOUND');
  }

  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (!timingSafeHexEquals(expectedSignature, razorpaySignature)) {
    await paymentEventRepo.set({
      id: `checkout_${razorpayPaymentId}`,
      workspaceId: payment.workspaceId,
      paymentId: payment.id,
      gateway: 'RAZORPAY',
      gatewayEventId: `checkout_${razorpayPaymentId}`,
      eventType: 'CHECKOUT_VERIFICATION',
      verificationStatus: 'REJECTED',
      receivedAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      metadata: { reason: 'HMAC_MISMATCH', razorpayOrderId, razorpayPaymentId },
    });
    throw new HttpError(400, 'Razorpay payment signature verification failed.', 'INVALID_PAYMENT_SIGNATURE');
  }

  return finalizeVerifiedPayment({
    paymentId: payment.id,
    gatewayPaymentId: razorpayPaymentId,
    gatewayEventId: `checkout_${razorpayPaymentId}`,
    eventType: 'CHECKOUT_VERIFIED',
    actorUid: actor.id,
  });
}

/**
 * Step 7-10: Verifies Razorpay webhook using raw request body + x-razorpay-signature
 * and processes the event idempotently even if browser was closed.
 */
export async function processRazorpayWebhook(params: {
  rawBody: Buffer | string;
  signatureHeader: string;
  eventIdHeader?: string;
}) {
  if (!RAZORPAY_WEBHOOK_SECRET) {
    throw new HttpError(503, 'RAZORPAY_WEBHOOK_SECRET is not configured.', 'WEBHOOK_NOT_CONFIGURED');
  }

  const expectedSig = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(params.rawBody)
    .digest('hex');

  if (!params.signatureHeader || !timingSafeHexEquals(expectedSig, params.signatureHeader)) {
    throw new HttpError(400, 'Invalid Razorpay webhook signature.', 'INVALID_WEBHOOK_SIGNATURE');
  }

  const rawStr = Buffer.isBuffer(params.rawBody)
    ? params.rawBody.toString('utf8')
    : params.rawBody;
  const payload = JSON.parse(rawStr) as Record<string, any>;
  const eventType = String(payload.event || '');
  const paymentEntity = payload?.payload?.payment?.entity || {};
  const orderEntity = payload?.payload?.order?.entity || {};

  const gatewayOrderId = String(paymentEntity.order_id || orderEntity.id || '');
  const gatewayPaymentId = String(paymentEntity.id || '');
  const gatewayEventId =
    params.eventIdHeader ||
    `wh_${eventType}_${gatewayPaymentId || gatewayOrderId || crypto.createHash('sha256').update(rawStr).digest('hex').slice(0, 16)}`;

  // Idempotency check before processing
  const existingEvent = await paymentEventRepo.findByGatewayEventId(gatewayEventId);
  if (existingEvent) {
    return { alreadyProcessed: true, event: existingEvent };
  }

  if (!gatewayOrderId) {
    return { ignored: true, reason: 'No gateway order ID in webhook payload' };
  }

  const payment = await paymentRepo.findByGatewayOrderId(gatewayOrderId);
  if (!payment) {
    return { ignored: true, reason: 'Order not matched to a pending TaskFlow payment' };
  }

  if (eventType === 'payment.captured' || eventType === 'order.paid') {
    const result = await finalizeVerifiedPayment({
      paymentId: payment.id,
      gatewayPaymentId,
      gatewayEventId,
      eventType,
      actorUid: payment.initiatedByUid,
    });
    return { processed: true, ...result };
  }

  if (eventType === 'payment.failed') {
    const nowIso = new Date().toISOString();
    await paymentRepo.update(payment.id, { status: 'FAILED' });
    const ev: PaymentEvent = {
      id: gatewayEventId,
      workspaceId: payment.workspaceId,
      paymentId: payment.id,
      gateway: 'RAZORPAY',
      gatewayEventId,
      eventType,
      verificationStatus: 'VERIFIED',
      receivedAt: nowIso,
      processedAt: nowIso,
      metadata: { gatewayOrderId, gatewayPaymentId },
    };
    await paymentEventRepo.set(ev);
    return { processed: true, status: 'FAILED', event: ev };
  }

  return { ignored: true, eventType };
}

async function finalizeVerifiedPayment(params: {
  paymentId: string;
  gatewayPaymentId: string;
  gatewayEventId: string;
  eventType: string;
  actorUid: string;
}) {
  const verifiedAtMs = Date.now();
  const verifiedAtIso = new Date(verifiedAtMs).toISOString();

  const outcome = await runFirestoreTransaction(async (tx, db) => {
    const paymentRef = db.collection('payments').doc(params.paymentId);
    const eventRef = db.collection('paymentEvents').doc(params.gatewayEventId);
    const [paymentSnap, eventSnap] = await Promise.all([tx.get(paymentRef), tx.get(eventRef)]);

    if (!paymentSnap.exists) {
      throw new HttpError(404, 'Payment record not found.', 'PAYMENT_NOT_FOUND');
    }

    const payment = paymentSnap.data() as Payment;

    // Strict idempotency: if payment already VERIFIED or event already recorded, return cleanly without creating another period
    if (payment.status === 'VERIFIED' || eventSnap.exists) {
      return {
        alreadyVerified: true,
        payment,
        periodId: payment.periodId,
      };
    }

    const { period } = await activatePremiumPeriodInTransaction({
      tx,
      db,
      workspaceId: payment.workspaceId,
      paymentId: payment.id,
      verifiedAtMs,
    });

    const updatedPayment: Payment = {
      ...payment,
      status: 'VERIFIED',
      periodId: period.id,
      gatewayPaymentId: params.gatewayPaymentId || payment.gatewayPaymentId,
      paidAt: verifiedAtIso,
      updatedAt: verifiedAtIso,
    };

    const paymentEvent: PaymentEvent = {
      id: params.gatewayEventId,
      workspaceId: payment.workspaceId,
      paymentId: payment.id,
      gateway: 'RAZORPAY',
      gatewayEventId: params.gatewayEventId,
      eventType: params.eventType,
      verificationStatus: 'VERIFIED',
      receivedAt: verifiedAtIso,
      processedAt: verifiedAtIso,
      metadata: {
        gatewayOrderId: payment.gatewayOrderId,
        gatewayPaymentId: params.gatewayPaymentId,
        periodId: period.id,
      },
    };

    tx.set(paymentRef, updatedPayment);
    tx.set(eventRef, paymentEvent);

    return {
      alreadyVerified: false,
      payment: updatedPayment,
      period,
    };
  }, 'finalizeVerifiedPayment');

  if (!outcome.alreadyVerified) {
    await auditRepo.create({
      workspaceId: outcome.payment.workspaceId,
      actorUserId: params.actorUid,
      entityType: 'payment',
      entityId: outcome.payment.id,
      eventType: 'PAYMENT_VERIFIED',
      previousState: 'PENDING',
      newState: 'VERIFIED',
      message: `Razorpay payment ${outcome.payment.gatewayPaymentId || outcome.payment.gatewayOrderId} verified and 30-day Premium period activated.`,
      createdAt: verifiedAtIso,
    });
  }

  return outcome;
}
