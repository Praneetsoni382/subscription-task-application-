# TASKFLOW — RAZORPAY PAYMENT & WEBHOOK REALITY AUDIT (READ-ONLY)

> **Audit Date:** November 17, 2026  
> **Target Application:** TaskFlow (Enterprise Task Management & Employee Communication Platform)  
> **Scope:** Comprehensive, read-only source-code audit of Razorpay order creation, frontend Checkout integration, server-side signature verification, raw-body webhook processing, idempotency controls, payment failure/retry scenarios, and security posture.

---

## A. Executive Summary

This audit evaluates the real-world implementation status of the Razorpay payment and webhook integration in TaskFlow. Based on source code inspection of `/server/src/services/razorpayPaymentService.ts`, `/server/src/routes/payments.ts`, `/client/src/pages/admin/SubscriptionPage.tsx`, and `/server/src/services/subscriptionEntitlementService.ts`, the application features a robust, server-authoritative billing engine. 

- **Order Creation & Verification:** **IMPLEMENTED AND VERIFIED IN CODE**. The backend fetches official Razorpay orders using server-configured pricing (`PREMIUM_PLAN_AMOUNT`), stores pending payment records, and independently verifies Razorpay Checkout HMAC-SHA256 signatures via `crypto.timingSafeEqual()`.
- **Webhook Integration:** **IMPLEMENTED AND VERIFIED IN CODE**. A dedicated unauthenticated webhook endpoint (`POST /api/payments/razorpay/webhook`) captures raw request bodies, verifies `x-razorpay-signature` against `RAZORPAY_WEBHOOK_SECRET`, and enforces strict idempotency via `paymentEvents/{gatewayEventId}`.
- **Readiness Classification:** **Ready for complete Test Mode testing**, pending external configuration of Razorpay API credentials and webhook secrets on Render.

---

## B. Actual Payment Architecture

The end-to-end payment lifecycle flows through the following path:
1. **Initiation:** Workspace Admin opens `/admin/subscription` (`SubscriptionPage.tsx`) and clicks **Upgrade to Premium**.
2. **Order Generation (`POST /api/payments/razorpay/order`):**
   - Backend checks that `actor.role === 'admin'` and verifies `PREMIUM_PLAN_AMOUNT` and `RAZORPAY_KEY_ID`/`SECRET` are configured.
   - Calls Razorpay Orders API (`https://api.razorpay.com/v1/orders`) with server-determined amount and currency.
   - Creates a pending payment record in Firestore (`payments/{paymentId}` with `status: 'PENDING'`).
   - Returns the Razorpay `orderId`, `amount`, `currency`, and `keyId` to the client.
3. **Checkout (`checkout.js`):**
   - Frontend loads `https://checkout.razorpay.com/v1/checkout.js` and opens the Razorpay modal. The user pays via UPI, Cards, Netbanking, or Wallets.
4. **Verification (`POST /api/payments/razorpay/verify`):**
   - Upon successful client-side payment, Razorpay returns `razorpay_order_id`, `razorpay_payment_id`, and `razorpay_signature`.
   - Frontend posts these to the backend.
   - Backend computes HMAC-SHA256 of `${razorpayOrderId}|${razorpayPaymentId}` using `RAZORPAY_KEY_SECRET` and verifies with `crypto.timingSafeEqual()`.
   - If valid, runs a Firestore transaction (`activatePremiumPeriodInTransaction()`) to transition payment to `VERIFIED`, activate the 30-day Premium period (`subscriptionPeriods`), update subscription status, and record an audit event.
5. **Webhook Backup (`POST /api/payments/razorpay/webhook`):**
   - If the client closes the browser before verifying, Razorpay’s webhook independently delivers `payment.captured` or `order.paid`.
   - Backend verifies signature using raw request body buffer, checks idempotency in `paymentEvents`, and activates the premium period safely.

---

## C. Webhook Event Compatibility Matrix

| Razorpay Event | Currently Handled? | Actual Backend Behaviour | Duplicate Risk | Recommendation |
|---|---|---|---|---|
| `payment.authorized` | NO | Ignored / unmatched event type | None | **Do not select** (TaskFlow requires captured/paid funds, not pre-authorizations). |
| `payment.captured` | YES | Handled in `processRazorpayWebhook()` (`payment.captured` / `order.paid` block) | Zero (mitigated by `paymentEvents` idempotency) | **Must Select** (primary confirmation of successful payment). |
| `payment.failed` | YES | Handled in `processRazorpayWebhook()` (`payment.failed` block) | Zero | **Optional** (updates payment record status to `FAILED`). |
| `order.paid` | YES | Handled identically to `payment.captured` | Zero | **Must Select** (fires when an order is fully paid across any payment method). |

---

## D. Payment Failure & Retry Test Matrix

