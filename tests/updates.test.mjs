import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
function source(name){
  const start=html.indexOf('        function '+name+'('),end=html.indexOf('\n        function ',start+10);
  assert.ok(start>=0&&end>start,name);return html.slice(start,end);
}
const helperSource=['readReleaseMetadata','releaseUpdateAvailable','releaseLabel'].map(source).join('\n');
const helpers={};vm.createContext(helpers);vm.runInContext(helperSource,helpers);
const local={version:'2.8.0',build:'Ko-Kr-Daeryun-hs-v.2.8.0-4'};
function remoteMarkup(version='2.8.0',build='Ko-Kr-Daeryun-hs-v.2.8.0-5'){
  return `<p data-version='${version}' class='version' id='app-version-text'>${version}</p><p data-build='${build}' id='app-build-number'>${build}</p>`;
}

test('release metadata supports either attribute order and quote style',()=>{
  const result=helpers.readReleaseMetadata(remoteMarkup());assert.equal(result.version,'2.8.0');assert.equal(result.build,'Ko-Kr-Daeryun-hs-v.2.8.0-5');
  const current=helpers.readReleaseMetadata(html);assert.equal(current.version,local.version);
  assert.equal(current.build,html.match(/id="app-build-number"[^>]*data-build="([^"]+)"/)[1]);
});

for(const [name,remote,expected] of [
  ['same version, newer build',{version:'2.8.0',build:'Ko-Kr-Daeryun-hs-v.2.8.0-5'},true],
  ['same release',local,false],
  ['same version, older build',{version:'2.8.0',build:'Ko-Kr-Daeryun-hs-v.2.8.0-3'},false],
  ['numeric build suffix 10 after 4',{version:'2.8.0',build:'Ko-Kr-Daeryun-hs-v.2.8.0-10'},true],
  ['newer app version without build',{version:'2.9.0',build:''},true],
  ['older app version despite larger build',{version:'2.7.9',build:'Ko-Kr-Daeryun-hs-v.2.7.9-999'},false],
  ['legacy same version without build',{version:'2.8.0',build:''},false],
  ['missing release metadata',{version:'',build:''},false],
  ['invalid version metadata',{version:'latest',build:'next'},false],
  ['a changed nonnumeric build identifier',{version:'2.8.0',build:'release-b'},true],
])test(name,()=>assert.equal(helpers.releaseUpdateAvailable(local,remote),expected));

function checkController({remote=remoteMarkup(),auto=true,snooze='0',offline=false}={}){
  const nodes=new Map(),alerts=[],scheduled=[];let requests=0,cancelled=0;
  function node(){const classes=new Set(['hidden']);return {textContent:'',classList:{add:(...names)=>names.forEach(n=>classes.add(n)),remove:(...names)=>names.forEach(n=>classes.delete(n)),contains:name=>classes.has(name)},getAttribute(){},querySelector:()=>node()};}
  for(const id of ['app-version-text','app-build-number','update-status-text','install-update-btn'])nodes.set(id,node());
  nodes.get('app-version-text').getAttribute=()=>local.version;nodes.get('app-build-number').getAttribute=()=>local.build;
  const context={developerUpdateSimulationActive:false,updateCheckGeneration:0,document:{getElementById:id=>nodes.get(id)},localStorage:{getItem:()=>snooze},UPDATE_URL:'https://example.test/',updateNotification:node(),updateNotificationHeader:node(),
    fetch:async()=>{requests++;if(offline)throw Error('offline');return {ok:true,text:async()=>remote};},console:{error(){}},alert:message=>alerts.push(message),isAutoUpdateEnabled:()=>auto,scheduleAutoUpdate:(...args)=>scheduled.push(args),cancelScheduledAutoUpdate:()=>cancelled++};
  const start=html.indexOf('        async function checkForUpdates('),end=html.indexOf('\n        updateNotificationHeader.addEventListener',start);
  vm.createContext(context);vm.runInContext(helperSource+html.slice(start,end),context);
  return {context,nodes,alerts,scheduled,get requests(){return requests;},get cancelled(){return cancelled;}};
}

test('a newer build takes the existing manual install and auto-update route',async()=>{
  const c=checkController();await c.context.checkForUpdates(true);
  assert.equal(c.nodes.get('install-update-btn').classList.contains('hidden'),false);assert.equal(c.scheduled.length,1);assert.deepEqual(c.scheduled[0],['2.8.0','Ko-Kr-Daeryun-hs-v.2.8.0-5']);
  assert.ok(c.alerts[0].includes('2.8.0-5'));assert.ok(c.alerts[0].includes('1시간'));assert.ok(c.nodes.get('update-status-text').textContent.includes('빌드'));
});

