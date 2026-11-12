// Self-contained so chrome.scripting.executeScript can serialize this function.
// Operates only on the DOM and normal UI controls, never on cookies or private APIs.
export async function pageOperation(command) {
  const $ = selector => document.querySelector(selector);
  const all = (selector, root=document) => [...root.querySelectorAll(selector)];
  const clean = value => (value || '').replace(/[\u2066-\u2069\u200b]/g,'').trim();
  const visible = e => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden';
  const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
  const wait = async (fn,ms=8000) => { const end=Date.now()+ms;do{const v=fn();if(v)return v;await pause(100);}while(Date.now()<end);return null; };
  function text(el) {
    if(!el)return '';
    const copy=el.cloneNode(true);
    for(const math of all('.katex[data-latex]',copy))math.replaceWith(`$${math.getAttribute('data-latex')}$`);
    for(const n of all('script,style,[aria-hidden="true"],.ProseMirror-widget',copy))n.remove();
    for(const block of all('p,li,h1,h2,h3,h4,pre,blockquote',copy))block.append('\n');
    return clean(copy.textContent).replace(/[ \t]+\n/g,'\n');
  }
  const pageUrl=new URL(location.href);
  if(pageUrl.protocol!=='https:'||pageUrl.port||!['themoonlight.io','www.themoonlight.io'].includes(pageUrl.hostname))return {skipped:true};
  const isViewer=!!$('#viewer .page, #moonlight-viewer-shell');
  const isLibrary=!!$('table[aria-label="Paper list"],[role="table"][aria-label="Paper list"],a[href*="/paper/"]') && /\/library(?:\/|$)/.test(location.pathname);
  const source=()=>({provider:'themoonlight.io',url:location.href,title:document.title,observedAt:new Date().toISOString(),untrustedContent:true});
  function button(names,root=document) {
    return all('button,[role="button"]',root).find(e=>visible(e)&&names.includes(clean(e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent)));
  }
  const side=()=>$('aside[data-viewer-right-sidebar] .moonlight-viewer-sidebar-panel');
  async function panel(kind) {
    const names={notes:['笔记','Note','Notes'],highlights:['高亮','Highlight','Highlights'],comments:['评论','Comments','Comment'],explanations:['解释','Explanation','Explanations'],ai:['与AI一起','与 AI 一起','With AI','AI']};
    const root=$('aside[data-viewer-right-sidebar]')||document;
    const control=button(names[kind],root);
    if(!control)throw new Error(`未找到 ${kind} 面板入口；页面版本可能变化。`);
    const matches=()=>{
      const p=side();if(!p)return false;
      if(kind==='notes')return visible(p.querySelector('.ProseMirror[contenteditable="true"]'));
      if(kind==='ai')return visible(p.querySelector('[data-viewer-composer] textarea,textarea'));
      return names[kind].includes(clean(p.querySelector('.right-sidebar-tab-title')?.textContent));
    };
    if(matches())return side();
    control.click();
    if(!await wait(matches,800)){
      // Some collapsed readers first open their previous tab. Re-select only after checking.
      control.click();
      if(!await wait(matches,5000))throw new Error(`无法确认已切换到 ${kind} 面板，已停止读取以免混入其他内容。`);
    }
    await pause(200);
    return side();
  }
  if(command.action==='probe')return {surface:isViewer?'viewer':isLibrary?'library':null};
  function requireViewer(){if(!isViewer)return false;return true;}
  if(command.action==='library') {
    if(!isLibrary)return {skipped:true};
    const papers=new Map();let pagesVisited=0,hasMore=false;
    const links=()=>all('a[href*="/paper/"]',$('table[aria-label="Paper list"],[role="table"][aria-label="Paper list"]')||document);
    const signature=()=>links().map(a=>a.href).join('|');
    for(let i=0;i<(command.maxPages||1);i++) {
      await wait(()=>$('table[aria-label="Paper list"],[role="table"][aria-label="Paper list"],a[href*="/paper/"]')); 
      for(const link of links()) {
        const url=new URL(link.href),match=url.pathname.match(/^\/paper\/([a-f\d-]{36})$/i);
        if(!match || url.protocol!=='https:' || url.port || !['themoonlight.io','www.themoonlight.io'].includes(url.hostname))continue;
        const row=link.closest('tr,[role="row"]');
        papers.set(match[1],{paperId:match[1],title:clean(link.innerText||link.textContent),url:url.href,libraryRow:row?clean(row.innerText):null});
      }
      pagesVisited++;
      const next=button(['next page button','下一页']);hasMore=!!next&&!next.disabled&&next.getAttribute('aria-disabled')!=='true';
      if(!hasMore||i===(command.maxPages||1)-1)break;
      const before=signature();next.click();
      // Loading often clears rows briefly; an empty list is not a completed next page.
      const changed=await wait(()=>{const current=signature();return current&&current!==before&&!$('[aria-busy="true"]');});
      if(!changed)throw new Error('翻页未完成，不能确认论文列表完整性。');
    }
    const query=clean(command.query).toLocaleLowerCase();
    const result=[...papers.values()].filter(p=>!query||p.title.toLocaleLowerCase().includes(query));
    return {...source(),papers:result,pagesVisited,hasMore,coverage:'rendered_rows_on_visited_library_pages',notice:'检索范围仅包含已访问列表页中实际渲染的条目；文件夹及虚拟滚动中未呈现的内容可能未包含。'};
  }
  if(!requireViewer())return {skipped:true};
  const paperId=new URL(location.href).searchParams.get('paperId')||location.pathname.match(/\/paper\/([^/]+)/)?.[1];
  const meta=()=>({...source(),paperId,url:paperId?`https://www.themoonlight.io/paper/${paperId}`:location.href});
  const pages=()=>all('#viewer .page[data-page-number]');
  if(command.action==='paper') {
    const params=new URL(location.href).searchParams;
    return {...meta(),totalPages:pages().length,renderedPages:pages().filter(e=>e.querySelector('.textLayer span')).map(e=>Number(e.dataset.pageNumber)),pdfSource:params.get('origin'),coverage:'metadata_and_currently_rendered_pages',hasNotesPanel:!!button(['笔记','Note','Notes']),hasAI:!!button(['与AI一起','With AI','AI'])};
  }
  if(command.action==='pages') {
    const total=pages().length;
    if(command.startPage>total||command.endPage>total)throw new Error(`页码超出范围，当前论文共 ${total} 页。`);
    const container=$('#viewerContainer'),oldTop=container?.scrollTop;
    const pageInput=$('#moonlight-viewer-shell input[inputmode="numeric"]');
    const oldPage=pageInput?.value;
    async function goToPage(number){
      if(pageInput&&visible(pageInput)){
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(pageInput,String(number));
        pageInput.dispatchEvent(new Event('input',{bubbles:true}));
        pageInput.dispatchEvent(new Event('change',{bubbles:true}));
        await pause(0);
        pageInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
        pageInput.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
      }else $(`#viewer .page[data-page-number="${number}"]`)?.scrollIntoView({block:'start',behavior:'instant'});
    }
    const out=[];
    try {
      for(let n=command.startPage;n<=command.endPage;n++) {
        const element=$(`#viewer .page[data-page-number="${n}"]`);
        await goToPage(n);
        const layer=await wait(()=>{const t=element.querySelector('.textLayer');return t?.querySelector('span')?t:null;},4500);
        const spans=layer?all('span[role="presentation"],span',layer).filter(e=>!e.querySelector('span')):[];
        const content=spans.map(e=>clean(e.textContent)+(e.getAttribute('data-is-end-of-line')==='true'?'\n':' ')).join('').trim();
        out.push({page:n,status:content?'ok':'no_text_layer',text:content,citation:`${meta().url}#page=${n}`});
      }
    } finally {if(oldPage&&Number.isInteger(Number(oldPage)))await goToPage(oldPage);if(container&&oldTop!==undefined)container.scrollTop=oldTop;}
    return {...meta(),totalPages:total,pages:out,completeRequestedRange:out.every(p=>p.status==='ok'),coverage:`requested_pages_${command.startPage}_to_${command.endPage}`,notice:'内容来自 PDF 文本层；公式、分栏顺序和图片需要对照原 PDF。扫描页可能没有可读取的文本层。'};
  }
  if(command.action==='annotations') {
    const p=await panel(command.kind);
    if(!p)throw new Error('侧栏未打开。');
    if(command.kind==='notes') {
      const editor=await wait(()=>p.querySelector('.ProseMirror[contenteditable="true"]'));
      if(!editor)throw new Error('笔记编辑器尚未就绪，不能将其视为空笔记。');
      return {...meta(),kind:'notes',text:text(editor),coverage:'current_note_editor',empty:!text(editor)};
    }
    const scrollers=[p,...all('*',p)].filter(e=>e.scrollHeight>e.clientHeight+80 && /auto|scroll/.test(getComputedStyle(e).overflowY));
    const collected=new Set();let rounds=0;
    const save=()=>{for(const el of all('[data-page-number],[data-highlight-id],.highlight-card,.comment-card',p)){const t=text(el);if(t)collected.add(t);}};
    save();
    for(const scroller of scrollers) {
      const original=scroller.scrollTop;
      while(rounds++<20 && scroller.scrollTop+scroller.clientHeight<scroller.scrollHeight-2){const before=scroller.scrollTop;scroller.scrollTop+=Math.max(scroller.clientHeight,400);await pause(150);save();if(scroller.scrollTop===before)break;}
      scroller.scrollTop=original;
    }
    return {...meta(),kind:command.kind,panelText:clean(p.innerText),items:[...collected],coverage:'visible_sidebar_with_bounded_scroll',possiblyTruncated:rounds>=20,notice:'保留侧栏原文；未能可靠识别单条批注时请使用 panelText。空 items 不代表账户内没有批注，需结合面板内容判断。'};
  }
  function aiContent() {
    const p=side();if(!p)throw new Error('AI 面板未打开。');
    const discussion=p.querySelector('[data-feature-tour="discussion-section"]');
    const sections=all('section',p).map(e=>({heading:clean(e.querySelector('h3,h2')?.textContent),text:text(e)}));
    const stop=button(['停止','停止生成','Stop','Stop generating'],p);
    return {...meta(),contentType:'moonlight_generated_content',sections,discussionText:discussion?text(discussion):'',panelText:clean(p.innerText).slice(0,120000),generating:stop?true:null,completionState:stop?'generating':'unknown',coverage:'currently_selected_ai_discussion_and_visible_sections',notice:'generating 为 null 时无法仅凭页面确认生成已结束；可稍后再次读取比较。'};
  }
  if(command.action==='ai_read') {await panel('ai');return aiContent();}
  if(command.action==='ai_prepare') {
    const p=await panel('ai');
    const input=p?.querySelector('[data-viewer-composer] textarea')||p?.querySelector('textarea');
    if(!input)throw new Error('未找到 AI 问题输入框。');
    if(clean(input.value))throw new Error('输入框中有未发送内容，请先处理已有草稿。');
    if(button(['停止','停止生成','Stop','Stop generating'],p))throw new Error('Moonlight 正在生成，请先等待当前回复。');
    // Preparing deliberately does not fill or submit anything.
    return {...meta(),ready:true,question:command.question,notice:'尚未发送。必须在扩展弹窗确认此问题，再调用 submit。'};
  }
  if(command.action==='ai_submit') {
    if(command.expectedPaperId&&command.expectedPaperId!==paperId)throw new Error('论文已切换，请重新准备问题。');
    const p=side(),input=p?.querySelector('[data-viewer-composer] textarea')||p?.querySelector('textarea');
    if(!input||!visible(input))throw new Error('AI 面板发生变化，请重新准备问题。');
    if(clean(input.value))throw new Error('检测到已有草稿，已停止。');
    if(button(['停止','停止生成','Stop','Stop generating'],p))throw new Error('Moonlight 正在生成，请先等待当前回复。');
    const before=aiContent().discussionText;
    const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    set.call(input,command.question);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
    const send=await wait(()=>{const b=button(['发送','Send'],p);return b&&!b.disabled&&b.getAttribute('aria-disabled')!=='true'?b:null;},2000);
    if(!send)throw new Error('发送按钮未就绪，问题保留在输入框；未点击发送。');
    const currentPaperId=new URL(location.href).searchParams.get('paperId')||location.pathname.match(/\/paper\/([^/]+)/)?.[1];
    if(currentPaperId!==paperId||!input.isConnected||side()!==p)throw new Error('论文或 AI 面板已切换，已停止发送。');
    if(input.value!==command.question)throw new Error('输入框内容已变化，已停止发送；请核查已有草稿。');
    if(button(['停止','停止生成','Stop','Stop generating'],p))throw new Error('Moonlight 正在生成，已停止发送。');
    // One click only. No retry even if acknowledgement never arrives.
    send.click();
    const acknowledged=await wait(()=>clean(input.value)===''||aiContent().discussionText!==before,3000);
    return {...meta(),requestId:command.requestId,status:acknowledged?'submitted':'submission_uncertain',notice:'不会自动重发。请使用 moonlight_read_ai 读取回复；生成中再次读取即可。'};
  }
  return {skipped:true};
}
