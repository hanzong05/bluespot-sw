// ─────────────────────────────────────────────────────────────────────────
// BlueSpot Hub — "Delete User" Cloudflare Worker
// ─────────────────────────────────────────────────────────────────────────
// Does the same job the Firebase Cloud Function would have done, but runs
// on Cloudflare's free tier (no credit card required) instead of Firebase's
// paid Blaze plan. Talks to Google's REST APIs directly using a Firebase
// service account, since the firebase-admin Node SDK can't run in the
// Workers runtime.
//
// WHAT IT DOES, step by step, on every request:
//   1. Reads { uid, idToken } from the POST body.
//   2. Verifies idToken really is a valid, unexpired Firebase ID token for
//      THIS project (so randos can't call this endpoint).
//   3. Looks up the calling user's profile in Realtime Database and checks
//      role === 'super' — only Super Admins may delete other users.
//   4. Mints a Google OAuth2 access token from the service account
//      (JWT signed with the service account's private key via Web Crypto).
//   5. Uses that access token to delete the target user from Firebase Auth
//      (Identity Toolkit REST API) and from Realtime Database.
//
// SETUP — done once, entirely through web dashboards, no CLI:
//
//  A) Get a Firebase service account (free on the Spark/no-cost plan):
//     Firebase Console → ⚙️ Project Settings → Service Accounts →
//     "Generate new private key" → downloads a JSON file. You'll need
//     three values out of it for step B: project_id, client_email,
//     private_key.
//
//  B) Create the Worker on Cloudflare (free, no card):
//     1. Go to https://dash.cloudflare.com → sign up/log in (just email).
//     2. Workers & Pages → Create → "Create Worker" → give it a name,
//        e.g. "bluespot-delete-user" → Deploy (deploys a placeholder).
//     3. Click "Edit code" (the Quick Edit web editor) → delete everything
//        in the editor → paste in this entire file → Save and Deploy.
//     4. Go to the Worker's Settings → Variables → "Add variable" for each
//        of these (click "Encrypt" for the private key so it's a secret):
//          FIREBASE_PROJECT_ID   = bluespot-hub
//          FIREBASE_CLIENT_EMAIL = <client_email from the JSON file>
//          FIREBASE_PRIVATE_KEY  = <private_key from the JSON file,
//                                   pasted exactly as-is, including the
//                                   -----BEGIN PRIVATE KEY----- lines
//                                   and \n sequences>
//          DATABASE_URL          = https://bluespot-hub-default-rtdb.firebaseio.com
//          ALLOWED_ORIGIN        = * (or your GHL domain, e.g.
//                                   https://yourdomain.com, once you know it)
//     5. Save. Your Worker now lives at a URL like:
//          https://bluespot-delete-user.<your-subdomain>.workers.dev
//        Copy that URL — you'll paste it into adminpanel.html's
//        DELETE_USER_WORKER_URL constant.
// ─────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, corsHeaders);
    }

    try {
      const { uid, idToken, action, newPassword } = await request.json();
      if (!uid || !idToken) {
        return json({ error: 'Missing uid or idToken' }, 400, corsHeaders);
      }

      // 1. Verify the caller's Firebase ID token.
      const callerUid = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
      if (!callerUid) {
        return json({ error: 'Invalid or expired session. Please sign in again.' }, 401, corsHeaders);
      }

      // 2. Get a Google access token for the service account.
      const accessToken = await getServiceAccountAccessToken(env);

      // 3. Confirm the caller is a Super Admin.
      // If no DB profile exists, the UI defaults to 'super' (original owner account).
      const callerProfile = await dbGet(env.DATABASE_URL, `users/${callerUid}`, accessToken);
      const isSuperAdmin = !callerProfile || callerProfile.role === 'super';
      if (!isSuperAdmin) {
        return json({ error: 'Only Super Admins can manage users.' }, 403, corsHeaders);
      }

      // ── Change password action ──
      if (action === 'updatePassword') {
        if (!newPassword || newPassword.length < 6) {
          return json({ error: 'Password must be at least 6 characters.' }, 400, corsHeaders);
        }
        await updateAuthUserPassword(env.FIREBASE_PROJECT_ID, uid, newPassword, accessToken);
        return json({ success: true }, 200, corsHeaders);
      }

      // ── Default action: delete user ──
      if (callerUid === uid) {
        return json({ error: "You can't delete your own account this way." }, 400, corsHeaders);
      }

      // 4. Delete the DB profile.
      await dbDelete(env.DATABASE_URL, `users/${uid}`, accessToken);

      // 5. Delete the Auth account (ignore "not found" — already gone is fine).
      await deleteAuthUser(env.FIREBASE_PROJECT_ID, uid, accessToken);

      return json({ success: true }, 200, corsHeaders);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500, corsHeaders);
    }
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// ── Verify a Firebase ID token using Google's public JWK set ──
async function verifyFirebaseIdToken(idToken, projectId) {
  const [headerB64, payloadB64, sigB64] = idToken.split('.');
  if (!headerB64 || !payloadB64 || !sigB64) return null;

  const header = JSON.parse(base64UrlDecode(headerB64));
  const payload = JSON.parse(base64UrlDecode(payloadB64));

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return null;
  if (payload.aud !== projectId) return null;
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (!payload.sub) return null;

  // Fetch Google's public keys for the securetoken service (JWK format).
  const jwkRes = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const { keys } = await jwkRes.json();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToBytes(sigB64);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  if (!valid) return null;

  return payload.sub; // the verified caller's uid
}

// ── Mint a Google OAuth2 access token from the service account ──
async function getServiceAccountAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: [
      'https://www.googleapis.com/auth/identitytoolkit',
      'https://www.googleapis.com/auth/firebase.database',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const claimsB64 = base64UrlEncode(JSON.stringify(claims));
  const unsigned = `${headerB64}.${claimsB64}`;

  const key = await importPrivateKey(env.FIREBASE_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;

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
  const cleaned = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binaryDer = base64ToBytes(cleaned);
  return crypto.subtle.importKey(
    'pkcs8', binaryDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
}

// ── Realtime Database REST helpers ──
async function dbGet(databaseUrl, path, accessToken) {
  const res = await fetch(`${databaseUrl}/${path}.json`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.json();
}
async function dbDelete(databaseUrl, path, accessToken) {
  await fetch(`${databaseUrl}/${path}.json`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ── Identity Toolkit REST: delete an Auth user ──
async function deleteAuthUser(projectId, uid, accessToken) {
  const res = await fetch('https://identitytoolkit.googleapis.com/v1/projects/' + projectId + '/accounts:delete', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ localId: uid }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body?.error?.message || '';
    if (!message.includes('USER_NOT_FOUND')) {
      throw new Error('Failed to delete Auth user: ' + message);
    }
  }
}

// ── Identity Toolkit REST: set a new password for an Auth user ──
async function updateAuthUserPassword(projectId, uid, newPassword, accessToken) {
  const res = await fetch('https://identitytoolkit.googleapis.com/v1/projects/' + projectId + '/accounts:update', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ localId: uid, password: newPassword }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error('Failed to update password: ' + (body?.error?.message || res.status));
  }
}

// ── base64url helpers ──
function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlDecode(str) {
  return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}
function base64UrlToBytes(str) {
  const bin = base64UrlDecode(str);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function bytesToBase64Url(bytes) {
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
