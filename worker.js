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
async function resolveContent(bodyBuffer, auth) {
  // Try to see if this looks like a JSON pointer wrapper (e.g. {"url":"..."})
  // without assuming the bytes are valid UTF-8 text — binary file content
  // (like a .12daz zip) would get corrupted if blindly decoded, so we only
  // attempt JSON parsing, and only trust it, when it actually looks like
  // JSON text first.
  let asText = null;
  try { asText = new TextDecoder('utf-8', { fatal: false }).decode(bodyBuffer); } catch { asText = null; }

  if (asText) {
    const trimmed = asText.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        const pointerFrom = (obj) => obj && (obj.url || obj.downloadUrl || obj.data);

        if (Array.isArray(parsed)) {
          for (let i = parsed.length - 1; i >= 0; i--) {
            const innerUrl = pointerFrom(parsed[i]);
            if (typeof innerUrl === 'string' && innerUrl.startsWith('http')) {
              const innerRes = await fetch(innerUrl, { headers: { Authorization: auth } });
              if (innerRes.ok) return await innerRes.arrayBuffer();
            }
          }
          return null;
        }

        const innerUrl = pointerFrom(parsed);
        if (typeof innerUrl === 'string' && innerUrl.startsWith('http')) {
          const innerRes = await fetch(innerUrl, { headers: { Authorization: auth } });
          if (innerRes.ok) return await innerRes.arrayBuffer();
        }
        return null; // parsed as JSON but no usable pointer in it
      } catch {
        // Looked JSON-shaped but didn't actually parse — fall through to
        // treating the original bytes as real content below.
      }
    }
    if (trimmed.startsWith('<')) return null; // an HTML error page, not real content
  }

  // Not JSON, not HTML — treat the ORIGINAL bytes as the actual file
  // content directly. Covers plain CSV responses as well as any binary
  // format (like .12daz) a candidate path might hand back as-is.
  return bodyBuffer;
}

// Generic same-origin proxy for fetching a URL that lacks CORS headers —
// currently used for WMTS GetCapabilities documents (an XML file most
// providers, including Propeller Aero, don't serve with CORS headers,
// since it's traditionally consumed server-side by GIS desktop software,
// not fetched directly from a browser tab).
async function handleProxyFetch(url) {
  const target = url.searchParams.get('url');
  if (!target) {
    return new Response('Missing url', { status: 400, headers: CORS_HEADERS });
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return new Response('Invalid url', { status: 400, headers: CORS_HEADERS });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return new Response('Only http/https URLs are allowed', { status: 400, headers: CORS_HEADERS });
  }
  // Basic guard against pointing this at internal/private infrastructure.
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.startsWith('127.') || host.startsWith('169.254.') ||
      host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return new Response('That host is not allowed', { status: 400, headers: CORS_HEADERS });
  }

  try {
    const res = await fetch(parsed.toString(), { headers: { Accept: 'application/xml, text/xml, */*' } });
    const text = await res.text();
    if (text.length > 3_000_000) {
      return new Response('Response too large', { status: 502, headers: CORS_HEADERS });
    }
    return new Response(text, {
      status: res.status,
      headers: { ...CORS_HEADERS, 'Content-Type': res.headers.get('content-type') || 'text/plain' }
    });
  } catch (e) {
    return new Response(`Fetch failed: ${e}`, { status: 502, headers: CORS_HEADERS });
  }
}

// Finds which regional host actually serves this project, and returns the
// project's own metadata alongside it (rootId is needed for the folder
// browser; name is just for display). Reused by all three new endpoints
// below so every call in one deploy operation lands on the same host.
async function discoverHost(auth, projectId) {
  for (const host of CANDIDATE_HOSTS) {
    try {
      const res = await fetch(`${host}/tc/api/2.0/projects/${encodeURIComponent(projectId)}`, {
        headers: { Authorization: auth }
      });
      if (res.ok) return { host, project: await res.json() };
    } catch { /* try next host */ }
  }
  return null;
}

