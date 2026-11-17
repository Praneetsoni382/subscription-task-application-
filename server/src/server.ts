// ============================================================
// SERVER ENTRY POINT
// ============================================================

import { PORT } from './config.js';
import app from './app.js';
import { firebaseConfig, isAdminSdkConfigured } from './firebase.js';
import { startISTClockAndScheduler, getISTClock } from './services/istSchedulerService.js';

async function start() {
  try {
    startISTClockAndScheduler();
    const ist = getISTClock();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🚀 TaskFlow Platform API running on http://0.0.0.0:${PORT}`);
      console.log(`   Health check:  http://localhost:${PORT}/api/health`);
      console.log(`   Bootstrap API: http://localhost:${PORT}/api/bootstrap/status`);
      console.log(`   Firebase:      ${firebaseConfig.projectId} / ${firebaseConfig.firestoreDatabaseId || '(default)'}`);
      console.log(`   Admin SDK:     ${isAdminSdkConfigured ? 'Configured with Service Account' : 'Waiting for FIREBASE_CLIENT_EMAIL & FIREBASE_PRIVATE_KEY'}`);
      console.log(`   IST Clock:     ${ist.timeWithSeconds} (${ist.dateFormatted})\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
