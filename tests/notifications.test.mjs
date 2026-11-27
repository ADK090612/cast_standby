// Dependency-free controller checks: node --test tests/notifications.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
function functionSource(name) {
  const start=html.indexOf('    function '+name+'(');
  const end=html.indexOf('\n    function ',start+10);
  assert.ok(start>=0&&end>start,'Missing function boundary: '+name);
  return html.slice(start,end);
}
function element(rect={left:0,top:0,width:200,height:44}) {
  const classes=new Set(),properties=new Map(),attributes=new Map();
  return {hidden:true,dataset:{},textContent:'',classList:{add:(...names)=>names.forEach(n=>classes.add(n)),remove:(...names)=>names.forEach(n=>classes.delete(n)),contains:n=>classes.has(n),toggle(n,enabled){if(enabled??!classes.has(n))classes.add(n);else classes.delete(n);}},
    style:{setProperty:(k,v)=>properties.set(k,v),getPropertyValue:k=>properties.get(k),removeProperty:k=>properties.delete(k)},setAttribute:(k,v)=>attributes.set(k,v),
    getBoundingClientRect:()=>({...rect,right:rect.left+rect.width,bottom:rect.top+rect.height}),querySelector:()=>null,querySelectorAll:()=>[]};
}
function controller({reduced=false,lowPerformance=false}={}) {
  let now=0,nextId=0,renders=0;
  const timers=new Map();
  const title=element(),message=element(),pill=element(),list=element(),badge=element(),toggle=element();
  pill.querySelector=selector=>selector.includes('title')?title:message;
  const elements={'custom-notification-pill':pill,'custom-notification-container':list,'notification-badge':badge,'notification-toggle':toggle};
  const context={appNotifications:[],isPillHidden:true,notificationCloseTimer:null,notificationPillTimer:null,notificationPillCloseTimer:null,notificationIdleTimer:null,notificationPillId:null,notificationHandleDrag:null,notificationSwipeDrag:null,notificationSuppressClick:false,
    window:{setTimeout(fn,ms){const id=++nextId;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id)},document:{getElementById:id=>elements[id],body:{classList:{contains:()=>lowPerformance}}},matchMedia:()=>({matches:reduced}),
    positionNotificationSurfaces(){},updateNotificationHandleVisibility(){},bringNotificationsToFront(){},renderNotificationList(){renders++;}};
  vm.createContext(context);
  const names=['notificationListIsOpen','syncNotificationToggle','resetNotificationIdleTimer','closeNotificationList','toggleNotificationList','hideNotificationPill','showNotificationPill','addCustomNotification','updateNotificationUI','notificationSettingsTarget','showAllNotifications','clearAllNotifications'];
  vm.runInContext(names.map(functionSource).join('\n'),context);
  function tick(ms) {
    const target=now+ms;
    while(true){const due=[...timers].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;timers.delete(due[0]);now=due[1].at;due[1].fn();}
    now=target;
  }
  return {context,tick,pill,list,title,message,toggle,badge,timers,get renders(){return renders;}};
}
test('a new alert previews only itself and starts its exit after three seconds',()=>{
  const {context:c,tick,pill,title,message}=controller();
  c.addCustomNotification('meal','이전 알림','이전 내용');
  c.addCustomNotification('update','업데이트','새 내용');
  assert.equal(title.textContent,'업데이트');assert.equal(message.textContent,'새 내용');assert.equal(pill.hidden,false);
  assert.equal(c.notificationListIsOpen(),false);
  tick(2999);assert.equal(pill.hidden,false);tick(1);assert.equal(pill.hidden,false);assert.ok(pill.classList.contains('notification-preview-closing'));assert.equal(pill.inert,true);
  tick(419);assert.equal(pill.hidden,false);tick(1);assert.equal(pill.hidden,true);
  assert.equal(c.appNotifications.length,2,'Preview timeout must retain notification history');
});
test('an older preview timeout cannot hide a newer alert',()=>{
  const {context:c,tick,pill,message}=controller();
  c.addCustomNotification('general','첫 알림','첫 내용');tick(2000);
  c.addCustomNotification('general','둘째 알림','둘째 내용');tick(1500);
  assert.equal(pill.hidden,false);assert.equal(message.textContent,'둘째 내용');
  tick(1500);assert.ok(pill.classList.contains('notification-preview-closing'));tick(420);assert.equal(pill.hidden,true);
});

test('a new alert during exit cancels the stale hide callback and restarts entry',()=>{
  const {context:c,tick,pill,message,timers}=controller();c.addCustomNotification('general','첫 알림','처음');tick(3200);
  assert.ok(pill.classList.contains('notification-preview-closing'));
  c.addCustomNotification('general','새 알림','교체');assert.equal(pill.inert,false);assert.ok(pill.classList.contains('notification-preview-entering'));assert.equal(c.notificationPillCloseTimer,null);
  tick(300);assert.equal(pill.hidden,false);assert.equal(message.textContent,'교체');assert.equal(pill.classList.contains('notification-preview-closing'),false);
  tick(2700);assert.ok(pill.classList.contains('notification-preview-closing'));tick(420);assert.equal(pill.hidden,true);assert.equal(timers.size,0);
});

