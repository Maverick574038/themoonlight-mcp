import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createBridge} from '../src/bridge.mjs';
import {validateCommand} from '../src/config.mjs';

const config={port:0,clientToken:'client-secret',browserToken:'extension-secret'};
async function fixture(t,options={}){const b=await createBridge(config,options);t.after(()=>b.close());return {b,base:`http://127.0.0.1:${b.port}`,headers:{Authorization:'Bearer client-secret','Content-Type':'application/json'}};}
async function browser(base,token='extension-secret',version){const ws=new WebSocket(base.replace('http:','ws:')+'/browser',{origin:'chrome-extension://'+'a'.repeat(32)});await once(ws,'open');const response=once(ws,'message');ws.send(JSON.stringify({type:'hello',token,version}));await response;return ws;}

test('local endpoints authenticate and reject website origins',async t=>{
  const {base,headers}=await fixture(t);
  assert.equal((await fetch(base+'/health')).status,401);
  assert.equal((await fetch(base+'/health',{headers:{...headers,Origin:'https://www.themoonlight.io'}})).status,403);
  assert.equal((await (await fetch(base+'/health',{headers})).json()).browserConnected,false);
});
test('an offline browser gives an actionable error',async t=>{
  const {base,headers}=await fixture(t);
  const r=await fetch(base+'/command',{method:'POST',headers,body:JSON.stringify({action:'tabs'})});
  assert.equal(r.status,503);assert.match((await r.json()).error,/Chrome/);
});
test('bridge sends exact commands, correlates replies, and refuses parallel UI mutations',async t=>{
  const {base,headers}=await fixture(t);const ws=await browser(base);t.after(()=>ws.terminate());
  const received=once(ws,'message');const first=fetch(base+'/command',{method:'POST',headers,body:JSON.stringify({action:'paper',tabId:42})});
  const [raw]=await received,m=JSON.parse(raw);assert.deepEqual(m.command,{action:'paper',tabId:42});
  const busy=await fetch(base+'/command',{method:'POST',headers,body:JSON.stringify({action:'tabs'})});assert.match((await busy.json()).error,/执行中/);
  ws.send(JSON.stringify({type:'result',id:m.id,result:{title:'Example',pages:10}}));
  assert.deepEqual(await (await first).json(),{title:'Example',pages:10});
});
test('a failed request is not permanently cached before popup approval',async t=>{
  const {base,headers}=await fixture(t);const ws=await browser(base);t.after(()=>ws.terminate());let calls=0;
  ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='command'){calls++;ws.send(JSON.stringify({type:'result',id:m.id,...(calls===1?{error:'Approval required'}:{result:{status:'submitted'}})}));}});
  const body=JSON.stringify({action:'ai_submit',tabId:42,requestId:'b'.repeat(32)});
  assert.equal((await fetch(base+'/command',{method:'POST',headers,body})).status,400);
  assert.equal((await (await fetch(base+'/command',{method:'POST',headers,body})).json()).status,'submitted');
});
test('timeout does not automatically retransmit an AI request',async t=>{
  const {base,headers}=await fixture(t,{commandTimeout:80});const ws=await browser(base);t.after(()=>ws.terminate());let count=0;
  ws.on('message',raw=>{if(JSON.parse(raw).type==='command')count++;});
  const r=await fetch(base+'/command',{method:'POST',headers,body:JSON.stringify({action:'ai_submit',tabId:42,requestId:'b'.repeat(32)})});
  assert.match((await r.json()).error,/超时/);assert.equal(count,1);
});
test('only fixed Moonlight actions and bounded page ranges can cross the bridge',()=>{
  assert.throws(()=>validateCommand({action:'eval',script:'malicious()'}));
  assert.throws(()=>validateCommand({action:'pages',tabId:1,startPage:1,endPage:50}));
  assert.throws(()=>validateCommand({action:'open_paper',paperId:'https://attacker.invalid'}));
  assert.throws(()=>validateCommand({action:'ai_prepare',tabId:1,question:''}));
  assert.equal(validateCommand({action:'pages',tabId:1,startPage:1,endPage:10}).endPage,10);
});

test('an authenticated browser survives Codex idle timeout and heartbeat resets idle time',async t=>{
  let clock=0;
  const {b,base}=await fixture(t,{idleMs:100,now:()=>clock});
  const ws=await browser(base);t.after(()=>ws.terminate());
  clock=1000;
  assert.equal(await b.checkIdle(),false);
  assert.equal(b.server.listening,true);
  const pong=once(ws,'message');ws.send(JSON.stringify({type:'ping'}));
  assert.equal(JSON.parse((await pong)[0]).type,'pong');
  const closed=once(ws,'close');ws.terminate();await closed;
  // Wait for the server side of the close to be observed without issuing a health request.
  await new Promise(resolve=>setImmediate(resolve));
  clock=1050;assert.equal(await b.checkIdle(),false);
  clock=1200;assert.equal(await b.checkIdle(),true);
  assert.equal(b.server.listening,false);
  await b.close(); // Closing twice is harmless during shutdown/test cleanup.
});

test('a disconnected bridge still exits after its idle interval',async t=>{
  let clock=0;
  const {b}=await fixture(t,{idleMs:100,now:()=>clock});
  clock=101;assert.equal(await b.checkIdle(),true);assert.equal(b.server.listening,false);
});


