#!/usr/bin/env node
import { planRound,dryRun,runFixtureRound,runControls,liveOperatorTemplate,livePreflight } from './harness.mjs';
const args=process.argv.slice(2);
const size=Number(args[args.indexOf('--size')+1]||10);
try{
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
