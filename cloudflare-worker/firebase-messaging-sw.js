importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAAqyUeAMIWHhEAxjeJaWdCokpTRpfxXM0",
  authDomain: "bluespot-hub.firebaseapp.com",
  databaseURL: "https://bluespot-hub-default-rtdb.firebaseio.com",
  projectId: "bluespot-hub",
  storageBucket: "bluespot-hub.firebasestorage.app",
  messagingSenderId: "819010976218",
  appId: "1:819010976218:web:3f8ce672704169cee528e3"
});

const messaging = firebase.messaging();

// Background push notification handler
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || 'BlueSpot Hub', {
    body: body || '',
    icon: 'https://assets.cdn.filesafe.space/Sk7XUXxjVtIrJHKp3GhX/media/6a2ff4421b95dbb2c2e8e5c1.png',
    badge: 'https://assets.cdn.filesafe.space/Sk7XUXxjVtIrJHKp3GhX/media/6a2ff4421b95dbb2c2e8e5c1.png',
    vibrate: [200, 100, 200],
    data: payload.data || {}
  });
});
