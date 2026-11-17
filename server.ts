import path from 'path';
import fs from 'fs';

const distServerPath = path.resolve(process.cwd(), 'server/dist/server.js');

async function startServer() {
  try {
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction && fs.existsSync(distServerPath)) {
      await import('./server/dist/server.js');
    } else {
      const appModule = await import('./server/src/app.js');
      const firebaseModule = await import('./server/src/firebase.js');
      const app = appModule.default;
      const { firebaseConfig, isAdminSdkConfigured } = firebaseModule;

      const { startISTClockAndScheduler, getISTClock } = await import(
        './server/src/services/istSchedulerService.js'
      );

      const PORT = Number(process.env.DEV_PORT || 3000);
      startISTClockAndScheduler();
      const ist = getISTClock();

      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true, hmr: false },
        appType: 'spa',
        root: path.resolve(process.cwd(), 'client'),
        configFile: path.resolve(process.cwd(), 'client/vite.config.ts'),
      });

      app.use(vite.middlewares);

      app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 TaskFlow Platform running on http://0.0.0.0:${PORT}`);
        console.log(`   Health check:  http://0.0.0.0:${PORT}/api/health`);
        console.log(`   Firebase:      ${firebaseConfig.projectId} / ${firebaseConfig.firestoreDatabaseId || '(default)'}`);
        console.log(`   Admin SDK:     ${isAdminSdkConfigured ? 'Configured' : 'Awaiting FIREBASE_CLIENT_EMAIL & FIREBASE_PRIVATE_KEY'}`);
        console.log(`   IST Clock:     ${ist.timeWithSeconds} (${ist.dateFormatted})\n`);
      });
    }
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
