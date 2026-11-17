// ============================================================
// FCM PUSH CONFIGURATION VERIFICATION SUITE
// ============================================================

import http from 'http';
import app from './server/dist/app.js';

const PORT = 5566;

function request(method, path) {
  const url = `http://localhost:${PORT}/api${path.startsWith('/') ? path : '/' + path}`;
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
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
    req.end();
  });
}

async function runFcmCheck() {
  let server;
  try {
    await new Promise((resolve) => {
      server = app.listen(PORT, resolve);
    });

    const cfg = await request('GET', '/push/config');
    if (cfg.status !== 200 || !cfg.data?.success || !cfg.data?.data?.projectId) {
      throw new Error(`Push config failed: ${JSON.stringify(cfg)}`);
    }
    console.log(`✔ /api/push/config returned projectId=${cfg.data.data.projectId}`);

    const devices = await request('GET', '/push/devices');
    if (devices.status !== 401) {
      throw new Error(`Expected 401 on unauthenticated /push/devices, got ${devices.status}`);
    }
    console.log('✔ /api/push/devices fails closed (401) when unauthenticated');

    process.exit(0);
  } catch (err) {
    console.error('❌ FCM check failed:', err);
    process.exit(1);
  } finally {
    if (server) server.close();
  }
}

runFcmCheck();
