const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {shutdownScript}=require('../app/remote.cjs');
const a='11111111-1111-1111-1111-111111111111';
const b='22222222-2222-2222-2222-222222222222';
const c='33333333-3333-3333-3333-333333333333';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function harness() {
  const entries=new Map(),intervals=[],calls={start:[],shutdown:[],disconnect:0,devices:0};
  class Element {
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.value='';this.textContent='';this.disabled=false;this.classList={toggle(){}};}
    append(...items){this.children.push(...items);}
    replaceChildren(...items){this.children=[...items];}
    setAttribute(){}
    focus(){document.activeElement=this;}
    matches(){return !!this.opened;}
    showPicker(){}
    click(){if(!this.disabled)return this.onclick?.();}
  }
  for(const match of fs.readFileSync('app/index.html','utf8').matchAll(/id="([^"]+)"/g))entries.set(match[1],new Element());
  const main=new Element('main');
  const document={getElementById:id=>entries.get(id),createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text}),querySelector:()=>main,querySelectorAll:()=>[],addEventListener(){},hasFocus:()=>false,activeElement:null};
  const info={devices:[{udid:a,name:'iPhone A',kind:'simulator',state:'Booted',runtime:'iOS-26-3'},{udid:b,name:'iPhone B',kind:'simulator',state:'Booted',runtime:'iOS-26-3'},{udid:c,name:'iPhone C',kind:'simulator',state:'Shutdown',runtime:'iOS-26-3'}]};
  let progress,menuAction,viewerMode;
  const mirror={profiles:async()=>[],importHosts:async()=>[{kind:'mcp',hostId:'test',name:'Mac',target:'mac.local'}],setup:async()=>structuredClone(info),devices:async()=>{calls.devices++;return structuredClone(info)},panel:async()=>{},onPanel(){},onAgentView(fn){mirror.agentView=fn;},onAction(fn){menuAction=fn},onViewerMode(fn){viewerMode=fn},onProgress:fn=>{progress=fn},
    start:async id=>{calls.start.push(id);if(mirror.failStart)throw Error('Boot failed');info.devices.find(d=>d.udid===id).state='Booted';},
    shutdown:async id=>{calls.shutdown.push(id);info.devices.find(d=>d.udid===id).state='Shutdown';},disconnect:async()=>{calls.disconnect++;},stop:async()=>{},control:async()=>{},screenshot:async()=>{},chooseKey:async()=>''};
  vm.runInNewContext(fs.readFileSync('app/renderer.js','utf8'),{document,window:{mirror},setInterval:fn=>intervals.push(fn)});
  await tick();
  entries.get('hosts').value='0';
  return {entries,info,calls,intervals,mirror,menuAction:command=>menuAction(command),viewerMode:mode=>viewerMode(mode),progress:message=>progress(message),labels:()=>entries.get('simulators').children.flatMap(group=>group.children.length?group.children.map(o=>o.textContent):[group.textContent])};
}

test('Watch agent changes input mode without reconnecting or losing the selected simulator',async()=>{
  const h=await harness();await h.entries.get('connect').onclick();
  h.entries.get('simulators').value=a;await h.entries.get('simulators').onchange();
  const events=[];h.mirror.watchAgent=async()=>events.push('release-and-switch');
  const start=h.mirror.start;h.mirror.start=async id=>{events.push('reconnect');return start(id)};
  h.progress('Live video connected.');
  await h.menuAction('watch-agent');assert.deepEqual(events,['release-and-switch']);assert.deepEqual(h.calls.start,[a]);assert.equal(h.calls.disconnect,0);
  h.viewerMode(true);assert.equal(h.entries.get('home').disabled,true);assert.equal(h.entries.get('screenshot').disabled,false);
  h.viewerMode(false);assert.equal(h.entries.get('home').disabled,false);
  h.mirror.watchAgent=async()=>{throw Error('Reservation release failed')};events.length=0;
  await h.menuAction('watch-agent');assert.deepEqual(events,[]);assert.match(h.entries.get('status').textContent,/Reservation release failed/);
});

