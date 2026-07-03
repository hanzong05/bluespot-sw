// ─────────────────────────────────────────────────────────────────────────
// BlueSpot Hub — Password Reset Worker
// ─────────────────────────────────────────────────────────────────────────
//   POST /send-reset    { email }           → sends reset email via Resend
//   POST /verify-reset  { token, password } → validates token, updates password
//
// ENVIRONMENT VARIABLES (Cloudflare Worker → Settings → Variables):
//   FIREBASE_PROJECT_ID   = bluespot-hub                              ✓ set
//   FIREBASE_CLIENT_EMAIL = firebase-adminsdk-fbsvc@bluespot-hub...   ✓ set
//   FIREBASE_PRIVATE_KEY  = -----BEGIN PRIVATE KEY----- ...           ✓ set (Encrypt this one)
//   DATABASE_URL          = https://bluespot-hub-default-rtdb...      ✓ set
//   ALLOWED_ORIGIN        = *                                          ✓ set
//   RESEND_API_KEY        = re_PpeJCSZs_...                           ✓ set
//   RESEND_FROM_EMAIL     = noreply@send.bluespotconnect.com          ✓ set
//   RESEND_SENDER_NAME    = BlueSpot                                  ✓ set
//   RESET_PAGE_URL        = https://YOURSITE.com/reset-password.html  ← ADD THIS
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
      if (url.pathname === '/send-reset') {
        return await handleSendReset(request, env, corsHeaders);
      }
      if (url.pathname === '/verify-reset') {
        return await handleVerifyReset(request, env, corsHeaders);
      }
      return json({ error: 'Not found' }, 404, corsHeaders);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500, corsHeaders);
    }
  },
};

// ── POST /send-reset ──────────────────────────────────────────────────────
async function handleSendReset(request, env, corsHeaders) {
  const { email } = await request.json();
  if (!email) return json({ error: 'Email is required.' }, 400, corsHeaders);

  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    return json({ error: 'Email service not configured.' }, 500, corsHeaders);
  }

  // Verify the email exists in Firebase Auth before sending anything.
  const accessToken = await getServiceAccountAccessToken(env);
  const uid = await lookupUidByEmail(env.FIREBASE_PROJECT_ID, email, accessToken);
  // Always return success to prevent email enumeration — don't tell the caller if the account exists.
  if (!uid) return json({ ok: true }, 200, corsHeaders);

  // Generate a cryptographically random token (UUID).
  const token = crypto.randomUUID();
  const expires = Math.floor(Date.now() / 1000) + 3600; // 1 hour

  // Store in Firebase DB: passwordResets/{token}
  await dbSet(env.DATABASE_URL, `passwordResets/${token}`, { email, uid, expires }, accessToken);

  const resetUrl = `${env.RESET_PAGE_URL || 'https://yourdomain.com/reset-password.html'}?token=${token}`;
  const senderName = env.RESEND_SENDER_NAME || 'BlueSpot Hub';

  const emailBody = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#1a1d27;border-radius:12px;padding:40px;border:1px solid #2a2d3a;">
        <tr><td align="center" style="padding-bottom:28px;">
          <div style="font-size:28px;font-weight:800;color:#4fa3e8;letter-spacing:-0.5px;">BlueSpot Hub</div>
        </td></tr>
        <tr><td>
          <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#f0f2f8;">Reset your password</p>
          <p style="margin:0 0 24px;font-size:15px;color:#8b90a8;line-height:1.6;">
            We received a request to reset the password for your account (<strong style="color:#c0c4d8;">${email}</strong>).
            Click the button below to set a new password. This link expires in <strong style="color:#c0c4d8;">1 hour</strong>.
          </p>
          <a href="${resetUrl}" style="display:inline-block;background:#4fa3e8;color:#fff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 32px;border-radius:8px;margin-bottom:28px;">
            Reset Password
          </a>
          <p style="margin:0 0 8px;font-size:13px;color:#5a5f75;line-height:1.6;">
            Or copy and paste this link into your browser:
          </p>
          <p style="margin:0 0 24px;font-size:12px;color:#4fa3e8;word-break:break-all;">${resetUrl}</p>
          <hr style="border:none;border-top:1px solid #2a2d3a;margin:0 0 20px;">
          <p style="margin:0;font-size:12px;color:#5a5f75;line-height:1.6;">
            If you didn't request this, you can safely ignore this email — your password won't change.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${senderName} <${env.RESEND_FROM_EMAIL}>`,
      to: [email],
      subject: 'Reset your password',
      html: emailBody,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('Failed to send email: ' + (err?.message || res.status));
  }

  return json({ ok: true }, 200, corsHeaders);
}

// ── POST /verify-reset ────────────────────────────────────────────────────
async function handleVerifyReset(request, env, corsHeaders) {
  const { token, password } = await request.json();
  if (!token || !password) return json({ error: 'Missing token or password.' }, 400, corsHeaders);
  if (password.length < 6) return json({ error: 'Password must be at least 6 characters.' }, 400, corsHeaders);

  const accessToken = await getServiceAccountAccessToken(env);

  // Read the reset record from Firebase DB.
  const record = await dbGet(env.DATABASE_URL, `passwordResets/${token}`, accessToken);
  if (!record) return json({ error: 'Reset link is invalid or has already been used.' }, 400, corsHeaders);

  const now = Math.floor(Date.now() / 1000);
  if (record.expires < now) {
    // Clean up expired token.
    await dbDelete(env.DATABASE_URL, `passwordResets/${token}`, accessToken).catch(() => {});
    return json({ error: 'Reset link has expired. Please request a new one.' }, 400, corsHeaders);
  }

  // Update the user's password in Firebase Auth.
  await updateAuthUserPassword(env.FIREBASE_PROJECT_ID, record.uid, password, accessToken);

  // Delete the token so it can't be reused.
  await dbDelete(env.DATABASE_URL, `passwordResets/${token}`, accessToken).catch(() => {});

  return json({ ok: true }, 200, corsHeaders);
}

// ── Identity Toolkit: look up UID by email ────────────────────────────────
async function lookupUidByEmail(projectId, email, accessToken) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:lookup`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: [email] }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.users?.[0]?.localId || null;
}

// ── Identity Toolkit: set a new password ──────────────────────────────────
async function updateAuthUserPassword(projectId, uid, newPassword, accessToken) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:update`, {
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

// ── Realtime Database REST helpers ────────────────────────────────────────
async function dbGet(databaseUrl, path, accessToken) {
  const res = await fetch(`${databaseUrl}/${path}.json`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}
async function dbSet(databaseUrl, path, data, accessToken) {
  await fetch(`${databaseUrl}/${path}.json`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}
async function dbDelete(databaseUrl, path, accessToken) {
  await fetch(`${databaseUrl}/${path}.json`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ── Mint a Google OAuth2 access token from the service account ────────────
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

// ── base64url helpers ─────────────────────────────────────────────────────
function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesToBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
