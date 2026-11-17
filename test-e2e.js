// ============================================================
// WORKSPACE E2E VERIFICATION SUITE
// Boots the Express app and verifies health, bootstrap status,
// and fail-closed authorization boundaries without hardcoded passwords.
// ============================================================

import http from 'http';
import app from './server/dist/app.js';

const PORT = 5555;

function request(method, path, body = null, headers = {}) {
  const url = `http://localhost:${PORT}/api${path.startsWith('/') ? path : '/' + path}`;
  return new Promise((resolve, reject) => {
    const reqHeaders = { 'Content-Type': 'application/json', ...headers };
    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runVerification() {
  let server;
  try {
    await new Promise((resolve) => {
      server = app.listen(PORT, resolve);
    });

    const health = await request('GET', '/health');
    if (health.status !== 200 || health.data?.status !== 'ok') {
      throw new Error(`Health check failed: ${JSON.stringify(health)}`);
    }
    console.log('✔ /api/health responded 200 ok');

    const bootstrapStatus = await request('GET', '/bootstrap/status');
    if (bootstrapStatus.status !== 200 || !bootstrapStatus.data?.success) {
      throw new Error(`Bootstrap status failed: ${JSON.stringify(bootstrapStatus)}`);
    }
    console.log('✔ /api/bootstrap/status responded 200');

    const unauthTasks = await request('GET', '/tasks');
    if (unauthTasks.status !== 401) {
      throw new Error(`Expected 401 on unauthenticated /tasks, got ${unauthTasks.status}`);
    }
    console.log('✔ /api/tasks fails closed (401) when unauthenticated');

    const unauthSub = await request('GET', '/subscriptions/current');
    if (unauthSub.status !== 401) {
      throw new Error(`Expected 401 on unauthenticated /subscriptions/current, got ${unauthSub.status}`);
    }
    console.log('✔ /api/subscriptions/current fails closed (401) when unauthenticated');

    console.log('\n🎉 Verification checks passed.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Verification failed:', err);
    process.exit(1);
  } finally {
    if (server) server.close();
  }
}

runVerification();
