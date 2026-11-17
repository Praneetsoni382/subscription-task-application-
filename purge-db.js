// Maintenance script to reset the Firestore database cleanly for a fresh workspace bootstrap.
// Requires valid FIREBASE_CLIENT_EMAIL & FIREBASE_PRIVATE_KEY environment variables.
import 'dotenv/config';
import { requireAdminDb } from './server/dist/firebase.js';

const COLLECTIONS = [
  'systemConfig',
  'workspaces',
  'users',
  'tasks',
  'taskMembers',
  'statusRequests',
  'statusResponses',
  'queries',
  'queryMessages',
  'chatMessages',
  'notifications',
  'auditEvents',
  'meetings',
  'reminderOccurrences',
  'googleAuthTokens',
  'oauthStates',
  'devices',
  'pushPreferences',
  'subscriptions',
  'subscriptionPeriods',
  'subscriptionUsage',
  'subscriptionEvents',
  'payments',
  'paymentEvents',
  'meetGenerationOperations',
  'activeSessions',
];

async function purgeAll() {
  const db = requireAdminDb();
  console.log('🧹 Clearing all collections in Cloud Firestore...');

  for (const col of COLLECTIONS) {
    const snap = await db.collection(col).get();
    if (!snap.empty) {
      console.log(`   Deleting ${snap.size} document(s) from '${col}'...`);
      for (const docSnap of snap.docs) {
        await docSnap.ref.delete();
      }
    }
  }

  console.log('✨ Database cleared. Ready for clean /api/bootstrap workspace initialization.');
  process.exit(0);
}

purgeAll().catch((err) => {
  console.error('❌ Purge failed:', err);
  process.exit(1);
});
