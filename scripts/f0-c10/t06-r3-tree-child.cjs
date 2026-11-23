// Disposable LOCAL child program. This is NOT deployed in Containers.
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const path=require('node:path');
const [mode,arg1,arg2]=process.argv.slice(2);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const marker=name=>path.join(process.cwd(),name);
const writePid=file=>fs.writeFileSync(marker(file),JSON.stringify({pid:process.pid,mode,cwd:process.cwd()}));
async function waitFile(file,deadline=4000){for(let i=0;i<deadline/20;i++){if(fs.existsSync(marker(file)))return;await pause(20);}throw Error('marker missing '+file);}
async function main(){
 if(mode==='leaf') {writePid(arg1);process.on('SIGTERM',()=>{});setInterval(()=>{},1000);return;}
 if(mode==='middle') {writePid('middle.json');spawn(process.execPath,[__filename,'leaf',arg1],{stdio:'inherit'}).unref();await waitFile(arg1);return;}
 if(mode==='tree') {writePid('root.json');spawn(process.execPath,[__filename,'middle','leaf.json'],{stdio:'inherit'}).unref();await waitFile('leaf.json');await pause(80);process.exitCode=31;return;}
 if(mode==='setsid-pipes') {spawn(process.execPath,[__filename,'leaf','escaped.json'],{detached:true,stdio:'inherit'}).unref();await waitFile('escaped.json');process.exitCode=17;return;}
 if(mode==='fork-stage') {spawn(process.execPath,[__filename,'leaf','double.json'],{detached:true,stdio:'ignore'}).unref();await waitFile('double.json');return;}
 if(mode==='double-fork') {spawn(process.execPath,[__filename,'fork-stage'],{stdio:'ignore'}).unref();await waitFile('double.json');return;}
 if(mode==='barrier') {const number=Number(arg1),barrier=arg2;writePid('ready.json');for(let i=0;i<900;i++){if(fs.existsSync(barrier))break;await pause(10)}if(!fs.existsSync(barrier))throw Error('barrier timeout');fs.writeFileSync('marker.json',JSON.stringify({number,cwd:process.cwd()}));process.stdout.write('out-'+number);process.stderr.write('err-'+number);process.exitCode=number;return;}
 if(mode==='massive') {const {once}=require('node:events');const write=async (s,byte,n)=>{const buf=Buffer.alloc(8192,byte);for(let i=0;i<n;i++){if(!s.write(buf))await once(s,'drain')}};await Promise.all([write(process.stdout,0x41,2048),write(process.stderr,0x45,2048)]);process.exitCode=19;return;}
 if(mode==='binary') {process.stdout.write(Buffer.from([0,255,254,10,13]));process.stderr.write(Buffer.from([0,254,255,13,10]));process.exitCode=23;return;}
 if(mode==='kill-timeout') {writePid('timeout-leaf.json');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);return;}
 throw Error('unknown fixture '+mode);
}
main().catch(e=>{console.error(e.message);process.exitCode=125;});