test('malformed WebSocket JSON values are rejected without stopping the bridge',async t=>{
  const {base,headers}=await fixture(t);
  for(const authenticated of [false,true]){
    for(const message of [null,[],42,'hello',{}, {type:'result',id:'test'}]){
      const ws=authenticated?await browser(base):new WebSocket(base.replace('http:','ws:')+'/browser',{origin:'chrome-extension://'+'a'.repeat(32)});
      if(!authenticated)await once(ws,'open');
      const closed=once(ws,'close');ws.send(JSON.stringify(message));
      assert.equal((await closed)[0],1008);
      const health=await fetch(base+'/health',{headers});
      assert.equal(health.status,200);
    }
  }
});

test('split UTF-8 HTTP chunks preserve the exact question',async t=>{
  const {base,headers}=await fixture(t);const ws=await browser(base);t.after(()=>ws.terminate());
  const question='请解释这个公式。';
  const body=Buffer.from(JSON.stringify({action:'ai_prepare',tabId:42,question}));
  const split=body.indexOf(Buffer.from('请'))+1;
  ws.once('message',raw=>{
    const m=JSON.parse(raw);assert.equal(m.command.question,question);
    ws.send(JSON.stringify({type:'result',id:m.id,result:{question:m.command.question}}));
  });
  const response=await new Promise((resolve,reject)=>{
    const req=http.request(base+'/command',{method:'POST',headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks).toString())));res.on('error',reject);
    });
    req.on('error',reject);req.write(body.subarray(0,split));
    setTimeout(()=>req.end(body.subarray(split)),30);
  });
  assert.equal(response.question,question);
});

test('a timed-out operation retains its slot until the browser reports completion',async t=>{
  const {base,headers}=await fixture(t,{commandTimeout:30});const ws=await browser(base);t.after(()=>ws.terminate());
  let count=0;ws.on('message',raw=>{if(JSON.parse(raw).type==='command')count++;});
  const received=once(ws,'message');
  const first=fetch(base+'/command',{method:'POST',headers,body:JSON.stringify({action:'paper',tabId:42})});
  const m=JSON.parse((await received)[0]);
  assert.match((await (await first).json()).error,/超时/);
  assert.equal((await (await fetch(base+'/health',{headers})).json()).timedOutPending,1);
  const blocked=await fetch(base+'/command',{method:'POST',headers,body:JSON.stringify({action:'tabs'})});
  assert.match((await blocked.json()).error,/尚未完成/);assert.equal(count,1);
  ws.send(JSON.stringify({type:'result',id:m.id,result:{title:'late result'}}));
  const pong=once(ws,'message');ws.send(JSON.stringify({type:'ping'}));await pong;
  assert.equal((await (await fetch(base+'/health',{headers})).json()).pending,0);
  ws.once('message',raw=>{const next=JSON.parse(raw);ws.send(JSON.stringify({type:'result',id:next.id,result:{tabs:[]}}));});
  assert.deepEqual(await (await fetch(base+'/command',{method:'POST',headers,body:JSON.stringify({action:'tabs'})})).json(),{tabs:[]});
  assert.equal(count,2);
});

test('disconnect clears an uncertain operation and allows a new browser session',async t=>{
  const {base,headers}=await fixture(t,{commandTimeout:30});const ws=await browser(base);
  const response=await fetch(base+'/command',{method:'POST',headers,body:JSON.stringify({action:'paper',tabId:42})});
  assert.match((await response.json()).error,/超时/);
  const closed=once(ws,'close');ws.close();await closed;
  const next=await browser(base);t.after(()=>next.terminate());
  const health=await (await fetch(base+'/health',{headers})).json();
  assert.equal(health.browserConnected,true);assert.equal(health.pending,0);
});


test('health identifies the bridge and connected extension version without requiring a new client',async t=>{
  const {base,headers}=await fixture(t);
  const ws=await browser(base,'extension-secret','0.1.2');
  const health=await (await fetch(base+'/health',{headers})).json();
  assert.equal(health.version,'0.1.2');assert.equal(health.browserVersion,'0.1.2');
  const closed=once(ws,'close');ws.close();await closed;
  const legacy=await browser(base);t.after(()=>legacy.terminate());
  assert.equal((await (await fetch(base+'/health',{headers})).json()).browserVersion,null);
});


test('a replacement cannot take over before the closing browser settles its request',async t=>{
  const {b,base,headers}=await fixture(t);const ws=await browser(base);t.after(()=>ws.terminate());
  const received=once(ws,'message');
  const pending=fetch(base+'/command',{method:'POST',headers,body:JSON.stringify({action:'paper',tabId:42})});
  await received;
  // Delay the client's close acknowledgement to exercise the CLOSING transition.
  ws._socket.pause();
  const serverSocket=[...b.wss.clients][0];serverSocket.close(1000);
  const candidate=new WebSocket(base.replace('http:','ws:')+'/browser',{origin:'chrome-extension://'+'a'.repeat(32)});
  t.after(()=>candidate.terminate());await once(candidate,'open');
  const rejected=once(candidate,'close');candidate.send(JSON.stringify({type:'hello',token:'extension-secret'}));
  assert.equal((await rejected)[0],1008);
  const closed=once(ws,'close');ws._socket.resume();await closed;
  assert.match((await (await pending).json()).error,/连接中断/);
  const replacement=await browser(base);t.after(()=>replacement.terminate());
  assert.equal((await (await fetch(base+'/health',{headers})).json()).pending,0);
});
