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
        const control=await caches.open(CACHE_NAME);
        const current=await control.match(STATUS_URL);
        const active=current?await current.json():null;
        const cache=active?.cacheName?await caches.open(active.cacheName):control;
        if(request.mode==='navigate'){
            let source=cache,saved=active;
            if(!saved&&(await caches.keys()).includes(OLD_CACHE)){source=await caches.open(OLD_CACHE);const metadata=await source.match(STATUS_URL);saved=metadata?await metadata.json():null}
            if(!saved||!(saved.pageURLs||[saved.pageURL]).includes(url.origin+url.pathname))return fetch(request);
            return networkOrCache(request,()=>source.match(saved.pageURL));
        }
        if(['script','style','manifest'].includes(request.destination))return networkOrCache(request,()=>cache.match(request));
        return(await cache.match(request))||fetch(request);
    })());
});
async function networkOrCache(request,cached){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3500);
    try{const response=await fetch(request,{signal:controller.signal});if(!response.ok)throw new Error('HTTP '+response.status);return response}
    catch(error){const response=await cached();if(response)return response;throw error}
    finally{clearTimeout(timer)}
}
