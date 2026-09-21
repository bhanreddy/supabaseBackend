import test from 'node:test';
import assert from 'node:assert/strict';
import { processPendingReminders } from '../services/calendarNotificationService.js';
import { processOverstayAlerts } from '../services/visitorOverstayService.js';

function textOf(strings) {
  return strings.join(' ? ').replace(/\s+/g, ' ').trim();
}

test('calendar reminder claims due rows with SKIP LOCKED inside a transaction', async () => {
  const queries = [];
  let transactionStarted = false;
  const tx = async (strings) => {
    queries.push(textOf(strings));
    return [];
  };
  const db = {
    begin: async (callback) => {
      transactionStarted = true;
      return callback(tx);
    },
  };

  const count = await processPendingReminders({ db, notify: async () => {} });
  assert.equal(count, 0);
  assert.equal(transactionStarted, true);
  assert.match(queries[0], /FOR UPDATE OF r SKIP LOCKED/);
});

test('visitor overstay worker exits without querying alerts when advisory lock is contended', async () => {
  const queries = [];
  const tx = async (strings) => {
    const text = textOf(strings);
    queries.push(text);
    if (text.includes('pg_try_advisory_xact_lock')) return [{ acquired: false }];
    throw new Error('worker queried rows without holding the advisory lock');
  };
  const db = { begin: async (callback) => callback(tx) };

  const count = await processOverstayAlerts({ db, notify: async () => {} });
  assert.equal(count, 0);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /visitor-overstay-worker/);
});
