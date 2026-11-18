// ============================================================
// FIREBASE ADMIN SDK INITIALIZATION (AUTHORITATIVE SERVER)
// ============================================================

import {
  initializeApp as initializeAdminApp,
  getApps as getAdminApps,
  cert,
  type App,
} from 'firebase-admin/app';
import {
  getFirestore as getAdminFirestore,
  FieldValue,
  Timestamp,
  type Firestore as AdminFirestore,
  type Transaction,
} from 'firebase-admin/firestore';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import fs from 'fs';
import path from 'path';

export interface FirebaseConfig {
  projectId: string;
  apiKey?: string;
  authDomain?: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  oAuthClientId?: string;
  clientEmail?: string;
  privateKey?: string;
}

function loadConfig(): FirebaseConfig {
  let config: Record<string, any> = {};

  const possiblePaths = [
    path.resolve(process.cwd(), 'firebase-applet-config.json'),
    path.resolve(process.cwd(), 'client/src/firebase-applet-config.json'),
    path.resolve(process.cwd(), '../firebase-applet-config.json'),
    path.resolve(import.meta.dirname, '../../firebase-applet-config.json'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        config = {
          ...parsed,
          ...config,
          firestoreDatabaseId: config.firestoreDatabaseId || parsed.firestoreDatabaseId || '',
        };
      } catch {
        // continue checking other paths
      }
    }
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || config.projectId || '';
  if (!projectId) {
    throw new Error(
      'Missing Firebase Project ID. Configure FIREBASE_PROJECT_ID or firebase-applet-config.json.'
    );
  }

  return {
    projectId,
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    firestoreDatabaseId: process.env.FIRESTORE_DATABASE_ID || config.firestoreDatabaseId || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || config.storageBucket || '',
    messagingSenderId: config.messagingSenderId || '',
    oAuthClientId: config.oAuthClientId || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    privateKey: process.env.FIREBASE_PRIVATE_KEY
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      : '',
  };
}

export const firebaseConfig = loadConfig();

export const hasServiceAccountCredentials = Boolean(
  firebaseConfig.clientEmail && firebaseConfig.privateKey
);

let adminApp: App | null = null;
let adminDbInstance: AdminFirestore | null = null;
let adminAuthInstance: Auth | null = null;
let adminMessagingInstance: Messaging | null = null;

try {
  if (getAdminApps().length === 0) {
    if (hasServiceAccountCredentials) {
      adminApp = initializeAdminApp({
        credential: cert({
          projectId: firebaseConfig.projectId,
          clientEmail: firebaseConfig.clientEmail!,
          privateKey: firebaseConfig.privateKey!,
        }),
        projectId: firebaseConfig.projectId,
        storageBucket: firebaseConfig.storageBucket || undefined,
      });
      console.log(
        `🔥 Firebase Admin initialized with Service Account for project: ${firebaseConfig.projectId}`
      );
    } else {
      adminApp = initializeAdminApp({
        projectId: firebaseConfig.projectId,
        storageBucket: firebaseConfig.storageBucket || undefined,
      });
      console.warn(
        `⚠️ Firebase Admin initialized without FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY (Project: ${firebaseConfig.projectId}). Protected Firestore/Auth operations require valid service account credentials.`
      );
    }
  } else {
    adminApp = getAdminApps()[0];
  }

  if (adminApp) {
    adminAuthInstance = getAuth(adminApp);
    adminDbInstance = firebaseConfig.firestoreDatabaseId
      ? getAdminFirestore(adminApp, firebaseConfig.firestoreDatabaseId)
      : getAdminFirestore(adminApp);
    adminDbInstance.settings({ ignoreUndefinedProperties: true });

    try {
      adminMessagingInstance = getMessaging(adminApp);
    } catch (mErr) {
      console.warn('⚠️ Firebase Admin Messaging initialization notice:', mErr);
    }
  }
} catch (err) {
  console.error('❌ Firebase Admin initialization error:', err);
}

export class FirebaseConfigurationError extends Error {
  public readonly statusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = 'FirebaseConfigurationError';
  }
}

export function requireAdminDb(): AdminFirestore {
  if (!adminDbInstance) {
    throw new FirebaseConfigurationError(
      'Cloud Firestore Admin SDK is not initialized. Verify Firebase project configuration and service account credentials.'
    );
  }
  return adminDbInstance;
}

export function isPermissionOrAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown })?.code;
  return (
    code === 7 ||
    code === 16 ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('UNAUTHENTICATED') ||
    msg.includes('Could not load the default credentials') ||
    msg.includes('Unable to detect a Project Id')
  );
}

export function wrapFirestoreError(err: unknown, operation: string): never {
  if (err instanceof FirebaseConfigurationError) {
    throw err;
  }
  if (isPermissionOrAuthError(err)) {
    throw new FirebaseConfigurationError(
      `Firestore Admin access denied during "${operation}" on project "${firebaseConfig.projectId}". Configure FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY service account environment variables.`
    );
  }
  throw err;
}

export async function runFirestoreTransaction<T>(
  fn: (tx: Transaction, db: AdminFirestore) => Promise<T>,
  operationName = 'transaction'
): Promise<T> {
  const db = requireAdminDb();
  try {
    return await db.runTransaction((tx) => fn(tx, db));
  } catch (err) {
    wrapFirestoreError(err, operationName);
  }
}

export async function verifyFirestoreConnectivity(): Promise<{
  connected: boolean;
  hasServiceAccount: boolean;
  projectId: string;
  databaseId: string;
  error?: string;
}> {
  const base = {
    hasServiceAccount: hasServiceAccountCredentials,
    projectId: firebaseConfig.projectId,
    databaseId: firebaseConfig.firestoreDatabaseId || '(default)',
  };

  if (!adminDbInstance) {
    return {
      ...base,
      connected: false,
      error: 'Firebase Admin Firestore instance is not initialized',
    };
  }

  try {
    await adminDbInstance.collection('systemConfig').doc('bootstrap').get();
    return {
      ...base,
      connected: true,
    };
  } catch (err) {
    return {
      ...base,
      connected: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const isAdminSdkConfigured = hasServiceAccountCredentials && Boolean(adminDbInstance);

export {
  adminApp,
  adminAuthInstance as adminAuth,
  adminDbInstance as adminDb,
  adminMessagingInstance as adminMessaging,
  FieldValue,
  Timestamp,
};
