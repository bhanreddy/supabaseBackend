import assert from 'node:assert/strict';
import test from 'node:test';
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
  }
});

test('error handling delegates after a response has already started', () => {
  const error = new Error('late failure');
  const { nextError, res } = invoke(error, { headersSent: true });
  assert.equal(nextError, error);
  assert.equal(res.payload, undefined);
});
