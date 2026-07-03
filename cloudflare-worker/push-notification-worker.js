// ─────────────────────────────────────────────────────────────────────────
// BlueSpot Hub — Push / Email / SMS Notification Worker
// ─────────────────────────────────────────────────────────────────────────
// Handles notifications for hub announcements and events:
//   POST /                  → FCM push notifications
//   POST /send-sms          → Twilio SMS to active hub guests
//   POST /send-email        → Resend (legacy, basic HTML + carrier SMS)
//   POST /send-email-resend → Resend (rich HTML emails + carrier SMS, active guests only)
//
// ENVIRONMENT VARIABLES (Cloudflare Worker → Settings → Variables → Encrypt):
//   FIREBASE_PROJECT_ID   = bluespot-hub
//   FIREBASE_CLIENT_EMAIL = <service account email>
//   FIREBASE_PRIVATE_KEY  = <service account private key>
//   DATABASE_URL          = https://bluespot-hub-default-rtdb.firebaseio.com
//   ALLOWED_ORIGIN        = * (or your domain)
//   RESEND_API_KEY        = re_xxxxxxxx               ← resend.com → API Keys
//   RESEND_FROM_EMAIL     = noreply@mail.yourdomain.com ← verified sender
//   RESEND_SENDER_NAME    = BlueSpot Hub              ← display name in inbox
//   SENDBLUE_API_KEY      = <your api key>            ← sendblue.co API key
//   SENDBLUE_API_SECRET   = <your api secret>         ← sendblue.co API secret
//   TWILIO_ACCOUNT_SID    = ACxxxxxxxxxxxxxxxx        ← Twilio (optional)
//   TWILIO_AUTH_TOKEN     = xxxxxxxxxxxxxxxx          ← Twilio (optional)
//   TWILIO_FROM_NUMBER    = +1xxxxxxxxxx              ← Twilio (optional)
// ─────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, corsHeaders);

    const url = new URL(request.url);

    try {
      if (url.pathname === '/send-sms') {
        return await handleSms(request, env, corsHeaders);
      }
      if (url.pathname === '/send-sms-sendblue') {
        return await handleSendBlueSms(request, env, corsHeaders);
      }
      if (url.pathname === '/send-email') {
        return await handleEmail(request, env, corsHeaders);
      }
      if (url.pathname === '/send-email-resend') {
        return await handleResendEmail(request, env, corsHeaders);
      }
      if (url.pathname === '/send-welcome') {
        return await handleWelcomeEmail(request, env, corsHeaders);
      }
      // Default: FCM push
      return await handlePush(request, env, corsHeaders);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500, corsHeaders);
    }
  },
};

// ── FCM Push (existing behaviour) ─────────────────────────────────────────

