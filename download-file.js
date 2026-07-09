// Cloudflare Pages Function — /api/download-file
//
// Runs server-side (no browser CORS restrictions apply here), so it can call
// Trimble Connect's Core API directly and hand the raw file content back to
// the extension over a same-origin request.
//
// The browser calls:  GET /api/download-file?fileId=<id>
//   with header:        Authorization: Bearer <trimble access token>
//
// Trimble Connect projects are split across regional API hosts. We don't
// know which one a given project lives on ahead of time, so we try the
// hosts Connect's own web app is observed calling (app / app21 / app31)
// and return the first one that succeeds.

const CANDIDATE_HOSTS = [
  'https://app.connect.trimble.com',
  'https://app21.connect.trimble.com',
  'https://app31.connect.trimble.com'
];

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const fileId = url.searchParams.get('fileId');
  const auth = request.headers.get('Authorization');

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  if (!fileId) {
    return new Response('Missing fileId', { status: 400, headers: corsHeaders });
  }
  if (!auth) {
    return new Response('Missing Authorization header', { status: 401, headers: corsHeaders });
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
          headers: { ...corsHeaders, 'Content-Type': 'text/csv; charset=utf-8' }
        });
      }

      lastStatus = res.status;
      lastBody = await res.text().catch(() => '');
      // 404 here plausibly means "wrong region" — try the next host.
      // Any other status (401/403/etc) is unlikely to differ by host, but we
      // still try them all rather than assume.
    } catch (e) {
      lastStatus = 'network-error';
      lastBody = String(e);
    }
  }

  return new Response(
    `Could not fetch file from any known Trimble region host. Last status: ${lastStatus}. ${lastBody}`.slice(0, 500),
    { status: 502, headers: corsHeaders }
  );
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    }
  });
}