test('automatic detection displays the existing banner and honors disabled automatic installation',async()=>{
  const c=checkController({auto:false});await c.context.checkForUpdates();assert.equal(c.context.updateNotification.classList.contains('hidden'),false);assert.equal(c.scheduled.length,0);assert.equal(c.alerts.length,0);
});

test('snoozing still suppresses automatic checks while manual checks bypass it',async()=>{
  const c=checkController({snooze:'-1'});await c.context.checkForUpdates();assert.equal(c.requests,0);await c.context.checkForUpdates(true);assert.equal(c.requests,1);
});

test('matching and older releases clear stale installation and countdown state',async()=>{
  for(const build of [local.build,'Ko-Kr-Daeryun-hs-v.2.8.0-3']){
    const c=checkController({remote:remoteMarkup(local.version,build)});c.nodes.get('install-update-btn').classList.remove('hidden');await c.context.checkForUpdates(true);
    assert.equal(c.nodes.get('install-update-btn').classList.contains('hidden'),true);assert.equal(c.cancelled,1);assert.ok(c.alerts[0].includes('최신 버전'));assert.ok(c.alerts[0].includes(local.build));
  }
});

test('network failure reports the existing error without offering a fabricated build',async()=>{
  const c=checkController({offline:true});await c.context.checkForUpdates(true);assert.equal(c.scheduled.length,0);assert.equal(c.alerts[0],'서버에 연결할 수 없습니다.');
});

test('auto-update identity includes the build and coalesces repeated checks',()=>{
  let nextId=0;const timers=new Map();
  const context={scheduledUpdateVersion:'',autoUpdateDueAt:0,autoUpdateCountdownId:null,autoUpdateReloadId:null,autoUpdateGeneration:0,autoUpdateSimulation:false,autoUpdateDuration:3600000,document:{getElementById:()=>null},AUTO_UPDATE_DELAY:3600000,isAutoUpdateEnabled:()=>true,
    cancelScheduledAutoUpdate(){timers.clear();},updateAutoUpdateCountdown(){},setInterval(fn,delay){const id=++nextId;timers.set(id,{fn,delay});return id;},setTimeout(fn,delay){const id=++nextId;timers.set(id,{fn,delay});return id;}};
  vm.createContext(context);vm.runInContext(source('releaseLabel')+source('scheduleAutoUpdate'),context);
  context.scheduleAutoUpdate('2.8.0','build-5');const first=nextId;context.scheduleAutoUpdate('2.8.0','build-5');assert.equal(nextId,first);assert.equal(timers.size,2);
  context.scheduleAutoUpdate('2.8.0','build-6');assert.equal(timers.size,2);assert.equal(context.scheduledUpdateVersion,'2.8.0|build-6');assert.ok(nextId>first);
});

