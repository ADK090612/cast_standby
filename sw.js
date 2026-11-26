'use strict';
const directory = new URL('./', self.registration.scope).pathname;
const CACHE_NAME = 'adk-standby-offline-v2:' + directory;
const OLD_CACHE = 'adk-standby-offline-v1:' + directory;
const STATUS_URL = new URL('./__adk_offline_status__', self.registration.scope).href;
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
    const request=event.request,url=new URL(request.url);
    if(request.method!=='GET'||!/^https?:$/.test(url.protocol))return;
    if(request.mode!=='navigate'&&!['style','script','font','image','manifest'].includes(request.destination))return;
    event.respondWith((async()=>{
        // Explicit refreshes from the cache manager must reach the server.
        if(request.cache==='reload'||request.cache==='no-store')return fetch(request);
        // Reading an uninstalled package must not recreate caches after a reset.
        const names=await caches.keys();
        if(!names.includes(CACHE_NAME)&&!names.includes(OLD_CACHE))return fetch(request);
        const controlName=names.includes(CACHE_NAME)?CACHE_NAME:OLD_CACHE;
        const current=await caches.match(STATUS_URL,{cacheName:controlName});
        const active=current?await current.json():null;
        const activeName=active?.cacheName&&names.includes(active.cacheName)?active.cacheName:controlName;
        if(request.mode==='navigate'){
            let sourceName=activeName,saved=active;
            if(!saved&&names.includes(OLD_CACHE)){sourceName=OLD_CACHE;const metadata=await caches.match(STATUS_URL,{cacheName:sourceName});saved=metadata?await metadata.json():null}
            if(!saved||!(saved.pageURLs||[saved.pageURL]).includes(url.origin+url.pathname))return fetch(request);
            return networkOrCache(request,()=>caches.match(saved.pageURL,{cacheName:sourceName}));
        }
        if(['script','style','manifest'].includes(request.destination))return networkOrCache(request,()=>caches.match(request,{cacheName:activeName}));
        return(await caches.match(request,{cacheName:activeName}))||fetch(request);
    })());
});
async function networkOrCache(request,cached){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3500);
    try{const response=await fetch(request,{signal:controller.signal});if(!response.ok)throw new Error('HTTP '+response.status);return response}
    catch(error){const response=await cached();if(response)return response;throw error}
    finally{clearTimeout(timer)}
}
