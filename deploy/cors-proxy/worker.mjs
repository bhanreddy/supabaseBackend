const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const EXPOSED_HEADERS = 'Retry-After,X-Request-Id,Request-Id';
const BACKEND_ORIGIN = 'https://simsapi-50046891665.development.catalystappsail.in';
const UPSTREAM_TIMEOUT_MS = 30_000;
const CF_HEADERS_TO_STRIP = ['CF-Ray', 'CF-Visitor', 'CF-IPCountry', 'CF-Connecting-IP'];

export function isAllowedOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.origin === origin &&
      (url.hostname === 'nexsyrus.com' || url.hostname.endsWith('.nexsyrus.com'));
  } catch {
    return false;
  }
}

function addCors(response, origin) {
  const result = new Response(response.body, response);
  // The edge owns CORS on this route. Remove any upstream copies first.
  for (const name of [...result.headers.keys()]) {
    if (name.startsWith('access-control-')) result.headers.delete(name);
  }
  const vary = result.headers.get('Vary') || '';
  if (!vary.split(',').some(value => ['origin', '*'].includes(value.trim().toLowerCase()))) {
    result.headers.set('Vary', vary ? `${vary}, Origin` : 'Origin');
  }
  if (origin) {
    result.headers.set('Access-Control-Allow-Origin', origin);
    result.headers.set('Access-Control-Allow-Credentials', 'true');
    result.headers.set('Access-Control-Expose-Headers', EXPOSED_HEADERS);
  }
  return result;
}

export async function proxyRequest(request, env = {}, upstreamFetch = fetch) {
  const origin = request.headers.get('Origin');
  if (origin && !isAllowedOrigin(origin)) {
    return addCors(Response.json({ error: 'Origin is not allowed' }, { status: 403 }), null);
  }

  if (request.method === 'OPTIONS') {
    const requestedMethod = request.headers.get('Access-Control-Request-Method');
    if (requestedMethod && !METHODS.includes(requestedMethod)) {
      return addCors(Response.json({ error: 'Method is not allowed' }, { status: 405 }), origin);
    }
    const response = addCors(new Response(null, { status: 204 }), origin);
    response.headers.set('Allow', METHODS.join(', '));
    if (origin) {
      response.headers.set('Access-Control-Allow-Methods', METHODS.join(', '));
      response.headers.set('Access-Control-Allow-Headers', request.headers.get('Access-Control-Request-Headers') || 'Content-Type,Authorization');
      response.headers.set('Access-Control-Max-Age', '600');
      response.headers.set('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    }
    return response;
  }

  const incoming = new URL(request.url);
  const upstream = new URL(env.UPSTREAM_URL || BACKEND_ORIGIN);
  if (upstream.protocol !== 'https:') throw new Error('UPSTREAM_URL must use HTTPS');
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  const headers = new Headers(request.headers);
  headers.delete('Host');
  headers.delete('Origin');
  headers.set('X-Forwarded-Host', incoming.host);
  headers.set('X-Forwarded-Proto', incoming.protocol.replace(':', ''));
  headers.delete('X-Forwarded-For');
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) headers.set('X-Forwarded-For', clientIp);
  for (const name of CF_HEADERS_TO_STRIP) headers.delete(name);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const forwarded = new Request(upstream, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
    ...(hasBody ? { duplex: 'half' } : {}),
  });
  try {
    // Preserve the application's authentication headers and stream the payload.
    // Manual redirects keep credentials from being forwarded to another host.
    return addCors(await upstreamFetch(forwarded, {
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }), origin);
  } catch {
    return addCors(Response.json({ success: false, error: 'Backend service is temporarily unavailable.' }, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    }), origin);
  }
}

export default {
  fetch(request, env) {
    return proxyRequest(request, env);
  },
};
