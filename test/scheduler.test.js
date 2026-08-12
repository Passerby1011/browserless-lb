import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPool } from '../src/scheduler.js';

test('picks keys in round-robin order', () => {
  const pool = new KeyPool(['a', 'b', 'c'], 1000);
  assert.equal(pool.pick(0).value, 'a');
  assert.equal(pool.pick(0).value, 'b');
  assert.equal(pool.pick(0).value, 'c');
  assert.equal(pool.pick(0).value, 'a');
});

test('cools failed key and returns it after the cooldown', () => {
  const pool = new KeyPool(['a', 'b'], 1000);
  const first = pool.pick(0);
  pool.markFailure(first, 0);
  assert.equal(pool.pick(1).value, 'b');
  assert.equal(pool.pick(999).value, 'b');
  assert.equal(pool.pick(1000).value, 'a');
});
