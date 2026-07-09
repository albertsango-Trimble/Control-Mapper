// Cloudflare Worker entry point.
//
// With `assets.directory` configured in wrangler.jsonc, static files in
// public/ (index.html, manifest.json, sample-points.csv) are served
// automatically for any request that matches a real file. Anything that
// doesn't match — just /api/download-file here — falls through to this
// fetch handler instead.

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

    // Fallback: let static assets handle it (should already have happened
    // automatically before this Worker ran, but this covers edge cases).
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
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
