#!/usr/bin/env node
import { planRound,dryRun,runFixtureRound,runControls,liveOperatorTemplate,livePreflight } from './harness.mjs';
const args=process.argv.slice(2);
try{
  const i=args.indexOf('--size');
  if(i>=0&&!/^(1|2|4|10)$/.test(args[i+1]||''))throw Error('invalid or missing --size');
  const size=i<0?10:Number(args[i+1]);
  const modes=args.filter(x=>['--live','--dry-run','--suite'].includes(x));
  if(modes.length>1||args.some((a,j)=>!['--live','--dry-run','--suite','--size'].includes(a)&&!(i>=0&&j===i+1))||args.filter(x=>x==='--size').length>1)throw Error('invalid arguments');
  let result;
  if(args.includes('--live')){const template=liveOperatorTemplate(size);result={template,preflight:livePreflight(template),pass:false,livePass:false};process.exitCode=2;}
  else if(args.includes('--dry-run'))result=dryRun(size);
  else if(args.includes('--suite')){
    const rounds=[];for(const n of [1,2,4,10])rounds.push(await runFixtureRound(planRound(n)));
    const controls=runControls();result={pass:rounds.every(r=>r.report.fixturePass)&&controls.every(c=>c.ok),rounds,controls,livePass:false,realStagingTested:false};
    if(!result.pass)process.exitCode=1;
  }else{result=await runFixtureRound(planRound(size));if(!result.report.fixturePass)process.exitCode=1;}
  console.log(JSON.stringify(result,null,2));
}catch(e){console.error('FAIL-CLOSED:',e.message);process.exitCode=2;}