async function handlePush(request, env, corsHeaders) {
  const { hubId, title, body, idToken } = await request.json();
  if (!hubId || !title || !idToken) return json({ error: 'Missing fields' }, 400, corsHeaders);

  const callerUid = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
  if (!callerUid) return json({ error: 'Unauthorized' }, 401, corsHeaders);

  const accessToken = await getServiceAccountAccessToken(env);
  const today = new Date().toISOString().split('T')[0];

  // ── Active guests: departure not yet passed (or no departure date on file) ──
  const allGuests = await loadGuests(env.DATABASE_URL, hubId, accessToken);
  const activeGuests = allGuests.filter(g => {
    const dep = g.departureDate || g.stayDetails?.departureDate;
    return !dep || dep >= today;
  });

  // ── FCM tokens from active guest records ─────────────────────────────────
  const guestTokens = activeGuests.map(g => g.fcmToken?.token).filter(Boolean);
  const guestTokenSet = new Set(guestTokens);

  // Also include tokens in the raw bucket that aren't linked to any guest
  // (users who enabled push without completing a guest profile)
  const hubTokensData = await dbGet(env.DATABASE_URL, `hubs/${hubId}/fcmTokens`, accessToken) || {};
  const unlinkedTokens = Object.values(hubTokensData)
    .map(t => t.token)
    .filter(t => t && !guestTokenSet.has(t));

  const tokens = [...guestTokens, ...unlinkedTokens];

  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`;
  let sent = 0, webSent = 0;
  const staleTokens = [];

  for (const token of tokens) {
    const res = await fetch(fcmUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          webpush: {
            headers: { Urgency: 'high', TTL: '86400' },
            notification: {
              title, body,
              icon: 'https://assets.cdn.filesafe.space/Sk7XUXxjVtIrJHKp3GhX/media/6a2ff4421b95dbb2c2e8e5c1.png',
              badge: 'https://assets.cdn.filesafe.space/Sk7XUXxjVtIrJHKp3GhX/media/6a2ff4421b95dbb2c2e8e5c1.png',
              vibrate: [200, 100, 200],
              requireInteraction: false,
            },
            fcm_options: { link: '/' },
          },
        },
      }),
    });
    if (res.ok) {
      sent++;
    } else {
      const err = await res.json().catch(() => ({}));
      if (err?.error?.details?.some(d => d.errorCode === 'UNREGISTERED')) staleTokens.push(token);
    }
  }

  for (const token of staleTokens) {
    const key = token.replace(/\./g, '_');
    await dbDelete(env.DATABASE_URL, `hubs/${hubId}/fcmTokens/${key}`, accessToken).catch(() => {});
    await dbDelete(env.DATABASE_URL, `hubs/_global/fcmTokens/${key}`, accessToken).catch(() => {});
  }

  // ── Web Push subscriptions (iOS 16.4+) — active guests only ────────────
  const webErrors = [];
  if (env.VAPID_PRIVATE_KEY && env.VAPID_PUBLIC_KEY) {
    // Collect subs stored on active guest records
    const guestSubs = activeGuests
      .map(g => g.webPushSub)
      .filter(s => s && s.endpoint && s.p256dh && s.auth);
    const guestEndpoints = new Set(guestSubs.map(s => s.endpoint));

    // Also include subs in the raw bucket not linked to any guest
    const rawSubs = await dbGet(env.DATABASE_URL, `hubs/${hubId}/webPushSubs`, accessToken) || {};
    const unlinkedSubs = Object.values(rawSubs)
      .filter(s => s && s.endpoint && s.p256dh && s.auth && !guestEndpoints.has(s.endpoint));

    const subs = [...guestSubs, ...unlinkedSubs];
    for (const sub of subs) {
      try {
        await sendWebPush(sub, { title, body }, env);
        webSent++;
      } catch (e) {
        webErrors.push(e.message);
      }
    }
  } else {
    webErrors.push('VAPID_PRIVATE_KEY or VAPID_PUBLIC_KEY not set in env');
  }

  return json({ sent, webSent, total: tokens.length, staleRemoved: staleTokens.length, webErrors }, 200, corsHeaders);
}

// ── Native Web Push — RFC 8291 (aes128gcm) for iOS 16.4+ ─────────────────
async function sendWebPush(sub, payload, env) {
  const enc = s => new TextEncoder().encode(s);

  // ── VAPID JWT ────────────────────────────────────────────────────────────
  const audience = new URL(sub.endpoint).origin;
  const expiry   = Math.floor(Date.now() / 1000) + 12 * 3600;
  const jwtHeader = base64UrlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const jwtClaims = base64UrlEncode(JSON.stringify({ aud: audience, exp: expiry, sub: 'mailto:admin@bluespotguide.com' }));
  const unsigned  = `${jwtHeader}.${jwtClaims}`;

  // Import VAPID private key: raw 32-byte EC key → wrap in PKCS8 DER
  const rawPriv = base64urlToBytes(env.VAPID_PRIVATE_KEY);
  const pkcs8   = wrapP256InPkcs8(rawPriv);
  const privKey = await crypto.subtle.importKey(
    'pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sigBytes = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privKey, enc(unsigned)
  ));
  const jwt = `${unsigned}.${bytesToBase64Url(sigBytes)}`;

  // ── RFC 8291 payload encryption (aes128gcm) ──────────────────────────────
  const plaintext        = enc(JSON.stringify({ title: payload.title, body: payload.body }));
  const subscriberPub    = base64urlToBytes(sub.p256dh);
  const authSecret       = base64urlToBytes(sub.auth);
  const salt             = crypto.getRandomValues(new Uint8Array(16));

  // Ephemeral ECDH key pair
  const ephKP      = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephPubRaw  = new Uint8Array(await crypto.subtle.exportKey('raw', ephKP.publicKey));
  const subPubKey  = await crypto.subtle.importKey('raw', subscriberPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: subPubKey }, ephKP.privateKey, 256));

  // PRK = HKDF-Extract(auth_secret, ecdh_secret)
  const prk = await hkdfExtract(authSecret, ecdhSecret);

  // IKM = HKDF-Expand(PRK, "WebPush: info\x00" || sub_pub || eph_pub, 32)
  const keyInfo = wpConcat(enc('WebPush: info\x00'), subscriberPub, ephPubRaw);
  const ikm     = await hkdfExpand(prk, wpConcat(keyInfo, new Uint8Array([1])), 32);

  // PRK2 = HKDF-Extract(salt, ikm)
  const prk2  = await hkdfExtract(salt, ikm);
  const cek   = await hkdfExpand(prk2, enc('Content-Encoding: aes128gcm\x00\x01'), 16);
  const nonce = await hkdfExpand(prk2, enc('Content-Encoding: nonce\x00\x01'), 12);

  // AES-GCM encrypt: plaintext + \x02 delimiter (no padding)
  const toEncrypt = wpConcat(plaintext, new Uint8Array([0x02]));
  const aesKey    = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, toEncrypt));

  // RFC 8291 content header: salt(16) + rs(4 BE) + keyid_len(1) + eph_pub(65) + ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const body = wpConcat(salt, rs, new Uint8Array([65]), ephPubRaw, ciphertext);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`WebPush ${res.status}: ${txt}`);
  }
}

// Wrap raw 32-byte P-256 private key in PKCS8 DER structure
function wrapP256InPkcs8(rawKey) {
  const prefix = new Uint8Array([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07,
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04,
    0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
  ]);
  const out = new Uint8Array(prefix.length + rawKey.length);
  out.set(prefix); out.set(rawKey, prefix.length);
  return out;
}

function base64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  return base64ToBytes(b64 + pad);
}

async function hkdfExtract(salt, ikm) {
  const saltKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm));
}

async function hkdfExpand(prk, info, length) {
  const prkKey = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', prkKey, info)).slice(0, length);
}

function wpConcat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function concat(...arrays) {
  return wpConcat(...arrays);
}

// ── Carrier email-to-SMS gateways (100% free) ─────────────────────────────

const CARRIER_GATEWAYS = {
  // ── USA ──
  att:        'txt.att.net',
  verizon:    'vtext.com',
  tmobile:    'tmomail.net',
  sprint:     'messaging.sprintpcs.com',
  boost:      'sms.myboostmobile.com',
  cricket:    'sms.cricketwireless.net',
  metro:      'mymetropcs.com',
  uscellular: 'email.uscc.net',

  // ── CANADA ──
  bell:       'txt.bell.ca',
  rogers:     'pcs.rogers.com',
  telus:      'msg.telus.com',

  // ── UK ──
  o2:         'mms.o2.co.uk',
  vodafone:   'vodafone.net.uk',
  ee:         'orange.net',
  three:      'x.co.uk',

  // ── EUROPE ──
  dt:         't-mobile.de',
  orange:     'orange.fr',
  swisscom:   'bluewin.ch',
  tim:        'tim.it',
  movistar:   'movistar.es',
  proximus:   'sms.proximus.be',

  // ── AUSTRALIA ──
  telstra:    'telstra.com.au',
  vodafone_au: 'voicemail.vodafone.com.au',
  optus:      'optus.com.au',

  // ── INDIA ──
  airtel:     'airtelxstream.in',
  jio:        'jio.com',
  vodafone_in: 'vodafone.in',
  bsnl:       'bsnlmobil.com',

  // ── PHILIPPINES ──
  globe:      'globetxt.com.ph',
  smart:      'smtpgateway.smart.com.ph',
};

// ── SMS via Twilio ─────────────────────────────────────────────────────────

async function handleSms(request, env, corsHeaders) {
  const { hubId, title, body, idToken } = await request.json();
  if (!hubId || !title || !idToken) return json({ error: 'Missing fields' }, 400, corsHeaders);
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER)
    return json({ error: 'Twilio env vars not configured' }, 500, corsHeaders);

  const callerUid = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
  if (!callerUid) return json({ error: 'Unauthorized' }, 401, corsHeaders);

  const accessToken = await getServiceAccountAccessToken(env);
  const guests      = await loadGuests(env.DATABASE_URL, hubId, accessToken);

  const smsText = `${title}\n\n${body}`;
  let sent = 0, failed = 0;

  for (const g of guests) {
    if (!g.phone) continue;
    const phone = normalizePhone(g.phone);
    if (!phone) continue;

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: env.TWILIO_FROM_NUMBER, To: phone, Body: smsText }),
      }
    );
    res.ok ? sent++ : failed++;
  }

  return json({ sent, failed, total: guests.length }, 200, corsHeaders);
}

// ── SMS via SendBlue ───────────────────────────────────────────────────────

async function handleSendBlueSms(request, env, corsHeaders) {
  const { hubId, title, body, idToken } = await request.json();
  if (!hubId || !title || !idToken) return json({ error: 'Missing fields' }, 400, corsHeaders);
  if (!env.SENDBLUE_API_KEY || !env.SENDBLUE_API_SECRET)
    return json({ error: 'SendBlue env vars not configured' }, 500, corsHeaders);

  const callerUid = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
  if (!callerUid) return json({ error: 'Unauthorized' }, 401, corsHeaders);

  const accessToken = await getServiceAccountAccessToken(env);
  const guests      = await loadGuests(env.DATABASE_URL, hubId, accessToken);

  const smsText = `Announcement from ${name}:\n${title}\n\nView details: hub.bluespotguide.com`.slice(0, 160);
  let sent = 0, failed = 0, errors = [];

  for (const g of guests) {
    if (!g.phone) continue;
    const phone = normalizePhone(g.phone);
    if (!phone) continue;

    try {
      const res = await fetch('https://api.sendblue.co/api/send-message', {
        method: 'POST',
        headers: {
          'sb-api-key-id': env.SENDBLUE_API_KEY,
          'sb-api-secret-key': env.SENDBLUE_API_SECRET,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from_number: env.SENDBLUE_FROM_NUMBER,
          number: phone,
          content: smsText,
        }),
      });

      if (res.ok) {
        sent++;
      } else {
        failed++;
        const errData = await res.json().catch(() => ({}));
        errors.push(`${phone}: ${errData.message || res.statusText}`);
      }
    } catch (e) {
      failed++;
      errors.push(`${phone}: ${e.message}`);
    }
  }

  return json({
    sent,
    failed,
    total: guests.length,
    errors: errors.slice(0, 5), // include first 5 errors for debugging
  }, 200, corsHeaders);
}

// ── Email via Resend ───────────────────────────────────────────────────────

async function handleEmail(request, env, corsHeaders) {
  const { hubId, title, body, hubName, idToken } = await request.json();
  if (!hubId || !title || !idToken) return json({ error: 'Missing fields' }, 400, corsHeaders);
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL)
    return json({ error: 'Resend env vars not configured' }, 500, corsHeaders);

  const callerUid = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
  if (!callerUid) return json({ error: 'Unauthorized' }, 401, corsHeaders);

  const accessToken = await getServiceAccountAccessToken(env);
  const guests      = await loadGuests(env.DATABASE_URL, hubId, accessToken);

  const name = hubName || hubId;
  let sent = 0, smsSent = 0, failed = 0;

  for (const g of guests) {
    // ── Email ──
    if (g.email) {
      const html = `
        <div style="font-family:'DM Sans',Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#0f172a;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px;">
            <div style="width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#2563eb,#60a5fa);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              <span style="color:#fff;font-size:18px;">📍</span>
            </div>
            <div>
              <div style="font-size:17px;font-weight:700;">${name}</div>
              <div style="font-size:12px;color:#94a3b8;">Guest Announcement</div>
            </div>
          </div>
          <h2 style="font-size:20px;font-weight:800;margin:0 0 12px;">${title}</h2>
          <p style="font-size:14px;line-height:1.7;color:#475569;margin:0 0 28px;">${body.replace(/\n/g, '<br>')}</p>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin-bottom:20px;">
          <p style="font-size:11px;color:#94a3b8;">You're receiving this because you registered as a guest at ${name}.</p>
        </div>`;

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${name} <${env.RESEND_FROM_EMAIL}>`,
          to:   [g.email],
          subject: `${title} — ${name}`,
          html,
        }),
      });
      res.ok ? sent++ : failed++;
    }

    // ── Free SMS via carrier email gateway ──
    const gateway = g.carrier && CARRIER_GATEWAYS[g.carrier];
    if (gateway && g.phone && env.RESEND_API_KEY && env.RESEND_FROM_EMAIL) {
      const digits = g.phone.replace(/\D/g, '').slice(-10);
      if (digits.length === 10) {
        const smsAddress = `${digits}@${gateway}`;
        // SMS body must be short — carriers truncate long messages
        const smsBody = `${name}: ${title}\n${body.slice(0, 140)}`;
        const smsRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: env.RESEND_FROM_EMAIL,
            to:   [smsAddress],
            subject: title,
            text: smsBody,   // plain text only — SMS gateways ignore HTML
          }),
        });
        if (smsRes.ok) smsSent++;
      }
    }
  }

  return json({ sent, smsSent, failed, total: guests.length }, 200, corsHeaders);
}

