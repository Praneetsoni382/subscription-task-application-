// ============================================================
// SERVER CONFIGURATION
// ============================================================

import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// Ephemeral fallback ONLY for local non-production dev when SESSION_SECRET is unset
const DEV_EPHEMERAL_SECRET = crypto.randomBytes(32).toString('hex');

export const SESSION_SECRET = process.env.SESSION_SECRET || DEV_EPHEMERAL_SECRET;

export const PORT = Number(
  process.env.BACKEND_PORT ||
    (process.env.NODE_ENV === 'production' && process.env.PORT ? process.env.PORT : 3000)
);

export const SESSION_INACTIVITY_TIMEOUT_MINUTES = Math.max(
  1,
  Number(process.env.SESSION_INACTIVITY_TIMEOUT_MINUTES || 30)
);
export const SESSION_INACTIVITY_TIMEOUT_MS = SESSION_INACTIVITY_TIMEOUT_MINUTES * 60 * 1000;

export const OAUTH_TOKEN_ENCRYPTION_KEY = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || '';

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
export const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';

export const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
export const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
export const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

const parsedAmount = Number(process.env.PREMIUM_PLAN_AMOUNT);
export const PREMIUM_PLAN_AMOUNT: number | null =
  Number.isFinite(parsedAmount) && parsedAmount > 0 ? Math.round(parsedAmount) : null;
export const PREMIUM_PLAN_CURRENCY = (process.env.PREMIUM_PLAN_CURRENCY || 'INR').toUpperCase();

export const BOOTSTRAP_SETUP_SECRET = process.env.BOOTSTRAP_SETUP_SECRET || '';

// Subscription business constants (Part 5)
export const PREMIUM_PERIOD_DURATION_SECONDS = 2_592_000; // Exactly 30 days (30 * 24 * 60 * 60)
export const PREMIUM_PERIOD_DURATION_MS = PREMIUM_PERIOD_DURATION_SECONDS * 1000;
export const PREMIUM_MEET_CREDIT_LIMIT = 5;
export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000; // 15 minutes
