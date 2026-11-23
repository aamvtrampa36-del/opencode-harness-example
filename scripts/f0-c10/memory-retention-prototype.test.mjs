import test from 'node:test';
import assert from 'node:assert/strict';
import { events, fullHistory, boundedHistory } from './memory-retention-prototype.mjs';

test('synthetic ten-session event stream yields equivalent final cursor/tail', () => {
  const a = fullHistory(events(10, 12, 128), 20);
  const b = boundedHistory(events(10, 12, 128), 20);
  assert.deepEqual(b.recent, a.recent);
  assert.equal(b.count, 120);
  assert.equal(b.bytes, a.bytes - (a.count - 1));
  assert.equal(b.recent.at(-1), '9:11');
});
test('empty and singleton streams produce exact results', () => {
  assert.deepEqual(boundedHistory([],20).recent,[]);
  assert.deepEqual(boundedHistory([{id:'one',session:0,seq:0,body:'a'}],20).recent,['one']);
});
test('bounded tail size never exceeds its capacity', () => {
  const result = boundedHistory(events(10, 700, 32), 7);
  assert.equal(result.count,7000);
  assert.equal(result.recent.length,7);
});
test('invalid parameters fail closed',()=>{
  assert.throws(()=>boundedHistory([], 257), /TAIL_LIMIT/);
  assert.throws(()=>[...events(0, 1, 1)], /LIMIT/);
});
