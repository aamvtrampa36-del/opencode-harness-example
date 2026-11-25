import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifest, validManifest, SIZES } from './manifest.mjs';
import { fixtureTrace } from './fixture-trace.mjs';
import { evaluateFixture, LIMITS, LIMITS_DIGEST } from './evaluator.mjs';
import { digest } from '../live-evidence.mjs';
import { sha256 } from '../tasks.mjs';

export const BASELINE = Object.freeze({source:'T10 #118/#119 / B0', limitsDigest:LIMITS_DIGEST,
  version:'fixture:v1', model:'none-offline', maxCostUsd:0, maxConcurrency:10, maxPageEvents:32});
export function planRound(size){
  const m=manifest(size);
  const body={schema:'metralla.m07.round-plan.v1',mode:'fixture',manifest:m,
    baseline:BASELINE,limits:LIMITS,requestedConcurrency:size,authorization:null,
    reservations:size,priorOpenOperations:0,priorOpenReservations:0};
  return {...body,planDigest:digest(body)};
}
export function preflight(p){
  try {
    if(!p||p.mode!=='fixture'||!validManifest(p.manifest)||
       !SIZES.includes(p.requestedConcurrency)||p.requestedConcurrency!==p.manifest.size||
       p.requestedConcurrency>BASELINE.maxConcurrency||digest(p)!==digest(planRound(p.manifest.size)))
      return {ok:false,code:'PLAN_OR_LIMITS_MISMATCH'};
    return {ok:true,planDigest:p.planDigest,liveAllowed:false};
  }catch{return {ok:false,code:'INVALID_PLAN'};}
}
// Pure planning branch: no files, submission, provider, Remote or GitHub adapters.
export function dryRun(size){
  const plan=planRound(size);
  return {plan,preflight:preflight(plan),dryRun:true,submissions:0,readbacks:0,writes:0,liveEffects:0,livePass:false};
}
export function liveOperatorTemplate(size){
  const fixture=manifest(size);
  return {schema:'metralla.m07.operator-preflight.v1',mode:'live-proposed',size,
    fixtureManifestDigest:fixture.digest,taskSpecs:fixture.tasks.map(t=>({kind:t.kind,input:t.input,
      inputSha256:t.inputSha256,expectedSha256:t.expected.sha256,expectedBytes:t.expected.size,
      requestId:null,sessionId:null,operationId:null,projectId:null,artifactScope:null,
      githubScope:t.scope.github?{repository:null,branch:null,baseSha:null,path:null,authorization:null}:null})),
    environment:null,sourceSha:null,workerVersion:null,mcpVersion:null,modelCapabilityReceipt:null,
    modelAllowlist:null,providerPriceReceipt:null,roundCapUsd:null,campaignCapUsd:null,
    effectiveSpendStopReceipt:null,atomicReservationReceipt:null,priorClosureReceipt:null,
    leaseId:null,fencingToken:null,operatorAuthorization:null,limitsDigest:null,
    collectorTrustReceipt:null,liveAllowed:false};
}
export function livePreflight(template){
  const required=['environment','sourceSha','workerVersion','mcpVersion','modelCapabilityReceipt',
    'modelAllowlist','providerPriceReceipt','roundCapUsd','campaignCapUsd','effectiveSpendStopReceipt',
    'atomicReservationReceipt','priorClosureReceipt','leaseId','fencingToken','operatorAuthorization',
    'limitsDigest','collectorTrustReceipt'];
  const missing=required.filter(k=>template?.[k]==null);
  if(!Array.isArray(template?.taskSpecs)||template.taskSpecs.some(t=>!t||['requestId','sessionId','operationId','projectId','artifactScope'].some(k=>!t[k])))missing.push('task identities/scopes');
  // A completed form cannot authorize effects or establish external trust.
  return {ok:false,liveAllowed:false,code:'STOP_LIVE_ADAPTER_NOT_AUTHORIZED_OR_CERTIFIED',missing};
}

