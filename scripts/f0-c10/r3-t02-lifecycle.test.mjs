import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import { LEVELS, MODES, LifecycleFixture, scenario } from './r3-t02-lifecycle.mjs';

test('1/2/4/10: create, exact ID reconciliation, continuation, settle, restart', () => {
 for (const count of LEVELS) for (const mode of MODES) {
   const r = scenario(count, mode);
   assert.equal(r.nativeCreateCalls, count);
   assert.equal(r.recovered, 1);
   assert.equal(r.continuationSubmits, count);
   assert.equal(r.duplicateContinuationReused, count);
   assert.equal(r.peakSlots, count);
   assert.equal(r.afterFinalSettlementReferences, 0);
   assert.equal(r.afterRestartReferences, 0);
   assert.equal(r.afterRestartSlots, 0);
   assert.equal(r.workerd, false);
 }
});
test('RED-guard: missing exact ID stays unknown; no duplicate create and no slot reuse', () => {
 const f = new LifecycleFixture({capacity: 1});
 const id = f.id(0); assert.equal(f.reserve(id).kind, 'granted');
 f.create(id, { loseReceipt: true });
 f.nativeRows.delete(id); // simulate lost/unconfirmed native row without replay
 assert.equal(f.reconcileExact(id).kind, 'unknown');
 assert.equal(f.nativeNotFound(id).slotHeld, true);
 assert.equal(f.reserve(f.id(1)).kind, 'capacity');
 assert.throws(() => f.create(id), /BAD_CREATE_STATE/);
 assert.equal(f.counts.created, 1);
});
test('stale generation cannot commit after recovery; exact owner mismatch remains unknown', () => {
 const f = new LifecycleFixture(), id = f.id(0);
 f.reserve(id); f.create(id, {loseReceipt: true}); const g = f.record(id).generation;
 f.nativeRows.get(id).owner = 'other'; assert.equal(f.reconcileExact(id).kind,'unknown');
 f.nativeRows.get(id).owner = id; assert.equal(f.reconcileExact(id).kind,'recovered');
 assert.equal(f.staleCommit(id,g),false);
});
test('continuation keeps slot on lost receipt/not_found; over-capacity fail closed', () => {
 const f = new LifecycleFixture({capacity: 1}), a = f.id(0), b = f.id(1);
 f.reserve(a); f.create(a); f.finish(a);
 assert.equal(f.continueTurn(a,'t1','h').kind,'submit');
 assert.equal(f.turnReceipt(a,'t1',{accepted:false}).kind,'unknown');
 assert.equal(f.nativeNotFound(a).slotHeld,true);
 assert.equal(f.reserve(b).kind,'capacity');
 assert.equal(f.continueTurn(a,'t1','h').kind,'reused');
 assert.throws(()=>f.continueTurn(a,'t1','other'),/TURN_CONFLICT/);
 assert.equal(f.counts.turns,1);
});
test('restart drops JS resident refs but conserves unknown durable slot until evidence', () => {
 const f = new LifecycleFixture(), id = f.id(0);
 f.reserve(id); f.create(id,{loseReceipt:true});
 const after = f.restart();
 assert.equal(after.liveReferences,0); assert.equal(after.slots.size,1);
 assert.equal(after.reconcileExact(id).kind,'recovered');
 assert.equal(after.record(id).status,'running');
});
test('reject invalid cases and oversized message fixtures', () => {
 assert.throws(()=>scenario(3,'full-history'),/INVALID_CASE/);
 assert.throws(()=>new LifecycleFixture({capacity:11}),/INVALID_OPTIONS/);
 const f = new LifecycleFixture(), id=f.id(0);
 f.reserve(id); f.create(id);
 assert.throws(()=>f.write(id,1001,1024),/INVALID_BYTES/);
});
