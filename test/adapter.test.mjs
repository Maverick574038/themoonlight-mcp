import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {pageOperation} from '../extension/adapter.js';
function page(html,url='https://www.themoonlight.io/extension/release/test/web/pdf.html?paperId=79ad721a-10d1-4767-a6cf-dc5ded2de5d1'){
 const dom=new JSDOM(html,{url,runScripts:'outside-only'});
 dom.window.HTMLElement.prototype.getBoundingClientRect=()=>({width:100,height:30});
 dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const run=dom.window.eval(`(${pageOperation.toString()})`);return {dom,run};
}

test('library rows preserve paper identity and report partial scope',async()=>{
 const {run}=page('<table><tr><td><a href="/paper/79ad721a-10d1-4767-a6cf-dc5ded2de5d1">Data Uncertainty Learning</a></td></tr><tr><td><a href="https://evil.invalid/paper/79ad721a-10d1-4767-a6cf-dc5ded2de5d1">Other site</a></td></tr></table>','https://www.themoonlight.io/zh/library');
 const result=await run({action:'library',query:'uncertainty',maxPages:1});assert.equal(result.papers.length,1);assert.equal(result.papers[0].title,'Data Uncertainty Learning');assert.equal(result.coverage,'rendered_rows_on_visited_library_pages');
});
test('PDF extraction preserves page numbers, text and source citations',async()=>{
 const {run}=page('<div id="viewerContainer"><div id="viewer"><div class="page" data-page-number="1"><div class="textLayer"><span role="presentation">Original paper text</span></div></div></div></div>');
 const result=await run({action:'pages',startPage:1,endPage:1});assert.equal(result.pages[0].text,'Original paper text');assert.equal(result.completeRequestedRange,true);assert.match(result.pages[0].citation,/#page=1$/);
 await assert.rejects(()=>run({action:'pages',startPage:1,endPage:2}),/超出/);
});
test('notes preserve formulas and do not modify the editor',async()=>{
 const {dom,run}=page('<div id="moonlight-viewer-shell"></div><aside data-viewer-right-sidebar><button aria-label="笔记">笔记</button><div class="moonlight-viewer-sidebar-panel"><div class="ProseMirror" contenteditable="true"><p>My own notes</p><p><span class="katex" data-latex="x^2"><span aria-hidden="true">duplicate</span></span></p></div></div></aside>');
 const editor=dom.window.document.querySelector('.ProseMirror'),before=editor.innerHTML;
 const result=await run({action:'annotations',kind:'notes'});assert.match(result.text,/My own notes/);assert.match(result.text,/\$x\^2\$/);assert.doesNotMatch(result.text,/duplicate/);assert.equal(editor.innerHTML,before);
});
test('question preparation does not fill the input or click send',async()=>{
 const {dom,run}=page('<div id="moonlight-viewer-shell"></div><aside data-viewer-right-sidebar><button aria-label="与AI一起">AI</button><div class="moonlight-viewer-sidebar-panel"><div data-viewer-composer><textarea></textarea><button aria-label="发送">send</button></div></div></aside>');
 let sends=0;dom.window.document.querySelector('[aria-label="发送"]').onclick=()=>sends++;
 const result=await run({action:'ai_prepare',question:'Explain the method'});assert.equal(result.ready,true);assert.equal(sends,0);assert.equal(dom.window.document.querySelector('textarea').value,'');
});
test('sending clicks once and existing drafts are never overwritten',async()=>{
 const {dom,run}=page('<div id="moonlight-viewer-shell"></div><aside data-viewer-right-sidebar><div class="moonlight-viewer-sidebar-panel"><section data-feature-tour="discussion-section"></section><div data-viewer-composer><textarea></textarea><button aria-label="发送">send</button></div></div></aside>');
 let sends=0;const input=dom.window.document.querySelector('textarea');dom.window.document.querySelector('button').onclick=()=>{sends++;input.value='';};
 const result=await run({action:'ai_submit',question:'Q',requestId:'a'.repeat(32)});assert.equal(sends,1);assert.equal(result.status,'submitted');
 input.value='My unsent draft';await assert.rejects(()=>run({action:'ai_submit',question:'Q'}),/草稿/);assert.equal(input.value,'My unsent draft');assert.equal(sends,1);
});

test('unrendered PDF pages are loaded through the page-number control and the original page is restored',async()=>{
 const {dom,run}=page('<div id="moonlight-viewer-shell"><input inputmode="numeric" value="1"></div><div id="viewerContainer"><div id="viewer"><div class="page" data-page-number="1"><div class="textLayer"><span>Page one</span></div></div><div class="page" data-page-number="2"></div></div></div>');
 const input=dom.window.document.querySelector('input'),visited=[];
 input.addEventListener('keydown',e=>{if(e.key==='Enter'){visited.push(input.value);if(input.value==='2')dom.window.document.querySelector('[data-page-number="2"]').innerHTML='<div class="textLayer"><span>Lazy-loaded second page</span></div>';}});
 const result=await run({action:'pages',startPage:2,endPage:2});
 assert.equal(result.completeRequestedRange,true);assert.equal(result.pages[0].text,'Lazy-loaded second page');assert.equal(input.value,'1');assert.deepEqual(visited,['2','1']);
});


function aiPage(extra=''){
 return page(`<div id="moonlight-viewer-shell"></div><aside data-viewer-right-sidebar><div class="moonlight-viewer-sidebar-panel"><section data-feature-tour="discussion-section"></section>${extra}<div data-viewer-composer><textarea></textarea><button aria-label="发送">send</button></div></div></aside>`);
}

test('editing the prepared text before the send click cancels submission',async()=>{
 const {dom,run}=aiPage();
 const input=dom.window.document.querySelector('textarea');let sends=0;
 dom.window.document.querySelector('button').onclick=()=>sends++;
 input.addEventListener('input',()=>{input.value='User replacement draft';});
 await assert.rejects(()=>run({action:'ai_submit',question:'Approved question'}),/内容已变化/);
 assert.equal(input.value,'User replacement draft');assert.equal(sends,0);
});

test('submission refuses an already generating conversation without altering its input',async()=>{
 const {dom,run}=aiPage('<button aria-label="停止生成">Stop</button>');
 let sends=0;dom.window.document.querySelector('[aria-label="发送"]').onclick=()=>sends++;
 await assert.rejects(()=>run({action:'ai_submit',question:'Approved question'}),/正在生成/);
 assert.equal(dom.window.document.querySelector('textarea').value,'');assert.equal(sends,0);
});

test('navigation during input processing prevents a send to another paper',async()=>{
 const {dom,run}=aiPage();let sends=0;
 const input=dom.window.document.querySelector('textarea');
 dom.window.document.querySelector('button').onclick=()=>sends++;
 input.addEventListener('input',()=>dom.window.history.replaceState({},'', '?paperId=96cf8496-54aa-4ae0-8b16-b5e548a22cc5'));
 await assert.rejects(()=>run({action:'ai_submit',question:'Approved question'}),/论文或 AI 面板已切换/);
 assert.equal(sends,0);
});

test('an aria-disabled send button is never clicked',async()=>{
 const {dom,run}=aiPage();let sends=0;
 const send=dom.window.document.querySelector('button');send.setAttribute('aria-disabled','true');send.onclick=()=>sends++;
 await assert.rejects(()=>run({action:'ai_submit',question:'Approved question'}),/发送按钮未就绪/);
 assert.equal(sends,0);
});

test('adapter refuses non-Moonlight document origins',async()=>{
 const {run}=page('<div id="moonlight-viewer-shell"></div>','https://other.invalid/paper/test');
 const result=await run({action:'paper'});assert.equal(result.skipped,true);
});


test('library pagination waits through an empty loading state and excludes links outside its table',async()=>{
 const first='79ad721a-10d1-4767-a6cf-dc5ded2de5d1',second='96cf8496-54aa-4ae0-8b16-b5e548a22cc5';
 const {dom,run}=page(`<a href="/paper/00000000-0000-4000-8000-000000000001">Outside library</a><table aria-label="Paper list"><tbody><tr><td><a href="/paper/${first}">First</a></td></tr></tbody></table><button aria-label="下一页">Next</button>`,'https://www.themoonlight.io/zh/library');
 const tbody=dom.window.document.querySelector('tbody'),next=dom.window.document.querySelector('button');
 next.onclick=()=>{tbody.replaceChildren();dom.window.setTimeout(()=>{tbody.innerHTML=`<tr><td><a href="/paper/${second}">Second</a></td></tr>`;next.disabled=true;},150);};
 const result=await run({action:'library',query:'',maxPages:2});
 assert.deepEqual([...result.papers].map(paper=>paper.title),['First','Second']);
 assert.equal(result.pagesVisited,2);assert.equal(result.hasMore,false);
});
