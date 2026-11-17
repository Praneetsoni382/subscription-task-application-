// ============================================================
// RAZORPAY PAYMENT & WEBHOOK ROUTES
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { paymentRepo } from '../repositories/firestoreRepository.js';
import {
  createPremiumOrder,
  getRazorpayConfigStatus,
  processRazorpayWebhook,
  verifyCheckoutPayment,
} from '../services/razorpayPaymentService.js';
import { getEntitlementForUser } from '../services/subscriptionEntitlementService.js';

const router = Router();

// GET /api/payments/config (returns public Key ID and server-configured pricing status only)
router.get(
  '/config',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({
      success: true,
      data: getRazorpayConfigStatus(),
    });
  })
);

// GET /api/payments (Admin only: list workspace payments)
router.get(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const payments = await paymentRepo.findByWorkspace(req.authUser!.workspaceId);
    res.json({ success: true, data: payments });
  })
);

// POST /api/payments/razorpay/order
router.post(
  '/razorpay/order',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const schema = z.object({
      idempotencyKey: z.string().max(128).optional(),
    });
    const parse = schema.safeParse(req.body || {});
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const result = await createPremiumOrder({
      actor: req.authUser!,
      idempotencyKey: parse.data.idempotencyKey,
    });

    res.status(201).json({ success: true, data: result });
  })
);

// POST /api/payments/razorpay/verify
router.post(
  '/razorpay/verify',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const schema = z.object({
      razorpayOrderId: z.string().min(1),
      razorpayPaymentId: z.string().min(1),
      razorpaySignature: z.string().min(1),
    });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const verification = await verifyCheckoutPayment({
      actor: req.authUser!,
      razorpayOrderId: parse.data.razorpayOrderId,
      razorpayPaymentId: parse.data.razorpayPaymentId,
      razorpaySignature: parse.data.razorpaySignature,
    });

    const entitlement = await getEntitlementForUser(req.authUser!);

    res.json({
      success: true,
      data: {
        ...verification,
        entitlement,
      },
    });
  })
);

// POST /api/payments/razorpay/webhook (unauthenticated webhook with rawBody HMAC verification)
router.post(
  '/razorpay/webhook',
  asyncHandler(async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    const signatureHeader = Array.isArray(signature) ? signature[0] : signature || '';
    const eventId = req.headers['x-razorpay-event-id'];
    const eventIdHeader = Array.isArray(eventId) ? eventId[0] : eventId;

    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    const outcome = await processRazorpayWebhook({
      rawBody,
      signatureHeader,
      eventIdHeader,
    });

    res.json({ success: true, data: outcome });
  })
);

export default router;
