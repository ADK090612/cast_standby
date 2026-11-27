import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
function source(name,async=false){
  const start=html.indexOf('        '+(async?'async ':'')+'function '+name+'(');
  const next=html.indexOf('\n        function ',start+10),nextAsync=html.indexOf('\n        async function ',start+10);
  const end=Math.min(...[next,nextAsync].filter(n=>n>start));assert.ok(start>=0&&Number.isFinite(end),name);return html.slice(start,end);
}
const helpers={};vm.createContext(helpers);vm.runInContext(['luminanceFromRgb','schoolLogoColor','schoolLogoTextShouldBeWhite'].map(name=>source(name)).join('\n'),helpers);

test('pill color parsing preserves alpha and handles space-separated CSS RGB',()=>{
  assert.deepEqual(Array.from(helpers.schoolLogoColor('rgba(255, 255, 255, 0.13)')),[255,255,255,.13]);
  assert.deepEqual(Array.from(helpers.schoolLogoColor('rgb(10 20 30 / 0.9)')),[10,20,30,.9]);
});

test('dark and bright composed pill backgrounds select legible school wordmarks',()=>{
  assert.equal(helpers.schoolLogoTextShouldBeWhite([255,255,255,.13],[8,27,21]),true);
  assert.equal(helpers.schoolLogoTextShouldBeWhite([255,255,255,.13],[255,255,255]),false);
  assert.equal(helpers.schoolLogoTextShouldBeWhite([255,255,255,.66],[0,0,0]),false);
  assert.equal(helpers.schoolLogoTextShouldBeWhite([0,0,0,.9],[255,255,255]),true);
});

test('a luminance hysteresis band avoids toggling near the contrast boundary',()=>{
  assert.equal(helpers.schoolLogoTextShouldBeWhite([0,0,0,0],[118,118,118],'white'),true);
  assert.equal(helpers.schoolLogoTextShouldBeWhite([0,0,0,0],[118,118,118],'original'),false);
});

function scheduler(){
  let id=0;const frames=new Map(),timers=new Map(),checks=[];
  const c={schoolLogoContrastFrame:0,schoolLogoContrastTimer:0,schoolLogoContrastGeneration:0,
    window:{setTimeout(fn){const key=++id;timers.set(key,fn);return key;},clearTimeout:key=>timers.delete(key)},
    requestAnimationFrame(fn){const key=++id;frames.set(key,fn);return key;},refreshSchoolLogoContrast:generation=>checks.push(generation)};
  vm.createContext(c);vm.runInContext(source('scheduleSchoolLogoContrast'),c);
  return {c,frames,timers,checks,flush(collection){for(const [key,fn] of [...collection]){collection.delete(key);fn();}}};
}

test('a burst of contrast requests coalesces into one frame with the latest generation',()=>{
  const {c,frames,timers,checks,flush}=scheduler();for(let i=0;i<100;i++)c.scheduleSchoolLogoContrast();assert.equal(frames.size,1);assert.equal(timers.size,0);
  flush(frames);assert.deepEqual(checks,[100]);assert.equal(c.schoolLogoContrastFrame,0);
});

test('resize bursts retain one debounce timer and no recurring work after checking',()=>{
  const {c,frames,timers,checks,flush}=scheduler();for(let i=0;i<100;i++)c.scheduleSchoolLogoContrast(120);assert.equal(timers.size,1);assert.equal(frames.size,0);
  flush(timers);assert.equal(frames.size,1);flush(frames);assert.equal(timers.size,0);assert.equal(frames.size,0);assert.deepEqual(checks,[100]);
});

test('background sampling caches one image and a 16 by 8 sample instead of reading the full image',async()=>{
  let images=0,draws=0,reads=0;
  const c={schoolLogoBackgroundCache:null,innerWidth:1440,innerHeight:900,
    Image:class{naturalWidth=1440;naturalHeight=900;set src(value){if(value){images++;Promise.resolve().then(()=>this.onload?.());}}},
    document:{createElement(){return {width:0,height:0,getContext(){return {drawImage(){draws++;},getImageData(x,y,width,height){assert.equal(width,16);assert.equal(height,8);reads++;return {data:Uint8ClampedArray.from({length:width*height*4},(_,i)=>i%4===3?255:120)};}};}};}}};
  vm.createContext(c);vm.runInContext(source('schoolLogoBackdropSample',true),c);
  const rect={left:500,top:780,width:170,height:64};
  for(let i=0;i<20;i++)assert.deepEqual(Array.from(await c.schoolLogoBackdropSample('image-A',rect,[0,0,0])),[120,120,120]);
  assert.equal(images,1);assert.equal(draws,1);assert.equal(reads,1);
  await c.schoolLogoBackdropSample('image-A',{...rect,left:600},[0,0,0]);assert.equal(images,1);assert.equal(reads,2);
  await c.schoolLogoBackdropSample('image-B',rect,[0,0,0]);assert.equal(images,2);assert.equal(reads,3);assert.equal(c.schoolLogoBackgroundCache.url,'image-B');
});
