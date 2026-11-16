import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { errorHandler } from './asyncHandler.js';

function invoke(error, { headersSent = false } = {}) {
  const headers = new Map();
  let nextError;
  const res = {
    headersSent,
    statusCode: 200,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  errorHandler(error, { requestId: 'req-test' }, res, (err) => {
    nextError = err;
  });
  return { res, headers, nextError };
}

test('database connection failures return retryable JSON before the gateway timeout', () => {
  for (const code of ['CONNECT_TIMEOUT', 'CONNECTION_CLOSED', '53300', '08006']) {
    const { res, headers } = invoke(Object.assign(new Error('database unavailable'), { code }));
    assert.equal(res.statusCode, 503, code);
    assert.equal(res.payload.code, 'SERVICE_UNAVAILABLE', code);
    assert.equal(res.payload.requestId, 'req-test', code);
    assert.equal(headers.get('retry-after'), '5', code);
    assert.equal(res.err.code, code);
    assert.equal(res.err.message, 'Database connection unavailable');
  }
});

test('database failure logging excludes provider details and query parameters', () => {
  const error = Object.assign(new Error('connect timeout: sensitive connection details'), {
    query: 'SELECT private_data',
    parameters: ['sensitive value'],
  });
  const { res } = invoke(error);
  assert.equal(res.statusCode, 503);
  assert.equal(res.err.code, 'DATABASE_CONNECTION_ERROR');
  assert.equal(res.err.query, undefined);
  assert.equal(res.err.parameters, undefined);
  assert.doesNotMatch(res.err.stack, /sensitive|private_data/);
});

test('HTTP completion logs retain the database error code instead of a generic 503 error', async () => {
  const logs = [];
  const logRequest = pinoHttp({
    logger: pino({ base: null }, { write: (line) => logs.push(JSON.parse(line)) }),
  });
  const server = http.createServer((req, res) => {
    logRequest(req, res);
    res.status = (status) => { res.statusCode = status; return res; };
    res.json = (body) => { res.end(JSON.stringify(body)); return res; };
    errorHandler(Object.assign(new Error('sensitive provider details'), {
      code: 'CONNECT_TIMEOUT',
    }), req, res, () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    await response.text();
    const entry = logs.find((log) => log.res?.statusCode === 503);
    assert.equal(entry.err.code, 'CONNECT_TIMEOUT');
    assert.equal(entry.err.message, 'Database connection unavailable');
    assert.doesNotMatch(JSON.stringify(entry), /sensitive provider details/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('error handling delegates after a response has already started', () => {
  const error = new Error('late failure');
  const { nextError, res } = invoke(error, { headersSent: true });
  assert.equal(nextError, error);
  assert.equal(res.payload, undefined);
});
