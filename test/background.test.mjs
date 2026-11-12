import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
let source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
source=source.replace(/^import .*;\n/gm,'');
function worker(options={}){
 const messages=[],storage={};let sends=0;let multiple=false;let listener;const sockets=[];
 class FakeSocket {
  readyState=0;
  sent=[];
  constructor(){sockets.push(this);}
  send(value){this.sent.push(JSON.parse(value));}
  open(){this.readyState=1;this.onopen?.();}
  receive(value){this.onmessage?.({data:JSON.stringify(value)});}
  close(){this.readyState=3;this.onclose?.({code:1000,reason:''});}
 }
 const timers=new Set();
 const mockSetTimeout=(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref?.();timers.add(timer);return timer;};
 const mockSetInterval=(fn,ms)=>{const timer=setInterval(fn,ms);timer.unref?.();timers.add(timer);return timer;};
 const chrome={
  action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},
  storage:{local:{get:async()=>options.local||{},set:async()=>{}},session:{get:async()=>options.session?await options.session:{},set:async v=>Object.assign(storage,JSON.parse(JSON.stringify(v)))}},
  tabs:{get:async()=>({id:1,url:options.tabUrl||'https://www.themoonlight.io/paper/79ad721a-10d1-4767-a6cf-dc5ded2de5d1',title:'Test paper'}),query:async()=>options.tabs||[],create:async tab=>({id:2,...tab})},
  scripting:{executeScript:async({args:[cmd]})=>{
   messages.push(cmd);
   if(options.onScript)await options.onScript(cmd);
   if(cmd.action==='probe')return multiple?[{frameId:0,result:{surface:'viewer'}},{frameId:1,result:{surface:'viewer'}}]:[{frameId:0,result:{surface:'viewer'}}];
   if(cmd.action==='ai_submit'){sends++;if(cmd.question==='fail')throw new Error('connection lost');return [{result:{status:'submitted'}}];}
   return [{result:{paperId:'79ad721a-10d1-4767-a6cf-dc5ded2de5d1',ready:true}}];
  }},
  runtime:{id:'a'.repeat(32),getURL:path=>`chrome-extension://${'a'.repeat(32)}/${path||''}`,getManifest:()=>({version:'0.1.2'}),onMessage:{addListener:fn=>{listener=fn;}}},
  alarms:{onAlarm:{addListener:()=>{}},create:async()=>{}}
 };
 const context=vm.createContext({chrome,CONNECTION:{port:47831,token:'test'},pageOperation:()=>{},crypto:globalThis.crypto,URL,setTimeout:mockSetTimeout,clearTimeout,setInterval:mockSetInterval,clearInterval,WebSocket:FakeSocket});
 vm.runInContext(source+'\nglobalThis.api={execute,stages,initialized};',context);
 return {api:context.api,messages,storage,sockets,async popup(message,sender={id:chrome.runtime.id,url:chrome.runtime.getURL('popup.html')}){return new Promise(resolve=>{if(!listener(message,sender,resolve))resolve(undefined);});},close(){for(const socket of sockets)socket.close();for(const timer of timers){clearTimeout(timer);clearInterval(timer);}},get sends(){return sends;},set multiple(value){multiple=value;}};
}

test('extension requires popup approval and deduplicates a successful request',async()=>{
 const w=worker();const prepared=await w.api.execute({action:'ai_prepare',tabId:1,question:'Explain the method'});
 assert.equal(w.sends,0);
 await assert.rejects(()=>w.api.execute({action:'ai_submit',tabId:1,requestId:prepared.requestId}),/确认/);
 w.api.stages.get(prepared.requestId).approved=true;
 const result=await w.api.execute({action:'ai_submit',tabId:1,requestId:prepared.requestId});
 assert.equal(result.status,'submitted');assert.equal(w.sends,1);
 await w.api.execute({action:'ai_submit',tabId:1,requestId:prepared.requestId});assert.equal(w.sends,1);
 assert.equal(w.messages.at(-1).question,'Explain the method');
});
test('extension preserves attempted state after failure and refuses a resend',async()=>{
 const w=worker();const p=await w.api.execute({action:'ai_prepare',tabId:1,question:'fail'});w.api.stages.get(p.requestId).approved=true;
 await assert.rejects(()=>w.api.execute({action:'ai_submit',tabId:1,requestId:p.requestId}),/connection lost/);
 assert.equal(w.storage.pending[0].status,'attempted');
 await assert.rejects(()=>w.api.execute({action:'ai_submit',tabId:1,requestId:p.requestId}),/不会重发/);assert.equal(w.sends,1);
});
test('approval cannot be reused against a different tab',async()=>{
 const w=worker();const p=await w.api.execute({action:'ai_prepare',tabId:1,question:'Q'});w.api.stages.get(p.requestId).approved=true;
 await assert.rejects(()=>w.api.execute({action:'ai_submit',tabId:2,requestId:p.requestId}),/不匹配/);assert.equal(w.sends,0);
});


