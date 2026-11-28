import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source=await readFile(new URL('../adk-offline.js',import.meta.url),'utf8');
const manifest=await readFile(new URL('../adk-assets/resource-list.js',import.meta.url),'utf8');
function controller({fetch=async()=>new Response('ok'),autoTimers=true}={}){
  const nodes=new Map(),timers=new Map(),delays=[],events=[];let now=0,nextTimer=0,open=false;
  function node(){return {textContent:'',disabled:false,addEventListener(){},querySelector(){return null;}};}
  const context={URL,Response,AbortController,AbortSignal,Uint8Array,crypto:webcrypto,fetch,
    location:new URL('https://example.test/app/index.html'),navigator:{onLine:true},performance:{now:()=>now},
    document:{readyState:'loading',getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},querySelectorAll:()=>[],addEventListener(){}},
    window:{isSecureContext:true,addEventListener(){}},appNotifications:[],currentSettingsView:'offline',
    addCustomNotification(type,title,message,url,settingsView){const n={id:'n'+events.length,type,title,message,settingsView,read:open};context.appNotifications.push(n);events.push(['add',message]);return n;},
    updateNotificationUI(){events.push(['render']);},showNotificationPill(n){events.push(['preview',n.message]);},
    updateNotificationContent(n){events.push(['patch',n.message]);},notificationListIsOpen:()=>open,console:{error(){}},
    setTimeout(fn,ms){const id=++nextTimer;delays.push(ms);timers.set(id,fn);if(autoTimers)queueMicrotask(()=>{if(timers.delete(id))fn();});return id;},clearTimeout:id=>timers.delete(id)};
  const expose='window.testOffline={parseResourceList,fetchWithRetry,verifiedResponse,retryDelay,waitForRetry,notifyOffline,setStatus,setProgress,perform,cacheCheckpoint,setController(value){operationController=value;},get busy(){return busy;}};';
  vm.createContext(context);vm.runInContext(source.replace(/\}\)\(\);\s*$/,expose+'})();'),context);
  return {context,api:context.window.testOffline,nodes,timers,delays,events,advance:ms=>now+=ms,setOpen:value=>open=value};
}