async function handleListFolder(request, url) {
  const auth = request.headers.get('Authorization');
  const projectId = url.searchParams.get('projectId');
  const folderId = url.searchParams.get('folderId'); // optional — defaults to project root

  if (!auth) return new Response('Missing Authorization header', { status: 401, headers: CORS_HEADERS });
  if (!projectId) return new Response('Missing projectId', { status: 400, headers: CORS_HEADERS });

  const discovered = await discoverHost(auth, projectId);
  if (!discovered) {
    return new Response('Could not reach any known Trimble region host for this project', { status: 502, headers: CORS_HEADERS });
  }
  const { host, project } = discovered;
  const targetFolderId = folderId || project.rootId;

  try {
    const res = await fetch(`${host}/tc/api/2.0/folders/${encodeURIComponent(targetFolderId)}/items`, {
      headers: { Authorization: auth }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return new Response(`Could not list folder: HTTP ${res.status} ${body}`, { status: 502, headers: CORS_HEADERS });
    }
    const items = await res.json();
    const payload = {
      host,
      folderId: targetFolderId,
      rootId: project.rootId,
      isRoot: targetFolderId === project.rootId,
      items: (Array.isArray(items) ? items : [])
        .filter(i => i.type === 'FOLDER' || i.type === 'FILE')
        .map(i => ({ id: i.id, name: i.name, type: i.type }))
    };
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(`Fetch failed: ${e}`, { status: 502, headers: CORS_HEADERS });
  }
}

async function handleListVersions(request, url) {
  const auth = request.headers.get('Authorization');
  const projectId = url.searchParams.get('projectId');
  const fileId = url.searchParams.get('fileId');

  if (!auth) return new Response('Missing Authorization header', { status: 401, headers: CORS_HEADERS });
  if (!projectId) return new Response('Missing projectId', { status: 400, headers: CORS_HEADERS });
  if (!fileId) return new Response('Missing fileId', { status: 400, headers: CORS_HEADERS });

  const discovered = await discoverHost(auth, projectId);
  if (!discovered) {
    return new Response('Could not reach any known Trimble region host for this project', { status: 502, headers: CORS_HEADERS });
  }
  const { host } = discovered;

  try {
    const res = await fetch(`${host}/tc/api/2.0/files/${encodeURIComponent(fileId)}/versions`, {
      headers: { Authorization: auth }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return new Response(`Could not list versions: HTTP ${res.status} ${body}`, { status: 502, headers: CORS_HEADERS });
    }
    const versions = await res.json();
    const payload = {
      host,
      versions: (Array.isArray(versions) ? versions : []).map(v => ({
        versionId: v.versionId || v.id,
        revision: v.revision,
        size: v.size,
        modifiedOn: v.modifiedOn,
        modifiedBy: v.modifiedBy ? { firstName: v.modifiedBy.firstName, lastName: v.modifiedBy.lastName, email: v.modifiedBy.email } : null
      }))
    };
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(`Fetch failed: ${e}`, { status: 502, headers: CORS_HEADERS });
  }
}

async function handleUploadFile(request) {
  const auth = request.headers.get('Authorization');
  if (!auth) return new Response('Missing Authorization header', { status: 401, headers: CORS_HEADERS });

  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON body', { status: 400, headers: CORS_HEADERS }); }

  const { projectId, parentId, parentType, fileName, content } = body || {};
  if (!projectId || !parentId || !fileName || content == null) {
    return new Response('Missing projectId, parentId, fileName, or content', { status: 400, headers: CORS_HEADERS });
  }

  const discovered = await discoverHost(auth, projectId);
  if (!discovered) {
    return new Response('Could not reach any known Trimble region host for this project', { status: 502, headers: CORS_HEADERS });
  }
  const { host } = discovered;

  try {
    // Step 1: initiate — tells Trimble Connect a file is coming and gets
    // back a short-lived signed URL to PUT the actual bytes to.
    const initiateRes = await fetch(`${host}/tc/api/2.0/files/fs/initiate`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId, parentType: parentType || 'FOLDER', name: fileName })
    });
    if (!initiateRes.ok) {
      const t = await initiateRes.text().catch(() => '');
      return new Response(`initiate failed: HTTP ${initiateRes.status} ${t}`, { status: 502, headers: CORS_HEADERS });
    }
    const initiateData = await initiateRes.json();

    // Step 2: PUT the raw bytes directly to that signed URL (not Trimble's
    // API host — this is typically direct-to-blob-storage, so no auth
    // header here).
    const putRes = await fetch(initiateData.uploadURL, { method: 'PUT', body: content });
    if (!putRes.ok) {
      const t = await putRes.text().catch(() => '');
      return new Response(`upload PUT failed: HTTP ${putRes.status} ${t}`, { status: 502, headers: CORS_HEADERS });
    }

    // Step 3: commit — finalizes the upload into an actual file record.
    const commitRes = await fetch(`${host}/tc/api/2.0/files/fs/commit`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: initiateData.uploadId })
    });
    if (!commitRes.ok) {
      const t = await commitRes.text().catch(() => '');
      return new Response(`commit failed: HTTP ${commitRes.status} ${t}`, { status: 502, headers: CORS_HEADERS });
    }
    const fileEntry = await commitRes.json();

    return new Response(JSON.stringify({ host, file: fileEntry }), {
      status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(`Upload failed: ${e}`, { status: 502, headers: CORS_HEADERS });
  }
}

