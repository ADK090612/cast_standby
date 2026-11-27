// No dependencies: node --test tests/weather-rendering.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import vm from 'node:vm';

const root=new URL('../',import.meta.url);
const html=await readFile(new URL('index.html',root),'utf8');
function sourceBetween(start,end) {
  const from=html.indexOf(start),to=html.indexOf(end,from+start.length);
  assert.ok(from>=0&&to>from,`Missing source boundary: ${start}`);
  return html.slice(from,to);
}
function nightScene(phase='night',amount=50,visibility=1) {
  const paints=[];
  const starCtx={globalAlpha:1,createRadialGradient:()=>({stops:[],addColorStop(offset,color){this.stops.push({offset,color});}}),fillRect(...rect){paints.push({rect,gradient:this.fillStyle});}};
  // A night pass must never touch the independent, sometimes idle cloud canvas.
  const cloudCtx=new Proxy({},{get(){throw Error('Night pass wrote into the cloud layer');}});
  const context={starCtx,cloudCtx,width:1440,height:900,solarPhase:()=>phase,weatherVisualState:()=>({kind:amount>0?'snow':'none',amount}),clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),
    lastStarRotationAt:0,starRotation:0,state:{rotationSpeed:0},document:{body:{classList:{contains:()=>false}}},stars:[],previousFrameCost:0,getStarAtlas:()=>({}),drawShootingStars:()=>{}};
  vm.createContext(context);
  vm.runInContext(sourceBetween('  function drawNight(', '  function cloudBillowStamp('),context);
  context.drawNight(1000,0,visibility);
  return paints;
}
test('all inline JavaScript parses',()=>{
  let count=0;
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if(/\bsrc\s*=|type\s*=\s*["'](?:application\/ld\+json|application\/json)/i.test(match[1]))continue;
    new vm.Script(match[2],{filename:`inline-script-${++count}.js`});
  }
  assert.ok(count>0);
});
for(const phase of ['night','bluehour'])for(const amount of [0,.01,25,50]) {
  test(`${phase}, snow ${amount}: lighting stays in the cleared star layer`,()=>{
    const paints=nightScene(phase,amount);
    assert.equal(paints.length,amount>0?2:0);
    for(const paint of paints)assert.deepEqual(paint.rect,[0,0,1440,900],'Glow must fade naturally without a cropped sky rectangle');
  });
}
test('snow glow fades with precipitation and star visibility',()=>{
  const alpha=paints=>Number(paints[0].gradient.stops[0].color.match(/,([^,]+)\)$/)[1]);
  assert.ok(Math.abs(alpha(nightScene('night',25))-alpha(nightScene('night',50))*.5)<1e-9);
  assert.ok(Math.abs(alpha(nightScene('night',50,.25))-alpha(nightScene('night',50))*.25)<1e-9);
});
test('ground palette converges after a day-to-night transition',()=>{
  let now=0;
  const context={groundCurrentColors:[[200,200,200],[180,180,180],[160,160,160]],lastGroundPalettePaint:0,performance:{now:()=>now+=100},ground:{style:{}},groundPaletteFor:()=>[[15,29,44],[8,19,33],[3,9,18]]};
  vm.createContext(context);
  vm.runInContext(sourceBetween('  function updateGroundPalette(', '  function paintGrassTexture('),context);
  for(let i=0;i<300;i++)context.updateGroundPalette('night',{kind:'none',amount:0},100);
  assert.equal(context.ground.style.background,'linear-gradient(180deg,rgb(15 29 44) 0%,rgb(8 19 33) 22%,rgb(3 9 18) 100%)');
});
test('automatic API refresh stops after switching to manual mode',()=>{
  let callback,fetches=0,cleared=false;
  const context={state:{mode:'live'},document:{documentElement:{dataset:{theme:'weather'}}},weatherFetchIntervalId:0,fetchWeather:()=>fetches++,window:{setInterval:fn=>{callback=fn;return 1;},clearInterval:()=>{cleared=true;}}};
  vm.createContext(context);
  vm.runInContext(sourceBetween('  function startWeatherDataRefresh(', '  function persist('),context);
  context.startWeatherDataRefresh();callback();assert.equal(fetches,1);
  context.state.mode='manual';callback();assert.equal(fetches,1);assert.ok(cleared);assert.equal(context.weatherFetchIntervalId,0);
});
test('weather request status has a visible destination',()=>{
  assert.match(html,/<p\b[^>]*id="weather-detail"[^>]*role="status"/);
});
test('offline resource hashes and downloadable package match current files',async()=>{
  const context={window:{}};
  vm.runInNewContext(await readFile(new URL('adk-assets/resource-list.js',root),'utf8'),context);
  vm.runInNewContext(await readFile(new URL('adk-package-data.js',root),'utf8'),context);
  const resources=context.window.ADKOfflineResources;
  const archive=JSON.parse(gunzipSync(Buffer.from(context.window.ADKOfflinePackageData,'base64')));
  const archived=new Map(archive.files.map(file=>[file.name,Buffer.from(file.base64,'base64')]));
  for(const file of resources.files) {
    if(file.name==='adk-package-data.js')continue;
    const bytes=await readFile(new URL(file.name,root));
    if(file.sha256)assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,`Stale resource hash: ${file.name}`);
    assert.ok(archived.get(file.name)?.equals(bytes),`Stale downloadable resource: ${file.name}`);
  }
  assert.equal(archive.files.length,resources.files.length-1);
});