// ── Email via Resend (rich HTML, active guests only) ───────────────────────

async function handleResendEmail(request, env, corsHeaders) {
  const { hubId, type, title, body, hubName, eventDate, eventHours, idToken } = await request.json();
  if (!hubId || !title || !idToken) return json({ error: 'Missing fields' }, 400, corsHeaders);
  if (!env.RESEND_API_KEY) return json({ error: 'RESEND_API_KEY not configured' }, 500, corsHeaders);

  const callerUid = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
  if (!callerUid) return json({ error: 'Unauthorized' }, 401, corsHeaders);

  const accessToken = await getServiceAccountAccessToken(env);
  const guests = await loadGuests(env.DATABASE_URL, hubId, accessToken);
  const today = new Date().toISOString().split('T')[0];
  const activeGuests = guests.filter(g => {
    const dep = g.stayDetails?.departureDate;
    if (!dep) return true;  // no stay info yet — include them
    return dep >= today;    // active = departure is today or future
  });
  const emailGuests = activeGuests.filter(g => g.email);
  const smsGuestsForSendBlue = activeGuests.filter(g => g.phone);

  const name        = hubName || hubId;
  const senderEmail = env.RESEND_FROM_EMAIL   || 'noreply@bluespotconnect.com';
  let sent = 0, smsSent = 0, failed = 0, smsFailed = 0;

  for (const g of emailGuests) {
    const toName  = `${g.firstName || ''} ${g.lastName || ''}`.trim() || 'Guest';
    const isEvent = type === 'event';
    const html    = isEvent
      ? buildEventEmail(name, title, body, toName, eventDate || '', eventHours || '')
      : buildAnnouncementEmail(name, title, body, toName);
    const subject = isEvent
      ? `🔔 Happening Now at ${name}: ${title}`
      : `Hey ${toName}, ${name} has a new update for you!`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: senderEmail,
        to:   [g.email],
        subject,
        html,
      }),
    });
    res.ok ? sent++ : failed++;
  }

  // ── SMS: SendBlue only ──
  for (const g of smsGuestsForSendBlue) {
    const phone = normalizePhone(g.phone);
    if (!phone) continue;

    if (!env.SENDBLUE_API_KEY || !env.SENDBLUE_API_SECRET) continue;

    try {
      const smsBody = `${name}: ${title}`.slice(0, 160);
      const smsRes = await fetch('https://api.sendblue.co/api/send-message', {
        method: 'POST',
        headers: {
          'sb-api-key-id': env.SENDBLUE_API_KEY,
          'sb-api-secret-key': env.SENDBLUE_API_SECRET,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from_number: env.SENDBLUE_FROM_NUMBER,
          number: phone,
          content: smsBody,
        }),
      });
      if (smsRes.ok) {
        smsSent++;
      } else {
        smsFailed++;
        const errData = await smsRes.json().catch(() => ({}));
        console.error(`[SendBlue SMS] Failed for ${phone}: ${smsRes.status} ${JSON.stringify(errData)}`);
      }
    } catch (e) {
      smsFailed++;
      console.error(`[SendBlue SMS] Error for ${phone}: ${e.message}`);
    }
  }

  return json({ sent, smsSent, smsFailed, failed, total: emailGuests.length, smsSentTo: smsGuestsForSendBlue.length }, 200, corsHeaders);
}

