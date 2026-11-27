(() => {
    'use strict';
    const bundle = window.ADKOfflineResources;
    const cacheName = 'adk-standby-offline-v2:' + new URL('./', location.href).pathname;
    const status = document.getElementById('offline-cache-status');
    const cacheButton = document.getElementById('offline-cache-btn');
    const zipButton = document.getElementById('offline-download-btn');
    const clearButton = document.getElementById('offline-cache-clear-btn');
    const progressPanels=[...document.querySelectorAll('[data-offline-progress]')];
    const canCache = /^https?:$/.test(location.protocol) && window.isSecureContext && 'caches' in window && 'serviceWorker' in navigator;
    let lastProgressAt=0,lastProgressLabel='';
    function setStatus(message,progress=null) {
        status.textContent=message;cacheUpdateStatus.textContent=message;
        const percent=progress?.total>0?Math.min(100,Math.max(0,Math.round(progress.done/progress.total*100))):null;
        for(const panel of progressPanels) {
            panel.hidden=!message;
            panel.querySelector('[data-offline-progress-value]').textContent=percent===null?'':percent+'%';
            const track=panel.querySelector('[data-offline-progress-track]');track.hidden=percent===null;
            if(percent!==null){track.setAttribute('aria-valuenow',String(percent));panel.querySelector('[data-offline-progress-fill]').style.width=percent+'%';}
            else track.removeAttribute('aria-valuenow');
        }
    }
    function setProgress(done,total,label) {
        const now=performance.now();
        if(done<total&&label===lastProgressLabel&&now-lastProgressAt<150)return;
        lastProgressAt=now;lastProgressLabel=label;setStatus(label,{done,total});
    }
    let busy=false,resetting=false,operationController=null,operationPromise=null,resetPromise=null;
    const resetKey='dashboardOfflineReset:'+new URL('./',location.href).pathname;
    function requestSignal(milliseconds){return operationController?AbortSignal.any([operationController.signal,AbortSignal.timeout(milliseconds)]):AbortSignal.timeout(milliseconds);}
    window.addEventListener('storage',event=>{if(event.key===resetKey||event.key===null)operationController?.abort();});
    function syncOperationControls(){
        const blocked=busy||resetting;
        zipButton.disabled=blocked;cacheButton.disabled=blocked||!canCache;clearButton.disabled=blocked||!canCache;syncCacheUpdateControls();
    }
    function notifyOffline(message){
        if(!message||typeof addCustomNotification!=='function')return;
        let item=appNotifications.find(item=>item.offlineCache===true);
        const settingsView=typeof currentSettingsView!=='undefined'&&currentSettingsView==='cache-update'?'cache-update':'offline';
        if(item){
            const changed=item.message!==message;item.message=message;item.settingsView=settingsView;
            updateNotificationUI();if(changed)showNotificationPill(item);
        }else{
            item=addCustomNotification('general','오프라인',message,undefined,settingsView);
            if(item)item.offlineCache=true;
        }
    }

    let downloadModule;
    async function downloadPackage() {
        if (!window.ADKOfflineDownload) {
            if (!downloadModule) downloadModule=new Promise((resolve,reject)=>{
                const script=document.createElement('script'); script.src=new URL('./adk-download.js',location.href).href;
                script.onload=()=>window.ADKOfflineDownload?resolve():reject(new Error('다운로드 모듈이 올바르지 않습니다.'));
                script.onerror=()=>reject(new Error('adk-download.js 파일을 읽지 못했습니다. HTML과 함께 보관하세요.'));
                document.head.append(script);
            }).catch(error=>{downloadModule=null;throw error});
            await downloadModule;
        }
        await window.ADKOfflineDownload(setStatus,(done,total)=>setProgress(done,total,'ZIP 생성 중'));
    }

    function registerWorker() {
        if (!canCache) return Promise.reject(new Error('브라우저 캐싱은 HTTPS 또는 localhost에서 사용할 수 있습니다. 파일 직접 실행 시 ZIP 패키지를 이용하세요.'));
        return navigator.serviceWorker.register('./sw.js', {scope:'./', updateViaCache:'none'});
    }
    async function activeWorker(registration) {
        const worker = registration.installing || registration.waiting || registration.active;
        if (!worker) throw new Error('서비스 워커를 활성화하지 못했습니다.');
        if (worker.state === 'activated') return;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(new Error('서비스 워커 활성화 시간이 초과되었습니다.')); }, 20000);
            const check = () => {
                if (worker.state === 'activated') { cleanup(); resolve(); }
                else if (worker.state === 'redundant') { cleanup(); reject(new Error('서비스 워커를 활성화하지 못했습니다.')); }
            };
            function cleanup() { clearTimeout(timer); worker.removeEventListener('statechange', check); }
            worker.addEventListener('statechange', check);
            check();
        });
    }
    let latestResources=null,cachedInfo=null;
    const checkCacheUpdateButton=document.getElementById('offline-cache-check-update-btn');
    const applyCacheUpdateButton=document.getElementById('offline-cache-apply-update-btn');
    const cacheUpdateStatus=document.getElementById('offline-cache-update-status');
    const cacheVersionLabel=document.getElementById('offline-cache-version');
    const latestVersionLabel=document.getElementById('offline-cache-latest-version');
    function versionLabel(info){return info?.revision?(info.appVersion||'리소스'):'이전 형식'}
    function syncCacheUpdateControls(){
        checkCacheUpdateButton.disabled=busy||resetting||!canCache;
        applyCacheUpdateButton.disabled=busy||resetting||!canCache||!latestResources||!cachedInfo;
    }
    async function readCacheInfo(){
        if(!canCache)return null;
        const keys=await caches.keys();
        for(const key of [cacheName,'adk-standby-offline-v1:'+new URL('./',location.href).pathname]){
            if(!keys.includes(key))continue;
            const response=await caches.match(new URL('./__adk_offline_status__',location.href),{cacheName:key});
            if(response){const info=await response.json();return {...info,cacheName:info.cacheName||key};}
        }
        return null;
    }
    async function refreshCacheInfo(){
        cachedInfo=await readCacheInfo();
        cacheVersionLabel.textContent=cachedInfo?versionLabel(cachedInfo):'없음';
        syncCacheUpdateControls();
    }
    function parseResourceList(text){
        const match=text.match(/^\s*window\.ADKOfflineResources\s*=\s*([\s\S]+?)\s*;?\s*$/);
        if(!match)throw new Error('서버의 리소스 버전 정보를 읽지 못했습니다.');
        const info=JSON.parse(match[1].replace(/;\s*$/,''));
        if(!/^[a-f0-9]{64}$/.test(info.revision)||!Array.isArray(info.files)||!info.files.length||info.files.length>3000)throw new Error('리소스 버전 정보가 올바르지 않습니다.');
        const base=new URL('./',location.href);
        for(const file of info.files){
            if(typeof file.name!=='string'||file.name.includes('\\')||file.name.includes('..')||/[?#]/.test(file.name)||file.name.startsWith('/')||!/[.](html|js|css|woff2|png|json|txt)$/.test(file.name))throw new Error('리소스 파일 목록이 올바르지 않습니다.');
            const url=new URL(file.name,base);
            if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname))throw new Error('리소스 경로가 올바르지 않습니다.');
        }
        return info;
    }
    async function fetchLatestResources(){
        const url=new URL('./adk-assets/resource-list.js',location.href);url.searchParams.set('check',Date.now());
        const response=await fetch(url,{cache:'no-store',signal:requestSignal(15000)});
        if(!response.ok)throw new Error('최신 캐시 버전을 확인하지 못했습니다. (HTTP '+response.status+')');
        return parseResourceList(await response.text());
    }
    async function checkCacheUpdates(){
        latestResources=null;
        await refreshCacheInfo();
        const latest=await fetchLatestResources();
        latestVersionLabel.textContent=versionLabel(latest);
        if(!cachedInfo)setStatus('저장된 캐시 없음');
        else if(cachedInfo.revision===latest.revision)setStatus('최신 버전입니다.');
        else{latestResources=latest;setStatus('캐시 업데이트 가능');}
        syncCacheUpdateControls();
    }
    async function verifiedResponse(response,file){
        if(!response.ok)throw new Error('리소스를 저장하지 못했습니다: '+file.name+' (HTTP '+response.status+')');
        if(file.sha256){
            const bytes=await response.arrayBuffer();
            const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
            if(hash!==file.sha256)throw new Error('저장 중 서버의 파일이 변경되었습니다. 다시 확인해 주세요: '+file.name);
            return new Response(bytes,{headers:response.headers,status:response.status});
        }
        return response;
    }
    async function cacheInBrowser(resourceSet=bundle){
        if(!canCache)throw new Error('브라우저 캐싱은 HTTPS 또는 localhost에서 사용할 수 있습니다.');
        return withOfflineCacheLock(()=>writeBrowserCache(resourceSet),operationController?.signal);
    }
    async function writeBrowserCache(resourceSet){
        const signal=operationController?.signal;signal?.throwIfAborted();
        const saved=await readCacheInfo(),names=await caches.keys();
        const source=saved&&names.includes(saved.cacheName)?await caches.open(saved.cacheName):null;
        if(source&&saved.revision===resourceSet.revision){
            const urls=new Set((await source.keys()).map(request=>request.url));
            if(resourceSet.files.every(file=>urls.has(new URL(file.name,location.href).href))&&urls.has(saved.pageURL)){
                const scope=new URL('./',location.href).href,script=new URL('./sw.js',location.href).href;
                if(!(await navigator.serviceWorker.getRegistrations()).some(registration=>registration.scope===scope&&registration.active?.scriptURL===script))await activeWorker(await registerWorker());
                signal?.throwIfAborted();latestResources=null;await refreshCacheInfo();setStatus('이미 캐싱되어 있습니다.',{done:1,total:1});return;
            }
        }
        const registration=await registerWorker();await activeWorker(registration);
        const dataName=cacheName+':'+resourceSet.revision+':'+Date.now();
        const cache=await caches.open(dataName);
        const pageURL=new URL(location.href);pageURL.hash='';pageURL.search='';
        let committed=false;
        try{
            const resources=resourceSet.files.filter(file=>file.name!==resourceSet.pageName);
            let cursor=0,done=0;
            setProgress(0,resources.length+2,'캐시 다운로드 중');
            const results=await Promise.allSettled(Array.from({length:4},async()=>{
                while(cursor<resources.length){
                    const file=resources[cursor++],url=new URL(file.name,location.href);
                    let response=null;
                    if(source&&(file.sha256||saved.revision===resourceSet.revision)){
                        const previous=await source.match(url);
                        if(previous)try{response=await verifiedResponse(previous,file);}catch{}
                    }
                    if(!response)response=await verifiedResponse(await fetch(url,{cache:'reload',signal:requestSignal(60000)}),file);
                    signal?.throwIfAborted();await cache.put(url,response);
                    setProgress(++done,resources.length+2,'캐시 다운로드 중');
                }
            }));
            const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
            const additional=new Set();
            for(const image of document.images)if(/^https?:/.test(image.src)&&new URL(image.src).origin!==location.origin)additional.add(image.src);
            for(const node of [document.body,...document.querySelectorAll('[style*="url("]')])for(const match of getComputedStyle(node).backgroundImage.matchAll(/url\(["']?(https?:[^"')]+)["']?\)/g))if(new URL(match[1]).origin!==location.origin)additional.add(match[1]);
            for(const url of additional){const response=(source&&await source.match(url))||await fetch(url,{mode:'no-cors',cache:'reload',signal:requestSignal(30000)});if(!response.ok&&response.type!=='opaque')throw new Error('이미지 저장 실패: '+url);signal?.throwIfAborted();await cache.put(url,response)}
            setStatus('캐시 확인 중',{done:resources.length,total:resources.length+2});
            const pageFile=resourceSet.files.find(file=>file.name===resourceSet.pageName);
            let htmlResponse=null;
            if(source){const previous=await source.match(pageURL);if(previous)try{htmlResponse=await verifiedResponse(previous,pageFile);}catch{}}
            if(!htmlResponse)htmlResponse=await verifiedResponse(await fetch(pageURL,{cache:'reload',signal:requestSignal(30000)}),pageFile);
            const pageURLs=[...new Set([pageURL.href,new URL('./index.html',pageURL).href,new URL('./',pageURL).href])];
            for(const url of pageURLs)await cache.put(url,htmlResponse.clone());
            const current=await fetchLatestResources();
            if(current.revision!==resourceSet.revision)throw new Error('저장 중 리소스 버전이 변경되었습니다. 최신 버전을 다시 확인해 주세요.');
            const info={pageURL:pageURL.href,pageURLs,cacheName:dataName,savedAt:new Date().toISOString(),fonts:resourceSet.fontCount,revision:resourceSet.revision,appVersion:resourceSet.appVersion};
            const control=await caches.open(cacheName);
            signal?.throwIfAborted();
            await control.put(new URL('./__adk_offline_status__',location.href),new Response(JSON.stringify(info),{headers:{'Content-Type':'application/json'}}));
            committed=true;latestResources=null;
            for(const key of await caches.keys())if(key.startsWith(cacheName+':')&&key!==dataName)await caches.delete(key);
            await caches.delete('adk-standby-offline-v1:'+new URL('./',location.href).pathname);
            await refreshCacheInfo();
            setStatus('캐시 저장 완료',{done:1,total:1});
        }finally{if(!committed)await caches.delete(dataName);}
    }
    function runCacheUpdate(action,message,notify=true){
        return perform(action,message,notify);
    }
    checkCacheUpdateButton.addEventListener('click',()=>runCacheUpdate(checkCacheUpdates,'최신 캐시 버전을 확인하고 있습니다…'));
    applyCacheUpdateButton.addEventListener('click',()=>runCacheUpdate(async()=>{
        if(!latestResources||!cachedInfo)throw new Error('최신 캐시 버전을 먼저 확인해 주세요.');
        await cacheInBrowser(latestResources);
        setStatus('캐시 업데이트 완료',{done:1,total:1});
    },'새 버전의 캐시를 저장하고 있습니다…'));
    document.getElementById('manual-check-update-btn')?.addEventListener('click',()=>{if(canCache)runCacheUpdate(checkCacheUpdates,'최신 캐시 버전을 확인하고 있습니다…')});
    document.addEventListener('click',event=>{if(event.target.closest('[data-view="update"]')&&canCache)runCacheUpdate(checkCacheUpdates,'최신 캐시 버전을 확인하고 있습니다…',false)});
    function setupCacheUpdateMenu(){
        const popup=document.querySelector('#update-view .update-settings-popup');
        if(!popup||document.getElementById('offline-cache-update-menu-btn'))return;
        const button=document.createElement('button');button.id='offline-cache-update-menu-btn';button.type='button';button.className='glass-button w-full';button.textContent='오프라인 캐시 업데이트';
        button.addEventListener('click',()=>{
            popup.hidden=true;document.querySelector('#update-view .update-settings-trigger')?.setAttribute('aria-expanded','false');
            switchSettingsView('cache-update');
            if(canCache)runCacheUpdate(checkCacheUpdates,'최신 캐시 버전을 확인하고 있습니다…');
        });
        popup.append(button);
        document.getElementById('back-settings-btn').addEventListener('click',event=>{
            if(currentSettingsView==='cache-update'){event.stopImmediatePropagation();switchSettingsView('update')}
        },true);
    }
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setupCacheUpdateMenu,{once:true});else setupCacheUpdateMenu();
    refreshCacheInfo().catch(error=>{const message='캐시 정보를 읽지 못했습니다. '+error.message;setStatus(message);notifyOffline(message);});

    async function clearBrowserCache(message) {
        await clearOfflineBrowserStorage();latestResources=null;await refreshCacheInfo();setStatus(message||'오프라인 데이터 삭제 완료');
    }
    function perform(action,message,notify=true) {
        if(busy||resetting)return Promise.resolve();
        busy=true;operationController=new AbortController();const controller=operationController;syncOperationControls();setStatus(message);
        if(notify)notifyOffline(message);
        operationPromise=(async()=>{
            try{await action();if(notify&&!controller.signal.aborted)notifyOffline(status.textContent);}
            catch(error){if(!controller.signal.aborted){setStatus('완료하지 못했습니다. '+error.message);if(notify)notifyOffline(status.textContent);console.error('ADK offline:',error);}else if(!resetting){setStatus('캐싱이 취소되었습니다.');if(notify)notifyOffline(status.textContent);}}
            finally{busy=false;operationController=null;syncOperationControls();}
        })();
        return operationPromise;
    }
    window.ADKOfflineCache={clear(){
        if(resetPromise)return resetPromise;
        resetting=true;operationController?.abort();syncOperationControls();
        resetPromise=(async()=>{if(operationPromise)await operationPromise;await clearBrowserCache();notifyOffline('오프라인 데이터 삭제 완료');})().finally(()=>{resetting=false;resetPromise=null;syncOperationControls();});
        return resetPromise;
    }};
    syncOperationControls();
    clearButton.addEventListener('click', () => perform(() => clearBrowserCache('캐시 삭제 완료'),'캐시 삭제 중'));
    cacheButton.addEventListener('click', () => perform(cacheInBrowser,'브라우저 캐싱을 준비하고 있습니다…'));
    zipButton.addEventListener('click', () => perform(downloadPackage,'오프라인 ZIP 패키지를 만들고 있습니다…'));
    if(!canCache)setStatus('브라우저 캐싱 지원 안 됨');

    const offlineMessage = '오프라인 구동 중입니다. 외부 정보를 가져오지 못 할 수 있습니다.';
    let wasOffline = false;
    function updateNetworkNotification() {
        if (!navigator.onLine) {
            if (!wasOffline) {
                addCustomNotification('network','시스템',offlineMessage,undefined,'offline');
            }
            wasOffline=true;
        } else {
            wasOffline=false;
            if (appNotifications.some(item=>item.message===offlineMessage)) {
                appNotifications=appNotifications.filter(item=>item.message!==offlineMessage); updateNotificationUI();
                if (document.getElementById('custom-notification-container').classList.contains('open')) showAllNotifications();
            }
        }
    }
    window.addEventListener('offline',updateNetworkNotification);
    window.addEventListener('online',updateNetworkNotification);
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',updateNetworkNotification,{once:true});
    else updateNetworkNotification();
})();
