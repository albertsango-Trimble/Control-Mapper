// Cloudflare Worker entry point.
//
// wrangler.jsonc sets `run_worker_first: true`, so EVERY request comes
// through this fetch handler first — including static files like
// index.html and manifest.json. That's deliberate: Cloudflare's default
// static-asset serving doesn't add CORS headers, and Trimble Connect
// fetches manifest.json directly from the browser, which needs
// Access-Control-Allow-Origin present or the "Add extension" step fails
// with a generic "not a valid extension" error. So we fetch static files
// ourselves via env.ASSETS and stamp CORS headers onto every response.

const CANDIDATE_HOSTS = [
  'https://app.connect.trimble.com',
  'https://app21.connect.trimble.com',
  'https://app31.connect.trimble.com'
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/download-file') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === 'GET') {
        return handleDownload(request, url);
      }
    }

    // Everything else: serve the static file, then add CORS headers so
    // Trimble Connect (and any other external caller) can read it.
    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      const res = new Response(assetRes.body, assetRes);
      res.headers.set('Access-Control-Allow-Origin', '*');
      return res;
    }
    return new Response('Not found', { status: 404 });
  }
};

async function handleDownload(request, url) {
  const fileId = url.searchParams.get('fileId');
  const auth = request.headers.get('Authorization');

  if (!fileId) {
    return new Response('Missing fileId', { status: 400, headers: CORS_HEADERS });
  }
  if (!auth) {
    return new Response('Missing Authorization header', { status: 401, headers: CORS_HEADERS });
  }

  let lastStatus = null;
  let lastBody = '';

  for (const host of CANDIDATE_HOSTS) {
    try {
      const res = await fetch(`${host}/tc/api/2.0/files/${encodeURIComponent(fileId)}/data`, {
        headers: { Authorization: auth }
      });

      if (res.ok) {
        const text = await res.text();
        return new Response(text, {
          status: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'text/csv; charset=utf-8' }
        });
      }

      lastStatus = res.status;
      lastBody = await res.text().catch(() => '');
      // A 404 here plausibly means "wrong region" — try the next host.
    } catch (e) {
      lastStatus = 'network-error';
      lastBody = String(e);
    }
  }

  return new Response(
    `Could not fetch file from any known Trimble region host. Last status: ${lastStatus}. ${lastBody}`.slice(0, 500),
    { status: 502, headers: CORS_HEADERS }
  );
}
