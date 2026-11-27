import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const root=new URL('../',import.meta.url),html=await readFile(new URL('index.html',root),'utf8');
function source(name){
  const start=html.indexOf('    function '+name+'('),end=html.indexOf('\n    function ',start+10);
  assert.ok(start>=0&&end>start,'Missing function: '+name);return html.slice(start,end);
}
test('theme cycles light, dark, weather in order',()=>{
  const context={};vm.createContext(context);vm.runInContext(source('nextQuickSettingsTheme'),context);
  let value='light';const sequence=[];for(let i=0;i<4;i++){sequence.push(value);value=context.nextQuickSettingsTheme(value);}
  assert.deepEqual(sequence,['light','dark','weather','light']);assert.equal(context.nextQuickSettingsTheme('unknown'),'light');
});
test('screen style cycles simple, modern, default in order',()=>{
  const context={};vm.createContext(context);vm.runInContext(source('nextQuickSettingsDesign'),context);
  let value='simple';const sequence=[];for(let i=0;i<4;i++){sequence.push(value);value=context.nextQuickSettingsDesign(value);}
  assert.deepEqual(sequence,['simple','modern','default','simple']);assert.equal(context.nextQuickSettingsDesign('unknown'),'simple');
});
for(const theme of ['light','dark','weather'])test(`saved ${theme} theme survives startup`,()=>{
  const context={localStorage:{getItem:()=>theme},document:{documentElement:{dataset:{}}}};
  vm.runInNewContext(html.match(/^        try \{ const savedTheme=[^\n]+/m)[0],context);
  assert.equal(context.document.documentElement.dataset.theme,theme);
});
for(const design of ['simple','modern','default'])test(`saved ${design} screen style survives startup`,()=>{
  const context={localStorage:{getItem:()=>design},document:{documentElement:{dataset:{}}}};
  vm.runInNewContext(html.match(/^        try \{ const savedDesign=[^\n]+/m)[0],context);
  assert.equal(context.document.documentElement.dataset.weatherDesign,design);
});
test('missing storage access falls back to a usable theme and style',()=>{
  const context={localStorage:{getItem(){throw Error('Storage unavailable');}},document:{documentElement:{dataset:{}}}};
  vm.runInNewContext(html.match(/^        try \{ const savedTheme=[^\n]+/m)[0],context);
  vm.runInNewContext(html.match(/^        try \{ const savedDesign=[^\n]+/m)[0],context);
  assert.equal(context.document.documentElement.dataset.theme,'weather');assert.equal(context.document.documentElement.dataset.weatherDesign,'simple');
});
function panelController({reduced=false,lowPerformance=false}={}){
  let now=0,nextId=0;
  const timers=new Map(),nodes=new Map();
  function node(){
    const classes=new Set();
    return {hidden:true,inert:false,textContent:'',classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)},setAttribute(){},contains:()=>false};
  }
  for(const id of ['quick-settings-panel','quick-settings-control','quick-settings-toggle','quick-settings-school','quick-settings-date'])nodes.set(id,node());
  const context={quickSettingsOpen:false,quickSettingsDrag:null,quickSettingsPositionFrame:0,quickSettingsCloseTimer:null,quickSettingsPreviousFocus:null,
    window:{setTimeout(fn,ms){const id=++nextId;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id)},
    document:{activeElement:null,getElementById:id=>nodes.get(id),body:{appendChild(){},classList:{contains:()=>lowPerformance}}},
    localStorage:{getItem:()=>null},quickSettingsDateFormatter:{format:()=>''},matchMedia:()=>({matches:reduced}),
    closeNotificationList(){},hideNotificationPill(){},syncQuickSettings(){},positionQuickSettings(){},cancelAnimationFrame(){}};
  vm.createContext(context);vm.runInContext(source('showQuickSettings')+source('closeQuickSettings'),context);
  return {context,panel:nodes.get('quick-settings-panel'),timers,tick(ms){now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}}};
}

test('closing disables panel input immediately and hides it after the exit animation',()=>{
  const {context:c,panel,tick}=panelController();c.showQuickSettings();c.closeQuickSettings();
  assert.equal(c.quickSettingsOpen,false);assert.equal(panel.hidden,false);assert.equal(panel.inert,true);assert.ok(panel.classList.contains('is-closing'));
  tick(419);assert.equal(panel.hidden,false);tick(1);assert.equal(panel.hidden,true);assert.equal(c.quickSettingsCloseTimer,null);
});

test('reopening cancels stale exit callbacks and repeated close does not extend the animation',()=>{
  const {context:c,panel,tick,timers}=panelController();c.showQuickSettings();c.closeQuickSettings();tick(200);c.showQuickSettings();tick(500);
  assert.equal(panel.hidden,false);assert.equal(panel.inert,false);assert.equal(c.quickSettingsCloseTimer,null);assert.equal(timers.size,0);
  c.closeQuickSettings();tick(200);c.closeQuickSettings();assert.equal(timers.size,1);tick(220);assert.equal(panel.hidden,true);
});

test('panel handoffs and reduced-motion or low-performance modes leave no exit timer',()=>{
  for(const options of [{},{reduced:true},{lowPerformance:true}]){
    const {context:c,panel,timers}=panelController(options);c.showQuickSettings();c.closeQuickSettings(false,true);
    assert.equal(panel.hidden,true);assert.equal(timers.size,0);
    if(options.reduced||options.lowPerformance){c.showQuickSettings();c.closeQuickSettings();assert.equal(panel.hidden,true);assert.equal(timers.size,0);}
  }
});

test('version, build, release notes and offline metadata agree',async()=>{
  const version=html.match(/id="app-version-text"[^>]*data-version="([^"]+)"/)[1];
  const build=html.match(/id="app-build-number"[^>]*data-build="([^"]+)"/)[1];
  assert.ok(build.includes('v.'+version+'-'));
  for(const id of ['update-version-hero-value','software-version-hero-value'])assert.ok(html.includes('id="'+id+'">'+version+'</span>'));
  assert.ok(html.includes('<!-- release-v'+version+'-start -->'));
  const context={window:{}};vm.runInNewContext(await readFile(new URL('adk-assets/resource-list.js',root),'utf8'),context);
  assert.equal(context.window.ADKOfflineResources.appVersion,version);
});
