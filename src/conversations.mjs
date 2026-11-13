import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import { command } from './client.mjs';
export async function collectConversations({tabId,signal},send=command){
  const deadline=AbortSignal.timeout(600000);
  signal=signal?AbortSignal.any([signal,deadline]):deadline;
  const call=async value=>{signal.throwIfAborted();return send({tabId,...value},{signal});};
  const paper=await call({action:'paper'});
  if(!paper.paperId||!paper.title)throw new Error('论文元信息不完整。');
  async function step(value){
    const operationId=randomUUID(),end=Date.now()+50000;
    while(Date.now()<end){
      const result=await call({...value,operationId});
      if(!result.pending)return result;
      if(result.paperId!==paper.paperId)throw new Error('论文已切换，已停止采集。');
      await pause(250,undefined,{signal});
    }
    throw new Error('会话读取超过时限，尚未导入；请等待页面加载结束后重试。');
  }
  const list=await step({action:'conversation_list',expectedPaperId:paper.paperId});
  if(list.paperId!==paper.paperId||!list.complete)throw new Error('历史列表未完整读取，尚未导入。');
  if(!Array.isArray(list.entries)||list.entries.length>300)throw new Error('会话超过单次 300 条上限，尚未导入。');
  const conversations=[];
  for(const entry of list.entries){
    const result=await step({action:'conversation_read',expectedPaperId:paper.paperId,entry});
    if(result.paperId!==paper.paperId||!result.complete||!result.messages?.length)throw new Error(`会话“${entry.title}”未完整读取，尚未导入。请等待生成结束并检查页面。`);
    conversations.push({entry,messages:result.messages});
  }
  const final=await step({action:'conversation_list',expectedPaperId:paper.paperId});
  if(!final.complete||JSON.stringify(final.entries)!==JSON.stringify(list.entries))throw new Error('采集期间会话列表发生变化，请重试；尚未导入。');
  return {paperId:paper.paperId,title:paper.title,url:paper.url,observedAt:new Date().toISOString(),complete:true,coverage:'current_paper_discussion_history_and_explanations',untrustedContent:true,conversations};
}
