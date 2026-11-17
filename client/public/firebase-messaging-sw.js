// ============================================================
// FIREBASE CLOUD MESSAGING (FCM) SERVICE WORKER
// Path: client/public/firebase-messaging-sw.js
// Served from root scope: /firebase-messaging-sw.js
// ============================================================

/* eslint-disable no-undef */

importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

const firebaseConfig = {
  projectId: "gen-lang-client-0707937978",
  appId: "1:759056051727:web:22b5ac72acb18b5a43fd7a",
  apiKey: "AIzaSyBoXlBfQ5qwWxqt7vBtSjP04D3PAM0Kon0",
  authDomain: "gen-lang-client-0707937978.firebaseapp.com",
  messagingSenderId: "759056051727"
};

try {
  if (typeof firebase !== 'undefined') {
    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    const messaging = firebase.messaging();

    messaging.onBackgroundMessage((payload) => {
      const notificationTitle =
        payload.notification?.title || payload.data?.title || 'TaskFlow Notification';

      const notificationBody =
        payload.notification?.body || payload.data?.body || 'You have a new update in TaskFlow.';

      const targetUrl =
        payload.data?.url || (payload.fcmOptions && payload.fcmOptions.link) || '/';

      const notificationOptions = {
        body: notificationBody,
        icon: '/favicon.svg',
        badge: '/favicon.svg',
        tag: payload.data?.tag || `taskflow-${Date.now()}`,
        data: {
          url: targetUrl,
          notificationId: payload.data?.notificationId,
          eventType: payload.data?.eventType,
          relatedTaskId: payload.data?.relatedTaskId,
        },
        requireInteraction: false,
      };

      return self.registration.showNotification(notificationTitle, notificationOptions);
    });
  }
} catch (err) {
  console.warn('[firebase-messaging-sw] Firebase SDK initialization notice:', err);
}

self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const raw = event.data.json();
    const title =
      raw.notification?.title || raw.data?.title || 'TaskFlow Notification';
    const body =
      raw.notification?.body || raw.data?.body || 'You have a new organizational task notification.';
    const targetUrl =
      raw.data?.url || raw.fcmOptions?.link || '/';

    const options = {
      body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: raw.data?.tag || `taskflow-${Date.now()}`,
      data: {
        url: targetUrl,
        ...raw.data,
      },
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch {
    // Ignore malformed push payload
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  let targetUrl = event.notification.data?.url || '/';
  if (!targetUrl.startsWith('/') && !targetUrl.startsWith(self.location.origin)) {
    targetUrl = '/';
  }

  event.waitUntil(
    clients
      .matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            if ('navigate' in client && targetUrl !== '/') {
              client.navigate(targetUrl);
            }
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});
