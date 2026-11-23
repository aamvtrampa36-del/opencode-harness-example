/** LOCAL-ONLY disposable workerd probe, NOT the OpenCode SDK or staging Worker. */
import { DurableObject } from 'cloudflare:workers';
const valid = id => typeof id === 'string' && /^r3t02_[0-9a-f]{8}$/.test(id);
const json = (data, code = 200) => new Response(JSON.stringify(data), {
  status: code, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});
export class ResidencyProbe extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.active = new Map(); this.openedAt = Date.now(); }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const begin = performance.now();
    if (path === '/snapshot' && request.method === 'GET') {
      const data = await this.ctx.storage.list({prefix:'probe:'});
      return json({kind:'workerd-disposable-probe-not-OpenCode', openedAt:this.openedAt,
        activeReferences:this.active.size, rows:[...data.entries()].map(([key,value])=>({key,status:value.status,steps:value.steps})),
        durationMs:performance.now()-begin, memoryIsolateMiB:null});
    }
    if (request.method !== 'POST') return json({error:'METHOD_NOT_ALLOWED'},405);
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > 4096) return json({error:'PAYLOAD_TOO_BIG'},413);
    let input;
    try { input = await request.json(); } catch { return json({error:'BAD_JSON'},400); }
    const {id} = input;
    if (!valid(id)) return json({error:'INVALID_ID'},400);
    const key = 'probe:' + id;
    const old = await this.ctx.storage.get(key);
    if (path === '/start') {
      if (old) return json({error:'EXISTS',status:old.status},409);
      const stored = await this.ctx.storage.list({prefix:'probe:'});
      const running = [...stored.values()].filter(v=>v.status==='running').length;
      if (running >= 10) return json({error:'CAPACITY'},429);
      await this.ctx.storage.put(key,{status:'running',steps:0});
      this.active.set(id,[]);
      return json({status:'running',durationMs:performance.now()-begin});
    }
    if (!old) return json({error:'NOT_FOUND'},404);
    if (path === '/continue') {
      if (old.status!=='finished') return json({error:'UNSAFE_CONTINUE',status:old.status},409);
      await this.ctx.storage.put(key,{status:'running',steps:old.steps});
      this.active.set(id,[]);
      return json({status:'running',durationMs:performance.now()-begin});
    }
    if (path === '/step') {
      if (old.status!=='running') return json({error:'NOT_RUNNING'},409);
      if (!this.active.has(id)) return json({error:'RECOVERY_UNCONFIRMED',status:old.status},409);
      const rows = this.active.get(id);
      rows.push(('r3t02:' + id + ':' + old.steps).padEnd(512,'x'));
      if (rows.length > 20) rows.shift();
      await this.ctx.storage.put(key,{...old,steps:old.steps+1});
      return json({status:'running',buffered:rows.length,durationMs:performance.now()-begin});
    }
    if (path === '/finish' || path === '/cancel') {
      if (old.status!=='running') return json({error:'NOT_RUNNING'},409);
      const status = path === '/finish' ? 'finished' : 'cancelled';
      await this.ctx.storage.put(key,{...old,status});
      this.active.delete(id);
      return json({status,activeReferences:this.active.size,durationMs:performance.now()-begin});
    }
    return json({error:'UNKNOWN_ACTION'},404);
  }
}
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/health') return json({ready:true,scope:'local-only'});
    return env.LOCAL_PROBE.getByName('one-logical-DO-no-isolate-sharding').fetch(request);
  }
};