test('multiple viewer frames are rejected before any send can execute',async()=>{
 const w=worker();w.multiple=true;
 await assert.rejects(()=>w.api.execute({action:'paper',tabId:1}),/操作前停止/);
 assert.equal(w.messages.length,1);assert.equal(w.messages[0].action,'probe');assert.equal(w.sends,0);
});


test('popup cancellation during the final paper check prevents any send',async()=>{
 let checked,release;
 const checking=new Promise(resolve=>{checked=resolve;});
 const gate=new Promise(resolve=>{release=resolve;});
 const w=worker({onScript:async cmd=>{if(cmd.action==='paper'){checked();await gate;}}});
 const prepared=await w.api.execute({action:'ai_prepare',tabId:1,question:'Q'});
 assert.equal((await w.popup({type:'approve',requestId:prepared.requestId})).ok,true);
 const sending=w.api.execute({action:'ai_submit',tabId:1,requestId:prepared.requestId});
 await checking;
 assert.equal((await w.popup({type:'reject',requestId:prepared.requestId})).ok,true);
 release();
 await assert.rejects(sending,/取消或过期/);
 assert.equal(w.sends,0);
});

test('worker waits for stored requests before servicing popup or submit',async()=>{
 let release;
 const session=new Promise(resolve=>{release=resolve;});
 const requestId='b'.repeat(32);
 const w=worker({session});
 let answered=false;
 const state=w.popup({type:'state'}).then(value=>{answered=true;return value;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(answered,false);
 release({pending:[{requestId,tabId:1,paperId:'79ad721a-10d1-4767-a6cf-dc5ded2de5d1',question:'Q',approved:true,status:'attempted',created:Date.now()}]});
 await state;
 await assert.rejects(()=>w.api.execute({action:'ai_submit',tabId:1,requestId}),/不会重发/);
 assert.equal(w.sends,0);
});

test('only the actual extension popup can approve a pending question',async()=>{
 const w=worker();
 const prepared=await w.api.execute({action:'ai_prepare',tabId:1,question:'Q'});
 assert.equal(await w.popup({type:'approve',requestId:prepared.requestId},{id:'a'.repeat(32),url:'https://www.themoonlight.io/paper/test'}),undefined);
 assert.equal(w.api.stages.get(prepared.requestId).approved,false);
 assert.equal((await w.popup({type:'approve',requestId:prepared.requestId})).ok,true);
});

test('preparing enforces the twenty-request limit before touching the page',async()=>{
 const w=worker();await w.api.initialized;
 for(let i=0;i<20;i++)w.api.stages.set(String(i),{created:Date.now(),status:'prepared'});
 await assert.rejects(()=>w.api.execute({action:'ai_prepare',tabId:1,question:'Q'}),/请求过多/);
 assert.equal(w.messages.length,0);assert.equal(w.api.stages.size,20);
});

test('queued commands are cancelled on disconnect and the new connection remains usable',async t=>{
 let release,entered;
 const started=new Promise(resolve=>{entered=resolve;});
 const gate=new Promise(resolve=>{release=resolve;});
 let blocked=false;
 const w=worker({local:{enabled:true},onScript:async cmd=>{if(cmd.action==='probe'&&!blocked){blocked=true;entered();await gate;}}});
 t.after(()=>w.close());
 await w.api.initialized;
 const first=w.sockets[0];first.open();first.receive({type:'ready'});
 assert.equal(first.sent[0].version,'0.1.2');
 first.receive({type:'command',id:'old-1',command:{action:'paper',tabId:1}});
 first.receive({type:'command',id:'old-2',command:{action:'paper',tabId:1}});
 await started;
 await w.popup({type:'disconnect'});
 release();
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(w.messages.map(command=>command.action),['probe']);
 await w.popup({type:'connect'});
 const second=w.sockets[1];second.open();second.receive({type:'ready'});
 second.receive({type:'command',id:'new',command:{action:'paper',tabId:1}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(second.sent.at(-1).id,'new');
 assert.equal(second.sent.at(-1).result.paperId,'79ad721a-10d1-4767-a6cf-dc5ded2de5d1');
});

test('an existing paper on the bare domain is reused despite query parameters',async()=>{
 const paperId='79ad721a-10d1-4767-a6cf-dc5ded2de5d1';
 const w=worker({tabs:[{id:7,url:`https://themoonlight.io/paper/${paperId}?from=library`}]});
 const result=await w.api.execute({action:'open_paper',paperId});
 assert.equal(result.tabId,7);
});

test('nonstandard website ports are rejected before injecting a script',async()=>{
 const w=worker({tabUrl:'https://www.themoonlight.io:444/paper/test'});
 await assert.rejects(()=>w.api.execute({action:'paper',tabId:1}),/只允许访问/);
 assert.equal(w.messages.length,0);
});
