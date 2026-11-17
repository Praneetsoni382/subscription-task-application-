# Razorpay Payment Architecture

## Design Principles

- **Server-Authoritative Pricing**: Clients never send or override subscription price or currency. Orders read `PREMIUM_PLAN_AMOUNT` (in paise, e.g., `49900` = ₹499.00) and `PREMIUM_PLAN_CURRENCY` (`INR`) strictly from server environment configuration (`server/src/config.ts`).
- **Zero Simulated Payments**: If `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, or `PREMIUM_PLAN_AMOUNT` is unset, `GET /api/payments/config` reports incomplete configuration (`isGatewayConfigured` / `isPricingConfigured`), and `POST /api/payments/razorpay/order` returns HTTP `503`. The frontend never activates Premium without backend cryptographic verification.

## Payment & Webhook Lifecycle

1. **Order Creation (`POST /api/payments/razorpay/order`)**:
   - Admin-only endpoint.
   - Calls `https://api.razorpay.com/v1/orders` with Basic Auth (`RAZORPAY_KEY_ID:RAZORPAY_KEY_SECRET`), server-configured amount, currency, and workspace metadata notes.
   - Persists `payments/{paymentId}` with `status: 'PENDING'`, `gatewayOrderId`, `idempotencyKey`, and `initiatedByUid`.
2. **Checkout Verification (`POST /api/payments/razorpay/verify`)**:
   - Admin-only endpoint called by Razorpay Checkout callback handler.
   - Computes expected HMAC-SHA256 digest of `${razorpayOrderId}|${razorpayPaymentId}` using `RAZORPAY_KEY_SECRET` and compares using `crypto.timingSafeEqual`.
   - Rejects mismatches with HTTP `400 INVALID_PAYMENT_SIGNATURE` and logs a `REJECTED` `paymentEvents` record.
   - On match, runs `finalizeVerifiedPayment` inside a Firestore transaction.
3. **Raw-Body Webhook Verification (`POST /api/payments/razorpay/webhook`)**:
   - `server/src/app.ts` preserves `req.rawBody` via `express.json({ verify })`.
   - Computes expected HMAC-SHA256 digest of `req.rawBody` using `RAZORPAY_WEBHOOK_SECRET` and compares against `x-razorpay-signature` via `crypto.timingSafeEqual`.
   - Processes `payment.captured` and `order.paid` idempotently even if the browser closed mid-checkout; handles `payment.failed` cleanly.
4. **Transactional Idempotency (`finalizeVerifiedPayment`)**:
   - Reads `payments/{paymentId}` and `paymentEvents/{gatewayEventId}` inside `runFirestoreTransaction`.
   - If `payment.status === 'VERIFIED'` or the event document already exists, exits cleanly without double-activating or issuing duplicate 30-day periods.
   - Otherwise, invokes `activatePremiumPeriodInTransaction` to create a 30-day (`2,592,000s`) `SubscriptionPeriod` with `5` Meet credits and updates `payments` + `paymentEvents` + `auditEvents` atomically.
