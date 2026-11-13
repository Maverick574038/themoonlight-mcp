// Serialized into the viewer frame. Each injection performs one short DOM step.
// Waiting lives in Node, so background-frame timer throttling cannot stall export.
export async function conversationOperation(command) {
 let phase='初始化';
 try {
  const all=(s,r=document)=>[...r.querySelectorAll(s)];
  const clean=s=>(s||'').replace(/[\u2066-\u2069\u200b]/g,'').trim();
  const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).opacity!=='0'&&!e.closest('[hidden],[aria-hidden="true"]');
  const url=new URL(location.href);
  if(url.protocol!=='https:'||url.port||!['themoonlight.io','www.themoonlight.io'].includes(url.hostname))throw new Error('仅支持 Moonlight 阅读器。');
  const paperId=url.searchParams.get('paperId')||url.pathname.match(/\/paper\/([^/]+)/)?.[1];
  if(!paperId||paperId!==command.expectedPaperId)throw new Error('论文已切换，已停止采集。');
  const side=()=>document.querySelector('aside[data-viewer-right-sidebar] .moonlight-viewer-sidebar-panel');
  const operationKey='__moonlightMcpConversationExport';
  let state=globalThis[operationKey];
  if(!state||state.id!==command.operationId){state={id:command.operationId,action:command.action,started:Date.now(),phase:command.action==='conversation_list'?'history':command.entry?.kind==='discussion'?'select':'explanation'};globalThis[operationKey]=state;}
  if(state.action!==command.action)throw new Error('采集任务不匹配，请重新开始。');
  phase=state.phase;
  if(Date.now()-state.started>45000)throw new Error('读取超过时限，请保持论文标签页打开并等待加载结束后重试。');
  const pending=()=>({pending:true,phase:state.phase,paperId});
  const meta={paperId,url:`https://www.themoonlight.io/paper/${paperId}`,title:command.paperTitle,untrustedContent:true,coverage:'current_paper_discussion_history_and_explanations'};
  const done=result=>{delete globalThis[operationKey];return {...meta,...result};};
  function panel(kind){
    const p=side();const names=kind==='ai'?['与AI一起','与 AI 一起','With AI','AI']:['解释','Explanation','Explanations'];
    const ready=p&&(kind==='ai'?visible(p.querySelector('[data-viewer-composer] textarea,textarea')):names.includes(clean(p.querySelector('.right-sidebar-tab-title')?.textContent)));
    if(ready)return p;
    const root=document.querySelector('aside[data-viewer-right-sidebar]');
    const b=root&&all('button,[role="button"]',root).find(e=>visible(e)&&names.includes(clean(e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent)));
    if(!b)throw new Error('未找到会话面板入口，页面结构可能已变化。');
    b.click();return null;
  }
  function stable(key,value,ms=700){const signature=JSON.stringify(value);if(state[key]?.signature!==signature){state[key]={signature,at:Date.now()};return false;}return Date.now()-state[key].at>=ms;}
  function scan(root,keys,key){
    let s=state[key];if(!s){const scrollers=[root,...all('*',root)].filter(e=>e.clientHeight>0&&e.scrollHeight>e.clientHeight+5&&/auto|scroll/.test(getComputedStyle(e).overflowY));s=state[key]={scrollers,original:scrollers.map(e=>e.scrollTop),index:0,previous:[],complete:true,rounds:0};if(scrollers.length){scrollers[0].scrollTop=0;scrollers[0].dispatchEvent(new Event('scroll'));return false;}}
    if(s.previous.some(x=>!keys.includes(x)))s.complete=false;s.previous=keys;
    if(s.scrollers.some(e=>!e.isConnected))throw new Error('采集期间面板发生变化，请重试。');
    const el=s.scrollers[s.index];
    if(!el)return true;
    if(++s.rounds>100)throw new Error('滚动超过读取上限，无法确认会话完整性。');
    if(el.scrollTop+el.clientHeight>=el.scrollHeight-2){el.scrollTop=s.original[s.index];s.index++;if(s.scrollers[s.index])s.scrollers[s.index].scrollTop=0;return !s.scrollers[s.index];}
    const before=el.scrollTop;el.scrollTop+=Math.max(200,el.clientHeight-30);el.dispatchEvent(new Event('scroll'));
    if(el.scrollTop===before)throw new Error('滚动未完成，无法确认会话完整性。');return false;
  }
  const discussion=()=>side()?.querySelector('[data-feature-tour="discussion-section"]');
  const trigger=()=>discussion()&&all('button',discussion()).find(b=>b.querySelector('svg.lucide-message-circle'));
  const filterButton=()=>discussion()&&all('button',discussion()).find(b=>['仅限当前论文','Only this paper','Current paper only'].includes(clean(b.childNodes[0]?.textContent)));
  const filterOn=b=>b.getAttribute('aria-checked')==='true'||b.getAttribute('data-state')==='checked'||all('span',b).some(s=>/translateX\(12px\)/.test(s.style.transform));
  const rows=()=>discussion()?all('button',discussion()).filter(b=>b.querySelectorAll('p').length===2&&!b.hasAttribute('aria-label')):[];
  function history(){
    if(!panel('ai'))return null;
    if(!trigger())return null;
    if(!filterButton()){trigger().click();return null;}
    if(!filterOn(filterButton())){filterButton().click();delete state.historyStable;return null;}
    const entries=rows().map(b=>{const p=b.querySelectorAll('p');return {kind:'discussion',title:clean(p[0].textContent),paperTitle:clean(p[1].textContent)};});
    const empty=/^(暂无讨论|暂无历史讨论|尚无讨论|没有讨论|No discussions|No conversations)$/i.test(clean(filterButton().parentElement.lastElementChild?.textContent));
    if(!entries.length&&!empty)return null;
    if(!stable('historyStable',entries))return null;
    if(!scan(filterButton().parentElement,entries.map(e=>e.title+'|'+e.paperTitle),'historyScan'))return null;
    if(entries.some(e=>e.paperTitle!==clean(command.paperTitle)))throw new Error('历史讨论所属论文不匹配，已停止以免串入其他论文。');
    if(new Set(entries.map(e=>e.title)).size!==entries.length)throw new Error('存在同名讨论且页面未提供稳定标识，请先区分讨论标题。');
    return {entries,complete:state.historyScan.complete};
  }
  function explanationEntries(){
    if(!panel('explanations'))return null;
    const root=document.querySelector('#rightSidebarExplanationContent');if(!root)return null;
    if(document.querySelector('#rightSidebarExplanationSearch')?.value||all('.explanation-checkbox').some(e=>!e.checked))throw new Error('请清空解释搜索并勾选全部解释类型后重试，避免漏掉会话。');
    if(root.querySelector('[aria-busy="true"],[role="progressbar"]'))return null;
    const entries=all('.tab-item[data-id]',root).map(e=>({kind:'explanation',id:e.dataset.id,title:clean(e.querySelector('.tab-title')?.textContent),selectedText:clean(e.querySelector('.tab-content')?.textContent),page:Number(e.querySelector('#explanationTabPageNumber')?.textContent)||null,userCount:Number(e.querySelector('#explanationTabChatCount')?.textContent)||0}));
    if(!stable('explanationsStable',entries,entries.length?700:3000))return null;
    if(!scan(root,entries.map(e=>e.id),'explanationScan'))return null;
    return {entries,complete:state.explanationScan.complete};
  }
  function markdown(root){
    const text=s=>s.replace(/[\\`*_[\]<>]/g,'\\$&');
    const safe=s=>{try{const u=new URL(s,location.href);return ['https:','http:'].includes(u.protocol)?u.href:null;}catch{return null;}};
    const render=n=>{
      if(n.nodeType===3)return text(n.nodeValue);
      if(n.nodeType!==1)return '';
      const tag=n.tagName.toLowerCase();
      if(n.matches('script,style,button,textarea,svg,.modal-toolbar,.keyword-tooltip,[aria-hidden="true"]'))return '';
      if(n.matches('.katex,.katex-display,math')){
        const latex=n.getAttribute('data-latex')||n.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
        if(latex)return n.matches('.katex-display')?`\n\n$$\n${latex}\n$$\n\n`:`$${latex}$`;
      }
      if(tag==='pre'){const code=n.querySelector('code')||n;const value=code.textContent;const fence='`'.repeat(Math.max(3,...[...value.matchAll(/`+/g)].map(m=>m[0].length+1)));const lang=(code.className.match(/language-([\w+-]+)/)||[])[1]||'';return `\n\n${fence}${lang}\n${value.replace(/\n$/,'')}\n${fence}\n\n`;}
      if(tag==='code'){const value=n.textContent;const fence='`'.repeat(Math.max(1,...[...value.matchAll(/`+/g)].map(m=>m[0].length+1)));return `${fence} ${value} ${fence}`;}
      const inner=()=>[...n.childNodes].map(render).join('');
      if(tag==='br')return '\n';
      if(/^h[1-6]$/.test(tag))return `\n\n${'#'.repeat(Number(tag[1]))} ${inner()}\n\n`;
      if(tag==='strong'||tag==='b')return `**${inner()}**`;
      if(tag==='em'||tag==='i')return `*${inner()}*`;
      if(tag==='a'){const label=inner(),href=safe(n.getAttribute('href'));return href&&!/^#/.test(n.getAttribute('href')||'')?`[${label}](<${href}>)`:label;}
      if(tag==='img'){const href=safe(n.getAttribute('src'));return href?`![${text(n.getAttribute('alt')||'图片')}](<${href}>)`:'';}
      if(tag==='blockquote')return '\n\n'+inner().trim().split('\n').map(s=>'> '+s).join('\n')+'\n\n';
      if(tag==='hr')return '\n\n---\n\n';
      if(tag==='ul'||tag==='ol')return '\n'+[...n.children].filter(e=>e.tagName==='LI').map((li,i)=>`${tag==='ol'?`${Number(n.getAttribute('start')||1)+i}.`:'-'} ${[...li.childNodes].map(render).join('').trim().replace(/\n/g,'\n  ')}`).join('\n')+'\n';
      if(tag==='table'){const rows=all('tr',n).map(row=>[...row.children].map(cell=>[...cell.childNodes].map(render).join('').trim().replace(/\|/g,'\\|').replace(/\n+/g,'<br>')));if(!rows.length)return '';const width=Math.max(...rows.map(r=>r.length));const line=r=>'| '+Array.from({length:width},(_,i)=>r[i]||'').join(' | ')+' |';return '\n\n'+[line(rows[0]),line(Array(width).fill('---')),...rows.slice(1).map(line)].join('\n')+'\n\n';}
      return ['p','div','section'].includes(tag)?`\n\n${inner()}\n\n`:inner();
    };
    // Keep whitespace inside fenced code; normal HTML whitespace outside blocks collapses.
    return [...root.childNodes].map(render).join('').trim();
  }

  if(command.action==='conversation_list'){
    if(state.phase==='history'){
      const h=history();if(!h)return pending();state.history=h;trigger()?.click();state.phase='explanations';return pending();
    }
    const e=explanationEntries();if(!e)return pending();return done({entries:[...state.history.entries,...e.entries],complete:state.history.complete&&e.complete});
  }
  if(command.action!=='conversation_read')throw new Error('Unknown conversation action');
  const entry=command.entry;let root,read;
  if(entry.kind==='discussion'){
    if(!panel('ai'))return pending();
    if(!trigger())return pending();
    if(!state.selected){
      const h=history();if(!h)return pending();
      const row=rows().find(b=>clean(b.querySelector('p')?.textContent)===entry.title);
      if(!row)throw new Error('讨论列表已变化，请重新采集。');
      // The selection dot identifies the actual thread even when another paper has the same title.
      const dot=row.parentElement.firstElementChild;
      const selected=row.getAttribute('aria-selected')==='true'||dot?.tagName==='SPAN'&&all('span',dot).some(e=>e.style.background.includes('--moonlight-viewer-accent'));
      state.selected=true;
      if(selected&&clean(trigger().querySelector('span')?.textContent)===entry.title){trigger().click();return pending();}
      state.previousText=all('.ml-reader-content',discussion()).map(e=>e.textContent).join('\n');
      row.click();state.phase='messages';delete state.messagesStable;return pending();
    }
    if(clean(trigger().querySelector('span')?.textContent)!==entry.title)throw new Error('采集期间讨论被切换，请重试。');
    root=discussion();
    read=()=>all('.ml-reader-content',root).filter(e=>!e.parentElement.closest('.ml-reader-content')).map(e=>({role:e.classList.contains('markdown-body')?'assistant':'user',markdown:e.classList.contains('markdown-body')?markdown(e):e.textContent}));
    if(state.previousText!==undefined&&all('.ml-reader-content',root).map(e=>e.textContent).join('\n')===state.previousText)return pending();
  }else{
    if(!panel('explanations'))return pending();
    const card=all('#rightSidebarExplanationContent .tab-item[data-id]').find(e=>e.dataset.id===entry.id);
    if(!card)throw new Error('解释列表已变化，请重新采集。');
    root=document.getElementById(entry.id);
    if(!state.opened){state.wasMinimized=!root||root.querySelector('.modal-body')?.classList.contains('modal-hidden');card.querySelector('.tab-title').click();state.opened=true;state.phase='messages';return pending();}
    if(!root?.matches('.moonlight-modal')||!root.querySelector('.modal-content-wrapper'))return pending();
    if(clean(root.querySelector('.modal-title')?.textContent)!==entry.title)throw new Error('解释标题已变化，请重新采集。');
    read=()=>all('.modal-content-wrapper > .modal-content,.modal-content-wrapper > .modal-chat-user,.modal-content-wrapper > .modal-chat-professor',root).filter(e=>clean(e.textContent)).map(e=>({role:e.classList.contains('modal-chat-user')?'user':'assistant',markdown:e.classList.contains('modal-chat-user')?e.textContent:markdown(e)}));
  }
  if(all('button',root).some(b=>visible(b)&&/^(停止|停止生成|Stop|Stop generating)$/.test(clean(b.getAttribute('aria-label')||b.textContent))))throw new Error('AI 仍在生成，稍后重试。');
  const messages=read();if(!messages.length)return pending();
  if(!stable('messagesStable',messages))return pending();
  const scrollRoot=entry.kind==='discussion'?root.closest('[data-viewer-discussion-scroll]')||root:root;
  if(!scan(scrollRoot,messages.map(m=>JSON.stringify(m)),'messageScan'))return pending();
  if(!stable('finalStable',messages))return pending();
  const countOk=entry.kind!=='explanation'||messages.filter(m=>m.role==='user').length===entry.userCount;
  const alternating=messages.every((m,i)=>m.markdown.trim()&&(i===0||messages[i-1].role!==m.role));
  if(entry.kind==='explanation'&&state.wasMinimized)root.querySelector('button.modal-minimize[aria-label="最小化"]')?.click();
  return done({entry,messages,complete:state.messageScan.complete&&countOk&&alternating&&messages.at(-1)?.role==='assistant',notice:'采集页面可访问的全部消息；未发送问题。远程图片保留链接，不自动下载。'});
 }catch(error){delete globalThis.__moonlightMcpConversationExport;return {operationError:phase+'：'+(error instanceof Error?error.message:String(error))};}
}
