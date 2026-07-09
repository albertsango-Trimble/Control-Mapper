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
  'https://app32.connect.trimble.com', // confirmed from a real thumbnailUrl in this project's file-selected event
  'https://app.connect.trimble.com',
  'https://app21.connect.trimble.com',
  'https://app31.connect.trimble.com'
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

// Given a 200 response body from a candidate content endpoint, figure out
// whether it IS the CSV content, or whether it's JSON wrapping a further
// signed pointer URL to fetch (the pattern Trimble's thumbnailUrl field
// confirmed is real for this API). Returns the final text content, or null
// if this body doesn't look usable either way.
async function resolveContent(bodyText, auth) {
  try {
    const parsed = JSON.parse(bodyText);
    const innerUrl =
      parsed.url || parsed.downloadUrl || parsed.data ||
      (Array.isArray(parsed.thumbnailUrl) ? parsed.thumbnailUrl[0] : null);
    if (typeof innerUrl === 'string' && innerUrl.startsWith('http')) {
      const innerRes = await fetch(innerUrl, { headers: { Authorization: auth } });
      if (innerRes.ok) return await innerRes.text();
    }
    return null; // parsed as JSON but no usable pointer in it
  } catch {
    // Not JSON at all — if it looks like CSV-ish text (has commas/newlines
    // and isn't an HTML error page), treat it as the content directly.
    if (bodyText && !bodyText.trim().startsWith('<')) return bodyText;
    return null;
  }
}

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
  const versionId = url.searchParams.get('versionId');
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
      // Step 1: fetch file metadata. This is the well-established, standard
      // REST shape (GET /files/{id}) — far more likely to be correct than
      // guessing a raw content-download path outright. Include versionId
      // if we have one, since Trimble's own thumbnail URLs pass it too.
      const metaUrl = new URL(`${host}/tc/api/2.0/files/${encodeURIComponent(fileId)}`);
      if (versionId) metaUrl.searchParams.set('versionId', versionId);

      const metaRes = await fetch(metaUrl.toString(), {
        headers: { Authorization: auth }
      });

      if (!metaRes.ok) {
        lastStatus = metaRes.status;
        lastBody = await metaRes.text().catch(() => '');
        continue; // try next regional host
      }
      const meta = await metaRes.json();

      // We've now confirmed this host is correct for this project (metadata
      // resolved), and that /files/{id}/data is NOT a valid path (confirmed
      // INVALID_ENDPOINT on this exact host). Rather than guess one more
      // single path, try several plausible shapes for the content/download
      // endpoint — informed by Trimble's own docs referencing a "Download
      // File via URL" operation, and by the token-URL pattern its
      // thumbnailUrl field already proved is real for this API.
      const candidatePaths = [
        `/tc/api/2.0/files/${encodeURIComponent(fileId)}/downloadurl`,
        versionId ? `/tc/api/2.0/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/downloadurl` : null,
        `/tc/api/2.0/files/${encodeURIComponent(fileId)}/content`,
        versionId ? `/tc/api/2.0/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}` : null,
        versionId ? `/tc/api/2.0/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/content` : null
      ].filter(Boolean);

      const attempts = [];

      for (const path of candidatePaths) {
        const candidateUrl = `${host}${path}`;
        try {
          const candRes = await fetch(candidateUrl, { headers: { Authorization: auth } });
          if (!candRes.ok) {
            attempts.push(`${path} -> ${candRes.status}`);
            continue;
          }
          const bodyText = await candRes.text();
          const result = await resolveContent(bodyText, auth);
          if (result) {
            return new Response(result, {
              status: 200,
              headers: { ...CORS_HEADERS, 'Content-Type': 'text/csv; charset=utf-8' }
            });
          }
          attempts.push(`${path} -> 200 but not usable content/pointer: ${bodyText.slice(0, 150)}`);
        } catch (e) {
          attempts.push(`${path} -> network error: ${e}`);
        }
      }

      // Fall back: look for a download link directly on the metadata object,
      // in case none of the guessed paths above are it either.
      const downloadUrl =
        meta.downloadUrl ||
        meta.url ||
        meta?.versions?.[meta.versions.length - 1]?.downloadUrl ||
        meta?.versions?.[meta.versions.length - 1]?.url;

      if (downloadUrl) {
        const fileRes = await fetch(downloadUrl, { headers: { Authorization: auth } });
        if (fileRes.ok) {
          const text = await fileRes.text();
          return new Response(text, {
            status: 200,
            headers: { ...CORS_HEADERS, 'Content-Type': 'text/csv; charset=utf-8' }
          });
        }
        lastStatus = `metadata ok, but downloadUrl fetch failed: ${fileRes.status}`;
        lastBody = await fileRes.text().catch(() => '');
        continue;
      }

      // We got file metadata but none of the guessed content endpoints
      // worked, and there's no obvious download link on the metadata
      // object itself. Surface everything we tried.
      return new Response(
        `Got file metadata but no working download link. fileId: ${fileId}. Attempts:\n${attempts.join('\n')}\n\nRaw metadata:\n${JSON.stringify(meta, null, 2)}`.slice(0, 2000),
        { status: 502, headers: CORS_HEADERS }
      );
    } catch (e) {
      lastStatus = 'network-error';
      lastBody = String(e);
    }
  }

  return new Response(
    `Could not fetch file metadata from any known Trimble region host. fileId requested: ${fileId}. Last status: ${lastStatus}. ${lastBody}`.slice(0, 800),
    { status: 502, headers: CORS_HEADERS }
  );
}
