import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin, proxyRequest } from './worker.mjs';

const env = { UPSTREAM_URL: 'https://simsapi-50046891665.development.catalystappsail.in' };
const url = 'https://simsapi.nexsyrus.com/api/v1/ping';

test('accepts the apex, new subdomains and nested subdomains with HTTPS', () => {
  for (const origin of ['https://nexsyrus.com', 'https://new-school.nexsyrus.com', 'https://parent.new-school.nexsyrus.com']) {
    assert.equal(isAllowedOrigin(origin), true, origin);
  }
});

test('rejects deceptive suffixes, credentials, paths and unrelated origins', () => {
  for (const origin of ['https://nexsyrus.com.attacker.example', 'https://evilnexsyrus.com', 'https://nexsyrus.com@attacker.example', 'https://user@nexsyrus.com', 'https://nexsyrus.com/path', 'null', 'http://school.nexsyrus.com']) {
    assert.equal(isAllowedOrigin(origin), false, origin);
  }
});

test('answers new-subdomain preflight without invoking Catalyst', async () => {
  const origin = 'https://unlisted-school.nexsyrus.com';
  const response = await proxyRequest(new Request(url, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-school-id,x-device-proof' },
  }), env, () => { throw new Error('Preflight must not call the backend'); });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /x-device-proof/);
});

test('forwards auth, body, tenant headers and query but strips upstream Origin', async () => {
  const request = new Request('https://simsapi.nexsyrus.com/api/v1/example?a=1', {
    method: 'POST', body: '{"example":true}',
    headers: { Origin: 'https://nested.school.nexsyrus.com', Authorization: 'Bearer test', 'X-School-Id': '17', 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': 'spoofed' },
  });
  const response = await proxyRequest(request, env, async (forwarded, options) => {
    assert.equal(forwarded.url, `${env.UPSTREAM_URL}/api/v1/example?a=1`);
    assert.equal(forwarded.headers.get('Origin'), null);
    assert.equal(forwarded.headers.get('Authorization'), 'Bearer test');
    assert.equal(forwarded.headers.get('X-School-Id'), '17');
    assert.equal(forwarded.headers.get('X-Forwarded-For'), '203.0.113.7');
    assert.equal(forwarded.headers.get('CF-Connecting-IP'), null);
    assert.equal(forwarded.headers.get('X-Forwarded-Host'), 'simsapi.nexsyrus.com');
    assert.equal(forwarded.headers.get('X-Forwarded-Proto'), 'https');
    assert.equal(await forwarded.text(), '{"example":true}');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ ok: true }, { headers: { 'Access-Control-Allow-Origin': 'duplicate, duplicate', 'Access-Control-Allow-Credentials': 'true, true', 'X-Request-Id': 'test-request' } });
  });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://nested.school.nexsyrus.com');
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.equal(response.headers.get('X-Request-Id'), 'test-request');
});

test('rejects untrusted browser origins before forwarding', async () => {
  const response = await proxyRequest(new Request(url, { headers: { Origin: 'https://attacker.example' } }), env, () => { throw new Error('Must not forward'); });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('keeps native clients without an Origin header working', async () => {
  const response = await proxyRequest(new Request(url), env, async () => Response.json({ ok: true }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('upstream failures retain CORS so the frontend can read the 502 error', async () => {
  const origin = 'https://new.nexsyrus.com';
  const response = await proxyRequest(new Request(url, { headers: { Origin: origin } }), env, () => { throw new Error('Network failure'); });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
});