test('connecting discovers running devices without selecting, booting or opening one',async()=>{
  const h=await harness();await h.entries.get('connect').onclick();
  assert.deepEqual(h.calls.start,[]);assert.deepEqual(h.calls.shutdown,[]);
  assert.equal(h.entries.get('simulators').value,'');
  assert.ok(h.labels().includes('iPhone A — Running'));
  assert.ok(h.labels().includes('iPhone C — Stopped'));
  assert.equal(h.entries.get('open').disabled,true);
});

test('switching preserves other running simulators, and shutdown targets only the selected one',async()=>{
  const h=await harness();await h.entries.get('connect').onclick();
  for(const id of [a,b]){h.entries.get('simulators').value=id;await h.entries.get('simulators').onchange();}
  assert.deepEqual(h.calls.start,[a,b]);
  assert.equal(h.info.devices.find(d=>d.udid===a).state,'Booted');
  assert.ok(h.labels().includes('iPhone B — Running · Viewing'));
  await h.entries.get('shutdown').onclick();
  assert.deepEqual(h.calls.shutdown,[b]);
  assert.equal(h.info.devices.find(d=>d.udid===a).state,'Booted');
  assert.equal(h.info.devices.find(d=>d.udid===b).state,'Shutdown');
  assert.deepEqual(h.calls.start,[a,b]);
});

test('background refresh updates running labels without changing selection or opening anything',async()=>{
  const h=await harness();await h.entries.get('connect').onclick();
  h.entries.get('simulators').value=a;await h.entries.get('simulators').onchange();
  h.info.devices.find(d=>d.udid===c).state='Booted';
  h.intervals[0]();await tick();
  assert.equal(h.entries.get('simulators').value,a);
  assert.ok(h.labels().includes('iPhone C — Running'));
  assert.deepEqual(h.calls.start,[a]);
});

test('a failed device start leaves no misleading active viewer',async()=>{
  const h=await harness();await h.entries.get('connect').onclick();h.mirror.failStart=true;
  h.entries.get('simulators').value=c;await h.entries.get('simulators').onchange();
  assert.equal(h.calls.disconnect,1);assert.equal(h.entries.get('home').disabled,true);
});

test('background refresh leaves an open device picker alone',async()=>{
  const h=await harness();await h.entries.get('connect').onclick();
  h.entries.get('simulators').opened=true;
  h.intervals[0]();await tick();assert.equal(h.calls.devices,0);
  h.entries.get('simulators').opened=false;
  h.intervals[0]();await tick();assert.equal(h.calls.devices,1);
});

test('a user selection made during refresh is preserved and opens only that device',async()=>{
  const h=await harness();await h.entries.get('connect').onclick();
  const original=h.mirror.devices;let deliver;
  h.mirror.devices=()=>new Promise(resolve=>{deliver=()=>resolve(structuredClone(h.info));});
  h.intervals[0]();
  h.entries.get('simulators').value=b;
  const selection=h.entries.get('simulators').onchange();
  h.mirror.devices=original;deliver();await selection;
  assert.deepEqual(h.calls.start,[b]);assert.equal(h.entries.get('simulators').value,b);
});

test('simulator shutdown rejects injected identifiers',()=>{
  assert.throws(()=>shutdownScript(a+'; shutdown all'));
});

test('a pending connection keeps the selector usable and switching cancels the old attempt',async()=>{
  const h=await harness();await h.entries.get('connect').onclick();let rejectFirst;
  h.mirror.start=async id=>{h.calls.start.push(id);if(id===a)await new Promise((_resolve,reject)=>{rejectFirst=reject;});};
  h.mirror.cancelStart=async()=>rejectFirst(Error('Connection cancelled.'));
  h.entries.get('simulators').value=a;const first=h.entries.get('simulators').onchange();await tick();
  assert.equal(h.entries.get('simulators').disabled,false);
  assert.equal(h.entries.get('open').title,'Cancel connection attempt');
  h.entries.get('simulators').value=b;await h.entries.get('simulators').onchange();await first;
  assert.deepEqual(h.calls.start,[a,b]);assert.equal(h.entries.get('simulators').value,b);
});