// Execute deterministic tasks from inputs, independently of the expected-answer function.
export function solve(spec){
  const text=spec.input.text;
  let result,tdd=null;
  switch(spec.kind){
    case 'sha256':result={digest:sha256(text)};break;
    case 'unicode':result={utf16Units:text.length,codePoints:[...text].length,upper:spec.input.upperText.toLocaleUpperCase(spec.input.locale)};break;
    case 'csv':{
      const rows=text.trim().split('\n').slice(1).map(line=>line.split(','));
      const byTeam={};let sum=0;
      for(const [team,raw] of rows){const n=Number(raw);if(!Number.isFinite(n))throw Error('invalid CSV');byTeam[team]=(byTeam[team]||0)+n;sum+=n;}
      result={sum,byTeam,rows:rows.length};break;
    }
    case 'json':{
      const parse=s=>{try{JSON.parse(s);return true;}catch{return false;}};
      const [a,b]=text.split('\n');result={valid:parse(a),invalid:parse(b)};break;
    }
    case 'logs':{
      const counts={INFO:0,WARN:0,ERROR:0};
      for(const line of text.split('\n')){const level=line.split(' ')[0];if(!(level in counts))throw Error('unknown log');counts[level]++;}
      result=counts;break;
    }
    case 'html':{
      if(text!=='Un título y un botón etiquetado')throw Error('unsupported HTML fixture');
      const title='Estado',button='Actualizar';
      result={html:'<main><h1>'+title+'</h1><button type="button" aria-label="'+button+'">'+button+'</button></main>'};break;
    }
    case 'tdd':{
      const boundary=Number(text.match(/\d+/)?.[0]);
      const cases=[[boundary-1,true],[boundary,true],[boundary+1,false]];
      const run=fn=>cases.every(([x,expected])=>fn(x)===expected)?0:1;
      const redExitCode=run(x=>x<boundary),greenExitCode=run(x=>x<=boundary);
      tdd={redExitCode,greenExitCode};result={boundary,redExitCode,greenExitCode,passingTests:cases.filter(([x,expected])=>(x<=boundary)===expected).length};break;
    }
    case 'config':{
      const [a,b]=text.split('+').map(JSON.parse);result={merged:{...a,...b}};break;
    }
    case 'dag':{
      const [path,cycle]=text.split('; ').map(s=>s.split('→'));
      result={order:[...new Set(path)],cycleDetected:new Set(cycle).size!==cycle.length};break;
    }
    case 'pipeline':{
      const rows=text.split(',').map(Number),total=rows.reduce((a,b)=>a+b,0),report='rows='+rows.length+';total='+total;
      result={rows:rows.length,total,report,reportSha256:sha256(report)};break;
    }
    default:throw Error('unknown fixture');
  }
  return {content:JSON.stringify(result),tdd};
}

