// ─────────────────────────────────────────────────────────────────────────
// BlueSpot Hub — SW Host Worker (multi-hub)
// ─────────────────────────────────────────────────────────────────────────
// Routes (add these in Cloudflare):
//   hub.bluespotguide.com/*/sw.js
//   hub.bluespotguide.com/*/manifest.json
//   hub.bluespotguide.com/manifest.json   ← catches GHL framework's root manifest request
// ─────────────────────────────────────────────────────────────────────────

const HUBS = {
  'stone-mountain': {
    name: 'Stone Mountain Park Campground. ',
    short_name: 'Stone Mountain Park Campground. ',
    icon: 'https://i.ibb.co/ycPVs1k9/2c3eafaa2fd1.jpg',
  },
  'stone-mountain-park-hub': {
    name: 'Stone Mountain Park Campground',
    short_name: 'Stone Mountain Park Campground',
    icon: 'https://i.ibb.co/tw3TD0bX/5d88370f0ac4.jpg',
  },
  'sanwar-rv-resort': {
    name: 'Sanwar RV Resort',
    short_name: 'Sanwar RV',
    icon: 'https://i.ibb.co/352V9Kd0/8d6fd4f3c751.jpg',
  },
  'sanwar-rv-resort-hub': {
    name: 'Sanwar RV Resort',
    short_name: 'Sanwar RV',
    icon: 'https://i.ibb.co/352V9Kd0/8d6fd4f3c751.jpg',
  },
  'winding-waters-rv-resort': {
    name: 'Winding Waters RV Resort',
    short_name: 'Winding Waters',
    icon: 'https://i.ibb.co/FFks5ys/fb5bf57345b8.jpg',
  },
  'winding-waters-rv-resort-hub': {
    name: 'Winding Waters RV Resort',
    short_name: 'Winding Waters',
    icon: 'https://i.ibb.co/FFks5ys/fb5bf57345b8.jpg',
  },
  'sweetwater-valley-park': {
    name: 'Sweetwater Valley Park',
    short_name: 'Sweetwater Valley',
    icon: 'https://i.ibb.co/gZsBmsW7/e4354384da4f.jpg',
  },
};

const FIREBASE_CONFIG = `{
  apiKey: "AIzaSyAAqyUeAMIWHhEAxjeJaWdCokpTRpfxXM0",
  authDomain: "bluespot-hub.firebaseapp.com",
  databaseURL: "https://bluespot-hub-default-rtdb.firebaseio.com",
  projectId: "bluespot-hub",
  storageBucket: "bluespot-hub.firebasestorage.app",
  messagingSenderId: "819010976218",
  appId: "1:819010976218:web:3f8ce672704169cee528e3"
}`;

function buildSW(hubId, icon) {
  return `
const ICON = '${icon}';
const HUB_PATH = '/${hubId}';

self.addEventListener('push', event => {
  let title = 'Park Hub Update';
  let body = 'Tap to see the latest announcements.';

  try {
    if (event.data) {
      const d = event.data.json();
      const n = d.notification || d.data || d;
      title = n.title || d.title || title;
      body  = n.body  || d.body  || body;
    }
  } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: ICON,
      badge: ICON,
      vibrate: [200, 100, 200],
      data: { url: HUB_PATH },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const target = event.notification.data?.url || HUB_PATH;
      for (const c of list) {
        if (c.url.includes(HUB_PATH) && 'focus' in c) return c.focus();
      }
      return clients.openWindow(target);
    })
  );
});

const CACHE = 'park-hub-${hubId}-v4';
const SKIP = ['firebase', 'gstatic', 'googleapis', 'workers.dev', 'filesafe.space', 'ibb.co'];

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const host = new URL(e.request.url).hostname;
  if (SKIP.some(s => host.includes(s))) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res && res.status === 200 && res.type !== 'opaque') {
        const clone = res.clone(); // clone synchronously before any async ops
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
`;
}

function buildManifest(hubId, hub) {
  return JSON.stringify({
    name: hub.name,
    short_name: hub.short_name,
    description: 'Your campground companion — announcements, amenities, activities and more.',
    start_url: `/${hubId}`,
    scope: '/',
    display: 'standalone',
    background_color: '#1a4a7a',
    theme_color: '#1a56db',
    orientation: 'portrait-primary',
    icons: [
      { src: hub.icon, sizes: '192x192', type: 'image/jpeg', purpose: 'any' },
      { src: hub.icon, sizes: '512x512', type: 'image/jpeg', purpose: 'any' },
    ],
  });
}

// Resolve hub from Referer header path when no hubId in URL (e.g. /manifest.json root request)
function hubFromReferer(request) {
  const ref = request.headers.get('Referer') || '';
  try {
    const refPath = new URL(ref).pathname.split('/').filter(Boolean);
    if (refPath[0] && HUBS[refPath[0]]) return { hubId: refPath[0], hub: HUBS[refPath[0]] };
  } catch {}
  return null;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const cors = { 'Access-Control-Allow-Origin': request.headers.get('Origin') || '*' };

    // Handle root /manifest.json (GHL framework overrides <link rel="manifest">)
    if (parts.length === 1 && parts[0] === 'manifest.json') {
      const match = hubFromReferer(request);
      if (match) {
        return new Response(buildManifest(match.hubId, match.hub), {
          headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache', ...cors },
        });
      }
      return new Response('Not found', { status: 404 });
    }

    // Expected: /hubId/sw.js  or  /hubId/manifest.json
    const hubId = parts[0];
    const file = parts[1];
    const hub = HUBS[hubId];

    if (!hub || !file) {
      return new Response('Not found', { status: 404 });
    }

    if (file === 'sw.js') {
      return new Response(buildSW(hubId, hub.icon), {
        headers: {
          'Content-Type': 'application/javascript',
          'Service-Worker-Allowed': '/',
          'Cache-Control': 'no-cache',
          ...cors,
        },
      });
    }

    if (file === 'manifest.json') {
      return new Response(buildManifest(hubId, hub), {
        headers: {
          'Content-Type': 'application/manifest+json',
          'Cache-Control': 'no-cache',
          ...cors,
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
