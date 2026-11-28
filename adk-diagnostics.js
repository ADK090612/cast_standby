// Loaded only after developer options are enabled. No hooks, timers, or sampling run on load.
(() => {
    'use strict';
    const MAX_APIS=20,MAX_LOGS=100,MAX_BODY=65536,MAX_PENDING=2,MAX_TASKS=200,MAX_LOG_BODY=16384,MAX_SAMPLES=120;
    let active=false,apiEnabled=false,logsEnabled=false,longTasksEnabled=false,performanceEnabled=false,overlayEnabled=false;
    let generation=0,nextId=0,uiController=null,viewObserver=null,longTaskObserver=null,longFrameObserver=null,timer=null,frame=null,dirty=false;
    let originalFetch=null,fetchHook=null,originalConsole=null,consoleHooks=null;
    let sampleStart=0,frames=0,lastFrame=0,maxFrameGap=0,weatherFrames=0,weatherCost=0,weatherMax=0,longTasks=0,longTaskMs=0;
    let lastSample=null,sampling=false,longFrames=0,lastInput=null,recordKind='log',recordViewKind='',followRecords=true;
    let exporting=false,exportGeneration=0,exportTimer=null,exportResolve=null,sessionStartedAt=null;
    let overlayPosition=null,overlayDrag=null,overlayPositionFrame=null,overlaySizeObserver=null;
    const apis=[],logs=[],tasks=[],samples=[],pending=new Set(),recordNodes=new Map(),downloadURLs=new Map(),$=id=>document.getElementById(id);
    const totals={api:0,log:0,task:0,sample:0,apiTruncated:0,logTruncated:0};
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
    function snapshotLog(value){
        const seen=new WeakSet();let nodes=512,remaining=MAX_LOG_BODY,truncated=false;
        const text=value=>{const s=String(value);if(s.length>remaining){truncated=true;const part=s.slice(0,Math.max(0,remaining));remaining=0;return part+'[생략]';}remaining-=s.length;return s;};
        function visit(value,depth){
            if(--nodes<0||remaining<=0){truncated=true;return '[기록 한도]';}
            if(value===null||typeof value==='boolean'||typeof value==='number')return value;
            if(typeof value==='string')return text(value);
            if(typeof value==='undefined')return '[undefined]';
            if(typeof value==='function')return '[함수 '+text(value.name||'익명')+']';
            if(typeof value==='bigint'||typeof value==='symbol')return text(String(value));
            if(value instanceof Error)return text(value.name+': '+value.message+'\n'+(value.stack||''));
            if(value instanceof Date)return value.toISOString();
            if(typeof Node!=='undefined'&&value instanceof Node)return {node:value.nodeName,id:text(value.id||''),note:'DOM 참조를 보관하지 않습니다.'};
            if(seen.has(value))return '[순환 또는 공유 참조]';seen.add(value);
            if(depth>=6){truncated=true;return '[깊이 한도]';}
            const output=Array.isArray(value)?[]:Object.create(null);let count=0;
            for(const key in value){
                if(!Object.prototype.hasOwnProperty.call(value,key))continue;
                if(count++>=50||nodes<=0||remaining<=0){truncated=true;output.__omitted__='항목 한도';break;}
                const descriptor=Object.getOwnPropertyDescriptor(value,key);output[text(key)]=descriptor&&'value' in descriptor?visit(descriptor.value,depth+1):'[접근자: 실행하지 않음]';
            }
            return output;
        }
        try{let body=JSON.stringify(visit(value,0),null,2);if(body.length>MAX_LOG_BODY){body=body.slice(0,MAX_LOG_BODY)+'\n[16,384자 이후 생략]';truncated=true;}return {body,truncated};}
        catch(error){return {body:'직렬화 실패: '+summarize(error),truncated:true};}
    }
    function record(level,message,data=null,truncated=false){
        if(!permitted()||!logsEnabled)return;
        const full=String(data??message),limited=truncated||full.length>MAX_LOG_BODY;
        logs.unshift({id:++nextId,time:new Date().toISOString(),level,message:String(message).slice(0,4000),data:full.slice(0,MAX_LOG_BODY),truncated:limited,revision:0});
        if(logs.length>MAX_LOGS)logs.length=MAX_LOGS;totals.log++;if(limited)totals.logTruncated++;dirty=true;
    }
    function updateAPI(entry,values){
        if(values.truncated&&!entry.truncated)totals.apiTruncated++;
        Object.assign(entry,values);entry.revision=(entry.revision||0)+1;dirty=true;
    }
    async function captureBody(response,entry,run){
        if(pending.size>=MAX_PENDING){updateAPI(entry,{body:'원본 동시 기록 한도에 도달했습니다.',truncated:true});return;}
        let reader,timeout=null,limited=false,timedOut=false;
        try{
            const clone=response.clone();reader=clone.body?.getReader();
            if(!reader){updateAPI(entry,{body:'읽을 수 있는 응답 본문이 없습니다.'});return;}
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
                if(generation===run&&permitted()&&apiEnabled)updateAPI(entry,{bytes,body:text+(limited?'\n[64KB 이후 생략]':timedOut?'\n[원본 기록 시간 제한]':''),truncated:limited||timedOut});
            }finally{pending.delete(task);}
        }catch(error){if(generation===run&&permitted())updateAPI(entry,{body:'원본 읽기 실패: '+summarize(error),truncated:true});}
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
                            apis.unshift(entry);if(apis.length>MAX_APIS)apis.length=MAX_APIS;totals.api++;dirty=true;
                            void captureBody(response,entry,run);
                        }
                    }
                    return response;
                }catch(error){if(permitted()&&run===generation){record('api-error',address+' · '+summarize(error));if(apiEnabled){apis.unshift({id:++nextId,time:new Date().toISOString(),url:address,status:'오류',headerMs:+(performance.now()-started).toFixed(1),body:summarize(error),bytes:0});if(apis.length>MAX_APIS)apis.length=MAX_APIS;totals.api++;dirty=true;}}throw error;}
            };
            window.fetch=fetchHook;
        }else if(!needFetch&&fetchHook){if(window.fetch===fetchHook)window.fetch=originalFetch;fetchHook=null;}
        if(permitted()&&logsEnabled&&!consoleHooks){
            originalConsole={};consoleHooks={};
            for(const level of ['log','info','warn','error','debug']){
                const original=console[level];originalConsole[level]=original;
                consoleHooks[level]=function(...args){if(permitted()&&logsEnabled){const snapshot=snapshotLog(args);record(level,args.slice(0,8).map(summarize).join(' '),snapshot.body,snapshot.truncated);}return original.apply(this,args);};console[level]=consoleHooks[level];
            }
        }else if((!permitted()||!logsEnabled)&&consoleHooks){for(const level of Object.keys(consoleHooks))if(console[level]===consoleHooks[level])console[level]=originalConsole[level];consoleHooks=null;originalConsole=null;}
    }
    function timingNumber(value){return Number.isFinite(value)?+value.toFixed(2):null;}
    function timingURL(value){return value?safeURL(String(value).slice(0,2048)):'';}
    function interactionContext(start,end){
        const modal=$('settings-modal'),settingsOpen=!!modal&&!modal.classList.contains('hidden');
        const view=settingsOpen?document.querySelector('#settings-modal .settings-view:not(.hidden)'):null;
        const recent=lastInput&&lastInput.at<=end&&start-lastInput.at<=5000?{...lastInput}:null;
        return {observedAt:new Date().toISOString(),file:timingURL(location.href),theme:document.documentElement.dataset.theme||'',style:document.documentElement.dataset.weatherDesign||'',settingsOpen,view:view?.id||'home',viewport:{width:innerWidth,height:innerHeight,pixelRatio:devicePixelRatio},recentInput:recent,recentInputNote:'직전 입력과 기록 시 화면 상태는 참고 정보이며 원인을 확정하지 않습니다.'};
    }
    function recordStall(entry){
        if(!permitted()||!longTasksEnabled||document.hidden)return;
        const start=entry.startTime||0,duration=entry.duration||0,origin=performance.timeOrigin||Date.now()-performance.now();
        const item={id:++nextId,revision:0,entryType:entry.entryType,name:String(entry.name||'').slice(0,256),time:new Date(origin+start).toISOString(),endTime:new Date(origin+start+duration).toISOString(),startTime:timingNumber(start),duration:timingNumber(duration),blockingDuration:timingNumber(entry.blockingDuration),renderStart:timingNumber(entry.renderStart),styleAndLayoutStart:timingNumber(entry.styleAndLayoutStart),context:interactionContext(start,start+duration)};
        if(entry.entryType==='longtask'){
            const attribution=Array.from(entry.attribution||[]);item.attribution=attribution.slice(0,4).map(a=>({name:String(a.name||'').slice(0,256),containerType:String(a.containerType||'').slice(0,80),containerId:String(a.containerId||'').slice(0,256),containerName:String(a.containerName||'').slice(0,256),containerSrc:timingURL(a.containerSrc)}));
            item.omittedAttributions=Math.max(0,attribution.length-4);item.locationNote='Long Tasks API의 프레임 귀속 정보입니다. 이 정보만으로 JavaScript 함수나 호출 스택을 확정할 수 없습니다.';
        }else{
            const scripts=Array.from(entry.scripts||[]);item.scripts=scripts.slice(0,64).sort((a,b)=>b.duration-a.duration).slice(0,8).map(s=>({sourceURL:timingURL(s.sourceURL),sourceFunctionName:String(s.sourceFunctionName||'').slice(0,256),sourceCharPosition:Number.isFinite(s.sourceCharPosition)?s.sourceCharPosition:-1,invoker:String(s.invoker||s.name||'').slice(0,512),invokerType:String(s.invokerType||s.type||'').slice(0,128),windowAttribution:String(s.windowAttribution||'').slice(0,128),executionStart:timingNumber(s.executionStart),duration:timingNumber(s.duration),forcedStyleAndLayoutDuration:timingNumber(s.forcedStyleAndLayoutDuration),pauseDuration:timingNumber(s.pauseDuration)}));
            item.scriptCount=scripts.length;item.omittedScripts=Math.max(0,scripts.length-item.scripts.length);item.locationNote='브라우저가 이 긴 프레임에서 관측한 스크립트입니다. 문자 위치는 줄 번호가 아니며, 비어 있는 정보는 추정하지 않습니다.';
        }
        tasks.unshift(item);if(tasks.length>MAX_TASKS)tasks.length=MAX_TASKS;totals.task++;dirty=true;
    }
    function syncPerformanceObservers(){
        const allowed=permitted()&&!document.hidden,types=window.PerformanceObserver?PerformanceObserver.supportedEntryTypes||[]:[];
        const needTasks=allowed&&(sampling||longTasksEnabled);
        if(needTasks&&types.includes('longtask')&&!longTaskObserver){
            longTaskObserver=new PerformanceObserver(list=>{if(!permitted()||document.hidden)return;for(const entry of list.getEntries()){longTasks++;longTaskMs+=entry.duration;if(longTasksEnabled)recordStall(entry);}});longTaskObserver.observe({type:'longtask'});
        }else if(!needTasks&&longTaskObserver){longTaskObserver.disconnect();longTaskObserver=null;}
        const needFrames=allowed&&longTasksEnabled;
        if(needFrames&&types.includes('long-animation-frame')&&!longFrameObserver){
            longFrameObserver=new PerformanceObserver(list=>{if(!permitted()||!longTasksEnabled||document.hidden)return;for(const entry of list.getEntries()){longFrames++;recordStall(entry);}});longFrameObserver.observe({type:'long-animation-frame'});
        }else if(!needFrames&&longFrameObserver){longFrameObserver.disconnect();longFrameObserver=null;}
        setText($('dev-longtask-status'),`긴 작업 API: ${types.includes('longtask')?'지원':'미지원'} · 스크립트 위치를 제공하는 긴 프레임 API: ${types.includes('long-animation-frame')?'지원':'미지원'}`);
    }
    function noteInteraction(event){
        if(!permitted()||!longTasksEnabled||document.hidden)return;
        const node=event.target instanceof Element?event.target:null;
        lastInput={at:timingNumber(performance.now()),type:event.type,target:node?(node.tagName.toLowerCase()+(node.id?'#'+node.id.slice(0,128):'')):'unknown'};
        if(event.type==='pointerdown'){lastInput.x=Math.round(event.clientX);lastInput.y=Math.round(event.clientY);}
        else lastInput.key=event.key?.length===1?'문자 키':String(event.key||'').slice(0,40);
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
        if(!performanceEnabled)return 'FPS 측정이 꺼져 있습니다.\n긴 작업 '+longTasks+'회 · 긴 프레임 '+longFrames+'회 · 상세 기록 '+tasks.length+'/'+MAX_TASKS+'\n현재 파일: '+safeURL(location.href)+'\n버전 '+version+' · '+build;
        if(!lastSample)return '첫 성능 표본을 준비하고 있습니다…';
        const m=lastSample,heap=Number.isFinite(performance.memory?.usedJSHeapSize)?(performance.memory.usedJSHeapSize/1048576).toFixed(1)+'MB':'브라우저 미지원';
        return `화면 갱신 FPS: ${m.fps} · 가장 긴 프레임 간격 ${m.gap}ms\n날씨 그리기 FPS: ${m.weatherFPS} · 평균 ${m.cost}ms / 최대 ${m.max}ms\n긴 작업: ${longTasks}회 · 누적 ${longTaskMs.toFixed(1)}ms · 긴 프레임 ${longFrames}회\nJS 힙: ${heap}\nAPI 기록 ${apis.length}/${MAX_APIS} · 로그 ${logs.length}/${MAX_LOGS} · 작업 ${tasks.length}/${MAX_TASKS}\n현재 파일: ${safeURL(location.href)}\n버전 ${version} · ${build}`;
    }
    function recordHeading(kind,entry){
        if(kind==='api')return `${entry.time} · HTTP ${entry.status} · ${entry.headerMs}ms`;
        if(kind==='log')return `${entry.time} · ${entry.level}${entry.truncated?' · 일부 생략':''}`;
        return `${entry.time} · ${entry.entryType==='longtask'?'긴 작업':'긴 프레임'} · ${entry.duration}ms`;
    }
    function recordBody(kind,entry){
        if(kind==='api')return `${entry.url}\n기록 ${entry.bytes}바이트${entry.truncated?' · 일부 생략':''}\n\n${entry.body}`;
        if(kind==='log')return entry.data??entry.message;
        return JSON.stringify(entry,null,2);
    }
    function renderRecords(){
        const kind=recordKind,entries=kind==='api'?apis:kind==='task'?tasks:logs,list=$('dev-diagnostics-records');
        if(recordViewKind!==kind){list.replaceChildren();recordNodes.clear();recordViewKind=kind;}
        const ids=new Set(entries.map(entry=>entry.id));
        for(const [id,node] of recordNodes)if(!ids.has(id)){node.root.remove();recordNodes.delete(id);}
        if(!entries.length){
            if(!list.querySelector('.diagnostics-empty')){const empty=document.createElement('p');empty.className='diagnostics-empty';empty.textContent='아직 기록이 없습니다.';list.append(empty);}
        }else{
            list.querySelector('.diagnostics-empty')?.remove();const added=document.createDocumentFragment();
            for(const entry of [...entries].reverse()){
                let node=recordNodes.get(entry.id);
                if(!node){const root=document.createElement('article'),heading=document.createElement('div'),body=document.createElement('pre');root.className='diagnostics-record';root.dataset.recordId=String(entry.id);heading.className='diagnostics-record-heading';body.className='diagnostics-record-body';root.append(heading,body);node={root,heading,body,revision:-1};recordNodes.set(entry.id,node);added.append(root);}
                if(node.revision!==(entry.revision||0)){setText(node.heading,recordHeading(kind,entry));setText(node.body,recordBody(kind,entry));node.revision=entry.revision||0;}
            }
            list.append(added);
        }
        if(followRecords)list.scrollTop=list.scrollHeight;
        setText($('dev-diagnostics-status'),`API ${apis.length}/${totals.api}개 · 로그 ${logs.length}/${totals.log}개 · 긴 작업·프레임 ${tasks.length}/${totals.task}개 보관 · 원본 읽기 ${pending.size}개`);
    }
    function cancelExport(){
        exportGeneration++;exporting=false;
        if(exportTimer!==null)clearTimeout(exportTimer);exportTimer=null;
        exportResolve?.(false);exportResolve=null;
        const button=$('dev-diagnostics-export');if(button)button.disabled=false;
    }
    function releaseDownloads(){for(const [url,job] of downloadURLs){clearTimeout(job);URL.revokeObjectURL(url);}downloadURLs.clear();}
    function exportYield(run){return new Promise(resolve=>{exportResolve=resolve;exportTimer=setTimeout(()=>{exportTimer=null;exportResolve=null;resolve(permitted()&&run===exportGeneration);},0);});}
    async function exportRecords(){
        if(!permitted()||exporting)return;
        exporting=true;const run=++exportGeneration,button=$('dev-diagnostics-export');button.disabled=true;
        setText($('dev-diagnostics-export-status'),'현재 보관 중인 전체 기록을 텍스트 파일로 준비하고 있습니다…');
        // Snapshot references only on explicit export. Records contain bounded plain data and strings.
        const groups=[['실행 로그','log',logs.map(e=>({...e})).reverse()],['API 원본','api',apis.map(e=>({...e})).reverse()],['긴 작업·긴 프레임','task',[...tasks].reverse()],['성능 표본','sample',[...samples]]];
        const metadata={exportedAt:new Date().toISOString(),sessionStartedAt,file:safeURL(location.href),version:$('app-version-text')?.dataset.version||'',build:$('app-build-number')?.dataset.build||'',limits:{apiRecords:MAX_APIS,apiBodyBytes:MAX_BODY,logRecords:MAX_LOGS,logBodyCharacters:MAX_LOG_BODY,taskRecords:MAX_TASKS,sampleRecords:MAX_SAMPLES},totals:{...totals},retained:{api:apis.length,log:logs.length,task:tasks.length,sample:samples.length},evicted:{api:Math.max(0,totals.api-apis.length),log:Math.max(0,totals.log-logs.length),task:Math.max(0,totals.task-tasks.length),sample:Math.max(0,totals.sample-samples.length)},pendingAPIBodies:pending.size};
        const parts=['\uFEFFADK Dash 개발자 진단 기록\r\n현재 보관 중인 수집 데이터 전체입니다. 수집 이전·보관 한도를 넘긴 기록은 포함되지 않습니다.\r\nAPI 응답 본문과 로그가 제한되거나 아직 읽는 중이면 각 항목 및 메타데이터에 표시됩니다.\r\nURL의 인증 관련 쿼리는 숨깁니다. 원본 본문과 로그에는 수집된 내용이 포함됩니다.\r\n긴 작업과 긴 프레임은 같은 지연을 각각 기록할 수 있습니다. 직전 입력은 원인 확정 정보가 아닙니다.\r\n\r\n',JSON.stringify(metadata,null,2),'\r\n'];
        try{
            let count=0;
            for(const [label,kind,entries] of groups){
                parts.push(`\r\n========== ${label} (${entries.length}개) ==========\r\n`);
                for(const entry of entries){
                    if(!permitted()||run!==exportGeneration)return;
                    if(kind==='sample'||kind==='task')parts.push(JSON.stringify(entry,null,2));
                    else{const {body,data,...info}=entry;parts.push(recordHeading(kind,entry),'\r\n',JSON.stringify(info,null,2),'\r\n\r\n',recordBody(kind,entry));}
                    parts.push('\r\n\r\n');
                    if(++count%20===0&&!await exportYield(run))return;
                }
            }
            if(!permitted()||run!==exportGeneration)return;
            const blob=new Blob(parts,{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
            downloadURLs.set(url,setTimeout(()=>{URL.revokeObjectURL(url);downloadURLs.delete(url);},1000));
            link.href=url;link.download='ADK-diagnostics-'+metadata.exportedAt.replace(/[:.]/g,'-')+'.txt';link.click();
            setText($('dev-diagnostics-export-status'),`${count}개 기록의 텍스트 파일 저장을 요청했습니다. (${(blob.size/1024).toFixed(1)}KB) 보관 한도에 따른 생략 내역도 포함했습니다.`);
        }catch(error){if(run===exportGeneration)setText($('dev-diagnostics-export-status'),'텍스트 저장 준비 실패: '+summarize(error));}
        finally{if(run===exportGeneration){exporting=false;button.disabled=false;}}
    }
    function overlayGeometry(){
        const panel=$('developer-performance-overlay'),style=getComputedStyle(document.documentElement);
        const inset=side=>{const raw=style.getPropertyValue('--safe-'+side).trim(),value=parseFloat(raw)||0;return Math.max(0,value*(raw.endsWith('vw')?innerWidth/100:raw.endsWith('vh')?innerHeight/100:1));};
        const left=inset('left')+12,right=innerWidth-inset('right')-12,top=inset('top')+12,bottom=innerHeight-inset('bottom')-12;
        const maxHeight=Math.max(28,Math.min(innerHeight*.65,bottom-(overlayPosition?top:inset('top')+70)))+'px';
        if(panel.style.maxHeight!==maxHeight)panel.style.maxHeight=maxHeight;
        const rect=panel.getBoundingClientRect();
        return {left,top,maxLeft:Math.max(left,right-rect.width),maxTop:Math.max(top,bottom-rect.height),rect};
    }
    function clampOverlayPosition(position,bounds){return {left:Math.max(bounds.left,Math.min(bounds.maxLeft,position.left)),top:Math.max(bounds.top,Math.min(bounds.maxTop,position.top))};}
    function paintOverlayPosition(){
        overlayPositionFrame=null;
        const panel=$('developer-performance-overlay');if(!permitted()||panel.hidden||document.hidden)return;
        if(!overlayPosition){for(const key of ['left','top','right','bottom'])panel.style.removeProperty(key);}
        const bounds=overlayDrag?.bounds||overlayGeometry(),position=clampOverlayPosition(overlayPosition||bounds.rect,bounds);
        if(overlayPosition)overlayPosition=position;
        if(overlayPosition||position.left!==bounds.rect.left||position.top!==bounds.rect.top){
            panel.style.right='auto';panel.style.bottom='auto';panel.style.left=position.left+'px';panel.style.top=position.top+'px';
        }
    }
    function scheduleOverlayPosition(){
        if(!permitted()||!overlayEnabled||document.hidden||overlayPositionFrame!==null)return;
        overlayPositionFrame=requestAnimationFrame(paintOverlayPosition);
    }
    function stopOverlayDrag(event=null,commit=true){
        const drag=overlayDrag;if(!drag||(event&&event.pointerId!==drag.id))return;
        if(overlayPositionFrame!==null){cancelAnimationFrame(overlayPositionFrame);overlayPositionFrame=null;}
        if(commit&&overlayPosition)paintOverlayPosition();
        overlayDrag=null;
        const handle=$('developer-performance-drag');handle.classList.remove('is-dragging');$('developer-performance-overlay').classList.remove('is-dragging');
        if(handle.hasPointerCapture(drag.id))handle.releasePointerCapture(drag.id);
        if(commit)scheduleOverlayPosition();
    }
    function syncOverlayPosition(){
        const visible=permitted()&&overlayEnabled&&!document.hidden,panel=$('developer-performance-overlay'),wasHidden=panel.hidden;
        panel.hidden=!visible;
        if(visible){
            // A nonmodal top layer keeps the grip usable above the invisible notification hit targets.
            if(typeof panel.showPopover==='function'){if(!panel.matches(':popover-open'))panel.showPopover();}
            else if(wasHidden)document.body.appendChild(panel);
            if(!overlaySizeObserver&&window.ResizeObserver){overlaySizeObserver=new ResizeObserver(()=>{if(overlayDrag)overlayDrag.bounds=overlayGeometry();scheduleOverlayPosition();});overlaySizeObserver.observe(panel);}
            scheduleOverlayPosition();
        }else{
            if(typeof panel.hidePopover==='function'&&panel.matches(':popover-open'))panel.hidePopover();
            stopOverlayDrag(null,false);
            if(overlayPositionFrame!==null)cancelAnimationFrame(overlayPositionFrame);overlayPositionFrame=null;
            overlaySizeObserver?.disconnect();overlaySizeObserver=null;
        }
    }
    function setupOverlayDrag(signal){
        const handle=$('developer-performance-drag'),panel=$('developer-performance-overlay');
        handle.addEventListener('pointerdown',event=>{
            if(!permitted()||!overlayEnabled||panel.hidden||event.button!==0||overlayDrag)return;
            const bounds=overlayGeometry();overlayDrag={id:event.pointerId,x:event.clientX,y:event.clientY,left:bounds.rect.left,top:bounds.rect.top,bounds};
            handle.setPointerCapture(event.pointerId);handle.focus({preventScroll:true});handle.classList.add('is-dragging');panel.classList.add('is-dragging');event.preventDefault();
        },{signal});
        handle.addEventListener('pointermove',event=>{
            const drag=overlayDrag;if(!drag||drag.id!==event.pointerId)return;
            if(event.pointerType==='mouse'&&event.buttons===0){stopOverlayDrag(event);return;}
            overlayPosition=clampOverlayPosition({left:drag.left+event.clientX-drag.x,top:drag.top+event.clientY-drag.y},drag.bounds);scheduleOverlayPosition();
        },{signal});
        for(const type of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(type,event=>stopOverlayDrag(event),{signal});
        handle.addEventListener('keydown',event=>{
            if(!permitted()||!overlayEnabled)return;
            if(event.key==='Home'){
                event.preventDefault();stopOverlayDrag(null,false);overlayPosition=null;scheduleOverlayPosition();return;
            }
            if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
            event.preventDefault();event.stopPropagation();stopOverlayDrag(null,false);
            const bounds=overlayGeometry(),step=event.shiftKey?10:1;
            overlayPosition=clampOverlayPosition({left:bounds.rect.left+(event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0),top:bounds.rect.top+(event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0)},bounds);scheduleOverlayPosition();
        },{signal});
        for(const type of ['resize','standby-safe-margins-change'])window.addEventListener(type,()=>{stopOverlayDrag(null,false);if(overlayEnabled)scheduleOverlayPosition();},{signal});
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
            samples.push({time:new Date().toISOString(),...lastSample,longTasks,longTaskMs:timingNumber(longTaskMs),longFrames,heapBytes:Number.isFinite(performance.memory?.usedJSHeapSize)?performance.memory.usedJSHeapSize:null});if(samples.length>MAX_SAMPLES)samples.shift();totals.sample++;
            sampleStart=now;frames=0;maxFrameGap=0;weatherFrames=0;weatherCost=0;weatherMax=0;
        }
        render();
    }
    function syncSampling(){
        const enabled=samplingVisible();
        sampling=enabled;
        if(enabled&&frame===null){sampleStart=performance.now();frames=0;lastFrame=0;maxFrameGap=0;weatherFrames=0;weatherCost=0;weatherMax=0;frame=requestAnimationFrame(measureFrame);
            window.dispatchEvent(new CustomEvent('standby-diagnostics-performance-change',{detail:{sample:weatherFrameSample}}));
        }else if(!enabled){if(frame!==null)cancelAnimationFrame(frame);frame=null;window.dispatchEvent(new CustomEvent('standby-diagnostics-performance-change',{detail:{sample:null}}));}
        syncPerformanceObservers();
        const needsUI=permitted()&&!document.hidden&&(performanceEnabled||apiEnabled||logsEnabled||longTasksEnabled)&&(panelVisible()||overlayEnabled);
        if(needsUI&&timer===null)timer=setInterval(tick,1000);else if(!needsUI&&timer!==null){clearInterval(timer);timer=null;}
        syncOverlayPosition();
        render();
    }
    function cancelBodies(){generation++;for(const task of pending)task.cancel();pending.clear();}
    function clearRecords(){
        cancelExport();releaseDownloads();cancelBodies();apis.length=0;logs.length=0;tasks.length=0;samples.length=0;recordNodes.clear();recordViewKind='';
        for(const key of Object.keys(totals))totals[key]=0;
        lastSample=null;longTasks=0;longTaskMs=0;longFrames=0;lastInput=null;sessionStartedAt=new Date().toISOString();dirty=true;
        $('dev-diagnostics-records').replaceChildren();
        setText($('dev-diagnostics-export-status'),'현재 보관 중인 API 원본·로그·긴 작업·성능 표본 전체를 UTF-8 텍스트로 저장합니다. 한도로 생략된 데이터는 파일에 표시됩니다.');
    }
    function reset(){
        apiEnabled=false;logsEnabled=false;longTasksEnabled=false;performanceEnabled=false;overlayEnabled=false;overlayPosition=null;clearRecords();recordKind='log';followRecords=true;$('dev-diagnostics-follow').checked=true;selectRecordTab('log');
        for(const id of ['dev-api-recording','dev-log-recording','dev-longtask-recording','dev-performance-enabled','dev-performance-overlay'])$(id).checked=false;
        syncHooks();syncSampling();
    }
    function selectRecordTab(kind){
        if(!['log','api','task'].includes(kind))return;
        recordKind=kind;
        for(const tab of document.querySelectorAll('[data-diagnostics-kind]')){const selected=tab.dataset.diagnosticsKind===kind;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}
        $('dev-diagnostics-records').setAttribute('aria-labelledby','dev-record-'+kind);dirty=true;
    }
    function deactivate(){if(!active)return;reset();active=false;syncHooks();if(timer!==null)clearInterval(timer);timer=null;uiController?.abort();uiController=null;viewObserver?.disconnect();viewObserver=null;}
    function activate(){
        if(active||window.__dashboardDeveloperOptionsEnabled?.()!==true)return;active=true;sessionStartedAt=new Date().toISOString();uiController=new AbortController();const signal=uiController.signal;
        setupOverlayDrag(signal);
        const bind=(id,type,handler)=>$(id).addEventListener(type,handler,{signal});
        bind('dev-api-recording','change',event=>{apiEnabled=event.target.checked;if(!apiEnabled)cancelBodies();syncHooks();dirty=true;syncSampling();});
        bind('dev-log-recording','change',event=>{logsEnabled=event.target.checked;syncHooks();dirty=true;syncSampling();});
        bind('dev-longtask-recording','change',event=>{longTasksEnabled=event.target.checked;if(!longTasksEnabled)lastInput=null;dirty=true;syncSampling();});
        bind('dev-performance-enabled','change',event=>{performanceEnabled=event.target.checked;if(!performanceEnabled){overlayEnabled=false;$('dev-performance-overlay').checked=false;}syncSampling();});
        bind('dev-performance-overlay','change',event=>{overlayEnabled=event.target.checked;if(overlayEnabled){performanceEnabled=true;$('dev-performance-enabled').checked=true;}syncSampling();});
        bind('developer-performance-close','click',()=>{overlayEnabled=false;$('dev-performance-overlay').checked=false;syncSampling();});
        for(const tab of document.querySelectorAll('[data-diagnostics-kind]')){
            tab.addEventListener('click',()=>{selectRecordTab(tab.dataset.diagnosticsKind);render();},{signal});
            tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const kinds=['log','api','task'],index=kinds.indexOf(recordKind),next=event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowRight'?1:2))%3;selectRecordTab(kinds[next]);$('dev-record-'+kinds[next]).focus();render();},{signal});
        }
        bind('dev-diagnostics-follow','change',event=>{followRecords=event.target.checked;if(followRecords){const list=$('dev-diagnostics-records');list.scrollTop=list.scrollHeight;}});
        $('dev-diagnostics-records').addEventListener('scroll',()=>{const list=$('dev-diagnostics-records');if(followRecords&&list.scrollHeight-list.clientHeight-list.scrollTop>24){followRecords=false;$('dev-diagnostics-follow').checked=false;}},{signal,passive:true});
        bind('dev-diagnostics-export','click',()=>void exportRecords());
        bind('dev-diagnostics-clear','click',()=>{clearRecords();render();});
        window.addEventListener('error',event=>{if(!logsEnabled)return;const snapshot=snapshotLog({message:event.message,file:safeURL(event.filename),line:event.lineno,column:event.colno,error:event.error});record('error',event.message,snapshot.body,snapshot.truncated);},{signal});
        window.addEventListener('unhandledrejection',event=>{if(!logsEnabled)return;const snapshot=snapshotLog(event.reason);record('unhandledrejection',summarize(event.reason),snapshot.body,snapshot.truncated);},{signal});
        for(const type of ['online','offline','standby-settings-visibility-change','standby-safe-margins-change','school-profile-updated'])window.addEventListener(type,event=>{if(!logsEnabled)return;const snapshot=snapshotLog({type,detail:event.detail});record('app',type,snapshot.body,snapshot.truncated);},{signal});
        for(const type of ['pointerdown','keydown'])document.addEventListener(type,noteInteraction,{signal,capture:true,passive:true});
        document.addEventListener('visibilitychange',syncSampling,{signal});
        viewObserver=new MutationObserver(syncSampling);for(const id of ['settings-modal','developer-options-view'])viewObserver.observe($(id),{attributes:true,attributeFilter:['class']});
        apiEnabled=$('dev-api-recording').checked;logsEnabled=$('dev-log-recording').checked;longTasksEnabled=$('dev-longtask-recording').checked;performanceEnabled=$('dev-performance-enabled').checked;overlayEnabled=$('dev-performance-overlay').checked;
        selectRecordTab(recordKind);
        dirty=true;syncHooks();syncSampling();
    }
    window.ADKDiagnostics={activate,deactivate,reset,record,get state(){return {active,apiEnabled,logsEnabled,longTasksEnabled,performanceEnabled,overlayEnabled,apiCount:apis.length,logCount:logs.length,taskCount:tasks.length,sampleCount:samples.length,pendingBodies:pending.size,timer:timer!==null,frame:frame!==null,observer:!!viewObserver,longTaskObserver:!!longTaskObserver,longFrameObserver:!!longFrameObserver,exporting,downloadURLs:downloadURLs.size,recordNodes:recordNodes.size,followRecords,dragging:!!overlayDrag,positionPending:overlayPositionFrame!==null};}};
})();