// ── Welcome / account-created email to a single new user (Resend) ──────────
async function handleWelcomeEmail(request, env, corsHeaders) {
  const { idToken, email, name, password, loginUrl } = await request.json();
  if (!idToken || !email || !password) return json({ error: 'Missing fields' }, 400, corsHeaders);
  if (!env.RESEND_API_KEY) return json({ error: 'RESEND_API_KEY not configured' }, 500, corsHeaders);

  // Only an authenticated admin may trigger this.
  const callerUid = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
  if (!callerUid) return json({ error: 'Unauthorized' }, 401, corsHeaders);

  const senderEmail = env.RESEND_FROM_EMAIL || 'noreply@bluespotconnect.com';
  const senderName  = env.RESEND_SENDER_NAME || 'BlueSpot Hub';
  const html = buildWelcomeEmail(name || 'there', email, password, loginUrl || '');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${senderName} <${senderEmail}>`,
      to:   [email],
      subject: 'Your BlueSpot Hub account is ready',
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return json({ error: err?.message || 'Resend send failed', sent: 0 }, 502, corsHeaders);
  }
  return json({ sent: 1 }, 200, corsHeaders);
}

function buildWelcomeEmail(toName, loginEmail, loginPassword, loginUrl) {
  const btn = loginUrl
    ? `<a href="${loginUrl}" style="display:inline-block;background:#1a56db;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:10px;">Open the Control Panel →</a>`
    : '';
  return `<!DOCTYPE html><html><body style="margin:0;background:#f0f4ff;font-family:'Segoe UI',Arial,sans-serif;color:#0f1f4a;">
    <div style="max-width:520px;margin:0 auto;padding:32px 20px;">
      <div style="background:#fff;border:1px solid #dde5f5;border-radius:18px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#1a3a6b,#2a52a0);padding:26px 28px;color:#fff;">
          <div style="font-size:18px;font-weight:800;">BlueSpot Hub</div>
          <div style="font-size:12px;opacity:.8;">Admin Control Panel</div>
        </div>
        <div style="padding:26px 28px;">
          <h1 style="font-size:20px;margin:0 0 10px;">Welcome, ${toName}!</h1>
          <p style="font-size:14px;line-height:1.6;color:#3d5580;margin:0 0 18px;">
            An account has been created for you. Use the credentials below to sign in.
          </p>
          <div style="background:#f4f7fd;border:1px solid #cdd9ef;border-radius:12px;padding:16px 18px;margin-bottom:20px;font-size:14px;line-height:1.9;">
            <div><strong>Email:</strong> ${loginEmail}</div>
            <div><strong>Temporary password:</strong> ${loginPassword}</div>
          </div>
          ${btn}
          <p style="font-size:12px;color:#7890b8;margin:22px 0 0;line-height:1.6;">
            For your security, please change your password after your first sign-in.
          </p>
        </div>
      </div>
    </div>
  </body></html>`;
}

function buildAnnouncementEmail(hubName, title, body, toName) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
  <tr><td align="center" style="padding-bottom:20px;">
    <div style="display:inline-block;background:#dbeafe;border:1px solid #93c5fd;border-radius:30px;padding:6px 18px;">
      <span style="color:#1d4ed8;font-size:11px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;">📍 ${hubName}</span>
    </div>
  </td></tr>
  <tr><td style="background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#1e40af,#3b82f6);padding:36px 36px 28px;">
      <p style="margin:0 0 6px;color:rgba(255,255,255,0.75);font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">New Announcement</p>
      <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:800;line-height:1.25;">${title}</h1>
    </div>
    <div style="padding:32px 36px;">
      <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:#0f172a;">Hey, ${toName}! 👋</p>
      <p style="margin:0 0 24px;font-size:14px;color:#64748b;line-height:1.6;"><strong style="color:#1e293b;">${hubName}</strong> just posted a new announcement for you. Here's what you need to know:</p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:22px 24px;margin-bottom:28px;">
        <p style="margin:0 0 12px;font-size:16px;font-weight:700;color:#0f172a;">${title}</p>
        <p style="margin:0;font-size:14px;color:#475569;line-height:1.7;">${body.replace(/\n/g,'<br>')}</p>
      </div>
      <p style="margin:0 0 20px;font-size:14px;color:#334155;line-height:1.6;">Make sure to check your hub for more updates. We'll keep you posted on everything happening at <strong>${hubName}</strong>!</p>
      <div style="text-align:center;"><div style="display:inline-block;background:linear-gradient(135deg,#1d4ed8,#3b82f6);border-radius:10px;padding:13px 32px;"><span style="color:#ffffff;font-size:14px;font-weight:700;">Check Your Hub</span></div></div>
    </div>
    <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 36px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.8;">You're getting this because you're a registered guest at <strong style="color:#64748b;">${hubName}</strong>.<br>Questions? Contact the front office directly.</p>
    </div>
  </td></tr>
  <tr><td align="center" style="padding-top:20px;"><p style="margin:0;font-size:11px;color:#94a3b8;">&copy; ${hubName} · Powered by BlueSpot Hub</p></td></tr>
</table></td></tr></table>
</body></html>`;
}