test('the complete shipped resource list is accepted, including all SVG logo variants',()=>{
  const {api}=controller(),list=api.parseResourceList(manifest);
  assert.ok(list.files.length>700);
  for(const name of ['adk-assets/adk-logo-light.svg','adk-assets/school-logo-white.svg'])assert.ok(list.files.some(f=>f.name===name));
});
test('resource validation still rejects unsafe paths, unrecognized formats and malformed entries',()=>{
  const {api}=controller();
  for(const name of ['../secret.js','/index.html','x\\y.png','x.js?override','x.js#fragment','x.exe','https://other.test/a.js']){
    assert.throws(()=>api.parseResourceList('window.ADKOfflineResources='+JSON.stringify({revision:'a'.repeat(64),files:[{name}]})));
  }
  assert.throws(()=>api.parseResourceList('window.ADKOfflineResources='+JSON.stringify({revision:'a'.repeat(64),files:[null]})));
});
test('HTTP 503 retries after the server delay, then verifies the recovered response',async()=>{
  let requests=0;const {api,delays}=controller({fetch:async()=>++requests===1?new Response('busy',{status:503,headers:{'Retry-After':'1'}}):new Response('font')});
  const r=await api.fetchWithRetry('/font',{},1000,r=>api.verifiedResponse(r,{name:'font.woff2'}));
  assert.equal(await r.text(),'font');assert.equal(requests,2);assert.deepEqual(delays,[1000]);
});
test('persistent transient failures stop after two retries and keep the HTTP diagnostic',async()=>{
  let requests=0;const {api,delays}=controller({fetch:async()=>{requests++;return new Response('busy',{status:503,headers:{'Retry-After':'0'}});}});
  await assert.rejects(api.fetchWithRetry('/font',{},1000,r=>api.verifiedResponse(r,{name:'font.woff2'})),/font.woff2 \(HTTP 503\)/);
  assert.equal(requests,3);assert.equal(delays.length,2);
});
test('permanent HTTP errors and integrity mismatches are not retried',async()=>{
  for(const status of [404,200]){
    let requests=0;const {api,delays}=controller({fetch:async()=>{requests++;return new Response('bad',{status});}});
    await assert.rejects(api.fetchWithRetry('/font',{},1000,r=>api.verifiedResponse(r,{name:'font.woff2',sha256:'a'.repeat(64)})),status===404?/HTTP 404/:/파일이 변경/);
    assert.equal(requests,1);assert.equal(delays.length,0);
  }
});
test('network failure and body-read timeout both receive a bounded retry',async()=>{
  for(const kind of ['network','body']){
    let requests=0;const {api}=controller({fetch:async()=>{
      requests++;if(requests===1){if(kind==='network')throw new TypeError('network');return {status:200,arrayBuffer:async()=>{throw new DOMException('expired','TimeoutError');},ok:true};}
      return new Response('ok');
    }});
    const r=await api.fetchWithRetry('/font',{},1000,async r=>{await r.arrayBuffer();return 'verified';});
    assert.equal(r,'verified');assert.equal(requests,2);
  }
});
test('long Retry-After fails visibly without waiting indefinitely or retrying too soon',async()=>{
  let requests=0;const {api,delays}=controller({fetch:async()=>{requests++;return new Response('busy',{status:429,headers:{'Retry-After':'120'}});}});
  await assert.rejects(api.fetchWithRetry('/font',{},1000,r=>api.verifiedResponse(r,{name:'font.woff2'})),/HTTP 429/);
  assert.equal(requests,1);assert.equal(delays.length,0);
  assert.ok(api.retryDelay(new Response('',{headers:{'Retry-After':new Date(Date.now()+10000).toUTCString()}}),0)>8000);
});
test('abort during backoff releases its timer and starts no further requests',async()=>{
  let requests=0;const {api,timers}=controller({autoTimers:false,fetch:async()=>{requests++;return new Response('busy',{status:503});}});
  const abort=new AbortController();api.setController(abort);
  const pending=api.fetchWithRetry('/font');
  for(let i=0;i<20&&!timers.size;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(timers.size,1);abort.abort();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(timers.size,0);assert.equal(requests,1);
});
test('one notification tracks progress quietly and announces completion once',async()=>{
  const c=controller(),{api,context,events}=c;context.currentSettingsView='cache-update';
  await api.perform(async()=>{
    context.currentSettingsView='offline';
    for(let done=0;done<=10;done++){c.advance(200);api.setProgress(done,10,'캐시 다운로드 중');}
    assert.equal(context.appNotifications.length,1);assert.equal(events.filter(e=>e[0]==='render').length,1);
    assert.equal(context.appNotifications[0].settingsView,'cache-update');
    api.setStatus('캐시 저장 완료',{done:1,total:1});
  },'준비 중');
  const item=context.appNotifications[0];assert.equal(item.offlineState,'complete');assert.equal(item.offlineProgress.percent,100);
  assert.equal(events.filter(e=>e[0]==='add').length,1);assert.equal(events.filter(e=>e[0]==='preview').length,1);
  assert.equal(events.filter(e=>e[0]==='render').length,2);assert.equal(api.busy,false);
});
test('progress throttling limits UI work and respects dismissal until terminal status',async()=>{
  const c=controller(),{api,context,events}=c;
  await api.perform(async()=>{
    for(let done=0;done<100;done++){c.advance(1);api.setProgress(done,100,'캐시 다운로드 중');}
    assert.ok(events.filter(e=>e[0]==='patch').length<=2);
    context.appNotifications=[];c.advance(200);api.setProgress(50,100,'캐시 다운로드 중');assert.equal(context.appNotifications.length,0);
    api.setStatus('캐시 저장 완료',{done:1,total:1});
  },'준비 중');
  assert.equal(context.appNotifications.length,1);assert.equal(context.appNotifications[0].offlineState,'complete');
});
test('passive background checks create no notification and failures clear busy state',async()=>{
  const {api,context,nodes}=controller();
  await api.perform(async()=>api.setStatus('최신 버전입니다.'),'확인 중',false);assert.equal(context.appNotifications.length,0);
  await api.perform(async()=>{throw Error('HTTP 503');},'준비 중');
  assert.equal(context.appNotifications[0].offlineState,'error');assert.equal(api.busy,false);
  assert.match(nodes.get('offline-cache-status').textContent,/완료하지 못했습니다.*HTTP 503/);
});
test('reading an active operation keeps progress read; terminal status becomes unread',async()=>{
  const c=controller(),{api,context}=c;
  await api.perform(async()=>{
    c.setOpen(true);context.appNotifications[0].read=true;api.setStatus('캐시 다운로드 중',{done:1,total:2});
    assert.equal(context.appNotifications[0].read,true);c.setOpen(false);api.setStatus('캐시 저장 완료',{done:1,total:1});
  },'준비 중');
  assert.equal(context.appNotifications[0].read,false);
});
test('progress stays below 100 percent until all work and final verification finish',async()=>{
  const {api,context}=controller();await api.perform(async()=>{
    api.setStatus('캐시 확인 중',{done:795,total:797});assert.equal(context.appNotifications[0].offlineProgress.percent,99);
    api.setStatus('캐시 저장 완료',{done:1,total:1});
  },'준비 중');assert.equal(context.appNotifications[0].offlineProgress.percent,100);
});
test('pausing blocks all waiting work without polling; resume releases every worker',async()=>{
  const {api,context,timers}=controller(),cache=context.window.ADKOfflineCache;let resumed=0;
  await api.perform(async()=>{
    api.setStatus('캐시 다운로드 중',{done:2,total:10});assert.equal(cache.pause(),true);assert.equal(cache.pause(),false);
    const workers=Array.from({length:4},async()=>{await api.cacheCheckpoint();resumed++;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(resumed,0);assert.equal(timers.size,0);
    const n=context.appNotifications[0];assert.equal(n.offlineState,'paused');assert.equal(n.offlineOperation.paused,true);assert.equal(n.offlineProgress.percent,20);
    assert.equal(cache.resume(),true);await Promise.all(workers);assert.equal(resumed,4);api.setStatus('캐시 저장 완료',{done:1,total:1});
  },'준비 중',true,'cache');
  assert.equal(cache.state,null);assert.equal(context.appNotifications[0].offlineOperation,null);
});
test('cancelling while paused unblocks waiters and clears controls without a completion alert',async()=>{
  const {api,context,nodes}=controller(),cache=context.window.ADKOfflineCache;let resumed=false;
  const operation=api.perform(async()=>{cache.pause();await api.cacheCheckpoint();resumed=true;},'준비 중',true,'cache');
  assert.equal(cache.state.paused,true);assert.equal(cache.cancel(),true);await operation;
  assert.equal(resumed,false);assert.equal(cache.state,null);assert.equal(cache.resume(),false);assert.equal(api.busy,false);
  assert.equal(nodes.get('offline-cache-status').textContent,'캐싱이 취소되었습니다.');
  assert.equal(context.appNotifications[0].offlineState,'cancelled');assert.equal(context.appNotifications[0].offlineOperation,null);
});
test('cancel aborts an active request and does not retry it',async()=>{
  let requests=0,started;const ready=new Promise(resolve=>{started=resolve;});
  const {api,context}=controller({fetch:async(url,{signal})=>{requests++;started();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const operation=api.perform(()=>api.fetchWithRetry('/font'),'준비 중',true,'cache');await ready;
  context.window.ADKOfflineCache.cancel();await operation;assert.equal(requests,1);assert.equal(context.appNotifications[0].offlineState,'cancelled');
});
test('pause and cancel are unavailable for ZIP, update checks and idle operations',async()=>{
  const {api,context}=controller(),cache=context.window.ADKOfflineCache;
  assert.equal(cache.pause(),false);assert.equal(cache.cancel(),false);
  await api.perform(async()=>{assert.equal(cache.pause(),false);assert.equal(cache.cancel(),false);assert.equal(cache.state,null);},'ZIP 생성 중');
});
test('an error during pause clears the paused state and retains its actual diagnostic',async()=>{
  const {api,context,nodes}=controller();
  await api.perform(async()=>{context.window.ADKOfflineCache.pause();throw Error('HTTP 404');},'준비 중',true,'cache');
  assert.match(nodes.get('offline-cache-status').textContent,/HTTP 404/);assert.equal(context.appNotifications[0].offlineState,'error');assert.equal(api.busy,false);
});
