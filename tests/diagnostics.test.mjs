import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../adk-diagnostics.js',import.meta.url),'utf8');
test('loading the diagnostics module while developer options are locked installs no hooks or jobs',()=>{
  let work=0;const fetch=()=>{},log=()=>{},context={window:{__dashboardDeveloperOptionsEnabled:()=>false,fetch},document:new Proxy({},{get(){work++;throw Error('Locked diagnostics touched the DOM');}}),console:{log},setTimeout(){work++;},setInterval(){work++;},requestAnimationFrame(){work++;},MutationObserver:class{constructor(){work++;}}};
  vm.runInNewContext(code,context);const api=context.window.ADKDiagnostics;api.activate();api.record('test','ignored');
  assert.equal(api.state.active,false);assert.equal(api.state.timer,false);assert.equal(api.state.frame,false);assert.equal(api.state.observer,false);assert.equal(api.state.apiCount,0);assert.equal(api.state.logCount,0);assert.equal(context.window.fetch,fetch);assert.equal(context.console.log,log);assert.equal(work,0);
});
