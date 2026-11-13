import {readFile,writeFile,mkdir,readdir,lstat,realpath,open} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export function safeName(value){let name=String(value).normalize('NFC').replace(/[\x00-\x1f\x7f/\\:*?"<>|\[\]#^]/g,' ').replace(/\s+/g,' ').replace(/^[. ]+|[. ]+$/g,'');if(!name||/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name))name='Moonlight 论文';while(Buffer.byteLength(name)>180)name=[...name].slice(0,-1).join('');return name;}
async function dir(parent,name){const target=path.join(parent,name);try{await mkdir(target);}catch(e){if(e.code!=='EEXIST')throw e;}const st=await lstat(target);if(!st.isDirectory()||st.isSymbolicLink())throw new Error(`拒绝使用符号链接或非目录：${name}`);return target;}
async function text(file){try{const st=await lstat(file);if(st.isSymbolicLink()||!st.isFile()||st.size>2_000_000)throw new Error('归档路径包含不安全文件或文件过大。');return await readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function immutable(file,content){try{await writeFile(file,content,{flag:'wx',mode:0o600});return 'created';}catch(e){if(e.code!=='EEXIST')throw e;if(await text(file)===content)return 'unchanged';throw new Error(`已有文件内容不同，未覆盖手工修改：${path.basename(file)}`);}}
export async function importToObsidian(bundle,{vaultPath=process.env.MOONLIGHT_OBSIDIAN_VAULT||path.join(os.homedir(),'Documents','Obsidian Knowledge'),signal}={}){
  if(!bundle?.complete||!uuid.test(bundle.paperId)||!bundle.title||!Array.isArray(bundle.conversations)||!bundle.conversations.length)throw new Error('没有完整会话可导入；未创建论文目录。');
  const canonical=`https://www.themoonlight.io/paper/${bundle.paperId}`;
  if(bundle.url!==canonical)throw new Error('论文来源地址与 paperId 不匹配。');
  for(const c of bundle.conversations)if(!c.entry?.title||!['discussion','explanation'].includes(c.entry.kind)||!Array.isArray(c.messages)||!c.messages.length||c.messages.some(m=>!['user','assistant'].includes(m.role)||typeof m.markdown!=='string'||!m.markdown.trim()))throw new Error('会话结构无效，尚未写入。');
  signal?.throwIfAborted();
  const vault=await realpath(vaultPath);const vaultStat=await lstat(path.join(vault,'.obsidian'));
  if(!vaultStat.isDirectory()||vaultStat.isSymbolicLink())throw new Error('目标不是有效 Obsidian 库。');
  const papers=await dir(vault,'论文阅读');
  // A local lock serializes directory discovery and immutable writes. Never break another import's lock.
  const lock=path.join(papers,'.moonlight-import.lock');let handle;
  try{handle=await open(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw new Error('另一个导入正在运行；若进程已退出，请检查后移除论文阅读/.moonlight-import.lock。');throw e;}
  try{
    const matches=[];
    for(const entry of await readdir(papers,{withFileTypes:true})){
      if(!entry.isDirectory()||entry.isSymbolicLink())continue;
      const branch=path.join(papers,entry.name);const marker=await text(path.join(branch,'.moonlight-paper.json'));
      if(marker){let data;try{data=JSON.parse(marker);}catch{throw new Error('论文归档标识损坏，请先修复。');}if(data.paperId===bundle.paperId)matches.push(branch);continue;}
      const original=path.join(branch,'论文原文');let st;try{st=await lstat(original);}catch(e){if(e.code==='ENOENT')continue;throw e;}if(!st.isDirectory()||st.isSymbolicLink())continue;
      for(const file of await readdir(original,{withFileTypes:true})){if(!file.isFile()||!file.name.endsWith('.md'))continue;const value=await text(path.join(original,file.name));if(value?.includes(canonical)){matches.push(branch);break;}}
    }
    if(matches.length>1)throw new Error('同一论文存在多个分支，请合并或指定唯一归档标识后重试。');
    let branch=matches[0];
    if(!branch){const name=safeName(bundle.title);let exists=false;try{await lstat(path.join(papers,name));exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}branch=await dir(papers,exists?`${name} ${bundle.paperId.slice(0,8)}`:name);const marker=await text(path.join(branch,'.moonlight-paper.json'));if(marker&&JSON.parse(marker).paperId!==bundle.paperId)throw new Error('论文目录归属冲突。');}
    for(const name of ['论文原文','配图','解释','问答'])await dir(branch,name);
    await immutable(path.join(branch,'.moonlight-paper.json'),JSON.stringify({provider:'themoonlight.io',paperId:bundle.paperId,url:canonical},null,2)+'\n');
    const qa=path.join(branch,'问答');const files=[];let created=0,unchanged=0;
    for(const c of bundle.conversations){
      signal?.throwIfAborted();const key=hash(JSON.stringify([bundle.paperId,c.entry.kind,c.entry.id||c.entry.title])).slice(0,16);
      const body=`# ${c.entry.title.replace(/[\r\n]/g,' ')}\n\n来源：[Moonlight 原会话](${canonical})\n\n类型：${c.entry.kind==='discussion'?'历史讨论':'解释与追问'}${c.entry.page?` · 第 ${c.entry.page} 页`:''}\n\n${c.entry.selectedText?`原文选区：\n\n${c.entry.selectedText.split('\n').map(s=>'> '+s).join('\n')}\n\n`:''}`+c.messages.map((m,i)=>`## ${i+1}. ${m.role==='user'?'用户':'Moonlight AI'}\n\n${m.markdown}\n`).join('\n');
      const content=`---\nsource: moonlight\npaper_id: ${JSON.stringify(bundle.paperId)}\nconversation_key: ${key}\ncontent_sha256: ${hash(body)}\nscope: current_paper\n---\n\n${body}`;
      const filename=`Moonlight-${c.entry.kind==='discussion'?'讨论':'解释'}-${key}-${hash(content).slice(0,16)}.md`;
      const status=await immutable(path.join(qa,filename),content);status==='created'?created++:unchanged++;
      files.push({title:c.entry.title,file:filename,messages:c.messages.length,status});
    }
    const index=`# Moonlight 全部对话索引\n\n论文：[${bundle.title.replace(/[\r\n\[\]]/g,' ')}](${canonical})\n\n范围：当前论文历史讨论和解释中的全部可访问消息。AI 回答按原样归档，未经事实核验。远程图片保留链接。\n\n共 ${files.length} 个会话，${files.reduce((n,f)=>n+f.messages,0)} 条消息。文件按内容生成快照；重复导入跳过相同内容，新消息生成新快照，保留旧版本和手工修改。\n\n`+files.map(f=>`- [${f.title.replace(/[\r\n\[\]]/g,' ')}](<${f.file}>)（${f.messages} 条消息）`).join('\n')+'\n';
    const indexFile=`Moonlight对话索引-${hash(index).slice(0,16)}.md`;await immutable(path.join(qa,indexFile),index);
    return {paperId:bundle.paperId,folder:branch,index:path.join(qa,indexFile),conversations:files.length,messages:files.reduce((n,f)=>n+f.messages,0),created,unchanged,files};
  }finally{await handle.close();const {unlink}=await import('node:fs/promises');await unlink(lock);}
}