test('virtual build comparison uses the actual detection flow without a network request',async()=>{
  const c=checkController({auto:false,snooze:'-1'});c.context.developerUpdateSimulationActive=true;
  await c.context.checkForUpdates(false,{remote:{version:local.version,build:'Ko-Kr-Daeryun-hs-v.2.8.0-5'},force:true,delayMs:10000});
  assert.equal(c.requests,0);assert.equal(c.scheduled.length,1);assert.equal(c.scheduled[0][2].simulation,true);assert.equal(c.scheduled[0][2].delayMs,10000);
  assert.equal(c.nodes.get('install-update-btn').classList.contains('hidden'),false);
  await c.context.checkForUpdates();assert.equal(c.requests,0,'Live polls stay idle during a simulation');
});
test('matching and older virtual releases do not schedule forced installation',async()=>{
  for(const build of [local.build,'Ko-Kr-Daeryun-hs-v.2.8.0-3']){
    const c=checkController();c.context.developerUpdateSimulationActive=true;
    await c.context.checkForUpdates(false,{remote:{version:local.version,build},force:true,delayMs:10000});assert.equal(c.scheduled.length,0);assert.equal(c.requests,0);
  }
});
test('a live response started before simulation cannot overwrite the simulated release',async()=>{
  const c=checkController();let resolve;c.context.fetch=()=>new Promise(r=>{resolve=r;});const request=c.context.checkForUpdates();
  c.context.updateCheckGeneration++;c.context.developerUpdateSimulationActive=true;resolve({ok:true,text:async()=>remoteMarkup()});await request;
  assert.equal(c.scheduled.length,0);assert.equal(c.nodes.get('install-update-btn').classList.contains('hidden'),true);
});
function scheduler({auto=false}={}){
  let now=1000,next=0,reloads=0;const timers=new Map(),nodes=new Map();
  function node(){const classes=new Set();return {textContent:'',disabled:false,style:{},classList:{add:(...x)=>x.forEach(y=>classes.add(y)),remove:(...x)=>x.forEach(y=>classes.delete(y)),contains:x=>classes.has(x)},querySelector(){return node();}};}
  const c={scheduledUpdateVersion:'',autoUpdateDueAt:0,autoUpdateCountdownId:null,autoUpdateReloadId:null,autoUpdateFinalizeId:null,autoUpdateDuration:3600000,autoUpdateSimulation:false,autoUpdateGeneration:0,AUTO_UPDATE_DELAY:3600000,
    developerUpdateSimulationActive:true,developerOptionsEnabled:true,developerUpdatePhase:'',isAutoUpdateEnabled:()=>auto,Date:class extends Date{static now(){return now;}},document:{getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);}},updateNotification:node(),updateNotificationHeader:node(),window:{location:{reload(){reloads++;}}},
    setTimeout(fn,ms){const id=++next;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id),setInterval(fn,ms){const id=++next;timers.set(id,{fn,at:now+ms,interval:ms});return id;},clearInterval:id=>timers.delete(id)};
  vm.createContext(c);vm.runInContext(['releaseLabel','updateAutoUpdateCountdown','clearAutoUpdateCountdown','cancelScheduledAutoUpdate','scheduleAutoUpdate','beginScheduledUpdate'].map(source).join('\n'),c);
  function tick(ms){const end=now+ms;while(true){const next=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;const [id,t]=next;now=t.at;if(t.interval)timers.set(id,{...t,at:now+t.interval});else timers.delete(id);t.fn();}now=end;}
  return {c,nodes,timers,tick,get reloads(){return reloads;}};
}
test('forced simulation counts down, prepares, completes, and never reloads',()=>{
  const s=scheduler();s.c.scheduleAutoUpdate('99.0.0','test',{simulation:true,delayMs:10000});assert.equal(s.nodes.get('update-notification-remaining').textContent,'00:10');
  s.tick(5000);assert.equal(s.nodes.get('update-notification-fill').style.width,'50%');s.tick(5000);assert.equal(s.c.developerUpdatePhase,'preparing');
  s.tick(2500);assert.equal(s.c.developerUpdatePhase,'complete');assert.equal(s.reloads,0);assert.equal(s.timers.size,0);
});
test('skipping a simulated countdown cancels its old deadline instead of applying twice',()=>{
  const s=scheduler();s.c.scheduleAutoUpdate('99.0.0','test',{simulation:true,delayMs:10000});s.tick(2000);s.c.beginScheduledUpdate('99.0.0','test',s.c.autoUpdateGeneration);s.tick(2500);
  assert.equal(s.c.developerUpdatePhase,'complete');assert.equal(s.timers.size,0);s.tick(20000);assert.equal(s.reloads,0);
});
test('cancel during preparation clears the final application timer',()=>{
  const s=scheduler();s.c.scheduleAutoUpdate('99.0.0','test',{simulation:true,delayMs:1000});s.tick(1000);assert.equal(s.c.developerUpdatePhase,'preparing');s.c.cancelScheduledAutoUpdate();
  s.tick(5000);assert.equal(s.timers.size,0);assert.equal(s.reloads,0);assert.equal(s.c.autoUpdateDueAt,0);
});
test('normal automatic update keeps its one-hour wait and actual reload path',()=>{
  const s=scheduler({auto:true});s.c.scheduleAutoUpdate('99.0.0','real');s.tick(3599999);assert.equal(s.reloads,0);s.tick(1);assert.equal(s.timers.size,1);s.tick(2500);assert.equal(s.reloads,1);
});
test('a restored real deadline retains its remaining duration',()=>{
  const s=scheduler({auto:true});s.c.scheduleAutoUpdate('99.0.0','real',{dueAt:6000});s.tick(4999);assert.equal(s.reloads,0);s.tick(2501);assert.equal(s.reloads,1);
});