// Cursor is bound to the immutable evidence digest and page offset. No arbitrary remote fetch.
export function collectPage(events,cursor=null,limit=BASELINE.maxPageEvents){
  if(!Array.isArray(events)||events.length>LIMITS.maxEvents||!Number.isSafeInteger(limit)||limit<1||limit>BASELINE.maxPageEvents)throw Error('page bound');
  const version=digest(events);let offset=0;
  if(cursor!==null){
    if(typeof cursor!=='string'||!cursor.startsWith(version+':'))throw Error('foreign cursor');
    const raw=cursor.slice(version.length+1);
    if(!/^(0|[1-9]\d*)$/.test(raw))throw Error('invalid cursor');
    offset=Number(raw);if(!Number.isSafeInteger(offset)||offset<1||offset>=events.length)throw Error('cursor range');
  }
  const rows=events.slice(offset,offset+limit),next=offset+rows.length;
  return {rows:structuredClone(rows),cursor:next<events.length?version+':'+next:null};
}
export async function runFixtureRound(plan,{dry=false}={}){
  const check=preflight(plan);
  if(!check.ok)throw Error(check.code);
  if(dry)return dryRun(plan.manifest.size);
  const m=plan.manifest, {trace}=fixtureTrace(m.size);
  const root=await mkdtemp(join(tmpdir(),'metralla-m07-'));
  let next=0,active=0,peak=0,submissions=0,readbacks=0;
  try{
    const worker=async()=>{
      for(;;){
        const i=next++;if(i>=m.size)return;
        const spec=m.tasks[i];active++;peak=Math.max(peak,active);submissions++;
        try{
          const {content,tdd}=solve(spec);
          if(Buffer.byteLength(content)>spec.limits.maxOutputBytes)throw Error('output bound');
          const file=join(root,String(i)+'.json');
          await writeFile(file,content,{flag:'wx',mode:0o600});
          const produced={content,sha256:sha256(content),size:Buffer.byteLength(content),type:spec.expected.type,path:spec.expected.path};
          const bytes=await readFile(file);readbacks++;
          const recovered={content:bytes.toString('utf8'),sha256:sha256(bytes),size:bytes.length,type:spec.expected.type,path:spec.expected.path};
          const ev=trace.events.filter(e=>e.fixtureId===spec.fixtureId);
          ev.find(e=>e.type==='output').artifact=produced;
          ev.find(e=>e.type==='readback').artifact=recovered;
          if(tdd){ev.find(e=>e.type==='tdd_red').exitCode=tdd.redExitCode;ev.find(e=>e.type==='tdd_green').exitCode=tdd.greenExitCode;}
          if(spec.scope.github)ev.find(e=>e.type==='github').receipt.contentSha256=recovered.sha256;
        }finally{active--;}
      }
    };
    const settled=await Promise.allSettled(Array.from({length:plan.requestedConcurrency},()=>worker()));
    const failure=settled.find(x=>x.status==='rejected');if(failure)throw failure.reason;
    const rows=[];let cursor=null,pages=0;
    do{const page=collectPage(trace.events,cursor);rows.push(...page.rows);cursor=page.cursor;pages++;
      if(pages>LIMITS.maxEvents)throw Error('page loop');}while(cursor!==null);
    const evidence={...trace,events:rows};
    return {report:evaluateFixture(m,evidence),evidence,submissions,readbacks,peakLocalSubmissions:peak,pages,
      syntheticActivity:true,liveEffects:0,livePass:false};
  }finally{await rm(root,{recursive:true,force:true});}
}

// Offline control model. Unknown effects remain sticky until same-id reconciliation.
export function fixtureControls(){
  const tasks=new Map();let effects=0,epoch=1;
  return {
    submit(id,owner,{readOnly=false,loseResponse=false}={}){
      if(readOnly)return {code:'READ_ONLY'};
      if(tasks.has(id))return {code:'DUPLICATE'};
      tasks.set(id,{owner,state:loseResponse?'unknown':'running',epoch});effects++;
      return {code:loseResponse?'UNKNOWN':'STARTED'};
    },
    status(id,owner){const t=tasks.get(id);return t&&t.owner===owner?{...t}:{code:'DENIED'};},
    cancel(id,owner){const t=tasks.get(id);if(!t||t.owner!==owner)return {code:'DENIED'};
      if(t.state==='unknown')return {code:'RECONCILE_FIRST'};t.state='cancelled';return {code:'CANCELLED'};},
    restart(){epoch++;return {epoch};},
    reconcile(id,owner,observed){const t=tasks.get(id);if(!t||t.owner!==owner||t.state!=='unknown'||observed!=='materialized')return {code:'UNKNOWN'};
      t.state='running';return {code:'MATERIALIZED'};},
    effects:()=>effects
  };
}
export function runControls(){
  const c=fixtureControls(), results=[];
  const add=(name,ok)=>results.push({name,ok:!!ok,countsAsPositive:false,evidenceClass:'fixture'});
  add('read-only',c.submit('fixture:ro','a',{readOnly:true}).code==='READ_ONLY'&&c.effects()===0);
  c.submit('fixture:a','a');add('duplicate',c.submit('fixture:a','a').code==='DUPLICATE'&&c.effects()===1);
  add('cross-access',c.status('fixture:a','b').code==='DENIED'&&c.cancel('fixture:a','b').code==='DENIED');
  c.restart();add('restart',c.status('fixture:a','a').state==='running'&&c.effects()===1);
  add('cancellation',c.cancel('fixture:a','a').code==='CANCELLED'&&c.status('fixture:a','a').state==='cancelled');
  const lost=c.submit('fixture:lost','a',{loseResponse:true});
  add('response-lost',lost.code==='UNKNOWN'&&c.cancel('fixture:lost','a').code==='RECONCILE_FIRST'&&
    c.submit('fixture:lost','a').code==='DUPLICATE'&&c.reconcile('fixture:lost','a','materialized').code==='MATERIALIZED'&&c.effects()===2);
  return results;
}