function buildEventEmail(hubName, title, body, toName, eventDate, eventHours) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
  <tr><td align="center" style="padding-bottom:20px;">
    <div style="display:inline-block;background:#fef3c7;border:1px solid #f59e0b;border-radius:30px;padding:6px 18px;">
      <span style="color:#d97706;font-size:11px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;">🔔 Happening Now · ${hubName}</span>
    </div>
  </td></tr>
  <tr><td style="background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#d97706,#f59e0b);padding:36px 36px 28px;">
      <p style="margin:0 0 6px;color:rgba(255,255,255,0.8);font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">Event Starting Now</p>
      <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:800;line-height:1.25;">${title}</h1>
    </div>
    <div style="padding:32px 36px;">
      <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:#0f172a;">Hey, ${toName}! 👋</p>
      <p style="margin:0 0 24px;font-size:14px;color:#64748b;line-height:1.6;">Don't miss it — an event at <strong style="color:#1e293b;">${hubName}</strong> is happening right now!</p>
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:22px 24px;margin-bottom:24px;">
        <p style="margin:0 0 6px;font-size:18px;font-weight:800;color:#0f172a;">${title}</p>
        ${body ? `<p style="margin:0 0 16px;font-size:13px;color:#78716c;line-height:1.6;">${body.replace(/\n/g,'<br>')}</p>` : ''}
        <table cellpadding="0" cellspacing="0" width="100%"><tr>
          <td style="padding:8px 14px;background:#fff;border-radius:8px;border:1px solid #fde68a;width:48%;">
            <div style="font-size:9px;font-weight:700;color:#a16207;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Date</div>
            <div style="font-size:13px;font-weight:700;color:#0f172a;">${eventDate}</div>
          </td>
          <td style="width:4%;"></td>
          <td style="padding:8px 14px;background:#fff;border-radius:8px;border:1px solid #fde68a;width:48%;">
            <div style="font-size:9px;font-weight:700;color:#a16207;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Time</div>
            <div style="font-size:13px;font-weight:700;color:#0f172a;">${eventHours}</div>
          </td>
        </tr></table>
      </div>
      <p style="margin:0 0 20px;font-size:14px;color:#334155;line-height:1.6;">Head over now and enjoy the experience! Check your hub for location details.</p>
      <div style="text-align:center;"><div style="display:inline-block;background:linear-gradient(135deg,#d97706,#f59e0b);border-radius:10px;padding:13px 32px;"><span style="color:#ffffff;font-size:14px;font-weight:700;">View Event Details</span></div></div>
    </div>
    <div style="background:#fffbeb;border-top:1px solid #fde68a;padding:20px 36px;text-align:center;">
      <p style="margin:0;font-size:11px;color:#a16207;line-height:1.8;">You're getting this because you're a registered guest at <strong>${hubName}</strong>.</p>
    </div>
  </td></tr>
  <tr><td align="center" style="padding-top:20px;"><p style="margin:0;font-size:11px;color:#94a3b8;">&copy; ${hubName} · Powered by BlueSpot Hub</p></td></tr>
