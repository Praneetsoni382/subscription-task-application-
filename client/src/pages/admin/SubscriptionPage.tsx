import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreditCard,
  CheckCircle2,
  Lock,
  Sparkles,
  Video,
  MessageSquareReply,
  Calendar,
  AlertTriangle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { AppLayout } from '../../components/layout/AppLayout';
import { Card, CardHeader, CardTitle } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { PageLoader } from '../../components/ui/LoadingSpinner';
import { useAuth } from '../../contexts/AuthContext';
import { paymentApi, subscriptionApi } from '../../services/api';
import { formatDateTime } from '../../utils/formatDate';
import type {
  EntitlementSummary,
  PaymentRecord,
  RazorpayConfigStatus,
  SubscriptionEvent,
  SubscriptionPeriod,
  Workspace,
} from '../../types';

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, cb: (res: any) => void) => void;
    };
  }
}

function loadRazorpayCheckoutScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (window.Razorpay) {
      resolve(true);
      return;
    }
    const existing = document.querySelector('script[data-razorpay-checkout="true"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(Boolean(window.Razorpay)));
      existing.addEventListener('error', () => resolve(false));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.setAttribute('data-razorpay-checkout', 'true');
    script.onload = () => resolve(Boolean(window.Razorpay));
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

function formatCurrency(amountInSmallestUnit: number, currency: string): string {
  const major = amountInSmallestUnit / 100;
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
    }).format(major);
  } catch {
    return `${currency || 'INR'} ${major.toFixed(2)}`;
  }
}

