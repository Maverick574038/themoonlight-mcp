import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {conversationOperation} from '../extension/conversations.js';
import {collectConversations} from '../src/conversations.mjs';
import {validateCommand} from '../src/config.mjs';
const id='11111111-1111-4111-8111-111111111111';
const eid='22222222-2222-4222-8222-222222222222';
function fixture({other=false,duplicate=false}={}){
 const d=new JSDOM(`<aside data-viewer-right-sidebar><button aria-label="与AI一起">AI</button><button aria-label="解释">解释</button><div class="moonlight-viewer-sidebar-panel"></div></aside>`,{url:`https://www.themoonlight.io/extension/release/test/web/pdf.html?paperId=${id}`,runScripts:'outside-only'});
 const w=d.window;w.HTMLElement.prototype.getBoundingClientRect=()=>({width:100,height:30});const timer=w.setTimeout.bind(w);w.setTimeout=(fn,ms)=>timer(fn,Math.min(ms,1));
 const realNow=w.Date.now.bind(w.Date);let elapsed=0;w.Date.now=()=>realNow()+elapsed;
 const panel=w.document.querySelector('.moonlight-viewer-sidebar-panel');let filtered=false,selected='First',reads=[];
 const make=()=>{panel.innerHTML=`<textarea></textarea><section data-feature-tour="discussion-section"><header><button id="history"><svg class="lucide-message-circle"></svg><span>${selected}</span></button><div id="menu" hidden><button id="filter">仅限当前论文<span><span style="transform:${filtered?'translateX(12px)':'none'}"></span></span></button><div id="rows"></div></div></header><div id="turns"></div></section>`;
  const renderRows=()=>{panel.querySelector('#rows').innerHTML=(filtered?['First','Second']:['First','Second','Other']).map(t=>`<button aria-selected="${t===selected}" data-select="${t}"><p>${duplicate?'First':t}</p><p>${t==='Other'||other?'Other paper':'Paper'}</p></button>`).join('');panel.querySelectorAll('[data-select]').forEach(b=>b.onclick=()=>{selected=b.dataset.select;reads.push(selected);make();});};
  panel.querySelector('#history').onclick=()=>panel.querySelector('#menu').hidden=!panel.querySelector('#menu').hidden;
  panel.querySelector('#filter').onclick=()=>{filtered=!filtered;panel.querySelector('#filter span span').style.transform=filtered?'translateX(12px)':'none';renderRows();};renderRows();
  panel.querySelector('#turns').innerHTML=`<div class="ml-reader-content">Repeated question</div><div class="markdown-body ml-reader-content"><p>${selected} answer <strong>bold</strong><span class="keyword-chip">term<span class="keyword-tooltip">hidden tooltip</span></span></p><span class="katex" data-latex="x^2"><span aria-hidden="true">wrong duplicate</span></span><pre><code class="language-js">const a = \`code\`;\n\n// keep empty line</code></pre><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></div><div class="ml-reader-content">Repeated question</div><div class="markdown-body ml-reader-content"><p>Last answer</p></div>`;
 };
 w.document.querySelector('[aria-label="与AI一起"]').onclick=make;
 w.document.querySelector('[aria-label="解释"]').onclick=()=>{panel.innerHTML=`<span class="right-sidebar-tab-title">解释</span><input id="rightSidebarExplanationSearch"><input type="checkbox" class="explanation-checkbox" checked><div id="rightSidebarExplanationContent"><div class="tab-item" data-id="${eid}"><strong class="tab-title">Explain</strong><span class="tab-content">source</span><strong id="explanationTabPageNumber">2</strong><strong id="explanationTabChatCount">1</strong></div></div>`;panel.querySelector('.tab-title').onclick=()=>{if(w.document.getElementById(eid))return;const e=w.document.createElement('div');e.id=eid;e.className='moonlight-modal';e.innerHTML='<p class="modal-title">Explain</p><div class="modal-content-wrapper"><div class="modal-content"><p>Initial explanation</p></div><div class="modal-chat-user">Follow up</div><div class="modal-chat-professor"><p>Full follow up answer</p></div></div><button class="modal-minimize" aria-label="最小化"></button>';w.document.body.append(e);};};
 make();return {run:async cmd=>{const operationId=String(Math.random());for(let i=0;i<200;i++){elapsed+=300;const r=await w.eval(`(${conversationOperation.toString()})`)({...cmd,operationId});if(r.operationError)throw new Error(r.operationError);if(!r.pending)return r;}throw new Error('fixture exhausted');},w,reads};
}
const base={tabId:1,expectedPaperId:id,paperTitle:'Paper'};
test('serialized DOM reader enumerates every current-paper history and explanation, excluding other papers',async()=>{
 const {run}=fixture();const list=await run({...base,action:'conversation_list'});assert.equal(list.complete,true);assert.deepEqual(Array.from(list.entries,e=>e.title),['First','Second','Explain']);
});
test('DOM reader preserves ordered repeated turns, Markdown, code blank lines and math without tooltips',async()=>{
 const {run}=fixture();const r=await run({...base,action:'conversation_read',entry:{kind:'discussion',title:'Second'}});assert.equal(r.complete,true);assert.deepEqual(Array.from(r.messages,m=>m.role),['user','assistant','user','assistant']);assert.equal(r.messages[0].markdown,r.messages[2].markdown);const md=r.messages[1].markdown;for(const token of ['Second answer','**bold**','$x^2$','```js','\n\n// keep empty line','| A | B |'])assert.ok(md.includes(token),token);assert.doesNotMatch(md,/hidden tooltip|wrong duplicate/);
});
test('explanation export includes initial answer and all follow-ups by stable card ID',async()=>{
 const {run}=fixture();const r=await run({...base,action:'conversation_read',entry:{kind:'explanation',id:eid,title:'Explain',userCount:1}});assert.equal(r.complete,true);assert.deepEqual(Array.from(r.messages,m=>m.role),['assistant','user','assistant']);assert.match(r.messages[2].markdown,/Full follow up answer/);
 const incomplete=await run({...base,action:'conversation_read',entry:{kind:'explanation',id:eid,title:'Explain',userCount:2}});assert.equal(incomplete.complete,false);
});
test('DOM reader rejects paper changes, ambiguous discussion names and cross-paper rows',async()=>{
 await assert.rejects(()=>fixture().run({...base,expectedPaperId:eid,action:'conversation_list'}),/论文已切换/);
 await assert.rejects(()=>fixture({other:true}).run({...base,action:'conversation_list'}),/所属论文不匹配/);
 await assert.rejects(()=>fixture({duplicate:true}).run({...base,action:'conversation_list'}),/同名/);
});
test('collector refuses partial messages, changed indexes and cancellation before any archive write',async()=>{
 const entries=[{kind:'discussion',title:'First'}];const messages=[{role:'user',markdown:'Q'},{role:'assistant',markdown:'A'}];let partial=false,changed=false,lists=0;
 const send=async cmd=>cmd.action==='paper'?{paperId:id,title:'Paper',url:`https://www.themoonlight.io/paper/${id}`}:cmd.action==='conversation_list'?{paperId:id,complete:true,entries:changed&&lists++>0?[]:entries}:{paperId:id,complete:!partial,messages};
 const bundle=await collectConversations({tabId:1},send);assert.equal(bundle.conversations.length,1);
 partial=true;await assert.rejects(()=>collectConversations({tabId:1},send),/未完整读取/);partial=false;changed=true;await assert.rejects(()=>collectConversations({tabId:1},send),/列表发生变化/);
 await assert.rejects(()=>collectConversations({tabId:1,signal:AbortSignal.abort(new Error('cancelled'))},send),/cancelled/);
});
test('bridge validates conversation identity and descriptors',()=>{
 assert.throws(()=>validateCommand({action:'conversation_list',tabId:1}),/Expected/);
 assert.throws(()=>validateCommand({action:'conversation_read',tabId:1,expectedPaperId:id,operationId:id,entry:{kind:'delete',title:'X'}}),/descriptor/);
 assert.throws(()=>validateCommand({action:'conversation_probe',tabId:1}),/Unknown/);
});


test('host polls pending browser steps with one operation ID per thread',async()=>{
 const ids=new Map();let pending=0;
 const send=async cmd=>{
  if(cmd.action==='paper')return {paperId:id,title:'Paper',url:`https://www.themoonlight.io/paper/${id}`};
  assert.match(cmd.operationId,/^[a-f0-9-]{36}$/);
  const n=ids.get(cmd.operationId)||0;ids.set(cmd.operationId,n+1);
  if(n===0){pending++;return {pending:true,paperId:id};}
  return cmd.action==='conversation_list'?{paperId:id,complete:true,entries:[{kind:'discussion',title:'First'}]}:{paperId:id,complete:true,messages:[{role:'user',markdown:'Question'},{role:'assistant',markdown:'Answer'}]};
 };
 const b=await collectConversations({tabId:1},send);assert.equal(b.conversations.length,1);assert.equal(pending,3);assert.equal(ids.size,3);assert.ok([...ids.values()].every(n=>n===2));
});
