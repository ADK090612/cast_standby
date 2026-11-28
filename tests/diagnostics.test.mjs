import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../adk-diagnostics.js',import.meta.url),'utf8');
test('loading the diagnostics module while developer options are locked installs no hooks or jobs',()=>{
  let work=0;const fetch=()=>{},log=()=>{},context={window:{__dashboardDeveloperOptionsEnabled:()=>false,fetch},document:new Proxy({},{get(){work++;throw Error('Locked diagnostics touched the DOM');}}),console:{log},setTimeout(){work++;},setInterval(){work++;},requestAnimationFrame(){work++;},MutationObserver:class{constructor(){work++;}}};
  vm.runInNewContext(code,context);const api=context.window.ADKDiagnostics;api.activate();api.record('test','ignored');
  assert.equal(api.state.active,false);assert.equal(api.state.timer,false);assert.equal(api.state.frame,false);assert.equal(api.state.observer,false);assert.equal(api.state.apiCount,0);assert.equal(api.state.logCount,0);assert.equal(context.window.fetch,fetch);assert.equal(context.console.log,log);assert.equal(work,0);
});
function diagnostics(){
  const document={hidden:false,getElementById:()=>null,querySelector:()=>null,documentElement:{dataset:{theme:'light',weatherDesign:'simple'}}};
  const context={window:{__dashboardDeveloperOptionsEnabled:()=>true},document,location:{href:'https://example.test/index.html'},performance:{now:()=>2000,timeOrigin:1700000000000},innerWidth:1440,innerHeight:900,devicePixelRatio:1,URL,TextDecoder,Date,Error};
  vm.runInNewContext(code.replace('    window.ADKDiagnostics=',`    window.test={snapshotLog,record,recordStall,get logs(){return logs},get tasks(){return tasks},enable(){active=true;logsEnabled=true;longTasksEnabled=true},disable(){active=false}};window.ADKDiagnostics=`),context);return {api:context.window.test,context};
}
test('log snapshots preserve nested values without executing getters or keeping circular references',()=>{
  const {api}=diagnostics();let accessed=0;const value={school:{name:'테스트 학교',count:42},get secret(){accessed++;return 'getter';}};value.self=value;
  const output=api.snapshotLog(value),data=JSON.parse(output.body);assert.equal(data.school.name,'테스트 학교');assert.equal(data.school.count,42);assert.match(data.secret,/접근자/);assert.match(data.self,/순환/);assert.equal(accessed,0);
});
test('very large, deep or wide console values have bounded snapshots and explicit truncation',()=>{
  const {api}=diagnostics();for(const value of ['x'.repeat(1048576),Object.fromEntries(Array.from({length:1000},(_,i)=>['key'+i,{data:'x'.repeat(100)}])),{a:{b:{c:{d:{e:{f:{g:'deep'}}}}}}}]){const out=api.snapshotLog(value);assert.equal(out.truncated,true);assert.ok(out.body.length<16500);}
});
test('snapshotting an own __proto__ property preserves it as data',()=>{
  const {api}=diagnostics(),out=JSON.parse(api.snapshotLog(JSON.parse('{"__proto__":{"polluted":true},"ok":1}')).body);assert.equal(out.__proto__.polluted,true);assert.equal(out.ok,1);assert.equal({}.polluted,undefined);
});
test('console collection stays disabled by default and retains only the latest bounded records',()=>{
  const {api}=diagnostics();api.record('log','disabled');assert.equal(api.logs.length,0);api.enable();for(let i=0;i<130;i++)api.record('log','item '+i,'data '+i);assert.equal(api.logs.length,100);assert.equal(api.logs[0].data,'data 129');assert.equal(api.logs[99].data,'data 30');api.disable();api.record('log','after lock');assert.equal(api.logs[0].message,'item 129');
});
test('long tasks include wall clock start/end, duration and honest frame attribution',()=>{
  const {api}=diagnostics();api.enable();api.recordStall({entryType:'longtask',startTime:1000,duration:125,name:'self',attribution:[{containerType:'iframe',containerId:'slow-frame',containerSrc:'https://example.test/slow?token=private'}]});
  const entry=api.tasks[0];assert.equal(entry.time,'2023-11-14T22:13:21.000Z');assert.equal(entry.endTime,'2023-11-14T22:13:21.125Z');assert.equal(entry.duration,125);assert.equal(entry.attribution[0].containerId,'slow-frame');assert.ok(!entry.attribution[0].containerSrc.includes('private'));assert.match(entry.locationNote,/확정할 수 없/);assert.equal(entry.context.theme,'light');
});
test('long frames retain available script locations and never invent unavailable line numbers',()=>{
  const {api}=diagnostics();api.enable();api.recordStall({entryType:'long-animation-frame',startTime:1200,duration:180,scripts:[{sourceURL:'https://example.test/slow.js',sourceFunctionName:'slowRender',sourceCharPosition:420,duration:100},{duration:60}]});
  const entry=api.tasks[0];assert.equal(entry.scripts[0].sourceFunctionName,'slowRender');assert.equal(entry.scripts[0].sourceCharPosition,420);assert.equal(entry.scripts[1].sourceCharPosition,-1);assert.match(entry.locationNote,/줄 번호가 아니/);assert.ok(!('line' in entry.scripts[0]));
});
test('task history and per-frame script records remain bounded and stop on lock or hidden tabs',()=>{
  const {api,context}=diagnostics();api.enable();for(let i=0;i<240;i++)api.recordStall({entryType:'long-animation-frame',startTime:i*200,duration:80,scripts:Array.from({length:80},(_,i)=>({duration:i}))});assert.equal(api.tasks.length,200);assert.equal(api.tasks[0].scripts.length,8);assert.equal(api.tasks[0].omittedScripts,72);context.document.hidden=true;api.recordStall({entryType:'longtask',duration:90});assert.equal(api.tasks[0].startTime,47800);context.document.hidden=false;api.disable();api.recordStall({entryType:'longtask',duration:90});assert.equal(api.tasks[0].startTime,47800);
});