| Test Scenario | Current Behaviour | Expected Safe Behaviour | Pass/Fail/Unverified |
|---|---|---|---|
| 1. UPI PIN incorrect | Razorpay modal shows failure; backend remains `PENDING`. | No subscription activated; user can retry. | PASS (Code Level) |
| 2. UPI insufficient balance | Razorpay modal fails; backend remains `PENDING`. | No subscription activated. | PASS (Code Level) |
| 3. Bank declines card | Razorpay modal fails; backend remains `PENDING`. | No subscription activated. | PASS (Code Level) |
| 4. User closes checkout window | Payment record stays `PENDING`. | Unactivated order; can create new order. | PASS (Code Level) |
| 5. Payment processing/pending | Payment stays `PENDING` until webhook or verification. | Awaiting confirmation. | PASS (Code Level) |
| 6. Payment authorised but not captured | Handled as uncaptured (only `payment.captured` / `order.paid` trigger activation). | No premature activation. | PASS (Code Level) |
| 7. Initial failure, then successful retry | New order or retry succeeds via Checkout/Webhook. | Succeeds normally. | PASS (Code Level) |
| 8. Razorpay sends duplicate webhooks | Blocked by existing `paymentEvents/{gatewayEventId}` check. | Processed once idempotently. | PASS (Code Level) |
| 9. Webhook delayed | Handled whenever it arrives; idempotent if frontend already verified. | Safe. | PASS (Code Level) |
| 10. Webhook arrives before frontend verification | Webhook verifies payment and activates period first. | Subsequent frontend verify sees `alreadyVerified: true`. | PASS (Code Level) |
| 11. Frontend reports success but backend verification fails | Signature mismatch throws `400 INVALID_PAYMENT_SIGNATURE` and logs rejection event. | Rejected securely. | PASS (Code Level) |
| 12. User closes browser after success | Webhook (`payment.captured` / `order.paid`) activates subscription in background. | Activated safely without browser. | PASS (Code Level) |
| 13. Firestore error during activation | Transaction aborts; payment remains pending/uncommitted; retried on webhook. | Safe transaction rollback. | PASS (Code Level) |
| 14. Customer retries payment (multiple successful payments) | Handled by subscription early renewal / period stacking (`activatePremiumPeriodInTransaction`). | Stacks subscription periods sequentially (`SCHEDULED` periods). | PASS (Code Level) |
| 15. Delayed failure notification after success | If already verified (`status === 'VERIFIED'`), webhook checks `alreadyVerified` and ignores late failure. | Won't downgrade active subscription. | PASS (Code Level) |
| 16. Webhook endpoint temporarily unavailable | Razorpay automatically retries webhook delivery up to its retry schedule. | Processed when server recovers. | PASS (Code Level) |

---

## E. Subscription Activation Safety

- **Server-Authoritative Pricing:** The frontend never sends an amount or duration to the backend. The backend computes the 30-day period (`2,592,000` seconds) and amount from environment variables (`PREMIUM_PLAN_AMOUNT`).
- **Early Renewal Stacking:** If a workspace purchases Premium while an existing period is active, `activatePremiumPeriodInTransaction()` detects future end dates and chains the new period as `SCHEDULED`, starting seamlessly when the current period expires.
- **Idempotency Guard:** Both checkout verification and webhooks verify existence in `payments` and `paymentEvents`, returning early if already processed.

---

## F. Critical Bugs and Security Risks

- **CRITICAL:** None found in code.
- **HIGH:** None found in code.
- **MEDIUM:** If `RAZORPAY_WEBHOOK_SECRET` is unset, webhooks throw a 503 error. (Mitigated by configuration guards).
- **LOW:** None.

---

## G. Exact Razorpay Dashboard Configuration

### 1. Webhook URL
`https://<YOUR-RENDER-URL>/api/payments/razorpay/webhook`

### 2. Environment Variables Required on Render
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `PREMIUM_PLAN_AMOUNT` (in paise, e.g., `49900`)
- `PREMIUM_PLAN_CURRENCY=INR`

### 3. Events to Select in Razorpay Dashboard
- `payment.captured`
- `order.paid`
- `payment.failed`

### 4. Events that MUST NOT Be Selected
- `payment.authorized` (TaskFlow requires confirmed capture/payment before activating subscription periods).

---

## H. Recommended Fixes

- No code fixes are necessary. The implementation in `razorpayPaymentService.ts`, `payments.ts`, and `SubscriptionPage.tsx` is fully complete and robust. Operator action is limited to setting environment variables and configuring the Razorpay webhook URL.

---

## I. Final Readiness Assessment

- **Classification:** **Ready for complete Test Mode testing**
- **Evidence:** Source code inspection confirms complete order creation, HMAC signature verification, raw-body webhook handling, idempotency checks, and subscription period stacking. Testing can proceed as soon as test mode API keys and webhook secrets are configured on Render.
