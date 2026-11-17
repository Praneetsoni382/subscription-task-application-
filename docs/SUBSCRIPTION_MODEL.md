# Subscription & Entitlement Engine

## Overview

TaskFlow implements an authoritative server-side subscription and entitlement engine in `server/src/services/subscriptionEntitlementService.ts`. Workspaces operate on either the **Free Plan (`FREE`)** or the **30-Day Paid Premium Plan (`PREMIUM`)**.

## Entitlement Matrix

| Capability | Free / Expired Plan | Active Premium Plan |
|---|---|---|
| Task creation, assignment & status lifecycle | Allowed | Allowed |
| Task queries & clarifications (`/tasks/:id/queries`, `/queries`) | Allowed | Allowed |
| Task team chat (`/tasks/:id/messages`) | Allowed | Allowed |
| Notifications, FCM Web Push, IST reminders & Reports | Allowed | Allowed |
| Status Requests (create, list, respond) | Blocked (`402 PREMIUM_REQUIRED`) | Allowed |
| Status Queries (`/status-requests/*`) | Blocked (`402 PREMIUM_REQUIRED`) | Allowed (tracked in `statusQueriesUsed`) |
| Google Meet space creation (`POST .../meetings`) | Blocked (`402 PREMIUM_REQUIRED`) | Allowed up to **5 credits per 30-day cycle** (`402 MEET_CREDITS_EXHAUSTED` once used) |
| View / Join Google Meet discussions (`GET .../meeting`) | Blocked (`402 PREMIUM_REQUIRED`) | Allowed for Workspace members & Admin |

## 30-Day Billing Cycle & Rollover Mechanics

- **Exact Duration**: Each verified Premium purchase provisions a `SubscriptionPeriod` lasting `2,592,000` seconds (`30 * 24 * 60 * 60 * 1000` ms) from activation timestamp (`verifiedAtMs`).
- **Initial or Expired Activation**: Starts immediately at `verifiedAtMs`, sets `endAt = verifiedAtMs + 30 days`, sets `meetCreditLimit = 5`, and marks the period `ACTIVE`.
- **Early Renewal Chaining**: If the Workspace already has an active or scheduled future Premium period ending at `latestFutureEndMs > verifiedAtMs`, the new 30-day period is queued with `startAt = latestFutureEndMs`, `endAt = latestFutureEndMs + 30 days`, `status = 'SCHEDULED'`, and a fresh `meetCreditLimit = 5`.
- **Server-Time Reconciliation**: Whenever `reconcileAndGetEntitlement(workspaceId)` executes, it checks authoritative server UTC `Date.now()`:
  - If `nowMs >= currentPeriodEnd` and a `SCHEDULED` period covers `nowMs`, it atomically rolls over `subscriptions/{workspaceId}` to the next period (`SCHEDULED_PERIOD_ROLLED_OVER`) with its fresh 5 Meet credits.
  - Otherwise, if `nowMs >= currentPeriodEnd`, it transitions the subscription and period to `EXPIRED` (`PERIOD_EXPIRED`), immediately locking Premium capabilities on both API and UI.

## Atomic Meet Credit Accounting

To guarantee a workspace never exceeds `5` Meet spaces per 30-day period even under concurrent requests:
1. A Firestore transaction checks `period.meetCreditsUsed + period.meetCreditsReserved < period.meetCreditLimit` and increments `meetCreditsReserved` by `1` while writing a `meetGenerationOperations/{id}` document (`status: 'RESERVED'`).
2. The Google Meet REST API v2 call executes outside the transaction.
3. On success, a second transaction decrements `meetCreditsReserved`, increments `meetCreditsUsed`, marks the operation `COMMITTED`, and saves the `meetings/{meetingId}` document.
4. On Google API failure, a compensating transaction decrements `meetCreditsReserved` and marks the operation `ROLLED_BACK` so failed calls never consume a workspace credit.
