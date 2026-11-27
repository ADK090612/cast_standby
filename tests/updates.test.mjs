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
  const context={document:{getElementById:id=>nodes.get(id)},localStorage:{getItem:()=>snooze},UPDATE_URL:'https://example.test/',updateNotification:node(),updateNotificationHeader:node(),
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
  const context={scheduledUpdateVersion:'',autoUpdateDueAt:0,autoUpdateCountdownId:null,autoUpdateReloadId:null,AUTO_UPDATE_DELAY:3600000,isAutoUpdateEnabled:()=>true,
    cancelScheduledAutoUpdate(){timers.clear();},updateAutoUpdateCountdown(){},setInterval(fn,delay){const id=++nextId;timers.set(id,{fn,delay});return id;},setTimeout(fn,delay){const id=++nextId;timers.set(id,{fn,delay});return id;}};
  vm.createContext(context);vm.runInContext(source('releaseLabel')+source('scheduleAutoUpdate'),context);
  context.scheduleAutoUpdate('2.8.0','build-5');const first=nextId;context.scheduleAutoUpdate('2.8.0','build-5');assert.equal(nextId,first);assert.equal(timers.size,2);
  context.scheduleAutoUpdate('2.8.0','build-6');assert.equal(timers.size,2);assert.equal(context.scheduledUpdateVersion,'2.8.0|build-6');assert.ok(nextId>first);
});