test('repeated hide does not extend exit and an immediate handoff cancels its timer',()=>{
  const {context:c,tick,pill,timers}=controller();c.addCustomNotification('general','알림','내용');tick(3000);tick(200);c.hideNotificationPill();tick(220);
  assert.equal(pill.hidden,true);assert.equal(timers.size,0);
  c.addCustomNotification('general','다음','다음');tick(3000);c.showAllNotifications();assert.equal(pill.hidden,true);assert.equal(c.notificationPillCloseTimer,null);tick(500);assert.ok(c.notificationListIsOpen());
});

test('preview uses immediate hiding with reduced motion or low performance',()=>{
  for(const options of [{reduced:true},{lowPerformance:true}]){
    const {context:c,tick,pill,timers}=controller(options);c.addCustomNotification('general','알림','내용');tick(3000);assert.equal(pill.hidden,true);assert.equal(timers.size,0);
  }
});

test('opening history marks retained alerts as read and restores the handle',()=>{
  const {context:c,toggle,badge}=controller();c.addCustomNotification('general','첫째','내용1');c.addCustomNotification('general','둘째','내용2');
  assert.ok(toggle.classList.contains('has-notifications'));assert.equal(badge.textContent,'2');
  c.showAllNotifications();assert.equal(toggle.classList.contains('has-notifications'),false);assert.equal(badge.textContent,'0');assert.equal(c.appNotifications.length,2);assert.ok(c.appNotifications.every(n=>n.read));
});

test('an unseen alert after reading reactivates the handle without unread history',()=>{
  const {context:c,toggle,badge}=controller();c.addCustomNotification('general','확인','내용1');c.showAllNotifications();c.closeNotificationList(true);
  c.addCustomNotification('general','신규','내용2');assert.ok(toggle.classList.contains('has-notifications'));assert.equal(badge.textContent,'1');assert.equal(c.appNotifications.length,2);
});

test('passive preview expiry does not mark an alert as read',()=>{
  const {context:c,tick,toggle}=controller();c.addCustomNotification('general','알림','내용');tick(3500);assert.equal(c.appNotifications[0].read,false);assert.ok(toggle.classList.contains('has-notifications'));
});