export function SubscriptionPage() {
  const { user, workspace, refreshSession } = useAuth();
  const queryClient = useQueryClient();
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [billingMessage, setBillingMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const { data: currentData, isLoading: currentLoading } = useQuery({
    queryKey: ['subscription-current'],
    queryFn: async () => {
      const res = await subscriptionApi.getCurrent();
      return res.data?.data as {
        workspace: Workspace | null;
        entitlement: EntitlementSummary;
      };
    },
    refetchInterval: 30_000,
  });

  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: ['subscription-history'],
    queryFn: async () => {
      const res = await subscriptionApi.getHistory();
      return res.data?.data as {
        entitlement: EntitlementSummary;
        periods: SubscriptionPeriod[];
        events: SubscriptionEvent[];
      };
    },
  });

  const { data: paymentConfig } = useQuery({
    queryKey: ['payment-config'],
    queryFn: async () => {
      const res = await paymentApi.getConfig();
      return res.data?.data as RazorpayConfigStatus;
    },
  });

  const { data: payments = [] } = useQuery({
    queryKey: ['payments-list'],
    queryFn: async () => {
      const res = await paymentApi.list();
      return (res.data?.data ?? []) as PaymentRecord[];
    },
  });

  const entitlement = currentData?.entitlement;
  const activeWorkspace = currentData?.workspace || workspace;
  const isPremiumActive = Boolean(entitlement?.isPremiumActive);

  const handleUpgradeOrRenew = async () => {
    setBillingMessage(null);
    if (!paymentConfig?.isGatewayConfigured || !paymentConfig?.isPricingConfigured) {
      setBillingMessage({
        type: 'error',
        text: 'Razorpay gateway keys or server subscription pricing (PREMIUM_PLAN_AMOUNT) are not configured yet.',
      });
      return;
    }

    setCheckoutBusy(true);
    try {
      const scriptLoaded = await loadRazorpayCheckoutScript();
      if (!scriptLoaded || !window.Razorpay) {
        throw new Error('Unable to load Razorpay Checkout SDK.');
      }

      const idempotencyKey =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `ord_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      const orderRes = await paymentApi.createRazorpayOrder({ idempotencyKey });
      const orderPayload = orderRes.data?.data as {
        razorpayOrder: {
          id: string;
          amount: number;
          currency: string;
          keyId: string;
        };
      };

      if (!orderPayload?.razorpayOrder?.id) {
        throw new Error('Server did not return a valid Razorpay Order ID.');
      }

      const { razorpayOrder } = orderPayload;

      await new Promise<void>((resolve, reject) => {
        const rzp = new window.Razorpay!({
          key: razorpayOrder.keyId,
          amount: razorpayOrder.amount,
          currency: razorpayOrder.currency,
          name: 'TaskFlow Workspace',
          description: `${activeWorkspace?.name || 'Workspace'} — 30-Day Premium Subscription`,
          order_id: razorpayOrder.id,
          prefill: {
            name: user?.fullName || '',
            email: user?.email || '',
          },
          theme: {
            color: '#2458D3',
          },
          modal: {
            ondismiss: () => resolve(),
          },
          handler: async (response: {
            razorpay_order_id: string;
            razorpay_payment_id: string;
            razorpay_signature: string;
          }) => {
            try {
              await paymentApi.verifyRazorpayPayment({
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              });
              setBillingMessage({
                type: 'success',
                text: 'Payment verified successfully! Your 30-day Premium period and 5 Google Meet credits are now active.',
              });
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['subscription-current'] }),
                queryClient.invalidateQueries({ queryKey: ['subscription-history'] }),
                queryClient.invalidateQueries({ queryKey: ['payments-list'] }),
                refreshSession(),
              ]);
              resolve();
            } catch (verifyErr: any) {
              reject(
                new Error(
                  verifyErr?.response?.data?.error ||
                    verifyErr?.message ||
                    'Payment verification failed on server.'
                )
              );
            }
          },
        });

        rzp.on('payment.failed', (failEvent: any) => {
          reject(
            new Error(
              failEvent?.error?.description || 'Razorpay payment did not complete.'
            )
          );
        });

        rzp.open();
      });
    } catch (err: any) {
      setBillingMessage({
        type: 'error',
        text:
          err?.response?.data?.error ||
          err?.message ||
          'Failed to start Razorpay Checkout.',
      });
    } finally {
      setCheckoutBusy(false);
    }
  };

  if (currentLoading || historyLoading) {
    return (
      <AppLayout title="Subscription & Billing">
        <PageLoader />
      </AppLayout>
    );
  }

  const periods = historyData?.periods ?? [];
  const events = historyData?.events ?? [];
  const canPayNow = Boolean(
    paymentConfig?.isGatewayConfigured && paymentConfig?.isPricingConfigured
  );

  return (
    <AppLayout title="Workspace Subscription & Billing">
      <div className="space-y-6 max-w-6xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#E4E8EF]">
          <div>
            <h1 className="text-xl font-bold text-[#172033]">
              Subscription, Entitlements & Billing
            </h1>
            <p className="text-xs text-[#667085] mt-0.5">
              Workspace: <span className="font-semibold text-[#172033]">{activeWorkspace?.name || 'Organization'}</span>{' '}
              • Billing cycles run strictly for 30 days (2,592,000s) with verified Razorpay activation
            </p>
          </div>
          <Button
            size="sm"
            onClick={handleUpgradeOrRenew}
            loading={checkoutBusy}
            disabled={!canPayNow}
            className="shrink-0"
          >
            <CreditCard size={15} />
            <span>
              {isPremiumActive
                ? 'Renew Premium (+30 Days)'
                : 'Upgrade to Premium (30 Days)'}
              {paymentConfig?.amount
                ? ` • ${formatCurrency(paymentConfig.amount, paymentConfig.currency)}`
                : ''}
            </span>
          </Button>
        </div>

        {billingMessage && (
          <div
            className={`p-4 rounded-xl border text-xs flex items-center gap-2.5 ${
              billingMessage.type === 'success'
                ? 'bg-[#EDFAF4] border-[#A8DFC5] text-[#16865B]'
                : 'bg-[#FFF0F0] border-[#F5B8B8] text-[#D64545]'
            }`}
          >
            {billingMessage.type === 'success' ? (
              <CheckCircle2 size={16} className="shrink-0" />
            ) : (
              <AlertTriangle size={16} className="shrink-0" />
            )}
            <span className="font-semibold">{billingMessage.text}</span>
          </div>
        )}

        {!canPayNow && (
          <div className="p-4 rounded-xl bg-[#FFF8E7] border border-[#F5D87E] text-xs space-y-1.5">
            <div className="flex items-center gap-2 font-bold text-[#C58A20]">
              <AlertTriangle size={15} />
              <span>Payment Gateway Configuration Pending</span>
            </div>
            <p className="text-[#172033] leading-relaxed">
              Live Razorpay checkout is disabled until server environment variables are configured:{' '}
              {!paymentConfig?.isGatewayConfigured && (
                <span className="font-mono font-semibold">
                  RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET{' '}
                </span>
              )}
              {!paymentConfig?.isPricingConfigured && (
                <span className="font-mono font-semibold">PREMIUM_PLAN_AMOUNT</span>
              )}
              . TaskFlow never simulates fake payments or activates Premium without verified server webhooks/HMAC signatures.
            </p>
          </div>
        )}

        {/* Current Plan Overview */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[#667085]">Active Workspace Plan</span>
              <Badge
                bg={isPremiumActive ? '#EDFAF4' : '#F1F5F9'}
                color={isPremiumActive ? '#16865B' : '#475569'}
                border={isPremiumActive ? '#A8DFC5' : '#CBD5E1'}
              >
                {entitlement?.plan || 'FREE'} ({entitlement?.status || 'ACTIVE'})
              </Badge>
            </div>
            <p className="text-2xl font-bold text-[#172033] mt-3">
              {isPremiumActive ? 'Premium Workspace' : 'Free Standard Plan'}
            </p>
            <p className="text-xs text-[#667085] mt-2">
              {isPremiumActive && entitlement?.currentPeriodEnd
                ? `Valid through ${formatDateTime(entitlement.currentPeriodEnd)}`
                : entitlement?.status === 'EXPIRED'
                ? 'Your previous Premium period expired. Renew to unlock Status Requests & Google Meet.'
                : 'Core task management, assignments, clarifications, team chat & reports included.'}
            </p>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[#667085]">Google Meet Generation Credits</span>
              <Video size={17} className="text-[#2458D3]" />
            </div>
            <p className="text-2xl font-bold text-[#172033] mt-3 tabular-nums">
              {entitlement?.meetCreditsRemaining ?? 0}{' '}
              <span className="text-sm font-medium text-[#667085]">
                / {entitlement?.meetCreditLimit ?? 0} remaining
              </span>
            </p>
            <p className="text-xs text-[#667085] mt-2">
              {isPremiumActive
                ? `${entitlement?.meetCreditsUsed ?? 0} used, ${entitlement?.meetCreditsReserved ?? 0} in flight this 30-day cycle`
                : '5 genuine Google Meet links unlocked per 30-day Premium billing period.'}
            </p>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[#667085]">Status Queries Usage</span>
              <MessageSquareReply size={17} className="text-[#7464E8]" />
            </div>
            <p className="text-2xl font-bold text-[#172033] mt-3 tabular-nums">
              {entitlement?.statusQueriesUsed ?? 0}
            </p>
            <p className="text-xs text-[#667085] mt-2">
              {isPremiumActive
                ? 'Status Requests & Status Queries are unlocked for all workspace members.'
                : 'Status Requests & Status Queries require an active Premium subscription.'}
            </p>
          </Card>
        </div>

        {/* Plan Comparison */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-5 border border-[#E4E8EF]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck size={17} className="text-[#2458D3]" />
                Free Plan (Always Included)
              </CardTitle>
            </CardHeader>
            <ul className="space-y-2 text-xs text-[#172033]">
              <li className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-[#16865B] shrink-0" />
                Unlimited Task Creation, Assignments (Solo/Group) & Status Lifecycle
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-[#16865B] shrink-0" />
                Task Queries & Clarification Threads
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-[#16865B] shrink-0" />
                Task Team Chat, Reports, IST Deadline Reminders & Push Notifications
              </li>
              <li className="flex items-center gap-2 text-[#667085]">
                <Lock size={14} className="shrink-0" />
                Status Requests & Status Queries locked
              </li>
              <li className="flex items-center gap-2 text-[#667085]">
                <Lock size={14} className="shrink-0" />
                Google Meet Space Creation & Joining locked
              </li>
            </ul>
          </Card>

          <Card className="p-5 border-2 border-[#2458D3]/30 bg-[#F9FBFF]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-[#172033]">
                <Sparkles size={17} className="text-[#2458D3]" />
                Premium Plan (30-Day Billing Cycle)
              </CardTitle>
            </CardHeader>
            <ul className="space-y-2 text-xs text-[#172033]">
              <li className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-[#16865B] shrink-0" />
                Everything in Free Plan across your entire Workspace
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-[#16865B] shrink-0" />
                Status Requests & Manager-Employee Status Queries unlocked
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-[#16865B] shrink-0" />
                Up to 5 Google Meet REST API v2 space generations per 30-day cycle
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-[#16865B] shrink-0" />
                Early renewal stacks +30 days & fresh 5 credits seamlessly after current expiry
              </li>
            </ul>
          </Card>
        </div>

        {/* Billing Periods */}
        <Card className="p-5">
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <Calendar size={16} className="text-[#2458D3]" />
                Subscription Periods
              </CardTitle>
              <p className="text-xs text-[#667085]">
                Exact UTC start/end intervals and Meet credit consumption per period
              </p>
            </div>
          </CardHeader>

          {periods.length === 0 ? (
            <p className="text-xs text-[#667085] py-4">No subscription periods recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[#E4E8EF] text-[#667085]">
                    <th className="py-2.5 font-medium">#</th>
                    <th className="py-2.5 font-medium">Plan</th>
                    <th className="py-2.5 font-medium">Status</th>
                    <th className="py-2.5 font-medium">Start</th>
                    <th className="py-2.5 font-medium">End</th>
                    <th className="py-2.5 font-medium">Meet Credits</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E4E8EF]">
                  {periods.map((p) => (
                    <tr key={p.id}>
                      <td className="py-2.5 font-semibold text-[#172033]">#{p.periodNumber}</td>
                      <td className="py-2.5 font-medium">{p.plan}</td>
                      <td className="py-2.5">
                        <Badge size="sm">{p.status}</Badge>
                      </td>
                      <td className="py-2.5 text-[#667085]">{formatDateTime(p.startAt)}</td>
                      <td className="py-2.5 text-[#667085]">
                        {p.endAt ? formatDateTime(p.endAt) : 'Ongoing (Free)'}
                      </td>
                      <td className="py-2.5 tabular-nums">
                        {p.meetCreditsUsed} / {p.meetCreditLimit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Payment Records & Audit Events */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="p-5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <CreditCard size={15} className="text-[#2458D3]" />
                Razorpay Payment History
              </CardTitle>
            </CardHeader>
            {payments.length === 0 ? (
              <p className="text-xs text-[#667085] py-4">No Razorpay payment orders created yet.</p>
            ) : (
              <div className="space-y-2.5">
                {payments.map((pay) => (
                  <div
                    key={pay.id}
                    className="p-3 rounded-xl border border-[#E4E8EF] bg-[#F9FBFF] text-xs flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-[#172033]">
                        {formatCurrency(pay.amount, pay.currency)}
                      </p>
                      <p className="text-[11px] text-[#667085] font-mono truncate">
                        Order: {pay.gatewayOrderId}
                      </p>
                      <p className="text-[10px] text-[#667085]">
                        {formatDateTime(pay.paidAt || pay.createdAt)}
                      </p>
                    </div>
                    <Badge
                      bg={
                        pay.status === 'VERIFIED'
                          ? '#EDFAF4'
                          : pay.status === 'FAILED'
                          ? '#FFF0F0'
                          : '#FFF8E7'
                      }
                      color={
                        pay.status === 'VERIFIED'
                          ? '#16865B'
                          : pay.status === 'FAILED'
                          ? '#D64545'
                          : '#C58A20'
                      }
                      size="sm"
                    >
                      {pay.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <RefreshCw size={15} className="text-[#2458D3]" />
                Subscription Lifecycle Events
              </CardTitle>
            </CardHeader>
            {events.length === 0 ? (
              <p className="text-xs text-[#667085] py-4">No subscription lifecycle events yet.</p>
            ) : (
              <div className="space-y-2.5 max-h-72 overflow-y-auto">
                {events.map((ev) => (
                  <div
                    key={ev.id}
                    className="p-3 rounded-xl border border-[#E4E8EF] bg-white text-xs space-y-0.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[#172033]">{ev.eventType}</span>
                      <span className="text-[10px] text-[#667085]">
                        {formatDateTime(ev.createdAt)}
                      </span>
                    </div>
                    <p className="text-[11px] text-[#667085]">
                      Status: {ev.previousStatus || 'NONE'} → {ev.newStatus || 'NONE'}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
