const send=async message=>{const result=await chrome.runtime.sendMessage(message);if(result?.error)throw new Error(result.error);return result;};
async function refresh(){
  const state=await send({type:'state'});document.querySelector('#status').textContent=state.connected?'已连接，可以回到 Codex 使用':state.enabled?'正在等待本地 MCP 启动…':'尚未连接';
  document.querySelector('#endpoint').textContent=state.base;
  if(!state.connected&&state.lastError)document.querySelector('#error').textContent=state.lastError;
  const root=document.querySelector('#pending');root.replaceChildren();
  for(const p of state.pending){
    const card=document.createElement('div');card.className='card';
    const title=document.createElement('strong');title.textContent=p.title||'待发送问题';
    const question=document.createElement('p');question.className='question';question.textContent=p.question;
    const note=document.createElement('p');note.className='sub';note.textContent=p.approved?'已确认；回到 Codex 提交即可。':'确认后，Codex 可向这篇论文发送一次该问题。';
    const approve=document.createElement('button');approve.textContent=p.approved?'已确认':'允许发送此问题';approve.disabled=p.approved;
    approve.onclick=()=>act(()=>send({type:'approve',requestId:p.requestId}));
    const reject=document.createElement('button');reject.textContent='取消';reject.className='secondary';reject.onclick=()=>act(()=>send({type:'reject',requestId:p.requestId}));
    card.append(title,question,note,approve,reject);root.append(card);
  }
}
async function act(fn){try{document.querySelector('#error').textContent='';await fn();await refresh();}catch(e){document.querySelector('#error').textContent=e.message;}}
document.querySelector('#connect').onclick=()=>act(()=>send({type:'connect'}));document.querySelector('#disconnect').onclick=()=>act(()=>send({type:'disconnect'}));
act(refresh);setInterval(()=>act(refresh),2000);
