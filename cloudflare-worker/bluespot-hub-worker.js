// ─────────────────────────────────────────────────────────────────────────
// BlueSpot Hub — Proxy Worker
// ─────────────────────────────────────────────────────────────────────────
// Proxies all requests to GHL (sites.ludicrous.cloud) but strips the
// Content-Security-Policy header so the Service Worker can register.
// ─────────────────────────────────────────────────────────────────────────

const GHL_ORIGIN = 'https://sites.ludicrous.cloud';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Build the proxied URL pointing to GHL
    const proxyUrl = GHL_ORIGIN + url.pathname + url.search;

    // Forward the request to GHL with browser-like headers
    const proxyHeaders = new Headers(request.headers);
    proxyHeaders.set('Host', 'hub.bluespotguide.com');
    proxyHeaders.set('User-Agent', 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
    proxyHeaders.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    proxyHeaders.set('Accept-Language', 'en-US,en;q=0.5');
    proxyHeaders.set('Referer', 'https://hub.bluespotguide.com/');

    const proxyRequest = new Request(proxyUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: request.body,
      redirect: 'follow',
    });

    const response = await fetch(proxyRequest);

    // Copy all headers except CSP (which blocks our SW)
    const newHeaders = new Headers(response.headers);
    newHeaders.delete('content-security-policy');
    newHeaders.delete('content-security-policy-report-only');

    // Inject SW registration into HTML responses
    if (newHeaders.get('content-type')?.includes('text/html')) {
      let html = await response.text();

      // Inject manifest + SW registration before </head>
      const inject = `
<link rel="manifest" href="/manifest.json">
<meta name="mobile-web-app-capable" content="yes">
<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('https://hub.bluespotguide.com/sw.js', { scope: '/' })
      .then(function(reg) { console.log('SW registered:', reg.scope); })
      .catch(function(err) { console.log('SW failed:', err); });
  });
}
</script>`;

      html = html.replace('</head>', inject + '</head>');

      return new Response(html, {
        status: response.status,
        headers: newHeaders,
      });
    }

    return new Response(response.body, {
      status: response.status,
      headers: newHeaders,
    });
  },
};