</table></td></tr></table>
</body></html>`;
}

// ── Shared helpers ─────────────────────────────────────────────────────────

async function loadGuests(databaseUrl, hubId, accessToken) {
  const hubsToRead = hubId === '_global'
    ? Object.keys(await dbGet(databaseUrl, 'hubs', accessToken) || {})
    : [hubId];
  const guests = [];
  for (const hid of hubsToRead) {
    const data = await dbGet(databaseUrl, `hubs/${hid}/guests`, accessToken);
    if (data) Object.values(data).forEach(g => guests.push(g));
  }
  return guests;
}

function normalizePhone(raw) {
  if (!raw) return null;
  // If already has +, return as-is
  if (raw.startsWith('+')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return null;
}

// ── Firebase helpers (unchanged) ───────────────────────────────────────────

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function verifyFirebaseIdToken(idToken, projectId) {
  const [headerB64, payloadB64, sigB64] = idToken.split('.');
  if (!headerB64 || !payloadB64 || !sigB64) return null;
  const header  = JSON.parse(base64UrlDecode(headerB64));
  const payload = JSON.parse(base64UrlDecode(payloadB64));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return null;
  if (payload.aud !== projectId) return null;
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (!payload.sub) return null;
  const jwkRes = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const { keys } = await jwkRes.json();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const data      = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToBytes(sigB64);
  const valid     = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  return valid ? payload.sub : null;
}

async function getServiceAccountAccessToken(env) {
  const now    = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: [
      'https://www.googleapis.com/auth/firebase.messaging',
      'https://www.googleapis.com/auth/firebase.database',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const claimsB64 = base64UrlEncode(JSON.stringify(claims));
  const unsigned  = `${headerB64}.${claimsB64}`;
  const key       = await importPrivateKey(env.FIREBASE_PRIVATE_KEY);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt       = `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(data));
  return data.access_token;
}

async function importPrivateKey(pem) {
  const cleaned = pem.replace(/\\n/g, '\n').replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  return crypto.subtle.importKey('pkcs8', base64ToBytes(cleaned), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

async function dbGet(databaseUrl, path, accessToken) {
  const res = await fetch(`${databaseUrl}/${path}.json`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return res.json();
}

async function dbDelete(databaseUrl, path, accessToken) {
  await fetch(`${databaseUrl}/${path}.json`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
}

function base64UrlEncode(str)    { return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function base64UrlDecode(str)    { return atob(str.replace(/-/g, '+').replace(/_/g, '/')); }
function base64UrlToBytes(str)   { const bin = base64UrlDecode(str); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
function bytesToBase64Url(bytes) { let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b); }); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function base64ToBytes(b64)      { const bin = atob(b64); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