async function handleTagFile(request) {
  const auth = request.headers.get('Authorization');
  if (!auth) return new Response('Missing Authorization header', { status: 401, headers: CORS_HEADERS });

  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON body', { status: 400, headers: CORS_HEADERS }); }
  const { projectId, fileId } = body || {};
  if (!projectId || !fileId) return new Response('Missing projectId or fileId', { status: 400, headers: CORS_HEADERS });

  const discovered = await discoverHost(auth, projectId);
  if (!discovered) {
    return new Response('Could not reach any known Trimble region host for this project', { status: 502, headers: CORS_HEADERS });
  }
  const { host } = discovered;
  const TAG_LABEL = 'TrimbleAccess.ProjectFile';

  try {
    const listRes = await fetch(`${host}/tc/api/2.0/tags?projectId=${encodeURIComponent(projectId)}`, {
      headers: { Authorization: auth }
    });
    if (!listRes.ok) {
      const t = await listRes.text().catch(() => '');
      return new Response(`Could not list tags: HTTP ${listRes.status} ${t}`, { status: 502, headers: CORS_HEADERS });
    }
    const tags = await listRes.json();
    let tag = Array.isArray(tags) ? tags.find(t => t.label === TAG_LABEL) : null;

    if (!tag) {
      const createRes = await fetch(`${host}/tc/api/2.0/tags`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: TAG_LABEL, projectId })
      });
      if (!createRes.ok) {
        const t = await createRes.text().catch(() => '');
        return new Response(`Could not create tag: HTTP ${createRes.status} ${t}`, { status: 502, headers: CORS_HEADERS });
      }
      tag = await createRes.json();
    }

    const attachRes = await fetch(`${host}/tc/api/2.0/tags/${encodeURIComponent(tag.id)}/objects`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: fileId, objectType: 'FILE' }])
    });
    if (!attachRes.ok) {
      const t = await attachRes.text().catch(() => '');
      return new Response(`Could not attach tag to file: HTTP ${attachRes.status} ${t}`, { status: 502, headers: CORS_HEADERS });
    }

    return new Response(JSON.stringify({ tagId: tag.id, applied: true }), {
      status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(`Tagging failed: ${e}`, { status: 502, headers: CORS_HEADERS });
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

    if (url.pathname === '/api/proxy-fetch') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === 'GET') {
        return handleProxyFetch(url);
      }
    }

    if (url.pathname === '/api/list-folder') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === 'GET') {
        return handleListFolder(request, url);
      }
    }

    if (url.pathname === '/api/list-versions') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === 'GET') {
        return handleListVersions(request, url);
      }
    }

    if (url.pathname === '/api/upload-file') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === 'POST') {
        return handleUploadFile(request);
      }
    }

    if (url.pathname === '/api/tag-file') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === 'POST') {
        return handleTagFile(request);
      }
    }

    // Everything else: serve the static file, then add CORS headers so
    // Trimble Connect (and any other external caller) can read it. Also
    // forbid caching outright — Trimble Connect's iframe was observed
    // serving a stale cached copy of this app even after fresh deploys.
    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      const res = new Response(assetRes.body, assetRes);
      res.headers.set('Access-Control-Allow-Origin', '*');
      res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
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
        // Confirmed directly from Trimble's own official JS SDK source
        // (trimble-connect-sdk, TCPS.getFileDownloadUrl): the /fs/ segment
        // is required and easy to miss — every path we'd guessed without it
        // came back INVALID_ENDPOINT.
        `/tc/api/2.0/files/fs/${encodeURIComponent(fileId)}/downloadurl${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''}`
      ];

      const attempts = [];

      for (const path of candidatePaths) {
        const candidateUrl = `${host}${path}`;
        try {
          let candRes = await fetch(candidateUrl, { headers: { Authorization: auth } });
          if (candRes.status === 400) {
            // A 400 (vs 404) means the route exists but rejected this
            // specific request — commonly a missing Accept header on
            // content/download endpoints. Worth one retry before giving up.
            candRes = await fetch(candidateUrl, {
              headers: { Authorization: auth, Accept: 'application/octet-stream, text/csv, */*' }
            });
          }
          if (!candRes.ok) {
            const errBody = await candRes.text().catch(() => '');
            attempts.push(`${path} -> ${candRes.status} ${errBody.slice(0, 200)}`);
            continue;
          }
          const bodyBuffer = await candRes.arrayBuffer();
          const result = await resolveContent(bodyBuffer, auth);
          if (result) {
            return new Response(result, {
              status: 200,
              headers: { ...CORS_HEADERS, 'Content-Type': 'application/octet-stream' }
            });
          }
          const preview = new TextDecoder('utf-8', { fatal: false }).decode(bodyBuffer).slice(0, 600);
          attempts.push(`${path} -> 200 but not usable content/pointer: ${preview}`);
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
          const buf = await fileRes.arrayBuffer();
          return new Response(buf, {
            status: 200,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/octet-stream' }
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
        `Got file metadata but no working download link. fileId: ${fileId}. Attempts:\n${attempts.join('\n')}\n\nRaw metadata:\n${JSON.stringify(meta, null, 2)}`.slice(0, 3000),
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
