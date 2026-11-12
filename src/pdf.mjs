import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
const MAX_BYTES=32*1024*1024;
const CACHE_TTL_MS=10*60*1000;
const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

function waitWithSignal(promise,signal,onAbort=()=>{}){
  if(!signal)return promise;
  let abort;
  const cancelled=new Promise((_,reject)=>{
    abort=()=>{onAbort();reject(signal.reason||new Error('PDF 读取已取消。'));};
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  });
  return Promise.race([promise,cancelled]).finally(()=>signal.removeEventListener('abort',abort));
}
function validateRange(startPage,endPage){
  if(!Number.isSafeInteger(startPage)||!Number.isSafeInteger(endPage)||startPage<1||endPage<startPage||endPage-startPage>9)throw new Error('一次读取 1–10 页。');
}
export function trustedPdfSource(meta){
  if(!meta||!UUID.test(meta.paperId||''))return null;
  try{
    const u=new URL(meta.pdfSource);
    if(u.protocol!=='https:'||u.hostname!=='moonlight-paper.s3.ap-northeast-2.amazonaws.com'||u.username||u.password||(u.port&&u.port!=='443'))return null;
    if(!u.pathname.toLowerCase().endsWith(`/${meta.paperId.toLowerCase()}.pdf`))return null;
    return u.href;
  }catch{return null;}
}
export async function fetchPdf(source,{fetchImpl=fetch,maxBytes=MAX_BYTES,signal}={}){
  signal?.throwIfAborted();
  const timeout=AbortSignal.timeout(25000);
  const response=await fetchImpl(source,{redirect:'error',credentials:'omit',signal:signal?AbortSignal.any([signal,timeout]):timeout});
  if(!response.ok){await response.body?.cancel();throw new Error(`原始 PDF 下载失败（HTTP ${response.status}）。`);}
  if(Number(response.headers.get('content-length')||0)>maxBytes){await response.body?.cancel();throw new Error('PDF 超出本机读取大小限制。');}
  if(!response.body)throw new Error('原文链接返回的内容不是有效 PDF（响应为空）。');
  let total=0;const chunks=[];
  for await(const chunk of response.body){total+=chunk.length;if(total>maxBytes)throw new Error('PDF 超出本机读取大小限制。');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('原文链接返回的内容不是有效 PDF。');
  return bytes;
}
export async function extractPdfPages(bytes,startPage,endPage,{getDocumentImpl=getDocument,timeoutMs=40000,signal}={}){
  validateRange(startPage,endPage);signal?.throwIfAborted();
  const task=getDocumentImpl({data:Uint8Array.from(bytes),isEvalSupported:false,disableFontFace:true,useSystemFonts:true,verbosity:0});
  let timer,destroyPromise;
  // Loading, extraction and cleanup must settle on timeout or cancellation.
  // Destroy only once and always observe its asynchronous rejection.
  const destroy=()=>destroyPromise??=Promise.resolve().then(()=>task.destroy()).catch(()=>{});
  const extract=async()=>{
    try{
      const doc=await task.promise;
      if(endPage>doc.numPages)throw new Error(`页码超出范围，当前论文共 ${doc.numPages} 页。`);
      const pages=[];
      for(let page=startPage;page<=endPage;page++){
        const pdfPage=await doc.getPage(page);
        try{
          const content=await pdfPage.getTextContent();
          const text=content.items.filter(x=>typeof x.str==='string').map(x=>x.str+(x.hasEOL?'\n':' ')).join('').trim();
          pages.push({page,text,status:text?'ok':'no_extractable_text'});
        }finally{pdfPage.cleanup();}
      }
      return {totalPages:doc.numPages,pages};
    }finally{await destroy();}
  };
  const operation=Promise.race([extract(),new Promise((_,reject)=>{
    timer=setTimeout(()=>{reject(new Error('PDF 解析超时，请缩小页码范围后重试。'));void destroy();},timeoutMs);
  })]);
  try{return await waitWithSignal(operation,signal,()=>{void destroy();});}
  finally{clearTimeout(timer);}
}
export function createOriginalPdfReader({fetchImpl=fetch,extractPages=extractPdfPages,now=Date.now}={}){
  const cache=new Map(),pending=new Map();
  async function load(source){
    for(const [key,record] of cache)if(now()-record.time>=CACHE_TTL_MS)cache.delete(key);
    if(cache.has(source)){
      const record=cache.get(source);cache.delete(source);cache.set(source,record);
      return record.bytes;
    }
    if(pending.has(source))return pending.get(source);
    const download=(async()=>{
      const bytes=await fetchPdf(source,{fetchImpl});
      cache.set(source,{bytes,time:now()});
      // At most two completed documents and 64 MiB of original bytes; no disk copies.
      while(cache.size>2)cache.delete(cache.keys().next().value);
      return bytes;
    })();
    pending.set(source,download);
    try{return await download;}finally{pending.delete(source);}
  }
  return async function originalPdfPages(meta,startPage,endPage,{signal}={}){
    validateRange(startPage,endPage);signal?.throwIfAborted();
    const source=trustedPdfSource(meta);if(!source)return null;
    const bytes=await waitWithSignal(load(source),signal);
    const result=await extractPages(bytes,startPage,endPage,{signal});
    signal?.throwIfAborted();
    return {...meta,...result,pages:result.pages.map(p=>({...p,citation:`${meta.url}#page=${p.page}`})),completeRequestedRange:result.pages.every(p=>p.status==='ok'),coverage:`requested_pages_${startPage}_to_${endPage}`,extractionMethod:'original_pdf',notice:'从页面提供的原始 PDF 在本机提取；不依赖浏览器已渲染页。扫描页需要 OCR，公式、图片和双栏顺序仍需对照原 PDF。'};
  };
}
export const originalPdfPages=createOriginalPdfReader();
