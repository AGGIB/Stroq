export async function jsonBody(req, maxBody = 64 * 1024, parse = JSON.parse) {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBody)) {
    req.resume();
    throw new Error('body-too-large');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let finished = false;
    const done = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('aborted', aborted);
      req.removeListener('error', aborted);
      if (error) {
        req.resume();
        reject(new Error(error));
      } else resolve(value);
    };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBody) return done('body-too-large');
      chunks.push(chunk);
    };
    const end = () => {
      try {
        done(null, parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      } catch {
        done('invalid-request');
      }
    };
    const aborted = () => done('invalid-request');
    const timer = setTimeout(() => done('request-timeout'), 5000);
    req.on('data', data);
    req.once('end', end);
    req.once('aborted', aborted);
    req.once('error', aborted);
  });
}

/** Authentication and global Host/Origin checks run before this router. */
export async function routeControl(req, path, origin, control) {
  if (path === '/api/control')
    return req.method === 'GET'
      ? { status: 200, body: await control.snapshot() }
      : { status: 405, body: { error: 'method-not-allowed' } };
  if (path === '/api/runs/cancel')
    return jsonAction(req, origin, (input) => control.cancel(input), 4096);
  if (path.startsWith('/api/runs/')) {
    if (req.method !== 'GET') return { status: 405, body: { error: 'method-not-allowed' } };
    const id = path.slice('/api/runs/'.length);
    const run = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)
      ? await (control.readRun ? control.readRun(id) : control.getRun(id))
      : null;
    return run ? { status: 200, body: run } : { status: 404, body: { error: 'not-found' } };
  }
  if (path !== '/api/runs') return { status: 404, body: { error: 'not-found' } };
  return jsonAction(req, origin, (input) => control.start(input));
}

/** Shared bounded action gate. The outer server authenticates bearer and Host. */
export async function jsonAction(req, origin, action, maxBody = 64 * 1024, parse = JSON.parse) {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method-not-allowed' } };
  // Browsers must identify the exact origin on every action, even when no mutation
  // occurs. A stolen bearer token alone is not enough for a cross-origin POST.
  if (req.headers.origin !== origin) return { status: 403, body: { error: 'origin-refused' } };
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') ||
    (req.headers['content-encoding'] !== undefined &&
      req.headers['content-encoding'] !== 'identity')
  ) {
    req.resume();
    return { status: 415, body: { error: 'json-required' } };
  }
  try {
    return await action(await jsonBody(req, maxBody, parse));
  } catch (error) {
    const code = error?.message;
    if (code === 'body-too-large') return { status: 413, body: { error: code } };
    if (code === 'request-timeout') return { status: 408, body: { error: code } };
    return { status: 400, body: { error: 'invalid-request' } };
  }
}
