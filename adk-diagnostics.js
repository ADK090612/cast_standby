// Loaded only after developer options are enabled. No hooks, timers, or sampling run on load.
(() => {
    'use strict';
    const MAX_APIS=20,MAX_LOGS=100,MAX_BODY=65536,MAX_PENDING=2;
    let active=false,apiEnabled=false,logsEnabled=false,performanceEnabled=false,overlayEnabled=false;
    let generation=0,nextId=0,uiController=null,viewObserver=null,longTaskObserver=null,timer=null,frame=null,dirty=false;
    let originalFetch=null,fetchHook=null,originalConsole=null,consoleHooks=null;
    let sampleStart=0,frames=0,lastFrame=0,maxFrameGap=0,weatherFrames=0,weatherCost=0,weatherMax=0,longTasks=0,longTaskMs=0;
    let lastSample=null,apiSequence=0,logSequence=0,listSignature='',selectedSignature='',sampling=false;
    const apis=[],logs=[],pending=new Set(),$=id=>document.getElementById(id);
    const permitted=()=>active&&window.__dashboardDeveloperOptionsEnabled?.()===true;
    function safeURL(value){
        try{const url=new URL(value,location.href);for(const key of [...url.searchParams.keys()])if(/key|token|secret|auth|appid/i.test(key))url.searchParams.set(key,'[숨김]');return url.href.slice(0,2048);}catch{return String(value).slice(0,2048);}
    }
    function isAPI(url){return /(^|\.)(neis\.go\.kr|openweathermap\.org|open-meteo\.com|safetydata\.go\.kr|data\.go\.kr|noembed\.com)$/.test(url.hostname);}
    function summarize(value){
        try{
            if(value instanceof Error)return (value.name+': '+value.message+'\n'+(value.stack||'')).slice(0,4000);
            if(typeof value==='string')return value.slice(0,4000);
            if(value===null||['number','boolean','undefined','bigint'].includes(typeof value))return String(value);
            if(Array.isArray(value))return '[배열 '+value.length+'개] '+value.slice(0,8).map(item=>typeof item==='object'?'[객체]':String(item).slice(0,100)).join(', ');
            return '[객체] '+Object.keys(value).slice(0,8).join(', ');
        }catch{return '[요약할 수 없는 값]';}
    }
    function record(level,message){
        if(!permitted()||!logsEnabled)return;
        logs.unshift({id:++nextId,time:new Date().toISOString(),level,message:String(message).slice(0,4000)});
        if(logs.length>MAX_LOGS)logs.length=MAX_LOGS;logSequence++;dirty=true;
    }
    async function captureBody(response,entry,run){
        if(pending.size>=MAX_PENDING){entry.body='원본 동시 기록 한도에 도달했습니다.';dirty=true;return;}
        let reader,timeout=null,limited=false,timedOut=false;
        try{
            const clone=response.clone();reader=clone.body?.getReader();
            if(!reader){entry.body='읽을 수 있는 응답 본문이 없습니다.';return;}
            const task={cancel(){reader.cancel().catch(()=>{});}};pending.add(task);
            try{
                timeout=setTimeout(()=>{timedOut=true;task.cancel();},5000);
                const decoder=new TextDecoder();let text='',bytes=0;
                while(permitted()&&apiEnabled&&generation===run){
                    const part=await reader.read();if(part.done)break;
                    const count=Math.min(part.value.byteLength,MAX_BODY-bytes);
                    text+=decoder.decode(part.value.subarray(0,count),{stream:true});bytes+=count;
                    if(bytes>=MAX_BODY){limited=true;task.cancel();break;}
                }
                text+=decoder.decode();
                if(generation===run&&permitted()&&apiEnabled){entry.bytes=bytes;entry.body=text+(limited?'\n[64KB 이후 생략]':timedOut?'\n[원본 기록 시간 제한]':'');entry.truncated=limited||timedOut;dirty=true;}
            }finally{pending.delete(task);}
        }catch(error){if(generation===run&&permitted()){entry.body='원본 읽기 실패: '+summarize(error);dirty=true;}}
        finally{if(timeout!==null)clearTimeout(timeout);}
    }
    function syncHooks(){
        const needFetch=permitted()&&(apiEnabled||logsEnabled);
        if(needFetch&&!fetchHook){
            originalFetch=window.fetch;
            fetchHook=async function(input,options){
                let url;try{url=new URL(input instanceof Request?input.url:String(input),location.href);}catch{return originalFetch.call(this,input,options);}
                if(!permitted()||!isAPI(url))return originalFetch.call(this,input,options);
                const started=performance.now(),run=generation,address=safeURL(url.href);
                try{
                    const response=await originalFetch.call(this,input,options),ms=performance.now()-started;
                    if(permitted()&&run===generation){
                        record('api',response.status+' · '+ms.toFixed(1)+'ms · '+address);
                        if(apiEnabled){
                            const entry={id:++nextId,time:new Date().toISOString(),url:address,status:response.status,headerMs:+ms.toFixed(1),body:'원본 읽는 중…',bytes:0,truncated:false};
                            apis.unshift(entry);if(apis.length>MAX_APIS)apis.length=MAX_APIS;apiSequence++;dirty=true;
                            void captureBody(response,entry,run);
                        }
                    }
                    return response;
                }catch(error){if(permitted()&&run===generation){record('api-error',address+' · '+summarize(error));if(apiEnabled){apis.unshift({id:++nextId,time:new Date().toISOString(),url:address,status:'오류',headerMs:+(performance.now()-started).toFixed(1),body:summarize(error),bytes:0});if(apis.length>MAX_APIS)apis.length=MAX_APIS;apiSequence++;dirty=true;}}throw error;}
            };
            window.fetch=fetchHook;
        }else if(!needFetch&&fetchHook){if(window.fetch===fetchHook)window.fetch=originalFetch;fetchHook=null;}
        if(permitted()&&logsEnabled&&!consoleHooks){
            originalConsole={};consoleHooks={};
            for(const level of ['log','info','warn','error','debug']){
                const original=console[level];originalConsole[level]=original;
                consoleHooks[level]=function(...args){record(level,args.slice(0,8).map(summarize).join(' '));return original.apply(this,args);};console[level]=consoleHooks[level];
            }
        }else if((!permitted()||!logsEnabled)&&consoleHooks){for(const level of Object.keys(consoleHooks))if(console[level]===consoleHooks[level])console[level]=originalConsole[level];consoleHooks=null;originalConsole=null;}
    }
    function panelVisible(){return !$('settings-modal').classList.contains('hidden')&&!$('developer-options-view').classList.contains('hidden');}
    function samplingVisible(){return permitted()&&performanceEnabled&&!document.hidden&&(overlayEnabled||panelVisible());}
    function measureFrame(now){
        if(!sampling){frame=null;return;}
        frames++;if(lastFrame)maxFrameGap=Math.max(maxFrameGap,now-lastFrame);lastFrame=now;frame=requestAnimationFrame(measureFrame);
    }
    function weatherFrameSample(now,cost){if(!sampling)return;weatherFrames++;weatherCost+=cost;weatherMax=Math.max(weatherMax,cost);}
    function setText(node,text){if(node&&node.textContent!==text)node.textContent=text;}
    function metricsText(){
        const version=$('app-version-text')?.dataset.version||'',build=$('app-build-number')?.dataset.build||'';
        if(!performanceEnabled)return '성능 측정이 꺼져 있습니다.\n현재 파일: '+safeURL(location.href)+'\n버전 '+version+' · '+build;
        if(!lastSample)return '첫 성능 표본을 준비하고 있습니다…';
        const m=lastSample,heap=Number.isFinite(performance.memory?.usedJSHeapSize)?(performance.memory.usedJSHeapSize/1048576).toFixed(1)+'MB':'브라우저 미지원';
        return `화면 갱신 FPS: ${m.fps} · 가장 긴 프레임 간격 ${m.gap}ms\n날씨 그리기 FPS: ${m.weatherFPS} · 평균 ${m.cost}ms / 최대 ${m.max}ms\n긴 작업: ${longTasks}회 · 누적 ${longTaskMs.toFixed(1)}ms\nJS 힙: ${heap}\nAPI 기록 ${apis.length}/${MAX_APIS} · 로그 ${logs.length}/${MAX_LOGS}\n현재 파일: ${safeURL(location.href)}\n버전 ${version} · ${build}`;
    }
    function renderRecords(){
        const kind=$('dev-diagnostics-kind').value,entries=kind==='api'?apis:logs;
        const signature=kind+':'+(kind==='api'?apiSequence:logSequence),select=$('dev-diagnostics-entry'),previous=select.value;
        if(signature!==listSignature){
            const options=entries.map(entry=>{const option=document.createElement('option');option.value=String(entry.id);option.textContent=(entry.time.slice(11,19)+' · '+(kind==='api'?entry.status+' '+entry.url:entry.level+' '+entry.message)).slice(0,160);return option;});
            if(!options.length){const option=document.createElement('option');option.value='';option.textContent='기록 없음';options.push(option);}
            select.replaceChildren(...options);if(entries.some(entry=>String(entry.id)===previous))select.value=previous;listSignature=signature;
        }
        const entry=entries.find(entry=>String(entry.id)===select.value);
        const detail=entry?kind==='api'?`${entry.time}\n${entry.url}\nHTTP ${entry.status} · 응답 헤더 ${entry.headerMs}ms · 기록 ${entry.bytes}바이트\n\n${entry.body}`:`${entry.time} · ${entry.level}\n${entry.message}`:'아직 기록이 없습니다.';
        if(selectedSignature!==detail){setText($('dev-diagnostics-detail'),detail);selectedSignature=detail;}
        setText($('dev-diagnostics-status'),`개발자 진단 활성 · API ${apis.length}개 / 로그 ${logs.length}개 · 원본 읽기 ${pending.size}개`);
    }
    function render(){
        if(!permitted()||document.hidden)return;
        const text=metricsText();
        if(panelVisible()){setText($('dev-runtime-metrics'),text);if(dirty)renderRecords();dirty=false;}
        if(overlayEnabled)setText($('developer-performance-output'),text);
    }
    function tick(){
        if(sampling){
            const now=performance.now(),elapsed=Math.max(1,now-sampleStart);
            lastSample={fps:Math.round(frames*1000/elapsed),gap:+maxFrameGap.toFixed(1),weatherFPS:Math.round(weatherFrames*1000/elapsed),cost:weatherFrames?+(weatherCost/weatherFrames).toFixed(2):0,max:+weatherMax.toFixed(2)};
            sampleStart=now;frames=0;maxFrameGap=0;weatherFrames=0;weatherCost=0;weatherMax=0;
        }
        render();
    }
    function syncSampling(){
        const enabled=samplingVisible();
        sampling=enabled;
        if(enabled&&frame===null){sampleStart=performance.now();frames=0;lastFrame=0;maxFrameGap=0;weatherFrames=0;weatherCost=0;weatherMax=0;frame=requestAnimationFrame(measureFrame);
            window.dispatchEvent(new CustomEvent('standby-diagnostics-performance-change',{detail:{sample:weatherFrameSample}}));
            if(window.PerformanceObserver&&PerformanceObserver.supportedEntryTypes?.includes('longtask')){longTaskObserver=new PerformanceObserver(list=>{for(const entry of list.getEntries()){longTasks++;longTaskMs+=entry.duration;}});longTaskObserver.observe({type:'longtask'});}
        }else if(!enabled){if(frame!==null)cancelAnimationFrame(frame);frame=null;longTaskObserver?.disconnect();longTaskObserver=null;window.dispatchEvent(new CustomEvent('standby-diagnostics-performance-change',{detail:{sample:null}}));}
        const needsUI=permitted()&&!document.hidden&&(performanceEnabled||apiEnabled||logsEnabled)&&(panelVisible()||overlayEnabled);
        if(needsUI&&timer===null)timer=setInterval(tick,1000);else if(!needsUI&&timer!==null){clearInterval(timer);timer=null;}
        $('developer-performance-overlay').hidden=!permitted()||!overlayEnabled;
        render();
    }
    function cancelBodies(){generation++;for(const task of pending)task.cancel();pending.clear();}
    function reset(){
        apiEnabled=false;logsEnabled=false;performanceEnabled=false;overlayEnabled=false;cancelBodies();apis.length=0;logs.length=0;apiSequence++;logSequence++;dirty=true;lastSample=null;longTasks=0;longTaskMs=0;
        for(const id of ['dev-api-recording','dev-log-recording','dev-performance-enabled','dev-performance-overlay'])$(id).checked=false;
        syncHooks();syncSampling();
    }
    function deactivate(){if(!active)return;reset();active=false;syncHooks();if(timer!==null)clearInterval(timer);timer=null;uiController?.abort();uiController=null;viewObserver?.disconnect();viewObserver=null;}
    function activate(){
        if(active||window.__dashboardDeveloperOptionsEnabled?.()!==true)return;active=true;uiController=new AbortController();const signal=uiController.signal;
        const bind=(id,type,handler)=>$(id).addEventListener(type,handler,{signal});
        bind('dev-api-recording','change',event=>{apiEnabled=event.target.checked;if(!apiEnabled)cancelBodies();syncHooks();dirty=true;syncSampling();});
        bind('dev-log-recording','change',event=>{logsEnabled=event.target.checked;syncHooks();dirty=true;syncSampling();});
        bind('dev-performance-enabled','change',event=>{performanceEnabled=event.target.checked;if(!performanceEnabled){overlayEnabled=false;$('dev-performance-overlay').checked=false;}syncSampling();});
        bind('dev-performance-overlay','change',event=>{overlayEnabled=event.target.checked;if(overlayEnabled){performanceEnabled=true;$('dev-performance-enabled').checked=true;}syncSampling();});
        bind('developer-performance-close','click',()=>{overlayEnabled=false;$('dev-performance-overlay').checked=false;syncSampling();});
        bind('dev-diagnostics-kind','change',()=>{dirty=true;render();});bind('dev-diagnostics-entry','change',()=>{dirty=true;render();});
        bind('dev-diagnostics-clear','click',()=>{cancelBodies();apis.length=0;logs.length=0;apiSequence++;logSequence++;dirty=true;render();});
        window.addEventListener('error',event=>record('error',event.message+' · '+safeURL(event.filename)),{signal});
        window.addEventListener('unhandledrejection',event=>record('unhandledrejection',summarize(event.reason)),{signal});
        for(const type of ['online','offline','standby-settings-visibility-change','standby-safe-margins-change','school-profile-updated'])window.addEventListener(type,event=>record('app',type+(event.detail?' · '+summarize(event.detail):'')),{signal});
        document.addEventListener('visibilitychange',syncSampling,{signal});
        viewObserver=new MutationObserver(syncSampling);for(const id of ['settings-modal','developer-options-view'])viewObserver.observe($(id),{attributes:true,attributeFilter:['class']});
        apiEnabled=$('dev-api-recording').checked;logsEnabled=$('dev-log-recording').checked;performanceEnabled=$('dev-performance-enabled').checked;overlayEnabled=$('dev-performance-overlay').checked;
        dirty=true;syncHooks();syncSampling();
    }
    window.ADKDiagnostics={activate,deactivate,reset,record,get state(){return {active,apiEnabled,logsEnabled,performanceEnabled,overlayEnabled,apiCount:apis.length,logCount:logs.length,pendingBodies:pending.size,timer:timer!==null,frame:frame!==null,observer:!!viewObserver};}};
})();