test('alerts delivered into an open history are read without a redundant preview',()=>{
  const {context:c,pill,toggle}=controller();c.showAllNotifications();c.addCustomNotification('general','바로 확인','목록에서 확인');
  assert.equal(c.appNotifications[0].read,true);assert.equal(pill.hidden,true);assert.equal(toggle.classList.contains('has-notifications'),false);
});
test('opening history cancels the preview and starts the idle timeout',()=>{
  const {context:c,tick,pill,list}=controller();c.addCustomNotification('general','알림','내용');
  c.showAllNotifications();assert.equal(pill.hidden,true);assert.equal(c.notificationListIsOpen(),true);
  tick(3000);assert.equal(list.classList.contains('closing'),true);
  tick(420);assert.equal(list.classList.contains('open'),false);
});
test('input restarts the three-second list timeout',()=>{
  const {context:c,tick}=controller();c.showAllNotifications();tick(2000);c.resetNotificationIdleTimer();
  tick(2000);assert.equal(c.notificationListIsOpen(),true);
  tick(1000);assert.equal(c.notificationListIsOpen(),false);
});
test('an active drag holds the list open until input ends',()=>{
  const {context:c,tick}=controller();c.notificationHandleDrag={id:1};c.showAllNotifications();
  tick(10000);assert.equal(c.notificationListIsOpen(),true);
  c.notificationHandleDrag=null;c.resetNotificationIdleTimer();tick(3000);assert.equal(c.notificationListIsOpen(),false);
});
test('reopening during the closing animation cancels the old close timer',()=>{
  const {context:c,tick}=controller();c.showAllNotifications();c.closeNotificationList();tick(200);
  c.showAllNotifications();tick(300);assert.equal(c.notificationListIsOpen(),true);
});
test('identical alerts deduplicate without merging unrelated sources',()=>{
  const {context:c}=controller();const first=c.addCustomNotification('general','A','같은 내용');
  assert.equal(c.addCustomNotification('general','A','같은 내용'),first);
  c.addCustomNotification('update','B','같은 내용');assert.equal(c.appNotifications.length,2);
});
test('new alerts survive an in-progress clear-all animation',()=>{
  const {context:c,tick}=controller();c.addCustomNotification('general','이전','삭제');c.showAllNotifications();c.clearAllNotifications();
  c.addCustomNotification('general','신규','보존');tick(500);
  assert.deepEqual(Array.from(c.appNotifications,item=>item.message),['보존']);
});
test('notification destinations respect the source and explicit settings metadata',()=>{
  const {context:c}=controller();
  for(const [type,view] of [['update','update'],['pip','pip'],['meal','profile'],['network','profile'],['general','main-menu']])assert.equal(c.notificationSettingsTarget({type,title:'알림'}),view);
  assert.equal(c.notificationSettingsTarget({type:'general',title:'오프라인'}),'offline');
  assert.equal(c.notificationSettingsTarget({type:'general',title:'오프라인',settingsView:'cache-update'}),'cache-update');
});
function layout({width=1440,height=900,left=0,right=0,top=0,bottom=0,open=false,drag=null}={}) {
  const control=element(),handle=element({left:0,top:4,width:76,height:20}),pill=element({left:0,top:48,width:300,height:44}),list=element({left:0,top:48,width:width<600?width-32:520,height:200});
  list.querySelector=()=>element({left:480,top:200,width:90,height:34});
  const elements={'notification-control':control,'notification-toggle':handle,'custom-notification-pill':pill,'custom-notification-container':list};
  const context={innerWidth:width,innerHeight:height,notificationHandleDrag:drag,notificationListIsOpen:()=>open,updateNotificationHandleVisibility(){},document:{documentElement:{},getElementById:id=>elements[id]},getComputedStyle:()=>({getPropertyValue:key=>{const value={'--safe-left':left,'--safe-right':right,'--safe-top':top,'--safe-bottom':bottom}[key]||0;return typeof value==='string'?value:value+'px';}})};
  vm.createContext(context);vm.runInContext(['displaySurfaceInsets','positionSurfaceHandleHitArea','positionNotificationSurfaces'].map(functionSource).join('\n'),context);context.positionNotificationSurfaces();
  return {control,list,pill};
}
test('closed handle sits at the left quarter with a four-pixel top gap',()=>{
  const {control}=layout();assert.equal(control.style.getPropertyValue('--notification-handle-center'),'360px');assert.equal(control.style.getPropertyValue('--notification-handle-top'),'4px');
});
test('click-open handle aligns vertically with clear all',()=>{
  const {control}=layout({open:true});assert.equal(control.style.getPropertyValue('--notification-handle-top'),'207px');
});
test('dragged handle follows the pointer and stops at the clear-all row',()=>{
  assert.equal(layout({open:true,drag:{opened:true,top:4,deltaY:50}}).control.style.getPropertyValue('--notification-handle-top'),'54px');
  assert.equal(layout({open:true,drag:{opened:true,top:4,deltaY:500}}).control.style.getPropertyValue('--notification-handle-top'),'207px');
});
test('an upward drag follows the pointer from the expanded row back to the top',()=>{
  assert.equal(layout({open:true,drag:{wasOpen:true,opened:false,top:207,deltaY:-50}}).control.style.getPropertyValue('--notification-handle-top'),'157px');
  assert.equal(layout({open:true,drag:{wasOpen:true,opened:false,top:207,deltaY:-500}}).control.style.getPropertyValue('--notification-handle-top'),'4px');
});
test('safe margins shift the quarter point and mobile content stays in view',()=>{
  assert.equal(layout({left:120,right:80}).control.style.getPropertyValue('--notification-handle-center'),'430px');
  const {control,list}=layout({width:390});assert.equal(control.style.getPropertyValue('--notification-handle-center'),'97.5px');assert.equal(list.style.getPropertyValue('--notification-center'),'195px');
});

test('viewport-based margins are converted to pixels for the handle quarter point and top gap',()=>{
  const {control}=layout({left:'10vw',right:'5vw',top:'12vh',bottom:'8vh'});
  assert.equal(control.style.getPropertyValue('--notification-handle-center'),'450px');
  assert.equal(control.style.getPropertyValue('--notification-handle-top'),'112px');
});

test('margin conversion scales with viewport resize instead of treating percentages as pixels',()=>{
  const {control}=layout({width:1920,height:1080,left:'10vw',right:'5vw',top:'12vh'});
  assert.equal(control.style.getPropertyValue('--notification-handle-center'),'600px');
  assert.ok(Math.abs(parseFloat(control.style.getPropertyValue('--notification-handle-top'))-133.6)<.001);
});

test('a narrow inset display clips the gesture zone inside its margins and its left half',()=>{
  const {control}=layout({width:390,height:844,left:'20vw',right:'20vw',top:'20vh',bottom:'20vh'}),value=name=>parseFloat(control.style.getPropertyValue(name));
  const center=value('--notification-handle-center'),hitLeft=center-38+value('--surface-hit-left');
  assert.equal(hitLeft,78);assert.equal(hitLeft+value('--surface-hit-width'),195);
  assert.equal(value('--surface-hit-top'),-4);assert.equal(value('--surface-hit-height'),56);
});
